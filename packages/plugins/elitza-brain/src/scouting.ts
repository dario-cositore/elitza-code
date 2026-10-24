/**
 * Elitza Brain — local client scouting (Task B).
 *
 * One Places API Text Search per call: a location plus a query in, the
 * business fields an AI Enabler needs out — name, address, phone, website,
 * rating, review count, category, Google Maps link.
 *
 * Key policy: the operator's own GOOGLE_MAPS_API_KEY, read from the
 * environment (the launcher loads ~/.elitza/.env). Nothing is embedded in
 * the repo, and the soul only ever learns whether the key exists.
 *
 * Endpoint policy: the official Google endpoint by default, overridable
 * with GOOGLE_PLACES_URL — the same pattern GAPFEED_LOCAL_URL uses, so
 * tests run against a local server instead of the live API.
 *
 * This module only searches. It never drafts, never sends, never writes a
 * client anywhere — those are the CRM and pipeline's jobs.
 *
 * Config (env):
 *   GOOGLE_MAPS_API_KEY   required; the operator's own Places API key
 *   GOOGLE_PLACES_URL     default https://places.googleapis.com/v1/places:searchText
 */

const DEFAULT_ENDPOINT = "https://places.googleapis.com/v1/places:searchText"
const FETCH_TIMEOUT_MS = 8_000
const MAX_LIMIT = 20

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
  error?: string
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

function endpoint(): string {
  return (process.env.GOOGLE_PLACES_URL || DEFAULT_ENDPOINT).replace(/\/$/, "")
}

/** True when the operator's own key is in the environment. The value never leaves it. */
export function scoutKeyPresent(): boolean {
  return Boolean(process.env.GOOGLE_MAPS_API_KEY?.trim())
}

/**
 * Search local businesses. A missing key, a refused request, or a dead
 * endpoint comes back as `error` rather than a throw, so the tool can tell
 * the operator what to fix instead of dumping a stack trace.
 */
export async function scoutBusinesses(
  location: string,
  query: string,
  limit = 10,
): Promise<ScoutResult> {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim()
  if (!key) {
    return {
      businesses: [],
      error:
        "GOOGLE_MAPS_API_KEY is not set. Add your own Google Places API key to ~/.elitza/.env as GOOGLE_MAPS_API_KEY=... (the file is mode 600), then restart Elitza.",
    }
  }

  const size = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
  try {
    const response = await fetch(endpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({ textQuery: `${query} in ${location}`, pageSize: size }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
