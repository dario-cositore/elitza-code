"""Git Worktree -- per-session worktree isolation.

Creates isolated git worktrees for sessions so experiments
don't pollute the main working directory.
"""

import subprocess
import os
import json
from pathlib import Path

from elitza.tools import registry


def git_worktree_create(branch: str = "", path: str = "") -> str:
    """Create a new git worktree for isolated work.

    Args:
        branch: Branch name (auto-generated if empty)
        path: Path for the worktree (auto-generated if empty)
    """
    try:
        cwd = os.getcwd()

        # Check if we're in a git repo
        result = subprocess.run(
            ["git", "rev-parse", "--git-dir"],
            capture_output=True, text=True, cwd=cwd
        )
        if result.returncode != 0:
            return "[error: Not in a git repository]"

        # Generate branch name if not provided
        if not branch:
            import time
            branch = f"elitza/work-{int(time.time())}"

        # Generate path if not provided
        if not path:
            git_root = subprocess.run(
                ["git", "rev-parse", "--show-toplevel"],
                capture_output=True, text=True, cwd=cwd
            ).stdout.strip()
            worktrees_dir = Path(git_root) / ".worktrees"
            worktrees_dir.mkdir(exist_ok=True)
            path = str(worktrees_dir / branch.replace("/", "-"))

        # Create worktree
        result = subprocess.run(
            ["git", "worktree", "add", "-b", branch, path],
            capture_output=True, text=True, cwd=cwd
        )

        if result.returncode != 0:
            return f"[error: {result.stderr.strip()}]"

        return f"[ok: Created worktree '{branch}' at {path}]"

    except Exception as e:
        return f"[error: {e}]"


def git_worktree_list() -> str:
    """List all git worktrees."""
    try:
        cwd = os.getcwd()
        result = subprocess.run(
            ["git", "worktree", "list", "--porcelain"],
            capture_output=True, text=True, cwd=cwd
        )
        if result.returncode != 0:
            return f"[error: {result.stderr.strip()}]"

        worktrees = []
        current = {}
        for line in result.stdout.strip().split("\n"):
            if line.startswith("worktree "):
                if current:
                    worktrees.append(current)
                current = {"path": line[9:]}
            elif line.startswith("HEAD "):
                current["head"] = line[5:]
            elif line.startswith("branch "):
                current["branch"] = line[7:]
        if current:
            worktrees.append(current)

        if not worktrees:
            return "[no worktrees found]"

        lines = []
        for wt in worktrees:
            branch = wt.get("branch", "detached")
            lines.append(f"  {wt['path']} -> {branch} ({wt.get('head', '?')[:8]})")
        return "\n".join(lines)

    except Exception as e:
        return f"[error: {e}]"


def git_worktree_remove(path: str, force: bool = False) -> str:
    """Remove a git worktree."""
    try:
        cwd = os.getcwd()
        cmd = ["git", "worktree", "remove", path]
        if force:
            cmd.append("--force")

        result = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd)
        if result.returncode != 0:
            return f"[error: {result.stderr.strip()}]"
        return f"[ok: Removed worktree at {path}]"

    except Exception as e:
        return f"[error: {e}]"


registry.register(
    name="git_worktree_create",
    toolset="terminal",
    schema={
        "name": "git_worktree_create",
        "description": "Create an isolated git worktree for safe experimentation without affecting the main working directory.",
        "parameters": {
            "type": "object",
            "properties": {
                "branch": {"type": "string", "description": "Branch name (auto-generated if empty)"},
                "path": {"type": "string", "description": "Path for the worktree (auto-generated if empty)"},
            },
        },
    },
    handler=git_worktree_create,
    description="Create git worktree",
)

registry.register(
    name="git_worktree_list",
    toolset="terminal",
    schema={
        "name": "git_worktree_list",
        "description": "List all git worktrees.",
        "parameters": {"type": "object", "properties": {}},
    },
    handler=git_worktree_list,
    description="List git worktrees",
)

registry.register(
    name="git_worktree_remove",
    toolset="terminal",
    schema={
        "name": "git_worktree_remove",
        "description": "Remove a git worktree.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path of the worktree to remove"},
                "force": {"type": "boolean", "description": "Force removal even if dirty"},
            },
            "required": ["path"],
        },
    },
    handler=git_worktree_remove,
    description="Remove git worktree",
)
