"""Elitza Role and Persona system.

TOML-based roles and personas.

Roles define:
- capability_mode: what tools are available (all, read-only)
- reasoning_effort: low / medium / high
- max_tokens: response length limit

Personas define:
- description: human-readable description
- instructions: system prompt override / extension

Both are loaded from ~/.elitza/roles/ and ~/.elitza/personas/
"""

import logging
import os
from pathlib import Path
from typing import Dict, Optional

try:
    import tomllib  # Python 3.11+
except ImportError:
    import tomli as tomllib

from elitza.constants import get_elitza_home

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

class Role:
    """A capability profile for the agent."""

    def __init__(
        self,
        name: str,
        description: str = "",
        capability_mode: str = "all",
        reasoning_effort: str = "medium",
        max_tokens: int = 4096,
        fork_context: bool = False,
        tool_allowlist: Optional[list] = None,
        tool_denylist: Optional[list] = None,
    ):
        self.name = name
        self.description = description
        self.capability_mode = capability_mode
        self.reasoning_effort = reasoning_effort
        self.max_tokens = max_tokens
        self.fork_context = fork_context
        self.tool_allowlist = tool_allowlist or []
        self.tool_denylist = tool_denylist or []

    def __repr__(self):
        return (
            f"Role({self.name!r}, mode={self.capability_mode!r}, "
            f"effort={self.reasoning_effort!r})"
        )


class Persona:
    """A system prompt template."""

    def __init__(
        self,
        name: str,
        description: str = "",
        instructions: str = "",
    ):
        self.name = name
        self.description = description
        self.instructions = instructions

    def __repr__(self):
        return f"Persona({self.name!r})"

    def build_system_prompt(self, base_prompt: str = "") -> str:
        """Build the full system prompt with this persona's instructions."""
        parts = []
        if base_prompt:
            parts.append(base_prompt)
        if self.instructions:
            parts.append(self.instructions)
        return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------

def _load_toml_dir(path: str) -> Dict:
    """Load all .toml files from a directory. Returns dict of name -> data."""
    result = {}
    dir_path = Path(path)
    if not dir_path.exists():
        return result

    for toml_file in sorted(dir_path.glob("*.toml")):
        name = toml_file.stem
        try:
            with open(toml_file, "rb") as f:
                data = tomllib.load(f)
            result[name] = data
        except Exception as e:
            logger.warning("Failed to load %s: %s", toml_file, e)

    return result


def load_roles() -> Dict[str, Role]:
    """Load all roles from roles directories (bundled + user)."""
    roles = {}

    # Bundled roles
    bundled = Path(__file__).parent / "bundled" / "roles"
    for name, data in _load_toml_dir(str(bundled)).items():
        roles[name] = Role(
            name=name,
            description=data.get("description", ""),
            capability_mode=data.get("capability_mode", "all"),
            reasoning_effort=data.get("reasoning_effort", "medium"),
            max_tokens=data.get("max_tokens", 4096),
            fork_context=data.get("fork_context", False),
            tool_allowlist=data.get("tool_allowlist", []),
            tool_denylist=data.get("tool_denylist", []),
        )

    # User overrides/extensions
    user_dir = get_elitza_home() / "roles"
    for name, data in _load_toml_dir(str(user_dir)).items():
        roles[name] = Role(
            name=name,
            description=data.get("description", ""),
            capability_mode=data.get("capability_mode", "all"),
            reasoning_effort=data.get("reasoning_effort", "medium"),
            max_tokens=data.get("max_tokens", 4096),
            fork_context=data.get("fork_context", False),
            tool_allowlist=data.get("tool_allowlist", []),
            tool_denylist=data.get("tool_denylist", []),
        )

    return roles


def load_personas() -> Dict[str, Persona]:
    """Load all personas from personas directories (bundled + user)."""
    personas = {}

    # Bundled personas
    bundled = Path(__file__).parent / "bundled" / "personas"
    for name, data in _load_toml_dir(str(bundled)).items():
        personas[name] = Persona(
            name=name,
            description=data.get("description", ""),
            instructions=data.get("instructions", ""),
        )

    # User overrides/extensions
    user_dir = get_elitza_home() / "personas"
    for name, data in _load_toml_dir(str(user_dir)).items():
        personas[name] = Persona(
            name=name,
            description=data.get("description", ""),
            instructions=data.get("instructions", ""),
        )

    return personas


def get_role(name: str) -> Optional[Role]:
    """Get a role by name."""
    return load_roles().get(name)


def get_persona(name: str) -> Optional[Persona]:
    """Get a persona by name."""
    return load_personas().get(name)
