/**
 * Elitza CRM "house" — a zero-build, single-page web dashboard over the CRM.
 *
 * Exposes `startCrmView()` which binds an HTTP server (default port 8787,
 * override with CRM_VIEW_PORT) serving a JSON API + an embedded HTML
 * dashboard. Reuses the exact same brain modules as the TUI, so there is no
 * second source of truth. Returns a cleanup function that stops the server.
 *
 * The plugin calls this from its setup hook so the house comes up whenever
 * the engine (elitza serve) starts and goes down when it stops.
 */

import { addClient, findClients, getClient, updateClient, listInteractions, listAssets } from "./crm.js"
import { approveDrafts, sendApproved, listPipeline } from "./outreach.js"
import { advance, recordPayment, scheduleCall, productionState } from "./production.js"
import { scoutBusinesses } from "./scouting.js"
import { enrichClient } from "./enrichment.js"

// Load ~/.elitza/.env (mode 600) into process.env, like the elitza launcher does.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
try {
  const envPath = join(homedir(), ".elitza", ".env")
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = val
  }
} catch {
  // No .env — continue with whatever the shell provides.
}

const STATUSES = ["scouted","contacted","followup_1","followup_2","followup_3","yes","no","stale","diagnose","proposal","workbook","scheduled","payment","done"]

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  })
}

async function readBody(req: Request): Promise<any> {
  try { return await req.json() } catch { return {} }
}

export function startCrmView(): { stop: () => void; port: number } | null {
  const PORT = Number(process.env.CRM_VIEW_PORT ?? 8787)
  let server: ReturnType<typeof Bun.serve> | null = null
  try {
    server = Bun.serve({
      port: PORT,
      async fetch(req) {
        const url = new URL(req.url)
        const path = url.pathname

        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "Content-Type" } })
        }

        if (path === "/api/clients" && req.method === "GET") {
          const status = url.searchParams.get("status") ?? undefined
          const query = url.searchParams.get("q") ?? undefined
          const clients = findClients({ status, query, limit: 200 })
          return json({ clients })
        }
        const clientMatch = path.match(/^\/api\/clients\/(\d+)$/)
        if (clientMatch && req.method === "GET") {
          const id = Number(clientMatch[1])
          const client = getClient(id)
          if (!client) return json({ error: "not found" }, 404)
          return json({ client, interactions: listInteractions(id), assets: listAssets(id) })
        }
        if (path === "/api/clients" && req.method === "POST") {
          const body = await readBody(req)
          const { client, created } = addClient({
            name: String(body.name ?? ""),
            vertical: body.vertical, status: body.status, score: body.score,
            address: body.address, phone: body.phone, website: body.website, email: body.email,
            linkedin: body.linkedin, twitter: body.twitter, facebook: body.facebook, instagram: body.instagram,
            notes: body.notes, deal_value: body.deal_value, source: body.source,
            next_action: body.next_action, next_action_at: body.next_action_at,
          })
          return json({ client, created })
        }
        if (path === "/api/clients/update" && req.method === "POST") {
          const body = await readBody(req)
          const id = Number(body.id)
          const patch: any = {}
          for (const k of ["name","vertical","status","score","address","phone","website","email","linkedin","twitter","facebook","instagram","notes","deal_value","next_action","next_action_at","last_contact","source"]) {
            if (k in body) patch[k] = body[k]
          }
          const client = updateClient(id, patch)
          return json({ client })
        }
        if (path === "/api/drafts" && req.method === "GET") {
          const rows = listPipeline({ limit: 200 }).filter((r) => r.draft_path)
          const drafts = rows.map((r) => {
            const c = getClient(r.client_id)
            return { id: r.id, client_id: r.client_id, client_name: c?.name ?? null, subject: r.draft_path, path: r.draft_path, approved: r.approved, stage: r.stage }
          })
          return json({ drafts })
        }
        if (path === "/api/approve" && req.method === "POST") {
          const body = await readBody(req)
          const ids = (body.ids ?? []).map(Number)
          const rows = approveDrafts(ids)
          return json({ approved: rows.length, rows })
        }
        if (path === "/api/send" && req.method === "POST") {
          const body = await readBody(req)
          const ids = body.ids ? body.ids.map(Number) : undefined
          const result = await sendApproved(ids)
          return json(result)
        }
        if (path === "/api/advance" && req.method === "POST") {
          const body = await readBody(req)
          const moved = advance(Number(body.id), String(body.stage), { note: body.note, asset: body.asset })
          return json(moved)
        }
        if (path === "/api/payment" && req.method === "POST") {
          const body = await readBody(req)
          const paid = recordPayment(Number(body.id), { amount: body.amount, note: body.note, invoice_path: body.invoice_path })
          return json(paid)
        }
        if (path === "/api/schedule" && req.method === "POST") {
          const body = await readBody(req)
          const booked = scheduleCall(Number(body.id), String(body.when), body.note)
          return json(booked)
        }
        if (path === "/api/scout" && req.method === "POST") {
          const body = await readBody(req)
          const result = await scoutBusinesses(String(body.location ?? ""), String(body.query ?? ""), Number(body.limit ?? 10))
          return json(result)
        }
        if (path === "/api/enrich" && req.method === "POST") {
          const body = await readBody(req)
          const result = await enrichClient(Number(body.id))
          return json(result)
        }
        if (path === "/api/where" && req.method === "POST") {
          const body = await readBody(req)
          const w = productionState(Number(body.id))
          return json(w)
        }
        if (path === "/api/log" && req.method === "POST") {
          const body = await readBody(req)
          const { logInteraction } = await import("./crm.js")
          const interaction = logInteraction(Number(body.id), {
            kind: String(body.kind ?? "note"),
            direction: body.direction,
            channel: body.channel,
            status: body.status,
            subject: body.subject,
            body: body.body,
            occurred_at: body.occurred_at,
          })
          return json({ interaction })
        }
        if (path === "/api/asset" && req.method === "POST") {
          const body = await readBody(req)
          const filePath = String(body.path ?? "")
          // Only read files under the Elitza home or /tmp (safety).
          const home = process.env.HOME ?? ""
          const allowed = [`${home}/.elitza`, "/tmp", `${home}/.openclaw`]
          if (!allowed.some((root) => filePath.startsWith(root))) {
            return json({ error: "path not allowed" }, 403)
          }
          try {
            const content = await Bun.file(filePath).text()
            return json({ path: filePath, content })
          } catch (e) {
            return json({ error: String(e) }, 404)
          }
        }

        return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } })
      },
    })
  } catch (error) {
    console.error(`[crm-view] could not bind port ${PORT}: ${String(error)}`)
    return null
  }

  console.log(`[crm-view] Elitza CRM house listening on http://127.0.0.1:${PORT}`)
  // Auto-open in the default browser on first start (best-effort, never fatal).
  if (!process.env.CRM_VIEW_NO_OPEN) {
    try {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
      Bun.spawn([opener, `http://127.0.0.1:${PORT}`], { stdout: "ignore", stderr: "ignore" })
    } catch {
      // No browser available — the URL is printed above.
    }
  }
  return { stop: () => server?.stop(true), port: PORT }
}

import { fileURLToPath } from "node:url"
import { dirname } from "node:path"
const _here = dirname(fileURLToPath(import.meta.url))
const HTML = readFileSync(join(_here, "crmview.html"), "utf8")