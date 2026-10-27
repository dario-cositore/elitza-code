/**
 * Elitza Brain — scouting unit tests.
 *
 * Drives the real scoutBusinesses waterfall against local Bun.serve
 * stand-ins for Photon, the OSM API, Overpass and Google Places via the
 * module's own endpoint overrides, so no test ever touches the live APIs
 * or invents contacts.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { scoutBusinesses } from "./scouting.js"

const ENV_KEYS = ["PHOTON_URL", "OSM_API_URL", "OVERPASS_URL", "GOOGLE_PLACES_URL", "GOOGLE_MAPS_API_KEY"] as const
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

function photonStub(features: unknown[]) {
  return serve(async () => Response.json({ features }))
}

function osmApiStub(tags: Record<string, string> | ((id: number) => Record<string, string>)) {
  return serve(async (request) => {
    const match = new URL(request.url).pathname.match(/\/(\d+)\.json$/)
    const id = match ? Number(match[1]) : 0
    const resolved = typeof tags === "function" ? tags(id) : tags
    return Response.json({ elements: [{ tags: resolved }] })
  })
}

function overpassStub(elements: unknown[]) {
  return serve(async () => Response.json({ elements }))
}

function placesStub(places: unknown[]) {
  return serve(async () => Response.json({ places }))
}

const dentistTags = {
  name: "Studio Dentale Rossi",
  amenity: "dentist",
  "addr:street": "Via Roma",
  "addr:housenumber": "1",
  "addr:postcode": "26022",
  "addr:city": "Castelleone",
  "contact:phone": "+39 0374 123456",
  "contact:website": "https://studio-rossi.example",
}

const dentistFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [9.76, 45.29] },
  properties: {
    osm_type: "N",
    osm_id: 12345,
    osm_key: "amenity",
    osm_value: "dentist",
    name: "Studio Dentale Rossi",
    city: "Castelleone",
    county: "Cremona",
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
  test("scouts keyless off Photon and reads OSM tags", async () => {
    process.env.PHOTON_URL = photonStub([dentistFeature])
    process.env.OSM_API_URL = osmApiStub(dentistTags)
    process.env.OVERPASS_URL = overpassStub([])

    const result = await scoutBusinesses("Castelleone, Italy", "dentisti", 5)

    expect(result.error).toBeUndefined()
    expect(result.meta.sources_used).toEqual(["osm"])
    expect(result.businesses).toHaveLength(1)
    expect(result.businesses[0].name).toBe("Studio Dentale Rossi")
    expect(result.businesses[0].address).toBe("Via Roma 1, 26022 Castelleone")
    expect(result.businesses[0].phone).toBe("+39 0374 123456")
    expect(result.businesses[0].website).toBe("https://studio-rossi.example")
    expect(result.businesses[0].google_maps).toBeNull()
  })

  test("widens to the province when the city scope is empty", async () => {
    const provinceFeature = { ...dentistFeature, properties: { ...dentistFeature.properties, city: "Persico Dosimo", county: "Cremona" } }
    process.env.PHOTON_URL = photonStub([provinceFeature])
    process.env.OSM_API_URL = osmApiStub(dentistTags)
    process.env.OVERPASS_URL = overpassStub([])

    const result = await scoutBusinesses("Cremona, Italy", "dentisti", 5)

    expect(result.businesses).toHaveLength(1)
    expect(result.businesses[0].name).toBe("Studio Dentale Rossi")
  })

  test("falls through to Overpass when Photon comes back short", async () => {
    process.env.PHOTON_URL = photonStub([])
    process.env.OVERPASS_URL = overpassStub([{
      type: "node",
      lat: 45.29,
      lon: 9.76,
      tags: dentistTags,
    }])

    const result = await scoutBusinesses("Castelleone, Italy", "dentisti", 5)

    expect(result.error).toBeUndefined()
    expect(result.meta.sources_used).toEqual(["osm"])
    expect(result.businesses).toHaveLength(1)
    expect(result.businesses[0].name).toBe("Studio Dentale Rossi")
  })

  test("falls through to Google Places when Photon and Overpass are short", async () => {
    process.env.PHOTON_URL = photonStub([])
    process.env.OVERPASS_URL = overpassStub([])
    process.env.GOOGLE_MAPS_API_KEY = "test-key"
    process.env.GOOGLE_PLACES_URL = placesStub([dentistPlace])

    const result = await scoutBusinesses("Castelleone, Italy", "dentisti", 5)

    expect(result.error).toBeUndefined()
    expect(result.meta.sources_used).toEqual(["google_places"])
    expect(result.businesses[0].rating).toBe(4.7)
    expect(result.businesses[0].google_maps).toBe("https://maps.example/studio-rossi")
  })

  test("stops the waterfall before Google Places once Photon fills the limit", async () => {
    const secondFeature = { ...dentistFeature, properties: { ...dentistFeature.properties, osm_id: 99999, name: "Studio Bianchi" } }
    process.env.PHOTON_URL = photonStub([dentistFeature, secondFeature])
    process.env.OSM_API_URL = osmApiStub((id) =>
      id === 99999
        ? { name: "Studio Bianchi", amenity: "dentist", "addr:street": "Via Garibaldi", "addr:housenumber": "4", phone: "+39 0374 654321" }
        : dentistTags,
    )
    process.env.GOOGLE_MAPS_API_KEY = "test-key"
    const placesRequests: Request[] = []
    process.env.GOOGLE_PLACES_URL = placesStub([dentistPlace])

    const result = await scoutBusinesses("Castelleone, Italy", "dentisti", 2)

    expect(result.meta.sources_used).toEqual(["osm"])
    expect(result.businesses).toHaveLength(2)
  })

  test("merges duplicates across sources on phone and fills the gaps", async () => {
    process.env.PHOTON_URL = photonStub([dentistFeature])
    process.env.OSM_API_URL = osmApiStub(dentistTags)
    process.env.OVERPASS_URL = overpassStub([])
    process.env.GOOGLE_MAPS_API_KEY = "test-key"
    process.env.GOOGLE_PLACES_URL = placesStub([dentistPlace])

    const result = await scoutBusinesses("Castelleone, Italy", "dentisti", 5)

    expect(result.meta.sources_used).toEqual(["osm", "google_places"])
    expect(result.businesses).toHaveLength(1)
    expect(result.businesses[0].rating).toBe(4.7)
    expect(result.businesses[0].google_maps).toBe("https://maps.example/studio-rossi")
  })

  test("reports a mapping gap for an unsupported query", async () => {
    const result = await scoutBusinesses("Castelleone, Italy", "pizzeria", 5)

    expect(result.businesses).toHaveLength(0)
    expect(result.error).toContain("no OpenStreetMap mapping")
    expect(result.meta.sources_used).toEqual([])
  })

  test("returns no error when the sources simply have nothing", async () => {
    process.env.PHOTON_URL = photonStub([])
    process.env.OVERPASS_URL = overpassStub([])

    const result = await scoutBusinesses("Castelleone, Italy", "farmacie", 5)

    expect(result.error).toBeUndefined()
    expect(result.businesses).toHaveLength(0)
    expect(result.meta.sources_used).toEqual([])
  })
})