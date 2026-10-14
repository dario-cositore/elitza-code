"""Elitza system services -- memory, skills, sessions.

Covers:
- Notes: daily notes, MEMORY.md, session search
- Skills: SKILL.md, roles/personas, todo scaffolds
- Sessions: auth profiles, multi-agent, session persistence
"""

import json
import logging
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from elitza.constants import get_elitza_home

logger = logging.getLogger(__name__)

MEMORY_DIR = "memory"
MEMORY_FILE = "MEMORY.md"
SESSIONS_DIR = "sessions"
AUTH_FILE = "auth-profiles.json"


# ===========================================================================
# Memory
# ===========================================================================

def get_memory_dir() -> Path:
    return get_elitza_home() / MEMORY_DIR


def get_memory_file() -> Path:
    return get_elitza_home() / MEMORY_FILE


def get_daily_note_path(date: Optional[datetime] = None) -> Path:
    d = date or datetime.now(timezone.utc)
    return get_memory_dir() / f"{d.strftime('%Y-%m-%d')}.md"


def append_daily_note(content: str):
    """Append a note to today's daily note file."""
    path = get_daily_note_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%H:%M UTC")
    with open(path, "a") as f:
        f.write(f"\n## {ts}\n\n{content}\n")


def load_daily_note(date: Optional[datetime] = None) -> str:
    path = get_daily_note_path(date)
    if path.exists():
        return path.read_text()
    return ""


def load_memory() -> str:
    """Load MEMORY.md if it exists."""
    path = get_memory_file()
    if path.exists():
        return path.read_text()
    return ""


def save_memory(content: str):
    """Save to MEMORY.md."""
    get_elitza_home().mkdir(parents=True, exist_ok=True)
    get_memory_file().write_text(content)


def search_memory(query: str, limit: int = 5) -> List[str]:
    """Search daily notes for relevant content."""
    results = []
    memory_dir = get_memory_dir()
    if not memory_dir.exists():
        return results
    query_lower = query.lower()
    for note_path in sorted(memory_dir.glob("*.md"), reverse=True):
        content = note_path.read_text()
        if query_lower in content.lower():
            # Extract relevant lines
            lines = content.split("\n")
            relevant = [l for l in lines if query_lower in l.lower()][:3]
            results.append(f"[{note_path.stem}] " + " | ".join(relevant))
            if len(results) >= limit:
                break
    return results


# ===========================================================================
# Skills
# ===========================================================================

def get_skills_dirs() -> List[Path]:
    """Return all skill search paths, bundled first then user."""
    dirs = []
    # Bundled
    bundled = Path(__file__).parent / "bundled" / "skills"
    if bundled.exists():
        dirs.append(bundled)
    # User
    user = get_elitza_home() / "skills"
    if user.exists():
        dirs.append(user)
    return dirs


def discover_skills() -> Dict[str, Path]:
    """Find all available skills. Returns name -> SKILL.md path."""
    skills = {}
    for skills_dir in get_skills_dirs():
        for skill_dir in sorted(skills_dir.iterdir()):
            if skill_dir.is_dir():
                skill_md = skill_dir / "SKILL.md"
                if skill_md.exists():
                    skills[skill_dir.name] = skill_md
    return skills


def load_skill(name: str) -> Optional[str]:
    """Load a skill's SKILL.md content."""
    skills = discover_skills()
    if name in skills:
        return skills[name].read_text()
    return None


def parse_skill_frontmatter(content: str) -> Dict[str, str]:
    """Parse YAML frontmatter from a SKILL.md file."""
    frontmatter = {}
    match = re.match(r"^---\s*\n(.*?)\n---", content, re.DOTALL)
    if match:
        for line in match.group(1).split("\n"):
            if ":" in line:
                key, _, value = line.partition(":")
                frontmatter[key.strip()] = value.strip().strip('"').strip("'")
    return frontmatter


def build_skills_summary() -> str:
    """Build a summary of available skills for the system prompt."""
    skills = discover_skills()
    if not skills:
        return ""

    lines = ["\n## Available Skills"]
    for name, path in sorted(skills.items()):
        content = path.read_text()
        fm = parse_skill_frontmatter(content)
        desc = fm.get("description", "No description")
        lines.append(f"- **{name}**: {desc}")

    return "\n".join(lines)


# ===========================================================================
# Sessions
# ===========================================================================

def get_sessions_dir() -> Path:
    return get_elitza_home() / SESSIONS_DIR


def get_session_path(session_id: str) -> Path:
    return get_sessions_dir() / f"{session_id}.jsonl"


def save_session_turn(session_id: str, role: str, content: str, metadata: dict = None):
    """Append a turn to the session log."""
    path = get_session_path(session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "role": role,
        "content": content,
    }
    if metadata:
        entry["metadata"] = metadata
    with open(path, "a") as f:
        f.write(json.dumps(entry) + "\n")


def load_session(session_id: str) -> List[Dict]:
    """Load a session's conversation history."""
    path = get_session_path(session_id)
    if not path.exists():
        return []
    turns = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    turns.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return turns


def list_sessions(limit: int = 10) -> List[Dict]:
    """List recent sessions."""
    sessions_dir = get_sessions_dir()
    if not sessions_dir.exists():
        return []
    results: List[Dict[str, Any]] = []
    for path in sorted(sessions_dir.glob("*.jsonl"), reverse=True):
        first_line = None
        last_line = None
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line:
                    if first_line is None:
                        first_line = json.loads(line)
                    last_line = json.loads(line)
        if first_line:
            results.append({
                "session_id": path.stem,
                "started": first_line.get("timestamp", "?"),
                "last_activity": last_line.get("timestamp", "?"),
                "turns": sum(1 for _ in open(path)),
            })
        if len(results) >= limit:
            break
    return results


# ===========================================================================
# Auth Profiles
# ===========================================================================

def get_auth_path() -> Path:
    return get_elitza_home() / AUTH_FILE


def load_auth_profiles() -> Dict:
    """Load auth profiles (encrypted credentials per service)."""
    path = get_auth_path()
    if path.exists():
        try:
            data = json.loads(path.read_text())
            return data.get("profiles", {})
        except (json.JSONDecodeError, IOError):
            pass
    return {}


def save_auth_profile(service: str, credentials: Dict[str, str]):
    """Save credentials for a service."""
    data: Dict[str, Any] = {"version": 1, "profiles": {}}
    path = get_auth_path()
    if path.exists():
        try:
            data = json.loads(path.read_text())
        except (json.JSONDecodeError, IOError):
            pass
    profiles = data.get("profiles", {})
    if profiles is None:
        profiles = {}
    profiles[service] = credentials
    data["profiles"] = profiles
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2))


def get_auth_profile(service: str) -> Optional[Dict[str, str]]:
    """Get credentials for a service."""
    profiles = load_auth_profiles()
    return profiles.get(service)


def list_auth_services() -> List[str]:
    """List services with stored credentials."""
    return list(load_auth_profiles().keys())


# ===========================================================================
# System prompt builder (combines memory + skills + role + persona)
# ===========================================================================

def build_system_context(role: str = "", persona: str = "", extra: str = "") -> str:
    """Build the system context from memory, skills, role, and persona."""
    parts = []

    # Memory
    memory = load_memory()
    if memory:
        parts.append(f"## Long-term Memory\n\n{memory}")

    # Daily note (today's context)
    daily = load_daily_note()
    if daily:
        parts.append(f"## Today's Notes\n\n{daily}")

    # Skills summary
    skills_summary = build_skills_summary()
    if skills_summary:
        parts.append(skills_summary)

    # Extra (role/persona injected by caller)
    if extra:
        parts.append(extra)

    return "\n\n".join(parts)
