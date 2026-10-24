/**
 * Elitza Brain — the work production pipeline (Task G).
 *
 * A `yes` disposition lands the client at `diagnose` (Task F). From there
 * the case runs through one ordered set of stages, and each stage carries
 * its own next action so Elitza never has to be told twice what happens
 * after a proposal:
 *
 *   diagnose   gather the facts — tools, documents, volume, what breaks now
 *   proposal   fixed-scope proposal, priced in euros
 *   workbook    pick the workbook for this case type on the call (Task H)
 *   scheduled  the call: scope, dates, who does what
 *   payment    collect before delivery starts
 *   done       hand over and close (Task 3 writes the runbook)
 *
 * Moving is deliberately loose in one direction only: any production stage
 * may be entered from another (deals really do jump from call to paid), but
 * a client only ever enters this machine from a `yes` — outreach stages
 * cannot be advanced into production by hand. Every move is an interaction,
 * so the client record tells the whole story in order.
 *
 * Payment collection records money and an invoice artifact; the processor
 * itself is still an open decision (blueprint §9), so nothing here charges
 * anyone. Calls are scheduled as a dated next action, not as calendar
 * invites — the calendar channel is also open.
 */

import { addAsset, getClient, logInteraction, updateClient, type AssetInput } from "./crm.js"
import { nowISO } from "./db.js"

export const PRODUCTION_STAGES = [
  "diagnose",
  "proposal",
  "workbook",
  "scheduled",
  "payment",
  "done",
] as const

export type ProductionStage = (typeof PRODUCTION_STAGES)[number]

/** What has to happen in each stage — surfaced as the client's next action. */
export const NEXT_ACTIONS: Record<ProductionStage, string> = {
  diagnose: "Gather the facts: current tools, documents, volume, what breaks today.",
  proposal: "Write the fixed-scope proposal: intake qualification, CRM automation, zero-leak document processing.",
  workbook: "On the call, choose the workbook that fits this case type.",
  scheduled: "Run the call: scope, dates, who does what.",
  payment: "Collect payment before delivery starts.",
  done: "Hand over: runbook, credentials, maintenance notes.",
}

export interface ProductionState {
  client_id: number
  name: string
  status: string
  in_production: boolean
  stage: ProductionStage | null
  next_action: string | null
  next_action_at: string | null
  deal_value: number | null
}

function isStage(value: string): value is ProductionStage {
  return (PRODUCTION_STAGES as readonly string[]).includes(value)
}

/** Where a client stands in production, entry (`yes`) counted as `diagnose`. */
export function productionState(clientId: number): ProductionState {
  const client = getClient(clientId)
  if (!client) throw new Error(`No client with id ${clientId}.`)
  const stage =
    client.status === "yes" ? "diagnose" : isStage(client.status) ? (client.status as ProductionStage) : null
  return {
    client_id: client.id,
    name: client.name,
    status: client.status,
    in_production: stage !== null,
    stage,
    next_action: client.next_action,
    next_action_at: client.next_action_at,
    deal_value: client.deal_value,
  }
}

/** Refuse the move when the client is not in production yet (or already closed). */
function requireStage(clientId: number, allowDone: boolean): { stage: ProductionStage; status: string } {
  const state = productionState(clientId)
  if (!state.stage) {
    throw new Error(
      `${state.name} is at "${state.status}" — only a yes enters production. Disposition the outreach first.`,
    )
  }
  if (state.stage === "done" && !allowDone) {
    throw new Error(`${state.name} is already in the done queue.`)
  }
  return { stage: state.stage, status: state.status }
}

export interface AdvanceOptions {
  note?: string
  asset?: AssetInput
}

/**
 * Move a client to another production stage. Records the move as an
 * interaction, rewrites the next action to fit the new stage, and attaches
 * an artifact when the stage has one (a proposal PDF, a signed quote).
 */
export function advance(
  clientId: number,
  target: string,
  options: AdvanceOptions = {},
): { from: ProductionStage; to: ProductionStage; next_action: string } {
  if (!isStage(target)) {
    throw new Error(`Unknown production stage "${target}". Valid: ${PRODUCTION_STAGES.join(", ")}`)
  }
  const current = requireStage(clientId, true)
  if (current.stage === target && current.status === target) {
    throw new Error(`${target} is where this client already stands.`)
  }

  const from = current.stage
  updateClient(clientId, { status: target, next_action: NEXT_ACTIONS[target] })
  logInteraction(clientId, {
    kind: "stage",
    direction: "note",
    channel: "note",
    status: target,
    subject: `stage: ${from} → ${target}`,
    body: options.note ?? "",
    occurred_at: nowISO(),
  })
  if (options.asset) addAsset(clientId, options.asset)
  return { from, to: target, next_action: NEXT_ACTIONS[target] }
}

/**
 * Put a date on the call. While a case is still being shaped (diagnose,
 * proposal, workbook) the call IS the next milestone, so the stage moves to
 * `scheduled` with it; from `scheduled` on it only refreshes the date.
 */
export function scheduleCall(
  clientId: number,
  when: string,
  note?: string,
): { stage: ProductionStage; when: string } {
  const current = requireStage(clientId, false)
  const stage: ProductionStage =
    current.stage === "diagnose" || current.stage === "proposal" || current.stage === "workbook"
      ? "scheduled"
      : current.stage
  updateClient(clientId, {
    status: stage,
    next_action: `Call booked${note ? `: ${note}` : ""}.`,
    next_action_at: when,
  })
  logInteraction(clientId, {
    kind: "call",
    direction: "note",
    channel: "phone",
    status: "scheduled",
    subject: `call ${when}`,
    body: note ?? "",
    occurred_at: nowISO(),
  })
  return { stage, when }
}

export interface PaymentInput {
  amount?: number
  note?: string
  invoice_path?: string
}

/**
 * Record money that came in: the deal value, an invoice artifact when
 * there is one, and the move to `payment` if the case had not got there.
 * Nothing is charged — the processor is an open decision — and the client
 * still has to be advanced to `done` once the work is delivered.
 */
export function recordPayment(clientId: number, input: PaymentInput = {}): {
  stage: ProductionStage
  amount: number | null
} {
  const current = requireStage(clientId, false)
  const stage: ProductionStage =
    current.stage === "diagnose" || current.stage === "proposal" || current.stage === "workbook" || current.stage === "scheduled"
      ? "payment"
      : current.stage
  updateClient(clientId, {
    status: stage,
    ...(input.amount !== undefined ? { deal_value: input.amount } : {}),
    next_action: stage === "payment" ? "Payment recorded — deliver, then advance to done." : NEXT_ACTIONS[stage],
  })
  logInteraction(clientId, {
    kind: "payment",
    direction: "in",
    channel: "note",
    status: "received",
    subject: input.amount !== undefined ? `payment ${input.amount} EUR` : "payment",
    body: input.note ?? "",
    occurred_at: nowISO(),
  })
  if (input.invoice_path) {
    addAsset(clientId, { kind: "invoice", name: `Invoice ${nowISO().slice(0, 10)}`, path: input.invoice_path, status: "paid" })
  }
  return { stage, amount: input.amount ?? null }
}
