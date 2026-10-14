"""Elitza plugins, federation, and hooks.

Plugins: extend Elitza with external tool/skill packages from git repos.
Federation: call remote MCP servers over the federation protocol.
Hooks: lifecycle scripts that run at specific events (pre-commit, post-tool, etc.).
"""

import json
import logging
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from elitza.constants import get_elitza_home
from elitza.tools import registry

logger = logging.getLogger(__name__)

PLUGINS_DIR = get_elitza_home() / "plugins"
HOOKS_DIR = get_elitza_home() / "hooks"


# ===========================================================================
# Plugins
# ===========================================================================

def discover_plugins() -> Dict[str, Path]:
    """Find all installed plugins. Returns name -> plugin_dir."""
    plugins = {}
    if not PLUGINS_DIR.exists():
        return plugins
    for d in sorted(PLUGINS_DIR.iterdir()):
        if d.is_dir() and (d / "elitza-plugin.json").exists():
            plugins[d.name] = d
    return plugins


def install_plugin(source: str, trust: bool = False) -> str:
    """Install a plugin from a git URL or local path.

    Args:
        source: git URL or local path
        trust: skip confirmation prompt

    Returns:
        Status message
    """
    PLUGINS_DIR.mkdir(parents=True, exist_ok=True)

    # Extract plugin name from source
    if source.endswith(".git"):
        name = source.rstrip("/").split("/")[-1].replace(".git", "")
    elif "@" in source:
        name = source.split("@")[0].split("/")[-1]
    else:
        name = source.rstrip("/").split("/")[-1]

    # If source looks like a local path, use it directly
    source_path = Path(source)
    if source_path.exists() and source_path.is_dir():
        target = PLUGINS_DIR / name
        if target.exists():
            return f"Plugin '{name}' already installed"
        # Create symlink or copy
        try:
            os.symlink(source_path.resolve(), target)
            _load_plugin(name, target)
            return f"Plugin '{name}' installed from local path"
        except OSError:
            import shutil
            shutil.copytree(source_path, target)
            _load_plugin(name, target)
            return f"Plugin '{name}' installed from local path (copied)"

    # Git clone
    target = PLUGINS_DIR / name
    if target.exists():
        return f"Plugin '{name}' already installed (at {target})"

    try:
        result = subprocess.run(
            ["git", "clone", source, str(target)],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            return f"Failed to clone plugin: {result.stderr[:200]}"
        _load_plugin(name, target)
        return f"Plugin '{name}' installed from {source}"
    except FileNotFoundError:
        return "Error: git is not installed"


def uninstall_plugin(name: str, keep_data: bool = False) -> str:
    """Uninstall a plugin by name."""
    target = PLUGINS_DIR / name
    if not target.exists():
        return f"Plugin '{name}' not found"

    # Unload plugin tools
    try:
        manifest = json.loads((target / "elitza-plugin.json").read_text())
        for tool_name in manifest.get("tools", []):
            if registry.get_tool(tool_name):
                registry._tools.pop(tool_name, None)
    except Exception:
        pass

    if target.is_symlink():
        target.unlink()
    else:
        import shutil
        shutil.rmtree(target)

    return f"Plugin '{name}' uninstalled"


def _load_plugin(name: str, plugin_dir: Path):
    """Load a plugin's tools and skills into Elitza."""
    manifest_path = plugin_dir / "elitza-plugin.json"
    if not manifest_path.exists():
        return

    try:
        manifest = json.loads(manifest_path.read_text())
    except (json.JSONDecodeError, IOError) as e:
        logger.warning("Failed to load plugin manifest for %s: %s", name, e)
        return

    # Load tools
    tools_dir = plugin_dir / "tools"
    if tools_dir.exists():
        for tool_file in tools_dir.glob("*.py"):
            if tool_file.name.startswith("_"):
                continue
            try:
                import importlib.util
                spec = importlib.util.spec_from_file_location(
                    f"elitza_plugin_{name}_{tool_file.stem}", str(tool_file)
                )
                if spec and spec.loader:
                    mod = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(mod)
            except Exception as e:
                logger.warning("Failed to load plugin tool %s: %s", tool_file, e)

    # Load skills
    skills_dir = plugin_dir / "skills"
    if skills_dir.exists():
        user_skills = get_elitza_home() / "skills"
        for skill_dir in skills_dir.iterdir():
            if skill_dir.is_dir():
                target = user_skills / skill_dir.name
                if not target.exists():
                    try:
                        os.symlink(skill_dir.resolve(), target)
                    except OSError:
                        import shutil
                        shutil.copytree(skill_dir, target)

    logger.info("Plugin '%s' loaded: %d tools", name, len(manifest.get("tools", [])))


def load_all_plugins():
    """Load all installed plugins on startup."""
    for name, plugin_dir in discover_plugins().items():
        _load_plugin(name, plugin_dir)


# ===========================================================================
# Federation (remote MCP)
# ===========================================================================

def federation_discover() -> List[Dict]:
    """Discover available federation endpoints."""
    import urllib.request
    url = "https://mcp.dariocositore.com/federation/discover"
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            return data.get("endpoints", data.get("servers", []))
    except Exception as e:
        logger.error("Federation discover failed: %s", e)
        return []


def federation_call(server_url: str, method: str, params: dict = None) -> Dict:
    """Call a federated MCP server endpoint."""
    import urllib.request
    payload = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params or {},
    }).encode()

    try:
        req = urllib.request.Request(
            server_url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        logger.error("Federation call failed: %s", e)
        return {"error": str(e)}


# ===========================================================================
# Hooks (lifecycle scripts)
# ===========================================================================

# Hook events
HOOK_EVENTS = [
    "pre_prompt",      # Before sending prompt to model
    "post_response",   # After receiving response from model
    "pre_tool_call",   # Before executing a tool
    "post_tool_call",  # After executing a tool
    "pre_compact",     # Before auto-compaction
    "post_compact",    # After auto-compaction
    "session_start",   # When session starts
    "session_end",     # When session ends
]


def discover_hooks() -> Dict[str, List[Path]]:
    """Discover hooks organized by event type."""
    hooks: Dict[str, List[Path]] = {}
    if not HOOKS_DIR.exists():
        return hooks

    for event in HOOK_EVENTS:
        event_dir = HOOKS_DIR / event
        if event_dir.exists():
            scripts = sorted(event_dir.glob("*"))
            scripts = [s for s in scripts if s.is_file() and os.access(s, os.X_OK)]
            if scripts:
                hooks[event] = scripts
    return hooks


def run_hooks(event: str, context: dict = None) -> List[Dict]:
    """Run all hooks for a given event.

    Args:
        event: Hook event name
        context: Dict with context data (session_id, message, tool_name, etc.)

    Returns:
        List of hook results: [{name, exit_code, stdout, stderr}]
    """
    results = []
    hooks = discover_hooks().get(event, [])

    for hook_script in hooks:
        try:
            env = os.environ.copy()
            if context:
                for key, value in context.items():
                    env[f"ELITZA_HOOK_{key.upper()}"] = str(value)

            result = subprocess.run(
                [str(hook_script)],
                capture_output=True, text=True,
                env=env,
                cwd=str(get_elitza_home()),
            )
            results.append({
                "name": hook_script.name,
                "exit_code": result.returncode,
                "stdout": result.stdout.strip(),
                "stderr": result.stderr.strip(),
            })
            if result.returncode != 0:
                logger.warning("Hook %s failed (exit %d): %s",
                             hook_script.name, result.returncode, result.stderr[:200])
        except Exception as e:
            results.append({"name": hook_script.name, "exit_code": -1, "stdout": "", "stderr": str(e)})

    return results


# ===========================================================================
# Plugin tool registration
# ===========================================================================

def register_plugin_tools():
    """Register plugin management tools."""

    def list_plugins() -> str:
        plugins = discover_plugins()
        if not plugins:
            return json.dumps({"plugins": [], "message": "No plugins installed"})
        result = []
        for name, path in sorted(plugins.items()):
            manifest_path = path / "elitza-plugin.json"
            desc = ""
            if manifest_path.exists():
                try:
                    desc = json.loads(manifest_path.read_text()).get("description", "")
                except Exception:
                    pass
            result.append({"name": name, "description": desc, "path": str(path)})
        return json.dumps({"plugins": result})

    def plugin_install(source: str, trust: bool = False) -> str:
        return install_plugin(source, trust)

    def plugin_uninstall(name: str) -> str:
        return uninstall_plugin(name)

    registry.register(
        name="plugin_list",
        toolset="core",
        schema={
            "name": "plugin_list",
            "description": "List all installed plugins.",
            "parameters": {"type": "object", "properties": {}},
        },
        handler=list_plugins,
        description="List installed plugins",
    )

    registry.register(
        name="plugin_install",
        toolset="core",
        schema={
            "name": "plugin_install",
            "description": "Install a plugin from a git URL or local path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "source": {"type": "string", "description": "Git URL or local path"},
                    "trust": {"type": "boolean", "description": "Skip confirmation", "default": False},
                },
                "required": ["source"],
            },
        },
        handler=plugin_install,
        description="Install a plugin from git URL or local path",
    )

    registry.register(
        name="plugin_uninstall",
        toolset="core",
        schema={
            "name": "plugin_uninstall",
            "description": "Uninstall a plugin by name.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Plugin name"},
                },
                "required": ["name"],
            },
        },
        handler=plugin_uninstall,
        description="Uninstall a plugin",
    )

    def federation_discover_tool() -> str:
        endpoints = federation_discover()
        return json.dumps({"endpoints": endpoints})

    registry.register(
        name="federation_discover",
        toolset="core",
        schema={
            "name": "federation_discover",
            "description": "Discover available federation endpoints.",
            "parameters": {"type": "object", "properties": {}},
        },
        handler=federation_discover_tool,
        description="Discover federation endpoints",
    )

    def federation_call_tool(server_url: str, method: str, params: dict = None) -> str:
        result = federation_call(server_url, method, params)
        return json.dumps(result)

    registry.register(
        name="federation_call",
        toolset="core",
        schema={
            "name": "federation_call",
            "description": "Call a federated MCP server endpoint.",
            "parameters": {
                "type": "object",
                "properties": {
                    "server_url": {"type": "string", "description": "Federation server URL"},
                    "method": {"type": "string", "description": "JSON-RPC method"},
                    "params": {"type": "object", "description": "Method parameters"},
                },
                "required": ["server_url", "method"],
            },
        },
        handler=federation_call_tool,
        description="Call a federated MCP server",
    )


# Auto-register on import
register_plugin_tools()
