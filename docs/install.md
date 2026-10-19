# Install Elitza

Elitza ships as a prebuilt binary for macOS and Linux. You install her with one command, connect a free model, and start working. The [README](../README.md) has the short version; this page has every flag, path and step.

## Install

```bash
curl -fsSL https://elitza.life/install.sh | bash
```

Then start her:

```bash
elitza
```

The installer is safe to re-run. It never overwrites a config, `SOUL.md` or key file you already have.

## Installer options

Pass flags after `--`:

```bash
curl -fsSL https://elitza.life/install.sh | bash -s -- --version v1.2.3
```

| Flag | What it does |
| --- | --- |
| `--version <tag>` | Install a specific release (default: latest) |
| `--no-modify-path` | Do not add `~/.local/bin` to your shell startup files |
| `--binary` | Print the path of the installed launcher and exit |
| `--uninstall` | Remove Elitza and exit |
| `--force` | Replace an existing source checkout at `~/.elitza/agent` |
| `--help` | Show the help text |

Environment overrides, also read from `--help`:

| Variable | Default |
| --- | --- |
| `ELITZA_HOME` | `~/.elitza` |
| `ELITZA_INSTALL_DIR` | `~/.elitza/agent` |
| `ELITZA_BIN_DIR` | `~/.local/bin` |

## What the installer does

1. Detects your OS and architecture: Linux or macOS, x64 or arm64. Anything else is rejected.
2. Resolves the newest release tag from the GitHub releases API. If the API is unreachable, it falls back to GitHub's `releases/latest/download` redirect, so it still gets a fresh build.
3. Downloads `elitza-<os>-<arch>.tar.gz` (the `elitza` binary plus the brain plugin), extracts it to a staging directory, and swaps it into `~/.elitza/agent`. A failed download never leaves a half-installed release behind.
4. Runs `elitza --version` in a throwaway home to prove the binary starts.
5. Migrates an older `~/.elitza/opencode` tree into `~/.elitza/home`, so sessions and config survive the upgrade.
6. Seeds what is missing: `~/.elitza/.env` for provider keys, `~/.elitza/SOUL.md` for her identity, `~/.elitza/brain`, `~/.elitza/personas`, and a config at `~/.elitza/home/config/opencode.json` with a free default model (`openrouter/nvidia/nemotron-3-super-120b-a12b:free`) and the brain plugin.
7. Writes the `elitza` launcher into `~/.local/bin` and adds a PATH line marked `# Elitza` to your shell startup files (skip with `--no-modify-path`).

The script lives at <https://elitza.life/install.sh>.

## What the launcher does

The launcher is a small shell script, not a symlink. It pins every runtime directory under `~/.elitza/home` so nothing Elitza writes lands in another app's XDG directories, then loads your keys and hands over to the binary.

| Variable | Value |
| --- | --- |
| `OPENCODE_CONFIG_DIR` | `~/.elitza/home/config` |
| `XDG_CONFIG_HOME` | `~/.elitza/home/config` |
| `XDG_DATA_HOME` | `~/.elitza/home/data` |
| `XDG_STATE_HOME` | `~/.elitza/home/state` |
| `XDG_CACHE_HOME` | `~/.elitza/home/cache` |
| `OPENCODE_DB` | `~/.elitza/home/data/elitza.db` |

It also sources `~/.elitza/.env` with `set -a`, so every variable you put there (like `OPENROUTER_API_KEY`) reaches the process, then execs `~/.elitza/agent/elitza`. Always start Elitza through the launcher. Run the bare binary and config, sessions and logs fall back to machine-default paths.

## Platforms

CI builds four targets on every `v*` tag (`.github/workflows/release.yml`):

| Asset | Runner |
| --- | --- |
| `elitza-linux-x64.tar.gz` | ubuntu-latest |
| `elitza-linux-arm64.tar.gz` | ubuntu-latest |
| `elitza-darwin-arm64.tar.gz` | macos-latest |
| `elitza-darwin-x64.tar.gz` | macos-latest |

`packages/cli/script/build.ts` also lists windows targets, but CI does not build or smoke test them. macOS and Linux are what ships.

## First run

1. Type `/connect`. The integration dialog walks you through an OpenRouter key. Free keys are at <https://openrouter.ai/keys>. You can also drop `OPENROUTER_API_KEY=...` straight into `~/.elitza/.env`.
2. Type `/models` to pick a brain. Free `:free` OpenRouter endpoints sort to the top of the list (`packages/tui/src/component/dialog-model.tsx`).
3. Type `@` to pull a file into context, then send your first prompt.

Elitza ships with no API key and meters nothing. You always bring your own. Full command and TUI reference: [tui.md](tui.md).

## Run from source

Requires [Bun](https://bun.sh) 1.4.2 or newer (the root `package.json` pins `packageManager: bun@1.4.2`).

```bash
git clone https://github.com/dario-cositore/elitza-code
cd elitza-code
bun install
bun run dev        # run the TUI from source
bun run check      # lint + typecheck, from the repo root
```

Tests run per package, never from the root: `cd packages/tui && bun test`.

## Update

Re-run the one-liner. It resolves the latest release and swaps the binary in place. The built-in `elitza upgrade` stays gated off in this build and refuses to run unless `ELITZA_SELF_UPDATE=1` is set (`packages/cli/src/commands/handlers/upgrade.ts`).

## Uninstall

Two ways out:

```bash
elitza uninstall                     # interactive
curl -fsSL https://elitza.life/install.sh | bash -s -- --uninstall
```

| Command | What it removes | What it keeps |
| --- | --- | --- |
| `elitza uninstall` | Cache, background service registrations, the PATH line, the binary | Data, config and state: sessions, credentials, settings, prompt history (`packages/cli/src/commands/handlers/uninstall.ts`) |
| installer `--uninstall` | The launcher and `~/.elitza/agent` | `~/.elitza` unless you answer `y` to the prompt, so config and memories survive |

`elitza uninstall` accepts `--dry-run` to preview and `--force` to skip the confirmation prompt.

## See also

- [TUI guide](tui.md): commands, keybindings, session lifecycle
- [Configuration](configuration.md): config files, providers, environment variables
- [README: Install](../README.md#install), [README: Where things live](../README.md#where-things-live)
