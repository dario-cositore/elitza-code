# Changelog

## Unreleased

The AI Enablement operator: the same binary, now built around finding, contacting and delivering client work.

- **MiMo-only guided setup** (`/start`): affiliate signup with invite code `HFSR94` (10% off the first paid Token Plan order), regional endpoint choice, key stored mode 600, and a first-party `elitza` provider block written to `opencode.json`. OpenRouter and Ollama paths removed from the setup flow.
- **Client scouting**: `client_scout` runs Google Places Text Search on your own `GOOGLE_MAPS_API_KEY` (header, never URL) and returns name, address, phone, website, rating, review count and category. `crm find_email` reads a public address from the client's own site.
- **CRM database**: `~/.elitza/brain/crm.db` with `clients`, `client_interactions`, `client_assets` and a 14-status lifecycle from `scouted` to `done`, queried through the `crm` tool.
- **Outreach pipeline**: draft files under `~/.elitza/pipeline/<date>/` with the compliance footer written in, batch approval, Resend sending (`RESEND_API_KEY` + `RESEND_FROM`), a heartbeat cadence at +3 / +7 / +14 days, disposition (`yes` → production, `no`/silence → stale list) and an exhausted-cadence sweep. Nothing sends unapproved.
- **Production pipeline**: `production` tool over `diagnose → proposal → workbook → scheduled → payment → done`, with artifacts attached as CRM assets and every move logged as an interaction.
- **Playbooks**: six curated AI Enablement playbooks seeded into `~/.elitza/brain/procedural/` (never overwriting edits), registered as skills, read through the `playbook` tool.
- **Handover generator**: `handover` writes `CLIENT_SOP_HANDOVER.md` from git history, a tracked-source environment-variable name scan, package scripts and the live permission gates. Values are never written.
- **MCP defaults**: ten well-known servers (maton, cloudflare, github, filesystem, memory, fetch, postgres, sqlite, slack, time) registered as defaults; user configuration always wins.
- **Task tracker**: a DB-backed hierarchical task tree injected into the prompt each turn.
- **Documentation restructure**: [docs/README.md](docs/README.md) now indexes a **guide** (install, guided setup, first client, handover) and a **reference** (TUI, brain, configuration, architecture), and the README tells the AI Enablement story.

## 1.0.0 — 2026-10-16

First Elitza release.

- `elitza` CLI and TUI: sessions, subagents, LSP, shell mode, diffs, plugins
- Free-model-first model list: OpenRouter `:free` endpoints plus any BYOK provider — no bundled keys
- Elitza brain plugin: SQLite memory (`soul.db`), personas, procedural skills, `/brain` tools
- Branded end to end: ELITZA wordmark, orange brand theme token, `elitza mini` banners, Elitza update screens
- Self-update gated (`ELITZA_SELF_UPDATE=1` to enable); Zen/managed inference disabled without credentials
- `curl | bash` installer from https://elitza.life — seeds config, SOUL, and personas under `~/.elitza`
