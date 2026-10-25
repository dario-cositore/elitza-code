<h1 align="center">Elitza</h1>

<p align="center">
  <b>The AI Enablement operator.</b><br>
  Scout local clients, qualify them in a CRM, run the outreach cadence and deliver implementation sprints from your terminal.
</p>

<p align="center">
  <a href="https://github.com/dario-cositore/elitza-code/releases"><img src="https://img.shields.io/github/v/release/dario-cositore/elitza-code?label=release&color=ff8700" alt="Release"></a>
  <a href="https://github.com/dario-cositore/elitza-code/actions/workflows/check.yml"><img src="https://img.shields.io/github/actions/workflows/check.yml?branch=main&label=ci" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-ff8700.svg" alt="MIT license"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-bun-1.4-ffd9a0.svg" alt="Bun 1.4"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-eeeeec.svg" alt="macOS and Linux">
  <img src="https://img.shields.io/badge/model-Xiaomi%20MiMo-ff8700.svg" alt="Model: Xiaomi MiMo">
</p>

<p align="center">
  <a href="https://elitza.life">elitza.life</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="docs/guide/install.md">Install</a> ·
  <a href="docs/guide/guided-setup.md">Guided setup</a> ·
  <a href="docs/guide/first-client.md">First client</a> ·
  <a href="docs/guide/handover.md">Handover</a> ·
  <a href="docs/reference/tui.md">TUI</a> ·
  <a href="docs/reference/architecture.md">Architecture</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

<p align="center">
  <img src="docs/assets/demo.gif" alt="Elitza running a full client engagement in the terminal" width="960">
</p>

<p align="center"><i>One prompt: a client scouted and qualified in the CRM, the first touch drafted as a file, batch-approved and sent, the workbook playbook consulted, the handover document generated.</i></p>

## What Elitza is

Elitza is a local agentic operator for selling and delivering AI enablement work to local businesses. You give her a town and a trade; she scouts the businesses, scores them, writes the first touch for your approval, runs the four-touch cadence, and once a client says yes, drives the job through proposal, call, payment and handover. She does the scoping paperwork you would otherwise do by hand.

Under the hood it is three things:

1. **A terminal app.** A fast, native TUI (and a browser UI and a desktop app for the same server) with real tool calling, streaming output and permission gates on every command and file write.
2. **A MiMo-only model client.** Her guided setup wires one provider, Xiaomi MiMo, on your own key. No OpenRouter path, no fallback, nothing bundled and nothing metered. The affiliate invite code `HFSR94` takes 10% off your first paid Token Plan order.
3. **A memory and an operating record.** A SQLite brain (`soul_v2.db`) with typed memories, personas and skills she writes herself, plus a separate CRM database (`crm.db`) holding clients, interactions, assets and the outreach pipeline.

Everything runs locally. Keys, config, sessions, memory and client records stay under `~/.elitza`. The only outbound traffic is to the model provider you configured, the Places lookup you asked for, the Resend call you approved, and release metadata.

## The AI Enablement loop

Every step is a tool she calls. Exactly one step reaches a human being, and it only goes out after you approve the batch.

| Stage | What happens | Tools |
| --- | --- | --- |
| Scout | location + query → name, address, phone, website, rating, category | `client_scout` |
| Qualify | score 0-100, dedupe, find a public email on their own site | `crm` |
| First touch | a draft file with the opt-out footer, waiting for your read | `outreach draft` |
| Approve, send | batch approval, then Resend posts it; stage, `last_contact` and the next touch are set | `outreach approve`, `outreach send` |
| Cadence | +3, +7, +14 days: the heartbeat drafts each follow-up in the same thread, you approve again | `outreach due`, `outreach queue` |
| Disposition | `yes` → production, `no` or silence → the stale list for nurture | `outreach dispose`, `outreach sweep` |
| Production | diagnose → proposal → workbook → scheduled → payment → done | `production` |
| Handover | `CLIENT_SOP_HANDOVER.md` written from git evidence and live gates | `handover` |

Playbooks for all of it (diagnosis, proposal, workbook library, call script, payment terms, handover) ship as skills she pulls in on her own: `playbook list`, `playbook read`.

Full walkthrough with real commands: [docs/guide/first-client.md](docs/guide/first-client.md).

## Highlights

**MiMo only, set up for you.**
First boot opens a setup wizard that walks you through the MiMo account (invite code `HFSR94`, 10% off the first paid Token Plan order), the endpoint for your region, and your key — masked as you type, stored mode 600, never echoed. No provider sprawl, no fallback to guess about.

**A CRM that is just a database.**
Clients, interactions and assets live in `~/.elitza/brain/crm.db` with a shared status lifecycle from `scouted` to `done`. Query it with `crm search`, patch it with `crm update`, read the story with `crm interactions`. It never enters the memory index.

**Nothing sends without you.**
Outreach is drafted to files under `~/.elitza/pipeline/<date>/` with the compliance footer already in. Approve a batch, then one command sends it. An unapproved row is refused with a reason, never a silent success.

**A memory that compounds.**
Memories are typed (episodic, semantic, procedural, emotional), scored for importance, decayed over time and consolidated when they prove useful. Personas, roles and hooks are plain directories of JSON and markdown you can read and edit.

**She tidies up on her own.**
A heartbeat runs between conversations: it consolidates and prunes the memory database, polls the local gapfeed radar into draft files, drafts the follow-ups that are due, and closes cadences that ran four touches in silence. During a long silence she writes a reflection that is waiting in the next session's prompt.

**Real tools, real permissions.**
Built-in tools: `read`, `write`, `edit`, `patch`, `grep`, `glob`, `shell`, `webfetch`, `websearch`, `question`, `skill`, `subagent` — plus the operator tools above (`client_scout`, `crm`, `outreach`, `production`, `playbook`, `handover`, `task`, the `brain_*` set, the `gapfeed_*` pair and the `doctor_*` repair set). Every shell command and file write can be gated by the permission policy you configure.

**Made for the terminal.**
Sessions and tabs, `@` file mentions, `/` command menu, shell mode, inline diffs with a file tree, a fuzzy command palette, theme tokens, and a storybook driven TUI test harness.

**More than a terminal.**
`elitza serve` starts the same API behind a browser UI, `elitza pair` prints one-time links to connect a browser or phone, and an Electron desktop shell renders the same app.

**Extensible.**
Plugins from npm or git, MCP servers (local and remote, with OAuth) with a baked-in default set (maton, cloudflare, github, filesystem, memory, fetch, postgres, sqlite, slack, time), and a plugin API for hooks, tools and TUI extensions.

## Install

macOS and Linux, x64 and arm64:

```bash
curl -fsSL https://elitza.life/install.sh | bash
```

Then start her:

```bash
elitza
```

Setup opens itself on first start as a popup wizard: it asks who she is, what she must never do, what needs your permission first, and walks the MiMo signup on your own key. Type `/setup` to run it again, or `/start` for the same interview in chat. Elitza never ships or embeds a key; you always bring your own.

The installer downloads a prebuilt binary plus the brain plugin, installs them at `~/.elitza/agent`, writes the `elitza` launcher into `~/.local/bin` and seeds your config, `SOUL.md` and personas. It is safe to re-run, and `--uninstall` reverses it. Full options: [docs/guide/install.md](docs/guide/install.md).

## Commands

| Command | What it does |
| --- | --- |
| `elitza` | Open the TUI in the current project |
| `elitza --prompt "text"` | Start a session that opens with an initial prompt |
| `elitza run "prompt"` | Run headless and print the result (`--format json`) |
| `elitza mini` | Minimal footer-only interface |
| `elitza -c` | Continue the most recent session |
| `elitza serve` | Start the v2 API and the browser UI |
| `elitza pair` | Print one-time links to connect a browser or app |
| `elitza models` | List every available model |
| `elitza auth login` | Add a provider or integration credential |
| `elitza mcp add` | Register an MCP server |
| `elitza plugin add` | Install a plugin from npm or git |
| `elitza session list` | List, export or delete sessions |
| `elitza service start` | Control the background server |
| `elitza upgrade` | Built in updater, gated off unless `ELITZA_SELF_UPDATE=1` (use the installer until then) |
| `elitza debug config` | Dump the resolved configuration |

<details>
<summary><b>Full command reference (17 subcommands)</b></summary>

| Command | Description |
| --- | --- |
| `run <message>` | One-shot non-interactive run, `--format json`, `--file`, `--model`, `--agent`, `--thinking` |
| `mini` | Minimal interactive interface |
| `serve` | v2 API + web server, `--port`, `--hostname`, `--cors`, `--service`, `--stdio` |
| `acp` | Agent Client Protocol server for editor integration |
| `api` | Send a raw request to the running server |
| `auth list\|login\|logout\|export\|import\|switch` | Credentials and BYOK integrations |
| `mcp list\|add\|auth\|logout` | MCP server management, local and remote, OAuth |
| `plugin list\|add\|check\|update\|remove` | Plugin management |
| `models` | List available models |
| `stats` | Shareable usage statistics |
| `session list\|delete\|export\|import` | Session management |
| `service start\|restart\|status\|stop\|get\|set\|unset` | Background server control |
| `pair` | One-time pairing links, `--remote` for a tunnel |
| `reload` | Reload configuration without a restart |
| `upgrade` / `uninstall` | Built in updater (needs `ELITZA_SELF_UPDATE=1`), or remove while keeping session data |
| `debug agents\|config\|paths` | Diagnostics |

Global flags: `--standalone` (private server), `--server <url>`, `--auto` (auto-approve permissions), `--session <id>`, `--continue`, `--prompt <text>`, `--log-level`, `--print-logs`, `--completions <shell>`.

</details>

## Inside the TUI

Type `/` in the composer for the command menu, `ctrl+p` for the fuzzy command palette, `@` to mention a file or skill, and `shift+tab` to cycle agents.

<details>
<summary><b>Slash commands</b></summary>

| Command | What it does |
| --- | --- |
| `/sessions` | Resume a session (aliases: `/resume`, `/continue`) |
| `/new` · `/clear` · `/rename` | Start fresh, wipe the transcript, rename the session |
| `/open` | Open a project or workspace |
| `/setup` · `/start` · `/profile` | Guided setup (popup wizard or in-chat interview), and the read-back of what it decided |
| `/models` | Pick the model (the guided setup leaves you on Xiaomi MiMo) |
| `/connect` | Add an integration or provider key |
| `/agents` · `/variants` | Switch agent, thinking and effort variants |
| `/mcps` · `/plugins` | Manage MCP servers and plugins |
| `/diff` | Diff viewer with file tree |
| `/terminal` | Embedded terminal pane |
| `/fork` · `/timeline` · `/compact` | Branch a session, browse its timeline, compact context |
| `/undo` · `/redo` · `/copy` · `/export` | Edit history, clipboard, transcript export |
| `/cd` · `/editor` · `/worktrees` | Jump to a directory, open the editor, manage worktrees |
| `/skills` | Browse the skills she has written |
| `/themes` · `/settings` · `/status` | Theme picker, settings, runtime status |
| `/pair` | Connect a browser or phone (alias `/web`) |
| `/highlights` · `/update` · `/reload` · `/restart` | Release notes, update, reload config, restart |
| `/stats` · `/debug` · `/help` · `/exit` | Usage, diagnostics, help, quit |

</details>

<details>
<summary><b>Composer and keybindings</b></summary>

| Input | Result |
| --- | --- |
| `@name` | Mention a file, directory or skill and pull it into context |
| `/name` | Run a slash command, with fuzzy filtering |
| `!command` | Drop into shell mode and run a command inline |
| `ctrl+p` | Command palette over every command and setting |
| `ctrl+o` | Session list |
| `ctrl+x` then `l` / `n` / `m` | Switch session, new session, switch model |
| `shift+tab` | Cycle agents |
| `esc` | Interrupt a running turn, press it twice |
| `tab` | Complete a file, command or mention |

</details>

## The brain

The brain plugin (`packages/plugins/elitza-brain`) gives her a persistent self:

- **Memory.** SQLite at `~/.elitza/brain/soul_v2.db`. Episodic (episodes, 1000 max), semantic (facts, 500), procedural (skills, 200) and emotional (300) memories, plus a full text index, a recall log and a session log. Memories carry importance and valence, decay on a schedule, and get consolidated when they cross the threshold.
- **The CRM.** SQLite at `~/.elitza/brain/crm.db`: `clients`, `client_interactions`, `client_assets` and the `pipeline` table with its cadence state. Deliberately a separate file, so client data stays out of the memory index and can be backed up or wiped on its own.
- **Identity.** `~/.elitza/SOUL.md` is her core personality in plain markdown, `~/.elitza/PERSONA.md` is what guided setup wrote about your answers. Edit either and she changes.
- **Personas, roles and hooks.** Directories of JSON and markdown under `~/.elitza` for who she is talking to, how she should behave, and what she should do on an event.
- **Playbooks.** Curated knowledge in `~/.elitza/brain/procedural/` — diagnosis, proposal, workbook library, call script, payment terms, handover. Seeded on load, never overwriting your edits, and registered as skills so she pulls the right one in herself. Your own `.md` files dropped in that folder join the library.
- **25 tools** exposed to the model: the `brain_*` memory set, `doctor_check` / `doctor_repair` / `doctor_history`, `gapfeed_query_signals` / `gapfeed_build_pipeline`, and the operator set `client_scout`, `crm`, `outreach`, `production`, `playbook`, `handover` and `task` (plus `rv_session` when the dual-mind API is configured).

Full reference: [docs/reference/brain.md](docs/reference/brain.md).

## Where things live

| Path | What lives there |
| --- | --- |
| `~/.elitza/agent` | The installed release (binary + brain plugin) |
| `~/.elitza/brain/soul_v2.db` | Memories, links, recall log, session log, tasks |
| `~/.elitza/brain/crm.db` | Clients, interactions, assets, outreach pipeline |
| `~/.elitza/brain/procedural/` | Playbooks (curated and auto-generated), one markdown each |
| `~/.elitza/pipeline/<date>/` | Outreach drafts waiting for your batch approval |
| `~/.elitza/SOUL.md` | Her identity. Edit to make her yours |
| `~/.elitza/personas`, `roles`, `hooks` | Persona, role and hook definitions |
| `~/.elitza/home/config` | Installed config (`opencode.json`) and service credential |
| `~/.elitza/home/data/elitza.db` | Session database for the installed copy |
| `~/.elitza/.env` | Provider keys (`XIAOMI_API_KEY`, `GOOGLE_MAPS_API_KEY`, `RESEND_API_KEY`, `MATON_API_KEY`), mode 600, loaded by the launcher |
| `./elitza.json`, `./.elitza/` | Per project configuration |

## Architecture

```mermaid
flowchart LR
    subgraph Clients
        TUI["packages/tui<br/>terminal"]
        WEB["packages/app<br/>browser"]
        DESK["packages/desktop<br/>electron"]
        CLI["packages/cli<br/>binary + launcher"]
    end

    subgraph Server
        API["packages/server<br/>v2 HTTP API"]
        CORE["packages/core<br/>sessions · tools · providers · config"]
        AI["packages/ai<br/>model + stream layer"]
    end

    subgraph Contracts
        SCH["schema"]
        PROTO["protocol"]
        CLIENT["client (generated)"]
    end

    subgraph Extensibility
        PLUG["plugin API"]
        BRAIN["elitza-brain plugin<br/>25 tools · hooks · SOUL.md"]
        MCP["MCP servers"]
    end

    TUI --> CLIENT
    WEB --> CLIENT
    DESK --> CLIENT
    CLI --> TUI
    CLI --> API
    CLIENT --> API
    API --> CORE
    CORE --> AI
    CORE --> PLUG
    PLUG --> BRAIN
    CORE --> MCP
    SCH --> CORE
    PROTO --> API
```

Three clients (terminal, browser, desktop) talk to one server. The server owns sessions, tools, providers and configuration, and plugins hang off the same host. Detailed package map and request flow: [docs/reference/architecture.md](docs/reference/architecture.md).

## Development

Requires [Bun](https://bun.sh) 1.4.2 or newer.

```bash
git clone https://github.com/dario-cositore/elitza-code
cd elitza-code
bun install
bun run dev        # run the TUI from source
bun run check      # lint + typecheck, run from the repo root
```

Tests run per package, never from the root: `cd packages/tui && bun test`. The brain plugin's own harness is `cd packages/plugins/elitza-brain && bun run script/smoke.ts` — it exercises memory, scouting, CRM, outreach, cadence, disposition, production, playbooks and the handover generator against a throwaway home. CI runs `bun run check`, `bun turbo test --affected`, a CLI build and a service smoke test on every push. Releases are built for linux x64/arm64 and darwin x64/arm64 when a `v*` tag lands.

More detail in [docs/reference/configuration.md](docs/reference/configuration.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## FAQ

<details>
<summary><b>What does it cost?</b></summary>

The software is MIT licensed and costs nothing. Inference runs on your own Xiaomi MiMo key: the guided setup signs you up through invite code `HFSR94`, which takes 10% off your first paid Token Plan order. Google Places and Resend also run on your own keys, so every cost stays visible on accounts you control.
</details>

<details>
<summary><b>Where does my data go?</b></summary>

Nowhere but your machine. Keys, config, sessions, memory and the CRM live under `~/.elitza`. The only outbound connections are the model provider you configured, Places searches you run, Resend posts you approved, and release metadata when you install or update. There is no analytics or telemetry client in the tree.
</details>

<details>
<summary><b>Will it email people without me?</b></summary>

No. Every message is a file under `~/.elitza/pipeline/<date>/` first. Only drafts you approve in a batch can be sent, an unapproved row is refused with a reason, and the compliance footer (public-listing reason, opt-out) is written in before you review it.
</details>

<details>
<summary><b>What is Elitza built on?</b></summary>

Elitza is a fork of the [OpenCode](https://github.com/anomalyco/opencode) terminal agent, rebranded and reworked end to end for one job: operating an AI enablement practice. New brain plugin, new CRM and outreach engine, new identity system, new defaults, new installer and a rebuilt command surface. Upstream credit stays in the license and in this sentence.
</details>

<details>
<summary><b>Can I use it with my own models?</b></summary>

The guided setup deliberately wires one provider, Xiaomi MiMo, so there is no fallback to debug and no key sprawl to manage. Underneath, the engine reads a standard OpenAI-compatible provider block in `opencode.json` — Elitza supports MiMo only, and that is the product decision, not a technical limit.
</details>

<details>
<summary><b>Windows?</b></summary>

The build pipeline can produce windows binaries, but only macOS and Linux are built and smoke tested in CI today. Track it in issues.
</details>

## Contributing

Bug fixes, AI enablement workflow improvements, brain and CRM improvements, and documentation are the changes most likely to land. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the ground rules and [AGENTS.md](AGENTS.md) for the repository conventions.

Security reports go through [GitHub Security Advisories](https://github.com/dario-cositore/elitza-code/security/advisories), never through public issues. See [SECURITY.md](SECURITY.md).

## Heritage and license

Elitza is a fork of [OpenCode](https://github.com/anomalyco/opencode), rebranded and reworked by Dario Cositore. Licensed under the MIT License, see [LICENSE](./LICENSE). Elitza branding and product design are separate from the upstream project.

<p align="center">
  <a href="https://elitza.life"><b>elitza.life</b></a> ·
  <img src="https://img.shields.io/github/stars/dario-cositore/elitza-code?style=flat&label=stars" alt="Stars">
</p>
