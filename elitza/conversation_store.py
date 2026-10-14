"""Elitza Conversation Store -- Permanent, searchable conversation history.

This module provides a solution to the "one infinite conversation" problem:
instead of keeping everything in the LLM context window, we store ALL
conversations in a searchable database and retrieve relevant context on demand.

Architecture:
  1. FULL STORAGE -- Every message is stored permanently in SQLite
  2. SMART RETRIEVAL -- Only relevant context is pulled into the LLM
  3. COMPRESSION -- Summaries replace old details when needed
  4. CONTINUITY -- Session bridging maintains conversation flow

This gives us:
  - Unlimited conversation length (no context window limit)
  - Zero information loss (everything is stored)
  - No quality degradation (only relevant context loaded)
  - Search across ALL past conversations
  - Cost efficiency (pay only for relevant context)
"""

import json
import sqlite3
import hashlib
import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, asdict

from elitza.constants import get_elitza_home

logger = logging.getLogger(__name__)

BRAIN = get_elitza_home() / "brain"
DB = BRAIN / "conversations.db"

# Context budget for LLM (tokens)
CONTEXT_BUDGET = 8000  # Keep recent context under this
SUMMARY_TOKEN_ESTIMATE = 200  # Estimated tokens per summary chunk


# ===========================================================================
# Database Schema
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
            total_tokens_est INTEGER DEFAULT 0,
            mood_start TEXT,
            mood_end TEXT
        )
    """)
    
    # Messages table -- stores every single message permanently
    conn.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            role TEXT,
            content TEXT,
            tokens_est INTEGER DEFAULT 0,
            tool_calls TEXT,
            tool_results TEXT,
            importance REAL DEFAULT 0.5,
            created TEXT,
            FOREIGN KEY (session_id) REFERENCES sessions(session_id)
        )
    """)
    
    # FTS index for full-text search across all messages
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content, role, session_id,
            content=messages, content_rowid=id
        )
    """)
    
    # Summaries table -- compressed versions of old conversations
    conn.execute("""
        CREATE TABLE IF NOT EXISTS summaries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            summary_type TEXT,
            content TEXT,
            covers_from TEXT,
            covers_to TEXT,
            message_count INTEGER,
            created TEXT,
            FOREIGN KEY (session_id) REFERENCES sessions(session_id)
        )
    """)
    
    # Context cache -- pre-computed relevant context for common queries
    conn.execute("""
        CREATE TABLE IF NOT EXISTS context_cache (
            query_hash TEXT PRIMARY KEY,
            context TEXT,
            created TEXT,
            hit_count INTEGER DEFAULT 0
        )
    """)
    
    # Sync FTS
    try:
        conn.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
    except Exception:
        pass
    
    conn.commit()
    return conn


# ===========================================================================
# Message Storage -- Store everything permanently
# ===========================================================================

def store_message(session_id: str, role: str, content: str,
                  tool_calls: list = None, tool_results: list = None,
                  importance: float = 0.5) -> int:
    """Store a message permanently. This is the source of truth."""
    conn = _db()
    
    # Estimate tokens (rough: 1 token ≈ 4 chars)
    tokens_est = len(content) // 4
    
    now = datetime.now(timezone.utc).isoformat()
    
    cursor = conn.execute("""
        INSERT INTO messages (session_id, role, content, tokens_est, 
                            tool_calls, tool_results, importance, created)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        session_id,
        role,
        content,
        tokens_est,
        json.dumps(tool_calls) if tool_calls else None,
        json.dumps(tool_results) if tool_results else None,
        importance,
        now
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
    
    # Update session stats
    conn.execute("""
        UPDATE sessions SET 
            message_count = message_count + 1,
            total_tokens_est = total_tokens_est + ?
        WHERE session_id = ?
    """, (tokens_est, session_id))
    
    conn.commit()
    conn.close()
    
    return msg_id


def start_session(session_id: str, topic: str = "", mood: str = "neutral") -> None:
    """Start a new session."""
    conn = _db()
    now = datetime.now(timezone.utc).isoformat()
    conn.execute("""
        INSERT OR REPLACE INTO sessions 
        (session_id, started, topic, mood_start, message_count, total_tokens_est)
        VALUES (?, ?, ?, ?, 0, 0)
    """, (session_id, now, topic, mood))
    conn.commit()
    conn.close()


def end_session(session_id: str, summary: str = "", mood: str = "neutral") -> None:
    """End a session and optionally store a summary."""
    conn = _db()
    now = datetime.now(timezone.utc).isoformat()
    conn.execute("""
        UPDATE sessions SET ended=?, summary=?, mood_end=? WHERE session_id=?
    """, (now, summary, mood, session_id))
    conn.commit()
    conn.close()


# ===========================================================================
# Smart Retrieval -- Pull only relevant context
# ===========================================================================

def retrieve_context(query: str, session_id: str = None,
                     max_tokens: int = CONTEXT_BUDGET,
                     include_summaries: bool = True) -> str:
    """Retrieve relevant context for the current conversation.
    
    This is the key innovation: instead of loading EVERYTHING,
    we load ONLY what's relevant to the current query.
    
    Strategy:
    1. Get recent messages (last N messages from current session)
    2. Search for relevant past messages (FTS)
    3. Get relevant summaries of old conversations
    4. Fit everything within token budget
    """
    conn = _db()
    
    context_parts = []
    tokens_used = 0
    
    # 1. Get recent messages from current session (highest priority)
    if session_id:
        recent = conn.execute("""
            SELECT role, content, tokens_est, created
            FROM messages
            WHERE session_id = ?
            ORDER BY id DESC
            LIMIT 20
        """, (session_id,)).fetchall()
        
        for role, content, tokens, created in reversed(recent):
            if tokens_used + tokens <= max_tokens:
                context_parts.append({
                    "type": "recent",
                    "role": role,
                    "content": content[:500],  # Truncate long messages
                    "tokens": tokens,
                    "created": created,
                })
                tokens_used += tokens
    
    # 2. Search for relevant past messages (FTS)
    if query:
        try:
            fts_query = " OR ".join(query.split()[:5])
            relevant = conn.execute("""
                SELECT m.role, m.content, m.tokens_est, m.created, m.session_id,
                       rank
                FROM messages m
                JOIN messages_fts f ON m.rowid = f.rowid
                WHERE messages_fts MATCH ?
                ORDER BY rank
                LIMIT 10
            """, (fts_query,)).fetchall()
            
            for role, content, tokens, created, sid, rank in relevant:
                # Skip if already in context (recent messages)
                if any(p["content"][:100] == content[:100] for p in context_parts):
                    continue
                
                if tokens_used + min(tokens, 200) <= max_tokens:
                    context_parts.append({
                        "type": "relevant",
                        "role": role,
                        "content": content[:300],  # More aggressive truncation
                        "tokens": min(tokens, 200),
                        "created": created,
                        "session_id": sid,
                    })
                    tokens_used += min(tokens, 200)
        except Exception:
            pass
    
    # 3. Get summaries of old conversations (if space allows)
    if include_summaries and tokens_used < max_tokens * 0.7:
        summaries = conn.execute("""
            SELECT content, covers_from, covers_to, message_count
            FROM summaries
            ORDER BY created DESC
            LIMIT 5
        """).fetchall()
        
        for content, from_date, to_date, msg_count in summaries:
            summary_tokens = len(content) // 4
            if tokens_used + summary_tokens <= max_tokens:
                context_parts.append({
                    "type": "summary",
                    "content": content,
                    "tokens": summary_tokens,
                    "covers": f"{from_date} to {to_date}",
                    "message_count": msg_count,
                })
                tokens_used += summary_tokens
    
    conn.close()
    
    # Format context for LLM
    return _format_context(context_parts)


def _format_context(parts: List[Dict]) -> str:
    """Format retrieved context into a readable string for the LLM."""
    if not parts:
        return ""
    
    lines = ["## Conversation Context"]
    
    # Group by type
    recent = [p for p in parts if p["type"] == "recent"]
    relevant = [p for p in parts if p["type"] == "relevant"]
    summaries = [p for p in parts if p["type"] == "summary"]
    
    if recent:
        lines.append("\n### Recent Conversation")
        for p in recent:
            role = "User" if p["role"] == "user" else "Elitza"
            content = p["content"][:300]
            lines.append(f"- **{role}**: {content}")
    
    if relevant:
        lines.append("\n### Relevant Past Context")
        for p in relevant:
            role = "User" if p["role"] == "user" else "Elitza"
            content = p["content"][:200]
            lines.append(f"- [{p.get('created', '')[:10]}] **{role}**: {content}")
    
    if summaries:
        lines.append("\n### Past Conversations Summary")
        for p in summaries:
            lines.append(f"- [{p['covers']}] {p['message_count']} messages: {p['content'][:200]}")
    
    return "\n".join(lines)


# ===========================================================================
# Conversation Compression -- Summarize old conversations
# ===========================================================================

def compress_session(session_id: str, summary: str) -> bool:
    """Compress a session into a summary.
    
    This replaces detailed messages with a summary,
    freeing up context space while preserving key information.
    """
    conn = _db()
    
    # Get session info
    session = conn.execute(
        "SELECT started, ended, message_count FROM sessions WHERE session_id=?",
        (session_id,)
    ).fetchone()
    
    if not session:
        conn.close()
        return False
    
    started, ended, msg_count = session
    
    # Store summary
    now = datetime.now(timezone.utc).isoformat()
    conn.execute("""
        INSERT INTO summaries (session_id, summary_type, content, 
                             covers_from, covers_to, message_count, created)
        VALUES (?, 'session', ?, ?, ?, ?, ?)
    """, (session_id, summary, started, ended or now, msg_count, now))
    
    conn.commit()
    conn.close()
    
    return True


def auto_compress_old_sessions(max_age_days: int = 7, 
                                max_sessions: int = 50) -> int:
    """Automatically compress old sessions that haven't been summarized."""
    conn = _db()
    
    # Find old sessions without summaries
    cutoff = (datetime.now(timezone.utc) - timedelta(days=max_age_days)).isoformat()
    
    old_sessions = conn.execute("""
        SELECT s.session_id, s.started, s.ended, s.message_count
        FROM sessions s
        LEFT JOIN summaries sm ON s.session_id = sm.session_id
        WHERE s.started < ? 
        AND sm.id IS NULL
        AND s.message_count > 5
        ORDER BY s.started ASC
        LIMIT ?
    """, (cutoff, max_sessions)).fetchall()
    
    compressed = 0
    
    for session_id, started, ended, msg_count in old_sessions:
        # Get a sample of messages for summarization
        messages = conn.execute("""
            SELECT role, content FROM messages
            WHERE session_id = ?
            ORDER BY id
            LIMIT 50
        """, (session_id,)).fetchall()
        
        # Create a basic summary (in production, use LLM for better summaries)
        topics = set()
        for role, content in messages:
            # Extract topics from first words
            words = content.split()[:5]
            topics.update(w.lower() for w in words if len(w) > 3)
        
        summary = f"Session from {started[:10]}: {', '.join(list(topics)[:5])}. {msg_count} messages total."
        
        # Store summary
        compress_session(session_id, summary)
        compressed += 1
    
    conn.commit()
    conn.close()
    
    return compressed


# ===========================================================================
# Context Budget Management -- Fit within token limits
# ===========================================================================

def estimate_tokens(text: str) -> int:
    """Estimate token count for text."""
    return len(text) // 4


def truncate_to_budget(text: str, max_tokens: int) -> str:
    """Truncate text to fit within token budget."""
    estimated = estimate_tokens(text)
    if estimated <= max_tokens:
        return text
    
    # Truncate proportionally
    ratio = max_tokens / estimated
    chars_to_keep = int(len(text) * ratio * 0.9)  # 90% to be safe
    return text[:chars_to_keep] + "..."


# ===========================================================================
# Search Across All Conversations
# ===========================================================================

def search_all_conversations(query: str, limit: int = 20) -> List[Dict]:
    """Search across ALL stored conversations."""
    conn = _db()
    
    results = []
    
    try:
        fts_query = " OR ".join(query.split()[:5])
        rows = conn.execute("""
            SELECT m.role, m.content, m.created, m.session_id, m.importance
            FROM messages m
            JOIN messages_fts f ON m.rowid = f.rowid
            WHERE messages_fts MATCH ?
            ORDER BY m.importance DESC, m.created DESC
            LIMIT ?
        """, (fts_query, limit)).fetchall()
        
        for role, content, created, session_id, importance in rows:
            results.append({
                "role": role,
                "content": content[:300],
                "created": created,
                "session_id": session_id,
                "importance": importance,
            })
    except Exception:
        pass
    
    conn.close()
    return results


# ===========================================================================
# Stats and Monitoring
# ===========================================================================

def get_conversation_stats() -> Dict:
    """Get statistics about stored conversations."""
    conn = _db()
    
    total_messages = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    total_sessions = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    total_summaries = conn.execute("SELECT COUNT(*) FROM summaries").fetchone()[0]
    total_tokens = conn.execute("SELECT SUM(tokens_est) FROM messages").fetchone()[0] or 0
    
    # Messages by role
    by_role = {}
    for row in conn.execute("SELECT role, COUNT(*) FROM messages GROUP BY role").fetchall():
        by_role[row[0]] = row[1]
    
    # Recent activity
    recent_sessions = conn.execute("""
        SELECT session_id, started, message_count 
        FROM sessions 
        ORDER BY started DESC 
        LIMIT 5
    """).fetchall()
    
    conn.close()
    
    return {
        "total_messages": total_messages,
        "total_sessions": total_sessions,
        "total_summaries": total_summaries,
        "total_tokens_est": total_tokens,
        "by_role": by_role,
        "recent_sessions": [
            {"id": s[0], "started": s[1], "messages": s[2]}
            for s in recent_sessions
        ],
    }
