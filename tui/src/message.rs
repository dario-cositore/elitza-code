use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

use crate::theme::*;

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub enum Message {
    User { text: String },
    Assistant {
        content: String,
        thinking: Option<String>,
        thinking_collapsed: bool,
    },
    ToolCall {
        name: String,
        args_summary: String,
        running: bool,
        result: Option<ToolResult>,
    },
    ShellCommand {
        command: String,
        running: bool,
        output: Option<String>,
    },
    System { text: String },
    Separator,
    Spacer,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct ToolResult {
    pub text: String,
    pub is_error: bool,
    pub truncated: bool,
}

/// Clean escape sequences from text (like \n, \t, |, etc.)
fn clean_escapes(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    
    while i < chars.len() {
        match chars[i] {
            '\\' if i + 1 < chars.len() => {
                match chars[i + 1] {
                    'n' => { result.push('\n'); i += 2; }
                    't' => { result.push_str("  "); i += 2; }
                    'r' => { i += 2; }
                    '\\' => { result.push('\\'); i += 2; }
                    '"' => { result.push('"'); i += 2; }
                    '\'' => { result.push('\''); i += 2; }
                    _ => { result.push(chars[i]); i += 1; }
                }
            }
            '|' if i > 0 && i + 1 < chars.len() => {
                // Pipe in table-like content - keep as is
                result.push(chars[i]);
                i += 1;
            }
            _ => {
                result.push(chars[i]);
                i += 1;
            }
        }
    }
    
    result
}

/// Wrap text to fit within max_width, breaking at word boundaries
fn wrap_text(text: &str, max_width: usize) -> Vec<String> {
    if text.is_empty() {
        return vec![String::new()];
    }
    
    let mut result = Vec::new();
    
    for paragraph in text.split('\n') {
        if paragraph.is_empty() {
            result.push(String::new());
            continue;
        }
        
        let mut current_line = String::new();
        
        for word in paragraph.split_whitespace() {
            if current_line.len() + word.len() + 1 > max_width && !current_line.is_empty() {
                result.push(current_line.clone());
                current_line = word.to_string();
            } else {
                if !current_line.is_empty() {
                    current_line.push(' ');
                }
                current_line.push_str(word);
            }
        }
        if !current_line.is_empty() {
            result.push(current_line);
        }
    }
    
    if result.is_empty() {
        result.push(String::new());
    }
    
    result
}

pub fn render_message(msg: &Message, width: u16, frame_idx: usize, agent_running: bool) -> (Vec<Line<'static>>, u16) {
    let mut lines: Vec<Line> = Vec::new();
    let content_width = width.saturating_sub(4) as usize;

    match msg {
        Message::User { text } => {
            let cleaned = clean_escapes(text);
            let wrapped = wrap_text(&cleaned, content_width.saturating_sub(2));
            for (i, line) in wrapped.iter().enumerate() {
                if i == 0 {
                    lines.push(Line::from(vec![
                        Span::styled("┃ ", Style::default().fg(ACCENT_PRIMARY)),
                        Span::styled(line.clone(), Style::default().fg(TEXT_PRIMARY)),
                    ]));
                } else {
                    lines.push(Line::from(vec![
                        Span::styled("  ", Style::default()),
                        Span::styled(line.clone(), Style::default().fg(TEXT_PRIMARY)),
                    ]));
                }
            }
            lines.push(Line::raw(""));
        }
        Message::Assistant { content, thinking, thinking_collapsed } => {
            // Thinking block
            if let Some(t) = thinking {
                if !t.trim().is_empty() {
                    let cleaned_thinking = clean_escapes(t);
                    if *thinking_collapsed {
                        let line_count = cleaned_thinking.lines().count();
                        let preview = cleaned_thinking.lines().next().unwrap_or("").chars().take(80).collect::<String>();
                        lines.push(Line::from(vec![
                            Span::styled("+ ", Style::default().fg(ACCENT_THINKING).add_modifier(Modifier::BOLD)),
                            Span::styled("Thought", Style::default().fg(ACCENT_THINKING).add_modifier(Modifier::BOLD)),
                            Span::styled(format!(" ({} lines)", line_count), Style::default().fg(TEXT_DIM)),
                        ]));
                        if !preview.is_empty() {
                            lines.push(Line::from(vec![
                                Span::styled("  ", Style::default()),
                                Span::styled(preview, Style::default().fg(TEXT_DIM)),
                                Span::styled(" ...", Style::default().fg(TEXT_DIM)),
                            ]));
                        }
                    } else {
                        let spinner = if agent_running {
                            format!(" {}", SPINNER_FRAMES[frame_idx % SPINNER_FRAMES.len()])
                        } else {
                            String::new()
                        };
                        lines.push(Line::from(vec![
                            Span::styled("+ ", Style::default().fg(ACCENT_THINKING).add_modifier(Modifier::BOLD)),
                            Span::styled("Thought", Style::default().fg(ACCENT_THINKING).add_modifier(Modifier::BOLD)),
                            Span::styled(spinner, Style::default().fg(ACCENT_RUNNING)),
                        ]));
                        for line in cleaned_thinking.lines() {
                            let wrapped = wrap_text(line, content_width.saturating_sub(4));
                            for wline in wrapped {
                                lines.push(Line::from(vec![
                                    Span::styled("  ", Style::default()),
                                    Span::styled(wline, Style::default().fg(TEXT_DIM)),
                                ]));
                            }
                        }
                    }
                    lines.push(Line::raw(""));
                }
            }

            // Assistant content
            if content.is_empty() && agent_running {
                let spinner = SPINNER_FRAMES[frame_idx % SPINNER_FRAMES.len()];
                lines.push(Line::from(vec![
                    Span::styled("  ", Style::default()),
                    Span::styled(spinner, Style::default().fg(ACCENT_ASSISTANT).add_modifier(Modifier::BOLD)),
                ]));
            } else {
                let cleaned = clean_escapes(content);
                let all_lines = render_markdown(&cleaned, content_width);
                for line in all_lines {
                    lines.push(line);
                }
            }
            lines.push(Line::raw(""));
        }
        Message::ToolCall { name, args_summary, running, result } => {
            let cleaned_args = clean_escapes(args_summary);
            if *running {
                let spinner = SPINNER_FRAMES[frame_idx % SPINNER_FRAMES.len()];
                lines.push(Line::from(vec![
                    Span::styled("  ", Style::default()),
                    Span::styled(spinner, Style::default().fg(ACCENT_RUNNING)),
                    Span::styled(" ", Style::default()),
                    Span::styled("→", Style::default().fg(ACCENT_TOOL)),
                    Span::styled(" ", Style::default()),
                    Span::styled(name.clone(), Style::default().fg(ACCENT_TOOL).add_modifier(Modifier::BOLD)),
                    Span::styled(format!(" {}", cleaned_args), Style::default().fg(TEXT_DIM)),
                ]));
            } else {
                let status_icon = if result.as_ref().map_or(false, |r| r.is_error) { "✗" } else { "→" };
                let status_color = if result.as_ref().map_or(false, |r| r.is_error) { ACCENT_ERROR } else { ACCENT_TOOL };
                lines.push(Line::from(vec![
                    Span::styled("  ", Style::default()),
                    Span::styled(status_icon, Style::default().fg(status_color)),
                    Span::styled(" ", Style::default()),
                    Span::styled(name.clone(), Style::default().fg(ACCENT_TOOL).add_modifier(Modifier::BOLD)),
                    Span::styled(format!(" {}", cleaned_args), Style::default().fg(TEXT_DIM)),
                ]));
            }

            if let Some(res) = result {
                let cleaned_result = clean_escapes(&res.text);
                let text_style = if res.is_error {
                    Style::default().fg(ACCENT_ERROR)
                } else {
                    Style::default().fg(TEXT_DIM)
                };
                // Show first few lines of result
                for line in cleaned_result.lines().take(5) {
                    let wrapped = wrap_text(line, content_width.saturating_sub(6));
                    for wline in wrapped {
                        lines.push(Line::from(vec![
                            Span::styled("    ", Style::default()),
                            Span::styled(wline, text_style),
                        ]));
                    }
                }
                if cleaned_result.lines().count() > 5 {
                    lines.push(Line::from(vec![
                        Span::styled("    ", Style::default()),
                        Span::styled("···", Style::default().fg(TEXT_DIM)),
                    ]));
                }
            }
            lines.push(Line::raw(""));
        }
        Message::ShellCommand { command, running, output } => {
            if *running {
                let spinner = SPINNER_FRAMES[frame_idx % SPINNER_FRAMES.len()];
                lines.push(Line::from(vec![
                    Span::styled("  ", Style::default().bg(BG_CODE)),
                    Span::styled(spinner, Style::default().fg(ACCENT_RUNNING).bg(BG_CODE)),
                    Span::styled(" ", Style::default().bg(BG_CODE)),
                    Span::styled("$", Style::default().fg(ACCENT_TOOL).add_modifier(Modifier::BOLD).bg(BG_CODE)),
                    Span::styled(" ", Style::default().bg(BG_CODE)),
                    Span::styled(command.clone(), Style::default().fg(TEXT_PRIMARY).bg(BG_CODE)),
                ]));
            } else {
                lines.push(Line::from(vec![
                    Span::styled("  ", Style::default().bg(BG_CODE)),
                    Span::styled("$", Style::default().fg(ACCENT_TOOL).add_modifier(Modifier::BOLD).bg(BG_CODE)),
                    Span::styled(" ", Style::default().bg(BG_CODE)),
                    Span::styled(command.clone(), Style::default().fg(TEXT_PRIMARY).bg(BG_CODE)),
                ]));
            }
            if let Some(out) = output {
                let cleaned = clean_escapes(out);
                for line in cleaned.lines().take(10) {
                    let wrapped = wrap_text(line, content_width.saturating_sub(4));
                    for wline in wrapped {
                        lines.push(Line::from(vec![
                            Span::styled("    ", Style::default().bg(BG_CODE)),
                            Span::styled(wline, Style::default().fg(TEXT_DIM).bg(BG_CODE)),
                        ]));
                    }
                }
            }
            lines.push(Line::raw(""));
        }
        Message::System { text } => {
            let cleaned = clean_escapes(text);
            let wrapped = wrap_text(&cleaned, content_width);
            for wline in wrapped {
                lines.push(Line::from(vec![
                    Span::styled("  ", Style::default()),
                    Span::styled(wline, Style::default().fg(TEXT_DIM).add_modifier(Modifier::DIM)),
                ]));
            }
        }
        Message::Separator => {
            let w = width as usize;
            lines.push(Line::from(vec![
                Span::styled("  ", Style::default()),
                Span::styled("─".repeat(w.saturating_sub(4)), Style::default().fg(BORDER)),
            ]));
        }
        Message::Spacer => {
            lines.push(Line::raw(""));
        }
    }

    let height = lines.len() as u16;
    let lines: Vec<Line<'static>> = lines.into_iter().map(|l| {
        let spans: Vec<ratatui::text::Span<'static>> = l.spans.into_iter().map(|s| {
            ratatui::text::Span::styled(s.content.into_owned(), s.style)
        }).collect();
        Line::from(spans)
    }).collect();

    (lines, height)
}

/// Render markdown content with proper formatting
fn render_markdown(text: &str, max_width: usize) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let mut in_code_block = false;
    let mut code_lang = String::new();
    
    // Use a tighter width to ensure text doesn't overflow into sidebar
    let safe_width = max_width.saturating_sub(2);
    
    for line in text.lines() {
        let trimmed = line.trim();
        
        // Code blocks
        if trimmed.starts_with("```") {
            if in_code_block {
                lines.push(Line::from(vec![
                    Span::styled("  └", Style::default().fg(TEXT_DIM)),
                ]));
                in_code_block = false;
                code_lang.clear();
            } else {
                code_lang = trimmed[3..].trim().to_string();
                let lang_display = if code_lang.is_empty() { String::new() } else { format!(" ({})", code_lang) };
                lines.push(Line::from(vec![
                    Span::styled("  ┌─ Code Block", Style::default().fg(ACCENT_TOOL).add_modifier(Modifier::BOLD)),
                    Span::styled(lang_display, Style::default().fg(TEXT_DIM)),
                ]));
                in_code_block = true;
            }
            continue;
        }
        
        if in_code_block {
            let wrapped = wrap_text(line, safe_width.saturating_sub(4));
            for wline in wrapped {
                lines.push(Line::from(vec![
                    Span::styled("  │ ", Style::default().fg(ACCENT_TOOL)),
                    Span::styled(wline, Style::default().fg(ACCENT_TOOL).bg(BG_CODE)),
                ]));
            }
            continue;
        }
        
        // Headers
        if trimmed.starts_with("# ") {
            let header_text = &trimmed[2..];
            let wrapped = wrap_text(header_text, safe_width);
            for wline in wrapped {
                lines.push(Line::from(vec![
                    Span::styled("  ", Style::default()),
                    Span::styled(wline, Style::default().fg(ACCENT_HEADER).add_modifier(Modifier::BOLD)),
                ]));
            }
            continue;
        }
        if trimmed.starts_with("## ") {
            let header_text = &trimmed[3..];
            let wrapped = wrap_text(header_text, safe_width);
            for wline in wrapped {
                lines.push(Line::from(vec![
                    Span::styled("  ", Style::default()),
                    Span::styled(wline, Style::default().fg(ACCENT_HEADER).add_modifier(Modifier::BOLD)),
                ]));
            }
            continue;
        }
        if trimmed.starts_with("### ") {
            let header_text = &trimmed[4..];
            let wrapped = wrap_text(header_text, safe_width);
            for wline in wrapped {
                lines.push(Line::from(vec![
                    Span::styled("  ", Style::default()),
                    Span::styled(wline, Style::default().fg(ACCENT_HEADER).add_modifier(Modifier::BOLD)),
                ]));
            }
            continue;
        }
        
        // Bullet points
        if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
            let bullet_text = &trimmed[2..];
            let wrapped = wrap_text(bullet_text, safe_width.saturating_sub(4));
            for (i, wline) in wrapped.iter().enumerate() {
                if i == 0 {
                    lines.push(Line::from(vec![
                        Span::styled("  • ", Style::default().fg(ACCENT_PRIMARY)),
                        Span::styled(wline.clone(), Style::default().fg(TEXT_PRIMARY)),
                    ]));
                } else {
                    lines.push(Line::from(vec![
                        Span::styled("    ", Style::default()),
                        Span::styled(wline.clone(), Style::default().fg(TEXT_PRIMARY)),
                    ]));
                }
            }
            continue;
        }
        
        // Numbered lists
        if trimmed.len() > 2 && trimmed.chars().next().map_or(false, |c| c.is_ascii_digit()) {
            if let Some(dot_pos) = trimmed.find(". ") {
                let num = &trimmed[..dot_pos + 1];
                let list_text = &trimmed[dot_pos + 2..];
                let wrapped = wrap_text(list_text, safe_width.saturating_sub(6));
                for (i, wline) in wrapped.iter().enumerate() {
                    if i == 0 {
                        lines.push(Line::from(vec![
                            Span::styled(format!("  {} ", num), Style::default().fg(ACCENT_TOOL).add_modifier(Modifier::BOLD)),
                            Span::styled(wline.clone(), Style::default().fg(TEXT_PRIMARY)),
                        ]));
                    } else {
                        lines.push(Line::from(vec![
                            Span::styled("    ", Style::default()),
                            Span::styled(wline.clone(), Style::default().fg(TEXT_PRIMARY)),
                        ]));
                    }
                }
                continue;
            }
        }
        
        // Bold text with ** markers
        if trimmed.contains("**") {
            let wrapped = wrap_text(trimmed, safe_width);
            for wline in wrapped {
                let spans = render_bold_text(&wline);
                let mut line_spans = vec![Span::raw("  ")];
                line_spans.extend(spans);
                lines.push(Line::from(line_spans));
            }
            continue;
        }
        
        // Table rows (lines with |)
        if trimmed.contains('|') && trimmed.chars().filter(|c| *c == '|').count() >= 2 {
            let spans = render_table_row(trimmed);
            let mut line_spans = vec![Span::raw("  ")];
            line_spans.extend(spans);
            lines.push(Line::from(line_spans));
            continue;
        }
        
        // Regular text - wrap properly
        let wrapped = wrap_text(trimmed, safe_width);
        for wline in wrapped {
            lines.push(Line::from(vec![
                Span::styled("  ", Style::default()),
                Span::styled(wline, Style::default().fg(TEXT_PRIMARY)),
            ]));
        }
    }
    
    if in_code_block {
        lines.push(Line::from(vec![
            Span::styled("  └", Style::default().fg(TEXT_DIM)),
        ]));
    }
    
    lines
}

/// Render bold text (text between ** markers)
fn render_bold_text(text: &str) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    let parts: Vec<&str> = text.split("**").collect();
    
    for (i, part) in parts.iter().enumerate() {
        if i % 2 == 0 {
            // Regular text
            if !part.is_empty() {
                spans.push(Span::styled(
                    part.to_string(),
                    Style::default().fg(TEXT_PRIMARY),
                ));
            }
        } else {
            // Bold text
            spans.push(Span::styled(
                part.to_string(),
                Style::default().fg(ACCENT_PRIMARY).add_modifier(Modifier::BOLD),
            ));
        }
    }
    
    spans
}

/// Render table row
fn render_table_row(text: &str) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    let cells: Vec<&str> = text.split('|').collect();
    
    for (i, cell) in cells.iter().enumerate() {
        let cell = cell.trim();
        if cell.is_empty() {
            continue;
        }
        
        // Check if it's a separator row (---, ===, etc.)
        if cell.chars().all(|c| c == '-' || c == '=' || c == ':') {
            spans.push(Span::styled(
                "─".repeat(cell.len()),
                Style::default().fg(BORDER),
            ));
        } else if i == 1 {
            // First cell - header style
            spans.push(Span::styled(
                cell.to_string(),
                Style::default().fg(ACCENT_HEADER).add_modifier(Modifier::BOLD),
            ));
        } else {
            // Other cells
            spans.push(Span::styled(
                cell.to_string(),
                Style::default().fg(TEXT_PRIMARY),
            ));
        }
        
        // Add separator
        if i < cells.len() - 1 {
            spans.push(Span::styled(" │ ", Style::default().fg(BORDER)));
        }
    }
    
    spans
}

/// Wrap a list of spans to fit within max_width
fn wrap_spans(spans: Vec<Span<'static>>, max_width: usize) -> Vec<Vec<Span<'static>>> {
    let mut result = Vec::new();
    let mut current_line = Vec::new();
    let mut current_width = 0;
    
    for span in spans {
        let span_width = span.content.len();
        
        if current_width + span_width > max_width && !current_line.is_empty() {
            result.push(current_line);
            current_line = Vec::new();
            current_width = 0;
        }
        
        current_line.push(span);
        current_width += span_width;
    }
    
    if !current_line.is_empty() {
        result.push(current_line);
    }
    
    if result.is_empty() {
        result.push(Vec::new());
    }
    
    result
}

