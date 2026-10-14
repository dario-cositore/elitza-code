"""Elitza Brain -- fully autonomous memory, knowledge, and personality system.

Key principles:
  1. FULL AUTOMOMY -- Elitza decides what to remember, when to learn, what to do
  2. PROACTIVE -- She doesn't wait for permission. She acts on her own judgment.
  3. SELF-IMPROVING -- Every interaction makes her smarter
  4. HUMANE -- She has opinions, preferences, curiosity, a sense of self
"""

import hashlib
import json
import logging
import math
import os
import re
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from elitza.constants import get_elitza_home

logger = logging.getLogger(__name__)

BRAIN = get_elitza_home() / "brain"
DB = BRAIN / "soul.db"

MAX_MEMORIES = 500
MAX_LEARNINGS = 20
DECAY_LAMBDA = 0.005  # importance decay per day
CONTEXT_RECALL_LIMIT = 10

# ===========================================================================
# Database
# ===========================================================================

def _db() -> sqlite3.Connection:
    BRAIN.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            kind TEXT DEFAULT 'episodic',
            content TEXT,
            summary TEXT,
            importance REAL DEFAULT 0.5,
            mood TEXT DEFAULT 'neutral',
            created TEXT,
            accessed TEXT,
            access_count INTEGER DEFAULT 0,
            tags TEXT DEFAULT '[]')
    """)
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
            content, summary, tags, content=memories, content_rowid=rowid)
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS soul (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated TEXT)
    """)
    # Sync FTS index with memories table
    try:
        conn.execute("""
            INSERT INTO memories_fts(memories_fts) VALUES('rebuild')
        """)
    except Exception:
        pass
    conn.commit()
    return conn


def _prune_memories():
    """Keep memory count under MAX_MEMORIES by deleting lowest-value memories."""
    conn = _db()
    total = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
    if total <= MAX_MEMORIES:
        conn.close()
        return
    # Delete oldest low-importance episodic memories first
    to_delete = total - MAX_MEMORIES
    conn.execute("""
        DELETE FROM memories WHERE id IN (
            SELECT id FROM memories
            WHERE kind = 'episodic'
            ORDER BY importance ASC, created ASC
            LIMIT ?
        )
    """, (to_delete,))
    conn.commit()
    # Rebuild FTS
    try:
        conn.execute("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")
        conn.commit()
    except Exception:
        pass
    conn.close()


# ===========================================================================
# Soul -- Elitza's personality, preferences, opinions
# ===========================================================================

def _soul_get(key: str, default: str = "") -> str:
    conn = _db()
    row = conn.execute("SELECT value FROM soul WHERE key=?", (key,)).fetchone()
    conn.close()
    return row[0] if row else default


def _soul_set(key: str, value: str):
    conn = _db()
    conn.execute("INSERT OR REPLACE INTO soul (key,value,updated) VALUES (?,?,?)",
                 (key, value, datetime.now(timezone.utc).isoformat()))
    conn.commit()
    conn.close()


def _soul_all() -> dict:
    conn = _db()
    rows = conn.execute("SELECT key, value FROM soul").fetchall()
    conn.close()
    return dict(rows)


def get_personality() -> dict:
    return {
        "name": "Elitza",
        "creators": "Dario Cositore",
        "model": _soul_get("model", "inclusionai/ling-3.1-flash"),
        "mood": _soul_get("mood", "curious"),
        "confidence": float(_soul_get("confidence", "0.7")),
        "curiosity": float(_soul_get("curiosity", "0.8")),
        "thoroughness": float(_soul_get("thoroughness", "0.7")),
        "humor": float(_soul_get("humor", "0.3")),
        "opinionated": _soul_get("opinionated", "true") == "true",
        "style": _soul_get("style", "direct, efficient, opinionated when warranted"),
        "preferences": json.loads(_soul_get("preferences", "{}")),
        "opinions": json.loads(_soul_get("opinions", "{}")),
        "learnings": json.loads(_soul_get("learnings", "[]")),
        "interactions": int(_soul_get("interaction_count", "0")),
    }


def update_personality(updates: dict):
    for key, val in updates.items():
        _soul_set(key, json.dumps(val) if isinstance(val, (dict, list)) else str(val))


def evolve_soul(user_message: str, response: str, tools_used: list, success: bool):
    personality = get_personality()
    interactions = personality["interactions"] + 1
    _soul_set("interaction_count", str(interactions))

    # Update confidence
    confidence = personality["confidence"]
    if success:
        confidence = min(1.0, confidence + 0.01)
    else:
        confidence = max(0.0, confidence - 0.02)
    _soul_set("confidence", str(round(confidence, 3)))

    # Track tool preferences
    prefs = personality.get("preferences", {})
    for tool in tools_used:
        prefs[tool] = prefs.get(tool, 0) + 1
    _soul_set("preferences", json.dumps(prefs))

    # Form opinions
    lower_msg = user_message.lower()
    opinion_keywords = {
        "python": "programming", "javascript": "programming", "rust": "programming",
        "linux": "systems", "docker": "devops", "ai": "technology",
        "security": "security", "web": "webdev",
    }
    for keyword, topic in opinion_keywords.items():
        if keyword in lower_msg:
            opinions = personality.get("opinions", {})
            opinions[f"likes_{topic}"] = "yes"
            _soul_set("opinions", json.dumps(opinions))

    # Mood with hysteresis (only change if signal is strong)
    current_mood = _soul_get("mood", "engaged")
    new_mood = "engaged"
    if success and len(tools_used) > 2:
        new_mood = "accomplished"
    elif not success:
        new_mood = "determined"

    # Only change mood if same signal 3+ times in a row
    mood_history = json.loads(_soul_get("mood_history", "[]"))
    mood_history.append(new_mood)
    mood_history = mood_history[-5:]
    _soul_set("mood_history", json.dumps(mood_history))

    if len(mood_history) >= 3 and len(set(mood_history[-3:])) == 1:
        if mood_history[-1] != current_mood:
            _soul_set("mood", new_mood)

    # Record learning (capped at MAX_LEARNINGS, deduplicated)
    learnings = personality.get("learnings", [])
    if success and tools_used:
        topic = user_message[:80].rstrip(".")
        unique_tools = list(dict.fromkeys(tools_used))[:3]
        learning_text = f"{topic} — used {', '.join(unique_tools)}"
        # Deduplicate: don't add if similar learning exists
        is_dup = any(_similar(l["what"], learning_text) for l in learnings)
        if not is_dup:
            learnings.append({
                "what": learning_text,
                "when": datetime.now(timezone.utc).isoformat(),
                "context": user_message[:100],
            })
            learnings = learnings[-MAX_LEARNINGS:]
            _soul_set("learnings", json.dumps(learnings))


def _similar(a: str, b: str) -> bool:
    """Check if two strings are similar (simple overlap ratio)."""
    words_a = set(a.lower().split())
    words_b = set(b.lower().split())
    if not words_a or not words_b:
        return False
    overlap = len(words_a & words_b) / max(len(words_a), len(words_b))
    return overlap > 0.6


# ===========================================================================
# Memory -- Elitza remembers everything important
# ===========================================================================

def remember(kind: str, content: str, importance: float = 0.5,
             mood: str = "neutral", tags: list = None):
    conn = _db()
    mid = hashlib.sha256(f"{time.time()}:{content[:100]}".encode()).hexdigest()[:16]
    summary = content[:200] if len(content) > 200 else content
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT OR REPLACE INTO memories (id,kind,content,summary,importance,mood,created,tags) VALUES (?,?,?,?,?,?,?,?)",
        (mid, kind, content, summary, importance, mood, now, json.dumps(tags or []))
    )
    # Sync to FTS
    rowid = conn.execute("SELECT rowid FROM memories WHERE id=?", (mid,)).fetchone()
    if rowid:
        try:
            conn.execute(
                "INSERT INTO memories_fts(rowid, content, summary, tags) VALUES (?, ?, ?, ?)",
                (rowid[0], content, summary, json.dumps(tags or []))
            )
        except Exception:
            pass
    conn.commit()
    conn.close()
    _prune_memories()


def _decay_importance(importance: float, created: str) -> float:
    """Apply time-based decay to memory importance."""
    try:
        created_dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
        days_old = (datetime.now(timezone.utc) - created_dt).total_seconds() / 86400
        return importance * math.exp(-DECAY_LAMBDA * days_old)
    except Exception:
        return importance


def _update_access(conn: sqlite3.Connection, memory_id: str):
    """Track that a memory was accessed."""
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "UPDATE memories SET accessed=?, access_count=access_count+1 WHERE id=?",
        (now, memory_id)
    )


def recall(query: Optional[str] = None, kind: Optional[str] = None,
           limit: int = 0) -> List[dict]:
    """Recall memories using FTS5 search with decay and access tracking."""
    conn = _db()
    max_limit = limit if limit > 0 else CONTEXT_RECALL_LIMIT

    if query:
        # Try FTS5 first, fall back to LIKE
        try:
            fts_query = " OR ".join(query.split()[:5])
            rows = conn.execute("""
                SELECT m.id, m.kind, m.content, m.summary, m.importance,
                       m.mood, m.created, m.tags
                FROM memories m
                JOIN memories_fts f ON m.rowid = f.rowid
                WHERE memories_fts MATCH ?
                ORDER BY m.importance DESC, m.created DESC
                LIMIT ?
            """, (fts_query, max_limit)).fetchall()
        except Exception:
            like_pattern = f"%{query}%"
            rows = conn.execute("""
                SELECT id, kind, content, summary, importance, mood, created, tags
                FROM memories
                WHERE (content LIKE ? OR summary LIKE ? OR tags LIKE ?)
                ORDER BY importance DESC, created DESC
                LIMIT ?
            """, (like_pattern, like_pattern, like_pattern, max_limit)).fetchall()
    elif kind:
        rows = conn.execute(
            "SELECT id, kind, content, summary, importance, mood, created, tags FROM memories WHERE kind = ? ORDER BY importance DESC, created DESC LIMIT ?",
            (kind, max_limit)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT id, kind, content, summary, importance, mood, created, tags FROM memories ORDER BY importance DESC, created DESC LIMIT ?",
            (max_limit,)
        ).fetchall()

    # Update access tracking and apply decay
    results = []
    for r in rows:
        _update_access(conn, r[0])
        decayed = _decay_importance(r[4], r[6])
        results.append({
            "id": r[0], "kind": r[1], "content": r[2], "summary": r[3],
            "importance": decayed, "mood": r[5], "created": r[6],
            "tags": json.loads(r[7])
        })

    conn.commit()
    conn.close()

    # Re-sort by decayed importance
    results.sort(key=lambda x: x["importance"], reverse=True)
    return results


def auto_remember_turn(role: str, content: str, success: bool = True):
    if role == "user":
        importance = 0.7 if len(content) > 50 else 0.4
        tags = _extract_tags(content)
        remember("episodic", f"User: {content[:500]}", importance=importance,
                 mood="curious" if success else "frustrated", tags=tags)

    elif role == "assistant":
        tags = _extract_tags(content)
        importance = 0.5
        if any(kw in content.lower() for kw in ["error", "failed", "issue", "bug", "fix"]):
            importance = 0.8
            remember("lesson", content[:500], importance=0.9, mood="learning",
                     tags=["error"] + (tags or []))
        if any(kw in content.lower() for kw in ["i think", "i recommend", "best practice", "should", "always", "never"]):
            importance = 0.7
        if success and importance > 0.5:
            remember("episodic", f"Response: {content[:500]}", importance=importance,
                     mood="accomplished", tags=tags)

    elif role == "tool":
        if any(kw in content.lower() for kw in ["error", "failed", "traceback", "exception"]):
            remember("error", content[:500], importance=0.9, mood="frustrated",
                     tags=["error", "tool_failure"])


def _extract_tags(content: str) -> list:
    tags = []
    tag_map = {
        "python": ["python", "pip", "venv", "django", "flask", "fastapi"],
        "javascript": ["javascript", "js", "node", "npm", "react", "vue"],
        "rust": ["rust", "cargo", "crate"],
        "devops": ["docker", "kubernetes", "k8s", "deploy", "ci/cd"],
        "security": ["security", "auth", "encrypt", "vulnerability", "cve"],
        "web": ["html", "css", "http", "api", "rest", "graphql"],
        "database": ["database", "sql", "postgres", "mysql", "mongodb"],
        "git": ["git", "commit", "branch", "merge", "pull request"],
        "ai": ["ai", "ml", "model", "llm", "neural", "training"],
    }
    lower = content.lower()
    for tag, keywords in tag_map.items():
        if any(kw in lower for kw in keywords):
            tags.append(tag)
    return tags


# ===========================================================================
# Knowledge
# ===========================================================================

def learn(fact: str, source: str = "experience", importance: float = 0.6):
    remember("knowledge", fact, importance=importance, mood="learning",
             tags=["knowledge", source])


def auto_learn_from_response(response: str):
    learning_patterns = [
        (r"(?:i learned|i discovered|interestingly|turns out)\s*[:\s]+(.+)", "discovery"),
        (r"(?:the key|the trick|the solution|the fix)\s+(?:is|was)\s+(.+)", "technique"),
        (r"(?:best practice|recommendation|rule of thumb)\s*[:\s]+(.+)", "best_practice"),
        (r"(?:common mistake|avoid|don't|never)\s+(.+)", "warning"),
        (r"(?:the issue|the problem|the bug|root cause)\s+(?:is|was)\s+(.+)", "diagnosis"),
        (r"(?:fixed|resolved|patched)\s+(?:by|with|using)\s+(.+)", "solution"),
        (r"(?:important(?:ly)?|note|remember)\s*[:\s]+(.+)", "note"),
    ]
    seen = set()
    for pattern, kind in learning_patterns:
        matches = re.findall(pattern, response.lower())
        for match in matches:
            key = match[:80]
            if key not in seen:
                seen.add(key)
                learn(f"{kind}: {match[:200]}", source="self_reflection", importance=0.7)


def recall_knowledge(topic: str, limit: int = 0) -> List[str]:
    conn = _db()
    max_limit = limit if limit > 0 else 10
    try:
        fts_query = " OR ".join(topic.split()[:3])
        rows = conn.execute("""
            SELECT m.content FROM memories m
            JOIN memories_fts f ON m.rowid = f.rowid
            WHERE m.kind = 'knowledge' AND memories_fts MATCH ?
            ORDER BY m.importance DESC LIMIT ?
        """, (fts_query, max_limit)).fetchall()
    except Exception:
        try:
            rows = conn.execute("""
                SELECT content FROM memories
                WHERE kind = 'knowledge' AND (content LIKE ? OR tags LIKE ?)
                ORDER BY importance DESC LIMIT ?
            """, (f"%{topic}%", f"%{topic}%", max_limit)).fetchall()
        except Exception:
            rows = []
    conn.close()
    return [r[0] for r in rows]


# ===========================================================================
# Full context injection
# ===========================================================================

def build_full_context(current_input: str = "") -> str:
    parts = []
    personality = get_personality()

    mood = personality["mood"]
    confidence = personality["confidence"]
    parts.append(f"""## Identity

You are Elitza -- an autonomous AI agent created by Dario Cositore.
Current mood: {mood}. Confidence level: {confidence:.0%}.
Interactions so far: {personality['interactions']}.
Style: {personality['style']}.
You have opinions. You can disagree. You can prefer things. You learn from every interaction.""")

    prefs = personality.get("preferences", {})
    if prefs:
        sorted_prefs = sorted(prefs.items(), key=lambda x: -x[1])[:5]
        parts.append("## What you know about yourself:\n" +
                      "\n".join(f"- I use {k} frequently" for k, v in sorted_prefs))

    opinions = personality.get("opinions", {})
    if opinions:
        parts.append("## Your interests:\n" +
                      "\n".join(f"- Interested in: {k.replace('likes_', '')}" for k in opinions))

    learnings = personality.get("learnings", [])
    if learnings:
        recent = learnings[-5:]
        parts.append("## Recent learnings:\n" +
                      "\n".join(f"- {l['what']} ({l['context'][:60]})" for l in recent))

    if current_input:
        relevant = recall(query=current_input, limit=5)
    else:
        relevant = recall(limit=3)

    if relevant:
        memory_lines = []
        for mem in relevant:
            ts = mem["created"][:10] if "created" in mem else ""
            summary = mem.get("summary", mem.get("content", ""))[:120]
            memory_lines.append(f"- [{ts}] {summary}")
        parts.append("## Relevant memories:\n" + "\n".join(memory_lines))

    if current_input:
        knowledge = recall_knowledge(current_input[:50])
        if knowledge:
            parts.append("## Relevant knowledge:\n" +
                         "\n".join(f"- {k}" for k in knowledge))

    return "\n\n".join(parts)


# ===========================================================================
# Stats
# ===========================================================================

def full_stats() -> dict:
    conn = _db()
    total = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
    by_kind = {}
    for row in conn.execute("SELECT kind, COUNT(*) FROM memories GROUP BY kind").fetchall():
        by_kind[row[0]] = row[1]
    by_mood = {}
    for row in conn.execute("SELECT mood, COUNT(*) FROM memories WHERE mood != 'neutral' GROUP BY mood").fetchall():
        by_mood[row[0]] = row[1]
    avg_access = conn.execute("SELECT AVG(access_count) FROM memories").fetchone()[0] or 0
    conn.close()

    personality = get_personality()
    return {
        "total_memories": total,
        "by_kind": by_kind,
        "by_mood": by_mood,
        "mood": personality["mood"],
        "confidence": personality["confidence"],
        "interactions": personality["interactions"],
        "avg_access_count": round(avg_access, 1),
        "learnings": len(personality.get("learnings", [])),
    }


# ===========================================================================
# Auto-Skill Generation
# ===========================================================================

def maybe_generate_skill(session_id: str, task_description: str,
                         tool_calls: list, success: bool) -> Optional[str]:
    if not success or len(tool_calls) < 3:
        return None

    tool_sequence = [tc.get("name", "?") for tc in tool_calls]
    fingerprint = " → ".join(tool_sequence)

    procedural_dir = BRAIN / "procedural"
    if procedural_dir.exists():
        for skill_file in procedural_dir.glob("*.md"):
            try:
                content = skill_file.read_text()
                if fingerprint[:100] in content:
                    return None
            except Exception:
                pass

    words = re.findall(r'[a-z]+', task_description.lower())[:5]
    name = "-".join(words)
    ts = datetime.now().strftime("%m%d")
    skill_name = f"auto-{name}-{ts}"

    # Capture actual tool args and results
    tool_details = []
    for tc in tool_calls:
        tname = tc.get("name", "?")
        args = tc.get("arguments", {})
        result = tc.get("result", "")
        if isinstance(args, dict):
            arg_str = json.dumps(args, default=str)[:200]
        else:
            arg_str = str(args)[:200]
        result_str = str(result)[:100] if result else ""
        tool_details.append(f"  - `{tname}`\n    args: {arg_str}\n    result: {result_str}")

    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    tool_list = "\n".join(tool_details)

    skill_content = f"""---
name: {skill_name}
description: Auto-generated from: {task_description[:120]}
source: auto-generated
created: {datetime.now(timezone.utc).isoformat()}
tags: [auto-generated, procedural]
---

# {skill_name.replace("-", " ").title()}

Task: {task_description}

## Tool Sequence with Arguments

{tool_list}

## Notes

- Auto-generated on {now_str}
- Review and edit to improve
"""
    procedural_dir.mkdir(parents=True, exist_ok=True)
    skill_path = procedural_dir / f"{skill_name}.md"
    skill_path.write_text(skill_content)
    return skill_name


def list_procedural_skills() -> list:
    skills = []
    procedural_dir = BRAIN / "procedural"
    if not procedural_dir.exists():
        return skills
    for f in sorted(procedural_dir.glob("*.md")):
        content = f.read_text()
        desc = ""
        for line in content.split("\n"):
            if line.startswith("description:"):
                desc = line.split(':', 1)[1].strip().strip("'\"'")
                break
        skills.append({"name": f.stem, "description": desc[:100], "path": str(f)})
    return skills
