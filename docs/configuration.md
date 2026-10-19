# Configuration

Elitza is configured by plain JSON files on disk plus a handful of environment variables. Nothing is hidden in a database, and `elitza debug config` shows exactly what she resolved.

Back to the [README](../README.md). See also [install](install.md) and [the brain](brain.md).

## Files she reads

| File name | Where |
| --- | --- |
| `elitza.json`, `elitza.jsonc` | Preferred names, JSONC comments allowed |
| `opencode.json`, `opencode.jsonc` | Same schema, kept for upstream compatibility |

Locations searched, from the machine to the session:

| Location | Purpose |
| --- | --- |
| Working directory | `./elitza.json(c)` next to where you run her |
| `.elitza/`, `.opencode/` | Project level configuration directories |
| `.claude/`, `.agents/` | Shared configuration directories, also honored |
| Global XDG config directory | Your personal defaults for every project |
| `/etc/opencode`, `/Library/Application Support/opencode`, `%ProgramData%\opencode` | System wide defaults |
| `/Library/Managed Preferences/<user>/ai.opencode.managed.plist` | macOS MDM managed settings, when deployed |
| `OPENCODE_CONFIG` | An explicit file to use instead of discovery |

Set `OPENCODE_CONFIG_DIR` to move the whole global config directory somewhere else. The installed launcher already points it at `~/.elitza/home/config`.

To see the result: `elitza debug config`.

## Providers

Provider definitions live under the plural key `providers`:

```jsonc
{
  "providers": {
    "mylocal": {
      "package": "@ai-sdk/openai-compatible",
      "env": "MYLOCAL_API_KEY",
      "settings": { "baseURL": "http://localhost:11434/v1" },
      "models": {
        "qwen3:8b": { "name": "Qwen3 8B" }
      }
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `package` | npm package that implements the provider |
| `env` | Environment variable name (or list) holding the key |
| `settings` | Timeouts, transport, encoding, compaction |
| `headers`, `body` | Extra request headers or body fields |
| `models` | Model entries with names, limits, costs and per model overlays |

<details>
<summary><b>Why not the singular <code>provider</code> key?</b></summary>

The singular `provider` key is the legacy v1 shape and is read through the v1 migration (`packages/core/src/config/normalize.ts`), which understands the old field names `npm`, `api` and `options`. Modern fields written under `provider` do not survive that decode. New configuration belongs under `providers`.
</details>

Free OpenRouter endpoints need no provider block: `openrouter` is built in, and `:free` models appear first in `/models`.

## Selecting a model

```jsonc
{
  "model": "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"
}
```

The short form is `provider/model`, optionally with a variant. The full form is an object:

```jsonc
{
  "model": { "providerID": "openrouter", "model": "some/model", "variant": "thinking" }
}
```

You can also switch at runtime with `/models`, `ctrl+x` then `m`, or `--model` on `elitza run`.

## Permissions

`permissions` is an ordered list of rules. Each rule has an action, a resource and an effect of `allow`, `deny` or `ask`:

```jsonc
{
  "permissions": [
    { "action": "tool.use", "resource": "shell", "effect": "ask" },
    { "action": "provider.use", "resource": "openrouter", "effect": "allow" }
  ]
}
```

| Action | Controls |
| --- | --- |
| `tool.use` | Individual tools such as `shell`, `write`, `webfetch` |
| `provider.use` | Which model providers may be called |
| `integration.use` | Which integrations may be used |

Tools can also be switched off wholesale, which is what this repository does for its own config:

```jsonc
{
  "tools": { "github-triage": false, "github-pr-search": false }
}
```

`--auto` approves anything that is not explicitly denied.

## MCP servers and plugins

```jsonc
{
  "mcp": {
    "filesystem": { "type": "local", "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."] }
  },
  "plugins": ["elitza-plugin-example"]
}
```

* `mcp` accepts a server per name: local servers with a `command`, remote servers with a `url`, plus `cwd`, `environment`, `timeout` and `protocol` where you need them (`packages/schema/src/mcp.ts`).
* `plugins` accepts npm packages or git specifiers, the same thing `elitza plugin add` writes for you.
* `/plugins` and `elitza plugin list|check|update|remove` manage them afterwards.

`elitza debug config` reports any key it rejected, so a typo never fails silently.

## Environment variables

| Variable | Effect |
| --- | --- |
| `ELITZA_HOME` | Root of the brain: memories, SOUL, personas (default `~/.elitza`) |
| `ELITZA_BRAIN_DEBUG` | Log hook and heartbeat activity to `/tmp/elitza-brain-debug.log` |
| `ELITZA_HEARTBEAT=0` | Turn the background memory heartbeat off |
| `ELITZA_HEARTBEAT_MINUTES` | Heartbeat cadence, default 30, minimum 5 |
| `ELITZA_SELF_UPDATE=1` | Allow the in app updater to replace the binary |
| `OPENROUTER_API_KEY` | OpenRouter key, usually set in `~/.elitza/.env` |
| `OPENCODE_CONFIG_DIR` | Global config directory override |
| `OPENCODE_CONFIG` | Explicit config file |
| `OPENCODE_DB` | Session database path (installed: `~/.elitza/home/data/elitza.db`) |
| `OPENCODE_DISABLE_AUTOUPDATE` | Block the upstream self updater |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` | Standard XDG roots, all isolated under `~/.elitza/home` by the installed launcher |
| `OPENCODE_PASSWORD` | Local service credential, injected by `bun run dev:live` |

## Paths at a glance

| Path | Source run | Installed |
| --- | --- | --- |
| Config | `$XDG_CONFIG_HOME` or `~/.config/opencode` | `~/.elitza/home/config` |
| Sessions | XDG data directory | `~/.elitza/home/data/elitza.db` |
| Brain | `~/.elitza/brain/soul_v2.db` (or `$ELITZA_HOME`) | same |
| Keys | `~/.elitza/.env` | same |
| Identity | `~/.elitza/SOUL.md` | same |

## A worked example

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
  "providers": {
    "mylocal": {
      "package": "@ai-sdk/openai-compatible",
      "env": "MYLOCAL_API_KEY",
      "settings": { "baseURL": "http://localhost:11434/v1" },
      "models": { "qwen3:8b": { "name": "Qwen3 8B" } }
    }
  },
  "permissions": [
    { "action": "tool.use", "resource": "shell", "effect": "ask" }
  ],
  "tools": { "websearch": false },
  "mcp": {}
}
```

Save it as `elitza.json` in a project, then run `elitza debug config` to confirm every value landed where you expected.

## See also

* [README](../README.md)
* [Install](install.md)
* [TUI guide](tui.md)
* [Architecture](architecture.md)
