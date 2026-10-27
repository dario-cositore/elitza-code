/**
 * Elitza Brain — client enrichment agent.
 *
 * Given a CRM client, this agent:
 *   1. Fetches the client's own website (homepage + common subpages) and
 *      extracts text, emails, phones and any obvious service keywords.
 *   2. Reads the AI Enablement playbooks (diagnosis, proposal, payment terms)
 *      as the operating manual.
 *   3. Calls MiMo to produce a one-page diagnosis + a fixed-scope proposal
 *      with a recommended price band.
 *   4. Writes the result back into the CRM: updates notes, logs an
 *      interaction, attaches diagnosis.md and proposal.md as assets, and sets
 *      the next action.
 *
 * Nothing is sent to the client. The output is for the operator to read in
 * the CRM before deciding the next move.
 */

import fs from "node:fs"
import path from "node:path"
import { getClient, updateClient, logInteraction, addAsset } from "./crm.js"
import { ELITZA_HOME } from "./db.js"

const PLAYBOOK_DIR = path.join(ELITZA_HOME, "brain", "procedural")
const SUBPAGES = ["/", "/about", "/about-us", "/chi-siamo", "/services", "/servizi", "/contact", "/contatti", "/contact-us"]

function readPlaybook(name: string): string {
  try {
    return fs.readFileSync(path.join(PLAYBOOK_DIR, `${name}.md`), "utf8")
  } catch {
    return ""
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const PHONE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/g
const SOCIAL_RE: Record<string, RegExp> = {
  linkedin: /https?:\/\/(?:www\.)?linkedin\.com\/[^\s"'<>]+/gi,
  twitter: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[^\s"'<>]+/gi,
  facebook: /https?:\/\/(?:www\.)?facebook\.com\/[^\s"'<>]+/gi,
  instagram: /https?:\/\/(?:www\.)?instagram\.com\/[^\s"'<>]+/gi,
}

async function fetchPage(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Elitza enrichment (https://elitza.life)" },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return ""
    const html = await res.text()
    return stripHtml(html).slice(0, 6000)
  } catch {
    return ""
  }
}

function extractEmails(text: string): string[] {
  const matches = text.match(EMAIL_RE) ?? []
  const noise = ["example.", "example@", "sentry.", "wixpress", "yourdomain", "noreply", "no-reply"]
  return [...new Set(matches.map((m) => m.toLowerCase()))].filter((e) => !noise.some((n) => e.includes(n)))
}

function extractPhones(text: string): string[] {
  const matches = text.match(PHONE_RE) ?? []
  return [...new Set(matches.map((m) => m.trim()))].filter((p) => p.replace(/\D/g, "").length >= 7)
}

function extractSocials(text: string): { linkedin?: string; twitter?: string; facebook?: string; instagram?: string } {
  const result: { linkedin?: string; twitter?: string; facebook?: string; instagram?: string } = {}
  for (const [key, re] of Object.entries(SOCIAL_RE)) {
    const m = text.match(re)
    if (m && m[0]) result[key as keyof typeof result] = m[0].replace(/[.,;:]+$/, "")
  }
  return result
}

function mimoConfig(): { url: string; key: string; model: string } {
  const key = process.env.XIAOMI_API_KEY?.trim() ?? ""
  let url = "https://api.xiaomimimo.com/v1"
  try {
    const cfg = JSON.parse(require("node:fs").readFileSync(path.join(process.env.HOME ?? "", ".elitza", "home", "config", "opencode.json"), "utf8"))
    const base = cfg?.providers?.elitza?.settings?.baseURL
    if (base) url = String(base).replace(/\/$/, "")
  } catch {
    // fall back to prefix detection
  }
  if (!url || url === "https://api.xiaomimimo.com/v1") {
    if (key.toLowerCase().startsWith("tp")) url = "https://token-plan-ams.xiaomimimo.com/v1"
  }
  const model = "mimo-v2.6-flash"
  return { url, key, model }
}

export interface EnrichmentResult {
  ok: boolean
  client_id: number
  website: string | null
  emails: string[]
  phones: string[]
  socials: { linkedin?: string; twitter?: string; facebook?: string; instagram?: string }
  diagnosis: string
  proposal: string
  price: string
  risk_level: string
  risk_score: number
  risk_notes: string
  tech_stack: string
  revenue_estimate: string
  employee_count: string
  next_action: string
  error?: string
}

export async function enrichClient(clientId: number): Promise<EnrichmentResult> {
  const client = getClient(clientId)
  if (!client) {
    return { ok: false, client_id: clientId, website: null, emails: [], phones: [], socials: {}, diagnosis: "", proposal: "", price: "", risk_level: "", risk_score: 0, risk_notes: "", tech_stack: "", revenue_estimate: "", employee_count: "", next_action: "", error: `No client with id ${clientId}.` }
  }

  const website = client.website?.trim() || null
  if (!website) {
    return { ok: false, client_id: clientId, website: null, emails: [], phones: [], socials: {}, diagnosis: "", proposal: "", price: "", risk_level: "", risk_score: 0, risk_notes: "", tech_stack: "", revenue_estimate: "", employee_count: "", next_action: "", error: "No website on file. Set one with crm update first, or run scout to find contact details." }
  }

  const base = /^https?:\/\//i.test(website) ? website.replace(/\/$/, "") : `https://${website.replace(/\/$/, "")}`

  // Fetch homepage + common subpages.
  const pages: { url: string; text: string }[] = []
  const seen = new Set<string>()
  for (const sub of SUBPAGES) {
    const url = sub === "/" ? base : `${base}${sub}`
    if (seen.has(url)) continue
    seen.add(url)
    const text = await fetchPage(url)
    if (text) pages.push({ url, text })
  }

  const allText = pages.map((p) => `--- ${p.url} ---\n${p.text}`).join("\n\n")
  const emails = extractEmails(allText)
  const phones = extractPhones(allText)
  const socials = extractSocials(allText)

  // Read playbooks.
  const diagnosisPlaybook = readPlaybook("ai-enablement-diagnosis")
  const proposalPlaybook = readPlaybook("fixed-scope-proposal")
  const paymentPlaybook = readPlaybook("payment-terms")

  const { url: mimoUrl, key: mimoKey, model } = mimoConfig()
  if (!mimoKey) {
    return { ok: false, client_id: clientId, website: base, emails, phones, socials, diagnosis: "", proposal: "", price: "", risk_level: "", risk_score: 0, risk_notes: "", tech_stack: "", revenue_estimate: "", employee_count: "", next_action: "", error: "XIAOMI_API_KEY is not set." }
  }

  const systemPrompt = `You are Elitza, an AI Enablement operator. You scout local businesses and design fixed-scope AI enablement sprints (EUR 1,500-3,500). You are given a business's public website content and your own playbooks. Produce a concise, honest enrichment report. Never invent facts; mark unknowns as "unknown".

OPERATING PLAYBOOKS (follow these):

=== DIAGNOSIS PLAYBOOK ===
${diagnosisPlaybook}

=== PROPOSAL PLAYBOOK ===
${proposalPlaybook}

=== PAYMENT TERMS PLAYBOOK ===
${paymentPlaybook}`

  const userPrompt = `Business: ${client.name}
Vertical: ${client.vertical ?? "unknown"}
Address: ${client.address ?? "unknown"}
Phone (on file): ${client.phone ?? "none"}
Website: ${base}
Emails found on site: ${emails.join(", ") || "none"}
Phones found on site: ${phones.join(", ") || "none"}
Social profiles found: ${Object.entries(socials).map(([k,v]) => `${k}=${v}`).join(", ") || "none"}

WEBSITE CONTENT:
${allText.slice(0, 12000)}

Produce the enrichment report in this exact format:

DIAGNOSIS:
<2-4 sentences: what the business does, who it serves, current state, volume hints, what breaks. Mark unknowns.>

PAIN_POINTS:
- <bullet 1>
- <bullet 2>
- <bullet 3>

RECOMMENDED_SERVICE:
<one of: single flow EUR 1,500 | two or three flows with CRM EUR 2,500 | document processing with retention EUR 3,500 — and why>

SCOPE:
- <bullet 1: concrete artifact>
- <bullet 2>
- <bullet 3>

PRICE:
<EUR amount and one-line justification>

RISK_LEVEL:
<low | medium | high — assessment of: will they pay? are they financially healthy? do they have budget? red flags like no website, no email, sole proprietor with no staff, declining reviews, etc.>

RISK_SCORE:
<0-100 integer, higher = safer bet>

RISK_NOTES:
<2-3 sentences: why this risk level, what signals you used (review count, site quality, business size, vertical stability, payment terms fit).>

TECH_STACK:
<comma-separated list of technologies/tools detected on their site (CMS, booking tools, CRM, analytics, etc.) or "unknown">

REVENUE_ESTIMATE:
<rough monthly revenue band if inferable (e.g. "EUR 5k-15k/mo") or "unknown">

EMPLOYEE_COUNT:
<rough headcount if inferable (e.g. "1-3", "5-10", "20+") or "unknown">

NEXT_ACTION:
<one sentence: what the operator should do next>

Do not include anything outside these sections.`

  let responseText = ""
  try {
    const res = await fetch(`${mimoUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${mimoKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 1200,
      }),
      signal: AbortSignal.timeout(60000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      return { ok: false, client_id: clientId, website: base, emails, phones, socials, diagnosis: "", proposal: "", price: "", risk_level: "", risk_score: 0, risk_notes: "", tech_stack: "", revenue_estimate: "", employee_count: "", next_action: "", error: `MiMo HTTP ${res.status}: ${detail.slice(0, 200)}` }
    }
    const data = await res.json() as { choices?: { message?: { content?: string } }[] }
    responseText = data.choices?.[0]?.message?.content ?? ""
  } catch (error) {
    return { ok: false, client_id: clientId, website: base, emails, phones, socials, diagnosis: "", proposal: "", price: "", risk_level: "", risk_score: 0, risk_notes: "", tech_stack: "", revenue_estimate: "", employee_count: "", next_action: "", error: `MiMo call failed: ${String(error)}` }
  }

  // Parse sections.
  function section(name: string): string {
    const re = new RegExp(`${name}:\\s*\\n([\\s\\S]*?)(?=\\n[A-Z_]+:|$)`, "i")
    const m = responseText.match(re)
    return m ? m[1].trim() : ""
  }
  const diagnosis = section("DIAGNOSIS")
  const painPoints = section("PAIN_POINTS")
  const recommended = section("RECOMMENDED_SERVICE")
  const scope = section("SCOPE")
  const price = section("PRICE")
  const riskLevel = section("RISK_LEVEL").toLowerCase().trim()
  const riskScoreRaw = section("RISK_SCORE").trim()
  const riskScore = parseInt(riskScoreRaw, 10)
  const riskNotes = section("RISK_NOTES")
  const techStack = section("TECH_STACK")
  const revenueEstimate = section("REVENUE_ESTIMATE")
  const employeeCount = section("EMPLOYEE_COUNT")
  const nextAction = section("NEXT_ACTION")

  const fullDiagnosis = [diagnosis, painPoints ? `\nPain points:\n${painPoints}` : ""].filter(Boolean).join("")
  const fullProposal = [recommended ? `Recommended service: ${recommended}` : "", scope ? `\nScope:\n${scope}` : "", price ? `\nPrice: ${price}` : ""].filter(Boolean).join("\n")

  // Write to CRM.
  try {
    updateClient(clientId, {
      notes: fullDiagnosis || responseText.slice(0, 2000),
      next_action: nextAction || "Review enrichment and decide on proposal.",
      risk_level: riskLevel || null,
      risk_score: isNaN(riskScore) ? null : riskScore,
      risk_notes: riskNotes || null,
      tech_stack: techStack || null,
      revenue_estimate: revenueEstimate || null,
      employee_count: employeeCount || null,
      linkedin: socials.linkedin ?? client.linkedin ?? null,
      twitter: socials.twitter ?? client.twitter ?? null,
      facebook: socials.facebook ?? client.facebook ?? null,
      instagram: socials.instagram ?? client.instagram ?? null,
    })
    // Fill in emails/phones if the client didn't have them.
    if (!client.email && emails.length) updateClient(clientId, { email: emails[0] })
    if (!client.phone && phones.length) updateClient(clientId, { phone: phones[0] })
    logInteraction(clientId, {
      kind: "enrichment",
      direction: "note",
      channel: "web",
      status: "completed",
      subject: `enrichment: ${client.name}`,
      body: responseText,
      occurred_at: new Date().toISOString(),
    })
    // Attach diagnosis + proposal as assets.
    const stamp = new Date().toISOString().slice(0, 10)
    const diagPath = path.join(ELITZA_HOME, "pipeline", stamp, `C${clientId}-diagnosis.md`)
    const propPath = path.join(ELITZA_HOME, "pipeline", stamp, `C${clientId}-proposal.md`)
    fs.mkdirSync(path.dirname(diagPath), { recursive: true })
    fs.writeFileSync(diagPath, `# Diagnosis — ${client.name}\n\n${fullDiagnosis}\n\n---\nRaw enrichment output:\n\n${responseText}\n`)
    fs.writeFileSync(propPath, `# Proposal — ${client.name}\n\n${fullProposal}\n`)
    addAsset(clientId, { kind: "diagnosis", name: `Diagnosis ${stamp}`, path: diagPath, status: "draft" })
    addAsset(clientId, { kind: "proposal", name: `Proposal ${stamp}`, path: propPath, status: "draft" })
  } catch (error) {
    return { ok: false, client_id: clientId, website: base, emails, phones, socials, diagnosis: fullDiagnosis, proposal: fullProposal, price, risk_level: riskLevel, risk_score: isNaN(riskScore) ? 0 : riskScore, risk_notes: riskNotes, tech_stack: techStack, revenue_estimate: revenueEstimate, employee_count: employeeCount, next_action: nextAction, error: `CRM write failed: ${String(error)}` }
  }

  return {
    ok: true,
    client_id: clientId,
    website: base,
    emails,
    phones,
    socials,
    diagnosis: fullDiagnosis,
    proposal: fullProposal,
    price,
    risk_level: riskLevel || "unknown",
    risk_score: isNaN(riskScore) ? 0 : riskScore,
    risk_notes: riskNotes,
    tech_stack: techStack,
    revenue_estimate: revenueEstimate,
    employee_count: employeeCount,
    next_action: nextAction || "Review enrichment and decide on proposal.",
  }
}