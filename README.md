# Elitza

**Elitza by Dario Cositore** — an autonomous, OpenRouter-native AI agent for your terminal.

One-liner install, prebuilt binaries, full tool-calling, streaming responses.

```bash
curl -fsSL https://elitza.life/install.sh | bash
```

## Install

The installer detects your OS and CPU, downloads the prebuilt release archive
for it, and links `elitza` onto your `PATH`.

```bash
# Latest release
curl -fsSL https://elitza.life/install.sh | bash

# Pin a specific release
curl -fsSL https://elitza.life/install.sh | bash -s -- --version 0.2.0

# Do not touch your shell startup files
curl -fsSL https://elitza.life/install.sh | bash -s -- --no-modify-path

# Remove Elitza
curl -fsSL https://elitza.life/install.sh | bash -s -- --uninstall
```

What it does:

1. Resolves the latest release from the GitHub `latest` endpoint
2. Downloads `elitza-<version>-<os>-<arch>.tar.gz` (falls back to `git clone`
   if no prebuilt archive exists for your platform)
3. Creates a Python 3.11+ virtualenv and installs the package
   (uses [`uv`](https://github.com/astral-sh/uv) when available)
4. Seeds `~/.elitza` with the default config, soul, personas and skills —
   existing files are never overwritten, so upgrades keep your setup
5. Links `elitza` into `~/.local/bin` and adds it to `PATH`
6. Offers the setup wizard when run from an interactive terminal

### Options

| Flag | Effect |
| --- | --- |
| `--version <tag>` | Install a specific release instead of the latest |
| `--no-modify-path` | Leave your shell startup files alone |
| `--no-setup` | Skip the interactive setup wizard |
| `--binary` | Print the installed launcher path and exit |
| `--uninstall` | Remove Elitza (asks before deleting your `~/.elitza`) |
| `--help` | Show installer help |

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `ELITZA_HOME` | `~/.elitza` | Config, soul and memories |
| `ELITZA_INSTALL_DIR` | `~/.elitza/agent` | Installed code and virtualenv |
| `ELITZA_BIN_DIR` | `~/.local/bin` | Where the `elitza` link is placed |

## Quick Start

```bash
# Add your API key and pick a model
elitza setup

# Start the TUI
elitza

# Start the pure-Python REPL instead
elitza --python

# Single message
elitza -m "What's the weather like?"

# Use a specific model
elitza --model anthropic/claude-opus-4 -m "Hello"

# List available tools
elitza --list-tools
```

## Commands

```bash
elitza --version      # Print the installed version (alias: -V)
elitza update         # Update to the latest release
elitza update --check # Report whether a newer release exists
elitza update --version 0.2.0   # Update to a specific release
elitza setup          # Configure API key and model
elitza gateway start  # Gateway server: start | stop | status
```

### Useful flags

```bash
elitza --theme elitza   # Color theme
elitza --list-tools     # List registered tools
elitza --verbose        # Verbose output
elitza --yolo           # Auto-approve all tool executions
elitza --vim            # Vim-style keybindings
elitza --compact        # Compact display mode
elitza --model <id>     # Override the configured model
```

## Repository Layout

The repository doubles as the installer payload — everything the CLI needs to
run is tracked:

```
install.sh            # the one-liner installer
bin/elitza            # launcher: picks the TUI or the Python agent
elitza/               # the Python package (CLI, tools, brain, skills)
tui/                  # the Rust TUI crate
home/                 # defaults seeded into ~/.elitza on first install
  config.yaml         #   unified configuration
  .env.example        #   becomes ~/.elitza/.env
  AGENTS.md  SOUL.md  #   agent definition
  personas/  roles/   #   personas and role presets
  soul/               #   soul subsystem: code + pristine defaults
.github/workflows/    # release pipeline (per-platform artifacts)
```

Configuration lives in `~/.elitza/config.yaml`; the copy in `home/` is only a
template and is refreshed by re-running the installer with a different
`ELITZA_HOME`. Every credential slot ships as the literal placeholder
`[place your $api key$ here]`.

## Requirements

- Linux or macOS (x64 or arm64)
- Python 3.11+
- An [OpenRouter](https://openrouter.ai) API key (free tier available)

Rust is only needed if you build the TUI from source — releases ship a prebuilt
binary, and the launcher builds one on demand solely as a fallback.

## Architecture

- **OpenRouter-native**: uses the OpenAI SDK pointed at `https://openrouter.ai/api/v1`
- **Tool registry**: self-registering tools with AST-based auto-discovery
- **Streaming**: real-time token streaming with callbacks
- **Skills**: `SKILL.md`-based skill system for extensibility
- **Two front-ends**: a Rust TUI (default) and a Python REPL (`--python`), both
  speaking the same protocol to the agent

## Development

```bash
uv venv venv --python 3.11
uv pip install --python venv/bin/python -e .

# Python agent
./bin/elitza --python

# Rust TUI
cd tui && cargo build --release
```

Releases are cut by pushing a tag; `.github/workflows/release.yml` builds the
TUI for each platform and publishes one archive per `os-arch` pair.

## License

MIT — see [LICENSE](LICENSE).

Copyright © 2026 Dario Cositore.
