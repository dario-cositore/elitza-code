"""Elitza Doctor -- Self-diagnostic and self-healing system.

This module provides:
1. Health checks for all subsystems
2. Automatic diagnosis of issues
3. Self-repair capabilities
4. Health monitoring over time

The doctor can be called by Elitza herself or by the user
to check and fix issues automatically.
"""

import json
import logging
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from elitza.constants import get_elitza_home

logger = logging.getLogger(__name__)

BRAIN = get_elitza_home() / "brain"
HEALTH_DB = BRAIN / "health.db"


# ===========================================================================
# Health Database
# ===========================================================================

def _health_db() -> sqlite3.Connection:
    BRAIN.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(HEALTH_DB))
    conn.execute("PRAGMA journal_mode=WAL")
    
    conn.execute("""
        CREATE TABLE IF NOT EXISTS health_checks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            component TEXT,
            status TEXT,
            message TEXT,
            details TEXT,
            checked_at TEXT
        )
    """)
    
    conn.execute("""
        CREATE TABLE IF NOT EXISTS repairs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            component TEXT,
            issue TEXT,
            fix_applied TEXT,
            success INTEGER,
            repaired_at TEXT
        )
    """)
    
    conn.commit()
    return conn


# ===========================================================================
# Health Checks
# ===========================================================================

def check_all() -> Dict:
    """Run all health checks and return results."""
    results = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "overall": "healthy",
        "checks": [],
        "issues": [],
        "repairs_available": [],
    }
    
    checks = [
        ("databases", check_databases),
        ("brain", check_brain),
        ("config", check_config),
        ("tools", check_tools),
        ("plugins", check_plugins),
        ("hooks", check_hooks),
        ("sessions", check_sessions),
        ("disk_space", check_disk_space),
        ("permissions", check_permissions),
    ]
    
    for name, check_fn in checks:
        try:
            result = check_fn()
            results["checks"].append({
                "component": name,
                "status": result["status"],
                "message": result["message"],
            })
            if result["status"] == "error":
                results["overall"] = "unhealthy"
                results["issues"].append({
                    "component": name,
                    "message": result["message"],
                    "fix": result.get("fix", ""),
                })
            elif result["status"] == "warning":
                if results["overall"] != "unhealthy":
                    results["overall"] = "degraded"
                results["issues"].append({
                    "component": name,
                    "message": result["message"],
                    "fix": result.get("fix", ""),
                })
        except Exception as e:
            results["checks"].append({
                "component": name,
                "status": "error",
                "message": f"Check failed: {e}",
            })
            results["overall"] = "unhealthy"
    
    # Save check results
    _save_check_results(results)
    
    return results


def check_databases() -> Dict:
    """Check all SQLite databases for corruption."""
    issues = []
    
    db_files = [
        BRAIN / "soul.db",
        BRAIN / "soul_v2.db",
        BRAIN / "persistence.db",
        BRAIN / "conversations.db",
        get_elitza_home() / "sessions.db",
    ]
    
    for db_path in db_files:
        if not db_path.exists():
            continue
        
        try:
            conn = sqlite3.connect(str(db_path))
            # Quick integrity check
            result = conn.execute("PRAGMA quick_check").fetchone()
            if result[0] != "ok":
                issues.append(f"{db_path.name}: integrity check failed")
            conn.close()
        except Exception as e:
            issues.append(f"{db_path.name}: {e}")
    
    if issues:
        return {
            "status": "error",
            "message": f"Database issues: {'; '.join(issues)}",
            "fix": "Run doctor_repair to fix database issues",
        }
    
    return {"status": "ok", "message": "All databases healthy"}


def check_brain() -> Dict:
    """Check brain subsystem health."""
    issues = []
    
    # Check soul.db
    soul_db = BRAIN / "soul.db"
    if soul_db.exists():
        try:
            conn = sqlite3.connect(str(soul_db))
            count = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
            if count == 0:
                issues.append("No memories in soul.db")
            conn.close()
        except Exception as e:
            issues.append(f"soul.db error: {e}")
    
    # Check soul_v2.db
    soul_v2 = BRAIN / "soul_v2.db"
    if soul_v2.exists():
        try:
            conn = sqlite3.connect(str(soul_v2))
            count = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
            if count == 0:
                issues.append("No memories in soul_v2.db")
            conn.close()
        except Exception as e:
            issues.append(f"soul_v2.db error: {e}")
    
    # Check procedural skills
    proc_dir = BRAIN / "procedural"
    if proc_dir.exists():
        skills = list(proc_dir.glob("*.md"))
        if len(skills) == 0:
            issues.append("No procedural skills generated yet")
    
    if issues:
        return {
            "status": "warning",
            "message": f"Brain issues: {'; '.join(issues)}",
        }
    
    return {"status": "ok", "message": "Brain healthy"}


def check_config() -> Dict:
    """Check configuration health."""
    from elitza.config import validate_config
    
    warnings = validate_config()
    
    if warnings:
        return {
            "status": "warning",
            "message": f"Config warnings: {'; '.join(warnings[:3])}",
            "fix": "Create missing directories or update config.yaml",
        }
    
    return {"status": "ok", "message": "Configuration valid"}


def check_tools() -> Dict:
    """Check tool registry health."""
    try:
        from elitza.tools import registry
        tools = registry.get_all_tools()
        
        if len(tools) == 0:
            return {"status": "error", "message": "No tools registered"}
        
        # Check for tools with missing handlers
        broken = []
        for name, entry in tools.items():
            if not callable(entry.handler):
                broken.append(name)
        
        if broken:
            return {
                "status": "error",
                "message": f"Broken tools: {', '.join(broken)}",
            }
        
        return {"status": "ok", "message": f"{len(tools)} tools registered"}
    
    except Exception as e:
        return {"status": "error", "message": f"Tool check failed: {e}"}


def check_plugins() -> Dict:
    """Check plugin system health."""
    plugins_dir = get_elitza_home() / "plugins"
    
    if not plugins_dir.exists():
        return {"status": "ok", "message": "No plugins directory (normal)"}
    
    plugins = list(plugins_dir.iterdir())
    plugin_dirs = [p for p in plugins if p.is_dir()]
    
    # Check each plugin has manifest
    issues = []
    for plugin_dir in plugin_dirs:
        manifest = plugin_dir / "elitza-plugin.json"
        if not manifest.exists():
            issues.append(f"{plugin_dir.name}: missing manifest")
    
    if issues:
        return {
            "status": "warning",
            "message": f"Plugin issues: {'; '.join(issues[:3])}",
        }
    
    return {"status": "ok", "message": f"{len(plugin_dirs)} plugins installed"}


def check_hooks() -> Dict:
    """Check hooks system health."""
    from elitza.config import get
    
    hooks_config = get("hooks", {})
    if not hooks_config.get("enabled", True):
        return {"status": "ok", "message": "Hooks disabled"}
    
    hooks_dir = Path(hooks_config.get("directory", "~/.elitza/hooks")).expanduser()
    
    if not hooks_dir.exists():
        return {
            "status": "warning",
            "message": "Hooks directory missing",
            "fix": f"mkdir -p {hooks_dir}",
        }
    
    hook_count = sum(1 for _ in hooks_dir.iterdir()) if hooks_dir.exists() else 0
    return {"status": "ok", "message": f"{hook_count} hooks configured"}


def check_sessions() -> Dict:
    """Check session persistence health."""
    try:
        from elitza.persistence import get_persistence_stats
        stats = get_persistence_stats()
        
        return {
            "status": "ok",
            "message": f"{stats['total_messages']} messages, {stats['total_sessions']} sessions stored",
        }
    
    except Exception as e:
        return {"status": "error", "message": f"Session check failed: {e}"}


def check_disk_space() -> Dict:
    """Check available disk space."""
    try:
        stat = os.statvfs(str(get_elitza_home()))
        free_gb = (stat.f_bavail * stat.f_frsize) / (1024 ** 3)
        
        if free_gb < 1:
            return {
                "status": "error",
                "message": f"Low disk space: {free_gb:.1f} GB free",
                "fix": "Clean up old logs or databases",
            }
        elif free_gb < 5:
            return {
                "status": "warning",
                "message": f"Disk space getting low: {free_gb:.1f} GB free",
            }
        
        return {"status": "ok", "message": f"{free_gb:.1f} GB free"}
    
    except Exception as e:
        return {"status": "warning", "message": f"Could not check disk space: {e}"}


def check_permissions() -> Dict:
    """Check file permissions."""
    issues = []
    
    # Check key directories are writable
    dirs_to_check = [
        BRAIN,
        get_elitza_home() / "logs",
        get_elitza_home() / "brain" / "procedural",
    ]
    
    for d in dirs_to_check:
        if d.exists() and not os.access(str(d), os.W_OK):
            issues.append(f"{d.name}: not writable")
    
    if issues:
        return {
            "status": "error",
            "message": f"Permission issues: {'; '.join(issues)}",
        }
    
    return {"status": "ok", "message": "Permissions OK"}


# ===========================================================================
# Self-Repair
# ===========================================================================

def repair_all() -> Dict:
    """Attempt to repair all detected issues."""
    results = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "repairs": [],
        "success_count": 0,
        "fail_count": 0,
    }
    
    repairs = [
        ("databases", repair_databases),
        ("config", repair_config),
        ("brain", repair_brain),
        ("hooks", repair_hooks),
        ("logs", repair_logs),
    ]
    
    for name, repair_fn in repairs:
        try:
            result = repair_fn()
            results["repairs"].append({
                "component": name,
                "success": result["success"],
                "message": result["message"],
                "fixes_applied": result.get("fixes", []),
            })
            if result["success"]:
                results["success_count"] += 1
            else:
                results["fail_count"] += 1
        except Exception as e:
            results["repairs"].append({
                "component": name,
                "success": False,
                "message": f"Repair failed: {e}",
            })
            results["fail_count"] += 1
    
    return results


def repair_databases() -> Dict:
    """Repair database issues."""
    fixes = []
    
    db_files = [
        BRAIN / "soul.db",
        BRAIN / "soul_v2.db",
        BRAIN / "persistence.db",
        BRAIN / "conversations.db",
    ]
    
    for db_path in db_files:
        if not db_path.exists():
            continue
        
        try:
            conn = sqlite3.connect(str(db_path))
            
            # Run integrity check
            result = conn.execute("PRAGMA integrity_check").fetchone()
            
            if result[0] != "ok":
                # Attempt repair by rebuilding
                conn.execute("VACUUM")
                fixes.append(f"{db_path.name}: vacuumed")
            
            # Rebuild FTS indexes if they exist
            try:
                tables = conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'"
                ).fetchall()
                for (table,) in tables:
                    conn.execute(f"INSERT INTO {table}({table}) VALUES('rebuild')")
                    fixes.append(f"{db_path.name}: rebuilt {table}")
            except Exception:
                pass
            
            conn.close()
        
        except Exception as e:
            return {"success": False, "message": f"Failed to repair {db_path.name}: {e}"}
    
    if fixes:
        return {"success": True, "message": "Databases repaired", "fixes": fixes}
    return {"success": True, "message": "Databases OK, no repairs needed"}


def repair_config() -> Dict:
    """Create missing config directories."""
    fixes = []
    
    dirs_to_create = [
        get_elitza_home() / "hooks",
        get_elitza_home() / "roles",
        get_elitza_home() / "personas",
        get_elitza_home() / "logs",
        get_elitza_home() / "plugins",
        BRAIN / "procedural",
        BRAIN / "episodic",
        BRAIN / "semantic",
        BRAIN / "conversations",
    ]
    
    for d in dirs_to_create:
        if not d.exists():
            d.mkdir(parents=True, exist_ok=True)
            fixes.append(f"Created {d.name}/")
    
    if fixes:
        return {"success": True, "message": "Config directories created", "fixes": fixes}
    return {"success": True, "message": "All directories exist"}


def repair_brain() -> Dict:
    """Repair brain subsystem."""
    fixes = []
    
    # Ensure brain tables exist
    try:
        from elitza.brain_v2 import _db
        conn = _db()
        
        # Check memories table
        count = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
        if count == 0:
            fixes.append("Memories table empty (will populate on next interaction)")
        
        conn.close()
    except Exception as e:
        return {"success": False, "message": f"Brain repair failed: {e}"}
    
    if fixes:
        return {"success": True, "message": "Brain checked", "fixes": fixes}
    return {"success": True, "message": "Brain OK"}


def repair_hooks() -> Dict:
    """Create hooks directory structure."""
    fixes = []
    
    hooks_dir = get_elitza_home() / "hooks"
    events = [
        "pre_prompt", "post_response", "pre_tool_call", "post_tool_call",
        "pre_compact", "post_compact", "session_start", "session_end",
    ]
    
    for event in events:
        event_dir = hooks_dir / event
        if not event_dir.exists():
            event_dir.mkdir(parents=True, exist_ok=True)
            fixes.append(f"Created hooks/{event}/")
    
    if fixes:
        return {"success": True, "message": "Hook directories created", "fixes": fixes}
    return {"success": True, "message": "Hook directories exist"}


def repair_logs() -> Dict:
    """Clean up old log files."""
    fixes = []
    
    logs_dir = get_elitza_home() / "logs"
    if not logs_dir.exists():
        return {"success": True, "message": "No logs directory"}
    
    # Remove logs older than 30 days
    import time
    now = time.time()
    cutoff = now - (30 * 24 * 3600)
    
    for log_file in logs_dir.glob("*.log"):
        if log_file.stat().st_mtime < cutoff:
            log_file.unlink()
            fixes.append(f"Removed old log: {log_file.name}")
    
    if fixes:
        return {"success": True, "message": "Old logs cleaned", "fixes": fixes}
    return {"success": True, "message": "Logs OK"}


# ===========================================================================
# Health History
# ===========================================================================

def _save_check_results(results: Dict):
    """Save check results to health database."""
    try:
        conn = _health_db()
        now = datetime.now(timezone.utc).isoformat()
        
        for check in results["checks"]:
            conn.execute("""
                INSERT INTO health_checks (component, status, message, checked_at)
                VALUES (?, ?, ?, ?)
            """, (check["component"], check["status"], check["message"], now))
        
        conn.commit()
        conn.close()
    except Exception:
        pass


def get_health_history(days: int = 7) -> List[Dict]:
    """Get health check history."""
    conn = _health_db()
    cutoff = datetime.now(timezone.utc).isoformat()[:10]
    
    rows = conn.execute("""
        SELECT component, status, message, checked_at
        FROM health_checks
        WHERE checked_at >= date('now', ?)
        ORDER BY checked_at DESC
    """, (f"-{days} days",)).fetchall()
    
    conn.close()
    
    return [
        {"component": r[0], "status": r[1], "message": r[2], "checked_at": r[3]}
        for r in rows
    ]


def get_repair_history() -> List[Dict]:
    """Get repair history."""
    conn = _health_db()
    
    rows = conn.execute("""
        SELECT component, issue, fix_applied, success, repaired_at
        FROM repairs
        ORDER BY repaired_at DESC
        LIMIT 20
    """).fetchall()
    
    conn.close()
    
    return [
        {
            "component": r[0], "issue": r[1], "fix_applied": r[2],
            "success": bool(r[3]), "repaired_at": r[4]
        }
        for r in rows
    ]


# ===========================================================================
# Summary
# ===========================================================================

def doctor_summary() -> str:
    """Get a summary of system health."""
    results = check_all()
    
    lines = [f"## Elitza Doctor Report"]
    lines.append(f"**Overall Status**: {results['overall'].upper()}")
    lines.append(f"**Checked at**: {results['timestamp'][:19]}")
    lines.append("")
    
    lines.append("### Health Checks")
    for check in results["checks"]:
        icon = "✓" if check["status"] == "ok" else "⚠" if check["status"] == "warning" else "✗"
        lines.append(f"- {icon} **{check['component']}**: {check['message']}")
    
    if results["issues"]:
        lines.append("")
        lines.append("### Issues Found")
        for issue in results["issues"]:
            lines.append(f"- **{issue['component']}**: {issue['message']}")
            if issue.get("fix"):
                lines.append(f"  - Fix: {issue['fix']}")
    
    return "\n".join(lines)
