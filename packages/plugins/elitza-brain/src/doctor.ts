/**
 * Elitza Brain — doctor: self-diagnostics and self-repair.
 *
 * 1:1 port of the legacy Python `doctor.py`: health checks across all
 * subsystems, automatic repairs, and health history persisted in
 * `brain/health.db`. Checks are adapted to the OpenCode engine world
 * (engine config, engine session store, engine plugin entries).
 */

import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import { BRAIN_DIR, ELITZA_HOME, db } from "./db.js"
import { loadEngineConfig, validateConfig } from "./configview.js"
import { ENGINE_DB, persistenceStats } from "./sessions.js"

export interface CheckResult {
  status: "ok" | "warning" | "error"
  message: string
  fix?: string
}

const HEALTH_DB = path.join(BRAIN_DIR, "health.db")

// ---------------------------------------------------------------------------
// Health database — legacy schema (health_checks + repairs)
// ---------------------------------------------------------------------------

function healthDb(): Database {
  fs.mkdirSync(BRAIN_DIR, { recursive: true })
  const conn = new Database(HEALTH_DB)
  conn.exec("PRAGMA journal_mode=WAL")
  conn.exec(`
    CREATE TABLE IF NOT EXISTS health_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      component TEXT,
      status TEXT,
      message TEXT,
      details TEXT,
      checked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS repairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      component TEXT,
      issue TEXT,
      fix_applied TEXT,
      success INTEGER,
      repaired_at TEXT
    );
  `)
  return conn
}

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

function checkDatabases(): CheckResult {
  const dbFiles = [
    path.join(BRAIN_DIR, "soul.db"),
    path.join(BRAIN_DIR, "soul_v2.db"),
    path.join(BRAIN_DIR, "persistence.db"),
    path.join(BRAIN_DIR, "conversations.db"),
    path.join(ELITZA_HOME, "sessions.db"),
    ENGINE_DB,
  ]
  const issues: string[] = []

  for (const file of dbFiles) {
    if (!Bun.file(file).size) continue
    try {
      const conn = new Database(file, { readonly: true })
      const result = conn.query("PRAGMA quick_check").values()[0]?.[0]
      if (result !== "ok") issues.push(`${path.basename(file)}: integrity check failed`)
      conn.close()
    } catch (error) {
      issues.push(`${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (issues.length > 0) {
    return {
      status: "error",
      message: `Database issues: ${issues.join("; ")}`,
      fix: "Run doctor_repair to fix database issues",
    }
  }
  return { status: "ok", message: "All databases healthy" }
}

function memoriesIn(file: string): number | null {
  if (!Bun.file(file).size) return null
  try {
    const conn = new Database(file, { readonly: true })
    const count = conn.query("SELECT COUNT(*) FROM memories").values()[0]?.[0]
    conn.close()
    return typeof count === "number" ? count : null
  } catch {
    return null
  }
}

function checkBrain(): CheckResult {
  const issues: string[] = []

  for (const file of [path.join(BRAIN_DIR, "soul.db"), path.join(BRAIN_DIR, "soul_v2.db")]) {
    const count = memoriesIn(file)
    if (count !== null && count === 0) issues.push(`No memories in ${path.basename(file)}`)
    if (count === null && Bun.file(file).size) issues.push(`${path.basename(file)} error: unreadable`)
  }

  const procDir = path.join(BRAIN_DIR, "procedural")
  if (fs.existsSync(procDir) && fs.readdirSync(procDir).filter((f) => f.endsWith(".md")).length === 0) {
    issues.push("No procedural skills generated yet")
  }

  if (issues.length > 0) return { status: "warning", message: `Brain issues: ${issues.join("; ")}` }
  return { status: "ok", message: "Brain healthy" }
}

function checkConfig(): CheckResult {
  const warnings = validateConfig()
  if (warnings.length > 0) {
    return {
      status: "warning",
      message: `Config warnings: ${warnings.slice(0, 3).join("; ")}`,
      fix: "Create missing directories or update the engine config",
    }
  }
  return { status: "ok", message: "Configuration valid" }
}

function checkTools(toolNames: string[]): CheckResult {
  if (toolNames.length === 0) return { status: "error", message: "No tools registered" }
  return { status: "ok", message: `${toolNames.length} tools registered` }
}

function checkPlugins(): CheckResult {
  const entries = (loadEngineConfig().plugins ?? []) as (string | { package?: string })[]
  const issues: string[] = []
  let dirs = 0

  for (const entry of entries) {
    const specifier = typeof entry === "string" ? entry : entry.package
    if (!specifier || !specifier.startsWith("/") && !specifier.startsWith(".") && !specifier.startsWith("~")) continue
    // Loader rule: a directory plugin must expose <dir>/index.* or <dir>/server.*.
    dirs++
    const files = fs.existsSync(specifier) ? fs.readdirSync(specifier) : []
    if (!files.some((f) => /^(index|server)\.(ts|js|mjs|cjs|tsx)$/.test(f))) {
      issues.push(`${path.basename(specifier)}: missing index.ts/server.ts entrypoint`)
    }
  }

  if (issues.length > 0) {
    return { status: "warning", message: `Plugin issues: ${issues.slice(0, 3).join("; ")}` }
  }
  if (dirs === 0) return { status: "ok", message: "No plugins configured (normal)" }
  return { status: "ok", message: `${dirs} plugins installed` }
}

function checkHooks(): CheckResult {
  const hooksDir = path.join(ELITZA_HOME, "hooks")
  if (!fs.existsSync(hooksDir)) {
    return { status: "warning", message: "Hooks directory missing", fix: `mkdir -p ${hooksDir}` }
  }
  return { status: "ok", message: `${fs.readdirSync(hooksDir).length} hooks configured` }
}

function checkSessions(): CheckResult {
  const stats = persistenceStats()
  if (typeof stats.error === "string") return { status: "error", message: `Session check failed: ${stats.error}` }
  return {
    status: "ok",
    message: `${stats.total_messages} messages, ${stats.total_sessions} sessions stored`,
  }
}

function checkDiskSpace(): CheckResult {
  try {
    const stat = fs.statfsSync(ELITZA_HOME)
    const freeGb = (stat.bavail * stat.bsize) / 1024 ** 3
    if (freeGb < 1) {
      return {
        status: "error",
        message: `Low disk space: ${freeGb.toFixed(1)} GB free`,
        fix: "Clean up old logs or databases",
      }
    }
    if (freeGb < 5) return { status: "warning", message: `Disk space getting low: ${freeGb.toFixed(1)} GB free` }
    return { status: "ok", message: `${freeGb.toFixed(1)} GB free` }
  } catch (error) {
    return { status: "warning", message: `Could not check disk space: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function checkPermissions(): CheckResult {
  const issues: string[] = []
  for (const dir of [BRAIN_DIR, path.join(ELITZA_HOME, "logs"), path.join(BRAIN_DIR, "procedural")]) {
    if (!fs.existsSync(dir)) continue
    try {
      fs.accessSync(dir, fs.constants.W_OK)
    } catch {
      issues.push(`${path.basename(dir)}: not writable`)
    }
  }
  if (issues.length > 0) return { status: "error", message: `Permission issues: ${issues.join("; ")}` }
  return { status: "ok", message: "Permissions OK" }
}

export interface HealthResults {
  timestamp: string
  overall: "healthy" | "degraded" | "unhealthy"
  checks: { component: string; status: string; message: string }[]
  issues: { component: string; message: string; fix?: string }[]
}

export function checkAll(toolNames: string[]): HealthResults {
  const results: HealthResults = {
    timestamp: new Date().toISOString(),
    overall: "healthy",
    checks: [],
    issues: [],
  }

  const checks: [string, () => CheckResult][] = [
    ["databases", checkDatabases],
    ["brain", checkBrain],
    ["config", checkConfig],
    ["tools", () => checkTools(toolNames)],
    ["plugins", checkPlugins],
    ["hooks", checkHooks],
    ["sessions", checkSessions],
    ["disk_space", checkDiskSpace],
    ["permissions", checkPermissions],
  ]

  for (const [name, check] of checks) {
    try {
      const result = check()
      results.checks.push({ component: name, status: result.status, message: result.message })
      if (result.status === "error") results.overall = "unhealthy"
      if (result.status !== "ok" && results.overall !== "unhealthy") results.overall = "degraded"
      if (result.status !== "ok") {
        results.issues.push({ component: name, message: result.message, fix: result.fix })
      }
    } catch (error) {
      results.checks.push({ component: name, status: "error", message: `Check failed: ${String(error)}` })
      results.overall = "unhealthy"
    }
  }

  try {
    const conn = healthDb()
    const now = new Date().toISOString()
    const insert = conn.prepare("INSERT INTO health_checks (component, status, message, checked_at) VALUES (?, ?, ?, ?)")
    for (const check of results.checks) insert.run(check.component, check.status, check.message, now)
    conn.close()
  } catch {
    // History persistence is best-effort.
  }

  return results
}

// ---------------------------------------------------------------------------
// Summary — legacy doctor_summary formatting
// ---------------------------------------------------------------------------

export function doctorCheck(toolNames: string[]): string {
  const results = checkAll(toolNames)

  const lines = ["## Elitza Doctor Report"]
  lines.push(`**Overall Status**: ${results.overall.toUpperCase()}`)
  lines.push(`**Checked at**: ${results.timestamp.slice(0, 19)}`)
  lines.push("")
  lines.push("### Health Checks")
  for (const check of results.checks) {
    const icon = check.status === "ok" ? "✓" : check.status === "warning" ? "⚠" : "✗"
    lines.push(`- ${icon} **${check.component}**: ${check.message}`)
  }

  if (results.issues.length > 0) {
    lines.push("")
    lines.push("### Issues Found")
    for (const issue of results.issues) {
      lines.push(`- **${issue.component}**: ${issue.message}`)
      if (issue.fix) lines.push(`  - Fix: ${issue.fix}`)
    }
  }

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Self-repair — legacy repair_all + repairers
// ---------------------------------------------------------------------------

interface RepairResult {
  component: string
  success: boolean
  message: string
  fixes: string[]
}

function repairDatabases(): RepairResult {
  const fixes: string[] = []
  const dbFiles = [
    path.join(BRAIN_DIR, "soul.db"),
    path.join(BRAIN_DIR, "soul_v2.db"),
    path.join(BRAIN_DIR, "persistence.db"),
    path.join(BRAIN_DIR, "conversations.db"),
  ]

  for (const file of dbFiles) {
    if (!Bun.file(file).size) continue
    const conn = new Database(file)
    try {
      const integrity = conn.query("PRAGMA integrity_check").values()[0]?.[0]
      if (integrity !== "ok") {
        conn.exec("VACUUM")
        fixes.push(`${path.basename(file)}: vacuumed`)
      }

      const ftsTables = conn
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'")
        .values()
        .map((row) => String(row[0]))
      for (const table of ftsTables) {
        try {
          conn.exec(`INSERT INTO ${table}(${table}) VALUES('rebuild')`)
          fixes.push(`${path.basename(file)}: rebuilt ${table}`)
        } catch {
          // Non-content FTS tables reject rebuild — legacy ignored these too.
        }
      }
    } finally {
      conn.close()
    }
  }

  if (fixes.length > 0) return { component: "databases", success: true, message: "Databases repaired", fixes }
  return { component: "databases", success: true, message: "Databases OK, no repairs needed", fixes }
}

function repairConfig(): RepairResult {
  const dirs = [
    path.join(ELITZA_HOME, "hooks"),
    path.join(ELITZA_HOME, "roles"),
    path.join(ELITZA_HOME, "personas"),
    path.join(ELITZA_HOME, "logs"),
    path.join(ELITZA_HOME, "plugins"),
    path.join(BRAIN_DIR, "procedural"),
    path.join(BRAIN_DIR, "episodic"),
    path.join(BRAIN_DIR, "semantic"),
    path.join(BRAIN_DIR, "conversations"),
  ]
  const fixes: string[] = []
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
      fixes.push(`Created ${path.basename(dir)}/`)
    }
  }
  if (fixes.length > 0) return { component: "config", success: true, message: "Config directories created", fixes }
  return { component: "config", success: true, message: "All directories exist", fixes }
}

function repairBrain(): RepairResult {
  try {
    const count = db().query("SELECT COUNT(*) FROM memories").values()[0]?.[0]
    if (count === 0) {
      return {
        component: "brain",
        success: true,
        message: "Brain checked",
        fixes: ["Memories table empty (will populate on next interaction)"],
      }
    }
    return { component: "brain", success: true, message: "Brain OK", fixes: [] }
  } catch (error) {
    return { component: "brain", success: false, message: `Brain repair failed: ${String(error)}`, fixes: [] }
  }
}

function repairHooks(): RepairResult {
  const hooksDir = path.join(ELITZA_HOME, "hooks")
  const events = [
    "pre_prompt",
    "post_response",
    "pre_tool_call",
    "post_tool_call",
    "pre_compact",
    "post_compact",
    "session_start",
    "session_end",
  ]
  const fixes: string[] = []
  for (const event of events) {
    const dir = path.join(hooksDir, event)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
      fixes.push(`Created hooks/${event}/`)
    }
  }
  if (fixes.length > 0) return { component: "hooks", success: true, message: "Hook directories created", fixes }
  return { component: "hooks", success: true, message: "Hook directories exist", fixes }
}

function repairLogs(): RepairResult {
  const logsDir = path.join(ELITZA_HOME, "logs")
  if (!fs.existsSync(logsDir)) return { component: "logs", success: true, message: "No logs directory", fixes: [] }

  const cutoff = Date.now() - 30 * 24 * 3600
  const fixes: string[] = []
  for (const file of fs.readdirSync(logsDir).filter((f) => f.endsWith(".log"))) {
    const full = path.join(logsDir, file)
    if (fs.statSync(full).mtimeMs < cutoff) {
      fs.unlinkSync(full)
      fixes.push(`Removed old log: ${file}`)
    }
  }
  if (fixes.length > 0) return { component: "logs", success: true, message: "Old logs cleaned", fixes }
  return { component: "logs", success: true, message: "Logs OK", fixes }
}

export function repairAll(): { success_count: number; fail_count: number; repairs: RepairResult[] } {
  const repairs: RepairResult[] = []
  let successCount = 0
  let failCount = 0

  for (const [name, repair] of [
    ["databases", repairDatabases],
    ["config", repairConfig],
    ["brain", repairBrain],
    ["hooks", repairHooks],
    ["logs", repairLogs],
  ] as [string, () => RepairResult][]) {
    try {
      const result = repair()
      repairs.push(result)
      if (result.success) successCount++
      else failCount++
    } catch (error) {
      repairs.push({ component: name, success: false, message: `Repair failed: ${String(error)}`, fixes: [] })
      failCount++
    }
  }

  return { success_count: successCount, fail_count: failCount, repairs }
}

/** Legacy doctor_repair tool formatting. */
export function doctorRepair(): string {
  const results = repairAll()
  const lines = ["## Repair Results"]
  lines.push(`**Success**: ${results.success_count}, **Failed**: ${results.fail_count}`)
  lines.push("")

  for (const repair of results.repairs) {
    lines.push(`- ${repair.success ? "✓" : "✗"} **${repair.component}**: ${repair.message}`)
    for (const fix of repair.fixes) lines.push(`  - Applied: ${fix}`)
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Health history — legacy get_health_history + doctor_history formatting
// ---------------------------------------------------------------------------

export function doctorHistory(days = 7): string {
  const conn = healthDb()
  const rows = conn
    .query<{ component: string; status: string }, [string]>(
      `SELECT component, status, message, checked_at
       FROM health_checks
       WHERE checked_at >= date('now', ?)
       ORDER BY checked_at DESC`,
    )
    .all(`-${days} days`)
  conn.close()

  if (rows.length === 0) return "No health check history found."

  const byComponent = new Map<string, { ok: number; warning: number; error: number }>()
  for (const row of rows) {
    const counts = byComponent.get(row.component) ?? { ok: 0, warning: 0, error: 0 }
    if (row.status === "ok") counts.ok++
    if (row.status === "warning") counts.warning++
    if (row.status === "error") counts.error++
    byComponent.set(row.component, counts)
  }

  const lines = [`## Health Check History (last ${days} days)`]
  for (const [component, counts] of byComponent) {
    lines.push(`- **${component}**: ${counts.ok} ok, ${counts.warning} warnings, ${counts.error} errors`)
  }
  return lines.join("\n")
}
