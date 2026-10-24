/**
 * Elitza Brain — the gapfeed pipeline (Task 4b).
 *
 * Consumes lead/intent signals from the LOCAL gapfeed backend and turns
 * them into outreach drafts on disk. Two entry points, one engine:
 *
 *   querySignals()   one-shot fetch, used by the `gapfeed_query_signals`
 *                    tool (blueprint §3: the silent local integration).
 *   pollPipeline()   the listener: fetch -> select -> write drafts for any
 *                    signal not drafted yet. Runs from the heartbeat on an
 *                    interval, or on demand via `gapfeed_build_pipeline`.
 *
 * Endpoint policy: the local backend tree is the ONLY default —
 * `http://127.0.0.1:5002`, overridable with GAPFEED_LOCAL_URL. The dead
 * `api.gapfeed.com` name appears nowhere in this file on purpose; DNS for
 * it does not exist yet and nothing may hardcode it.
 *
 * Nothing here ever sends anything. Drafts are files for a human to
 * review, personalize, and send — outbound contact stays Dario's call.
 *
 * Config (env):
 *   GAPFEED_LOCAL_URL          default http://127.0.0.1:5002
 *   ELITZA_GAPFEED=0           disable the listener entirely
 *   ELITZA_GAPFEED_POLL_MINUTES  minimum minutes between automatic polls
 *                               (default 360 = 6h, blueprint sync interval)
 */

import fs from "node:fs"
import path from "node:path"
import { ELITZA_HOME, nowISO } from "./db.js"
import { soulGet, soulSet } from "./soul.js"

const DEFAULT_BASE_URL = "http://127.0.0.1:5002"
const DEFAULT_POLL_MINUTES = 360
const DRAFT_MIN_URGENCY = 0.6
const DRAFT_QUERY_LIMIT = 25
const DRAFTED_CAP = 1000
const FETCH_TIMEOUT_MS = 5_000

const PIPELINE_DIR = path.join(ELITZA_HOME, "pipeline")

export interface Signal {
  id?: number
  source?: string
  source_url?: string
  subreddit?: string
  author?: string
  title?: string
  content?: string
  collected_at?: string
  vertical?: string
  pain_category?: string
  signal_type?: string
  location?: string
  urgency_score?: number
  specificity_score?: number
  buyer_intent?: number
  quality_tier?: string
  sentiment?: string
  competitor_mentions?: unknown
  metadata?: unknown
}

export interface SignalQuery {
  vertical?: string
  region?: "italy" | "eu" | "global"
  urgency_threshold?: number
  quality_tier?: string
  limit?: number
}

function debug(message: string): void {
  if (!process.env.ELITZA_BRAIN_DEBUG) return
  try {
    fs.appendFileSync("/tmp/elitza-brain-debug.log", `${new Date().toISOString()} pipeline: ${message}\n`)
  } catch {
    // Logging is best-effort.
  }
}

function baseUrl(): string {
  return (process.env.GAPFEED_LOCAL_URL || DEFAULT_BASE_URL).replace(/\/$/, "")
}

function pollMinutes(): number {
  const requested = Number(process.env.ELITZA_GAPFEED_POLL_MINUTES ?? DEFAULT_POLL_MINUTES)
  return Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_POLL_MINUTES
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Fetch signals from the local backend. Returns [] on any failure — a
 * stopped server is a normal state (the backend runs on demand), not an
 * error worth waking anyone for.
 */
export async function querySignals(query: SignalQuery = {}): Promise<Signal[]> {
  const params = new URLSearchParams()
  params.set("limit", String(Math.max(1, Math.min(500, query.limit ?? 50))))
  params.set("min_urgency", String(Math.max(0, Math.min(1, query.urgency_threshold ?? 0))))
  if (query.vertical) params.set("vertical", query.vertical)
  if (query.quality_tier) params.set("quality_tier", query.quality_tier)

  try {
    const response = await fetch(`${baseUrl()}/api/signals?${params.toString()}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) {
      debug(`query failed: HTTP ${response.status}`)
      return []
    }
    const body = (await response.json()) as { signals?: Signal[] }
    const signals = Array.isArray(body.signals) ? body.signals : []
    return query.region && query.region !== "global" ? signals.filter((s) => regionMatches(s, query.region!)) : signals
  } catch (error) {
    debug(`query error: ${String(error)}`)
    return []
  }
}

// ---------------------------------------------------------------------------
// Region filter (client-side: the local schema has `location`, not a region
// column — see gapfeed shared/signals_db.py. Cities don't carry a country,
// so an unmatched location simply doesn't match a region filter.)
// ---------------------------------------------------------------------------

const REGION_TERMS: Record<"italy" | "eu", string[]> = {
  italy: ["italy", "italia"],
  eu: [
    "austria", "belgium", "bulgaria", "croatia", "cyprus", "czech", "denmark", "estonia",
    "finland", "france", "germany", "greece", "hungary", "ireland", "italy", "italia",
    "latvia", "lithuania", "luxembourg", "malta", "netherlands", "poland", "portugal",
    "romania", "slovakia", "slovenia", "spain", "españa", "sweden",
  ],
}

export function regionMatches(signal: Signal, region: "italy" | "eu" | "global"): boolean {
  if (region === "global") return true
  const location = (signal.location ?? "").toLowerCase()
  if (!location) return false
  return REGION_TERMS[region].some((term) => location.includes(term))
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

function drafted(): string[] {
  try {
    const parsed = JSON.parse(soulGet("pipeline_drafted", "[]")) as unknown
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function markDrafted(id: string): void {
  const next = [...drafted(), id].slice(-DRAFTED_CAP)
  soulSet("pipeline_drafted", JSON.stringify(next))
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "signal"
  )
}

function quote(text: string, limit = 600): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim()
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean
}

function score(value: unknown): string {
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(2) : "n/a"
}

/** One signal -> one markdown draft, in Dario's engineer-first voice. */
export function renderDraft(signal: Signal): string {
  const title = quote(signal.title || signal.content || "Untitled signal", 120)
  const vertical = signal.vertical || "general"
  const pain = signal.pain_category || "this operational problem"
  const lines = [
    `# Outreach draft — ${title}`,
    "",
    `_Generated by Elitza from gapfeed signal #${signal.id ?? "?"} on ${nowISO().slice(0, 10)}. Nothing sends itself: review, personalize, then send._`,
    "",
    "## Signal",
    "",
    `- Source: ${signal.source ?? "unknown"}${signal.subreddit ? ` (r/${signal.subreddit})` : ""}${signal.source_url ? ` — ${signal.source_url}` : ""}`,
    `- Vertical: ${vertical} | Pain: ${pain} | Type: ${signal.signal_type ?? "unknown"}`,
    `- Location: ${signal.location ?? "unspecified"} | Collected: ${signal.collected_at ?? "unknown"}`,
    `- Urgency: ${score(signal.urgency_score)} | Buyer intent: ${score(signal.buyer_intent)} | Tier: ${signal.quality_tier ?? "n/a"} | Sentiment: ${signal.sentiment ?? "n/a"}`,
    "",
    "### What they said",
    "",
    `> ${quote(signal.content ?? "")}`,
    "",
    "## Draft",
    "",
    "Hi,",
    "",
    `Quick, specific note: your situation reads like a ${pain} problem inside a ${vertical} team — that is exactly the kind of thing I take on.`,
    "",
    "I deliver it as a fixed-scope build: days, not weeks, a concrete price up front, and everything (code, runbooks, handover docs) handed to you so there is no vendor lock-in and no dependency on me.",
    "",
    "If it is still open, worth a 20-minute call this week? Either way I will send you a concrete first approach — useful even if we never work together.",
    "",
    "Best,",
    "Dario",
    "",
    "## Before sending",
    "",
    `- Replace the generic opener with a real detail from the signal above (quote it — people reply to recognition).`,
    `- Translate to Italian if the prospect writes in Italian.`,
    `- Double-check the company and the person before sending (Constraint: no outreach without a human read).`,
    `- This file is a draft. Nothing in the pipeline sends email, messages, or posts.`,
    "",
  ]
  return lines.join("\n")
}

function draftPath(signal: Signal): string {
  const day = nowISO().slice(0, 10)
  const dir = path.join(PIPELINE_DIR, day)
  return path.join(dir, `S${signal.id ?? "x"}-${slug(signal.title || signal.content || "signal")}.md`)
}

// ---------------------------------------------------------------------------
// The listener
// ---------------------------------------------------------------------------

export interface PipelineResult {
  fetched: number
  drafted: string[]
  skipped: number
}

/**
 * Fetch, filter, and write drafts for signals not drafted yet. `force`
 * bypasses the poll interval (tool calls); the heartbeat passes force=false
 * and lets the interval gate decide. Never throws.
 */
export async function pollPipeline(options: { force?: boolean } = {}): Promise<PipelineResult | null> {
  if (process.env.ELITZA_GAPFEED === "0") return null
  if (!options.force) {
    const last = Date.parse(soulGet("pipeline_last_poll", ""))
    if (Number.isFinite(last) && Date.now() - last < pollMinutes() * 60_000) return null
  }

  try {
    const signals = await querySignals({
      urgency_threshold: DRAFT_MIN_URGENCY,
      limit: DRAFT_QUERY_LIMIT,
    })
    soulSet("pipeline_last_poll", nowISO())
    if (!signals.length) return { fetched: 0, drafted: [], skipped: 0 }

    const seen = new Set(drafted())
    const written: string[] = []
    let skipped = 0

    for (const signal of signals) {
      const id = String(signal.id ?? "")
      if (!id || seen.has(id)) {
        skipped++
        continue
      }
      const file = draftPath(signal)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, renderDraft(signal))
      markDrafted(id)
      seen.add(id)
      written.push(file)
    }

    const result = { fetched: signals.length, drafted: written, skipped }
    soulSet("pipeline_last_summary", JSON.stringify({ ...result, at: nowISO() }))
    debug(`poll: fetched=${result.fetched} drafted=${written.length} skipped=${skipped}`)
    return result
  } catch (error) {
    debug(`poll error: ${String(error)}`)
    return null
  }
}
