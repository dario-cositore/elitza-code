/**
 * Elitza Brain — the AI Enablement knowledge base (Task H).
 *
 * The teaching layer: the playbooks that tell Elitza how a case is actually
 * run — what to ask before quoting, how the proposal is shaped, which
 * workbook fits, how the call goes, what payment means, what handover owes
 * the buyer. Curated here so they ship with the plugin, then seeded into
 * ~/.elitza/brain/procedural/ on load.
 *
 * Seeding never overwrites: an operator who edits a playbook keeps their
 * edit across restarts and upgrades. Files are plain markdown with a
 * description line, which is what memory.listProceduralSkills() already
 * reads — and each one is registered as a skill too, so the model pulls the
 * right one in on its own when a case calls for it.
 *
 * Every playbook is engineer-first: no marketing voice, euro prices, no
 * embedded secrets, and nothing that pretends a decision (payment
 * processor, calendar channel) has been made when it has not.
 */

import fs from "node:fs"
import path from "node:path"
import { BRAIN_DIR } from "./db.js"

export const PLAYBOOK_DIR = path.join(BRAIN_DIR, "procedural")

export const PLAYBOOKS: Record<string, string> = {
  "ai-enablement-diagnosis.md": `---
name: ai-enablement-diagnosis
description: "Intake diagnosis: what to ask, what to collect, red flags before you quote."
source: Elitza knowledge base (Task H)
---

# Intake diagnosis

Run this before any number is said out loud. Twenty focused minutes, written answers, not a tour.

## Collect

1. Tools in use today: what they pay for, what they abandoned, what is held together with spreadsheets.
2. Document flow: which documents arrive, from where, who retypes them, where they end up.
3. Volume: how many per day or week, peaks, seasonal jumps.
4. Who touches the data: names, roles, whether they share logins.
5. What breaks: the specific failure, how often, what it costs in hours or euros.
6. Decision maker and budget signal: who signs, what range they already expect.
7. Deadline: real date, and what happens if it slips.
8. Constraints: compliance (GDPR, sector rules), existing contracts, IT who must approve.

## Red flags

- No written process and nobody who owns it: scope will drift. Fix with a fixed price and a written out-of-scope list.
- "We will figure it out as we go": refuse time and materials, sell a sprint.
- Several owners who disagree: book a call with all of them before proposing.
- Wants a custom app for what is a configuration: say so plainly and price the simpler thing.
- Existing contract with a competitor ending soon: propose now, start after.

## Output

A one-page diagnosis note in the CRM (crm update, notes field): tools, volume, break, owner, budget signal, constraint. This is the input to the proposal playbook.
`,

  "fixed-scope-proposal.md": `---
name: fixed-scope-proposal
description: "Proposal template for a EUR 1,500-3,500 implementation sprint: structure, scope, price, acceptance."
source: Elitza knowledge base (Task H)
---

# Fixed-scope proposal

One page, sent as a file, priced in euros. The buyer should be able to forward it without you in the room.

## Structure

1. Situation — three sentences: their words about what breaks, their volume, their deadline.
2. What we do — exactly three bullets, each ending in a concrete artifact (a working intake flow, a CRM with their fields, a document pipeline that never leaves a file unlogged).
3. Out of scope — as explicit as the scope. This is what protects the price.
4. Deliverables — what exists at the end, named as files or systems they can open.
5. Timeline — 2 to 4 working days for a sprint, or the real number.
6. Price — one band: EUR 1,500 (single flow), EUR 2,500 (two or three flows with a CRM), EUR 3,500 (document processing with retention and access rules).
7. Acceptance — one paragraph: they run their own real cases through it, we fix what does not hold.
8. Next step — a call, a date, a reply.

## Rules

- No hourly rates. Fixed scope, fixed price.
- No features that were not in the diagnosis note.
- Say what happens after the sprint in one line (support by agreement, handover document included).
- Payment terms come from the payment-terms playbook, not from adjectives.

## Close

Send it, then stop. One follow-up at +3 days from the cadence, then the standard four touches.
`,

  "workbook-library.md": `---
name: workbook-library
description: "Which workbook fits which case: intake qualification, CRM automation, zero-leak document processing."
source: Elitza knowledge base (Task H)
---

# Workbook library

Pick one on the call. One case, one workbook; two workbooks only when the diagnosis proves both.

## 1. Intake qualification

When: leads arrive by form, phone, email or walk-in and nobody triages them.
Inputs: the current questions they ask, the source of each lead, what "qualified" means to them.
Does: one intake path, scoring rules they can read, routing to the right person, no lead without an owner.
Deliverable: working intake flow, a qualification sheet, a daily view of what arrived.
Typical: 2 days, EUR 1,500.

## 2. CRM automation

When: contacts live in inboxes and spreadsheets, follow-ups depend on someone remembering.
Inputs: their real fields, their stages, the people who need to see what.
Does: one client table with a status lifecycle, the next action on every row, scheduled follow-ups, an export.
Deliverable: the CRM, seeded with their current data, plus a one-page operating note.
Typical: 3 days, EUR 2,500.

## 3. Zero-leak document processing

When: documents are retyped, emailed around, or stored where anyone can read everything.
Inputs: document types, retention rule, who may read what, the systems they must land in.
Does: one intake point, extraction into structured records, access limited by role, every copy accounted for.
Deliverable: the pipeline, a retention configuration, an audit list of where each document lives.
Typical: 4 days, EUR 3,500.

## Choosing

Ask two questions on the call: what arrives most often, and what leaks time fastest. The first answer picks the workbook; the second sets the price band.
`,

  "discovery-call-script.md": `---
name: discovery-call-script
description: "Scope call runbook: 30 minutes, agenda, questions, workbook choice, close."
source: Elitza knowledge base (Task H)
---

# Discovery call

Thirty minutes. You talk for one third of it.

## Agenda

- 0-5 min: who they are, what a normal week looks like.
- 5-15 min: the diagnosis review — read their own answers back, correct them in front of them.
- 15-22 min: workbook choice. Name the one that fits, say why in a sentence.
- 22-27 min: price band and timeline, said plainly: "This is a EUR 2,500 sprint, three days, done inside your own tools."
- 27-30 min: close — next step with a date.

## Questions that earn their place

- Which of these two things costs you the most hours in a normal week?
- Who would have to agree for this to be signed?
- What would make you call the whole thing off?
- If we finish and it works, what do you do on the first morning after?

## Do not

- Do not demo. Do not promise integrations that were not in the diagnosis.
- Do not leave the price vague. The band is the point of the call.

## After the call

Update the CRM (stage, deal value, next action), attach the proposal if it went out, and let the cadence do its four touches if there is no answer.
`,

  "payment-terms.md": `---
name: payment-terms
description: "Payment terms: 50/50, EUR, what unlocks delivery, late handling, scope changes."
source: Elitza knowledge base (Task H)
---

# Payment terms

Stated in the proposal, repeated before work starts. The processor itself is still an open decision — bank transfer until it is settled.

- Currency: EUR, prices as quoted, no hourly work.
- Split: 50% to start, 50% on handover. Sprints under EUR 1,500 can be paid in full up front.
- Delivery starts when the first payment is recorded (production: record_payment). Say this sentence in writing.
- Terms: 14 days from invoice. After that, delivery pauses and the schedule moves.
- Invoices: numbered, dated, with the scope line from the proposal. Keep them attached to the client record as assets.
- Scope changes: a new one-page proposal with its own price. Never absorbed.
- Expenses: none without written agreement.
- Handover is not delivered before the final payment. The runbook, credentials list and access notes go out with it.

## On the call

Say the split before the price. It is easier to hear the total when the first half already has a date.
`,

  "client-handover.md": `---
name: client-handover
description: "What a finished job must hand over: architecture, environment, maintenance, recovery, approval gates."
source: Elitza knowledge base (Task H)
---

# Client handover

The handover is the product the buyer keeps. It is written from what actually shipped, not from the proposal.

## Sections the document must have

1. Architecture — what runs where, in plain language, with the one diagram or file tree that makes it obvious.
2. Environment and secrets — the names of every variable and where its value lives. Values never go in the document.
3. Daily operation — the three things the buyer does each week, written for a person who is not an engineer.
4. Maintenance — what must be updated, how often, what happens if it is ignored.
5. Edge cases and recovery — the failures that can happen, what the system does, what the human does.
6. Approval gates — every place a human must say yes before anything goes out, listed with how to say it.
7. Support and ownership — who fixes what, and where the code lives if they ever take it elsewhere.

## Rules

- No secret values. Names of variables only.
- Written to be read once and used forever: short sections, imperative sentences, no reassurance.
- Delivered with the final payment.
- Source of truth: the code and the execution log, not memory of the sale.
`,
}

/** Seed the playbooks that are missing. Existing files are never touched. */
export function ensureKnowledge(): string[] {
  fs.mkdirSync(PLAYBOOK_DIR, { recursive: true })
  const written: string[] = []
  for (const [file, content] of Object.entries(PLAYBOOKS)) {
    const target = path.join(PLAYBOOK_DIR, file)
    if (fs.existsSync(target)) continue
    fs.writeFileSync(target, content)
    written.push(target)
  }
  return written
}

/** Every playbook on disk, curated or operator-added, for skill registration. */
export function playbookFiles(): { name: string; path: string }[] {
  if (!fs.existsSync(PLAYBOOK_DIR)) return []
  return fs
    .readdirSync(PLAYBOOK_DIR)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => ({ name: file.replace(/\.md$/, ""), path: path.join(PLAYBOOK_DIR, file) }))
}

/** Read a playbook by name. Name is sanitized, so only files in that folder. */
export function readPlaybook(name: string): string | null {
  const safe = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, "")
  if (!safe) return null
  const file = path.join(PLAYBOOK_DIR, `${safe}.md`)
  if (!fs.existsSync(file)) return null
  return fs.readFileSync(file, "utf8")
}
