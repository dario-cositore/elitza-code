"""
Elitza TUI -- Elitza's terminal interface using Textual.

Textual is the Python equivalent of Rust's ratatui. It gives us:
  - True alternate screen with owned background
  - Cell-buffer diffing (only changed cells are redrawn)
  - Timer-based animations (wave, spinner) independent of content
  - Proper keyboard event handling
  - CSS-like styling for dark theme
  - Scrollable viewports

Architecture:
  - ElitzaApp: main Textual App, handles layout + keyboard + timers
  - StreamView: scrollable area showing conversation history
  - InputBar: prompt input at bottom
  - StatusBar: model/session/context info at top
  - Messages are plain strings with ANSI, rendered via Rich log
"""

import os
import sys
import time
import shutil
import threading
from enum import Enum, auto
from pathlib import Path
from typing import Callable, List, Optional, Tuple

from textual.app import App, ComposeResult
from textual.containers import Container, ScrollableContainer
from textual.widgets import Static, Input, Header, Footer
from textual.color import Color
from textual.css.query import NoMatches
from textual.timer import Timer
from textual import events
from textual.screen import Screen


# ===========================================================================
# Color Palette -- OpenCode theme (dark)
# ===========================================================================

class ElitzaTheme:
    """Colors matching the OpenCode theme. All values are final -- no quantization needed;
    Textual handles truecolor natively."""

    BG = Color.parse("#0a0a0a")          # bg_base -- the dark background
    BG_LIGHT = Color.parse("#282828")     # bg_light
    BG_DARK = Color.parse("#141414")      # bg_dark
    BG_HL = Color.parse("#1e1e1e")        # bg_highlight

    ACCENT_USER = Color.parse("#eeeeee")
    ACCENT_ASSISTANT = Color.parse("#5c9cf5")
    ACCENT_THINKING = Color.parse("#56b6c2")
    ACCENT_TOOL = Color.parse("#9d7cd8")
    ACCENT_SYSTEM = Color.parse("#808080")
    ACCENT_ERROR = Color.parse("#e06c75")
    ACCENT_SUCCESS = Color.parse("#7fd88f")
    ACCENT_RUNNING = Color.parse("#f5a742")
    ACCENT_MODEL = Color.parse("#9d7cd8")
    ACCENT_COLLAPSED = Color.parse("#606060")

    TEXT_PRIMARY = Color.parse("#eeeeee")
    TEXT_SECONDARY = Color.parse("#b5b5b5")
    GRAY_DIM = Color.parse("#606060")
    GRAY = Color.parse("#808080")
    GRAY_BRIGHT = Color.parse("#b5b5b5")
    BORDER = Color.parse("#484848")

    DIFF_DEL_BG = Color.parse("#37222c")
    DIFF_DEL_FG = Color.parse("#e26a75")
    DIFF_INS_BG = Color.parse("#20303b")
    DIFF_INS_FG = Color.parse("#7fd88f")


# ===========================================================================
# Logger widget that accumulates lines (replaces StreamingOutput)
# ===========================================================================

from textual.widgets import RichLog


class MessageLog(RichLog):
    """The main scrollable conversation area.

    Instead of re-rendering a giant Group on every token (Rich Live approach),
    we append individual Rich renderables to this widget. Textual's RichLog
    efficiently manages the scrollback buffer and only redraws changed lines.
    """

    def __init__(self, *args, **kwargs):
        kwargs["highlight"] = True
        kwargs["markup"] = True
        super().__init__(*args, **kwargs)
        self.can_focus = True  # allow scrollback navigation

    def add_user(self, text: str):
        from rich.text import Text
        t = Text()
        t.append("◆ ", style="bold white")
        t.append(text, style="#eeeeee")
        self.write(t)
        self.write("")  # spacer

    def add_assistant_start(self):
        from rich.text import Text
        self._prefix = Text()
        self._prefix.append("◇ ", style="#5c9cf5")
        self.write(self._prefix)
        self.write("")

    def add_thinking(self, text: str):
        from rich.text import Text
        t = Text()
        t.append("┌─ ", style="#56b6c2")
        t.append("Thinking", style="italic #56b6c2")
        t.append(" ···", style="#f5a742")
        self.write(t)
        for line in text.split("\n"):
            tl = Text()
            tl.append("│  ", style="#56b6c2")
            tl.append(line, style="dim #56b6c2")
            self.write(tl)
        t2 = Text()
        t2.append("└─", style="#56b6c2")
        self.write(t2)
        self.write("")

    def add_token(self, token: str):
        """Append a streaming token to the current line."""
        from rich.text import Text
        t = Text(token, style="#eeeeee")
        self.write(t)

    def add_tool_call(self, name: str, args: dict, running: bool = True):
        from rich.text import Text
        t = Text()
        if running:
            t.append("◈ ", style="#f5a742")
            t.append(name, style="italic #9d7cd8")
            arg_str = ", ".join(f"{k}={repr(v)[:20]}" for k, v in list(args.items())[:2])
            if arg_str:
                t.append(f"({arg_str})", style="#606060")
            t.append(" ···", style="#f5a742")
        else:
            t.append("◈ ", style="#9d7cd8")
            t.append(name, style="italic #9d7cd8")
            arg_str = ", ".join(f"{k}={repr(v)[:20]}" for k, v in list(args.items())[:2])
            if arg_str:
                t.append(f"({arg_str})", style="#606060")
        self.write(t)

    def add_tool_result(self, result: str, is_error: bool = False):
        from rich.text import Text
        t = Text()
        if is_error:
            t.append("└─✗ ", style="bold #e06c75")
            t.append(result[:200], style="#e06c75")
        else:
            t.append("└─▶ ", style="#484848")
            t.append(result[:300], style="#808080")
            if len(result) > 300:
                t.append(f" …({len(result)} chars)", style="dim #606060")
        self.write(t)
        self.write("")

    def add_shell_command(self, cmd: str, running: bool = True):
        from rich.text import Text
        t = Text()
        if running:
            t.append("$ ", style="#f5a742")
            t.append(cmd, style="#eeeeee")
            t.append(" ···", style="#f5a742")
        else:
            t.append("$ ", style="#808080")
            t.append(cmd, style="#eeeeee")
        self.write(t)

    def add_shell_output(self, output: str, is_error: bool = False):
        from rich.text import Text
        color = "#e06c75" if is_error else "#808080"
        for line in output.split("\n")[:20]:
            t = Text()
            t.append("│ ", style="#606060")
            t.append(line, style=color)
            self.write(t)

    def add_system(self, text: str):
        from rich.text import Text
        t = Text()
        t.append("  ", style="#484848")
        t.append(text, style="dim #606060")
        self.write(t)

    def add_separator(self):
        from rich.text import Text
        cols = shutil.get_terminal_size().columns
        t = Text("  " + "─" * (cols - 4), style="#484848")
        self.write(t)

    def add_wordmark(self):
        """Write the ELITZA wordmark (OpenCode-style two-tone block letters)."""
        from rich.text import Text
        for row in wordmark_lines():
            self.write(Text.from_markup("  " + row))
        self.write("")


# ===========================================================================
# Animation state for the spinner/wave in the status area
# ===========================================================================

BRAILLE = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"


class ElitzaTUI(App):
    """Main Textual application for Elitza.

    This replaces the Rich Live loop with a proper TUI that:
      - Owns the alternate screen (dark background everywhere)
      - Animates spinner independently via timer
      - Handles keyboard events properly
      - Only redraws changed content
    """

    CSS = """
    Screen {
        background: $surface;
    }

    #status-bar {
        dock: top;
        height: 3;
        background: #141414;
        color: #808080;
        padding: 0 2;
        content-align: left middle;
        border-bottom: solid #282828;
    }

    #context-bar {
        height: 1;
        background: #141414;
        color: #606060;
        padding: 0 2;
    }

    #message-log {
        height: 1fr;
        background: #0a0a0a;
        padding: 0 2;
        overflow-y: auto;
        overflow-x: hidden;
    }

    #input-bar {
        dock: bottom;
        height: 3;
        background: #141414;
        border-top: solid #282828;
        padding: 0 2;
    }

    #shortcuts-bar {
        dock: bottom;
        height: 1;
        background: #141414;
        color: #606060;
        padding: 0 2;
    }

    Input {
        background: #141414;
        border: none;
        color: #eeeeee;
        padding: 1 0;
    }

    Input:focus {
        border: none;
    }

    RichLog {
        background: #0a0a0a;
    }
    """

    BINDINGS = [
        ("ctrl+q", "quit", "Quit"),
        ("ctrl+c", "cancel", "Cancel"),
        ("ctrl+l", "clear", "Clear"),
        ("ctrl+m", "model_picker", "Model"),
        ("ctrl+o", "toggle_yolo", "YOLO"),
        ("pageup", "scroll_up", "Scroll Up"),
        ("pagedown", "scroll_down", "Scroll Down"),
    ]

    def __init__(self, agent=None, theme_name: str = "elitza", **kwargs):
        super().__init__(**kwargs)
        self._agent = agent
        self._theme_name = theme_name
        self._turn = 0
        self._ctx_used = 0
        self._ctx_total = 2000000
        self._yolo = False
        self._vim_mode = False
        self._compact_mode = False
        self._spinner_idx = 0
        self._timer: Optional[Timer] = None
        self._callbacks: dict = {}

    def compose(self) -> ComposeResult:
        """Build the UI layout."""
        yield Static("", id="status-bar")
        yield Static("", id="context-bar")
        yield MessageLog(id="message-log", wrap=True, auto_scroll=True)
        yield Input(placeholder="", id="input-bar")
        yield Static(self._shortcuts_text(), id="shortcuts-bar")

    def on_mount(self) -> None:
        """Called when the app is mounted. This is where we set up the initial state."""
        self.title = "Elitza"
        self.sub_title = ""

        # Enter alternate screen + hide cursor
        self.screen.styles.background = Color.parse("#0a0a0a")

        # Update status bar
        self._update_status()
        self._update_context_bar()

        # Start spinner animation timer (12fps)
        self._timer = self.set_interval(1 / 12, self._animate_spinner)

        # Focus the input
        self.query_one("#input-bar", Input).focus()

        # Show header -- OpenCode-style wordmark, same as the Rust TUI
        model = self._agent.model if self._agent else "unknown"
        session = self._agent.session_id[:8] if self._agent else "?"
        log = self.query_one("#message-log", MessageLog)
        log.add_wordmark()
        log.add_system("")
        log.add_system(f"Build · {model}   turn 0  ·  session {session}")
        log.add_system("")
        log.add_system("Ask anything, or type / for commands.")
        log.add_system("")

    def _update_status(self):
        """Update the status bar at the top."""
        model = self._agent.model if self._agent else "unknown"
        session = self._agent.session_id[:8] if self._agent else "?"
        pct = (self._ctx_used / self._ctx_total * 100) if self._ctx_total else 0
        ctx_str = f"ctx {pct:.0f}%" if self._ctx_used else ""
        spinner = BRAILLE[self._spinner_idx % len(BRAILLE)]
        yolo_str = " · YOLO" if self._yolo else ""
        status = f"  {spinner}  {model}  ·  turn {self._turn}  ·  {session}{yolo_str}  {ctx_str}"
        try:
            self.query_one("#status-bar", Static).update(status)
        except NoMatches:
            pass

    def _update_context_bar(self):
        """Update the context usage bar."""
        if self._ctx_total == 0:
            bar = ""
        else:
            pct = self._ctx_used / self._ctx_total
            filled = int(pct * 30)
            if pct < 0.5:
                color = "#56b6c2"
            elif pct < 0.85:
                color = "#f5a742"
            else:
                color = "#e06c75"
            bar = f"  [{color}]{'█' * filled}{'░' * (30 - filled)}[/#]  {pct:.0%}"
        try:
            self.query_one("#context-bar", Static).update(bar)
        except NoMatches:
            pass

    def _shortcuts_text(self) -> str:
        """Context-sensitive shortcuts text for the bottom bar.

        Follows OpenCode's footer rhythm: key in bright text, label muted.
        """
        key = "[#eeeeee]"
        lbl = "[/][#808080]"
        parts = [
            f"{key}enter{lbl} send",
            f"{key}ctrl+p{lbl} commands",
            f"{key}ctrl+m{lbl} model",
            f"{key}ctrl+o{lbl} yolo",
            f"{key}ctrl+q{lbl} quit",
        ]
        return "   ".join(parts) + "[/]"

    def _animate_spinner(self):
        """Timer callback to animate the spinner and wave effects."""
        self._spinner_idx += 1
        self._update_status()

    # == Public API for the agent loop to call from outside the TUI ==

    def set_agent(self, agent):
        self._agent = agent
        self._update_status()

    def add_user_message(self, text: str):
        self._turn += 1
        log = self.query_one("#message-log", MessageLog)
        log.add_user(text)
        log.add_system("")

    def start_assistant_response(self):
        log = self.query_one("#message-log", MessageLog)
        log.add_assistant_start()

    def add_token(self, token: str):
        log = self.query_one("#message-log", MessageLog)
        log.add_token(token)

    def add_thinking(self, text: str):
        log = self.query_one("#message-log", MessageLog)
        log.add_thinking(text)

    def add_tool_call(self, name: str, args: dict, running: bool = True):
        log = self.query_one("#message-log", MessageLog)
        log.add_tool_call(name, args, running)

    def add_tool_result(self, result: str, is_error: bool = False):
        log = self.query_one("#message-log", MessageLog)
        log.add_tool_result(result, is_error)

    def add_shell_command(self, cmd: str, running: bool = True):
        log = self.query_one("#message-log", MessageLog)
        log.add_shell_command(cmd, running)

    def add_shell_output(self, output: str, is_error: bool = False):
        log = self.query_one("#message-log", MessageLog)
        log.add_shell_output(output, is_error)

    def update_context(self, used: int, total: int):
        self._ctx_used = used
        self._ctx_total = total
        self._update_status()
        self._update_context_bar()

    def finish_response(self):
        log = self.query_one("#message-log", MessageLog)
        log.add_system("")

    # == Actions ==

    def action_quit(self):
        self.exit()

    def action_cancel(self):
        self.notify("Turn cancelled", severity="warning")

    def action_clear(self):
        try:
            self.query_one("#message-log", MessageLog).clear()
        except NoMatches:
            pass

    def action_model_picker(self):
        log = self.query_one("#message-log", MessageLog)
        model = self._agent.model if self._agent else "?"
        log.add_system(f"[dim]Model: {model}[/dim]")

    def action_toggle_yolo(self):
        self._yolo = not self._yolo
        state = "ON" if self._yolo else "OFF"
        self.notify(f"YOLO mode: {state}")
        self._update_status()

    def action_scroll_up(self):
        log = self.query_one("#message-log", MessageLog)
        log.scroll_page_up()

    def action_scroll_down(self):
        log = self.query_one("#message-log", MessageLog)
        log.scroll_page_down()


# ===========================================================================
# Non-Textual mode: optimized Rich printing for headless/single-message
# ===========================================================================

def init_console(theme_name: str = "elitza"):
    """Initialize Rich console for non-interactive use."""
    pass  # no-op in Textual mode


def get_console():
    from rich.console import Console
    return Console()


console = get_console()


# ---------------------------------------------------------------------------
# Wordmark -- OpenCode-style two-tone block letters, same as the Rust TUI.
# Left half is "ELIT" muted, right half is "ZA" bold in Elitza orange.
# `_` is a space filled with the shadow tint so letterforms pick up depth.
# ---------------------------------------------------------------------------

_WORDMARK_ROWS = (
    ("                   ", "  ▄      "),
    ("█▀▀▀ █___ ▀▀▀▀ ▀▀▀▀", "▀▀▀▀ _▀▀_"),
    ("█▀▀▀ █___ _█__ _█__", "__█_ █▀▀█"),
    ("▀▀▀▀ ▀▀▀▀ ▀▀▀▀ _█__", "▀▀▀▀ ▀__▀"),
)

_DIM = "#808080"
_PRIMARY = "#fb8147"
_SHADOW_DIM = "#282828"     # tint(base, dim, 0.25)
_SHADOW_PRIMARY = "#462819"  # tint(base, primary, 0.25)


def _render_wordmark_row(left: str, right: str) -> str:
    out = []
    for ch in left:
        if ch == "_":
            out.append(f"[on {_SHADOW_DIM}] [/]")
        elif ch == " ":
            out.append(" ")
        else:
            out.append(f"[{_DIM}]{ch}[/]")
    out.append(" ")
    for ch in right:
        if ch == "_":
            out.append(f"[on {_SHADOW_PRIMARY}] [/]")
        elif ch == " ":
            out.append(" ")
        else:
            out.append(f"[bold {_PRIMARY}]{ch}[/]")
    return "".join(out)


def wordmark_lines() -> list:
    """The four wordmark rows as Rich markup strings (no indent)."""
    return [_render_wordmark_row(left, right) for left, right in _WORDMARK_ROWS]


def print_header(model: str, session_id: str, turns: int = 0, ctx=None):
    """Session header: OpenCode-style wordmark, tagline, then session line."""
    c = get_console()
    cols = shutil.get_terminal_size().columns
    c.print()
    for row in wordmark_lines():
        c.print("  " + row)
    c.print()
    c.print(
        f"  [dim #808080]autonomous agent[/]  [dim #808080]·[/]"
        f"  [bold dim #808080]by Dario Cositore[/]"
    )
    c.print()
    c.print(
        f"  [bold #5c9cf5]Build[/] [dim #808080]·[/] [#eeeeee]{model}[/]"
        f" [dim #808080]  turn {turns}  ·  {session_id[:8]}[/]"
    )
    c.print("  " + "─" * max(cols - 4, 8), style="#484848")
    c.print()


def print_user(text: str):
    c = get_console()
    c.print(f"  [bold #eeeeee]◆[/] {text}")
    c.print()


def print_error(message: str):
    c = get_console()
    c.print(f"  [bold #e06c75]✗[/] {message}")
    c.print()


def print_bye():
    c = get_console()
    c.print()
    c.print("  [dim #606060]Elitza out.  ·  by Dario Cositore[/]")
    c.print()


def print_hint():
    c = get_console()
    # OpenCode footer rhythm: key bright, label muted.
    c.print(
        "  [bold #eeeeee]/help[/][dim #808080] commands[/]   "
        "[bold #eeeeee]/quit[/][dim #808080] exit[/]"
    )


def print_shortcuts(**kwargs):
    pass  # handled by Textual


# ===========================================================================
# Compatibility adapter: same StreamingOutput API but using RichLog
# ===========================================================================

class StreamingOutput:
    """Drop-in replacement that works with Textual's MessageLog or plain Rich.

    The agent loop calls these methods. In Textual mode, they queue updates.
    In plain mode, they print directly.
    """

    def __init__(self, message_log: Optional[MessageLog] = None):
        self._log = message_log
        self._thinking = True
        self._text = ""
        self._console = get_console() if message_log is None else None

    def start(self):
        if self._log:
            self._log.add_assistant_start()

    def on_token(self, token: str):
        if self._log:
            if self._thinking:
                self._thinking = False
            self._log.add_token(token)
        else:
            self._text += token
            # In plain mode, just append to text buffer
            # (actual printing happens in finish())

    def on_thinking(self, text: str):
        if self._log:
            self._log.add_thinking(text)

    def showToolCall(self, name: str, args: dict, is_running: bool = True):
        if self._log:
            self._log.add_tool_call(name, args, is_running)

    def showToolResult(self, result: str, is_error: bool = False):
        if self._log:
            self._log.add_tool_result(result, is_error)

    def showShellCommand(self, cmd: str, is_running: bool = True):
        if self._log:
            self._log.add_shell_command(cmd, is_running)

    def showShellOutput(self, output: str, is_error: bool = False):
        if self._log:
            self._log.add_shell_output(output, is_error)

    def showSubagentSpawn(self, run_id: str, persona: str, task: str):
        pass

    def showSubagentResult(self, run_id: str, persona: str, status: str, duration: float, result_preview: str = ""):
        pass

    def showTodoUpdate(self, todo_state):
        pass

    def showContextBar(self, ctx):
        pass

    def finish(self, full_text: str = ""):
        if self._log:
            self._log.add_system("")
        elif full_text and self._console:
            self._console.print(full_text)

    def stop(self):
        pass


def create_streamer(message_log: Optional[MessageLog] = None) -> StreamingOutput:
    """Create a StreamingOutput, optionally bound to a MessageLog."""
    return StreamingOutput(message_log=message_log)


# ===========================================================================
# Theme compatibility (for _handle_slash imports)
# ===========================================================================

THEMES = {
    "elitza": ElitzaTheme,
    "tokyonight": ElitzaTheme,
    "rosepine": ElitzaTheme,
}

THEME_ALIASES = {
    # Canonical name first; legacy names kept working.
    "elitza": "elitza", "opencode": "elitza", "default": "elitza",
    "dark": "elitza", "light": "elitza", "day": "elitza", "night": "elitza",
    "tokyo-night": "tokyonight", "tokyo": "tokyonight", "tokyonight": "tokyonight",
    "rose-pine": "rosepine", "rosepine-moon": "rosepine", "rose-pine-moon": "rosepine", "rosepine": "rosepine",
}

def resolve_theme(name: str) -> str:
    return THEME_ALIASES.get(name.lower(), "elitza")

def build_rich_theme(theme_name: str = "elitza", color_depth: int = 24):
    """Legacy compatibility -- returns a Rich Theme."""
    from rich.theme import Theme as RichTheme
    return RichTheme({
        "elitza": "bold #5c9cf5",
        "elitza.dim": "dim #606060",
        "elitza.text": "#eeeeee",
        "user": "bold white",
        "spinner": "bold #56b6c2",
        "thinking": "italic dim #56b6c2",
        "tool.name": "italic #9d7cd8",
        "tool.args": "italic #606060",
        "tool.result": "#808080",
        "success": "bold #7fd88f",
        "error": "bold #e06c75",
        "warning": "bold #f5a742",
        "border": "#484848",
        "model": "#9d7cd8",
        "session": "#606060",
        "context": "dim #56b6c2",
    })


def detect_color_support() -> int:
    colorterm = os.environ.get("COLORTERM", "").lower()
    if "truecolor" in colorterm or "24bit" in colorterm:
        return 24
    term = os.environ.get("TERM", "").lower()
    if "256color" in term:
        return 256
    return 16


# ===========================================================================
# Context + State (unchanged)
# ===========================================================================

from dataclasses import dataclass, field

@dataclass
class ContextState:
    used_tokens: int = 0
    total_tokens: int = 2000000
    compaction_count: int = 0

    @property
    def percentage(self) -> float:
        if self.total_tokens == 0:
            return 0.0
        return self.used_tokens / self.total_tokens

    @property
    def bar_text(self) -> str:
        pct = self.percentage * 100
        if pct < 50:
            color = "#56b6c2"
        elif pct < 85:
            color = "#56b6c2"
        else:
            color = "#e06c75"
        filled = int(self.percentage * 20)
        bar = "█" * filled + "░" * (20 - filled)
        return f"  [{color}][{bar}] {pct:.0f}%[/#]"


class TodoStatus(Enum):
    PENDING = auto()
    IN_PROGRESS = auto()
    COMPLETED = auto()
    CANCELLED = auto()


@dataclass
class TodoItem:
    id: str
    content: str
    status: TodoStatus = TodoStatus.PENDING


@dataclass
class TodoState:
    items: List[TodoItem] = field(default_factory=list)
