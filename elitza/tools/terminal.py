"""Terminal tool -- execute shell commands."""

import subprocess
import os
import json
import shlex
from typing import Optional

from elitza.tools import registry


def terminal(
    command: str,
    timeout: int = 0,
    workdir: Optional[str] = None,
) -> str:
    """Execute a shell command and return the output.

    Args:
        command: Shell command to execute
        timeout: Maximum seconds to wait (0 = no limit)
        workdir: Working directory (defaults to cwd)
    """
    try:
        env = os.environ.copy()
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout if timeout > 0 else None,
            cwd=workdir or os.getcwd(),
            env=env,
        )
        output = result.stdout
        if result.stderr:
            output += "\n" + result.stderr if output else result.stderr
        if result.returncode != 0:
            output += f"\n[exit code: {result.returncode}]"
        return output.strip()
    except subprocess.TimeoutExpired:
        return f"[timeout after {timeout}s]"
    except Exception as e:
        return f"[error: {e}]"


registry.register(
    name="terminal",
    toolset="terminal",
    schema={
        "name": "terminal",
        "description": "Execute a shell command and return the output. Use for running programs, installing packages, git operations, file management, and any system tasks.",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Shell command to execute",
                },
                "timeout": {
                    "type": "integer",
                    "description": "Maximum seconds to wait (0 = no limit)",
                },
                "workdir": {
                    "type": "string",
                    "description": "Working directory (defaults to current directory)",
                },
            },
            "required": ["command"],
        },
    },
    handler=terminal,
    description="Execute shell commands",
)
