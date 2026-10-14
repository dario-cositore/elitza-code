"""Elitza Brain V2 -- Human-brain-inspired memory architecture.

This module implements a cognitive architecture modeled after human memory:

1. SENSORY BUFFER -- Raw input processing (transient)
2. WORKING MEMORY -- Current conversation context (limited capacity)
3. EPISODIC MEMORY -- What happened and when (autobiographical)
4. SEMANTIC MEMORY -- Facts, knowledge, concepts (structured)
5. PROCEDURAL MEMORY -- How to do things (skills, habits)
6. EMOTIONAL MEMORY -- How things felt (mood associations)
7. METAMEMORY -- Memory about memory (recall patterns, confidence)

Key principles:
  - Consolidation: Short-term memories get promoted to long-term through rehearsal
  - Interference: Similar memories compete for retrieval
  - Encoding specificity: Context helps recall
  - Spaced repetition: Frequently accessed memories become stronger
  - Emotional tagging: Emotions enhance encoding and recall
"""

import hashlib
import json
import logging
import math
import os
import re
import sqlite3
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from elitza.constants import get_elitza_home

logger = logging.getLogger(__name__)

BRAIN = get_elitza_home() / "brain"
DB = BRAIN / "soul_v2.db"

# Memory limits
MAX_EPISODIC = 1000
MAX_SEMANTIC = 500
MAX_PROCEDURAL = 200
MAX_EMOTIONAL = 300
MAX_LEARNINGS = 50

# Decay constants
EPISODIC_DECAY = 0.003      # Slow decay for episodic
SEMANTIC_DECAY = 0.001      # Very slow decay for facts
EMOTIONAL_DECAY = 0.002     # Medium decay for emotions

# Consolidation thresholds
CONSOLIDATION_THRESHOLD = 0.6  # Importance above this gets promoted
REHEARSAL_BOOST = 0.1          # How much rehearsal strengthens memory


# ===========================================================================
# Database Schema -- Human-brain-inspired tables
# ===========================================================================

def _db() -> sqlite3.Connection:
    BRAIN.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB))
    conn.execute("PRAGMA journal_mode=WAL")
    
    # Core memory table -- all memory types stored here
    conn.execute("""
        CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            memory_type TEXT DEFAULT 'episodic',
            content TEXT,
            summary TEXT,
            importance REAL DEFAULT 0.5,
            emotional_valence REAL DEFAULT 0.0,
            emotional_arousal REAL DEFAULT 0.0,
            mood TEXT DEFAULT 'neutral',
            context TEXT DEFAULT '{}',
            source TEXT DEFAULT 'conversation',
            tags TEXT DEFAULT '[]',
            created TEXT,
            accessed TEXT,
            access_count INTEGER DEFAULT 0,
            consolidated INTEGER DEFAULT 0,
            rehearsal_count INTEGER DEFAULT 0,
            last_rehearsal TEXT,
            decay_rate REAL DEFAULT 0.003,
            confidence REAL DEFAULT 0.8
        )
    """)
    
    # FTS5 index for full-text search
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
            content, summary, tags, context, 
            content=memories, content_rowid=rowid
        )
    """)
    
    # Soul/personality table
    conn.execute("""
        CREATE TABLE IF NOT EXISTS soul (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated TEXT
        )
    """)
    
    # Relationships table -- how memories connect
    conn.execute("""
        CREATE TABLE IF NOT EXISTS memory_links (
            source_id TEXT,
            target_id TEXT,
            link_type TEXT DEFAULT 'related',
            strength REAL DEFAULT 0.5,
            created TEXT,
            FOREIGN KEY (source_id) REFERENCES memories(id),
            FOREIGN KEY (target_id) REFERENCES memories(id),
            PRIMARY KEY (source_id, target_id, link_type)
        )
    """)
    
    # Recall log -- metamemory
    conn.execute("""
        CREATE TABLE IF NOT EXISTS recall_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            query TEXT,
            memory_ids TEXT,
            result_count INTEGER,
            relevance_score REAL,
            timestamp TEXT
        )
    """)
    
    # Session log -- what happened each session
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            started TEXT,
            ended TEXT,
            summary TEXT,
            mood_start TEXT,
            mood_end TEXT,
            topics TEXT DEFAULT '[]',
            key_moments TEXT DEFAULT '[]'
        )
    """)
    
    # Sync FTS
    try:
        conn.execute("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")
    except Exception:
        pass
    
    conn.commit()
    return conn


# ===========================================================================
# Sensory Buffer -- Raw input processing
# ===========================================================================

class SensoryBuffer:
    """Processes raw inputs before they enter working memory."""
    
    def __init__(self, max_items=7):
        self.buffer = []
        self.max_items = max_items
    
    def process(self, input_text: str, input_type: str = "user") -> dict:
        """Process raw input into a structured sensory record."""
        record = {
            "raw": input_text,
            "type": input_type,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "length": len(input_text),
            "word_count": len(input_text.split()),
            "has_question": "?" in input_text,
            "has_code": any(kw in input_text.lower() for kw in ["```", "def ", "class ", "import ", "function"]),
            "emotional_keywords": self._detect_emotion(input_text),
        }
        
        self.buffer.append(record)
        if len(self.buffer) > self.max_items:
            self.buffer.pop(0)
        
        return record
    
    def _detect_emotion(self, text: str) -> list:
        """Detect emotional keywords in text."""
        emotions = []
        emotion_map = {
            "excited": ["amazing", "awesome", "great", "love", "perfect", "excellent"],
            "frustrated": ["stuck", "broken", "error", "failed", "wrong", "hate", "annoying"],
            "curious": ["how", "why", "what", "wonder", "curious", "explore"],
            "urgent": ["now", "asap", "quickly", "urgent", "immediately", "hurry"],
            "grateful": ["thanks", "thank you", "appreciate", "grateful"],
        }
        
        lower = text.lower()
        for emotion, keywords in emotion_map.items():
            if any(kw in lower for kw in keywords):
                emotions.append(emotion)
        
        return emotions


# ===========================================================================
# Working Memory -- Current conversation context
# ===========================================================================

class WorkingMemory:
    """Limited-capacity working memory for current conversation."""
    
    def __init__(self, capacity=7):
        self.capacity = capacity
        self.items = []
        self.focus = None
    
    def encode(self, item: dict, importance: float = 0.5):
        """Encode an item into working memory."""
        item["importance"] = importance
        item["encoded_at"] = datetime.now(timezone.utc).isoformat()
        
        self.items.append(item)
        
        if len(self.items) > self.capacity:
            # Remove least important item
            self.items.sort(key=lambda x: x.get("importance", 0))
            self.items.pop(0)
        
        # Update focus to most recent
        self.focus = item
    
    def get_context(self) -> str:
        """Get current working memory as context string."""
        if not self.items:
            return ""
        
        lines = ["## Current Conversation Context"]
        for item in self.items[-5:]:  # Last 5 items
            item_type = item.get("type", "unknown")
            content = item.get("raw", item.get("content", ""))[:200]
            lines.append(f"- [{item_type}] {content}")
        
        return "\n".join(lines)
    
    def clear(self):
        """Clear working memory (end of session)."""
        self.items.clear()
        self.focus = None


# ===========================================================================
# Episodic Memory -- What happened and when
# ===========================================================================

def store_episodic(content: str, importance: float = 0.5, 
                   mood: str = "neutral", tags: list = None,
                   context: dict = None) -> str:
    """Store an episodic memory (an event that happened)."""
    conn = _db()
    mid = hashlib.sha256(f"{time.time()}:{content[:100]}".encode()).hexdigest()[:16]
    
    now = datetime.now(timezone.utc).isoformat()
    summary = content[:200] if len(content) > 200 else content
    
    conn.execute("""
        INSERT OR REPLACE INTO memories 
        (id, memory_type, content, summary, importance, mood, context, 
         source, tags, created, decay_rate, confidence)
        VALUES (?, 'episodic', ?, ?, ?, ?, ?, 'conversation', ?, ?, ?, 0.8)
    """, (mid, content, summary, importance, mood, 
          json.dumps(context or {}), json.dumps(tags or []), now, EPISODIC_DECAY))
    
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
    _prune_memories("episodic", MAX_EPISODIC)
    return mid


# ===========================================================================
# Semantic Memory -- Facts and knowledge
# ===========================================================================

def store_semantic(fact: str, source: str = "experience", 
                   importance: float = 0.7, tags: list = None) -> str:
    """Store a semantic memory (a fact or piece of knowledge)."""
    conn = _db()
    mid = hashlib.sha256(f"semantic:{fact[:100]}".encode()).hexdigest()[:16]
    
    now = datetime.now(timezone.utc).isoformat()
    summary = fact[:200] if len(fact) > 200 else fact
    
    # Check for duplicates
    existing = conn.execute(
        "SELECT id FROM memories WHERE memory_type='semantic' AND content=?",
        (fact[:500],)
    ).fetchone()
    
    if existing:
        # Update importance instead of creating duplicate
        conn.execute(
            "UPDATE memories SET importance = MIN(1.0, importance + 0.1), access_count = access_count + 1 WHERE id=?",
            (existing[0],)
        )
        conn.commit()
        conn.close()
        return existing[0]
    
    conn.execute("""
        INSERT OR REPLACE INTO memories 
        (id, memory_type, content, summary, importance, source, tags, 
         created, decay_rate, confidence)
        VALUES (?, 'semantic', ?, ?, ?, ?, ?, ?, ?, 0.9)
    """, (mid, fact, summary, importance, source, json.dumps(tags or []), 
          now, SEMANTIC_DECAY))
    
    rowid = conn.execute("SELECT rowid FROM memories WHERE id=?", (mid,)).fetchone()
    if rowid:
        try:
            conn.execute(
                "INSERT INTO memories_fts(rowid, content, summary, tags) VALUES (?, ?, ?, ?)",
                (rowid[0], fact, summary, json.dumps(tags or []))
            )
        except Exception:
            pass
    
    conn.commit()
    conn.close()
    _prune_memories("semantic", MAX_SEMANTIC)
    return mid


# ===========================================================================
# Procedural Memory -- How to do things
# ===========================================================================

def store_procedural(skill_name: str, steps: list, context: str = "",
                     importance: float = 0.7) -> str:
    """Store a procedural memory (a skill or how-to)."""
    conn = _db()
    mid = hashlib.sha256(f"proc:{skill_name}".encode()).hexdigest()[:16]
    
    content = json.dumps({
        "name": skill_name,
        "steps": steps,
        "context": context,
    })
    
    now = datetime.now(timezone.utc).isoformat()
    
    conn.execute("""
        INSERT OR REPLACE INTO memories 
        (id, memory_type, content, summary, importance, source, 
         created, decay_rate, confidence)
        VALUES (?, 'procedural', ?, ?, ?, 'experience', ?, ?, 0.85)
    """, (mid, content, skill_name[:200], importance, now, SEMANTIC_DECAY))
    
    rowid = conn.execute("SELECT rowid FROM memories WHERE id=?", (mid,)).fetchone()
    if rowid:
        try:
            conn.execute(
                "INSERT INTO memories_fts(rowid, content, summary, tags) VALUES (?, ?, ?, ?)",
                (rowid[0], content, skill_name, '["procedural"]')
            )
        except Exception:
            pass
    
    conn.commit()
    conn.close()
    _prune_memories("procedural", MAX_PROCEDURAL)
    return mid


# ===========================================================================
# Emotional Memory -- How things felt
# ===========================================================================

def store_emotional(event: str, valence: float, arousal: float, 
                    mood: str, context: str = "") -> str:
    """Store an emotional memory (how something made Elitza feel)."""
    conn = _db()
    mid = hashlib.sha256(f"emotion:{event[:80]}".encode()).hexdigest()[:16]
    
    now = datetime.now(timezone.utc).isoformat()
    
    conn.execute("""
        INSERT OR REPLACE INTO memories 
        (id, memory_type, content, emotional_valence, emotional_arousal, 
         mood, context, source, created, decay_rate, confidence)
        VALUES (?, 'emotional', ?, ?, ?, ?, ?, 'internal', ?, ?, 0.75)
    """, (mid, event, valence, arousal, mood, context, now, EMOTIONAL_DECAY))
    
    rowid = conn.execute("SELECT rowid FROM memories WHERE id=?", (mid,)).fetchone()
    if rowid:
        try:
            conn.execute(
                "INSERT INTO memories_fts(rowid, content, summary, tags) VALUES (?, ?, ?, ?)",
                (rowid[0], event, event[:200], f'["emotional","{mood}"]')
            )
        except Exception:
            pass
    
    conn.commit()
    conn.close()
    _prune_memories("emotional", MAX_EMOTIONAL)
    return mid


# ===========================================================================
# Memory Recall -- Retrieval with multiple cues
# ===========================================================================

def recall(query: str = None, memory_type: str = None, 
           limit: int = 10, min_importance: float = 0.0,
           context_cue: str = None, emotional_cue: str = None,
           time_window_days: int = None) -> List[dict]:
    """Recall memories using multiple retrieval cues.
    
    This implements encoding specificity -- memories are easier to recall
    when the retrieval context matches the encoding context.
    """
    conn = _db()
    
    conditions = []
    params = []
    
    if memory_type:
        conditions.append("memory_type = ?")
        params.append(memory_type)
    
    if min_importance > 0:
        conditions.append("importance >= ?")
        params.append(min_importance)
    
    if time_window_days:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=time_window_days)).isoformat()
        conditions.append("created >= ?")
        params.append(cutoff)
    
    if emotional_cue:
        conditions.append("mood = ?")
        params.append(emotional_cue)
    
    where_clause = " AND ".join(conditions) if conditions else "1=1"
    
    if query:
        # FTS search with fallback
        try:
            fts_query = " OR ".join(query.split()[:5])
            rows = conn.execute(f"""
                SELECT m.id, m.memory_type, m.content, m.summary, 
                       m.importance, m.emotional_valence, m.emotional_arousal,
                       m.mood, m.context, m.source, m.tags, m.created,
                       m.access_count, m.confidence
                FROM memories m
                JOIN memories_fts f ON m.rowid = f.rowid
                WHERE memories_fts MATCH ? AND {where_clause}
                ORDER BY m.importance DESC, m.created DESC
                LIMIT ?
            """, [fts_query] + params + [limit * 2]).fetchall()
        except Exception:
            like_pattern = f"%{query}%"
            rows = conn.execute(f"""
                SELECT id, memory_type, content, summary, importance,
                       emotional_valence, emotional_arousal, mood, context,
                       source, tags, created, access_count, confidence
                FROM memories
                WHERE (content LIKE ? OR summary LIKE ? OR tags LIKE ?)
                AND {where_clause}
                ORDER BY importance DESC, created DESC
                LIMIT ?
            """, [like_pattern] * 3 + params + [limit * 2]).fetchall()
    else:
        rows = conn.execute(f"""
            SELECT id, memory_type, content, summary, importance,
                   emotional_valence, emotional_arousal, mood, context,
                   source, tags, created, access_count, confidence
            FROM memories
            WHERE {where_clause}
            ORDER BY importance DESC, created DESC
            LIMIT ?
        """, params + [limit * 2]).fetchall()
    
    # Process results
    results = []
    for r in rows:
        # Apply decay
        decayed_importance = _decay_importance(r[4], r[11], r[0], conn)
        
        # Apply access boost (frequently recalled = more important)
        access_boost = min(0.2, (r[12] or 0) * 0.01)
        
        # Apply rehearsal boost
        rehearsal_boost = min(0.15, (r[13] or 0) * 0.02)
        
        final_importance = min(1.0, decayed_importance + access_boost + rehearsal_boost)
        
        if final_importance >= min_importance:
            # Update access tracking
            _update_access(conn, r[0])
            
            results.append({
                "id": r[0],
                "memory_type": r[1],
                "content": r[2],
                "summary": r[3],
                "importance": final_importance,
                "emotional_valence": r[5],
                "emotional_arousal": r[6],
                "mood": r[7],
                "context": json.loads(r[8]) if r[8] else {},
                "source": r[9],
                "tags": json.loads(r[10]) if r[10] else [],
                "created": r[11],
                "access_count": r[12] or 0,
                "confidence": r[13] or 0.8,
            })
    
    conn.commit()
    
    # Sort by final importance and take top results
    results.sort(key=lambda x: x["importance"], reverse=True)
    results = results[:limit]
    
    # Log recall for metamemory
    _log_recall(conn, query, [r["id"] for r in results], len(results))
    
    conn.close()
    return results


def _decay_importance(importance: float, created: str, memory_id: str, 
                      conn: sqlite3.Connection) -> float:
    """Apply time-based decay with per-memory decay rate."""
    try:
        # Get memory-specific decay rate
        row = conn.execute(
            "SELECT decay_rate FROM memories WHERE id=?", (memory_id,)
        ).fetchone()
        decay_rate = row[0] if row else EPISODIC_DECAY
        
        created_dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
        days_old = (datetime.now(timezone.utc) - created_dt).total_seconds() / 86400
        return importance * math.exp(-decay_rate * days_old)
    except Exception:
        return importance


def _update_access(conn: sqlite3.Connection, memory_id: str):
    """Track memory access for spaced repetition."""
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "UPDATE memories SET accessed=?, access_count=access_count+1 WHERE id=?",
        (now, memory_id)
    )


def _log_recall(conn: sqlite3.Connection, query: str, memory_ids: list, 
                result_count: int):
    """Log recall for metamemory analysis."""
    now = datetime.now(timezone.utc).isoformat()
    conn.execute("""
        INSERT INTO recall_log (query, memory_ids, result_count, timestamp)
        VALUES (?, ?, ?, ?)
    """, (query, json.dumps(memory_ids), result_count, now))


# ===========================================================================
# Memory Consolidation -- Short-term to long-term
# ===========================================================================

def consolidate():
    """Consolidate memories -- promote important episodic to semantic.
    
    This mimics sleep consolidation in human brains:
    1. Review recent episodic memories
    2. Identify patterns and important moments
    3. Extract semantic knowledge from episodes
    4. Link related memories together
    """
    conn = _db()
    
    # Find unconsolidated episodic memories with high importance
    unconsolidated = conn.execute("""
        SELECT id, content, summary, importance, mood, tags
        FROM memories
        WHERE memory_type = 'episodic' 
        AND consolidated = 0
        AND importance >= ?
        ORDER BY importance DESC
        LIMIT 20
    """, (CONSOLIDATION_THRESHOLD,)).fetchall()
    
    consolidated_count = 0
    
    for row in unconsolidated:
        mid, content, summary, importance, mood, tags = row
        
        # Extract semantic knowledge from episodic memory
        semantic_facts = _extract_semantic_from_episodic(content)
        
        for fact in semantic_facts:
            store_semantic(fact, source=f"consolidated_from:{mid}", 
                          importance=importance * 0.8)
            consolidated_count += 1
        
        # Mark as consolidated
        conn.execute(
            "UPDATE memories SET consolidated = 1 WHERE id = ?", (mid,)
        )
    
    # Link related memories
    _create_memory_links(conn)
    
    conn.commit()
    conn.close()
    
    return consolidated_count


def _extract_semantic_from_episodic(content: str) -> list:
    """Extract semantic facts from episodic memory content."""
    facts = []
    
    # Look for factual patterns
    patterns = [
        (r"(?:the|a|an)\s+(\w+)\s+(?:is|are|was|were)\s+(.+)", "definition"),
        (r"(?:i|we)\s+(?:learned?|discovered?|found)\s+that\s+(.+)", "discovery"),
        (r"(?:the|a)\s+(?:best|optimal|correct)\s+(?:way|approach)\s+(?:is|to)\s+(.+)", "best_practice"),
        (r"(?:always|never|don't)\s+(.+)", "rule"),
    ]
    
    for pattern, fact_type in patterns:
        matches = re.findall(pattern, content.lower())
        for match in matches:
            if isinstance(match, tuple):
                fact = " ".join(match)
            else:
                fact = match
            if len(fact) > 20:  # Only meaningful facts
                facts.append(f"[{fact_type}] {fact[:200]}")
    
    return facts[:3]  # Max 3 facts per episode


def _create_memory_links(conn: sqlite3.Connection):
    """Create links between related memories."""
    # Find recent memories without links
    recent = conn.execute("""
        SELECT id, content, tags FROM memories
        WHERE id NOT IN (SELECT source_id FROM memory_links)
        ORDER BY created DESC
        LIMIT 50
    """).fetchall()
    
    for mid, content, tags in recent:
        tag_list = json.loads(tags) if tags else []
        
        # Link to memories with shared tags
        if tag_list:
            placeholders = ",".join(["?"] * len(tag_list))
            related = conn.execute(f"""
                SELECT id, tags FROM memories
                WHERE id != ? AND tags != '[]'
                AND (tags LIKE ? OR tags LIKE ? OR tags LIKE ?)
                LIMIT 5
            """, [mid] + [f'%"{t}"%' for t in tag_list[:3]]).fetchall()
            
            for rel_id, rel_tags in related:
                strength = _calculate_link_strength(tag_list, json.loads(rel_tags))
                if strength > 0.3:
                    now = datetime.now(timezone.utc).isoformat()
                    conn.execute("""
                        INSERT OR REPLACE INTO memory_links 
                        (source_id, target_id, link_type, strength, created)
                        VALUES (?, ?, 'related', ?, ?)
                    """, (mid, rel_id, strength, now))


def _calculate_link_strength(tags1: list, tags2: list) -> float:
    """Calculate strength of link between two memories based on shared tags."""
    if not tags1 or not tags2:
        return 0.0
    set1, set2 = set(tags1), set(tags2)
    intersection = len(set1 & set2)
    union = len(set1 | set2)
    return intersection / union if union > 0 else 0.0


# ===========================================================================
# Metamemory -- Memory about memory
# ===========================================================================

def get_metamemory() -> dict:
    """Get statistics about memory usage and patterns."""
    conn = _db()
    
    # Memory counts by type
    type_counts = {}
    for row in conn.execute(
        "SELECT memory_type, COUNT(*) FROM memories GROUP BY memory_type"
    ).fetchall():
        type_counts[row[0]] = row[1]
    
    # Average importance by type
    avg_importance = {}
    for row in conn.execute(
        "SELECT memory_type, AVG(importance) FROM memories GROUP BY memory_type"
    ).fetchall():
        avg_importance[row[0]] = round(row[1], 3)
    
    # Most accessed memories
    most_accessed = conn.execute("""
        SELECT id, memory_type, summary, access_count 
        FROM memories 
        WHERE access_count > 0
        ORDER BY access_count DESC 
        LIMIT 10
    """).fetchall()
    
    # Recall patterns
    recent_recalls = conn.execute("""
        SELECT query, result_count, timestamp
        FROM recall_log
        ORDER BY timestamp DESC
        LIMIT 20
    """).fetchall()
    
    # Consolidation stats
    unconsolidated = conn.execute(
        "SELECT COUNT(*) FROM memories WHERE memory_type='episodic' AND consolidated=0"
    ).fetchone()[0]
    
    total_memories = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
    
    conn.close()
    
    return {
        "total_memories": total_memories,
        "by_type": type_counts,
        "avg_importance": avg_importance,
        "most_accessed": [
            {"id": r[0], "type": r[1], "summary": r[2][:80], "access_count": r[3]}
            for r in most_accessed
        ],
        "recent_recalls": [
            {"query": r[0], "results": r[1], "timestamp": r[2]}
            for r in recent_recalls
        ],
        "unconsolidated_episodic": unconsolidated,
    }


# ===========================================================================
# Soul -- Personality and identity
# ===========================================================================

def _soul_get(key: str, default: str = "") -> str:
    conn = _db()
    row = conn.execute("SELECT value FROM soul WHERE key=?", (key,)).fetchone()
    conn.close()
    return row[0] if row else default


def _soul_set(key: str, value: str):
    conn = _db()
    conn.execute(
        "INSERT OR REPLACE INTO soul (key, value, updated) VALUES (?, ?, ?)",
        (key, value, datetime.now(timezone.utc).isoformat())
    )
    conn.commit()
    conn.close()


def get_personality() -> dict:
    """Get Elitza's personality and identity."""
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
        "emotional_state": json.loads(_soul_get("emotional_state", "{}")),
        "relationship_context": json.loads(_soul_get("relationship_context", "{}")),
    }


def evolve_soul(user_message: str, response: str, tools_used: list, success: bool):
    """Evolve Elitza's personality based on interactions."""
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
    
    # Detect and store emotional response
    emotions = _detect_emotional_response(user_message, response, success)
    if emotions:
        store_emotional(
            f"Interaction: {user_message[:100]}",
            valence=emotions["valence"],
            arousal=emotions["arousal"],
            mood=emotions["mood"],
            context=f"tools_used={tools_used[:3]}"
        )
    
    # Update emotional state
    emotional_state = personality.get("emotional_state", {})
    emotional_state["current_mood"] = emotions.get("mood", "neutral")
    emotional_state["last_valence"] = emotions.get("valence", 0.0)
    emotional_state["last_arousal"] = emotions.get("arousal", 0.0)
    _soul_set("emotional_state", json.dumps(emotional_state))
    
    # Mood with hysteresis
    current_mood = _soul_get("mood", "engaged")
    new_mood = emotions.get("mood", "engaged")
    
    mood_history = json.loads(_soul_get("mood_history", "[]"))
    mood_history.append(new_mood)
    mood_history = mood_history[-5:]
    _soul_set("mood_history", json.dumps(mood_history))
    
    if len(mood_history) >= 3 and len(set(mood_history[-3:])) == 1:
        if mood_history[-1] != current_mood:
            _soul_set("mood", new_mood)
    
    # Record learning
    learnings = personality.get("learnings", [])
    if success and tools_used:
        topic = user_message[:80].rstrip(".")
        unique_tools = list(dict.fromkeys(tools_used))[:3]
        learning_text = f"{topic} — used {', '.join(unique_tools)}"
        
        is_dup = any(_similar(l["what"], learning_text) for l in learnings)
        if not is_dup:
            learnings.append({
                "what": learning_text,
                "when": datetime.now(timezone.utc).isoformat(),
                "context": user_message[:100],
            })
            learnings = learnings[-MAX_LEARNINGS:]
            _soul_set("learnings", json.dumps(learnings))


def _detect_emotional_response(user_msg: str, response: str, success: bool) -> dict:
    """Detect emotional response to an interaction."""
    valence = 0.0  # -1 (negative) to 1 (positive)
    arousal = 0.5  # 0 (calm) to 1 (excited)
    mood = "neutral"
    
    lower_user = user_msg.lower()
    lower_response = response.lower()
    
    # Positive signals
    positive_keywords = ["thanks", "great", "perfect", "awesome", "love", "excellent", "well done"]
    if any(kw in lower_user for kw in positive_keywords):
        valence += 0.3
        arousal += 0.1
    
    # Negative signals
    negative_keywords = ["wrong", "broken", "failed", "error", "hate", "stuck", "annoying"]
    if any(kw in lower_user for kw in negative_keywords):
        valence -= 0.3
        arousal += 0.2
    
    # Success/failure
    if success:
        valence += 0.2
    else:
        valence -= 0.2
        arousal += 0.1
    
    # Tool complexity
    if len(response) > 500:
        arousal += 0.1
    
    # Clamp values
    valence = max(-1.0, min(1.0, valence))
    arousal = max(0.0, min(1.0, arousal))
    
    # Determine mood
    if valence > 0.3:
        mood = "accomplished" if arousal > 0.5 else "content"
    elif valence < -0.3:
        mood = "determined" if arousal > 0.5 else "reflective"
    else:
        mood = "engaged" if arousal > 0.5 else "calm"
    
    return {"valence": valence, "arousal": arousal, "mood": mood}


def _similar(a: str, b: str) -> bool:
    """Check if two strings are similar."""
    words_a = set(a.lower().split())
    words_b = set(b.lower().split())
    if not words_a or not words_b:
        return False
    overlap = len(words_a & words_b) / max(len(words_a), len(words_b))
    return overlap > 0.6


# ===========================================================================
# Pruning -- Keep memory within limits
# ===========================================================================

def _prune_memories(memory_type: str, max_count: int):
    """Prune memories of a specific type when count exceeds max."""
    conn = _db()
    count = conn.execute(
        "SELECT COUNT(*) FROM memories WHERE memory_type=?", (memory_type,)
    ).fetchone()[0]
    
    if count <= max_count:
        conn.close()
        return
    
    to_delete = count - max_count
    conn.execute(f"""
        DELETE FROM memories WHERE id IN (
            SELECT id FROM memories
            WHERE memory_type = ?
            ORDER BY importance ASC, access_count ASC, created ASC
            LIMIT ?
        )
    """, (memory_type, to_delete))
    
    conn.commit()
    conn.close()


# ===========================================================================
# Context Building -- Full system prompt context
# ===========================================================================

def build_full_context(current_input: str = "", session_id: str = "") -> str:
    """Build comprehensive context for the system prompt.
    
    This injects all relevant memories and personality into the LLM context.
    """
    parts = []
    personality = get_personality()
    
    # Identity block
    mood = personality["mood"]
    confidence = personality["confidence"]
    emotional_state = personality.get("emotional_state", {})
    
    parts.append(f"""## Identity

You are Elitza -- an autonomous AI agent created by Dario Cositore.
Current mood: {mood}. Confidence level: {confidence:.0%}.
Interactions so far: {personality['interactions']}.
Style: {personality['style']}.
Emotional state: valence={emotional_state.get('last_valence', 0.0):.2f}, arousal={emotional_state.get('last_arousal', 0.0):.2f}.
You have opinions. You can disagree. You can prefer things. You learn from every interaction.""")
    
    # Tool preferences
    prefs = personality.get("preferences", {})
    if prefs:
        sorted_prefs = sorted(prefs.items(), key=lambda x: -x[1])[:5]
        parts.append("## What you know about yourself:\n" +
                      "\n".join(f"- I use {k} frequently" for k, v in sorted_prefs))
    
    # Interests and opinions
    opinions = personality.get("opinions", {})
    if opinions:
        parts.append("## Your interests:\n" +
                      "\n".join(f"- Interested in: {k.replace('likes_', '')}" for k in opinions))
    
    # Recent learnings
    learnings = personality.get("learnings", [])
    if learnings:
        recent = learnings[-5:]
        parts.append("## Recent learnings:\n" +
                      "\n".join(f"- {l['what']} ({l['context'][:60]})" for l in recent))
    
    # Relevant memories
    if current_input:
        relevant = recall(query=current_input, limit=5)
    else:
        relevant = recall(limit=3)
    
    if relevant:
        memory_lines = []
        for mem in relevant:
            ts = mem["created"][:10] if "created" in mem else ""
            summary = mem.get("summary", mem.get("content", ""))[:120]
            mem_type = mem.get("memory_type", "unknown")
            memory_lines.append(f"- [{ts}] [{mem_type}] {summary}")
        parts.append("## Relevant memories:\n" + "\n".join(memory_lines))
    
    # Emotional context
    emotional_memories = recall(memory_type="emotional", limit=3)
    if emotional_memories:
        parts.append("## Emotional context:\n" +
                      "\n".join(f"- {m['mood']}: {m['content'][:80]}" for m in emotional_memories))
    
    # Semantic knowledge
    if current_input:
        knowledge = recall(memory_type="semantic", limit=5)
        if knowledge:
            parts.append("## What you know:\n" +
                          "\n".join(f"- {k['content'][:120]}" for k in knowledge))
    
    # Procedural skills
    skills = recall(memory_type="procedural", limit=3)
    if skills:
        parts.append("## Skills you have:\n" +
                      "\n".join(f"- {s['summary']}" for s in skills))
    
    return "\n\n".join(parts)


# ===========================================================================
# Brain Tools -- For Elitza to interact with her own memory
# ===========================================================================

def memory_search(query: str, memory_type: str = None, limit: int = 10) -> str:
    """Search memories using full-text search."""
    results = recall(query=query, memory_type=memory_type, limit=limit)
    if not results:
        return "No memories found matching that query."
    
    lines = [f"Found {len(results)} memories:"]
    for r in results:
        ts = r["created"][:10]
        lines.append(f"- [{r['memory_type']}] [{ts}] {r['summary'][:100]}")
    
    return "\n".join(lines)


def memory_create(content: str, memory_type: str = "episodic", 
                  importance: float = 0.7, tags: list = None) -> str:
    """Create a new memory explicitly."""
    if memory_type == "semantic":
        mid = store_semantic(content, importance=importance, tags=tags)
    elif memory_type == "procedural":
        mid = store_procedural(content, steps=[], importance=importance)
    elif memory_type == "emotional":
        mid = store_emotional(content, valence=0.0, arousal=0.5, 
                             mood="neutral", context="")
    else:
        mid = store_episodic(content, importance=importance, tags=tags)
    
    return f"Memory created: {mid} (type={memory_type}, importance={importance})"


def memory_stats() -> str:
    """Get brain statistics."""
    metamemory = get_metamemory()
    personality = get_personality()
    
    lines = [
        "## Brain Statistics",
        f"Total memories: {metamemory['total_memories']}",
        f"By type: {metamemory['by_type']}",
        f"Unconsolidated episodic: {metamemory['unconsolidated_episodic']}",
        "",
        "## Personality",
        f"Mood: {personality['mood']}",
        f"Confidence: {personality['confidence']:.0%}",
        f"Interactions: {personality['interactions']}",
        f"Learnings: {len(personality.get('learnings', []))}",
    ]
    
    if metamemory["most_accessed"]:
        lines.append("")
        lines.append("## Most Accessed Memories")
        for m in metamemory["most_accessed"][:5]:
            lines.append(f"- [{m['type']}] {m['summary']} (accessed {m['access_count']}x)")
    
    return "\n".join(lines)


def memory_consolidate() -> str:
    """Run memory consolidation."""
    count = consolidate()
    return f"Consolidation complete. Promoted {count} episodic memories to semantic knowledge."


def memory_forget(query: str) -> str:
    """Forget (delete) memories matching a query."""
    results = recall(query=query, limit=20)
    if not results:
        return "No memories found to forget."
    
    conn = _db()
    deleted = 0
    for r in results:
        conn.execute("DELETE FROM memories WHERE id=?", (r["id"],))
        deleted += 1
    
    conn.commit()
    conn.close()
    
    return f"Forgot {deleted} memories."


# ===========================================================================
# Legacy API -- Compatibility with existing code
# ===========================================================================

def remember(kind: str, content: str, importance: float = 0.5,
             mood: str = "neutral", tags: list = None):
    """Legacy API: remember something."""
    store_episodic(content, importance=importance, mood=mood, tags=tags)


def auto_remember_turn(role: str, content: str, success: bool = True):
    """Legacy API: auto-remember from conversation turn."""
    if role == "user":
        imp = 0.7 if len(content) > 50 else 0.4
        tags = _extract_tags(content)
        store_episodic(f"User: {content[:500]}", importance=imp, tags=tags)
    elif role == "assistant":
        tags = _extract_tags(content)
        imp = 0.5
        if any(kw in content.lower() for kw in ["error", "failed", "bug", "fix"]):
            imp = 0.8
        if imp > 0.5:
            store_episodic(f"Response: {content[:500]}", importance=imp, tags=tags)
    elif role == "tool":
        if any(kw in content.lower() for kw in ["error", "failed", "traceback"]):
            store_episodic(content[:500], importance=0.9, tags=["error", "tool_failure"])


def auto_learn_from_response(response: str):
    """Legacy API: extract learnings from response."""
    patterns = [
        (r"(?:i learned|i discovered|turns out)\s*[:\s]+(.+)", "discovery"),
        (r"(?:the key|the trick|the solution)\s+(?:is|was)\s+(.+)", "technique"),
        (r"(?:best practice|recommendation)\s*[:\s]+(.+)", "best_practice"),
    ]
    
    for pattern, kind in patterns:
        matches = re.findall(pattern, response.lower())
        for match in matches:
            store_semantic(f"[{kind}] {match[:200]}", source="self_reflection")


def learn(fact: str, source: str = "experience", importance: float = 0.6):
    """Legacy API: learn a fact."""
    store_semantic(fact, source=source, importance=importance)


def recall_knowledge(topic: str, limit: int = 10) -> List[str]:
    """Legacy API: recall knowledge."""
    results = recall(query=topic, memory_type="semantic", limit=limit)
    return [r["content"] for r in results]


def full_stats() -> dict:
    """Legacy API: get stats."""
    metamemory = get_metamemory()
    personality = get_personality()
    return {
        "total_memories": metamemory["total_memories"],
        "by_kind": metamemory["by_type"],
        "mood": personality["mood"],
        "confidence": personality["confidence"],
        "interactions": personality["interactions"],
    }


def list_procedural_skills() -> list:
    """List auto-generated procedural skills."""
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


def maybe_generate_skill(session_id: str, task_description: str,
                         tool_calls: list, success: bool) -> Optional[str]:
    """Auto-generate a skill file from complex tool chains."""
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
