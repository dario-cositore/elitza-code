/**
 * Elitza Brain — the AI Enablement CRM (Task C).
 *
 * Its own database (`~/.elitza/brain/crm.db`), deliberately separate from
 * the soul: client rows are case data carrying names, phones and emails, so
 * they keep their own file — independently backed up, exported or wiped,
 * and never indexed into the memory FTS.
 *
 * Tables:
 *   clients             one row per business: identity, scout data, stage, score
 *   client_interactions every touch and reply (Tasks D/E record them)
 *   client_assets       proposals, workbooks, SOPs, invoices (Task G)
 *
 * Status lifecycle, in order (Tasks D-G share it):
 *   scouted -> contacted -> followup_1 -> followup_2 -> followup_3
 *     -> yes  -> diagnose -> proposal -> workbook -> scheduled -> payment -> done
 *     -> no   -> stale
 *
 * Scores are 0-100 (Elitza's qualification), deal_value is whole euros.
 * Nothing here ever sends anything — contact is the pipeline's job.
 */

import { Database } from "bun:sqlite"
import fs from "node:fs"
import { BRAIN_DIR, nowISO } from "./db.js"

export const CRM_DB_PATH = `${BRAIN_DIR}/crm.db`

export const CLIENT_STATUSES = [
  "scouted",
  "contacted",
  "followup_1",
  "followup_2",
  "followup_3",
  "yes",
  "no",
  "stale",
  "diagnose",
  "proposal",
  "workbook",
  "scheduled",
  "payment",
  "done",
] as const

export type ClientStatus = (typeof CLIENT_STATUSES)[number]

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      vertical TEXT,
      status TEXT NOT NULL DEFAULT 'scouted',
      score INTEGER,
      address TEXT,
      phone TEXT,
      website TEXT,
      email TEXT,
      rating REAL,
      rating_count INTEGER,
      category TEXT,
      google_maps TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      notes TEXT,
      deal_value INTEGER,
      currency TEXT NOT NULL DEFAULT 'EUR',
      last_contact TEXT,
      next_action TEXT,
      next_action_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS client_interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      direction TEXT,
      channel TEXT,
      status TEXT,
      subject TEXT,
      body TEXT,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS client_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT,
      status TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS clients_status ON clients(status);
  CREATE INDEX IF NOT EXISTS clients_next_action ON clients(next_action_at);
  CREATE INDEX IF NOT EXISTS interactions_client ON client_interactions(client_id, occurred_at);
  CREATE INDEX IF NOT EXISTS assets_client ON client_assets(client_id);
`

let instance: Database | undefined

/** Open (or return) the single connection to the CRM database. */
export function crmDb(): Database {
  if (instance) return instance
  fs.mkdirSync(BRAIN_DIR, { recursive: true })
  const conn = new Database(CRM_DB_PATH, { create: true })
  conn.exec("PRAGMA journal_mode=WAL")
  conn.exec("PRAGMA foreign_keys=ON")
  conn.exec(SCHEMA)
  instance = conn
  return conn
}

export interface Client {
  id: number
  name: string
  vertical: string | null
  status: string
  score: number | null
  address: string | null
  phone: string | null
  website: string | null
  email: string | null
  rating: number | null
  rating_count: number | null
  category: string | null
  google_maps: string | null
  source: string
  notes: string | null
  deal_value: number | null
  currency: string
  last_contact: string | null
  next_action: string | null
  next_action_at: string | null
  created_at: string
  updated_at: string
}

export interface ClientInput {
  name: string
  vertical?: string
  status?: string
  score?: number
  address?: string
  phone?: string
  website?: string
  email?: string
  rating?: number
  rating_count?: number
  category?: string
  google_maps?: string
  source?: string
  notes?: string
  deal_value?: number
  next_action?: string
  next_action_at?: string
}

export interface Interaction {
  id: number
  client_id: number
  kind: string
  direction: string | null
  channel: string | null
  status: string | null
  subject: string | null
  body: string | null
  occurred_at: string
  created_at: string
}

export interface InteractionInput {
  kind: string
  direction?: string
  channel?: string
  status?: string
  subject?: string
  body?: string
  occurred_at?: string
}

export interface ClientAsset {
  id: number
  client_id: number
  kind: string
  name: string
  path: string | null
  status: string | null
  notes: string | null
  created_at: string
}

export interface AssetInput {
  kind: string
  name: string
  path?: string
  status?: string
  notes?: string
}

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

function assertStatus(status: string): ClientStatus {
  if ((CLIENT_STATUSES as readonly string[]).includes(status)) return status as ClientStatus
  throw new Error(`Unknown status "${status}". Valid: ${CLIENT_STATUSES.join(", ")}`)
}

function rows<T>(sql: string, params: unknown[] = []): T[] {
  return crmDb().query(sql).all(...(params as never[])) as T[]
}

function row<T>(sql: string, params: unknown[] = []): T | undefined {
  return crmDb().query(sql).get(...(params as never[])) as T | undefined
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/**
 * Insert a client, or return the existing one when the same business is
 * already in the CRM: a website match wins (scout data always has one when
 * the business has a site), otherwise name + address must both match.
 */
export function addClient(input: ClientInput): { client: Client; created: boolean } {
  const name = input.name.trim()
  if (!name) throw new Error("A client needs a name.")
  const status = assertStatus(input.status ?? "scouted")
  const website = input.website?.trim() || null
  const address = input.address?.trim() || null

  const existing = website
    ? row<Client>("SELECT * FROM clients WHERE website = ? LIMIT 1", [website])
    : address
      ? row<Client>("SELECT * FROM clients WHERE name = ? AND address = ? LIMIT 1", [name, address])
      : row<Client>("SELECT * FROM clients WHERE name = ? AND address IS NULL LIMIT 1", [name])
  if (existing) return { client: existing, created: false }

  const now = nowISO()
  const result = crmDb()
    .run(
      `INSERT INTO clients (
         name, vertical, status, score, address, phone, website, email, rating, rating_count,
         category, google_maps, source, notes, deal_value, next_action, next_action_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        input.vertical ?? null,
        status,
        input.score ?? null,
        address,
        input.phone ?? null,
        website,
        input.email ?? null,
        input.rating ?? null,
        input.rating_count ?? null,
        input.category ?? null,
        input.google_maps ?? null,
        input.source ?? "manual",
        input.notes ?? null,
        input.deal_value ?? null,
        input.next_action ?? null,
        input.next_action_at ?? null,
        now,
        now,
      ],
    )
  const client = row<Client>("SELECT * FROM clients WHERE id = ?", [result.lastInsertRowid])
  if (!client) throw new Error("Client insert did not produce a row.")
  return { client, created: true }
}

export interface ClientQuery {
  query?: string
  status?: string
  limit?: number
}

/** Find clients by name/vertical/website text and/or exact status, newest first. */
export function findClients(query: ClientQuery = {}): Client[] {
  const limit = Math.max(1, Math.min(200, query.limit ?? 50))
  const filters: string[] = []
  const params: unknown[] = []
  if (query.status) {
    filters.push("status = ?")
    params.push(assertStatus(query.status))
  }
  const text = query.query?.trim()
  if (text) {
    const like = `%${text}%`
    filters.push("(name LIKE ? OR vertical LIKE ? OR website LIKE ? OR notes LIKE ?)")
    params.push(like, like, like, like)
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : ""
  return rows<Client>(`SELECT * FROM clients ${where} ORDER BY updated_at DESC LIMIT ?`, [
    ...params,
    limit,
  ])
}

export function getClient(id: number): Client | null {
  return row<Client>("SELECT * FROM clients WHERE id = ?", [id]) ?? null
}

const UPDATABLE = [
  "name",
  "vertical",
  "status",
  "score",
  "address",
  "phone",
  "website",
  "email",
  "notes",
  "deal_value",
  "next_action",
  "next_action_at",
  "last_contact",
  "source",
] as const

export type ClientPatch = Partial<Record<(typeof UPDATABLE)[number], string | number | null>>

/** Patch a client. Returns the fresh row, or null when the id does not exist. */
export function updateClient(id: number, patch: ClientPatch): Client | null {
  const client = getClient(id)
  if (!client) return null

  const fields: string[] = []
  const params: (string | number | null)[] = []
  for (const key of UPDATABLE) {
    if (!(key in patch)) continue
    if (key === "status") assertStatus(String(patch[key]))
    fields.push(`${key} = ?`)
    params.push(patch[key] ?? null)
  }
  if (!fields.length) return client
  fields.push("updated_at = ?")
  params.push(nowISO(), id)
  crmDb().run(`UPDATE clients SET ${fields.join(", ")} WHERE id = ?`, params)
  return getClient(id)
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

/**
 * Record one touch or reply. Every interaction also moves the client's
 * `last_contact`, because the follow-up cadence (Task E) works off that
 * single column.
 */
export function logInteraction(clientId: number, input: InteractionInput): Interaction {
  const client = getClient(clientId)
  if (!client) throw new Error(`No client with id ${clientId}.`)
  const occurredAt = input.occurred_at ?? nowISO()
  const result = crmDb()
    .run(
      `INSERT INTO client_interactions (
         client_id, kind, direction, channel, status, subject, body, occurred_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        clientId,
        input.kind,
        input.direction ?? null,
        input.channel ?? null,
        input.status ?? null,
        input.subject ?? null,
        input.body ?? null,
        occurredAt,
        nowISO(),
      ],
    )
  crmDb().run("UPDATE clients SET last_contact = ?, updated_at = ? WHERE id = ?", [
    occurredAt,
    nowISO(),
    clientId,
  ])
  const interaction = row<Interaction>("SELECT * FROM client_interactions WHERE id = ?", [
    result.lastInsertRowid,
  ])
  if (!interaction) throw new Error("Interaction insert did not produce a row.")
  return interaction
}

export function listInteractions(clientId: number): Interaction[] {
  return rows<Interaction>(
    "SELECT * FROM client_interactions WHERE client_id = ? ORDER BY occurred_at DESC, id DESC",
    [clientId],
  )
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/** Attach a document or artifact to a client (proposal, workbook, SOP, invoice). */
export function addAsset(clientId: number, input: AssetInput): ClientAsset {
  const client = getClient(clientId)
  if (!client) throw new Error(`No client with id ${clientId}.`)
  const result = crmDb().run(
    `INSERT INTO client_assets (client_id, kind, name, path, status, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [clientId, input.kind, input.name, input.path ?? null, input.status ?? null, input.notes ?? null, nowISO()],
  )
  const asset = row<ClientAsset>("SELECT * FROM client_assets WHERE id = ?", [result.lastInsertRowid])
  if (!asset) throw new Error("Asset insert did not produce a row.")
  return asset
}

export function listAssets(clientId: number): ClientAsset[] {
  return rows<ClientAsset>("SELECT * FROM client_assets WHERE client_id = ? ORDER BY id DESC", [
    clientId,
  ])
}
