//! Structured event protocol for Elitza <-> Rust TUI communication.
//! Covers the agent-loop events (phase_changed, tool_started,
//! tool_completed, first_token, permission_*, hunk_recorded, turn_*, etc.).
//!
//! This replaces the ad-hoc "TOKEN foo\nTHINKING bar" text protocol for:
//! - Exact fidelity (reasoning phases, permission prompts, edit hunks)
//! - Better performance (batched structured data, less string escaping)
//! - Future-proofing for rich session replay / compaction / rewind

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TuiEvent {
    /// Agent is starting a new user turn
    TurnStarted {
        turn_number: u32,
        model_id: String,
        yolo_mode: bool,
    },

    /// Explicit phase in the agent loop
    PhaseChanged {
        phase: String, // "waiting_for_model", "streaming_reasoning", "streaming_content", "tool_execution", "permission_requested", etc.
    },

    /// First token of a response arrived
    FirstToken,

    /// A reasoning/thinking token (separate from final content in many models)
    ReasoningToken {
        text: String,
    },

    /// Regular content token
    ContentToken {
        text: String,
    },

    /// Tool execution started
    ToolStarted {
        tool_id: String,
        name: String,
        args: HashMap<String, serde_json::Value>,
    },

    /// Tool finished (success or error)
    ToolCompleted {
        tool_id: String,
        result: String,
        is_error: bool,
        duration_ms: Option<u64>,
    },

    /// Shell / terminal command started
    ShellStarted {
        command: String,
        shell_id: String,
    },

    /// Incremental shell output (can be large; TUI truncates display)
    ShellOutput {
        shell_id: String,
        output: String,
        is_error: bool,
    },

    /// Shell command finished
    ShellCompleted {
        shell_id: String,
    },

    /// Permission / approval prompt (YOLO, tool approval, etc.)
    PermissionRequested {
        request_id: String,
        tool_name: String,
        description: String,
        risk_level: String, // "low" | "medium" | "high"
    },

    PermissionResolved {
        request_id: String,
        approved: bool,
        yolo_used: bool,
    },

    /// File edit recorded (for hunk_records / precise rewind)
    HunkRecorded {
        hunk_id: String,
        file_path: String,
        start_line: u32,
        end_line: u32,
        lines_added: u32,
        lines_removed: u32,
        event_type: String, // "added" | "modified" | "deleted"
    },

    /// Compaction / summary event
    CompactionStarted {
        reason: String, // "context_threshold", "manual", etc.
    },
    CompactionCompleted {
        messages_before: u32,
        messages_after: u32,
        summary: String,
    },

    /// Turn finished
    TurnEnded {
        turn_number: u32,
        success: bool,
    },

    /// Control / meta
    YoloToggled { enabled: bool },
    ClearScrollback,
    StatusMessage { text: String, ttl_ms: u64 },
    Done, // legacy simple signal
}

/// Helper to parse a line as a TuiEvent (JSON or legacy simple format for transition)
pub fn parse_event_line(line: &str) -> Option<TuiEvent> {
    // Try JSON first (new structured protocol)
    if line.trim_start().starts_with('{') {
        if let Ok(ev) = serde_json::from_str::<TuiEvent>(line) {
            return Some(ev);
        }
    }

    // Legacy simple protocol fallback (for smooth transition)
    if line.starts_with("TOKEN ") {
        let text = &line[6..];
        return Some(TuiEvent::ContentToken { text: text.to_string() });
    }
    if line.starts_with("REASONING ") || line.starts_with("THINKING ") {
        let text = if line.starts_with("REASONING ") { &line[10..] } else { &line[9..] };
        return Some(TuiEvent::ReasoningToken { text: text.to_string() });
    }
    if line.starts_with("TOOL_CALL ") {
        // crude parse for transition
        let rest = &line[10..];
        let parts: Vec<&str> = rest.splitn(2, ' ').collect();
        let name = parts[0].to_string();
        return Some(TuiEvent::ToolStarted {
            tool_id: uuid::Uuid::new_v4().to_string(),
            name,
            args: HashMap::new(),
        });
    }
    if line.starts_with("TOOL_RESULT ") {
        let text = &line[12..];
        let is_error = text.starts_with("ERROR:");
        return Some(TuiEvent::ToolCompleted {
            tool_id: "unknown".to_string(),
            result: text.trim_start_matches("ERROR:").trim().to_string(),
            is_error,
            duration_ms: None,
        });
    }
    if line == "DONE" {
        return Some(TuiEvent::Done);
    }

    None
}
