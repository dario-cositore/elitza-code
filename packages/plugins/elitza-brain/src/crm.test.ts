/**
 * Elitza Brain — CRM unit tests.
 *
 * Runs against a throwaway database so a test can never reach the operator's
 * real client records: ELITZA_CRM_DB is read when the connection opens rather
 * than at import time, so it wins no matter which module loaded first, and the
 * guard below refuses to run if the path did not take.
 */

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "elitza-crm-test-"))
process.env.ELITZA_CRM_DB = path.join(home, "crm.db")

const { CLIENT_STATUSES, addClient, crmDbPath, findClients, getClient, updateClient } = await import(
  "./crm.js"
)

if (!crmDbPath().startsWith(home)) throw new Error(`refusing to run against ${crmDbPath()}`)

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe("clients", () => {
  test("add writes a full row and returns it", () => {
    const { client, created } = addClient({
      name: "Studio Rossi",
      website: "https://rossi.example",
      vertical: "dental",
      status: "scouted",
      score: 72,
      deal_value: 1500,
      source: "places",
    })
    expect(created).toBe(true)
    expect(client.id).toBe(1)
    expect(client.score).toBe(72)
    expect(client.deal_value).toBe(1500)
    expect(client.status).toBe("scouted")
    expect(client.created_at).toBeTruthy()
  })

  test("the same website never creates a second row", () => {
    const bySite = addClient({ name: "Studio Rossi", website: "https://rossi.example" })
    expect(bySite.created).toBe(false)
    const byName = addClient({ name: "Studio Rossi" })
    expect(byName.created).toBe(false)
    expect(byName.client.id).toBe(1)
  })

  test("social columns are stored, patched and read back", () => {
    const { client } = addClient({
      name: "Farmacia X",
      website: "https://farmacia.example",
      linkedin: "https://linkedin.com/company/farmacia-x",
    })
    expect(client.linkedin).toBe("https://linkedin.com/company/farmacia-x")
    const patched = updateClient(client.id, { facebook: "https://facebook.com/farmaciax", instagram: null })
    expect(patched?.facebook).toBe("https://facebook.com/farmaciax")
    expect(getClient(client.id)?.instagram).toBeNull()
  })

  test("an unknown status is rejected and names the vocabulary", () => {
    expect(() => addClient({ name: "Nope", status: "bogus" })).toThrow(/Unknown status/)
    expect(CLIENT_STATUSES).toContain("scouted")
    expect(CLIENT_STATUSES).toContain("done")
  })

  test("findClients filters by text and by status", () => {
    expect(findClients({ query: "rossi" }).some((c) => c.name === "Studio Rossi")).toBe(true)
    expect(findClients({ query: "zzz-not-here" })).toHaveLength(0)
    expect(findClients({ status: "scouted" }).length).toBeGreaterThanOrEqual(2)
  })
})
