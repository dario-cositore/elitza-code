"""Elitza project context -- loads AGENTS.md, SOUL.md, IDENTITY.md, USER.md from cwd.

Auto-loads project-level instructions from the working directory.
"""

import os
from pathlib import Path
from typing import Optional

from elitza.constants import get_elitza_home

PROJECT_FILES = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "CLAUDE.md", "CURSORRULES", ".cursorrules"]


def find_project_root(start_dir: Optional[str] = None) -> Path:
    """Walk up from cwd to find the project root (contains AGENTS.md or .git).

    Always checks Elitza's home directory first, so she uses her own identity
    files rather than picking up whatever project context exists in cwd.
    """
    elitza_home = get_elitza_home()
    for marker in PROJECT_FILES:
        if (elitza_home / marker).exists():
            return elitza_home

    current = Path(start_dir or os.getcwd()).resolve()
    for parent in [current] + list(current.parents):
        for marker in PROJECT_FILES + [".git"]:
            if (parent / marker).exists():
                return parent
    return current


def load_project_context(cwd: Optional[str] = None) -> str:
    """Load project-level instruction files from cwd or project root."""
    root = find_project_root(cwd)
    parts = []

    for filename in PROJECT_FILES:
        path = root / filename
        if path.exists():
            content = path.read_text().strip()
            if content:
                name = filename.replace(".", " ").title()
                parts.append(f"## {name}\n\n{content}")

    return "\n\n".join(parts) if parts else ""


def get_cwd_info(cwd: Optional[str] = None) -> str:
    """Get a compact description of the working directory."""
    try:
        path = Path(cwd or os.getcwd()).resolve()
        # Check if git repo
        git_dir = None
        for parent in [path] + list(path.parents):
            if (parent / ".git").exists():
                git_dir = parent
                break

        info_parts = [f"Working directory: {path}"]
        if git_dir:
            info_parts.append(f"Git root: {git_dir}")

        # List a few top-level files
        try:
            entries = sorted(path.iterdir())[:10]
            names = [e.name + ("/" if e.is_dir() else "") for e in entries if not e.name.startswith(".")]
            if names:
                info_parts.append(f"Contents: {', '.join(names)}")
        except PermissionError:
            pass

        return ". ".join(info_parts)
    except Exception:
        return ""
