"""Elitza Persistence -- Full session and state persistence.

This module ensures Elitza is fully persistent across restarts:
1. Conversation history is saved and restored
2. Personality and brain state persist
3. Session continuity is maintained
4. No information is lost between sessions

Architecture:
  - Every turn is saved to SQLite immediately
  - On startup, last session is restored automatically
  - Brain state (soul.db, memories) persists via SQLite WAL mode
  - Compressed session summaries enable quick context loading
"""

import json
import logging
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from elitza.constants import get_elitza_home

logger = logging.getLogger(__name__)

BRAIN = get_elitza_home() / "brain"
DB = BRAIN / "persistence.db"


# ===========================================================================
# Database
# ===========================================================================

def _db() -> sqlite3.Connection:
    BRAIN.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB))
    conn.execute("PRAGMA journal_mode=WAL")
    
    # Sessions table
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            started TEXT,
            ended TEXT,
            summary TEXT,
            topic TEXT,
            message_count INTEGER DEFAULT 0,
            model TEXT,
            mood TEXT DEFAULT 'neutral'
        )
    """)
    
    # Messages table - every single message
    conn.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            role TEXT,
            content TEXT,
            tool_calls TEXT,
            tool_call_id TEXT,
            created TEXT,
            tokens_est INTEGER DEFAULT 0,
            FOREIGN KEY (session_id) REFERENCES sessions(session_id)
        )
    """)
    
    # System state - personality, config, etc.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS state (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated TEXT
        )
    """)
    
    # Session summaries for quick loading
    conn.execute("""
        CREATE TABLE IF NOT EXISTS session_summaries (
            session_id TEXT PRIMARY KEY,
            summary TEXT,
            key_moments TEXT,
            topics TEXT,
            created TEXT,
            FOREIGN KEY (session_id) REFERENCES sessions(session_id)
        )
    """)
    
    # FTS for searching all messages
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content, role, session_id,
            content=messages, content_rowid=id
        )
    """)
    
    try:
        conn.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
    except Exception:
        pass
    
    conn.commit()
    return conn


# ===========================================================================
# Session Management
# ===========================================================================

def start_session(session_id: str, model: str = "", topic: str = "") -> None:
    """Start a new session."""
    conn = _db()
    now = datetime.now(timezone.utc).isoformat()
    conn.execute("""
        INSERT OR REPLACE INTO sessions 
        (session_id, started, model, topic, message_count)
        VALUES (?, ?, ?, ?, 0)
    """, (session_id, now, model, topic))
    conn.commit()
    conn.close()
    
    # Save as current session
    _state_set("current_session", session_id)
    _state_set("last_session_start", now)


def end_session(session_id: str, summary: str = "", mood: str = "neutral") -> None:
    """End a session and save summary."""
    conn = _db()
    now = datetime.now(timezone.utc).isoformat()
    
    # Get message count
    count = conn.execute(
        "SELECT COUNT(*) FROM messages WHERE session_id=?", (session_id,)
    ).fetchone()[0]
    
    conn.execute("""
        UPDATE sessions SET ended=?, summary=?, mood=?, message_count=?
        WHERE session_id=?
    """, (now, summary, mood, count, session_id))
    
    # Generate and save summary if not provided
    if not summary:
        summary = _generate_session_summary(conn, session_id)
        conn.execute(
            "UPDATE sessions SET summary=? WHERE session_id=?",
            (summary, session_id)
        )
    
    conn.commit()
    conn.close()
    
    # Clear current session
    _state_set("current_session", "")
    _state_set("last_session_end", now)


def _generate_session_summary(conn: sqlite3.Connection, session_id: str) -> str:
    """Generate a summary of the session."""
    messages = conn.execute("""
        SELECT role, content FROM messages
        WHERE session_id=?
        ORDER BY id
        LIMIT 50
    """, (session_id,)).fetchall()
    
    if not messages:
        return "Empty session"
    
    # Extract topics from user messages
    topics = []
    for role, content in messages:
        if role == "user" and content:
            words = content.split()[:5]
            topics.extend(w.lower() for w in words if len(w) > 3)
    
    # Get unique topics
    unique_topics = list(dict.fromkeys(topics))[:5]
    
    return f"Session about: {', '.join(unique_topics) if unique_topics else 'general conversation'}"


# ===========================================================================
# Message Storage
# ===========================================================================

def save_message(session_id: str, role: str, content: str,
                 tool_calls: list = None, tool_call_id: str = None) -> int:
    """Save a message permanently."""
    conn = _db()
    now = datetime.now(timezone.utc).isoformat()
    tokens_est = len(content) // 4
    
    cursor = conn.execute("""
        INSERT INTO messages (session_id, role, content, tool_calls, 
                            tool_call_id, created, tokens_est)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (
        session_id, role, content,
        json.dumps(tool_calls) if tool_calls else None,
        tool_call_id, now, tokens_est
    ))
    
    msg_id = cursor.lastrowid
    
    # Sync to FTS
    try:
        conn.execute(
            "INSERT INTO messages_fts(rowid, content, role, session_id) VALUES (?, ?, ?, ?)",
            (msg_id, content, role, session_id)
        )
    except Exception:
        pass
    
    # Update session count
    conn.execute("""
        UPDATE sessions SET message_count = message_count + 1
        WHERE session_id=?
    """, (session_id,))
    
    conn.commit()
    conn.close()
    return msg_id


def load_session_messages(session_id: str, limit: int = 100) -> List[Dict]:
    """Load messages from a session."""
    conn = _db()
    rows = conn.execute("""
        SELECT role, content, tool_calls, tool_call_id, created
        FROM messages
        WHERE session_id=?
        ORDER BY id
        LIMIT ?
    """, (session_id, limit)).fetchall()
    conn.close()
    
    messages = []
    for role, content, tool_calls, tool_call_id, created in rows:
        msg = {"role": role, "content": content}
        if tool_calls:
            msg["tool_calls"] = json.loads(tool_calls)
        if tool_call_id:
            msg["tool_call_id"] = tool_call_id
        messages.append(msg)
    
    return messages


def get_last_session_id() -> Optional[str]:
    """Get the last active session ID."""
    return _state_get("current_session") or _state_get("last_session_id")


def get_recent_sessions(limit: int = 10) -> List[Dict]:
    """Get recent sessions."""
    conn = _db()
    rows = conn.execute("""
        SELECT session_id, started, ended, summary, message_count, mood
        FROM sessions
        ORDER BY started DESC
        LIMIT ?
    """, (limit,)).fetchall()
    conn.close()
    
    return [
        {
            "session_id": r[0],
            "started": r[1],
            "ended": r[2],
            "summary": r[3],
            "message_count": r[4],
            "mood": r[5],
        }
        for r in rows
    ]


# ===========================================================================
# State Management
# ===========================================================================

def _state_get(key: str, default: str = "") -> str:
    """Get a state value."""
    conn = _db()
    row = conn.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
    conn.close()
    return row[0] if row else default


def _state_set(key: str, value: str) -> None:
    """Set a state value."""
    conn = _db()
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT OR REPLACE INTO state (key, value, updated) VALUES (?, ?, ?)",
        (key, value, now)
    )
    conn.commit()
    conn.close()


def save_state(key: str, value) -> None:
    """Save any state value (auto-serializes)."""
    if isinstance(value, (dict, list)):
        _state_set(key, json.dumps(value))
    else:
        _state_set(key, str(value))


def load_state(key: str, default=None):
    """Load any state value (auto-deserializes)."""
    val = _state_get(key)
    if not val:
        return default
    try:
        return json.loads(val)
    except (json.JSONDecodeError, TypeError):
        return val


# ===========================================================================
# Conversation Context for LLM
# ===========================================================================

def build_conversation_context(session_id: str, current_query: str = "",
                                max_tokens: int = 8000) -> str:
    """Build context from conversation history for the LLM.
    
    Strategy:
    1. Load recent messages from current session
    2. Search for relevant past messages
    3. Load session summary if available
    4. Fit within token budget
    """
    conn = _db()
    context_parts = []
    tokens_used = 0
    
    # 1. Recent messages from current session
    recent = conn.execute("""
        SELECT role, content, tokens_est FROM messages
        WHERE session_id=?
        ORDER BY id DESC
        LIMIT 20
    """, (session_id,)).fetchall()
    
    for role, content, tokens in reversed(recent):
        if tokens_used + min(tokens, 500) <= max_tokens:
            context_parts.append({
                "type": "recent",
                "role": role,
                "content": content[:500],
            })
            tokens_used += min(tokens, 500)
    
    # 2. Search relevant past messages
    if current_query and tokens_used < max_tokens * 0.7:
        try:
            fts_query = " OR ".join(current_query.split()[:5])
            relevant = conn.execute("""
                SELECT m.role, m.content, m.session_id
                FROM messages m
                JOIN messages_fts f ON m.rowid = f.rowid
                WHERE messages_fts MATCH ?
                AND m.session_id != ?
                ORDER BY rank
                LIMIT 10
            """, (fts_query, session_id)).fetchall()
            
            for role, content, sid in relevant:
                if tokens_used + 200 <= max_tokens:
                    context_parts.append({
                        "type": "relevant",
                        "role": role,
                        "content": content[:300],
                        "session_id": sid,
                    })
                    tokens_used += 200
        except Exception:
            pass
    
    # 3. Session summaries
    if tokens_used < max_tokens * 0.8:
        summaries = conn.execute("""
            SELECT ss.summary, s.started
            FROM session_summaries ss
            JOIN sessions s ON ss.session_id = s.session_id
            WHERE ss.session_id != ?
            ORDER BY s.started DESC
            LIMIT 5
        """, (session_id,)).fetchall()
        
        for summary, started in summaries:
            summary_tokens = len(summary) // 4
            if tokens_used + summary_tokens <= max_tokens:
                context_parts.append({
                    "type": "summary",
                    "content": summary,
                    "started": started,
                })
                tokens_used += summary_tokens
    
    conn.close()
    
    # Format context
    return _format_context(context_parts)


def _format_context(parts: List[Dict]) -> str:
    """Format context for LLM."""
    if not parts:
        return ""
    
    lines = ["## Conversation History"]
    
    recent = [p for p in parts if p["type"] == "recent"]
    relevant = [p for p in parts if p["type"] == "relevant"]
    summaries = [p for p in parts if p["type"] == "summary"]
    
    if recent:
        lines.append("\n### Current Conversation")
        for p in recent:
            role = "User" if p["role"] == "user" else "Elitza"
            lines.append(f"- **{role}**: {p['content'][:300]}")
    
    if relevant:
        lines.append("\n### Relevant Past Discussions")
        for p in relevant:
            role = "User" if p["role"] == "user" else "Elitza"
            lines.append(f"- **{role}**: {p['content'][:200]}")
    
    if summaries:
        lines.append("\n### Session Summaries")
        for p in summaries:
            lines.append(f"- [{p.get('started', '')[:10]}] {p['content'][:200]}")
    
    return "\n".join(lines)


# ===========================================================================
# Search
# ===========================================================================

def search_messages(query: str, limit: int = 20) -> List[Dict]:
    """Search across all messages."""
    conn = _db()
    
    try:
        fts_query = " OR ".join(query.split()[:5])
        rows = conn.execute("""
            SELECT m.role, m.content, m.session_id, m.created
            FROM messages m
            JOIN messages_fts f ON m.rowid = f.rowid
            WHERE messages_fts MATCH ?
            ORDER BY rank
            LIMIT ?
        """, (fts_query, limit)).fetchall()
    except Exception:
        like_pattern = f"%{query}%"
        rows = conn.execute("""
            SELECT role, content, session_id, created
            FROM messages
            WHERE content LIKE ?
            ORDER BY created DESC
            LIMIT ?
        """, (like_pattern, limit)).fetchall()
    
    conn.close()
    
    return [
        {"role": r[0], "content": r[1][:300], "session_id": r[2], "created": r[3]}
        for r in rows
    ]


# ===========================================================================
# Stats
# ===========================================================================

def get_persistence_stats() -> Dict:
    """Get persistence statistics."""
    conn = _db()
    
    total_messages = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    total_sessions = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    total_tokens = conn.execute("SELECT SUM(tokens_est) FROM messages").fetchone()[0] or 0
    
    current_session = _state_get("current_session")
    
    conn.close()
    
    return {
        "total_messages": total_messages,
        "total_sessions": total_sessions,
        "total_tokens_est": total_tokens,
        "current_session": current_session,
    }
