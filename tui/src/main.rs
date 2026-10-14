mod theme;
mod message;
mod logo;

use std::io::{self, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use crossterm::event::{self, Event, KeyCode, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout, Margin, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::{Frame, Terminal};

use crate::message::{Message, ToolResult, render_message};
use crate::theme::*;

// ===========================================================================
// Layout helpers
// ===========================================================================

/// The prompt box is capped at this width, matching OpenCode's `maxWidth` so
/// long lines don't stretch the composer across an ultrawide terminal.
const PROMPT_MAX_WIDTH: u16 = 90;

/// Horizontally center a block of `width` columns (capped at `max_width`)
/// inside `area`, returning the rect it should be drawn into.
fn centered_block(area: Rect, width: u16, max_width: u16) -> Rect {
    let w = width.min(max_width).min(area.width);
    Rect {
        x: area.x + (area.width.saturating_sub(w)) / 2,
        y: area.y,
        width: w,
        height: area.height,
    }
}

// ===========================================================================
// Protocol messages from the agent process
// ===========================================================================

#[allow(dead_code)]
enum Action {
    Token(String),
    StartAssistant,
    ThinkingStart,
    Thinking(String),
    ThinkingEnd,
    ToolCall { name: String, args_summary: String },
    ToolResult { result: String, is_error: bool },
    ShellCommand { command: String },
    ShellOutput { output: String },
    TurnComplete,
    AgentCrashed(String),
    // Live metrics
    MetricsUpdate { tokens: u64, cost: f64, speed: f64 },
    ActivityUpdate { title: String },
}

// ===========================================================================
// Application State
// ===========================================================================

struct AppState {
    messages: Vec<Message>,
    input: String,
    cursor_pos: usize,
    input_history: Vec<String>,
    history_idx: Option<usize>,
    scroll_offset: usize,
    yolo: bool,
    ctx_used: usize,
    ctx_total: usize,
    model: String,
    session_id: String,
    turn: usize,
    agent_running: bool,
    frame_idx: usize,
    last_anim_tick: Instant,
    status_msg: Option<(String, Instant)>,
    show_sidebar: bool,
    // Command palette (ctrl+p), OpenCode-style overlay
    palette_open: bool,
    palette_query: String,
    palette_selected: usize,
    // Sidebar fields
    activity_title: String,
    tokens_used: u64,
    cost: f64,
    speed: f64,
    working_dir: String,
    // Queue chat system
    message_queue: Vec<String>,
    queued_count: usize,
}

impl AppState {
    fn new(model: String, session_id: String) -> Self {
        let working_dir = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "~".to_string());
        Self {
            messages: vec![],
            input: String::new(),
            cursor_pos: 0,
            input_history: Vec::new(),
            history_idx: None,
            scroll_offset: 0,
            yolo: false,
            ctx_used: 0,
            ctx_total: 2000000,
            model,
            session_id,
            turn: 0,
            agent_running: false,
            frame_idx: 0,
            last_anim_tick: Instant::now(),
            status_msg: None,
            show_sidebar: true,
            palette_open: false,
            palette_query: String::new(),
            palette_selected: 0,
            activity_title: String::new(),
            tokens_used: 0,
            cost: 0.0,
            speed: 0.0,
            working_dir,
            message_queue: Vec::new(),
            queued_count: 0,
        }
    }

    fn tick_animation(&mut self) {
        // Always tick for splash animation; skip heavy ticks when idle
        if self.last_anim_tick.elapsed() >= Duration::from_millis(83) {
            self.frame_idx += 1;
            self.last_anim_tick = Instant::now();
        }
    }

    fn spinner(&self) -> &'static str {
        SPINNER_FRAMES[self.frame_idx % SPINNER_FRAMES.len()]
    }

    fn push_message(&mut self, msg: Message) {
        self.messages.push(msg);
    }

    fn toggle_thinking_collapse(&mut self) {
        for msg in &mut self.messages {
            if let Message::Assistant {
                thinking,
                thinking_collapsed,
                ..
            } = msg
            {
                if thinking.is_some() {
                    *thinking_collapsed = !*thinking_collapsed;
                }
            }
        }
    }

    fn queue_message(&mut self, text: String) {
        self.message_queue.push(text);
        self.queued_count = self.message_queue.len();
    }

    fn drain_queue(&mut self) -> Vec<String> {
        let queued: Vec<String> = self.message_queue.drain(..).collect();
        self.queued_count = 0;
        queued
    }

    fn format_tokens(&self) -> String {
        if self.tokens_used >= 1_000_000 {
            format!("{:.1}M", self.tokens_used as f64 / 1_000_000.0)
        } else if self.tokens_used >= 1_000 {
            format!("{:.1}K", self.tokens_used as f64 / 1_000.0)
        } else {
            format!("{}", self.tokens_used)
        }
    }

    fn format_cost(&self) -> String {
        if self.cost >= 1.0 {
            format!("${:.2}", self.cost)
        } else if self.cost >= 0.01 {
            format!("${:.2}", self.cost)
        } else if self.cost > 0.0 {
            format!("${:.3}", self.cost)
        } else {
            "$0.00".to_string()
        }
    }

    fn shorten_working_dir(&self) -> String {
        let home = std::env::var("HOME").unwrap_or_default();
        if self.working_dir.starts_with(&home) {
            self.working_dir.replacen(&home, "~", 1)
        } else {
            self.working_dir.clone()
        }
    }
}

// ===========================================================================
// ElitzaApp — owns terminal, agent process, and channels
// ===========================================================================

struct ElitzaApp {
    state: AppState,
    action_rx: Receiver<Action>,
    action_tx: Sender<Action>,
    agent_child: Option<Child>,
    agent_stdin_tx: Option<std::sync::mpsc::Sender<String>>,
    demo_mode: bool,
}

impl ElitzaApp {
    fn new(model: String, session_id: String, demo_mode: bool) -> Self {
        let (tx, rx) = channel();
        Self {
            state: AppState::new(model, session_id),
            action_rx: rx,
            action_tx: tx,
            agent_child: None,
            agent_stdin_tx: None,
            demo_mode,
        }
    }

    fn spawn_agent(&mut self) {
        if self.demo_mode {
            return;
        }

        let elitza_home = std::env::var("ELITZA_HOME")
            .unwrap_or_else(|_| format!("{}/.elitza", std::env::var("HOME").unwrap_or_default()));

        let python_bin = format!("{}/agent/venv/bin/python", elitza_home);
        let python_exists = std::path::Path::new(&python_bin).exists();

        if !python_exists {
            self.state.push_message(Message::System {
                text: "Python agent not found — running in demo mode.".to_string(),
            });
            self.demo_mode = true;
            return;
        }

        let mut cmd = Command::new(&python_bin);
        cmd.args(["-m", "elitza", "--protocol"])
            .env("ELITZA_HOME", &elitza_home)
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        match cmd.spawn() {
            Ok(child) => {
                self.agent_child = Some(child);
            }
            Err(e) => {
                self.state.push_message(Message::System {
                    text: format!("Failed to start agent: {} — demo mode.", e),
                });
                self.demo_mode = true;
            }
        }

        if let Some(ref mut child) = self.agent_child {
            let stdin = child.stdin.take();
            let stdout = child.stdout.take();

            if let Some(stdin) = stdin {
                let (stdin_tx, stdin_rx) = channel::<String>();
                self.agent_stdin_tx = Some(stdin_tx);
                thread::spawn(move || {
                    let mut stdin = stdin;
                    while let Ok(line) = stdin_rx.recv() {
                        if writeln!(stdin, "{}", line).is_err() {
                            break;
                        }
                        let _ = stdin.flush();
                    }
                });
            }

            if let Some(stdout) = stdout {
                let tx = self.action_tx.clone();
                thread::spawn(move || {
                    let reader = io::BufReader::new(stdout);
                    use std::io::BufRead;
                    for line in reader.lines() {
                        let line = match line {
                            Ok(l) => l,
                            Err(_) => break,
                        };
                        if let Some(action) = parse_protocol_line(&line) {
                            if tx.send(action).is_err() {
                                break;
                            }
                        }
                    }
                });
            }
        }
    }

    fn send_to_agent(&self, line: &str) {
        if let Some(ref tx) = self.agent_stdin_tx {
            let _ = tx.send(line.to_string());
        }
    }

    fn ensure_assistant_message(&mut self) {
        let needs_new = match self.state.messages.last() {
            Some(Message::Assistant { .. }) => false,
            _ => true,
        };
        if needs_new {
            self.state.push_message(Message::Assistant {
                content: String::new(),
                thinking: None,
                thinking_collapsed: false,
            });
            self.state.agent_running = true;
        }
    }

    fn drain_actions(&mut self) {
        while let Ok(action) = self.action_rx.try_recv() {
            match action {
                Action::Token(text) => {
                    self.ensure_assistant_message();
                    if let Some(Message::Assistant { content, thinking, .. }) = self.state.messages.last_mut() {
                        if let Some(t) = thinking {
                            if t.trim().is_empty() {
                                *thinking = None;
                            }
                        }
                        content.push_str(&text);
                    }
                }
                Action::ThinkingStart => {
                    self.ensure_assistant_message();
                }
                Action::Thinking(text) => {
                    self.ensure_assistant_message();
                    if let Some(Message::Assistant { thinking, .. }) = self.state.messages.last_mut() {
                        if !text.trim().is_empty() {
                            if thinking.is_none() {
                                *thinking = Some(String::new());
                            }
                            thinking.as_mut().unwrap().push_str(&text);
                        }
                    }
                }
                Action::ThinkingEnd => {
                    for msg in &mut self.state.messages {
                        if let Message::Assistant { thinking, thinking_collapsed, .. } = msg {
                            if let Some(t) = thinking {
                                if t.trim().is_empty() {
                                    *thinking = None;
                                } else {
                                    *thinking_collapsed = true;
                                }
                            }
                        }
                    }
                }
                Action::StartAssistant => {
                    self.state.push_message(Message::Assistant {
                        content: String::new(),
                        thinking: None,
                        thinking_collapsed: false,
                    });
                    self.state.agent_running = true;
                }
                Action::ToolCall { name, args_summary } => {
                    self.state.push_message(Message::ToolCall {
                        name,
                        args_summary,
                        running: true,
                        result: None,
                    });
                }
                Action::ToolResult { result, is_error } => {
                    let truncated = result.len() > 300;
                    if let Some(Message::ToolCall { running, result: res, .. }) =
                        self.state.messages.last_mut()
                    {
                        *running = false;
                        *res = Some(ToolResult {
                            text: result,
                            is_error,
                            truncated,
                        });
                    }
                }
                Action::ShellCommand { command } => {
                    self.state.push_message(Message::ShellCommand {
                        command,
                        running: true,
                        output: None,
                    });
                }
                Action::ShellOutput { output } => {
                    if let Some(Message::ShellCommand { running, output: out, .. }) =
                        self.state.messages.last_mut()
                    {
                        *running = false;
                        *out = Some(output);
                    }
                }
                Action::TurnComplete => {
                    self.state.agent_running = false;
                    self.state.push_message(Message::Spacer);
                    // Drain queued messages
                    let queued = self.state.drain_queue();
                    for msg in queued {
                        self.state.turn += 1;
                        self.state.push_message(Message::User {
                            text: msg.clone(),
                        });
                        self.send_to_agent(&format!("USER_INPUT {}", msg));
                        self.state.agent_running = true;
                    }
                }
                Action::AgentCrashed(msg) => {
                    self.state.agent_running = false;
                    self.state.push_message(Message::System {
                        text: format!("Agent crashed: {}", msg),
                    });
                    self.state.push_message(Message::Spacer);
                }
                Action::MetricsUpdate { tokens, cost, speed } => {
                    self.state.tokens_used = tokens;
                    self.state.cost = cost;
                    self.state.speed = speed;
                    // Estimate ctx_used from tokens
                    self.state.ctx_used = tokens as usize;
                }
                Action::ActivityUpdate { title } => {
                    self.state.activity_title = title;
                }
            }
        }
    }

    fn run(&mut self) -> io::Result<()> {
        self.spawn_agent();

        enable_raw_mode()?;
        let mut stdout = io::stdout();
        execute!(stdout, EnterAlternateScreen)?;

        let backend = CrosstermBackend::new(stdout);
        let mut terminal = Terminal::new(backend)?;

        let result = self.main_loop(&mut terminal);

        disable_raw_mode()?;
        execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
        terminal.show_cursor()?;

        if let Some(mut child) = self.agent_child.take() {
            let _ = child.kill();
        }

        result
    }

    fn main_loop(&mut self, terminal: &mut Terminal<CrosstermBackend<io::Stdout>>) -> io::Result<()> {
        loop {
            let mut did_input = false;

            while event::poll(Duration::from_millis(0))? {
                if let Event::Key(key) = event::read()? {
                    did_input = true;

                    if key.modifiers.contains(KeyModifiers::CONTROL) {
                        match key.code {
                            KeyCode::Char('c') => {
                                if self.state.agent_running {
                                    self.state.status_msg =
                                        Some(("Turn cancelled".to_string(), Instant::now()));
                                    self.state.agent_running = false;
                                    self.send_to_agent("CANCEL");
                                } else {
                                    return Ok(());
                                }
                            }
                            KeyCode::Char('q') => return Ok(()),
                            KeyCode::Char('l') => {
                                self.state.messages.clear();
                                self.state.scroll_offset = 0;
                            }
                            KeyCode::Char('a') => {
                                self.state.cursor_pos = 0;
                            }
                            KeyCode::Char('e') => {
                                self.state.cursor_pos = self.state.input.len();
                            }
                            KeyCode::Char('m') => {
                                // Cycle through models
                                self.state.status_msg = Some((
                                    format!("Model: {}", self.state.model),
                                    Instant::now(),
                                ));
                            }
                            KeyCode::Char('o') => {
                                self.state.yolo = !self.state.yolo;
                                let s = if self.state.yolo { "ON" } else { "OFF" };
                                self.state.status_msg =
                                    Some((format!("YOLO: {}", s), Instant::now()));
                            }
                            KeyCode::Char('b') => {
                                self.state.show_sidebar = !self.state.show_sidebar;
                                let s = if self.state.show_sidebar { "ON" } else { "OFF" };
                                self.state.status_msg =
                                    Some((format!("Sidebar: {}", s), Instant::now()));
                            }
                            KeyCode::Char('p') => {
                                self.state.palette_open = true;
                                self.state.palette_query.clear();
                                self.state.palette_selected = 0;
                            }
                            _ => {}
                        }
                        continue;
                    }

                    // While the command palette is open it swallows every key.
                    if self.state.palette_open {
                        if self.handle_palette_key(&key) {
                            return Ok(());
                        }
                        continue;
                    }

                    match key.code {
                        KeyCode::Esc => {
                            if self.state.agent_running {
                                self.state.status_msg =
                                    Some(("Turn cancelled".to_string(), Instant::now()));
                                self.state.agent_running = false;
                                self.send_to_agent("CANCEL");
                            }
                        }
                        KeyCode::Enter => {
                            let s = self.state.input.trim().to_string();
                            if !s.is_empty() {
                                self.state.input_history.push(s.clone());
                                self.state.history_idx = None;
                                self.handle_input(&s);
                            }
                            self.state.input.clear();
                            self.state.cursor_pos = 0;
                        }
                        KeyCode::Backspace => {
                            if self.state.cursor_pos > 0 {
                                self.state.cursor_pos -= 1;
                                self.state.input.remove(self.state.cursor_pos);
                            }
                        }
                        KeyCode::Delete => {
                            if self.state.cursor_pos < self.state.input.len() {
                                self.state.input.remove(self.state.cursor_pos);
                            }
                        }
                        KeyCode::Left => {
                            self.state.cursor_pos = self.state.cursor_pos.saturating_sub(1);
                        }
                        KeyCode::Right => {
                            if self.state.cursor_pos < self.state.input.len() {
                                self.state.cursor_pos += 1;
                            }
                        }
                        KeyCode::Up => {
                            if !self.state.input_history.is_empty() {
                                let idx = match self.state.history_idx {
                                    None => self.state.input_history.len() - 1,
                                    Some(i) if i > 0 => i - 1,
                                    Some(i) => i,
                                };
                                self.state.history_idx = Some(idx);
                                self.state.input = self.state.input_history[idx].clone();
                                self.state.cursor_pos = self.state.input.len();
                            }
                        }
                        KeyCode::Down => {
                            if let Some(idx) = self.state.history_idx {
                                if idx + 1 < self.state.input_history.len() {
                                    let new_idx = idx + 1;
                                    self.state.history_idx = Some(new_idx);
                                    self.state.input = self.state.input_history[new_idx].clone();
                                    self.state.cursor_pos = self.state.input.len();
                                } else {
                                    self.state.history_idx = None;
                                    self.state.input.clear();
                                    self.state.cursor_pos = 0;
                                }
                            }
                        }
                        KeyCode::Home => {
                            self.state.cursor_pos = 0;
                        }
                        KeyCode::End => {
                            self.state.cursor_pos = self.state.input.len();
                        }
                        KeyCode::Tab => {
                            self.state.toggle_thinking_collapse();
                        }
                        KeyCode::Char(c) => {
                            self.state.input.insert(self.state.cursor_pos, c);
                            self.state.cursor_pos += 1;
                        }
                        KeyCode::PageUp => {
                            self.state.scroll_offset =
                                self.state.scroll_offset.saturating_add(5);
                        }
                        KeyCode::PageDown => {
                            self.state.scroll_offset =
                                self.state.scroll_offset.saturating_sub(5);
                        }
                        _ => {}
                    }
                }
            }

            self.drain_actions();
            self.state.tick_animation();
            terminal.draw(|f| self.draw(f))?;

            if !did_input {
                // Splash needs smooth animation (~30fps), idle can sleep more
                let has_messages = !self.state.messages.is_empty();
                let sleep_ms = if !has_messages { 30 }  // splash: animate smoothly
                               else if self.state.agent_running { 5 }  // agent active: fast response
                               else { 50 };  // idle: save CPU
                std::thread::sleep(Duration::from_millis(sleep_ms));
            }
        }
    }

    fn handle_input(&mut self, input: &str) {
        if input == "/quit" || input == "/exit" {
            return;
        }

        if input.starts_with('/') {
            self.handle_slash_command(input);
            return;
        }

        // Queue message if agent is running
        if self.state.agent_running {
            self.state.queue_message(input.to_string());
            self.state.status_msg = Some((
                format!("Queued ({} in queue)", self.state.queued_count),
                Instant::now(),
            ));
            return;
        }

        self.state.turn += 1;
        self.state.push_message(Message::User {
            text: input.to_string(),
        });

        // Update activity title from first user message
        if self.state.activity_title.is_empty() {
            let title = if input.len() > 50 {
                format!("{}...", &input[..47])
            } else {
                input.to_string()
            };
            self.state.activity_title = title;
        }

        if self.demo_mode {
            self.state.push_message(Message::Assistant {
                content: String::new(),
                thinking: Some("Analyzing request...".to_string()),
                thinking_collapsed: false,
            });
            self.state.agent_running = true;
            self.state.push_message(Message::System {
                text: "[demo mode — no agent connected]".to_string(),
            });
            self.state.agent_running = false;
        } else {
            self.send_to_agent(&format!("USER_INPUT {}", input));
        }
    }

    /// Commands shown in the ctrl+p palette, in OpenCode's grouped order.
    /// Each entry: (label, description, keybind hint, action id).
    fn palette_commands() -> Vec<(&'static str, &'static str, &'static str, &'static str)> {
        vec![
            // -- Suggested --
            ("Model", "Switch the active model", "ctrl+m", "model"),
            ("Context", "Show context window usage", "", "context"),
            // -- View --
            ("Sidebar", "Toggle the info sidebar", "ctrl+b", "sidebar"),
            ("YOLO", "Toggle auto-approve mode", "ctrl+o", "yolo"),
            ("Clear", "Clear the transcript", "ctrl+l", "clear"),
            // -- Session --
            ("Queue", "Show queued messages", "", "queue"),
            ("Help", "List all commands", "", "help"),
            ("Quit", "Exit Elitza", "ctrl+q", "quit"),
        ]
    }

    /// Commands matching the current palette query (case-insensitive substring).
    fn filtered_palette(&self) -> Vec<(usize, &'static str, &'static str, &'static str, &'static str)> {
        let q = self.state.palette_query.to_lowercase();
        Self::palette_commands()
            .into_iter()
            .enumerate()
            .filter(|(_, (label, desc, _, _))| {
                q.is_empty()
                    || label.to_lowercase().contains(&q)
                    || desc.to_lowercase().contains(&q)
            })
            .map(|(i, (a, b, c, d))| (i, a, b, c, d))
            .collect()
    }

    /// Handle a keypress while the command palette is open.
    /// Returns `true` when the user chose Quit and the app should exit.
    fn handle_palette_key(&mut self, key: &crossterm::event::KeyEvent) -> bool {
        let matches = self.filtered_palette();
        match key.code {
            KeyCode::Esc => {
                self.state.palette_open = false;
                self.state.palette_query.clear();
            }
            KeyCode::Enter => {
                if let Some(entry) = matches.get(self.state.palette_selected) {
                    let action = entry.4.to_string();
                    self.state.palette_open = false;
                    self.state.palette_query.clear();
                    return self.run_palette_action(&action);
                }
            }
            KeyCode::Up => {
                self.state.palette_selected = self.state.palette_selected.saturating_sub(1);
            }
            KeyCode::Down => {
                let max = matches.len().saturating_sub(1);
                if self.state.palette_selected < max {
                    self.state.palette_selected += 1;
                }
            }
            KeyCode::Backspace => {
                self.state.palette_query.pop();
                self.state.palette_selected = 0;
            }
            KeyCode::Char(c) => {
                self.state.palette_query.push(c);
                self.state.palette_selected = 0;
            }
            _ => {}
        }
        false
    }

    /// Execute the action chosen in the palette by running its slash command.
    /// Returns `true` if the action should exit the app.
    fn run_palette_action(&mut self, action: &str) -> bool {
        match action {
            "quit" => return true,
            "model" => self.handle_slash_command("/model"),
            "context" => self.handle_slash_command("/context"),
            "sidebar" => self.handle_slash_command("/sidebar"),
            "yolo" => self.handle_slash_command("/yolo"),
            "clear" => self.handle_slash_command("/clear"),
            "queue" => self.handle_slash_command("/queue"),
            "help" => self.handle_slash_command("/help"),
            _ => {}
        }
        false
    }

    fn handle_slash_command(&mut self, cmd: &str) {
        let parts: Vec<&str> = cmd.splitn(2, ' ').collect();
        match parts[0] {
            "/help" => {
                self.state.push_message(Message::System {
                    text: "Commands: /help /model /context /yolo /clear /queue /quit".to_string(),
                });
            }
            "/model" => {
                self.state.push_message(Message::System {
                    text: format!(
                        "Current model: {}  (use /model <name> to switch)",
                        self.state.model
                    ),
                });
            }
            "/context" => {
                let pct = if self.state.ctx_total > 0 {
                    self.state.ctx_used as f64 / self.state.ctx_total as f64
                } else {
                    0.0
                };
                self.state.push_message(Message::System {
                    text: format!(
                        "Context: {:.0}% ({}/{} tokens)",
                        pct * 100.0,
                        self.state.ctx_used,
                        self.state.ctx_total
                    ),
                });
            }
            "/yolo" => {
                if parts.len() > 1 && parts[1] == "off" {
                    self.state.yolo = false;
                } else {
                    self.state.yolo = true;
                }
                let state = if self.state.yolo { "ON" } else { "OFF" };
                self.state.push_message(Message::System {
                    text: format!("YOLO mode: {}", state),
                });
            }
            "/clear" => {
                self.state.messages.clear();
                self.state.scroll_offset = 0;
            }
            "/queue" => {
                if self.state.message_queue.is_empty() {
                    self.state.push_message(Message::System {
                        text: "No messages in queue".to_string(),
                    });
                } else {
                    let count = self.state.message_queue.len();
                    let list: Vec<String> = self.state.message_queue.iter().enumerate().map(|(i, m)| {
                        let preview = if m.len() > 40 { format!("{}...", &m[..37]) } else { m.clone() };
                        format!("  {}. {}", i + 1, preview)
                    }).collect();
                    self.state.push_message(Message::System {
                        text: format!("Queued messages ({}):\n{}", count, list.join("\n")),
                    });
                }
            }
            "/sidebar" => {
                self.state.show_sidebar = !self.state.show_sidebar;
                let state = if self.state.show_sidebar { "ON" } else { "OFF" };
                self.state.push_message(Message::System {
                    text: format!("Sidebar: {}", state),
                });
            }
            _ => {
                self.state.push_message(Message::System {
                    text: format!("Unknown command: {}", parts[0]),
                });
            }
        }
    }

    // ===========================================================================
    // Rendering - functional buttons
    // ===========================================================================

    fn draw(&self, f: &mut Frame) {
        let area = f.area();

        let has_messages = !self.state.messages.is_empty();

        if has_messages {
            // Chat view
            if self.state.show_sidebar {
                let chunks = Layout::default()
                    .direction(Direction::Horizontal)
                    .constraints([
                        Constraint::Min(40),
                        Constraint::Length(30),
                    ])
                    .split(area);

                let main_chunks = Layout::default()
                    .direction(Direction::Vertical)
                    .constraints([
                        Constraint::Min(4),
                        Constraint::Length(5),
                        Constraint::Length(1),
                    ])
                    .split(chunks[0]);

                self.draw_scrollback(f, main_chunks[0]);
                self.draw_input_box(f, main_chunks[1]);
                self.draw_footer(f, main_chunks[2]);
                self.draw_sidebar(f, chunks[1]);
            } else {
                let chunks = Layout::default()
                    .direction(Direction::Vertical)
                    .constraints([
                        Constraint::Min(4),
                        Constraint::Length(5),
                        Constraint::Length(1),
                    ])
                    .split(area);

                self.draw_scrollback(f, chunks[0]);
                self.draw_input_box(f, chunks[1]);
                self.draw_footer(f, chunks[2]);
            }
        } else {
            // Home view: one vertically-centered stack, OpenCode-style.
            //
            //   wordmark (4)
            //   blank    (1)
            //   tagline  (1)
            //   blank    (2)
            //   prompt   (5)
            //   footer   (1)
            const STACK: u16 = 4 + 1 + 1 + 2 + 5 + 1;
            let top = area.y + area.height.saturating_sub(STACK) / 2;

            let at = |y_off: u16, height: u16| Rect {
                x: area.x,
                y: top + y_off,
                width: area.width,
                height,
            };

            self.draw_wordmark(f, at(0, 4));
            self.draw_tagline(f, at(5, 1));
            self.draw_input_box(f, at(8, 5));
            self.draw_footer(f, at(13, 1));
            self.draw_version(f, area);
        }

        if let Some((ref msg, ref time)) = self.state.status_msg {
            if time.elapsed() < Duration::from_secs(3) {
                self.draw_status_overlay(f, msg, area);
            }
        }

        // Command palette sits above everything else.
        if self.state.palette_open {
            self.draw_palette(f, area);
        }
    }

    /// OpenCode-style command palette: centered panel, query line, grouped
    /// rows with muted keybind hints, selection in Elitza orange.
    fn draw_palette(&self, f: &mut Frame, area: Rect) {
        const PANEL_W: u16 = 64;
        // 2 border rows + query + divider + section header + one row per command.
        let n_cmds = Self::palette_commands().len() as u16;
        let PANEL_H: u16 = 2 + 1 + 1 + 1 + n_cmds;

        let matches = self.filtered_palette();
        let panel = Rect {
            x: area.x + (area.width.saturating_sub(PANEL_W)) / 2,
            y: area.y + (area.height.saturating_sub(PANEL_H)) / 3,
            width: PANEL_W.min(area.width),
            height: PANEL_H.min(area.height),
        };

        // Inside Borders::ALL the usable text width is panel.width - 2.
        let inner = panel.width.saturating_sub(2) as usize;
        let mut lines: Vec<Line> = Vec::new();

        // Header: query echo on the left, `esc` flush right.
        let prompt = if self.state.palette_query.is_empty() {
            "Type a command…".to_string()
        } else {
            self.state.palette_query.clone()
        };
        let left = format!(" {} ", prompt);
        // `.len()` is bytes; the ellipsis is multibyte, so pad by display cells.
        let left_cells = left.chars().count();
        let hint_pad = inner.saturating_sub(left_cells + 3);
        lines.push(Line::from(vec![
            Span::styled(left, Style::default().fg(TEXT_PRIMARY)),
            Span::styled(" ".repeat(hint_pad), Style::default().fg(TEXT_DIM)),
            Span::styled("esc", Style::default().fg(TEXT_DIM)),
        ]));

        lines.push(Line::from(Span::styled(
            "─".repeat(inner),
            Style::default().fg(BORDER_SUBTLE),
        )));

        // Section header (OpenCode groups commands under an accent label).
        lines.push(Line::from(Span::styled(
            " Commands",
            Style::default().fg(ACCENT_HEADER).add_modifier(Modifier::BOLD),
        )));

        if matches.is_empty() {
            lines.push(Line::from(Span::styled(
                "  No matching commands",
                Style::default().fg(TEXT_DIM),
            )));
        }

        for (i, (_idx, label, desc, keybind, _)) in matches.iter().enumerate() {
            let selected = i == self.state.palette_selected;

            let head = format!(" {} ", label);
            let body = format!("{} ", desc);
            let pad = inner
                .saturating_sub(head.len() + body.len() + keybind.len());

            let (s_head, s_body, s_key) = if selected {
                (
                    Style::default().fg(BG_DARK).bg(ACCENT_PRIMARY).add_modifier(Modifier::BOLD),
                    Style::default().fg(BG_DARK).bg(ACCENT_PRIMARY),
                    Style::default().fg(BG_DARK).bg(ACCENT_PRIMARY),
                )
            } else {
                (
                    Style::default().fg(TEXT_PRIMARY),
                    Style::default().fg(TEXT_DIM),
                    Style::default().fg(TEXT_DIM),
                )
            };

            lines.push(Line::from(vec![
                Span::styled(head, s_head),
                Span::styled(body, s_body),
                Span::styled(" ".repeat(pad), s_body),
                Span::styled(keybind.clone(), s_key),
            ]));
        }

        f.render_widget(ratatui::widgets::Clear, panel);
        f.render_widget(
            Paragraph::new(lines).block(
                ratatui::widgets::Block::default()
                    .borders(ratatui::widgets::Borders::ALL)
                    .border_style(Style::default().fg(BORDER))
                    .style(Style::default().bg(BG_LIGHT)),
            ),
            panel,
        );
    }

    /// The Elitza wordmark, horizontally centered in `area`.
    fn draw_wordmark(&self, f: &mut Frame, area: Rect) {
        let wm = logo::wordmark();
        let wm_width = logo::wordmark_width() as usize;

        // Horizontal centering: pad each line to the centered offset.
        let offset = (area.width as usize).saturating_sub(wm_width) / 2;
        let pad = " ".repeat(offset);
        let centered: Vec<Line> = wm
            .into_iter()
            .map(|line| {
                let mut spans = vec![Span::raw(pad.clone())];
                spans.extend(line.spans);
                Line::from(spans)
            })
            .collect();

        let para = Paragraph::new(centered).style(Style::default().bg(BG_BASE));
        f.render_widget(para, area);
    }

    /// The brand tagline, horizontally centered in `area`.
    fn draw_tagline(&self, f: &mut Frame, area: Rect) {
        let tag = logo::tagline();
        let tag_width = tag.width() as u16;
        let tag_x = area.x + (area.width.saturating_sub(tag_width)) / 2;
        let tag_area = Rect {
            x: tag_x,
            y: area.y,
            width: tag_width.min(area.width),
            height: 1,
        };
        f.render_widget(Paragraph::new(tag).style(Style::default().bg(BG_BASE)), tag_area);
    }

    fn draw_scrollback(&self, f: &mut Frame, area: Rect) {
        let mut all_lines: Vec<Line<'static>> = Vec::new();

        // Use area.width minus padding for content
        let content_width = area.width.saturating_sub(2);
        
        for msg in &self.state.messages {
            let (mut lines, _height) = render_message(msg, content_width, self.state.frame_idx, self.state.agent_running);
            all_lines.append(&mut lines);
        }

        let total_lines = all_lines.len();
        let visible = area.height as usize;
        let start = if self.state.scroll_offset > 0 && total_lines > visible {
            total_lines.saturating_sub(visible + self.state.scroll_offset)
        } else {
            total_lines.saturating_sub(visible)
        };

        let visible_lines: Vec<Line<'static>> = all_lines
            .into_iter()
            .skip(start)
            .take(visible)
            .collect();

        let style = Style::default().bg(BG_BASE);
        let para = Paragraph::new(visible_lines).style(style);
        f.render_widget(para, area);
    }

    /// Rotating placeholder, OpenCode-style: `Ask anything… "<suggestion>"`.
    fn placeholder_text(&self) -> String {
        const SUGGESTIONS: [&str; 3] = [
            "What is the tech stack of this project?",
            "Fix a TODO in the codebase",
            "Summarize what changed here",
        ];
        let idx = (self.state.frame_idx / 60) % SUGGESTIONS.len();
        format!("Ask anything… \"{}\"", SUGGESTIONS[idx])
    }

    /// Prompt box, OpenCode-style:
    ///
    /// ```text
    ///   ┃
    ///   ┃  Ask anything…
    ///   ┃
    ///   ┃  Build · <model> Elitza
    ///   ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
    /// ```
    ///
    /// A left-only border with a `╹` corner and a half-block bottom edge in
    /// the panel color, so the box reads as a soft slab rather than a cage.
    fn draw_input_box(&self, f: &mut Frame, area: Rect) {
        if area.height < 5 {
            return;
        }

        // Center the composer under the wordmark, capped so it doesn't stretch
        // across an ultrawide terminal.
        let area = centered_block(area, PROMPT_MAX_WIDTH, PROMPT_MAX_WIDTH);

        let border_color = if self.state.agent_running {
            ACCENT_RUNNING
        } else {
            ACCENT_ASSISTANT
        };
        let border_style = Style::default().fg(border_color).bg(BG_BASE);
        let panel_style = Style::default().bg(BG_PANEL);

        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(1), // top pad
                Constraint::Length(1), // input line
                Constraint::Length(1), // spacer
                Constraint::Length(1), // agent · model
                Constraint::Length(1), // bottom edge
            ])
            .split(area);

        // Left border column, four rows of it.
        for row in rows.iter().take(4) {
            f.render_widget(
                Paragraph::new("┃").style(border_style),
                Rect { x: row.x, y: row.y, width: 1, height: 1 },
            );
        }

        // Input line (or rotating placeholder).
        let (input_line, cursor_col) = if self.state.input.is_empty() {
            (
                Line::from(vec![
                    Span::raw("  "),
                    Span::styled(self.placeholder_text(), Style::default().fg(TEXT_DIM)),
                ]),
                None,
            )
        } else {
            let before: String = self.state.input.chars().take(self.state.cursor_pos).collect();
            let after: String = self.state.input.chars().skip(self.state.cursor_pos).collect();
            // Measure before it is moved into the Span below.
            let cursor_col = 2 + before.chars().count();
            (
                Line::from(vec![
                    Span::raw("  "),
                    Span::styled(before, Style::default().fg(TEXT_PRIMARY)),
                    Span::styled(
                        "▏",
                        Style::default().fg(border_color).add_modifier(Modifier::SLOW_BLINK),
                    ),
                    Span::styled(after, Style::default().fg(TEXT_PRIMARY)),
                ]),
                Some(cursor_col),
            )
        };

        // Agent · model · product line.
        let model_info = Line::from(vec![
            Span::raw("  "),
            Span::styled(
                "Build",
                Style::default().fg(border_color).add_modifier(Modifier::BOLD),
            ),
            Span::styled(" · ", Style::default().fg(TEXT_DIM)),
            Span::styled(self.state.model.clone(), Style::default().fg(TEXT_PRIMARY)),
            Span::styled(" Elitza", Style::default().fg(TEXT_DIM)),
        ]);

        // Rows 1-3 carry content; row 0 is the top pad and row 4 the bottom edge.
        let inner = [input_line, Line::from(""), model_info];
        for (i, line) in inner.iter().enumerate() {
            let row = rows[i + 1];
            f.render_widget(
                Paragraph::new(line.clone()).style(panel_style),
                Rect { x: row.x + 1, y: row.y, width: row.width.saturating_sub(1), height: 1 },
            );
        }

        // Bottom edge: `╹` corner then half-blocks in the panel color.
        let bottom = rows[4];
        let fill = bottom.width.saturating_sub(1) as usize;
        f.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled("╹", border_style),
                Span::styled("▀".repeat(fill), Style::default().fg(BG_PANEL).bg(BG_BASE)),
            ])),
            Rect { x: bottom.x, y: bottom.y, width: bottom.width, height: 1 },
        );

        if let Some(col) = cursor_col {
            f.set_cursor_position((rows[1].x + 1 + col as u16, rows[1].y));
        }
    }

    fn draw_footer(&self, f: &mut Frame, area: Rect) {
        // OpenCode-style: working directory on the left, key hints on the right.
        // Keys render bright, their labels muted -- same rhythm as OpenCode.
        let dir = self.state.shorten_working_dir();

        let mut right_spans: Vec<Span> = Vec::new();
        if self.state.ctx_used > 0 {
            let pct = if self.state.ctx_total > 0 {
                self.state.ctx_used as f64 / self.state.ctx_total as f64 * 100.0
            } else {
                0.0
            };
            right_spans.push(Span::styled(
                format!("{:.0}K ({:.0}%)  ", self.state.ctx_used as f64 / 1000.0, pct),
                Style::default().fg(TEXT_DIM),
            ));
        }
        if self.state.agent_running {
            right_spans.push(Span::styled("esc ", Style::default().fg(TEXT_PRIMARY)));
            right_spans.push(Span::styled("interrupt  ", Style::default().fg(TEXT_DIM)));
        }
        right_spans.push(Span::styled("ctrl+p ", Style::default().fg(TEXT_PRIMARY)));
        right_spans.push(Span::styled("commands  ", Style::default().fg(TEXT_DIM)));
        right_spans.push(Span::styled("ctrl+m ", Style::default().fg(TEXT_PRIMARY)));
        right_spans.push(Span::styled("model", Style::default().fg(TEXT_DIM)));

        // Align to the same centered column as the prompt box above it.
        let inner = centered_block(area, PROMPT_MAX_WIDTH, PROMPT_MAX_WIDTH);
        let mut spans = vec![Span::styled(dir, Style::default().fg(TEXT_DIM))];
        spans.push(Span::raw("  "));
        spans.extend(right_spans);

        let para = Paragraph::new(Line::from(spans))
            .style(Style::default().bg(BG_BASE))
            .alignment(ratatui::layout::Alignment::Left);
        f.render_widget(para, inner);
    }

    /// Version stamp, bottom-right of the frame (OpenCode places it the same way).
    fn draw_version(&self, f: &mut Frame, area: Rect) {
        let version = env!("CARGO_PKG_VERSION");
        let text = format!("elitza {}", version);
        let w = text.len() as u16;
        if area.width < w + 2 {
            return;
        }
        let rect = Rect {
            x: area.x + area.width - w,
            y: area.y + area.height - 1,
            width: w,
            height: 1,
        };
        f.render_widget(
            Paragraph::new(Span::styled(text, Style::default().fg(TEXT_DIM)))
                .style(Style::default().bg(BG_BASE)),
            rect,
        );
    }

    fn draw_sidebar(&self, f: &mut Frame, area: Rect) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(3),  // Activity title
                Constraint::Length(7),  // Context section
                Constraint::Length(3),  // Working Directory
                Constraint::Length(3),  // Status/queue
                Constraint::Min(1),    // Spacer
                Constraint::Length(1),  // Version
            ])
            .split(area);

        // Activity title
        let activity_title = if self.state.activity_title.is_empty() {
            "No activity".to_string()
        } else if self.state.activity_title.len() > 24 {
            format!("{}...", &self.state.activity_title[..21])
        } else {
            self.state.activity_title.clone()
        };
        let activity_lines = vec![
            Line::from(vec![
                Span::styled(activity_title, Style::default().fg(TEXT_PRIMARY).add_modifier(Modifier::BOLD)),
            ]),
        ];
        let activity_para = Paragraph::new(activity_lines).style(Style::default().bg(BG_BASE));
        f.render_widget(activity_para, chunks[0]);

        // Context section - tokens, %, speed, cost
        let pct = if self.state.ctx_total > 0 {
            self.state.ctx_used as f64 / self.state.ctx_total as f64
        } else {
            0.0
        };

        let speed_str = if self.state.speed > 0.0 {
            if self.state.speed < 1.0 {
                format!("<1 t/s")
            } else {
                format!("{:.0} t/s", self.state.speed)
            }
        } else {
            "<1 t/s".to_string()
        };

        let context_lines = vec![
            Line::from(vec![
                Span::styled("Context", Style::default().fg(TEXT_PRIMARY).add_modifier(Modifier::BOLD)),
            ]),
            Line::from(vec![
                Span::styled(format!("{} tokens", self.state.format_tokens()), Style::default().fg(TEXT_DIM)),
            ]),
            Line::from(vec![
                Span::styled(format!("{:.0}% used", pct * 100.0), Style::default().fg(TEXT_DIM)),
            ]),
            Line::from(vec![
                Span::styled(&speed_str, Style::default().fg(TEXT_DIM)),
            ]),
            Line::from(vec![
                Span::styled(format!("{} spent", self.state.format_cost()), Style::default().fg(TEXT_DIM)),
            ]),
        ];
        let context_para = Paragraph::new(context_lines).style(Style::default().bg(BG_BASE));
        f.render_widget(context_para, chunks[1]);

        // Working Directory
        let dir_lines = vec![
            Line::from(vec![
                Span::styled("Working Directory", Style::default().fg(TEXT_PRIMARY).add_modifier(Modifier::BOLD)),
            ]),
            Line::from(vec![
                Span::styled(self.state.shorten_working_dir(), Style::default().fg(TEXT_DIM)),
            ]),
        ];
        let dir_para = Paragraph::new(dir_lines).style(Style::default().bg(BG_BASE));
        f.render_widget(dir_para, chunks[2]);

        // Status / Queue indicator
        let (status_char, status_color) = if self.state.agent_running {
            let spinner = SPINNER_FRAMES[self.state.frame_idx % SPINNER_FRAMES.len()];
            (spinner.to_string(), ACCENT_RUNNING)
        } else {
            ("●".to_string(), ACCENT_PRIMARY)
        };
        let status_text = if self.state.agent_running {
            if self.state.queued_count > 0 {
                format!("Thinking... ({} queued)", self.state.queued_count)
            } else {
                "Thinking...".to_string()
            }
        } else {
            "Ready".to_string()
        };
        let status_lines = vec![
            Line::from(vec![
                Span::styled(status_char, Style::default().fg(status_color).add_modifier(Modifier::BOLD)),
                Span::styled(format!(" {}", status_text), Style::default().fg(TEXT_DIM)),
            ]),
        ];
        let status_para = Paragraph::new(status_lines).style(Style::default().bg(BG_BASE));
        f.render_widget(status_para, chunks[3]);

        // Version indicator at bottom
        let version_lines = vec![
            Line::from(vec![
                Span::styled("● ", Style::default().fg(ACCENT_PRIMARY)),
                Span::styled("Elitza 0.1.0", Style::default().fg(TEXT_DIM)),
            ]),
        ];
        let version_para = Paragraph::new(version_lines).style(Style::default().bg(BG_BASE));
        f.render_widget(version_para, chunks[5]);
    }

    fn draw_status_overlay(&self, f: &mut Frame, msg: &str, area: Rect) {
        let overlay_width = (msg.len() + 6).min(area.width as usize);
        let overlay_area = Rect::new(
            area.x + (area.width as usize - overlay_width) as u16 / 2,
            area.y + area.height.saturating_sub(3),
            overlay_width as u16,
            1,
        );

        let text = Line::from(vec![
            Span::styled(" ", Style::default().bg(ACCENT_PRIMARY)),
            Span::styled(
                format!(" {} ", msg),
                Style::default()
                    .fg(TEXT_PRIMARY)
                    .bg(ACCENT_PRIMARY)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" ", Style::default().bg(ACCENT_PRIMARY)),
        ]);
        let para = Paragraph::new(text);
        f.render_widget(para, overlay_area);
    }
}

// ===========================================================================
// Protocol line parser
// ===========================================================================

fn parse_protocol_line(line: &str) -> Option<Action> {
    if line.starts_with("TOKEN ") {
        Some(Action::Token(line[6..].to_string()))
    } else if line == "THINKING_START" {
        Some(Action::ThinkingStart)
    } else if line.starts_with("THINKING ") {
        Some(Action::Thinking(line[9..].to_string()))
    } else if line == "THINKING_END" {
        Some(Action::ThinkingEnd)
    } else if line.starts_with("TOOL_CALL ") {
        let rest = &line[10..];
        let parts: Vec<&str> = rest.splitn(2, ' ').collect();
        Some(Action::ToolCall {
            name: parts[0].to_string(),
            args_summary: parts.get(1).unwrap_or(&"").to_string(),
        })
    } else if line.starts_with("TOOL_RESULT ") {
        let text = &line[12..];
        let is_error = text.starts_with("ERROR:");
        Some(Action::ToolResult {
            result: text.trim_start_matches("ERROR:").trim().to_string(),
            is_error,
        })
    } else if line.starts_with("SHELL_CMD ") {
        Some(Action::ShellCommand {
            command: line[10..].to_string(),
        })
    } else if line.starts_with("SHELL_OUTPUT ") {
        let output = line[13..].trim_start_matches("ERROR:").trim().to_string();
        Some(Action::ShellOutput {
            output,
        })
    } else if line == "DONE" {
        Some(Action::TurnComplete)
    } else if line.starts_with("METRICS ") {
        // Format: METRICS tokens=<n> cost=<f> speed=<f>
        let rest = &line[8..];
        let mut tokens = 0u64;
        let mut cost = 0.0f64;
        let mut speed = 0.0f64;
        for part in rest.split_whitespace() {
            if let Some(val) = part.strip_prefix("tokens=") {
                tokens = val.parse().unwrap_or(0);
            } else if let Some(val) = part.strip_prefix("cost=") {
                cost = val.parse().unwrap_or(0.0);
            } else if let Some(val) = part.strip_prefix("speed=") {
                speed = val.parse().unwrap_or(0.0);
            }
        }
        Some(Action::MetricsUpdate { tokens, cost, speed })
    } else if line.starts_with("ACTIVITY ") {
        Some(Action::ActivityUpdate {
            title: line[9..].to_string(),
        })
    } else {
        None
    }
}

// ===========================================================================
// Entry point
// ===========================================================================

fn main() -> io::Result<()> {
    let args: Vec<String> = std::env::args().collect();

    let demo_mode = args.iter().any(|a| a == "--demo");
    let model = args
        .iter()
        .skip(1)
        .find(|a| !a.starts_with('-'))
        .cloned()
        .unwrap_or_else(|| "inclusionai/ling-3.1-flash".to_string());
    let session_id = args
        .iter()
        .skip(2)
        .find(|a| !a.starts_with('-'))
        .cloned()
        .unwrap_or_else(|| {
            use std::time::{SystemTime, UNIX_EPOCH};
            let t = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            format!("{:x}", t)
        });

    let mut app = ElitzaApp::new(model, session_id, demo_mode);
    app.run()
}
