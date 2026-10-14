"""Elitza Config -- Unified configuration loader.

Reads config.yaml and provides typed access to all settings.
Every module imports from here instead of reading files directly.
"""

import os
import yaml
from pathlib import Path
from typing import Any, Dict, List, Optional

from elitza.constants import get_elitza_home

_CONFIG: Optional[Dict] = None
_CONFIG_PATH: Optional[Path] = None


def _find_config() -> Path:
    """Find the config file."""
    global _CONFIG_PATH
    if _CONFIG_PATH:
        return _CONFIG_PATH
    
    # Check environment variable
    env_path = os.environ.get("ELITZA_CONFIG")
    if env_path:
        _CONFIG_PATH = Path(env_path)
        return _CONFIG_PATH
    
    # Default location
    _CONFIG_PATH = get_elitza_home() / "config.yaml"
    return _CONFIG_PATH


def load_config(force: bool = False) -> Dict:
    """Load configuration from YAML file."""
    global _CONFIG
    
    if _CONFIG and not force:
        return _CONFIG
    
    config_path = _find_config()
    
    if config_path.exists():
        with open(config_path, "r") as f:
            _CONFIG = yaml.safe_load(f) or {}
    else:
        _CONFIG = {}
    
    # Apply environment variable overrides
    _apply_env_overrides()
    
    return _CONFIG


def _apply_env_overrides():
    """Override config with environment variables."""
    global _CONFIG
    
    env_map = {
        "ELITZA_MODEL": ("model", "primary"),
        "ELITZA_MAX_ITERATIONS": ("model", "max_iterations"),
        "ELITZA_MAX_TOKENS": ("model", "max_tokens"),
        "ELITZA_TEMPERATURE": ("model", "temperature"),
        "OPENROUTER_API_KEY": ("api", "openrouter_key"),
        "ELITZA_MCP_URL": ("mcp", "servers", 0, "base_url"),
        "ELITZA_LOG_LEVEL": ("logging", "level"),
    }
    
    for env_key, config_path in env_map.items():
        value = os.environ.get(env_key)
        if value is not None:
            _set_nested(_CONFIG, list(config_path), value)


def _set_nested(d: dict, keys: list, value: Any):
    """Set a value in a nested dict."""
    for key in keys[:-1]:
        if key not in d:
            d[key] = {}
        d = d[key]
    
    # Try to convert to appropriate type
    if isinstance(value, str):
        if value.lower() in ("true", "yes", "on"):
            value = True
        elif value.lower() in ("false", "no", "off"):
            value = False
        elif value.isdigit():
            value = int(value)
        else:
            try:
                value = float(value)
            except ValueError:
                pass
    
    d[keys[-1]] = value


def get(key: str, default: Any = None) -> Any:
    """Get a config value using dot notation.
    
    Examples:
        get("model.primary")
        get("brain.max_episodic", 1000)
        get("hooks.enabled", True)
    """
    if _CONFIG is None:
        load_config()
    
    keys = key.split(".")
    value = _CONFIG
    
    for k in keys:
        if isinstance(value, dict):
            value = value.get(k)
        else:
            return default
        
        if value is None:
            return default
    
    return value


def get_section(section: str) -> Dict:
    """Get an entire config section."""
    if _CONFIG is None:
        load_config()
    
    return _CONFIG.get(section, {})


# =============================================================================
# Typed getters for common settings
# =============================================================================

def get_model() -> str:
    """Get the primary model."""
    return get("model.primary", "inclusionai/ling-3.1-flash")


def get_fallback_models() -> List[str]:
    """Get fallback models."""
    return get("model.fallback", [])


def get_max_iterations() -> int:
    """Get max iterations."""
    return int(get("model.max_iterations", 0))


def get_max_tokens() -> int:
    """Get max tokens."""
    return int(get("model.max_tokens", 0))


def get_temperature() -> float:
    """Get temperature."""
    return float(get("model.temperature", 0.7))


def get_human_delay() -> float:
    """Get human delay."""
    return float(get("model.human_delay", 0.0))


def get_identity() -> Dict:
    """Get identity settings."""
    return get_section("identity")


def get_personality() -> Dict:
    """Get personality settings."""
    return get_section("personality")


def get_behavior() -> Dict:
    """Get behavior settings."""
    return get_section("behavior")


def get_tools_config() -> Dict:
    """Get tools configuration."""
    return get_section("tools")


def get_enabled_toolsets() -> List[str]:
    """Get enabled toolsets."""
    return get("tools.enabled_toolsets", [])


def get_disabled_toolsets() -> List[str]:
    """Get disabled toolsets."""
    return get("tools.disabled_toolsets", [])


def get_tool_setting(toolset: str, key: str, default: Any = None) -> Any:
    """Get a specific tool setting."""
    return get(f"tools.settings.{toolset}.{key}", default)


def get_brain_config() -> Dict:
    """Get brain configuration."""
    return get_section("brain")


def get_session_config() -> Dict:
    """Get session configuration."""
    return get_section("sessions")


def get_subagent_config() -> Dict:
    """Get subagent configuration."""
    return get_section("subagents")


def get_subagent_personas() -> Dict:
    """Get subagent persona definitions."""
    return get("subagents.personas", {})


def get_mcp_servers() -> List[Dict]:
    """Get MCP server configurations."""
    return get("mcp.servers", [])


def get_hooks_config() -> Dict:
    """Get hooks configuration."""
    return get_section("hooks")


def get_scheduler_config() -> Dict:
    """Get scheduler configuration."""
    return get_section("scheduler")


def get_roles_config() -> Dict:
    """Get roles configuration."""
    return get_section("roles")


def get_personas_config() -> Dict:
    """Get personas configuration."""
    return get_section("personas")


def get_tui_config() -> Dict:
    """Get TUI configuration."""
    return get_section("tui")


def get_context_config() -> Dict:
    """Get context management configuration."""
    return get_section("context")


def get_logging_config() -> Dict:
    """Get logging configuration."""
    return get_section("logging")


def get_writing_rules() -> Dict:
    """Get writing rules."""
    return get("personality.writing", {})


def is_writing_rule(rule: str) -> bool:
    """Check if a writing rule is enabled."""
    rules = get_writing_rules()
    return rules.get(rule, False)


def get_safety_config() -> Dict:
    """Get safety configuration."""
    return get("behavior.safety", {})


def requires_confirmation(action: str) -> bool:
    """Check if an action requires user confirmation."""
    dangerous = get_safety_config().get("require_confirmation_for", [])
    return any(d in action.lower() for d in dangerous)


# =============================================================================
# Config validation
# =============================================================================

def validate_config() -> List[str]:
    """Validate configuration and return warnings."""
    warnings = []
    
    # Check model
    model = get_model()
    if not model:
        warnings.append("No model configured")
    
    # Check API key
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        warnings.append("OPENROUTER_API_KEY not set")
    
    # Check brain directories
    brain_config = get_brain_config()
    brain_dir = get_elitza_home() / "brain"
    if not brain_dir.exists():
        warnings.append(f"Brain directory missing: {brain_dir}")
    
    # Check hooks directory
    hooks_config = get_hooks_config()
    if hooks_config.get("enabled"):
        hooks_dir = Path(hooks_config.get("directory", "~/.elitza/hooks")).expanduser()
        if not hooks_dir.exists():
            warnings.append(f"Hooks directory missing: {hooks_dir}")
    
    # Check roles/personas directories
    roles_config = get_roles_config()
    roles_dir = Path(roles_config.get("user_dir", "~/.elitza/roles")).expanduser()
    if not roles_dir.exists():
        warnings.append(f"Roles directory missing: {roles_dir}")
    
    personas_config = get_personas_config()
    personas_dir = Path(personas_config.get("user_dir", "~/.elitza/personas")).expanduser()
    if not personas_dir.exists():
        warnings.append(f"Personas directory missing: {personas_dir}")
    
    return warnings


# =============================================================================
# Config summary
# =============================================================================

def config_summary() -> str:
    """Get a human-readable summary of current configuration."""
    lines = ["## Elitza Configuration"]
    
    # Identity
    identity = get_identity()
    lines.append(f"\n### Identity")
    lines.append(f"- Name: {identity.get('name', 'Elitza')}")
    lines.append(f"- Creator: {identity.get('creator', 'Dario Cositore')}")
    lines.append(f"- Version: {identity.get('version', '0.1.0')}")
    
    # Model
    lines.append(f"\n### Model")
    lines.append(f"- Primary: {get_model()}")
    lines.append(f"- Fallbacks: {len(get_fallback_models())}")
    lines.append(f"- Temperature: {get_temperature()}")
    lines.append(f"- Max iterations: {get_max_iterations()}")
    
    # Personality
    personality = get_personality()
    lines.append(f"\n### Personality")
    lines.append(f"- Mood: {personality.get('mood', 'curious')}")
    lines.append(f"- Style: {personality.get('style', 'direct')}")
    lines.append(f"- Opinionated: {personality.get('opinionated', True)}")
    
    # Tools
    lines.append(f"\n### Tools")
    lines.append(f"- Enabled toolsets: {get_enabled_toolsets()}")
    lines.append(f"- Disabled toolsets: {get_disabled_toolsets()}")
    
    # Brain
    brain = get_brain_config()
    lines.append(f"\n### Brain")
    lines.append(f"- Max episodic: {brain.get('max_episodic', 1000)}")
    lines.append(f"- Max semantic: {brain.get('max_semantic', 500)}")
    lines.append(f"- Auto-learning: {brain.get('auto_learning', {}).get('enabled', True)}")
    lines.append(f"- Consolidation: {brain.get('consolidation', {}).get('enabled', True)}")
    
    # Sessions
    sessions = get_session_config()
    lines.append(f"\n### Sessions")
    lines.append(f"- Persistence: {sessions.get('persistence', True)}")
    lines.append(f"- Restore on start: {sessions.get('restore_on_start', True)}")
    
    # MCP
    mcp_servers = get_mcp_servers()
    lines.append(f"\n### MCP")
    lines.append(f"- Servers: {len(mcp_servers)}")
    
    # Warnings
    warnings = validate_config()
    if warnings:
        lines.append(f"\n### ⚠️ Warnings")
        for w in warnings:
            lines.append(f"- {w}")
    
    return "\n".join(lines)


# Auto-load on import
load_config()
