"""File operations -- read, write, patch, search."""

import json
import os
import re
from pathlib import Path
from typing import Optional

from elitza.tools import registry


def read_file(path: str, offset: int = 1, limit: int = 0) -> str:
    """Read a text file with line numbers.

    Args:
        path: File path (absolute or relative)
        offset: Line number to start from (1-indexed)
        limit: Maximum lines to return (0 = all)
    """
    try:
        p = Path(path).expanduser()
        if not p.is_absolute():
            p = Path.cwd() / p
        lines = p.read_text(encoding="utf-8").splitlines()
        total = len(lines)
        start = max(0, offset - 1)
        end = total if limit <= 0 else min(total, start + limit)
        selected = lines[start:end]
        numbered = [f"{start + i + 1}|{line}" for i, line in enumerate(selected)]
        result = "\n".join(numbered)
        if end < total:
            result += f"\n... ({total - end} more lines)"
        return result
    except FileNotFoundError:
        return f"[error: File not found: {path}]"
    except Exception as e:
        return f"[error: {e}]"


def write_file(path: str, content: str) -> str:
    """Write content to a file, creating it if needed.

    Args:
        path: File path (absolute or relative)
        content: Content to write
    """
    try:
        p = Path(path).expanduser()
        if not p.is_absolute():
            p = Path.cwd() / p
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return f"[ok: wrote {len(content)} chars to {p}]"
    except Exception as e:
        return f"[error: {e}]"


def patch_file(path: str, old_string: str, new_string: str) -> str:
    """Find and replace text in a file.

    Args:
        path: File path
        old_string: Text to find
        new_string: Replacement text
    """
    try:
        p = Path(path).expanduser()
        if not p.is_absolute():
            p = Path.cwd() / p
        content = p.read_text(encoding="utf-8")
        if old_string not in content:
            return f"[error: String not found in {path}]"
        content = content.replace(old_string, new_string, 1)
        p.write_text(content, encoding="utf-8")
        return f"[ok: patched {path}]"
    except Exception as e:
        return f"[error: {e}]"


def search_files(
    pattern: str,
    path: str = ".",
    file_glob: Optional[str] = None,
    limit: int = 0,
) -> str:
    """Search file contents using regex.

    Args:
        pattern: Regex pattern to search for
        path: Directory to search in
        file_glob: Optional glob filter (e.g. '*.py')
        limit: Maximum results (0 = unlimited)
    """
    try:
        base = Path(path).expanduser()
        if not base.is_absolute():
            base = Path.cwd() / base

        results = []
        glob_pattern = file_glob or "*"

        for fpath in sorted(base.rglob(glob_pattern)):
            if not fpath.is_file():
                continue
            try:
                text = fpath.read_text(encoding="utf-8")
            except (UnicodeDecodeError, PermissionError):
                continue
            for i, line in enumerate(text.splitlines(), 1):
                if re.search(pattern, line):
                    rel = fpath.relative_to(base) if fpath.is_relative_to(base) else fpath
                    results.append(f"{rel}:{i}|{line.strip()}")
                    if limit > 0 and len(results) >= limit:
                        break
            if limit > 0 and len(results) >= limit:
                break

        if not results:
            return "[no matches]"
        return "\n".join(results)
    except Exception as e:
        return f"[error: {e}]"


registry.register(
    name="read_file",
    toolset="file",
    schema={
        "name": "read_file",
        "description": "Read a text file with line numbers. Use offset and limit for large files.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path"},
                "offset": {"type": "integer", "description": "Start line (1-indexed, default 1)"},
                "limit": {"type": "integer", "description": "Max lines (0 = all, default 0)"},
            },
            "required": ["path"],
        },
    },
    handler=read_file,
    description="Read files",
)

registry.register(
    name="write_file",
    toolset="file",
    schema={
        "name": "write_file",
        "description": "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Creates parent directories automatically.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path"},
                "content": {"type": "string", "description": "Content to write"},
            },
            "required": ["path", "content"],
        },
    },
    handler=write_file,
    description="Write files",
)

registry.register(
    name="patch",
    toolset="file",
    schema={
        "name": "patch",
        "description": "Find and replace text in a file. The old_string must be unique in the file.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path"},
                "old_string": {"type": "string", "description": "Text to find"},
                "new_string": {"type": "string", "description": "Replacement text"},
            },
            "required": ["path", "old_string", "new_string"],
        },
    },
    handler=patch_file,
    description="Patch files",
)

registry.register(
    name="search_files",
    toolset="file",
    schema={
        "name": "search_files",
        "description": "Search file contents using regex. Returns matching lines with file paths and line numbers.",
        "parameters": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Regex pattern"},
                "path": {"type": "string", "description": "Directory to search (default: current)"},
                "file_glob": {"type": "string", "description": "File filter glob (e.g. '*.py')"},
                "limit": {"type": "integer", "description": "Max results (0 = unlimited, default 0)"},
            },
            "required": ["pattern"],
        },
    },
    handler=search_files,
    description="Search files",
)
