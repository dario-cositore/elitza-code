"""Elitza Agent CLI -- Interactive terminal interface.

Usage:
    elitza                    # Start interactive mode
    elitza setup              # Run setup wizard
    elitza --model <model>    # Use a specific model
    elitza -m "message"       # Single message mode
"""

import argparse
import atexit
import logging
import os
import sys
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

from elitza.constants import get_elitza_home, get_config_path, get_env_path, OPENROUTER_BASE_URL
from elitza.agent import ElitzaAgent
from elitza.tui import THEMES, resolve_theme, ContextState, TodoState

# Repository / release coordinates (must match agent/install.sh).
REPO = "dario-cositore/elitza-agent"
RELEASES_API = f"https://api.github.com/repos/{REPO}/releases/latest"
INSTALL_URL = "https://elitza.life/install.sh"


def get_version() -> str:
    """Installed version of the Elitza CLI.

    Reads the installed distribution metadata first (works for a normal or
    editable install), then falls back to pyproject.toml so a bare checkout
    with no install still reports something accurate.
    """
    try:
        from importlib.metadata import PackageNotFoundError, version
        try:
            return version("elitza-agent")
        except PackageNotFoundError:
            pass
    except Exception:
        pass

    try:
        import tomllib
        pyproject = Path(__file__).resolve().parent.parent / "pyproject.toml"
        if pyproject.exists():
            data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
            return data["project"]["version"]
    except Exception:
        pass

    return "0.0.0"


def fetch_latest_version() -> str:
    """Ask the GitHub releases "latest" endpoint. Returns "" when unreachable."""
    import json
    import urllib.request

    try:
        req = urllib.request.Request(
            RELEASES_API, headers={"User-Agent": f"elitza/{get_version()}"}
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8")).get("tag_name", "")
    except Exception:
        return ""


def load_config() -> dict:
    """Load config from ~/.elitza/config.yaml and .env."""
    env_path = get_env_path()
    if env_path.exists():
        load_dotenv(env_path, override=True)

    import yaml
    config_path = get_config_path()
    if config_path.exists():
        with open(config_path, "r") as f:
            return yaml.safe_load(f) or {}
    return {}


def setup_mcp(config: dict) -> list:
    """Connect to MCP servers from config and register their tools.

    Config format (in config.yaml):
        mcp_servers:
          - base_url: https://mcp.dariocositore.com
            connector_id: dario_hub
            auth_token: "[place your $api key$ here]"   # optional
            timeout: 30             # optional
    """
    servers = config.get("mcp_servers", [])
    if not servers:
        return []

    from elitza.tools import discover_tools
    discover_tools()

    from elitza.mcp_bridge import setup_mcp_servers, close_all
    clients = setup_mcp_servers(servers)

    if clients:
        atexit.register(close_all)

    return clients


def build_agent(args: argparse.Namespace, config: dict) -> ElitzaAgent:
    """Build an ElitzaAgent from args and config."""
    # Discover and register built-in tools
    from elitza.tools import discover_tools
    discover_tools()

    # Install bundled plugins
    try:
        from elitza.plugins import PLUGINS_DIR, _load_plugin
        if not PLUGINS_DIR.exists():
            import shutil
            bundled = Path(__file__).parent / "bundled" / "plugins"
            if bundled.exists():
                shutil.copytree(bundled, PLUGINS_DIR)
                for plugin_dir in PLUGINS_DIR.iterdir():
                    if plugin_dir.is_dir():
                        _load_plugin(plugin_dir.name, plugin_dir)
    except Exception:
        pass

    # Connect to MCP servers and register their tools
    setup_mcp(config)

    model_cfg = config.get("model", "")
    fallback_models = None
    if isinstance(model_cfg, dict):
        model = args.model or model_cfg.get("primary", "")
        max_iterations = model_cfg.get("max_iterations", 0)
        max_tokens = model_cfg.get("max_tokens", 0)
        fallback_models = model_cfg.get("fallback") or None
    else:
        model = args.model or model_cfg
        max_iterations = config.get("max_iterations", 0)
        max_tokens = config.get("max_tokens", 0)
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    base_url = OPENROUTER_BASE_URL

    system_prompt = config.get("system_prompt", "")

    enabled = None
    disabled = None
    if args.toolsets:
        enabled = [t.strip() for t in args.toolsets.split(",")]

    return ElitzaAgent(
        model=model,
        api_key=api_key,
        base_url=base_url,
        max_iterations=max_iterations,
        max_tokens=max_tokens,
        system_prompt=system_prompt,
        enabled_toolsets=enabled,
        disabled_toolsets=disabled,
        verbose=args.verbose,
        fallback_models=fallback_models,
    )


def interactive_loop(agent: ElitzaAgent, theme_name: str = "elitza",
                     compact_mode: bool = False, yolo: bool = False,
                     vim_mode: bool = False):
    """Fallback interactive loop when Rust TUI binary is not available."""
    from elitza.tui import get_console, print_header, print_user, print_bye

    ctx = ContextState(total_tokens=agent._context_window)
    todo_state = TodoState()

    console = get_console()
    print_header(agent.model, agent.session_id)

    while True:
        console.print()
        try:
            user_input = console.input("[bold white]  ◆ You[/bold white] [bright_black]›[/bright_black] ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not user_input:
            continue
        if user_input.lower() in ("quit", "exit", "q"):
            break
        if user_input.startswith("/"):
            _handle_slash(user_input, agent, ctx, todo_state, theme_name)
            continue

        print_user(user_input)

        def on_token(token: str):
            print(token, end="", flush=True)

        try:
            agent.run(user_input, stream=True, on_token=on_token)
            ctx.used_tokens = agent._estimate_context_tokens()
            console.print()
        except KeyboardInterrupt:
            console.print("\n  [dim]Turn cancelled[/dim]")
        except Exception as e:
            console.print(f"\n  [error]Error: {str(e)[:200]}[/error]")

    print_bye()


# ===========================================================================
# Theme Persistence
# ===========================================================================

_THEME_FILE = ".elitza_theme"

def _get_current_theme() -> str:
    """Get the current theme from disk or default."""
    theme_path = Path.home() / _THEME_FILE
    if theme_path.exists():
        name = theme_path.read_text().strip()
        if name in THEMES or resolve_theme(name) in THEMES:
            return resolve_theme(name)
    return "elitza"


def _save_theme(theme_name: str):
    """Persist theme choice to disk."""
    theme_path = Path.home() / _THEME_FILE
    theme_path.write_text(theme_name)


def _handle_slash(cmd: str, agent: ElitzaAgent,
                   ctx: object = None,
                   todo_state: object = None, current_theme: str = "elitza") -> Optional[str]:
    """Handle slash commands. Returns 'theme_changed' if theme was switched."""
    from elitza.tui import get_console
    console = get_console()
    parts = cmd.split()
    command = parts[0].lower()

    if command == "/help":
        # OpenCode command-palette rhythm: accent section header, bright
        # command, muted description.
        console.print()
        console.print("  [bold #9d7cd8]Commands[/]")
        console.print()
        rows = [
            ("/help", "Show this help"),
            ("/model", "Show/switch model"),
            ("/context", "Show context window usage"),
            ("/session-info", "Session details"),
            ("/tools", "List available tools"),
            ("/brain", "Brain stats and memory"),
            ("/skills", "List available skills"),
            ("/plugins", "List installed plugins"),
            ("/hooks", "List active hooks"),
            ("/theme", "Switch color theme"),
            ("/compact-mode", "Toggle compact display"),
            ("/multiline", "Toggle multiline input"),
            ("/vim-mode", "Toggle vim keybindings"),
            ("/yolo", "Toggle auto-approve mode"),
            ("/plan", "Enter plan mode"),
            ("/rewind [N]", "Rewind N turns"),
            ("/compact", "Compact conversation"),
            ("/flush", "Save session to memory"),
            ("/clear", "Clear screen"),
            ("/home", "Welcome screen"),
            ("/quit", "Exit"),
        ]
        width = max(len(c) for c, _ in rows)
        for name, desc in rows:
            console.print(
                f"  [bold #eeeeee]{name.ljust(width)}[/]"
                f"   [dim #808080]{desc}[/]"
            )
        console.print()

    elif command == "/model":
        if len(parts) > 1:
            new_model = " ".join(parts[1:])
            agent.model = new_model
            agent._cached_system_prompt = None
            console.print(f"  [success]Model switched to: [model]{new_model}[/model][/success]")
        else:
            console.print(f"  [elitza.dim]Model:[/elitza.dim] [model]{agent.model}[/model]")

    elif command == "/context":
        if ctx:
            console.print(f"  {ctx.bar_text}")
            console.print(f"  [elitza.dim]Messages: {len(agent.messages)}  Compactions: {agent._compaction_count}[/elitza.dim]")
        else:
            console.print("  [elitza.dim]Context tracking not available.[/elitza.dim]")

    elif command in ("/session-info", "/status", "/info"):
        console.print(f"  [elitza.dim]Session:[/elitza.dim] [session]{agent.session_id}[/session]")
        console.print(f"  [elitza.dim]Model:[/elitza.dim] [model]{agent.model}[/model]")
        console.print(f"  [elitza.dim]Messages:[/elitza.dim] {len(agent.messages)}")
        console.print(f"  [elitza.dim]Max iterations:[/elitza.dim] {agent.max_iterations}")
        console.print(f"  [elitza.dim]Max tokens:[/elitza.dim] {agent.max_tokens}")
        console.print(f"  [elitza.dim]Compactions:[/elitza.dim] {agent._compaction_count}")
        if ctx:
            console.print(f"  {ctx.bar_text}")

    elif command == "/tools":
        from elitza.tools import registry
        tools = registry.get_all_tools()
        console.print(f"  [elitza.dim]Tools ({len(tools)}):[/elitza.dim]")
        for name, entry in sorted(tools.items()):
            console.print(f"    [tool.name]{name}[/tool.name] [elitza.dim]({entry.toolset})[/elitza.dim]")

    elif command == "/brain":
        from elitza.brain_v2 import get_personality, list_procedural_skills
        p = get_personality()
        console.print("  [elitza]Brain Status:[/elitza]")
        console.print(f"    Mood: {p.get('mood','?')}  Confidence: {p.get('confidence',0):.0%}")
        console.print(f"    Interactions: {p.get('interactions',0)}")
        skills = list_procedural_skills()
        if skills:
            console.print(f"    Auto-skills: {len(skills)}")

    elif command == "/skills":
        from elitza.system import discover_skills
        skills = discover_skills()
        if skills:
            console.print(f"  [elitza.dim]Skills ({len(skills)}):[/elitza.dim]")
            for name in sorted(skills.keys()):
                console.print(f"    [elitza]•[/elitza] {name}")
        else:
            console.print("  [elitza.dim]No skills installed.[/elitza.dim]")

    elif command == "/plugins":
        from elitza.plugins import discover_plugins
        plugins = discover_plugins()
        if plugins:
            console.print(f"  [elitza.dim]Plugins ({len(plugins)}):[/elitza.dim]")
            for name in sorted(plugins.keys()):
                console.print(f"    [elitza]•[/elitza] {name}")
        else:
            console.print("  [elitza.dim]No plugins installed.[/elitza.dim]")

    elif command == "/hooks":
        from elitza.plugins import discover_hooks
        hooks = discover_hooks()
        if hooks:
            console.print(f"  [elitza.dim]Hooks ({sum(len(v) for v in hooks.values())}):[/elitza.dim]")
            for event, scripts in sorted(hooks.items()):
                for script in scripts:
                    console.print(f"    [elitza]•[/elitza] {event}/{script.name}")
        else:
            console.print("  [elitza.dim]No hooks installed.[/elitza.dim]")

    elif command == "/theme":
        from elitza.tui import THEMES, THEME_ALIASES
        available = list(THEMES.keys())
        console.print(f"  [elitza.dim]Available themes:[/elitza.dim]")
        for t in available:
            marker = " ← current" if t == current_theme else ""
            console.print(f"    [elitza]•[/elitza] {t}{marker}")
        console.print(f"  [elitza.dim]Type '/theme <name>' to switch[/elitza.dim]")
        if len(parts) > 1:
            new_theme = resolve_theme(parts[1])
            if new_theme in THEMES:
                _save_theme(new_theme)
                console.print(f"  [success]Theme switched to: {new_theme}[/success]")
                return "theme_changed"
            else:
                console.print(f"  [error]Unknown theme: {parts[1]}[/error]")

    elif command == "/compact-mode":
        console.print("  [elitza.dim]Compact mode toggle (not yet implemented)[/elitza.dim]")

    elif command in ("/multiline", "/ml"):
        console.print("  [elitza.dim]Multiline toggle (not yet implemented)[/elitza.dim]")

    elif command == "/vim-mode":
        console.print("  [elitza.dim]Vim mode toggle (not yet implemented)[/elitza.dim]")

    elif command in ("/yolo", "/always-approve"):
        if len(parts) > 1 and parts[1].lower() in ("off", "false", "0", "no", "disable"):
            console.print("  [success]YOLO mode: OFF[/success]")
        else:
            console.print("  [success]YOLO mode: ON (auto-approve all tools)[/success]")

    elif command == "/plan":
        console.print("  [elitza]Plan mode: create a structured plan before executing.[/elitza]")
        console.print("  [elitza.dim]The agent will use enter_plan_mode / exit_plan_mode tools.[/elitza.dim]")

    elif command == "/rewind":
        steps = 1
        if len(parts) > 1:
            try:
                steps = int(parts[1])
            except ValueError:
                pass
        if agent.rewind(steps):
            console.print(f"  [success]Rewound {steps} turn(s).[/success]")
        else:
            console.print("  [error]Could not rewind.[/error]")

    elif command == "/compact":
        result = agent.compact()
        console.print(f"  [success]Compacted: {result[:100]}[/success]")

    elif command == "/flush":
        console.print("  [success]Session memory saved.[/success]")

    elif command == "/clear":
        console.clear()

    elif command in ("/home", "/welcome"):
        console.print("  [elitza.dim]Welcome screen (not yet implemented)[/elitza.dim]")

    elif command in ("/exit", "/quit"):
        # handled by caller
        pass

    else:
        console.print(f"  [error]Unknown command: {command}[/error]")

    return None


def single_message(agent: ElitzaAgent, message: str):
    """Process a single message and print the result."""
    from elitza.tui import console

    def on_token(token: str):
        print(token, end="", flush=True)

    result = agent.run(message, stream=True, on_token=on_token)
    console.print()


# ============================================================================
# Setup Wizard
# ============================================================================

def run_setup_wizard():
    """Interactive setup wizard for first-time configuration."""
    elitza_home = get_elitza_home()
    env_path = get_env_path()
    config_path = get_config_path()

    print("")
    print("=" * 50)
    print("  Elitza Agent Setup Wizard")
    print("=" * 50)
    print("")

    # --- Step 1: OpenRouter API Key ---
    print("Step 1: OpenRouter API Key")
    print("-" * 30)
    print("Elitza uses OpenRouter to access AI models.")
    print("Get your free API key at: https://openrouter.ai/keys")
    print("")

    current_key = os.environ.get("OPENROUTER_API_KEY", "")
    if current_key:
        masked = current_key[:8] + "..." + current_key[-4:]
        print(f"Current key: {masked}")
        change = input("Change API key? [y/N] ").strip().lower()
        if change != "y":
            print("Keeping existing key.")
        else:
            current_key = ""
    else:
        current_key = ""

    if not current_key:
        api_key = input("Enter your OpenRouter API key: ").strip()
        if not api_key:
            print("No key entered. You can add it later to ~/.elitza/.env")
            api_key = ""
    else:
        api_key = current_key

    # --- Step 2: Default Model ---
    print("")
    print("Step 2: Default Model")
    print("-" * 30)
    print("Which model would you like to use by default?")
    print("")
    print("  1. inclusionai/ling-3.1-flash   (free, recommended)")
    print("  2. deepseek/deepseek-v4-flash:free (free)")
    print("  3. openai/gpt-oss-120b:free      (free)")
    print("  4. anthropic/claude-sonnet-4     (paid)")
    print("  5. deepseek/deepseek-chat        (paid)")
    print("  6. Custom (enter model ID)")
    print("")

    model_map = {
        "1": "inclusionai/ling-3.1-flash",
        "2": "deepseek/deepseek-v4-flash:free",
        "3": "openai/gpt-oss-120b:free",
        "4": "anthropic/claude-sonnet-4",
        "5": "deepseek/deepseek-chat",
    }

    choice = input("Choose [1-6, default=1]: ").strip()
    if not choice:
        choice = "1"

    if choice in model_map:
        model = model_map[choice]
    elif choice == "6":
        model = input("Enter OpenRouter model ID: ").strip()
        if not model:
            model = "inclusionai/ling-3.1-flash"
    else:
        model = "inclusionai/ling-3.1-flash"

    print(f"Selected: {model}")

    # --- Step 3: System Prompt (optional) ---
    print("")
    print("Step 3: Custom System Prompt (optional)")
    print("-" * 30)
    print("You can set a custom system prompt to change Elitza's behavior.")
    print("Leave empty for the default prompt.")
    print("")

    custom_prompt = input("Custom system prompt (or Enter to skip): ").strip()

    # --- Write .env ---
    print("")
    print("Writing configuration...")

    elitza_home.mkdir(parents=True, exist_ok=True)

    env_content = "# Elitza Agent Environment Variables\n"
    env_content += "# Generated by elitza setup\n\n"
    if api_key:
        env_content += f"OPENROUTER_API_KEY={api_key}\n"
    else:
        env_content += "# OPENROUTER_API_KEY=[place your $api key$ here]\n"

    env_path.write_text(env_content, encoding="utf-8")
    print(f"  Created: {env_path}")

    # --- Write config.yaml ---
    import yaml
    config = {
        "model": model,
        "max_iterations": 50,
    }
    if custom_prompt:
        config["system_prompt"] = custom_prompt

    with open(config_path, "w") as f:
        yaml.dump(config, f, default_flow_style=False, sort_keys=False)
    print(f"  Created: {config_path}")

    # --- Verify ---
    print("")
    print("Verifying setup...")

    # Reload env
    load_dotenv(env_path)
    verify_key = os.environ.get("OPENROUTER_API_KEY", "")

    if verify_key:
        print("  API key: OK")
    else:
        print("  API key: NOT SET (run 'elitza setup' to add it)")

    print(f"  Model: {model}")
    print(f"  Config: {config_path}")

    # --- Test connection ---
    print("")
    test = input("Test connection to OpenRouter now? [Y/n] ").strip().lower()
    if test != "n":
        print("Testing...")
        try:
            from openai import OpenAI
            client = OpenAI(
                api_key=verify_key,
                base_url=OPENROUTER_BASE_URL,
            )
            resp = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": "Reply with 'OK' to confirm the connection works."}],
                max_tokens=20,
            )
            reply = resp.choices[0].message.content
            print(f"  Connection successful! Model replied: {reply}")
        except Exception as e:
            print(f"  Connection test failed: {e}")
            print("  You can retry later with: elitza setup")

    # --- Done ---
    print("")
    print("=" * 50)
    print("  Setup complete!")
    print("=" * 50)
    print("")
    print("Start using Elitza:")
    print("  elitza              # Interactive mode")
    print("  elitza -m \"hello\"   # Single message")
    print("  elitza --help       # Full help")
    print("")


# ============================================================================
# Self-updater
# ============================================================================

def run_update(args: argparse.Namespace) -> int:
    """Update Elitza by re-running the installer against a release.

    Uses the copy of install.sh that ships alongside the package when present,
    otherwise fetches the canonical installer. The setup wizard and PATH edits
    are skipped: neither is needed to refresh an existing installation.
    """
    current = get_version()

    if args.check:
        print(f"elitza {current}")
        latest = fetch_latest_version()
        if not latest:
            print("  Could not reach the releases endpoint (network or rate limit).")
            return 1
        if latest.lstrip("v") == current.lstrip("v"):
            print(f"  Already up to date ({latest}).")
            return 0
        print(f"  A newer release is available: {latest}")
        print("  Update with: elitza update")
        return 0

    target = args.version or "latest"
    print(f"Elitza {current} -> {target}")

    import subprocess

    env = os.environ.copy()
    # Keep the code inside the home we resolved, even if ELITZA_HOME is unset.
    env.setdefault("ELITZA_INSTALL_DIR", str(Path(get_elitza_home()) / "agent"))
    # A piped installer cannot prompt, and never should during an update.
    env["ELITZA_NO_PROMPT"] = "1"

    local_script = Path(__file__).resolve().parent.parent / "install.sh"
    if local_script.exists():
        cmd = ["bash", str(local_script), "--no-setup", "--no-modify-path"]
    else:
        cmd = [
            "bash", "-c",
            f"curl -fsSL {INSTALL_URL} | bash -s -- --no-setup --no-modify-path",
        ]

    if args.version:
        cmd += ["--version", args.version]

    print(f"  Running {' '.join(cmd)}")
    try:
        return subprocess.call(cmd, env=env)
    except FileNotFoundError:
        print("  bash is required to run the installer.")
        return 1


# ============================================================================
# Main
# ============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="Elitza Agent -- OpenRouter-native AI agent CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Examples:\n  elitza              # Interactive mode\n  elitza setup        # Configure API key and model\n  elitza -m \"hello\"   # Single message\n",
    )

    # Subcommands
    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # Setup subcommand
    setup_parser = subparsers.add_parser("setup", help="Run the setup wizard")
    setup_parser.add_argument("--api-key", default="", help="OpenRouter API key (skip interactive)")
    setup_parser.add_argument("--model", default="", help="Default model ID")

    # Gateway subcommand
    gw_parser = subparsers.add_parser("gateway", help="Manage the gateway server")
    gw_sub = gw_parser.add_subparsers(dest="gw_command")
    gw_sub.add_parser("start", help="Start the gateway server")
    gw_sub.add_parser("stop", help="Stop the gateway server")
    gw_sub.add_parser("status", help="Show gateway status")

    # Update subcommand
    upd_parser = subparsers.add_parser("update", help="Update Elitza to the latest release")
    upd_parser.add_argument("--version", default="", help="Update to a specific release tag")
    upd_parser.add_argument("--check", action="store_true", help="Check for a newer release and exit")

    # Main options
    parser.add_argument("-m", "--message", help="Single message mode (non-interactive)")
    parser.add_argument("--model", default="", help="Model to use (e.g. inclusionai/ling-3.1-flash)")
    parser.add_argument("--toolsets", default="", help="Comma-separated toolsets to enable")
    parser.add_argument("--list-tools", action="store_true", help="List available tools and exit")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")
    parser.add_argument("--debug", action="store_true", help="Debug logging")
    parser.add_argument("--gateway", action="store_true", help="Connect to gateway server")
    parser.add_argument("--theme", default="", help="Color theme (elitza/tokyonight/rosepine)")
    parser.add_argument("--yolo", action="store_true", help="Auto-approve all tool executions")
    parser.add_argument("--vim", action="store_true", help="Enable vim-style keybindings")
    parser.add_argument("--compact", action="store_true", help="Compact display mode")
    parser.add_argument("--protocol", action="store_true", help="Protocol mode for TUI integration (stdin/stdout)")
    parser.add_argument(
        "--version", "-V", action="version", version=f"elitza {get_version()}",
        help="Show the installed version and exit",
    )

    args = parser.parse_args()

    if args.debug:
        logging.basicConfig(level=logging.DEBUG)

    # Handle subcommands
    if args.command == "setup":
        if args.api_key or args.model:
            _non_interactive_setup(args)
        else:
            run_setup_wizard()
        return

    # Gateway subcommand
    if args.command == "gateway":
        from elitza.gateway import gateway_start, gateway_stop, gateway_status
        gw_cmd = args.gw_command
        if gw_cmd == "start":
            gateway_start(background=True)
        elif gw_cmd == "stop":
            gateway_stop()
        elif gw_cmd == "status":
            gateway_status()
        else:
            print("Usage: elitza gateway {start|stop|status}")
        return

    # Update subcommand
    if args.command == "update":
        sys.exit(run_update(args))

    config = load_config()

    # Protocol mode for TUI integration
    if args.protocol:
        agent = build_agent(args, config)
        protocol_loop(agent)
        return

    # List tools mode
    if args.list_tools:
        from elitza.tools import discover_tools, registry
        discover_tools()
        setup_mcp(config)
        tools = registry.get_all_tools()
        print(f"Available tools ({len(tools)}):")
        for name, entry in sorted(tools.items()):
            print(f"  {name:40s} [{entry.toolset:10s}] {entry.description}")
        return

    # Gateway client mode
    if args.gateway:
        from elitza.gateway import GatewayClient
        client = GatewayClient()
        if not client.connect():
            print("Error: Could not connect to gateway. Start it with: elitza gateway start")
            sys.exit(1)
        print("Connected to gateway. Type /quit to exit.")
        # Simple interactive loop with gateway
        from elitza.tui import console, print_header, print_user, print_bye, print_error
        print_header(config.get("model", "inclusionai/ling-3.1-flash"), "gateway")
        console.print()
        while True:
            console.print()
            try:
                user_input = console.input("[bold white]  ◆ You[/bold white] [bright_black]›[/bright_black] ").strip()
            except (EOFError, KeyboardInterrupt):
                break
            if not user_input:
                continue
            if user_input.lower() in ("quit", "exit", "q"):
                break
            if user_input.startswith("/"):
                if user_input.lower() == "/history":
                    msgs = client.history()
                    for m in msgs[-10:]:
                        role = m.get("role", "?")
                        content = str(m.get("content", ""))[:100]
                        console.print(f"  [dim]{role}:[/dim] {content}")
                    continue
                if user_input.lower().startswith("/rewind"):
                    parts = user_input.split()
                    steps = int(parts[1]) if len(parts) > 1 else 1
                    client.rewind(steps)
                    console.print(f"  [success]Rewound {steps} turn(s)[/success]")
                    continue
                if user_input.lower() == "/compact":
                    client.compact()
                    console.print("  [success]Compacted[/success]")
                    continue
                console.print("  [elitza.dim]Commands: /history, /rewind [N], /compact, /quit[/elitza.dim]")
                continue
            print_user(user_input)
            response = client.chat(user_input)
            console.print(f"  [elitza]◇ Elitza ───[/elitza]")
            console.print()
            console.print(f"  {response}")
        client.disconnect()
        print_bye()
        return

    agent = build_agent(args, config)

    # Determine theme: CLI arg > saved preference > default
    theme = args.theme or _get_current_theme()

    if args.message:
        single_message(agent, args.message)
    else:
        interactive_loop(
            agent, theme_name=theme,
            compact_mode=args.compact,
            yolo=args.yolo,
            vim_mode=args.vim,
        )


def protocol_loop(agent: ElitzaAgent):
    """Protocol mode: reads USER_INPUT from stdin, writes protocol messages to stdout.

    Used by the Rust TUI (elitza-tui) for bidirectional communication.
    Protocol:
      stdin:  USER_INPUT <text>
      stdout: TOKEN <text>  |  THINKING <text>  |  TOOL_CALL <name> <args>  |
              TOOL_RESULT <text>  |  SHELL_CMD <cmd>  |  SHELL_OUTPUT <out>  |
              METRICS tokens=<n> cost=<f> speed=<f>  |  ACTIVITY <title>  |  DONE
    """
    import sys

    def stdout_write(msg: str):
        sys.stdout.write(msg + "\n")
        sys.stdout.flush()

    def on_token(token: str):
        stdout_write(f"TOKEN {token}")

    def on_tool_call(name: str, args: dict):
        arg_str = ", ".join(f"{k}={repr(v)[:30]}" for k, v in list(args.items())[:3])
        stdout_write(f"TOOL_CALL {name} {arg_str}")

    def on_tool_result(result: str, is_error: bool):
        prefix = "ERROR: " if is_error else ""
        result_escaped = result.replace('\n', '\\n')
        if len(result_escaped) > 500:
            result_escaped = result_escaped[:500] + "..."
        stdout_write(f"TOOL_RESULT {prefix}{result_escaped}")

    def on_thinking(text: str):
        stdout_write(f"THINKING {text}")

    # Use readline() instead of `for line in sys.stdin` to avoid read-ahead buffering
    # that deadlocks with piped stdin from the TUI subprocess.
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue

        if line == "QUIT":
            break
        if line == "CANCEL":
            continue

        if line.startswith("USER_INPUT "):
            user_input = line[11:]
            try:
                stdout_write("THINKING_START")
                # Emit activity title
                activity = user_input[:50] + "..." if len(user_input) > 50 else user_input
                stdout_write(f"ACTIVITY {activity}")

                result = agent.run(
                    user_input, stream=True,
                    on_token=on_token,
                    on_tool_call=on_tool_call,
                    on_tool_result=on_tool_result,
                    on_thinking=on_thinking,
                )
                stdout_write("THINKING_END")

                # Emit metrics if available
                if hasattr(agent, '_last_usage') and agent._last_usage:
                    usage = agent._last_usage
                    stdout_write(f"METRICS tokens={usage.get('total_tokens', 0)} cost=0.00 speed=0.0")

                stdout_write("DONE")
            except KeyboardInterrupt:
                stdout_write("THINKING_END")
                stdout_write("TOOL_RESULT ERROR: [interrupted]")
                stdout_write("DONE")
            except Exception as e:
                stdout_write("THINKING_END")
                stdout_write(f"TOOL_RESULT ERROR: {str(e)[:200]}")
                stdout_write("DONE")


def _non_interactive_setup(args: argparse.Namespace):
    """Non-interactive setup for scripted installs."""
    elitza_home = get_elitza_home()
    env_path = get_env_path()
    config_path = get_config_path()

    elitza_home.mkdir(parents=True, exist_ok=True)

    # Write .env
    env_content = "# Elitza Agent Environment Variables\n"
    if args.api_key:
        env_content += f"OPENROUTER_API_KEY={args.api_key}\n"
    else:
        env_content += "# OPENROUTER_API_KEY=[place your $api key$ here]\n"

    env_path.write_text(env_content, encoding="utf-8")
    print(f"Created: {env_path}")

    # Write config.yaml
    import yaml
    model = args.model or "inclusionai/ling-3.1-flash"
    config = {"model": model, "max_iterations": 50}
    with open(config_path, "w") as f:
        yaml.dump(config, f, default_flow_style=False, sort_keys=False)
    print(f"Created: {config_path}")

    print("Setup complete. Run 'elitza' to start.")


if __name__ == "__main__":
    main()
