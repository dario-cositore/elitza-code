//! Elitza wordmark -- OpenCode-style two-tone block letters.
//!
//! Mirrors OpenCode's logo treatment: a muted left half and a bold,
//! primary-colored right half, rendered over a tinted shadow so the
//! letterforms pick up a subtle depth. Personalized for Elitza,
//! branded by Dario Cositore.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use crate::theme::{mix, ACCENT_PRIMARY, BG_BASE, TEXT_DIM};

/// "ELIT" -- muted, not bold. 4 letters x 4 cols + 3 gaps = 19.
const LEFT: [&str; 4] = [
    "                   ",
    "█▀▀▀ █___ ▀▀▀▀ ▀▀▀▀",
    "█▀▀▀ █___ _█__ _█__",
    "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ _█__",
];

/// "ZA" -- bold, Elitza primary orange. 2 letters x 4 cols + 1 gap = 9.
const RIGHT: [&str; 4] = [
    "  ▄      ",
    "▀▀▀▀ _▀▀_",
    "__█_ █▀▀█",
    "▀▀▀▀ ▀__▀",
];

/// Render one half of the wordmark into styled spans.
///
/// Glyph legend (same convention as OpenCode's logo):
///   `█` full block in the letter color
///   `▀` upper-half block in the letter color
///   `_` space filled with the shadow tint
///   `^` upper-half block in the letter color, over the shadow tint
///   `~` upper-half block in the shadow tint
fn render_half(line: &str, fg: ratatui::style::Color, bold: bool) -> Vec<Span<'static>> {
    let shadow = mix(BG_BASE, fg, 0.25);
    let base = Style::default().fg(fg).bg(shadow);
    let plain = Style::default().fg(fg);
    let dim = Style::default().fg(shadow).bg(shadow);
    let styled = if bold {
        base.add_modifier(Modifier::BOLD)
    } else {
        base
    };
    let styled_plain = if bold {
        plain.add_modifier(Modifier::BOLD)
    } else {
        plain
    };

    line.chars()
        .map(|c| {
            let (text, style) = match c {
                '_' => (" ", base),
                '^' => ("▀", styled),
                '~' => ("▀", dim),
                ' ' => (" ", Style::default()),
                other => (Box::leak(other.to_string().into_boxed_str()) as &str, styled_plain),
            };
            Span::styled(text.to_string(), style)
        })
        .collect()
}

/// The Elitza wordmark: muted "ELIT" + bold "ZA", side by side.
pub fn wordmark() -> Vec<Line<'static>> {
    (0..4)
        .map(|row| {
            let mut spans = render_half(LEFT[row], TEXT_DIM, false);
            spans.push(Span::raw(" "));
            spans.extend(render_half(RIGHT[row], ACCENT_PRIMARY, true));
            Line::from(spans)
        })
        .collect()
}

/// Total display width of the wordmark in cells.
pub fn wordmark_width() -> u16 {
    (LEFT[0].chars().count() + 1 + RIGHT[0].chars().count()) as u16
}

/// The brand line shown under the wordmark on the home screen.
pub fn tagline() -> Line<'static> {
    Line::from(vec![
        Span::styled("autonomous agent", Style::default().fg(TEXT_DIM)),
        Span::styled("  ·  ", Style::default().fg(TEXT_DIM)),
        Span::styled(
            "by Dario Cositore",
            Style::default().fg(TEXT_DIM).add_modifier(Modifier::BOLD),
        ),
    ])
}
