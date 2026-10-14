use ratatui::style::Color;

// ============================================================================
// Elitza theme -- OpenCode look & feel, Elitza branded.
// Palette structure follows OpenCode's `opencode` theme (dark), with Elitza's
// signature orange as the primary/brand color.
// ============================================================================

// -- Backgrounds (OpenCode neutral ramp) ------------------------------------
pub const BG_BASE: Color = Color::Rgb(10, 10, 10); // #0a0a0a  background
pub const BG_DARK: Color = Color::Rgb(3, 3, 3); // #030303  deepest
pub const BG_LIGHT: Color = Color::Rgb(20, 20, 20); // #141414  backgroundPanel
pub const BG_PANEL: Color = Color::Rgb(30, 30, 30); // #1e1e1e  backgroundElement
pub const BG_CODE: Color = Color::Rgb(20, 20, 20); // #141414  code blocks

// -- Text -------------------------------------------------------------------
pub const TEXT_PRIMARY: Color = Color::Rgb(238, 238, 238); // #eeeeee  text
pub const TEXT_SECONDARY: Color = Color::Rgb(181, 181, 181); // #b5b5b5  neutral.300
pub const TEXT_DIM: Color = Color::Rgb(128, 128, 128); // #808080  textMuted

// -- Accents ---------------------------------------------------------------
// Elitza's brand: orange (OpenCode's primary slot).
pub const ACCENT_PRIMARY: Color = Color::Rgb(251, 129, 71); // #fb8147  primary
pub const ACCENT_ASSISTANT: Color = Color::Rgb(92, 156, 245); // #5c9cf5  secondary
pub const ACCENT_THINKING: Color = Color::Rgb(86, 182, 194); // #56b6c2  info
pub const ACCENT_TOOL: Color = Color::Rgb(157, 124, 216); // #9d7cd8  accent
pub const ACCENT_RUNNING: Color = Color::Rgb(127, 216, 143); // #7fd88f  success
pub const ACCENT_ERROR: Color = Color::Rgb(224, 108, 117); // #e06c75  error
pub const ACCENT_SUCCESS: Color = Color::Rgb(127, 216, 143); // #7fd88f  success
pub const ACCENT_WARNING: Color = Color::Rgb(245, 167, 66); // #f5a742  warning
pub const ACCENT_INFO: Color = Color::Rgb(86, 182, 194); // #56b6c2  info
pub const ACCENT_HEADER: Color = Color::Rgb(157, 124, 216); // #9d7cd8  accent (headings)

// -- Borders ---------------------------------------------------------------
pub const BORDER: Color = Color::Rgb(72, 72, 72); // #484848  border
pub const BORDER_LIGHT: Color = Color::Rgb(96, 96, 96); // #606060  borderActive
pub const BORDER_SUBTLE: Color = Color::Rgb(60, 60, 60); // #3c3c3c  borderSubtle

// -- Diff ------------------------------------------------------------------
pub const DIFF_DEL_BG: Color = Color::Rgb(55, 34, 44); // #37222c
pub const DIFF_DEL_FG: Color = Color::Rgb(226, 106, 117); // #e26a75
pub const DIFF_INS_BG: Color = Color::Rgb(32, 48, 59); // #20303b
pub const DIFF_INS_FG: Color = Color::Rgb(79, 214, 190); // #4fd6be

pub const SPINNER_FRAMES: &[&str] = &["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂"];

/// Blend two colors.
pub fn mix(a: Color, b: Color, t: f64) -> Color {
    let (ar, ag, ab) = rgb(a);
    let (br, bg, bb) = rgb(b);
    let t = t.clamp(0.0, 1.0);
    Color::Rgb(
        (ar as f64 + (br as f64 - ar as f64) * t).round() as u8,
        (ag as f64 + (bg as f64 - ag as f64) * t).round() as u8,
        (ab as f64 + (bb as f64 - ab as f64) * t).round() as u8,
    )
}

fn rgb(c: Color) -> (u8, u8, u8) {
    match c {
        Color::Rgb(r, g, b) => (r, g, b),
        _ => (0, 0, 0),
    }
}

/// A background tinted toward a foreground color (OpenCode's logo shadow).
pub fn tint(base: Color, overlay: Color, alpha: f64) -> Color {
    mix(base, overlay, alpha)
}

/// Shimmer effect: a color sweep across text (used by legacy animations).
pub fn shimmer_color(col: usize, frame: usize, total_width: usize) -> Color {
    let period = total_width + 20;
    let sweep_pos = (frame * 3) % period;
    let dist = (col as i32 - sweep_pos as i32).unsigned_abs() as f64;
    let half_width = 5.0;
    if dist < half_width {
        let intensity = 0.5 * (1.0 + (std::f64::consts::PI * dist / half_width).cos());
        mix(TEXT_DIM, ACCENT_PRIMARY, intensity)
    } else {
        TEXT_DIM
    }
}
