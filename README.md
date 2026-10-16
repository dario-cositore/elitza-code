<p align="center">

```
█████ ██    █████ █████ █████  ███
██    ██     ██    ██    ██ ██ ██
█████ ██     ██    ██    ██   █████
██    ██     ██    ██   ██    ██ ██
█████ █████ █████  ██   █████ ██ ██
```

</p>
<p align="center"><b>The AI agent that grows with you.</b></p>
<p align="center">
Free models. Bring your own key. Her memories, her skills — on your machine.<br>
<a href="https://elitza.life">elitza.life</a>
</p>

## Why Elitza

- **Free by design.** Elitza runs on free `:free` OpenRouter models or any provider key you already own (BYOK). No
  subscriptions, no bundled API keys, no inference resold to you.
- **She remembers.** A real brain: SQLite-backed memory (`soul.db`), personas for the people she works with, and skills
  she writes herself as tasks complete.
- **A proper terminal app.** Full-screen TUI with sessions, subagents, LSP, file references, shell mode, diffs, and a
  plugin system.
- **Private and local.** Keys, config, sessions and memory live under `~/.elitza`. Nothing phones home.

## Install

```bash
curl -fsSL https://elitza.life/install.sh | bash
```

Then start her:

```bash
elitza
```

First run teaches the rest — type `/connect` (or `/models`) to link a **free** OpenRouter key from
https://openrouter.ai/keys. Elitza never ships or embeds a key; you always bring your own.

## Commands

| Command               | What it does                              |
| --------------------- | ----------------------------------------- |
| `elitza`              | Open the TUI in the current project       |
| `elitza "prompt"`     | Start a session with an initial prompt    |
| `elitza run "prompt"` | Run headless and print the result         |
| `elitza mini`         | Minimal footer-only mode                  |
| `elitza -c`           | Continue the most recent session          |

Inside the TUI: `/models` picks the brain (free OpenRouter `:free` endpoints or your own provider key), `/connect`
walks you through BYOK setup, `/new` starts a fresh session, and `ctrl+p` opens the command palette.

## Paths

| Path                        | What lives there                             |
| --------------------------- | -------------------------------------------- |
| `~/.elitza/agent`           | The agent itself (installed release)         |
| `~/.elitza/brain`           | `soul.db`, `persona/`, `procedural/` skills  |
| `~/.elitza/opencode`        | Config + session database                    |
| `~/.elitza/SOUL.md`         | Her core identity — edit to make her yours   |

## Run from source

```bash
git clone https://github.com/dario-cositore/elitza-code
cd elitza-code
bun install
bun run dev
```

Requires [Bun](https://bun.sh) 1.4.2+.

## Heritage & license

Elitza is a fork of the [OpenCode](https://github.com/anomalyco/opencode) terminal agent, rebranded and reworked
end to end for a free-model, bring-your-own-key life. Licensed under the MIT License — see [LICENSE](./LICENSE).
Elitza branding and product design are separate from the upstream project.
