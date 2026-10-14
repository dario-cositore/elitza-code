"""Session Search -- search and recall past conversations.

Stores conversation sessions in SQLite with FTS5 search.
Regex + recency ranked search.
"""

import json
import logging
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Dict, Optional

from elitza.constants import get_elitza_home

logger = logging.getLogger(__name__)

SESSIONS_DB = get_elitza_home() / "sessions.db"


def _db() -> sqlite3.Connection:
    SESSIONS_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(SESSIONS_DB))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            model TEXT,
            started_at TEXT,
            ended_at TEXT,
            message_count INTEGER DEFAULT 0,
            summary TEXT DEFAULT '',
            tags TEXT DEFAULT '[]'
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            role TEXT,
            content TEXT,
            timestamp TEXT,
            tokens INTEGER DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content, content=messages, content_rowid=id)
    """)
    conn.commit()
    return conn


def save_session_turn(session_id: str, role: str, content: str,
                      model: str = "", tokens: int = 0):
    """Save a single conversation turn."""
    conn = _db()
    now = datetime.now(timezone.utc).isoformat()

    # Ensure session exists
    conn.execute("""
        INSERT OR IGNORE INTO sessions (session_id, model, started_at)
        VALUES (?, ?, ?)
    """, (session_id, model, now))

    # Insert message
    conn.execute("""
        INSERT INTO messages (session_id, role, content, timestamp, tokens)
        VALUES (?, ?, ?, ?, ?)
    """, (session_id, role, content, now, tokens))

    # Sync to FTS
    rowid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    try:
        conn.execute(
            "INSERT INTO messages_fts(rowid, content) VALUES (?, ?)",
            (rowid, content)
        )
    except Exception:
        pass

    # Update message count
    conn.execute("""
        UPDATE sessions SET message_count = message_count + 1
        WHERE session_id = ?
    """, (session_id,))

    conn.commit()
    conn.close()


def end_session(session_id: str, summary: str = ""):
    """Mark a session as ended."""
    conn = _db()
    now = datetime.now(timezone.utc).isoformat()
    conn.execute("""
        UPDATE sessions SET ended_at = ?, summary = ?
        WHERE session_id = ?
    """, (now, summary, session_id))
    conn.commit()
    conn.close()


def search_messages(query: str, limit: int = 10) -> List[dict]:
    """Search past messages using FTS5."""
    conn = _db()
    try:
        fts_query = " OR ".join(query.split()[:5])
        rows = conn.execute("""
            SELECT m.session_id, m.role, m.content, m.timestamp
            FROM messages m
            JOIN messages_fts f ON m.id = f.rowid
            WHERE messages_fts MATCH ?
            ORDER BY m.timestamp DESC
            LIMIT ?
        """, (fts_query, limit)).fetchall()
    except Exception:
        like_pattern = f"%{query}%"
        rows = conn.execute("""
            SELECT session_id, role, content, timestamp
            FROM messages
            WHERE content LIKE ?
            ORDER BY timestamp DESC
            LIMIT ?
        """, (like_pattern, limit)).fetchall()
    conn.close()

    return [
        {"session_id": r[0], "role": r[1], "content": r[2][:300], "timestamp": r[3]}
        for r in rows
    ]


def list_sessions(limit: int = 20) -> List[dict]:
    """List recent sessions."""
    conn = _db()
    rows = conn.execute("""
        SELECT session_id, model, started_at, ended_at, message_count, summary
        FROM sessions
        ORDER BY started_at DESC
        LIMIT ?
    """, (limit,)).fetchall()
    conn.close()

    return [
        {
            "session_id": r[0], "model": r[1], "started_at": r[2],
            "ended_at": r[3], "message_count": r[4], "summary": r[5][:200]
        }
        for r in rows
    ]


def get_session_history(session_id: str, limit: int = 50) -> List[dict]:
    """Get full message history for a session."""
    conn = _db()
    rows = conn.execute("""
        SELECT role, content, timestamp
        FROM messages
        WHERE session_id = ?
        ORDER BY timestamp ASC
        LIMIT ?
    """, (session_id, limit)).fetchall()
    conn.close()

    return [{"role": r[0], "content": r[1], "timestamp": r[2]} for r in rows]


def get_session_stats() -> dict:
    """Get overall session statistics."""
    conn = _db()
    total_sessions = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    total_messages = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    total_tokens = conn.execute("SELECT COALESCE(SUM(tokens), 0) FROM messages").fetchone()[0]
    conn.close()

    return {
        "total_sessions": total_sessions,
        "total_messages": total_messages,
        "total_tokens": total_tokens,
    }
