/**
 * Elitza Brain — the Armory connector (Task 2b).
 *
 * Pulls tool schemas ONLY from the first-party registry at
 * hub.dariocositore.com (override with ARMORY_BASE_URL, e.g. a local
 * `wrangler pages dev` instance). The old community / dario_hub endpoints
 * are gone and are never contacted — the base URL is a single constant,
 * not a per-tool decision.
 *
 * Safety model (theswitcharoo.md Task 2 requirements):
 *
 *   runtime validation   every fetched entry is checked against the
 *                        ArmoryTool contract before it is shown or run;
 *                        anything malformed is refused, not repaired
 *   interactive confirm  execution is two-phase: the first run request
 *                        returns the exact command/URL + input for the
 *                        operator to READ; only a second call with
 *                        confirm=true (matching a pending request, 10
 *                        min TTL) executes
 *   what never runs      schema-preview status, client-build entries,
 *                        POST http (until the registry defines a body
 *                        contract), unvalidated input
 *   shell safety         command placeholders are single-quote escaped;
 *                        the rendered command runs through /bin/sh -c
 *
 * The first-party Playwright recipes in the registry (screenshot, pdf)
 * execute through this module — that is their delivery mechanism.
 */

import fs from "node:fs"
import { soulGet, soulSet } from "./soul.js"

const DEFAULT_BASE_URL = "https://hub.dariocositore.com"
const FETCH_TIMEOUT_MS = 10_000
const EXEC_TIMEOUT_MS = 60_000
const PENDING_TTL_MS = 10 * 60_000
const OUTPUT_TAIL = 4_000
const SLUG_PATTERN = /^[a-z0-9-]+$/

export interface ArmoryTool {
  id: string
  name: string
  summary: string
  docs: string
  version: string
  tier: string
  status: string
  first_party: boolean
  maintainer: string
  tags: string[]
  execution: Record<string, unknown>
  input_schema: Record<string, unknown>
  verification: Record<string, unknown>
}

function debug(message: string): void {
  if (!process.env.ELITZA_BRAIN_DEBUG) return
  try {
    fs.appendFileSync("/tmp/elitza-brain-debug.log", `${new Date().toISOString()} armory: ${message}\n`)
  } catch {
    // Logging is best-effort.
  }
}

function baseUrl(): string {
  return (process.env.ARMORY_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "")
}

// ---------------------------------------------------------------------------
// Runtime validation of the registry contract
// ---------------------------------------------------------------------------

const REQUIRED_STRING_FIELDS = ["id", "name", "summary", "version", "tier", "status", "maintainer"] as const

/**
 * Validate one raw registry entry against the ArmoryTool contract.
 * Returns the entry or null — a failed validation is a refusal, never a repair.
 */
export function validateArmoryTool(raw: unknown): ArmoryTool | null {
  if (!raw || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof value[field] !== "string" || !(value[field] as string).length) return null
  }
  if (typeof value.first_party !== "boolean" || value.first_party !== true) return null
  if (typeof value.docs !== "string") return null
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string")) return null
  if (!value.execution || typeof value.execution !== "object") return null
  const execution = value.execution as Record<string, unknown>
  if (typeof execution.kind !== "string") return null
  if (!value.input_schema || typeof value.input_schema !== "object") return null
  if ((value.input_schema as Record<string, unknown>).type !== "object") return null
  if (!value.verification || typeof value.verification !== "object") return null
  return value as unknown as ArmoryTool
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

interface RegistryPayload {
  registry_version: string
  policy: string
  count: number
  tools: ArmoryTool[]
}

/** Fetch + validate the full registry. Invalid entries are dropped, not repaired. */
export async function fetchRegistry(): Promise<RegistryPayload | null> {
  try {
    const response = await fetch(`${baseUrl()}/api/v1/registry`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) {
      debug(`registry HTTP ${response.status}`)
      return null
    }
    const body = (await response.json()) as Record<string, unknown>
    if (body.policy !== "first-party-only" || !Array.isArray(body.tools)) {
      debug("registry refused: bad policy or missing tools array")
      return null
    }
    const tools = body.tools.map(validateArmoryTool).filter((tool): tool is ArmoryTool => tool !== null)
    return {
      registry_version: String(body.registry_version ?? "?"),
      policy: String(body.policy),
      count: tools.length,
      tools,
    }
  } catch (error) {
    debug(`registry error: ${String(error)}`)
    return null
  }
}

/** Fetch + validate one tool by slug. */
export async function fetchTool(slug: string): Promise<{ tool: ArmoryTool } | { error: string }> {
  if (!SLUG_PATTERN.test(slug)) return { error: "invalid slug (lowercase letters, digits, hyphens only)" }
  try {
    const response = await fetch(`${baseUrl()}/api/v1/tools/${slug}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (response.status === 404) return { error: `unknown tool "${slug}" — fetch the list from /api/v1/registry` }
    if (!response.ok) return { error: `registry answered HTTP ${response.status}` }
    const tool = validateArmoryTool(await response.json())
    if (!tool) return { error: `tool "${slug}" failed contract validation — refusing to use it` }
    if (tool.id !== slug) return { error: `tool id mismatch (asked ${slug}, got ${tool.id}) — refusing` }
    return { tool }
  } catch (error) {
    return { error: `registry unreachable (${String(error)})` }
  }
}

// ---------------------------------------------------------------------------
// Execution planning (pure — decides WHAT would run, runs nothing)
// ---------------------------------------------------------------------------

export interface ExecutionPlan {
  display: string
  run: () => Promise<string>
}

function shellescape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function renderTemplate(template: string, input: Record<string, unknown>): { command: string } | { error: string } {
  let missing = ""
  const rendered = template.replace(/\{([a-z0-9_]+)\}/g, (_match, key: string) => {
    const value = input[key]
    if (value === undefined || value === null || value === "") {
      missing = key
      return ""
    }
    if (typeof value === "object") {
      missing = `${key} (structured values are not substituted into command templates)`
      return ""
    }
    return shellescape(String(value))
  })
  if (missing) return { error: `missing or invalid input for placeholder: ${missing}` }
  return { command: rendered }
}

function validateInput(schema: Record<string, unknown>, input: Record<string, unknown>): string | null {
  const required = Array.isArray(schema.required) ? schema.required.map(String) : []
  for (const key of required) {
    if (input[key] === undefined) return `missing required input: ${key}`
  }
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
  for (const [key, value] of Object.entries(input)) {
    const declared = properties[key]
    if (!declared) continue
    const type = declared.type
    const ok =
      type === "string"
        ? typeof value === "string"
        : type === "number"
          ? typeof value === "number"
          : type === "integer"
            ? typeof value === "number" && Number.isInteger(value)
            : type === "boolean"
              ? typeof value === "boolean"
              : type === "array"
                ? Array.isArray(value)
                : true
    if (!ok) return `input "${key}" must be ${String(type)}`
  }
  return null
}

/**
 * Decide what executing this tool with this input would do, without doing it.
 * Returns the operator-facing plan, or an error refusal.
 */
export function planExecution(tool: ArmoryTool, input: Record<string, unknown>): ExecutionPlan | { error: string } {
  if (tool.status !== "available") {
    return { error: `tool "${tool.id}" has status "${tool.status}" — only available entries are executable` }
  }
  const schemaError = validateInput(tool.input_schema, input)
  if (schemaError) return { error: schemaError }

  const execution = tool.execution as Record<string, unknown>
  const kind = execution.kind

  if (kind === "client-build") return { error: `tool "${tool.id}" is a client build — never executable from the registry` }

  if (kind === "http") {
    const method = String(execution.method ?? "GET")
    if (method !== "GET") return { error: `http method ${method} is not supported by the connector yet (GET only)` }
    const url = new URL(String(execution.url))
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined && typeof value !== "object") url.searchParams.set(key, String(value))
    }
    if (execution.auth === "bearer-env") {
      return { error: `tool "${tool.id}" needs auth from env ${String(execution.auth_env)} — set it first` }
    }
    return {
      display: `GET ${url.toString()}`,
      run: async () => {
        const response = await fetch(url, { signal: AbortSignal.timeout(EXEC_TIMEOUT_MS) })
        const body = (await response.text()).slice(0, OUTPUT_TAIL)
        return `HTTP ${response.status}\n${body}`
      },
    }
  }

  if (kind === "command") {
    const template = String(execution.template ?? "")
    const rendered = renderTemplate(template, input)
    if ("error" in rendered) return { error: rendered.error }
    return {
      display: rendered.command,
      run: async () => {
        const proc = Bun.spawn(["/bin/sh", "-c", rendered.command], {
          stdout: "pipe",
          stderr: "pipe",
          env: processSafeEnv(execution.env),
        })
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        const tail = (text: string) => text.slice(-OUTPUT_TAIL)
        return `exit ${code}\n${tail(stdout)}${stderr ? `\n[stderr]\n${tail(stderr)}` : ""}`
      },
    }
  }

  return { error: `unknown execution kind "${String(kind)}" — refusing` }
}

/** Pass only the env vars a tool declared it needs; never the full process env. */
function processSafeEnv(declared: unknown): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" }
  if (!Array.isArray(declared)) return env
  for (const name of declared.map(String)) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

// ---------------------------------------------------------------------------
// Two-phase execution (the interactive confirmation)
// ---------------------------------------------------------------------------

interface PendingRun {
  slug: string
  input: Record<string, unknown>
  display: string
  at: string
}

function pending(): PendingRun | null {
  try {
    const parsed = JSON.parse(soulGet("armory_pending", "null")) as PendingRun | null
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

/**
 * Execute a registry tool — two-phase on purpose.
 *
 * Phase 1 (confirm unset): plans, stores the pending request, and returns
 * the exact command/URL for the operator to read. Phase 2 (confirm=true):
 * executes only if the pending request matches this call and is fresh.
 * The plan is recomputed from a FRESH schema fetch in both phases.
 */
export async function armoryRun(
  slug: string,
  input: Record<string, unknown>,
  confirm: boolean,
): Promise<string> {
  const fetched = await fetchTool(slug)
  if ("error" in fetched) return fetched.error
  const tool = fetched.tool

  const plan = planExecution(tool, input)
  if ("error" in plan) return plan.error

  if (!confirm) {
    const request: PendingRun = { slug, input, display: plan.display, at: new Date().toISOString() }
    soulSet("armory_pending", JSON.stringify(request))
    return [
      `Ready to run "${tool.name}" (${slug} v${tool.version}, ${tool.tier}):`,
      "",
      `  ${plan.display}`,
      "",
      `Input: ${JSON.stringify(input)}`,
      "",
      "Nothing has run. Confirm by calling armory_run_tool again with confirm=true.",
      "The request expires in 10 minutes.",
    ].join("\n")
  }

  const stored = pending()
  if (!stored || stored.slug !== slug || JSON.stringify(stored.input) !== JSON.stringify(input)) {
    return "No matching pending request — call armory_run_tool once without confirm to review what would run."
  }
  if (Date.now() - Date.parse(stored.at) > PENDING_TTL_MS) {
    soulSet("armory_pending", "null")
    return "The pending request expired (10 min) — call again without confirm to review a fresh one."
  }

  soulSet("armory_pending", "null")
  debug(`executing ${slug}: ${plan.display}`)
  try {
    const output = await plan.run()
    return `Ran "${tool.name}" — ${plan.display}\n\n${output}`
  } catch (error) {
    return `Execution failed: ${String(error)}`
  }
}
