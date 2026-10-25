/**
 * Elitza Brain — local client scouting (Task B).
 *
 * Scouting is keyless first: OpenStreetMap's Overpass API carries the
 * search, and Google Places runs only as an optional paid fallback when
 * the operator's own GOOGLE_MAPS_API_KEY is in the environment. Without
 * the key Google is simply skipped — scouting keeps working.
 *
 * One call in, the business fields an AI Enabler needs out — name, address,
 * phone, website, rating, review count, category, map link — merged and
 * deduplicated across sources on name, phone, website and address. Contact
 * details only ever come from public tags and Places fields; nothing is
 * ever invented, especially not phone numbers or websites.
 *
 * Waterfall: Overpass first; a source that fails or comes back short hands
 * over to the next one, and the walk stops early once enough results are
 * in. Areas are scoped at admin_level=8 (cities) with an admin_level=6
 * (province) fallback, and ways/relations get coordinates via
 * `out center tags`.
 *
 * Key policy: the operator's own GOOGLE_MAPS_API_KEY, read from the
 * environment (the launcher loads ~/.elitza/.env). Nothing is embedded in
 * the repo, and the soul only ever learns whether the key exists.
 *
 * Endpoint policy: the public Overpass instances in order, overridable
 * with OVERPASS_URL, and the official Google endpoint overridable with
 * GOOGLE_PLACES_URL — the same pattern GAPFEED_LOCAL_URL uses, so tests
 * run against local servers instead of the live APIs.
 *
 * This module only searches. It never drafts, never sends, never writes a
 * client anywhere — those are the CRM and pipeline's jobs.
 *
 * Config (env):
 *   GOOGLE_MAPS_API_KEY   optional; enables the Google Places fallback
 *   GOOGLE_PLACES_URL     default https://places.googleapis.com/v1/places:searchText
 *   OVERPASS_URL          default the public Overpass mirrors below
 */

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
const OVERPASS_TIMEOUT_MS = 45_000
const GOOGLE_TIMEOUT_MS = 8_000
const MAX_LIMIT = 20
const USER_AGENT = "Elitza client_scout (https://elitza.life)"

/**
 * The scouting vocabulary to OSM tags. Matchers are accent-insensitive:
 * a single-word matcher hits whole query words only (so "bar" never
 * catches "barbiere"), multi-word matchers match as substrings.
 */
const CATEGORY_TAGS = [
  {
    match: ["idraulico", "idraulici", "idraulica", "plumber", "plumbers"],
    tags: [
      ["craft", "plumber"],
      ["shop", "plumber"],
    ],
  },
  {
    match: ["parrucchiere", "parrucchieri", "parrucchiera", "hairdresser", "hairdressers"],
    tags: [["shop", "hairdresser"]],
  },
  {
    match: ["dentista", "dentisti", "dentist", "dentists"],
    tags: [["amenity", "dentist"]],
  },
  {
    match: ["avvocato", "avvocati", "lawyer", "lawyers", "attorney", "attorneys"],
    tags: [
      ["office", "lawyer"],
      ["office", "attorney"],
    ],
  },
  {
    match: ["commercialista", "commercialisti", "accountant", "accountants"],
    tags: [["office", "accountant"]],
  },
  {
    match: ["ristorante", "ristoranti", "restaurant", "restaurants", "bar", "caffe", "cafe", "cafes"],
    tags: [
      ["amenity", "restaurant"],
      ["amenity", "cafe"],
    ],
  },
  {
    match: ["autofficina", "autofficine", "car repair", "mechanic", "garage"],
    tags: [["shop", "car_repair"]],
  },
  {
    match: ["farmacia", "farmacie", "pharmacy", "pharmacies"],
    tags: [["amenity", "pharmacy"]],
  },
]

export interface ScoutedBusiness {
  name: string
  address: string
  phone: string | null
  website: string | null
  rating: number | null
  rating_count: number | null
  category: string
  google_maps: string | null
}

export interface ScoutResult {
  businesses: ScoutedBusiness[]
  meta: { sources_used: string[] }
  error?: string
}

interface OverpassElement {
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

interface OverpassResponse {
  elements?: OverpassElement[]
  remark?: string
}

interface PlacesResponse {
  places?: {
    displayName?: { text?: string }
    formattedAddress?: string
    nationalPhoneNumber?: string
    internationalPhoneNumber?: string
    websiteUri?: string
    rating?: number
    userRatingCount?: number
    primaryType?: string
    primaryTypeDisplayName?: { text?: string }
    googleMapsUri?: string
  }[]
}

type Candidate = { business: ScoutedBusiness; source: string }
type Merged = { business: ScoutedBusiness; sources: string[] }

/**
 * Search local businesses. Sources are walked as a waterfall (Overpass,
 * then Google Places behind the key), merged and deduplicated. A dead
 * source, a refused request, or a query with no OSM mapping comes back as
 * `error` rather than a throw, so the tool can tell the operator what to
 * fix instead of dumping a stack trace.
 */
export async function scoutBusinesses(
  location: string,
  query: string,
  limit = 10,
): Promise<ScoutResult> {
  const size = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
  const candidates: Candidate[] = []
  const failures: string[] = []

  const osmTags = tagsForQuery(query)
  if (osmTags.length) {
    const osm = await scoutOsm(location, osmTags)
    if (osm.error) failures.push(osm.error)
    candidates.push(...osm.businesses.map((business) => ({ business, source: "osm" })))
  } else {
    failures.push(
      `no OpenStreetMap mapping for "${query}" (known: idraulici, parrucchieri, dentisti, avvocati, commercialisti, ristoranti, bar, autofficine, farmacie)`,
    )
  }

  const key = process.env.GOOGLE_MAPS_API_KEY?.trim()
  if (key && mergeDedup(candidates).length < size) {
    const google = await googleSearch(location, query, key, size)
    if (google.error) failures.push(google.error)
    candidates.push(...google.businesses.map((business) => ({ business, source: "google_places" })))
  }

  const merged = mergeDedup(candidates).slice(0, size)
  if (!merged.length && failures.length) {
    return { businesses: [], meta: { sources_used: [] }, error: failures.join("; ") }
  }
  return {
    businesses: merged.map((entry) => entry.business),
    meta: { sources_used: [...new Set(merged.flatMap((entry) => entry.sources))] },
  }
}

/** True when the operator's own key is in the environment. The value never leaves it. */
export function scoutKeyPresent(): boolean {
  return Boolean(process.env.GOOGLE_MAPS_API_KEY?.trim())
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const EMAIL_NOISE = ["example.", "example@", "sentry.", "wixpress", "yourdomain"]

/**
 * Find a contact address on a business's own website — Places never returns
 * emails, so the first touch needs this. Reads the homepage once: a
 * `mailto:` wins, otherwise the first plain address that is not placeholder
 * junk. Returns null rather than guessing (a made-up info@ only bounces).
 */
export async function discoverEmail(website: string): Promise<string | null> {
  const raw = website.trim()
  if (!raw) return null
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
      headers: { "User-Agent": USER_AGENT },
    })
    if (!response.ok) return null
    const html = (await response.text()).slice(0, 500_000)
    const mailto = /mailto:\s*([^\s"'?#]+)/i.exec(html)
    const candidates = mailto ? [mailto[1]] : html.match(new RegExp(EMAIL_PATTERN, "gi")) ?? []
    for (const candidate of candidates) {
      const email = decodeURIComponent(candidate).trim().replace(/[.,;:]+$/, "").toLowerCase()
      if (EMAIL_PATTERN.test(email) && !EMAIL_NOISE.some((noise) => email.includes(noise))) return email
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Overpass (primary source)
// ---------------------------------------------------------------------------

function overpassEndpoints(): string[] {
  const override = process.env.OVERPASS_URL?.trim()
  return override ? [override.replace(/\/$/, "")] : OVERPASS_ENDPOINTS
}

function overpassQuery(areaName: string, adminLevel: string, tags: string[][]): string {
  const escaped = areaName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const filters = tags.map(([key, value]) => `nwr(area.a)["${key}"="${value}"];`).join("")
  return `[out:json][timeout:25];area["name"~"^${escaped}$",i]["boundary"="administrative"]["admin_level"="${adminLevel}"]->.a;(${filters});out center tags;`
}

function areaAttempts(location: string) {
  const tokens = location
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
  const attempts = [
    { name: tokens[0], level: "8" },
    { name: tokens[0], level: "6" },
  ]
  if (tokens[1]) attempts.push({ name: tokens[1], level: "6" })
  return attempts
}

/**
 * Walk the mirror list for one query. `answered` is true when some mirror
 * gave a clean 200 — only then is it worth widening the area scope, so a
 * dead or overloaded Overpass fleet is not retried once per scope.
 */
async function overpassSearch(query: string): Promise<{
  elements: OverpassElement[]
  answered: boolean
  error?: string
}> {
  const failures: string[] = []
  let answered = false
  for (const url of overpassEndpoints()) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
      })
      if (!response.ok) {
        failures.push(`${url}: HTTP ${response.status}`)
        continue
      }
      const body = (await response.json()) as OverpassResponse
      const elements = Array.isArray(body.elements) ? body.elements : []
      if (body.remark && !elements.length) {
        failures.push(`${url}: ${body.remark}`)
        continue
      }
      return { elements, answered: true }
    } catch (error) {
      failures.push(`${url}: ${String(error)}`)
    }
  }
  return { elements: [], answered, error: failures.join("; ") }
}

async function scoutOsm(location: string, tags: string[][]): Promise<{ businesses: ScoutedBusiness[]; error?: string }> {
  const failures: string[] = []
  for (const attempt of areaAttempts(location)) {
    const result = await overpassSearch(overpassQuery(attempt.name, attempt.level, tags))
    if (result.error) failures.push(result.error)
    const businesses = result.elements
      .map((element) => toOsmBusiness(element, tags))
      .filter((business): business is ScoutedBusiness => business !== null)
    if (businesses.length) return { businesses }
    if (!result.answered) return { businesses: [], error: `Overpass search failed: ${failures.join("; ")}` }
  }
  return {
    businesses: [],
    error: failures.length ? `Overpass search failed: ${failures.join("; ")}` : undefined,
  }
}

function toOsmBusiness(element: OverpassElement, tags: string[][]): ScoutedBusiness | null {
  const found = element.tags
  if (!found?.name) return null
  return {
    name: found.name,
    address: osmAddress(found),
    phone: found.phone ?? found["contact:phone"] ?? null,
    website: found.website ?? found["contact:website"] ?? null,
    rating: null,
    rating_count: null,
    category: [...new Set(tags.filter(([key, value]) => found[key] === value).map((pair) => pair[1]))].join(", "),
    google_maps: null,
  }
}

function osmAddress(tags: Record<string, string>): string {
  if (tags["addr:full"]) return tags["addr:full"]
  return [
    [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" "),
    [tags["addr:postcode"], tags["addr:city"]].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ")
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function tagsForQuery(query: string): string[][] {
  const normalized = normalizeText(query)
  const words = new Set(normalized.split(" "))
  return CATEGORY_TAGS.flatMap((entry) =>
    entry.match.some((matcher) => {
      const word = normalizeText(matcher)
      return word.includes(" ") ? normalized.includes(word) : words.has(word)
    })
      ? entry.tags
      : [],
  )
}

// ---------------------------------------------------------------------------
// Google Places (optional fallback)
// ---------------------------------------------------------------------------

const DEFAULT_ENDPOINT = "https://places.googleapis.com/v1/places:searchText"

const FIELD_MASK = [
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.primaryType",
  "places.primaryTypeDisplayName",
  "places.googleMapsUri",
].join(",")

function endpoint(): string {
  return (process.env.GOOGLE_PLACES_URL || DEFAULT_ENDPOINT).replace(/\/$/, "")
}

async function googleSearch(
  location: string,
  query: string,
  key: string,
  size: number,
): Promise<{ businesses: ScoutedBusiness[]; error?: string }> {
  try {
    const response = await fetch(endpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({ textQuery: `${query} in ${location}`, pageSize: size }),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    })
    if (!response.ok) {
      return { businesses: [], error: `Places search failed: HTTP ${response.status}` }
    }
    const body = (await response.json()) as PlacesResponse
    const places = Array.isArray(body.places) ? body.places : []
    return { businesses: places.slice(0, size).map(toBusiness) }
  } catch (error) {
    return { businesses: [], error: `Places search failed: ${String(error)}` }
  }
}

function toBusiness(place: NonNullable<PlacesResponse["places"]>[number]): ScoutedBusiness {
  return {
    name: place.displayName?.text ?? "",
    address: place.formattedAddress ?? "",
    phone: place.nationalPhoneNumber ?? place.internationalPhoneNumber ?? null,
    website: place.websiteUri ?? null,
    rating: typeof place.rating === "number" ? place.rating : null,
    rating_count: place.userRatingCount ?? null,
    category: place.primaryTypeDisplayName?.text ?? place.primaryType ?? "",
    google_maps: place.googleMapsUri ?? null,
  }
}

// ---------------------------------------------------------------------------
// Merge and dedup on name/phone/website/address
// ---------------------------------------------------------------------------

function dedupKeys(business: ScoutedBusiness): string[] {
  const phone = business.phone?.replace(/\D/g, "")
  const website = business.website
    ?.trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
  const name = normalizeText(business.name)
  const address = normalizeText(business.address)
  return [
    phone ? `phone:${phone}` : "",
    website ? `web:${website}` : "",
    name && address ? `na:${name}|${address}` : "",
  ].filter(Boolean)
}

function mergeDedup(candidates: Candidate[]): Merged[] {
  const merged: Merged[] = []
  const byKey = new Map<string, number>()
  for (const candidate of candidates) {
    const keys = dedupKeys(candidate.business)
    const hit = keys.map((key) => byKey.get(key)).find((index) => index !== undefined)
    if (hit === undefined) {
      merged.push({ business: { ...candidate.business }, sources: [candidate.source] })
      for (const key of keys) byKey.set(key, merged.length - 1)
      continue
    }
    merged[hit].business = fillBusiness(merged[hit].business, candidate.business)
    if (!merged[hit].sources.includes(candidate.source)) merged[hit].sources.push(candidate.source)
    for (const key of keys) byKey.set(key, hit)
  }
  return merged
}

function fillBusiness(base: ScoutedBusiness, extra: ScoutedBusiness): ScoutedBusiness {
  return {
    name: base.name || extra.name,
    address: base.address || extra.address,
    phone: base.phone ?? extra.phone,
    website: base.website ?? extra.website,
    rating: base.rating ?? extra.rating,
    rating_count: base.rating_count ?? extra.rating_count,
    category: base.category || extra.category,
    google_maps: base.google_maps ?? extra.google_maps,
  }
}
