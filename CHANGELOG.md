# Changelog

## 1.1.3 — 2026-10-26

MiMo-only purge, code side.

- **OpenRouter, Ollama and Zenmux (zen/managed inference) providers removed**: their plugin registration, plugin files and tests are gone. Elitza no longer ships or seeds any of those endpoints.
- **models.dev catalog seeding removed**: `ModelsDevPlugin` is no longer registered, so the engine no longer seeds non-MiMo providers/models. The only selectable model family is Xiaomi MiMo (`elitza/xiaomi/mimo-v2.6-flash`).
- **Free-model router dropped**: the TUI model dialog no longer filters OpenRouter `:free` endpoints or sorts "Free" models first; the managed Zen/Go providers stay rejected. The sidebar onboarding copy no longer points at OpenRouter.
- **Scout fixture**: brain smoke now uses the MiMo model string instead of an OpenRouter dummy.
- **Scouting rebuilt for stability**: Photon (Komoot, OSM-backed full-text) is now the primary source with the OSM API for tag enrichment; Overpass (mirror list) and Google Places remain fallbacks. Added retry with backoff, in-memory caching (production only), area + trade-tag filtering, and OSM-API enrichment. Overpass is no longer the single point of failure.
- **Fuzzy dedup in scouting**: OSM-only entries (no phone/website/address) now merge with their Google-Places-enriched counterparts via normalized name containment, Levenshtein distance, address similarity and shared postcode. Stops duplicate rows like "Pesadori" vs "Lafarmacia. Pesadori".
- **Production advance is idempotent**: re-running `advance` on the stage a client already stands on (e.g. disposition already moved them to `diagnose`) records the note/asset instead of throwing "already stands".
- **Handover refuses non-git folders**: `generateHandover` now throws a clear error when the repo has no `.git` directory, instead of silently writing a thin document. Updated the tool description accordingly.
- **CRM "house" web view** (`src/crmview.ts` + `src/crmview.html`): zero-build, single-page dashboard served on http://127.0.0.1:8787. Pipeline Kanban board, client detail with timeline/assets, approval queue (approve/send drafts), and a scout screen that adds results to the CRM. Reuses the exact same brain modules (crm, outreach, production, scouting) via a small JSON API. Loads ~/.elitza/.env automatically. **Auto-starts with the engine** (brain plugin setup hook) and stops when the engine stops — no separate process to manage. Standalone launcher remains at `script/crm-view.ts`.
- **Client enrichment** (`src/enrichment.ts`, `enrich_client` tool): fetches the client's own site (homepage plus common subpages), extracts emails, phones and social profiles, then runs MiMo over your playbooks to write a diagnosis, a scoped proposal, a price band and a risk assessment back into the CRM — plus `diagnosis.md` and `proposal.md` assets. Nothing is sent to the client.
- **Social profiles on every client**: `linkedin`, `twitter`, `facebook` and `instagram` columns on `clients` (schema + `ALTER TABLE` migration for existing databases), written by enrichment and by the `crm` tool. The house detail view has a Social block with one input per network, a Save button and clickable chips.
- **Everything clickable in the house**: website, email (`mailto:`), phone (`tel:`), address (Google Maps), scout results, enrichment output and any URL inside notes or reports render as real anchors; draft paths open in the asset viewer and queue rows open the client. Shared `webLink` / `mailLink` / `telLink` / `mapsLink` / `linkify` helpers replace the inline anchor strings.

## 1.1.2 — 2026-10-25

Keys know their own endpoint.

- **Key-type aware setup**: `sk-` (standard API) and `tp-` (Token Plan) MiMo keys are digested by their prefix. A standard key always verifies against `api.xiaomimimo.com`; a Token Plan key probes the Token Plan regions and runs on the one that accepts it, whatever the earlier endpoint answer said. The chat interview re-opens the region question when a `tp-` key lands without one. A correct key can no longer fail with "Invalid API Key" just because it met the wrong endpoint.

## 1.1.1 — 2026-10-25

Key safety and keyless scouting.

- **Wizard sentinel fix**: deferring a key in setup (answering "not now") no longer writes that placeholder over `XIAOMI_API_KEY` or `MATON_API_KEY` on the next boot. Deferred keys are left alone; real ones keep their 600-permission files.
- **Keyless scouting on OpenStreetMap**: `client_scout` runs Overpass as the primary source (Italian trade-to-tag mapping, city and province scoping, contact-tag hygiene) with cross-source dedup and `meta.sources_used`. Google Places is now an optional enrichment layer: add your own `GOOGLE_MAPS_API_KEY` and it joins the waterfall, otherwise scouting still works with zero keys. Never invents contact details.
- **CI restored for `@elitza/ui`**: the solid-js test preload dropped in the rebrand fork is back, so the test suite runs green again.

## 1.1.0 — 2026-10-25

The AI Enablement operator: the same binary, now built around finding, contacting and delivering client work.

- **First-boot setup wizard**: setup now opens as popups over the composer, not only as a chat interview. It auto-opens on the first start while setup is unfinished and walks the MiMo signup (affiliate link, invite code `HFSR94`, regional endpoint), a masked key paste with a live verify ping, then the persona and permission-gate questions. Esc on the welcome screen postpones it until `/setup`, progress is saved after every step, and the finished run writes a mode-600 hand-off file the engine applies on your first message. `/setup` reopens it — with a start-over confirm once complete — and `/start` stays as the in-chat fallback.
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
