# Configuration

Elitza reads JSON and JSONC config files from your project, your home directory and the system. One file drives the model, the tools, the permissions and the interface. The [README](../README.md) shows the paths; this page explains discovery, the provider key trap, every config surface and the environment variables.

## Where config comes from

| What | Where | Source |
| --- | --- | --- |
| File names | `opencode.json`, `opencode.jsonc`, `elitza.json`, `elitza.jsonc` | `packages/core/src/config/discovery.ts:12` |
| Project directories | `.claude/`, `.agents/`, `.elitza/`, `.opencode/` in the working directory, then every parent | `packages/core/src/config/discovery.ts:85` |
| System directory | `/etc/opencode` (Linux), `/Library/Application Support/opencode` (macOS), `%ProgramData%\opencode` (Windows) | `packages/core/src/config/discovery.ts:28` |
| Managed preferences | macOS MDM plists under `/Library/Managed Preferences` | `packages/core/src/config/discovery.ts` |
| Global directory | `$XDG_CONFIG_HOME/opencode`, default `~/.config/opencode` | `packages/util/src/global-roots.ts` |
| Global override | `OPENCODE_CONFIG_DIR` replaces the global directory | `packages/util/src/global.ts:79` |

Inside an installed Elitza the launcher points `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME` at `~/.elitza/home/config`, so that is your global config file. Next to your code, `./elitza.json` and `./.elitza/` are what she reads per project ([install.md](install.md)).

Load order runs lowest priority first: system policies, well-known sources, the global directory, explicit and direct files, project files, then content and managed settings. Project beats global. The system directory and MDM preferences load last and override everything. Scalar fields are replaced by the higher priority file, maps such as `providers` merge (`packages/core/src/config.ts`).

## Use the plural `providers` key

This is the one trap worth learning. Config providers use `providers`, with `package` and `settings` inside each entry:

```json
{
  "providers": {
    "local": {
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": { "baseURL": "http://localhost:8080/v1" }
    }
  }
}
```

The singular `provider` key is the old v1 format. It runs through a migration that expects the old field names (`npm`, `api`, `options`) and rewrites them to the new ones: `migrateProviders` in `packages/core/src/config/normalize.ts:168`, `migrateProvider` in `packages/core/src/v1/config/migrate.ts:111`. Decoding ignores excess properties (`onExcessProperty: "ignore"` in `packages/core/src/config/normalize.ts:44`), so `package` and `settings` written under `provider` are dropped with no diagnostic at all:

```json
{
  "provider": {
    "local": {
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": { "baseURL": "http://localhost:8080/v1" }
    }
  }
}
```

That block loads and produces an empty provider. Write `providers`. The plural key maps onto the schema in `packages/schema/src/config.ts:112` and `packages/schema/src/config/provider.ts`.

## What you can configure

| Surface | Key | Notes |
| --- | --- | --- |
| Default model | `model` | `"provider/model"` string or `{ providerID, model, variant }` (`packages/schema/src/config/model.ts`, normalized at `packages/core/src/config/normalize.ts:201`) |
| Providers | `providers` | `package`, `settings`, `headers`, `body`, `env`, `models` per entry (`packages/schema/src/config/provider.ts`) |
| MCP servers | `mcp.servers` | Entries carry `type: "local"` with a `command` array, or `type: "remote"` with a `url` (`packages/schema/src/config/mcp.ts`) |
| Plugins | `plugins` | npm registry or git package specifier, as a string or `{ package, options }` (`packages/schema/src/config/plugin.ts`, install path in `packages/cli/src/commands/handlers/plugin/add.ts`, resolution in `packages/util/src/npm.ts`) |
| Tool permissions | `permissions` | `{ action, resource, effect }`, `effect` is `allow`, `deny` or `ask`. The last matching rule wins, unmatched calls default to `ask` (`packages/schema/src/permission.ts`, evaluation in `packages/core/src/permission.ts`) |
| Policies | `policies` | `{ action, resource, effect }` where `action` is `provider.use`, `tool.use` or `integration.use`, matched against patterns like `shell:git *` (`packages/schema/src/config/policy.ts`, applied in `packages/core/src/config/plugin/policy.ts`) |
| Language servers | `lsp` | Schema in `packages/schema/src/config/lsp.ts`, validated by `packages/core/src/config/normalize.ts`. No code in this tree starts a language server: the browser LSP status query is a stub that returns an empty list (`packages/app/src/runtime/server/sync.tsx`), and Elitza registers no LSP tool (`packages/core/src/tool/plugin/` covers `read`, `write`, `edit`, `patch`, `grep`, `glob`, `shell`, `webfetch`, `websearch`, `question`, `skill` and `subagent`) |
| Agents | `agents`, `default_agent` | Override built-ins or define your own (`packages/schema/src/config/agent.ts`) |
| Update policy | `update` | `disable`, `notify` or `auto` (`packages/schema/src/config.ts`) |
| Shell, skills, instructions | `shell`, `skills`, `instructions`, `references` | Ambient paths and defaults (`packages/schema/src/config.ts`) |

The interface keys live in their own file: `cli.json` in the global config directory (`~/.elitza/home/config/cli.json` when installed). It holds `theme` (`name` and `mode`), `keybinds`, `leader.timeout`, `diffs`, `animations`, `highlights`, `mouse`, `cursor`, `session`, `tabs` and `terminal` (`packages/cli/src/config/config.ts`, schema in `packages/cli/src/config/schema.ts` built from `packages/tui/src/config/index.tsx`). `/settings` in the TUI edits this file ([tui.md](tui.md#slash-commands)).

Full server schema: `packages/schema/src/config.ts`.

## Environment variables

| Variable | What it does | Source |
| --- | --- | --- |
| `ELITZA_HOME` | Brain root. Defaults to `~/.elitza`; personas, hooks, roles and the brain database hang off it | `packages/plugins/elitza-brain/src/db.ts:19` |
| `OPENCODE_DB` | Session database path. The installed launcher sets `~/.elitza/home/data/elitza.db`; without it the path resolves under the data directory as `opencode.db` | `packages/cli/src/database-path.ts` |
| `OPENCODE_CONFIG_DIR` | Replaces the global config directory | `packages/util/src/global.ts` |
| `XDG_CONFIG_HOME` | Base for config, app subdirectory `opencode`, default `~/.config` | `packages/util/src/global-roots.ts` |
| `XDG_DATA_HOME` | Base for data, default `~/.local/share` | `packages/util/src/global-roots.ts` |
| `XDG_STATE_HOME` | Base for state, default `~/.local/state` | `packages/util/src/global-roots.ts` |
| `XDG_CACHE_HOME` | Base for cache, default `~/.cache` | `packages/util/src/global-roots.ts` |
| `ELITZA_SELF_UPDATE` | Set to `1` to un-gate the built-in updater, which stays off otherwise | `packages/cli/src/services/updater.ts`, `packages/cli/src/commands/handlers/upgrade.ts` |
| `OPENCODE_DISABLE_AUTOUPDATE` | `1` or `true` skips the background update check | `packages/cli/src/services/updater.ts` |

The app name inside the XDG directories is still `opencode` (`packages/util/src/global.ts`). Under an installed Elitza the launcher pins all four XDG bases plus `OPENCODE_CONFIG_DIR` and `OPENCODE_DB` under `~/.elitza/home`, so nothing leaks into machine-default paths ([install.md](install.md#what-the-launcher-does)).

## Databases

| Database | Path | Holds |
| --- | --- | --- |
| Sessions | `~/.elitza/home/data/elitza.db` when installed (`OPENCODE_DB`) | Sessions, messages, inbox items, credentials, projects, events, permissions and worktrees (`packages/cli/src/database-path.ts`, tables in `packages/core/src/session/sql.ts` and siblings) |
| Brain | `~/.elitza/brain/soul_v2.db` (`ELITZA_HOME` moves the root) | Episodic, semantic, procedural and emotional memories, recall log, session log (`packages/plugins/elitza-brain/src/db.ts`) |

The brain plugin reads the session database through the same `OPENCODE_DB` value (`packages/plugins/elitza-brain/src/sessions.ts`), so one variable moves both.

## A worked example

This is an example, not a recommended default. Drop it in `./elitza.json` for one project, or in `~/.elitza/home/config/` for everything.

```json
{
  "model": "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
  "providers": {
    "local": {
      "name": "My local endpoint",
      "package": "aisdk:@ai-sdk/openai-compatible",
      "env": ["LOCAL_LLM_API_KEY"],
      "settings": { "baseURL": "http://localhost:8080/v1" },
      "models": {
        "qwen-local": { "name": "Qwen local" }
      }
    }
  },
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "git status*", "effect": "allow" },
    { "action": "edit", "resource": "*", "effect": "ask" }
  ]
}
```

What each block does:

- `model` picks a free OpenRouter endpoint. `:free` models sort first in `/models` ([tui.md](tui.md)).
- `providers.local` adds an OpenAI-compatible endpoint on your machine. Select it with `/models`; `env` names the key she reads from `~/.elitza/.env`.
- `permissions` lets `git status` run without asking, and sends every other shell command and file edit to the permission gate. Rules evaluate in order and the last match wins.

## Check what loaded

```bash
elitza debug config
```

It prints the resolved configuration, so you can see which file won and whether your provider block survived. `/settings`, `/status` and `/debug` reach the same configuration from inside the TUI.

## See also

- [Install](install.md): installer flags, launcher environment, where config lands on disk
- [TUI guide](tui.md): `/settings`, `/models`, `/mcps` and `/plugins` in action
- [README: Where things live](../README.md#where-things-live), [README: Development](../README.md#development)
