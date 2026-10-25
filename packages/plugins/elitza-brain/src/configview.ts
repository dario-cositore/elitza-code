/**
 * Elitza Brain — configuration views.
 *
 * Port of the legacy `config.py` `config_summary` / `validate_config` /
 * section lookup, rebuilt on the Elitza engine config (opencode.json) plus
 * the brain's own state. Secrets are never echoed.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { BRAIN_DIR, ELITZA_HOME, MAX_EPISODIC, MAX_SEMANTIC } from "./db.js"
import { getPersonality } from "./soul.js"

const SENSITIVE_KEY = /api[_-]?key|token|secret|password|authorization|credential/i

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[redacted]" : redact(val),
      ]),
    )
  }
  return value
}

export function engineConfigPath(): string {
  const dir =
    process.env.OPENCODE_CONFIG_DIR ??
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode")
  return path.join(dir, "opencode.json")
}

interface EngineConfig {
  model?: string
  providers?: Record<string, { name?: string; models?: Record<string, unknown> }>
  plugins?: unknown[]
  mcp?: { servers?: Record<string, unknown> }
  [key: string]: unknown
}

export function loadEngineConfig(): EngineConfig {
  const file = engineConfigPath()
  if (!fs.existsSync(file)) return {}
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as EngineConfig
  } catch {
    return {}
  }
}

function pluginVersion(): string {
  const file = path.join(import.meta.dir, "..", "package.json")
  if (!fs.existsSync(file)) return "0.1.0"
  const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string }
  return pkg.version ?? "0.1.0"
}

// ---------------------------------------------------------------------------
// Summary — legacy config_summary shape, engine-backed sections
// ---------------------------------------------------------------------------

export function configSummary(toolNames: string[]): string {
  const config = loadEngineConfig()
  const personality = getPersonality()
  const warnings = validateConfig()
  const providers = Object.keys(config.providers ?? {})
  const mcpServers = Object.keys(config.mcp?.servers ?? {})

  const lines = ["## Elitza Configuration"]

  lines.push("", "### Identity")
  lines.push("- Name: Elitza")
  lines.push("- Creator: Dario Cositore")
  lines.push(`- Version: ${pluginVersion()}`)

  lines.push("", "### Model")
  lines.push(`- Primary: ${config.model ?? "not set"}`)
  lines.push(`- Providers: ${providers.length}${providers.length > 0 ? ` (${providers.join(", ")})` : ""}`)

  lines.push("", "### Personality")
  lines.push(`- Mood: ${personality.mood}`)
  lines.push(`- Style: ${personality.style ?? "direct"}`)

  lines.push("", "### Tools")
  lines.push(`- Brain tools: ${toolNames.join(", ")}`)
  lines.push("- Engine tools: managed by Elitza")

  lines.push("", "### Brain")
  lines.push(`- Max episodic: ${MAX_EPISODIC}`)
  lines.push(`- Max semantic: ${MAX_SEMANTIC}`)
  lines.push("- Auto-learning: true")
  lines.push("- Consolidation: true")

  lines.push("", "### Sessions")
  lines.push("- Persistence: Elitza engine session store")
  lines.push("- Restore on start: true")

  lines.push("", "### MCP")
  lines.push(`- Servers: ${mcpServers.length}`)

  if (warnings.length > 0) {
    lines.push("", "### ⚠️ Warnings")
    for (const w of warnings) lines.push(`- ${w}`)
  }

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Section lookup — legacy brain_config(section) behavior
// ---------------------------------------------------------------------------

export function configSection(section: string, toolNames: string[]): string {
  if (!section) return configSummary(toolNames)

  const config = loadEngineConfig()
  const views: Record<string, unknown> = {
    identity: { name: "Elitza", creator: "Dario Cositore", version: pluginVersion() },
    model: {
      model: config.model ?? null,
      providers: Object.entries(config.providers ?? {}).map(([id, info]) => ({
        id,
        name: info.name ?? id,
        models: Object.keys(info.models ?? {}).length,
      })),
    },
    brain: {
      home: ELITZA_HOME,
      brain_dir: BRAIN_DIR,
      soul_db: path.join(BRAIN_DIR, "soul_v2.db"),
      max_episodic: MAX_EPISODIC,
      max_semantic: MAX_SEMANTIC,
      auto_learning: true,
      consolidation: true,
    },
    personality: getPersonality(),
    tools: { brain_tools: toolNames, engine_tools: "managed by Elitza" },
    plugins: config.plugins ?? [],
    mcp: redact(config.mcp ?? {}),
    sessions: { persistence: "Elitza engine session store", restore_on_start: true },
  }

  if (section in views) return JSON.stringify(redact(views[section]), null, 2)
  if (section in config) return JSON.stringify(redact(config[section]), null, 2)
  return `Section '${section}' not found in config.`
}

// ---------------------------------------------------------------------------
// Validation — legacy validate_config, engine config substituted
// ---------------------------------------------------------------------------

export function validateConfig(): string[] {
  const warnings: string[] = []
  const config = loadEngineConfig()

  if (!config.model) warnings.push("No model configured")
  // Mirrors onboarding's MIMO_MODEL — the provider entry only works with its key in the environment.
  if (typeof config.model === "string" && config.model.startsWith("elitza/") && !process.env.XIAOMI_API_KEY) {
    warnings.push("XIAOMI_API_KEY not set")
  }
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    warnings.push("GOOGLE_MAPS_API_KEY not set (Google Places fallback disabled; client_scout still works via OpenStreetMap)")
  }
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM) {
    warnings.push("RESEND_API_KEY / RESEND_FROM not set (outreach send is disabled)")
  }

  if (!fs.existsSync(BRAIN_DIR)) warnings.push(`Brain directory missing: ${BRAIN_DIR}`)

  const hooksDir = path.join(ELITZA_HOME, "hooks")
  if (!fs.existsSync(hooksDir)) warnings.push(`Hooks directory missing: ${hooksDir}`)

  const rolesDir = path.join(ELITZA_HOME, "roles")
  if (!fs.existsSync(rolesDir)) warnings.push(`Roles directory missing: ${rolesDir}`)

  const personasDir = path.join(ELITZA_HOME, "personas")
  if (!fs.existsSync(personasDir)) warnings.push(`Personas directory missing: ${personasDir}`)

  return warnings
}
