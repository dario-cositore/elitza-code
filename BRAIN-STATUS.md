# Elitza Brain Port — Status (working log, uncommitted)

Branch: `opencode-fork` · Workspace: `~/.openclaw/workspace/2. Elitza Ecosystem/3. Elitza/.elitza/agent/`
Production: `~/.elitza/` (synced by `~/.local/bin/elitza-deploy`)

## ✅ INTEGRATION FULLY VERIFIED (2026-10-16) — success path included

The brain plugin `packages/plugins/elitza-brain` runs end-to-end against a mock
provider, proven **on the wire** (captured requests in the mock harness):

1. **Loading**: entrypoint must be `<dir>/index.ts` (root re-export;
   `Host.resolve` ignores package.json exports and silently drops dir-only src/).
2. **Tools**: all **16** brain tools registered as **direct** model tools —
   requires `options: { codemode: false }` (else they hide behind the `execute`
   CodeMode catalog). Verified: 28 tools in the model request (16 brain + 12 core).
3. **Hooks** (observed live):
   - `session.prompt` → emotion shift + auto-remember user turn ✓
   - `session.context` → brain block (`<!-- elitza-brain -->` + SOUL.md) appended to
     system prompt ✓ — **captured in the actual model request**.
     This is THE request path; `session.generate` never fires (onThink lives in context).
   - `session.execution.succeeded/failed/interrupted` → finalize turn
     (deprecated `session.idle` kept as deduped fallback) ✓
4. **Tool round-trip**: mock issued `tool_calls: brain_stats` → engine executed
   (`tool=brain_stats status=completed`) → result ("## Brain Statistics…") returned
   to the model in the continuation request ✓
5. **Success-path learning**: assistant episodic stored (keyword→importance),
   2 semantic learnings auto-extracted, emotional memory written,
   `confidence 0.70→0.71` (+0.01 ✓), `preferences={"brain_stats":1}` ✓,
   `learnings=[{…used brain_stats}]`, emotion → "accomplished"/calm valence +0.2 ✓
6. **Failure path** (earlier): `execution.failed` → confidence −0.02, valence −0.2
   — legacy formulas exact.
7. Title agent runs concurrently and does not interfere ✓
8. Prompt text arrives raw (earlier "quoted prompt" was a test-shell artifact —
   verified with a quote-free prompt) ✓
9. `bun run script/smoke.ts` → all assertions passed ✓

## Mock harness (kept for regression tests) — `/tmp/opencode/brain-mock/`

- `mock-llm.ts` — fake OpenAI-compatible server, port 8971; records all requests
  to `requests.json`; round 1 (main agent w/ brain tools) → `brain_stats` tool call,
  round 2 → content (auto-learning trigger); title agent → short title.
  Start: `~/.bun/bin/bun /tmp/opencode/brain-mock/mock-llm.ts &`
- `run.sh` — launcher clone → isolated config/data/brain (production untouched).
- `config/opencode.json` — mock provider config.

### Fixed bug (root cause found): provider config key
Config `provider` (singular) routes through the **V1→V2 migration**
(`core/src/config/normalize.ts:168` → `migrateProviders` → `v1/config/migrate.ts:111`)
which reads V1 field names (`npm`, `api`, `options`) — V2 fields (`package`,
`settings`) decode to `undefined` and are **silently dropped** (only name+models
survive) → provider unusable → model routing falls back to another provider.
**Correct form: `providers` (plural) with `package` + `settings`.**
Schema: `packages/schema/src/config.ts:112`.

## Blocked / pending

- **OpenRouter key expired** (`~/.elitza/.env`) — real end-to-end needs a fresh key
  (user action: renew at openrouter.ai).
- TUI visual confirmation needs the user to run `elitza`.
- Judgment call already flagged: companion chat-length rules deliberately omitted
  from injected context (would cripple the coding agent).

## ✅ FINAL PORT SLICE COMPLETE (2026-10-16) — all 16 legacy tools + learning

New modules in `packages/plugins/elitza-brain/src/`:

- **`learning.ts`** — `auto_learning.py` port: skill detectors (chain/combo/
  problem-solving/code), knowledge extractors (definition/rule/best-practice/
  technical/config with secret filter), `[LESSON]` episodics, emotional events,
  conversation compression (`[CONVERSATION]` episodic + `brain/conversations/*.json`),
  `learning_stats` in soul. Wired into finalize with per-turn `toolRuns` captured
  in `execute.after` (result text capped 1500 chars / error message).
  Runs for success+error outcomes only (interrupted returns early, same boundary
  as evolveSoul).
- **`sessions.ts`** — `persistence.py` port: `recentSessions`, `searchMessages`
  (LIKE over `session_message.data`, newest first), `persistenceStats` — all on
  `OPENCODE_DB` readonly (plugin SessionDomain lacks `list`/`search`).
  `ENGINE_DB` = `OPENCODE_DB` env → `XDG_DATA_HOME/opencode/opencode.db` fallback.
- **`doctor.ts`** — `doctor.py` port: 9 checks (databases quick_check incl. engine
  db, brain, config, tools, plugins entrypoints, hooks, sessions, disk via
  `statfsSync`, permissions), health.db `health_checks`/`repairs` schema,
  repairs (integrity→VACUUM, FTS rebuild, dir creation, old logs),
  `doctorCheck`/`doctorRepair`/`doctorHistory` markdown reports.
- **`configview.ts`** — `config_summary`/`validate_config` rebuilt on opencode.json
  (identity/model/personality/tools/brain/sessions/MCP sections), section lookup
  with legacy `Section 'x' not found` message, recursive **secret redaction**
  (`api_key|token|secret|password|authorization|credential` → `[redacted]`).

**Verified**: plugin `bun run typecheck` green (fixed pre-existing bun:sqlite
binding-type errors across memory.ts/soul.ts — array form `run(sql, [args])`,
`query<Row, Params>` two type args), extended `script/smoke.ts` green (16-tool
deep-equal, each tool executed, learning/sessions/config/doctor assertions),
mock integration re-run green: 28 tools on the wire, `tool=brain_stats
status=completed`, finalize `learn: knowledge=1 lessons=[error_encounter,
error_resolution] compressed=true emotions=[accomplished]`, `[LESSON]` ×2 +
`[CONVERSATION]` + `learning_stats` + `conversations/<sid>.json` on disk, no
skipped registrations.

Legacy reference: `/tmp/elitza-legacy/` (re-extract from branch
`legacy-python-rust` if wiped). Branch `legacy-python-rust` unpushed — keep
until user says prune.

## Session 2026-10-16 — Live key, /models curation, rebrand sweep

**Live end-to-end (first real OpenRouter run).** Fresh key in `~/.elitza/.env`
(`OPENROUTER_API_KEY`, $1 limit, no expiry, 1000 free-model req/day — free
models bill $0 so the limit is untouched). Real `elitza run --standalone` with
brain debug: live model did `brain_search → brain_create → brain_search`
(verify), finalize `outcome=success tools=[brain_search,brain_create,
brain_search] learn: skills=[tool-chain] knowledge=1 compressed=true
emotions=[accomplished]`, memory `2d0eaa05d265b029` persisted in
`~/.elitza/brain/soul_v2.db`. Full chain verified against the real API.

**Default model** switched in `~/.elitza/opencode/config/opencode.json`:
`nvidia/nemotron-3-ultra-550b-a55b:free` hung >110s consistently; now
`openrouter/nvidia/nemotron-3-super-120b-a12b:free` (~1s, `tool_call: true`).
Always pick free models that respond — test with a raw curl first.

**/models list = BYOK + OpenRouter free endpoint only.**
`packages/tui/src/component/dialog-model.tsx` filters the dialog's `models()`
memo through `offered()`: hides `opencode`/`opencode-go` (Zen is force-enabled
via `activation: "enabled"` in `plugin/provider/opencode.ts` but the gateway
rejects non-official clients), shows only `:free` ids for `openrouter`, passes
everything else through (server-side `Provider.snapshot()` availability already
restricts catalog providers to connected integrations — BYOK). Covered by
`packages/tui/test/model-offering.test.tsx` (fixture: zen free, openrouter
free+paid, BYOK demo provider → asserts only free+BYOK visible). Note:
openrouter stays `:free`-only even when a key is present (product decision —
revisit if paid OpenRouter models should show for connected BYOK keys).

**Rebrand sweep (found + fixed).** Pre-existing test failures were stale
rebrand debt — runtime said "elitza"/"Elitza" but tests expected "opencode".
While fixing those, found **real brand leaks in runtime UI** and fixed them:
17 user-visible strings "Elitza"→"Elitza" (permission prompt ×3, crash
screen ×4, update dialog ×4, error-investigation prompts ×2, terminal-pane,
slash `close`, storybook ×2, websearch label was already Elitza). Renamed the
built-in theme key `opencode`→`elitza` (theme/index.ts accessor now
`getElitzaTheme`, context/theme.tsx fallbacks, dialog-config default) — this
had a crash trap: config default theme name `"opencode"` went missing →
`parseTheme(undefined)` in every app fixture; fixed all defaults. Wire-level
identifiers left as `opencode` on purpose (basic-auth username, MCP clientInfo,
`ElitzaClient` SDK types, `opencode-theme*` storage keys).

**Verified**: full TUI suite **1491 pass / 0 fail / exit 0** (was 16-17
pre-existing fails), repo `bun run check` exit 0, production synced via
`elitza-deploy`. Uncommitted: dialog-model, ~20 test files, brand-string
sources, BRAIN-STATUS.md, plugin, bun.lock (branch `opencode-fork`).

**"API key expired." root cause + fix.** Dario's TUI error was NOT the .env key
(valid the whole time, verified via `/auth/key`). His 14:46 session had model
`opencode/mimo-v2.6-flash-free` persisted — Zen, force-available when signed out
(`activation: "enabled"` + `apiKey: "public"` in
`plugin/provider/opencode.ts`), whose gateway rejects non-official clients.
Fix at core: without credentials the fork now sets Zen `activation: "disabled"`
(never force-enable, no public key) → zen vanishes from availability, picker,
default fallback, and **old sessions pinned to zen models fall back to the
config default model** instead of erroring. Verified live: continuing
`ses_ebb3fba84f` (was mimo/zen) now runs
`nvidia/nemotron-3-super-120b-a12b:free`, exit 0. Upstream tests updated
(merged to one "disables zen without credentials so it never appears
available" test; output-only-cost test dropped — zen models are invisible
without credentials in this fork). Sidebar onboarding copy now teaches BYOK:
"Free models need a free OpenRouter key. Get one at openrouter.ai/keys, then
connect." Core suite: only 7 pre-existing load-sensitive fails (6
Session.shell timeouts + preload env — identical with change stashed, proven
baseline). Full TUI suite 1491/1491 green, root check exit 0, deployed.

**Scaling answer recorded**: users never share Dario's key — his key lives only
in his `~/.elitza/.env`; the installer ships no key. Each user brings their own
free OpenRouter key (BYOK): own quota (~1000 free-model req/day per account,
$0 cost), no competition. Minting per-user keys from Dario's account was
rejected: all keys meter one account pool + it's reselling (ToS) + fraud
surface. Path to sponsored quota = provider partnerships (OAuth per-user, the
Cline×Qwen model) after traction.

## Session 2026-10-16 (later) — Website interim dark + CLI sweep + self-update gate

**Website assessment (elitza.life).** Page + installer were fully stale: hero/meta
claimed "installs Python", requirements said "Python 3.11+ — or uv", one-liner's
`REPO="dario-cositore/elitza-agent"` is a pre-rename301 → elitza-code, download
buttons served legacy **v0.1.0** Python builds (published 2026-10-14 from the
legacy main), `elitza setup` doesn't exist in the fork, from-source showed
`uv/pip`, maintenance showed `update --check`/`--version` flags that don't exist.
**Decisions (Dario):** fork ships on **elitza-code main**; installer **taken down
now** (zero legacy installs); onboarding story changed on-page (no `elitza
setup` command) → `/connect` + free-key copy.

**Website edits (uncommitted, needs push to go live):** hero lede → "new engine —
installs paused" notice; Runtime row → "One binary"; meta + og:description
de-Pythonized; `hidden` on tablist, macOS panel and "Other ways to install"
section with `PAUSED (2026-10-16)` comment markers for the release pass; step 01
rewritten (openrouter.ai/keys + `/connect`, copy button updated). HTML validates
(well-formedness check clean). Untouched: user's local edits (`elitza installer/`,
`shop/`), maintenance section (still correct for existing legacy installs).

**CLI rebrand batch 2 (~30 strings) + two real leaks:**
- `stats.ts` heading `opencode stats` → `elitza stats`; footer `opencode.ai` →
  `elitza.life` (×2).
- Command-hint strings now say `elitza …`: updater retry hints (×6),
  `Usage: elitza service …` (×5), pair.ts (×6), server-process port hint,
  remote-tunnel, `elitza mini` TTY errors (×2), `elitza acp:` stderr prefix,
  commands.ts help descriptions (upgrade/uninstall/run/directory), uninstall/
  upgrade/pair/default handler intros, acp translate/error messages.
- Left as-is (wire identifiers): `Elitza.make` SDK types, `Symbol.for("opencode.plugin.v2.*")`,
  `Anomaly.Elitza` winget id, `opencode.` plugin-package filter, opencode.ai
  URLs (functional: schema + updater endpoints), "Elitza Go/Zen" product names.

**Self-update gate (critical):** `elitza upgrade`/update-dialog previously ran
Elitza's own updater → would replace Elitza with stock Elitza. Now:
`updater.check()` returns `unavailable` ("Self-update ships with Elitza's release
pipeline… elitza.life") so the TUI never prompts, and the `upgrade` handler fails
fast before any network/process detection. Escape hatch: `ELITZA_SELF_UPDATE=1`
(tests set it). Repoint at elitza-code releases when the release pipeline lands.

**Test debt fixed (first full CLI suite run ever):** initial run = 14 fails — 9
upgrade (gate; env added in test helper), stale rebrand expectations in
stats/debug-paths/debug-config/auth/mcp-auth/service-lifecycle/mini/
acp-lifecycle/pair-remote-consent tests (`opencode …` → `elitza …`; stats palette
cyan → Elitza orange `#FAB283`). **Final: CLI 338/338 pass, root check exit 0,
`elitza upgrade` gate proven live, production synced via elitza-deploy.**

**Release chain (next, each blocks the next):** ① commit fork (needs Dario's
go) → ② push `opencode-fork` → elitza-code main (+ push `legacy-python-rust`
backup) → ③ release binaries (`OPENCODE_CLI_NAME='elitza'` in
`packages/cli/script/build.ts`; archive = binary + brain plugin + config
template + soul/persona seed) → ④ rewrite install.sh (binary install, no key
embedded, first-run points at free OpenRouter key) → ⑤ un-hide + rewrite the
page's hidden sections (bun from-source, correct maintenance commands, version)
→ ⑥ commit + push website (deploys Cloudflare Pages).

## Release chain — shipped (2026-10-16 evening)

**Repo → GitHub main:** fork pushed to `github.com/dario-cositore/elitza-code`
main (fast-forward from legacy 6a62247). Stripped: 27 upstream workflows +
publish-python-sdk + setup-git-committer + CODEOWNERS, the root `install`
template, nix/sst infra, salesforce/, sdks/, the github-action page, specs/,
perf/, 23 translated READMEs, STATS.md, V2_HTTP_API_AUDIT.md. Rewrote
README/CONTRIBUTING/SECURITY/CHANGELOG for Elitza, emptied TEAM_MEMBERS,
root package.json → name `elitza` @ 1.0.0, bun.lock root workspace renamed.
Deferred (still upstream code, not user-visible on the landing page):
services/{www,changelog,files,update}, packages/{console,stats,web,posts,ai}.

**CI:** check.yml/test.yml retargeted to main on ubuntu-latest (unit suite +
service-lifecycle smoke + lib builds; upstream e2e/storybook dropped for v1).
New `.github/workflows/release.yml`: tag `v*` → matrix builds
(elitza-linux-x64/arm64 on ubuntu, elitza-darwin-arm64/x64 on macos;
OPENCODE_VERSION from the tag) → tarball `elitza-<target>.tar.gz` = binary +
elitza-brain source (node_modules/.turbo/script stripped) → idempotent
`gh release create | upload --clobber` with `-R` (re-tags replace assets).
All four build jobs green on the first tag run, including cross-arch.

**Build fixes CI caught:** service-smoke.ts resolved the old `opencode`
binary name; highlights.test.ts parsed the upstream CHANGELOG format
(fixture tests kept).

**Service ports (new):** Elitza builds default to her own managed ports —
latest 0xc142 (49474), local 0xc143 (49475) — upstream's latest port 0xc0de
is where a stock opencode service sits; both can now run on one machine.
service.test.ts updated.

**Stats palette:** unknown background (COLORFGBG unset — CI and most
terminals) renders Elitza orange instead of upstream cyan; palette resolves
per render (was module-load) and the test pins a dark background.

**Installer rewritten (elitza.life/install.sh + scripts/install-elitza.sh):**
zero Python. Detects os/arch → downloads `elitza-{os}-{arch}.tar.gz` from the
release (latest via API, pinned v1.0.0 fallback) → staged swap into
~/.elitza/agent (source checkouts protected behind --force) → smoke-runs
`--version` → seeds only what's missing (config with the free nemotron
default + brain plugin path, SOUL.md, .env with an empty OPENROUTER_API_KEY
slot, brain/personas dirs) → writes the ~/.local/bin/elitza launcher
(isolates OPENCODE_CONFIG_DIR/XDG_* under ~/.elitza/opencode, sources
~/.elitza/.env — mirrors production) → PATH wiring. Flags:
--version/--no-modify-path/--binary/--uninstall/--force. **Local E2E proven**
against a simulated release: fresh HOME → install → `elitza run` boots the
service on 49474, loads elitza-brain from the tarball WITHOUT node_modules
(all brain_* tools registered), creates soul_v2.db, and fails only with
"No model is available" (empty key — the expected pre-/connect state).

**Website (commit c9d8ee6, pushed — verified live):** install-pause banner
removed, OS tabs + "Other ways" un-hidden, direct downloads point at v1.0.0
assets, from-source = bun, maintenance = re-run the installer (self-update
stays gated, `ELITZA_SELF_UPDATE=1` escape hatch; the gated message now
points at the installer), meta description updated.

**Final state (2026-10-16 ~19:30):** tag v1.0.0 = commit 37b0da9; CI
release/check/test all green; GitHub release "Elitza v1.0.0" carries all four
tarballs (86–98 MB); the REAL installer run against the REAL release (fresh
HOME, no overrides) installed v1.0.0, booted the service on 49474, loaded
elitza-brain from the shipped tarball (all tools registered, soul_v2.db
created) and stopped only at the expected empty-key model error;
elitza.life serves the new installer and page with zero Python and zero
"paused" copy. Production (Dario's ~/.elitza) still runs the source deploy
via elitza-deploy — untouched by all of this.

## The heartbeat (2026-10-17) — she now lives between conversations

**What it is:** `packages/plugins/elitza-brain/src/heartbeat.ts` — a quiet loop
running inside the plugin host (in practice `elitza serve --service`). It wakes
the functions that existed as dead code and connects them, rather than
inventing anything new.

Two passes per tick (default cadence 30 min, `ELITZA_HEARTBEAT_MINUTES`, min 5):

- **TEND** — runs `consolidate()` (links related memories via shared tags and
  promotes episodic→semantic) + `pruneAll()` (new export; prunes all four types
  to their caps). Previously consolidation only ran if the model *volunteered*
  to call `brain_consolidate`, so production sat at 0 links / 0 consolidated
  forever. Idempotent, cheap, safe.
- **REFLECT** — calls the dormant `EmotionEngine.onSilence()` (loneliness now
  drifts during real silence) and, once idle >45 min and past a 4h cooldown,
  composes a genuine thought from `getFeelingStatement()` + the top memory,
  persists it on the soul (`heartbeat_reflection`), and injects it into the next
  system prompt as a "What's on your mind" block. Initiative in its safest form:
  a note to herself, surfaced in context. No network, no notifications.

**Wiring:** `startHeartbeat(emotion)` on setup → `noteInteraction()` in the
prompt hook (so the loop knows the silence ended) → `currentReflection()` in
`injectBrain` (so a thought surfaces) → `heartbeat.stop()` on cleanup.
`reflect()` is exported for the test; `currentReflection()` drops reflections
older than 7 days.

**Safety:** every tick is wrapped in try/catch — a heartbeat that throws can
never take down the host. Opt out with `ELITZA_HEARTBEAT=0`. Only writes to her
own files (`soul_v2.db`, `state.json`). Default ON.

**Verified:** `script/heartbeat-test.ts` (throwaway ELITZA_HOME) — links 0→40,
unconsolidated→0, 2 semantic promoted, loneliness 0.30→0.32 after 2h idle, a
real reflection composed ("It's been quiet. It's been 2 hours... I keep coming
back to: ..."), cooldown suppresses a second, surfacing returns it, stop() works.
Smoke test + full `bun run check` (36/36) green. Reflection is template+regex
(v1) — LLM-assisted distillation and the journal are the deferred "earn it"
steps. NOT committed to git yet (house rule: no commit/push without permission).

**Honest gaps this does NOT close (still open):** retrieval is keyword/FTS, not
semantic; personas remain unimplemented (empty dir only); the model still never
writes its own skill files (`maybeGenerateSkill` still unreachable); ordinary
assistant turns still aren't stored (only error-keyword ones). See the audit in
conversation for the full list.

## Housekeeping notes

- No commits/pushes without explicit permission.
- Kill stale servers **by PID** (`pkill -f` patterns match the shell's own command line).
- Stale test servers shadow config/code — check `ps` before trusting a run.
- `ELITZA_BRAIN_DEBUG=1` gates plugin logs → `/tmp/elitza-brain-debug.log`.
- Website repo updated only after CLI is done; install from https://elitza.life/.
- `/tmp` gets wiped between sessions — harness lives in `/tmp/opencode/` (recreate
  from this file + git-uncommitted sources if gone).
