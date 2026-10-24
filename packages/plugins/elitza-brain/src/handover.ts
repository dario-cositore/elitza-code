/**
 * Elitza Brain — the SOP / handover generator (Task 3).
 *
 * Writes CLIENT_SOP_HANDOVER.md for a delivered job: what runs where, which
 * environment variables it needs (names only — values live in mode-600
 * files and never reach this document), how to run and check it, how to
 * recover, what needs a human yes, and who owns it afterwards.
 *
 * Everything in the document is read from evidence, never from memory of
 * the project:
 *
 *   git log / git status      what actually changed, when, by which commit
 *   git ls-files scan         environment variable names in tracked source
 *   package.json              scripts, license, name
 *   git remote                where the code lives
 *   engine config + soul      the approval gates that are really in force
 *
 * Section headings match the client-handover playbook, so the generator and
 * the teaching layer describe the same document.
 */

import fs from "node:fs"
import path from "node:path"
import { nowISO } from "./db.js"
import { soulGet } from "./soul.js"
import { engineConfigPath } from "./configview.js"

const ENV_PATTERN = /process\.env\.([A-Z][A-Z0-9_]+)|os\.environ(?:\.get)?\(?[["']([A-Z][A-Z0-9_]+)/g
const SECRET_HINT = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".sh", ".json", ".md", ".yml", ".yaml", ".example"]
const MAX_FILE_BYTES = 256_000
const MAX_FILES = 800

export interface HandoverOptions {
  /** Repository (or any folder inside one) the document describes. */
  repo: string
  /** Where to write. Defaults to CLIENT_SOP_HANDOVER.md at the repo root. */
  out?: string
  /** CRM client this delivery belongs to, so the document names them. */
  clientID?: number
}

export interface HandoverResult {
  path: string
  commits: number
  env_vars: string[]
  sections: string[]
}

function git(repo: string, args: string[]): string {
  try {
    const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) return ""
    return new TextDecoder().decode(result.stdout).trim()
  } catch {
    return ""
  }
}

/** Environment variable names referenced by tracked source, sorted, deduped. */
function findEnvVars(repo: string): string[] {
  const files = git(repo, ["ls-files"]).split("\n").filter(Boolean)
  const found = new Set<string>()
  let scanned = 0
  for (const file of files) {
    if (scanned >= MAX_FILES) break
    if (!SCANNED_EXTENSIONS.some((extension) => file.endsWith(extension))) continue
    const full = path.join(repo, file)
    let text: string
    try {
      const stat = fs.statSync(full)
      if (stat.size > MAX_FILE_BYTES) continue
      text = fs.readFileSync(full, "utf8")
    } catch {
      continue
    }
    scanned++
    for (const match of text.matchAll(ENV_PATTERN)) {
      const name = match[1] ?? match[2]
      if (name) found.add(name)
    }
    if (file.endsWith(".env.example") || file.endsWith(".example")) {
      for (const line of text.split("\n")) {
        const declared = /^([A-Z][A-Z0-9_]+)=/.exec(line.trim())
        if (declared) found.add(declared[1])
      }
    }
  }
  return [...found].sort()
}

function permissionGates(): string[] {
  const gates: string[] = []
  try {
    const config = JSON.parse(fs.readFileSync(engineConfigPath(), "utf8")) as {
      permission?: Record<string, string>
    }
    for (const [tool, mode] of Object.entries(config.permission ?? {})) {
      if (mode === "ask") gates.push(`${tool}: ask before every use`)
    }
  } catch {
    // Config unreadable — the standing rules below still apply.
  }
  const operatorGates = soulGet("permission_gates", "").trim()
  if (operatorGates) gates.push(`operator's own words: ${operatorGates}`)
  return gates
}

function packageFacts(repo: string): { name: string; scripts: [string, string][]; license: string } {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as {
      name?: string
      license?: string
      scripts?: Record<string, string>
    }
    return {
      name: pkg.name ?? path.basename(repo),
      scripts: Object.entries(pkg.scripts ?? {}).slice(0, 8),
      license: pkg.license ?? "not declared",
    }
  } catch {
    return { name: path.basename(repo), scripts: [], license: "not declared" }
  }
}

/**
 * Generate the handover document. Returns where it went and what fed it, so
 * the caller can report honestly (an empty git log is a fact, not a silence).
 */
export function generateHandover(options: HandoverOptions): HandoverResult {
  const repo = path.resolve(options.repo)
  if (!fs.existsSync(repo)) throw new Error(`No such folder: ${repo}`)

  const log = git(repo, ["log", "-n", "15", "--pretty=format:%h %ad %s", "--date=short"])
  const commits = log ? log.split("\n").length : 0
  const remote = git(repo, ["remote", "get-url", "origin"])
  const porcelain = git(repo, ["status", "--porcelain"])
  const dirty = porcelain ? porcelain.split("\n").filter(Boolean).length : 0
  const pkg = packageFacts(repo)
  const envVars = findEnvVars(repo)
  const gates = permissionGates()
  const entries = fs
    .readdirSync(repo, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .slice(0, 24)

  const clientLine = options.clientID
    ? `Delivery recorded for CRM client ${options.clientID}.`
    : "No CRM client linked to this document."

  const sections = ["Architecture", "Environment and secrets", "Daily operation", "Maintenance", "Edge cases and recovery", "Approval gates", "Support and ownership"]

  const body = [
    "# CLIENT SOP & HANDOVER",
    "",
    `_Generated by Elitza on ${nowISO().slice(0, 10)} from ${repo}. Evidence below comes from git, the tracked source and the live config — not from memory of the project._`,
    "",
    "## Architecture",
    "",
    `- Project: ${pkg.name} (license: ${pkg.license})`,
    `- Layout: ${entries.join(" ") || "(empty)"}`,
    `- Repository: ${remote || "(local only — no git remote configured)"}`,
    `- Working tree: ${dirty === 0 ? "clean" : `${dirty} uncommitted change(s)`}`,
    "",
    "What changed, newest first:",
    "",
    log ? log.split("\n").map((line) => `- ${line}`).join("\n") : "- No git history available in this folder.",
    "",
    "## Environment and secrets",
    "",
    "Names only. Values live in mode-600 files (for Elitza: ~/.elitza/.env, ~/.config/maton/credentials.env) or the host environment, and never appear in this document.",
    "",
    envVars.length
      ? envVars.map((name) => `- \`${name}\` — ${SECRET_HINT.test(name) ? "secret: mode-600 file, loaded, never echoed" : "plain configuration: host environment or config file"}`).join("\n")
      : "- No environment variables referenced in the scanned source.",
    "",
    "## Daily operation",
    "",
    clientLine,
    pkg.scripts.length
      ? ["Run and check commands:", "", ...pkg.scripts.map(([name, command]) => `- \`${name}\`: ${command}`)].join("\n")
      : "- No package scripts defined; the run command is whatever the folder's own README states.",
    "",
    "## Maintenance",
    "",
    "- Dependency updates monthly, or immediately for a security advisory; re-run the project's check command after every one.",
    "- Keep the database and generated files out of git if they already are (check .gitignore) and back them up separately.",
    "- Re-generate this document after any structural change: it goes stale the moment the architecture moves.",
    "",
    "## Edge cases and recovery",
    "",
    "- Everything recoverable is in git: `git log` to see what changed, `git status` for uncommitted work, `git checkout <commit> -- <path>` to restore one file.",
    "- If a process will not start: check the environment variables above are set, then the port or path it binds to.",
    "- If a database file is corrupt: restore the newest backup copy; do not edit it by hand.",
    "- If this document disagrees with the code, the code wins and this file must be regenerated.",
    "",
    "## Approval gates",
    "",
    gates.length
      ? gates.map((gate) => `- ${gate}`).join("\n")
      : "- No engine permission gates configured (edit, bash, webfetch are unrestricted).",
    "- Nothing outbound is sent without a human approving the batch — outreach drafts wait as files.",
    "- No write to a live domain without explicit confirmation from the owner.",
    "- Secrets stay in mode-600 files: never in documents, repositories, prompts or memory.",
    "",
    "## Support and ownership",
    "",
    `- Code owner: the repository above${remote ? "" : " (no remote — take one before handover)"}`,
    `- Source of truth: this code, plus the git history listed in section one`,
    "- The buyer owns the deliverable and the right to move it elsewhere; the runbook travels with it.",
    "",
  ].join("\n")

  const target = path.resolve(options.out ?? path.join(repo, "CLIENT_SOP_HANDOVER.md"))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, body)
  return { path: target, commits, env_vars: envVars, sections }
}
