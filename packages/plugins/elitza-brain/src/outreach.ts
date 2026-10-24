/**
 * Elitza Brain — the outreach pipeline (Task D).
 *
 * The order of operations, all of it local and reviewable:
 *   add      push a CRM client into the pipeline (stage scouted)
 *   draft    write the next touch as a file in ~/.elitza/pipeline/<date>/
 *   approve  batch-approve drafts after a human read of those files
 *   send     POST the approved drafts through Resend, then advance the stage
 *
 * Two decisions Dario made on 2026-10-24 (blueprint §9, no longer open):
 *   channel    email, through Resend — the operator's own RESEND_API_KEY
 *   approval   batch: drafts wait as files until approved together, then one
 *              command sends what was approved. Nothing sends unapproved.
 *
 * Source of truth split: the FILE owns content (to/subject/body — a human may
 * edit it before approving), the ROW owns state (stage, touch, sent_at).
 * Every sent touch also moves the client's status and last_contact, so the
 * cadence in Task E can work off one column.
 *
 * Compliance is not optional: the footer (public-listing reason, opt-out,
 * OUTREACH_SIGNATURE) is written into the draft at draft time, so the human
 * reviews it along with the message.
 *
 * Endpoint policy: official Resend API, overridable with RESEND_URL the same
 * way GOOGLE_PLACES_URL and GAPFEED_LOCAL_URL are — tests never email anyone.
 *
 * Config (env):
 *   RESEND_API_KEY      required to send; operator's own key, mode 600 .env
 *   RESEND_FROM         verified sender, e.g. "Dario Cositore <hello@domain>"
 *   OUTREACH_SIGNATURE  the line under the opt-out in every footer
 */

import fs from "node:fs"
import path from "node:path"
import { ELITZA_HOME, nowISO } from "./db.js"
import { crmDb, getClient, logInteraction, updateClient } from "./crm.js"
import { slug } from "./pipeline.js"

const DEFAULT_RESEND_URL = "https://api.resend.com/emails"
const FETCH_TIMEOUT_MS = 10_000
const PIPELINE_DIR = path.join(ELITZA_HOME, "pipeline")
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Days to wait after each touch before the next one is due (0, +3, +7, +14). */
export const CADENCE_DAYS = [3, 7, 14]

/** Stage reached once touch n has gone out. */
const TOUCH_STAGES = ["contacted", "followup_1", "followup_2", "followup_3"]

export interface OutreachRow {
  id: number
  client_id: number
  stage: string
  channel: string
  touch: number
  draft_path: string | null
  approved: number
  queued_touch: number
  last_touch_at: string | null
  next_touch_at: string | null
  created_at: string
  updated_at: string
}

interface DraftFile {
  to: string
  subject: string
  body: string
  touch: number
}

function resendUrl(): string {
  return (process.env.RESEND_URL || DEFAULT_RESEND_URL).replace(/\/$/, "")
}

function rows<T>(sql: string, params: unknown[] = []): T[] {
  return crmDb().query(sql).all(...(params as never[])) as T[]
}

function row<T>(sql: string, params: unknown[] = []): T | undefined {
  return crmDb().query(sql).get(...(params as never[])) as T | undefined
}

function footer(): string {
  const signature = process.env.OUTREACH_SIGNATURE?.trim() || "Sent by Elitza on behalf of its operator."
  return [
    "---",
    "You are receiving this because your business details are publicly listed.",
    'Reply "no" and you will never hear from me again.',
    signature,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Pipeline rows
// ---------------------------------------------------------------------------

/** Push a CRM client into the pipeline. Existing clients keep their row. */
export function addToPipeline(clientId: number): { row: OutreachRow; created: boolean } {
  const client = getClient(clientId)
  if (!client) throw new Error(`No client with id ${clientId}.`)
  const existing = row<OutreachRow>("SELECT * FROM pipeline WHERE client_id = ?", [clientId])
  if (existing) return { row: existing, created: false }

  const now = nowISO()
  const result = crmDb().run(
    `INSERT INTO pipeline (client_id, stage, channel, touch, created_at, updated_at)
     VALUES (?, ?, 'email', 0, ?, ?)`,
    [clientId, client.status === "scouted" ? "scouted" : client.status, now, now],
  )
  const created = row<OutreachRow>("SELECT * FROM pipeline WHERE id = ?", [result.lastInsertRowid])
  if (!created) throw new Error("Pipeline insert did not produce a row.")
  return { row: created, created: true }
}

export function listPipeline(filter: { stage?: string; limit?: number } = {}): OutreachRow[] {
  const limit = Math.max(1, Math.min(200, filter.limit ?? 50))
  if (filter.stage) {
    return rows<OutreachRow>("SELECT * FROM pipeline WHERE stage = ? ORDER BY id LIMIT ?", [
      filter.stage,
      limit,
    ])
  }
  return rows<OutreachRow>("SELECT * FROM pipeline ORDER BY id LIMIT ?", [limit])
}

export function getPipelineRow(id: number): OutreachRow | null {
  return row<OutreachRow>("SELECT * FROM pipeline WHERE id = ?", [id]) ?? null
}

// ---------------------------------------------------------------------------
// Drafts (files the human reads)
// ---------------------------------------------------------------------------

/**
 * Write the next touch as a draft file. The copy comes in from the caller
 * (Elitza writes it); this owns the envelope: recipient, compliance footer,
 * file naming, and the matching pipeline row state.
 */
export function writeDraft(
  clientId: number,
  input: { subject: string; body: string },
): { filePath: string; row: OutreachRow } {
  const client = getClient(clientId)
  if (!client) throw new Error(`No client with id ${clientId}.`)
  const subject = input.subject.trim()
  const body = input.body.trim()
  if (!subject || !body) throw new Error("A draft needs both a subject and a body.")
  if (!client.email) {
    throw new Error(
      `No email for ${client.name} — find one with the crm find_email action (their own website) or set it with crm update first.`,
    )
  }

  const { row: pipelineRow } = addToPipeline(clientId)
  const touch = pipelineRow.touch + 1
  if (touch > 4) throw new Error("The 4-touch cadence is already complete for this client.")

  const day = nowISO().slice(0, 10)
  const dir = path.join(PIPELINE_DIR, day)
  const filePath = path.join(dir, `C${clientId}-${slug(subject, "draft")}.md`)
  fs.mkdirSync(dir, { recursive: true })

  fs.writeFileSync(filePath, renderDraft(pipelineRow, client.email, subject, body, touch, "drafted"))
  // queued_touch marks the touch number whose draft is waiting for review, so
  // the scheduler never writes a second copy of the same follow-up.
  crmDb().run(
    "UPDATE pipeline SET draft_path = ?, approved = 0, queued_touch = ?, updated_at = ? WHERE id = ?",
    [filePath, touch, nowISO(), pipelineRow.id],
  )
  return { filePath, row: getPipelineRow(pipelineRow.id) ?? pipelineRow }
}

function renderDraft(
  pipelineRow: OutreachRow,
  to: string,
  subject: string,
  body: string,
  touch: number,
  status: string,
): string {
  return [
    "---",
    `pipeline: ${pipelineRow.id}`,
    `client: ${pipelineRow.client_id}`,
    `touch: ${touch}`,
    `to: ${to}`,
    `subject: ${subject}`,
    `status: ${status}`,
    `created: ${nowISO()}`,
    "---",
    "",
    body,
    "",
    footer(),
    "",
  ].join("\n")
}

/** Flip a reviewed draft to sent in place — content stays exactly as approved. */
function markSent(filePath: string, sentAt: string): void {
  const text = fs.readFileSync(filePath, "utf8")
  const withStatus = text.replace(/^status:.*$/m, "status: sent")
  const marked = /^sent_at:/m.test(withStatus)
    ? withStatus.replace(/^sent_at:.*$/m, `sent_at: ${sentAt}`)
    : withStatus.replace(/^status: sent$/m, `status: sent\nsent_at: ${sentAt}`)
  fs.writeFileSync(filePath, marked)
}

/** Read a draft back: the human may have edited to/subject/body. */
export function readDraft(filePath: string): DraftFile | null {
  if (!fs.existsSync(filePath)) return null
  const lines = fs.readFileSync(filePath, "utf8").split("\n")
  if (lines[0]?.trim() !== "---") return null
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (end === -1) return null
  const meta: Record<string, string> = {}
  for (const line of lines.slice(1, end)) {
    const split = line.indexOf(":")
    if (split > 0) meta[line.slice(0, split).trim()] = line.slice(split + 1).trim()
  }
  return {
    to: meta.to ?? "",
    subject: meta.subject ?? "",
    body: lines.slice(end + 1).join("\n").trim(),
    touch: Number(meta.touch ?? 1),
  }
}

// ---------------------------------------------------------------------------
// Approval and sending
// ---------------------------------------------------------------------------

/** Batch-approve drafts. Every id must be an approved-pending draft with a file. */
export function approveDrafts(ids: number[]): OutreachRow[] {
  if (!ids.length) throw new Error("Approve needs at least one pipeline id.")
  const approved: OutreachRow[] = []
  for (const id of ids) {
    const pipelineRow = getPipelineRow(id)
    if (!pipelineRow) throw new Error(`No pipeline row with id ${id}.`)
    if (!pipelineRow.draft_path) throw new Error(`Pipeline ${id} has no draft to approve.`)
    crmDb().run("UPDATE pipeline SET approved = 1, updated_at = ? WHERE id = ?", [nowISO(), id])
    approved.push(getPipelineRow(id) ?? pipelineRow)
  }
  return approved
}

export interface SendResult {
  sent: number[]
  failed: { id: number; reason: string }[]
}

/**
 * Send approved drafts through Resend and advance each row through the
 * cadence: touch n sets stage TOUCH_STAGES[n-1] and schedules touch n+1
 * for +3 / +7 / +14 days. Unapproved rows are never sent.
 */
export async function sendApproved(ids?: number[]): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim()
  const from = process.env.RESEND_FROM?.trim()
  if (!apiKey) {
    throw new Error(
      "RESEND_API_KEY is not set. Add your own Resend key to ~/.elitza/.env as RESEND_API_KEY=... (mode 600), plus RESEND_FROM=<verified sender>.",
    )
  }
  if (!from) throw new Error("RESEND_FROM is not set — the verified sender address Resend accepts.")

  const targets = ids?.length
    ? rows<OutreachRow>(`SELECT * FROM pipeline WHERE id IN (${ids.map(() => "?").join(",")})`, ids)
    : rows<OutreachRow>("SELECT * FROM pipeline WHERE approved = 1 AND draft_path IS NOT NULL ORDER BY id")

  const result: SendResult = { sent: [], failed: [] }
  for (const pipelineRow of targets) {
    if (pipelineRow.approved !== 1) {
      result.failed.push({ id: pipelineRow.id, reason: "not approved" })
      continue
    }
    const draft = pipelineRow.draft_path ? readDraft(pipelineRow.draft_path) : null
    if (!draft || !pipelineRow.draft_path) {
      result.failed.push({ id: pipelineRow.id, reason: "draft file missing or unreadable" })
      continue
    }
    if (!EMAIL_ADDRESS.test(draft.to)) {
      result.failed.push({ id: pipelineRow.id, reason: `draft has no usable recipient (${draft.to || "empty"})` })
      continue
    }

    const failure = await sendEmail(from, draft.to, draft.subject, draft.body)
    if (failure) {
      result.failed.push({ id: pipelineRow.id, reason: failure })
      continue
    }

    const sentAt = nowISO()
    const touch = pipelineRow.touch + 1
    const stage = TOUCH_STAGES[touch - 1] ?? pipelineRow.stage
    const dueIn = CADENCE_DAYS[touch - 1]
    const nextTouchAt = dueIn
      ? new Date(Date.parse(sentAt) + dueIn * 86_400_000).toISOString()
      : null
    crmDb().run(
      `UPDATE pipeline SET touch = ?, stage = ?, approved = 0, queued_touch = 0, last_touch_at = ?, next_touch_at = ?, updated_at = ?
       WHERE id = ?`,
      [touch, stage, sentAt, nextTouchAt, sentAt, pipelineRow.id],
    )
    updateClient(pipelineRow.client_id, { status: stage, last_contact: sentAt })
    logInteraction(pipelineRow.client_id, {
      kind: touch === 1 ? "first_touch" : `followup_${touch - 1}`,
      direction: "out",
      channel: "email",
      status: "sent",
      subject: draft.subject,
      body: draft.body,
      occurred_at: sentAt,
    })
    markSent(pipelineRow.draft_path, sentAt)
    result.sent.push(pipelineRow.id)
  }
  return result
}

/** One Resend call. Returns a failure reason, or null when it went out. */
async function sendEmail(from: string, to: string, subject: string, text: string): Promise<string | null> {
  try {
    const response = await fetch(resendUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY?.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, text }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300)
      return `Resend HTTP ${response.status}: ${detail}`
    }
    return null
  } catch (error) {
    return String(error)
  }
}

// ---------------------------------------------------------------------------
// Cadence scheduler (Task E)
// ---------------------------------------------------------------------------

/** Stages where the cadence has stopped one way or another (Task F owns them). */
const TERMINAL_STAGES = ["yes", "no", "stale", "done"]

/** Copy for touch n+1 — shorter each time, always in the same thread. */
const FOLLOWUP_BODIES: Record<number, string> = {
  2: "Following up on my previous note — still worth a short conversation this week?",
  3: "One more nudge on the same. Happy to send a one-page outline instead, if judging it in writing is easier.",
  4: "Last one from me: if this is not a priority I will leave it alone. Reply and I will pick it back up.",
}

/** Rows whose next touch is due now: cadence still running, nothing waiting for review. */
export function listDue(now = nowISO(), limit = 20): OutreachRow[] {
  return rows<OutreachRow>(
    `SELECT * FROM pipeline
       WHERE next_touch_at IS NOT NULL
         AND next_touch_at <= ?
         AND touch < 4
         AND queued_touch <= touch
         AND stage NOT IN (${TERMINAL_STAGES.map(() => "?").join(",")})
       ORDER BY next_touch_at
       LIMIT ?`,
    [now, ...TERMINAL_STAGES, limit],
  )
}

export interface FollowupQueue {
  queued: { pipeline_id: number; client_id: number; touch: number; path: string }[]
  skipped: { pipeline_id: number; reason: string }[]
}

/**
 * The scheduler pass: draft every due follow-up as a file waiting for the
 * same batch review as a first touch. It never sends — approval stays the
 * human's, and `queued_touch` keeps the same follow-up from being drafted
 * twice on the next tick.
 */
export function queueFollowups(now = nowISO()): FollowupQueue {
  const result: FollowupQueue = { queued: [], skipped: [] }
  for (const pipelineRow of listDue(now)) {
    const client = getClient(pipelineRow.client_id)
    if (!client) {
      result.skipped.push({ pipeline_id: pipelineRow.id, reason: "client row missing" })
      continue
    }
    try {
      const { filePath, row } = writeDraft(pipelineRow.client_id, followupCopy(pipelineRow, client.name))
      result.queued.push({
        pipeline_id: row.id,
        client_id: row.client_id,
        touch: row.queued_touch,
        path: filePath,
      })
    } catch (error) {
      result.skipped.push({ pipeline_id: pipelineRow.id, reason: String(error) })
    }
  }
  return result
}

/**
 * Copy for touch n+1: `Re:` the subject that was actually sent, so a reply
 * lands in the thread the recipient already has. No sent subject means no
 * thread to stay in — one plain line instead.
 */
function followupCopy(pipelineRow: OutreachRow, business: string): { subject: string; body: string } {
  const previous = pipelineRow.draft_path ? readDraft(pipelineRow.draft_path) : null
  const topic = previous?.subject.replace(/^\s*re:\s*/i, "").trim() ?? ""
  const line = FOLLOWUP_BODIES[pipelineRow.touch + 1] ?? FOLLOWUP_BODIES[2]
  return topic
    ? { subject: `Re: ${topic}`, body: line }
    : { subject: `${business}: still worth a conversation?`, body: line }
}
