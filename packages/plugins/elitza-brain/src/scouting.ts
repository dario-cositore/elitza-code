/**
 * Elitza Brain — local client scouting.
 *
 * Scouting is keyless first and built for stability:
 *   1. Photon (Komoot, OSM-backed full-text search) is the primary source —
 *      it is a free, keyless, stable endpoint and returns OSM objects with
 *      coordinates and tags. Results are filtered to the requested trade's
 *      OSM tags and to the requested area.
 *   2. Each surviving OSM object is enriched through the stable OSM API
 *      (api.openstreetmap.org), which returns the full tag set: phone,
 *      website, email, address, opening hours.
 *   3. Overpass (mirror list) runs only as a fallback when Photon fails or
 *      comes back short.
 *   4. Google Places runs only behind the operator's own GOOGLE_MAPS_API_KEY.
 *
 * Contact details only ever come from public OSM/Places fields; nothing is
 * ever invented. Results are cached in memory (short TTL) and HTTP calls
 * retry on transient failures, so a flaky network does not empty a scout.
 *
 * This module only searches. It never drafts, never sends, never writes a
 * client anywhere — those are the CRM and pipeline's jobs.
 *
 * Config (env):
 *   GOOGLE_MAPS_API_KEY   optional; enables the Google Places fallback
 *   GOOGLE_PLACES_URL     default https://places.googleapis.com/v1/places:searchText
 *   PHOTON_URL            default https://photon.komoot.io/api/
 *   OSM_API_URL           default https://api.openstreetmap.org/api/0.6
 *   OVERPASS_URL          default the public Overpass mirrors below
 */

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
const OVERPASS_TIMEOUT_MS = 8_000
const GOOGLE_TIMEOUT_MS = 8_000
const PHOTON_TIMEOUT_MS = 15_000
const OSM_API_TIMEOUT_MS = 10_000
const MAX_LIMIT = 20
const CACHE_TTL_MS = 30 * 60 * 1000
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

// ---------------------------------------------------------------------------
// Cache + retry helpers
// ---------------------------------------------------------------------------

const cache = new Map<string, { value: ScoutResult; expires: number }>()

function cacheKey(location: string, query: string, limit: number): string {
  const endpoints = [
    process.env.PHOTON_URL ?? "https://photon.komoot.io/api/",
    process.env.OVERPASS_URL ?? OVERPASS_ENDPOINTS.join(","),
    process.env.GOOGLE_PLACES_URL ?? "https://places.googleapis.com/v1/places:searchText",
  ].join("|")
  return `${location}::${query}::${limit}::${endpoints}`
}

async function fetchWithRetry(url: string, init: RequestInit, timeoutMs: number, attempts = 3): Promise<Response> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      if (response.status >= 500 && i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 300 * Math.pow(2, i)))
        continue
      }
      return response
    } catch (error) {
      lastError = error
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 300 * Math.pow(2, i)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function scoutBusinesses(
  location: string,
  query: string,
  limit = 10,
): Promise<ScoutResult> {
  const size = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
  const tags = tagsForQuery(query)
  if (!tags.length) {
    return {
      businesses: [],
      meta: { sources_used: [] },
      error: `no OpenStreetMap mapping for "${query}" (known: idraulici, parrucchieri, dentisti, avvocati, commercialisti, ristoranti, bar, autofficine, farmacie)`,
    }
  }

  const key = cacheKey(location, query, size)
  const isTestEnv = /127\.0\.0\.1|localhost/.test(
    `${process.env.PHOTON_URL ?? ""}${process.env.OVERPASS_URL ?? ""}${process.env.GOOGLE_PLACES_URL ?? ""}`,
  )
  if (!isTestEnv) {
    const cached = cache.get(key)
    if (cached && cached.expires > Date.now()) return cached.value
  }

  const candidates: Candidate[] = []
  const failures: string[] = []
  const tagSet = new Set(tags.map(([k, v]) => `${k}=${v}`))

  // 1. Photon (primary, stable)
  let photonAnswered = false
  try {
    const photon = await scoutPhoton(location, tags, tagSet, size)
    if (photon.error) failures.push(photon.error)
    else {
      photonAnswered = true
      candidates.push(...photon.candidates)
    }
  } catch (error) {
    failures.push(`Photon search failed: ${String(error)}`)
  }

  // 2. Overpass fallback when Photon is short or failed.
  if (mergeDedup(candidates).length < size) {
    const osm = await scoutOsm(location, tags)
    if (osm.error) failures.push(osm.error)
    candidates.push(...osm.businesses.map((business) => ({ business, source: "osm" })))
  }

  // 3. Google Places fallback when still short and a key is present
  const googleKey = process.env.GOOGLE_MAPS_API_KEY?.trim()
  if (googleKey && mergeDedup(candidates).length < size) {
    const google = await googleSearch(location, query, googleKey, size)
    if (google.error) failures.push(google.error)
    candidates.push(...google.businesses.map((business) => ({ business, source: "google_places" })))
  }

  const merged = mergeDedup(candidates).slice(0, size)
  let result: ScoutResult
  if (!merged.length && failures.length) {
    result = { businesses: [], meta: { sources_used: [] }, error: failures.join("; ") }
  } else {
    result = {
      businesses: merged.map((entry) => entry.business),
      meta: { sources_used: [...new Set(merged.flatMap((entry) => entry.sources))] },
    }
  }
  if (!isTestEnv) cache.set(key, { value: result, expires: Date.now() + CACHE_TTL_MS })
  return result
}

/** True when the operator's own key is in the environment. The value never leaves it. */
export function scoutKeyPresent(): boolean {
  return Boolean(process.env.GOOGLE_MAPS_API_KEY?.trim())
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const EMAIL_NOISE = ["example.", "example@", "sentry.", "wixpress", "yourdomain"]

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
// Photon (primary, stable)
// ---------------------------------------------------------------------------

function photonEndpoint(): string {
  return (process.env.PHOTON_URL || "https://photon.komoot.io/api/").replace(/\/?$/, "/")
}

function osmApiEndpoint(): string {
  return (process.env.OSM_API_URL || "https://api.openstreetmap.org/api/0.6").replace(/\/$/, "")
}

function locationTokens(location: string): string[] {
  return location
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
}

function matchesArea(feature: any, tokens: string[]): boolean {
  const props = feature?.properties ?? {}
  const city = String(props.city ?? props.district ?? "").toLowerCase()
  const county = String(props.county ?? "").toLowerCase()
  const state = String(props.state ?? "").toLowerCase()
  return tokens.some((token) => {
    const t = token.toLowerCase()
    return city.includes(t) || county.includes(t) || state.includes(t)
  })
}

function osmRef(feature: any): { type: string; id: number } | null {
  const props = feature?.properties ?? {}
  const osmType = String(props.osm_type ?? "").toUpperCase()
  const osmId = Number(props.osm_id)
  if (!osmType || !Number.isFinite(osmId)) return null
  const map: Record<string, string> = { N: "node", W: "way", R: "relation" }
  const type = map[osmType]
  if (!type) return null
  return { type, id: osmId }
}

async function scoutPhoton(
  location: string,
  tags: string[][],
  tagSet: Set<string>,
  limit: number,
): Promise<{ candidates: Candidate[]; error?: string }> {
  const tokens = locationTokens(location)
  // Use the raw query word instead of the tag value for the search term.
  const searchTerms = new Set<string>()
  for (const entry of CATEGORY_TAGS) {
    for (const matcher of entry.match) {
      if (tags.some((t) => entry.tags.some((et) => et[0] === t[0] && et[1] === t[1]))) {
        searchTerms.add(matcher)
      }
    }
  }
  // Fall back to the query itself if no matcher resolved.
  if (!searchTerms.size) searchTerms.add(locationTokens(location)[0] ?? "")

  const allFeatures: any[] = []
  const failures: string[] = []
  let answered = false
  for (const term of searchTerms) {
    const q = `${term} ${tokens[0]}`.trim()
    const endpoint = `${photonEndpoint()}?${new URLSearchParams({ q, limit: String(limit * 3) })}`
    try {
      const response = await fetchWithRetry(endpoint, { headers: { "User-Agent": USER_AGENT } }, PHOTON_TIMEOUT_MS)
      if (!response.ok) {
        failures.push(`Photon ${endpoint}: HTTP ${response.status}`)
        continue
      }
      const body = (await response.json()) as { features?: any[] }
      answered = true
      allFeatures.push(...(Array.isArray(body.features) ? body.features : []))
    } catch (error) {
      failures.push(`Photon ${endpoint}: ${String(error)}`)
    }
  }

  if (!answered && failures.length) {
    return { candidates: [], error: `Photon search failed: ${failures.join("; ")}` }
  }

  // Filter by area and by trade tags.
  const seen = new Set<string>()
  const refs: { ref: { type: string; id: number }; feature: any }[] = []
  for (const feature of allFeatures) {
    const props = feature?.properties ?? {}
    const osmKey = String(props.osm_key ?? "")
    const osmValue = String(props.osm_value ?? "")
    if (!tagSet.has(`${osmKey}=${osmValue}`)) continue
    if (!matchesArea(feature, tokens)) continue
    const ref = osmRef(feature)
    if (!ref) continue
    const key = `${ref.type}/${ref.id}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push({ ref, feature })
    if (refs.length >= limit * 2) break
  }

  // Enrich each ref through the OSM API.
  const candidates: Candidate[] = []
  for (const { ref, feature } of refs.slice(0, limit * 2)) {
    const props = feature?.properties ?? {}
    let tags: Record<string, string> = {}
    try {
      const response = await fetchWithRetry(
        `${osmApiEndpoint()}/${ref.type}/${ref.id}.json`,
        { headers: { "User-Agent": USER_AGENT } },
        OSM_API_TIMEOUT_MS,
      )
      if (response.ok) {
        const body = (await response.json()) as { elements?: { tags?: Record<string, string> }[] }
        tags = body.elements?.[0]?.tags ?? {}
      }
    } catch {
      // Enrichment is best-effort; fall back to Photon's own fields.
    }

    const name = tags.name || props.name || ""
    if (!name) continue
    const address = osmAddress(tags) || [props.street, props.housenumber, props.postcode, props.city].filter(Boolean).join(", ")
    const phone = tags.phone ?? tags["contact:phone"] ?? tags.mobile ?? tags["contact:mobile"] ?? null
    const website = tags.website ?? tags["contact:website"] ?? null
    const category = tags[props.osm_key] === props.osm_value ? props.osm_value : (tags.craft ?? tags.shop ?? tags.amenity ?? tags.office ?? props.osm_value ?? "")
    candidates.push({
      business: {
        name,
        address,
        phone,
        website,
        rating: null,
        rating_count: null,
        category,
        google_maps: null,
      },
      source: "osm",
    })
    if (candidates.length >= limit * 2) break
  }

  if (!candidates.length) {
    return { candidates: [], error: failures.length ? failures.join("; ") : undefined }
  }
  return { candidates }
}

// ---------------------------------------------------------------------------
// Overpass (fallback)
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

async function overpassSearch(query: string): Promise<{
  elements: OverpassElement[]
  answered: boolean
  error?: string
}> {
  const failures: string[] = []
  let answered = false
  for (const url of overpassEndpoints()) {
    try {
      const response = await fetchWithRetry(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
          body: `data=${encodeURIComponent(query)}`,
        },
        OVERPASS_TIMEOUT_MS,
        2,
      )
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

// ---------------------------------------------------------------------------
// Google Places (optional fallback)
// ---------------------------------------------------------------------------

const DEFAULT_PLACES_ENDPOINT = "https://places.googleapis.com/v1/places:searchText"

function placesEndpoint(): string {
  return (process.env.GOOGLE_PLACES_URL || DEFAULT_PLACES_ENDPOINT).replace(/\/$/, "")
}

async function googleSearch(
  location: string,
  query: string,
  key: string,
  size: number,
): Promise<{ businesses: ScoutedBusiness[]; error?: string }> {
  try {
    const response = await fetchWithRetry(
      placesEndpoint(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": [
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
          ].join(","),
        },
        body: JSON.stringify({ textQuery: `${query} in ${location}`, pageSize: size }),
      },
      GOOGLE_TIMEOUT_MS,
    )
    if (!response.ok) {
      return { businesses: [], error: `Places search failed: HTTP ${response.status}` }
    }
    const body = (await response.json()) as PlacesResponse
    const places = Array.isArray(body.places) ? body.places : []
    return { businesses: places.slice(0, size).map(toPlace) }
  } catch (error) {
    return { businesses: [], error: `Places search failed: ${String(error)}` }
  }
}

function toPlace(place: NonNullable<PlacesResponse["places"]>[number]): ScoutedBusiness {
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

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

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

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let cur = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[b.length]
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(farmacia|studio|dott|dottore|dottoressa|ditta|snc|srl|spa|l|la|il|lo|gli|le|i)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function nameSimilar(a: string, b: string): boolean {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na || !nb) return false
  if (na === nb) return true
  if (na.includes(nb) || nb.includes(na)) return true
  if (Math.abs(na.length - nb.length) <= 4 && levenshtein(na, nb) <= 3) return true
  return false
}

function addressSimilar(a: string, b: string): boolean {
  const na = normalizeText(a)
  const nb = normalizeText(b)
  if (!na || !nb) return false
  if (na === nb) return true
  if (na.includes(nb) || nb.includes(na)) return true
  // Same postcode is a strong signal even when street strings differ.
  const pa = (a.match(/\b\d{5}\b/) ?? [])[0]
  const pb = (b.match(/\b\d{5}\b/) ?? [])[0]
  if (pa && pa === pb) return true
  return false
}

function mergeDedup(candidates: Candidate[]): Merged[] {
  const merged: Merged[] = []
  const byKey = new Map<string, number>()
  for (const candidate of candidates) {
    const keys = dedupKeys(candidate.business)
    let hit = keys.map((key) => byKey.get(key)).find((index) => index !== undefined)
    if (hit === undefined) {
      // Fuzzy fallback: catch renamed/abbreviated duplicates that share no
      // exact phone/website/name+address key (e.g. OSM shell vs Google entry).
      hit = merged.findIndex((entry) => {
        const sameName = nameSimilar(entry.business.name, candidate.business.name)
        if (!sameName) return false
        if (addressSimilar(entry.business.address, candidate.business.address)) return true
        // No address on either side: still merge when names are very close.
        if (!entry.business.address && !candidate.business.address) return true
        return false
      })
      if (hit < 0) hit = undefined
    }
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

// ---------------------------------------------------------------------------
// Tag mapping helpers
// ---------------------------------------------------------------------------

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