/**
 * Elitza Brain — scouting unit tests.
 *
 * Drives the real scoutBusinesses waterfall against local Bun.serve
 * stand-ins for Overpass and Google Places via the module's own endpoint
 * overrides, so no test ever touches the live APIs or invents contacts.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { scoutBusinesses } from "./scouting.js"

const ENV_KEYS = ["OVERPASS_URL", "GOOGLE_PLACES_URL", "GOOGLE_MAPS_API_KEY"] as const
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))
const servers: { stop: (force?: boolean) => void }[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handler })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}

function overpassStub(elements: unknown[], queries: string[] = []) {
  return serve(async (request) => {
    queries.push(new URLSearchParams(await request.text()).get("data") ?? "")
    return Response.json({ elements })
  })
}

function placesStub(places: unknown[], requests: Request[] = []) {
  return serve(async (request) => {
    requests.push(request)
    return Response.json({ places })
  })
}

const dentistNode = {
  type: "node",
  lat: 45.29,
  lon: 9.76,
  tags: {
    name: "Studio Dentale Rossi",
    amenity: "dentist",
    "addr:street": "Via Roma",
    "addr:housenumber": "1",
    "addr:postcode": "26022",
    "addr:city": "Castelleone",
    "contact:phone": "+39 0374 123456",
    "contact:website": "https://studio-rossi.example",
  },
}

const dentistPlace = {
  displayName: { text: "Studio Dentale Rossi" },
  formattedAddress: "Via Roma 1, 26022 Castelleone CR, Italy",
  nationalPhoneNumber: "+39 0374 123456",
  websiteUri: "https://studio-rossi.example",
  rating: 4.7,
  userRatingCount: 89,
  primaryType: "dentist",
  primaryTypeDisplayName: { text: "Dentist" },
  googleMapsUri: "https://maps.example/studio-rossi",
}

describe("scoutBusinesses", () => {
  test("scouts keyless off Overpass and reads contact:* tags", async () => {
    const queries: string[] = []
    process.env.OVERPASS_URL = overpassStub([dentistNode], queries)

    const result = await scoutBusinesses("Castelleone, Italy", "dentisti", 5)

    expect(result.error).toBeUndefined()
    expect(result.meta.sources_used).toEqual(["osm"])
    expect(result.businesses).toHaveLength(1)
    expect(result.businesses[0].name).toBe("Studio Dentale Rossi")
    expect(result.businesses[0].address).toBe("Via Roma 1, 26022 Castelleone")
    expect(result.businesses[0].phone).toBe("+39 0374 123456")
    expect(result.businesses[0].website).toBe("https://studio-rossi.example")
    expect(result.businesses[0].google_maps).toBeNull()
    expect(queries[0]).toContain('["admin_level"="8"]')
    expect(queries[0]).toContain('["amenity"="dentist"]')
    expect(queries[0]).toContain("out center tags")
  })

  test("widens to the province area at admin_level=6 when the city scope is empty", async () => {
    const queries: string[] = []
    process.env.OVERPASS_URL = serve(async (request) => {
      const query = new URLSearchParams(await request.text()).get("data") ?? ""
      queries.push(query)
      return Response.json({ elements: query.includes('["admin_level"="6"]') ? [dentistNode] : [] })
    })

    const result = await scoutBusinesses("Castelleone, Cremona, Italy", "dentisti", 5)

    expect(result.businesses).toHaveLength(1)
    expect(queries.some((query) => query.includes('["admin_level"="6"]'))).toBe(true)
  })

  test("falls through to Google Places when Overpass comes back short", async () => {
    process.env.OVERPASS_URL = overpassStub([])
    process.env.GOOGLE_MAPS_API_KEY = "test-key"
    const placesRequests: Request[] = []
    process.env.GOOGLE_PLACES_URL = placesStub([dentistPlace], placesRequests)

    const result = await scoutBusinesses("Castelleone, Italy", "dentisti", 5)

    expect(result.error).toBeUndefined()
    expect(result.meta.sources_used).toEqual(["google_places"])
    expect(result.businesses[0].rating).toBe(4.7)
    expect(result.businesses[0].google_maps).toBe("https://maps.example/studio-rossi")
    expect(placesRequests).toHaveLength(1)
  })

  test("stops the waterfall before Google Places once Overpass fills the limit", async () => {
    process.env.OVERPASS_URL = overpassStub([
      dentistNode,
      {
        type: "node",
        lat: 45.3,
        lon: 9.77,
        tags: {
          name: "Studio Bianchi",
          amenity: "dentist",
          "addr:street": "Via Garibaldi",
          "addr:housenumber": "4",
          phone: "+39 0374 654321",
        },
      },
    ])
    process.env.GOOGLE_MAPS_API_KEY = "test-key"
    const placesRequests: Request[] = []
    process.env.GOOGLE_PLACES_URL = placesStub([dentistPlace], placesRequests)

    const result = await scoutBusinesses("Castelleone, Italy", "dentisti", 2)

    expect(result.meta.sources_used).toEqual(["osm"])
    expect(result.businesses).toHaveLength(2)
    expect(placesRequests).toHaveLength(0)
  })

  test("merges duplicates across sources on phone and fills the gaps", async () => {
    process.env.OVERPASS_URL = overpassStub([dentistNode])
    process.env.GOOGLE_MAPS_API_KEY = "test-key"
    process.env.GOOGLE_PLACES_URL = placesStub([dentistPlace])

    const result = await scoutBusinesses("Castelleone, Italy", "dentisti", 5)

    expect(result.meta.sources_used).toEqual(["osm", "google_places"])
    expect(result.businesses).toHaveLength(1)
    expect(result.businesses[0].rating).toBe(4.7)
    expect(result.businesses[0].google_maps).toBe("https://maps.example/studio-rossi")
  })

  test("reports a mapping gap for an unsupported query with no key", async () => {
    process.env.OVERPASS_URL = overpassStub([])

    const result = await scoutBusinesses("Castelleone, Italy", "pizzeria", 5)

    expect(result.businesses).toHaveLength(0)
    expect(result.error).toContain("no OpenStreetMap mapping")
    expect(result.meta.sources_used).toEqual([])
  })

  test("returns no error when the sources simply have nothing", async () => {
    process.env.OVERPASS_URL = overpassStub([])

    const result = await scoutBusinesses("Castelleone, Italy", "farmacie", 5)

    expect(result.error).toBeUndefined()
    expect(result.businesses).toHaveLength(0)
    expect(result.meta.sources_used).toEqual([])
  })
})
