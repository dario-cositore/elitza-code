"""Kanban -- multi-agent task coordination board.

SQLite-backed task board with worker heartbeats, stale claim
reclamation, and structured handoffs. Searches the tool catalog by keyword.
"""

import json
import logging
import sqlite3
import time
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Dict, Optional

from elitza.constants import get_elitza_home

logger = logging.getLogger(__name__)

KANBAN_DB = get_elitza_home() / "kanban.db"
HEARTBEAT_TIMEOUT = 120  # seconds before a claim is considered stale


def _db() -> sqlite3.Connection:
    KANBAN_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(KANBAN_DB))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS boards (
            board_id TEXT PRIMARY KEY,
            name TEXT,
            created_at TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS tasks (
            task_id TEXT PRIMARY KEY,
            board_id TEXT,
            title TEXT,
            description TEXT,
            status TEXT DEFAULT 'backlog',
            priority INTEGER DEFAULT 0,
            assigned_to TEXT,
            claimed_at TEXT,
            heartbeat_at TEXT,
            result TEXT,
            created_at TEXT,
            updated_at TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS workers (
            worker_id TEXT PRIMARY KEY,
            board_id TEXT,
            name TEXT,
            heartbeat_at TEXT,
            current_task TEXT
        )
    """)
    conn.commit()
    return conn


class KanbanBoard:
    """A kanban task board."""

    def __init__(self, board_id: str = "default"):
        self.board_id = board_id
        self._ensure_board()

    def _ensure_board(self):
        conn = _db()
        conn.execute("""
            INSERT OR IGNORE INTO boards (board_id, name, created_at)
            VALUES (?, ?, ?)
        """, (self.board_id, self.board_id, datetime.now(timezone.utc).isoformat()))
        conn.commit()
        conn.close()

    def add_task(self, title: str, description: str = "",
                 priority: int = 0, status: str = "backlog") -> str:
        """Add a new task to the board."""
        task_id = f"task_{int(time.time())}_{hash(title) % 10000}"
        now = datetime.now(timezone.utc).isoformat()
        conn = _db()
        conn.execute("""
            INSERT INTO tasks (task_id, board_id, title, description, status, priority, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (task_id, self.board_id, title, description, status, priority, now, now))
        conn.commit()
        conn.close()
        return task_id

    def claim_task(self, task_id: str, worker_id: str) -> bool:
        """Claim a task for a worker."""
        now = datetime.now(timezone.utc).isoformat()
        conn = _db()
        # Check if task is unclaimed
        task = conn.execute(
            "SELECT assigned_to FROM tasks WHERE task_id=?", (task_id,)
        ).fetchone()
        if not task or (task[0] and task[0] != worker_id):
            conn.close()
            return False

        conn.execute("""
            UPDATE tasks SET assigned_to=?, claimed_at=?, heartbeat_at=?, status='in_progress', updated_at=?
            WHERE task_id=?
        """, (worker_id, now, now, now, task_id))
        conn.commit()
        conn.close()
        return True

    def heartbeat(self, task_id: str, worker_id: str):
        """Update heartbeat for a claimed task."""
        now = datetime.now(timezone.utc).isoformat()
        conn = _db()
        conn.execute("""
            UPDATE tasks SET heartbeat_at=? WHERE task_id=? AND assigned_to=?
        """, (now, task_id, worker_id))
        conn.commit()
        conn.close()

    def complete_task(self, task_id: str, result: str = ""):
        """Mark a task as complete."""
        now = datetime.now(timezone.utc).isoformat()
        conn = _db()
        conn.execute("""
            UPDATE tasks SET status='done', result=?, updated_at=? WHERE task_id=?
        """, (result[:1000], now, task_id))
        conn.commit()
        conn.close()

    def fail_task(self, task_id: str, reason: str = ""):
        """Mark a task as failed."""
        now = datetime.now(timezone.utc).isoformat()
        conn = _db()
        conn.execute("""
            UPDATE tasks SET status='failed', result=?, updated_at=? WHERE task_id=?
        """, (reason[:1000], now, task_id))
        conn.commit()
        conn.close()

    def unclaim_stale(self) -> List[str]:
        """Reclaim tasks with stale heartbeats."""
        cutoff = time.time() - HEARTBEAT_TIMEOUT
        cutoff_dt = datetime.fromtimestamp(cutoff, tz=timezone.utc).isoformat()
        conn = _db()

        stale = conn.execute("""
            SELECT task_id, assigned_to FROM tasks
            WHERE status='in_progress' AND heartbeat_at < ?
        """, (cutoff_dt,)).fetchall()

        for task_id, worker_id in stale:
            conn.execute("""
                UPDATE tasks SET assigned_to=NULL, claimed_at=NULL, heartbeat_at=NULL,
                status='backlog', updated_at=? WHERE task_id=?
            """, (datetime.now(timezone.utc).isoformat(), task_id))
            logger.info("Reclaimed stale task %s from worker %s", task_id, worker_id)

        conn.commit()
        conn.close()
        return [t[0] for t in stale]

    def list_tasks(self, status: str = "") -> List[dict]:
        """List tasks on the board."""
        conn = _db()
        if status:
            rows = conn.execute("""
                SELECT task_id, title, description, status, priority, assigned_to, result, created_at
                FROM tasks WHERE board_id=? AND status=?
                ORDER BY priority DESC, created_at ASC
            """, (self.board_id, status)).fetchall()
        else:
            rows = conn.execute("""
                SELECT task_id, title, description, status, priority, assigned_to, result, created_at
                FROM tasks WHERE board_id=?
                ORDER BY priority DESC, created_at ASC
            """, (self.board_id,)).fetchall()
        conn.close()

        return [
            {
                "task_id": r[0], "title": r[1], "description": r[2],
                "status": r[3], "priority": r[4], "assigned_to": r[5],
                "result": r[6], "created_at": r[7],
            }
            for r in rows
        ]

    def get_stats(self) -> dict:
        """Get board statistics."""
        conn = _db()
        total = conn.execute("SELECT COUNT(*) FROM tasks WHERE board_id=?", (self.board_id,)).fetchone()[0]
        by_status = {}
        for row in conn.execute(
            "SELECT status, COUNT(*) FROM tasks WHERE board_id=? GROUP BY status",
            (self.board_id,)
        ).fetchall():
            by_status[row[0]] = row[1]
        conn.close()
        return {"total": total, "by_status": by_status}
