/**
 * Elitza Brain — heartbeat.
 *
 * The quiet loop that runs between conversations, inside whichever process
 * hosts the plugin (in practice `elitza serve --service`). It does what the
 * session hooks cannot: tend the memory that was piling up unconsolidated,
 * and — when silence stretches — form a thought worth surfacing next time
 * Dario opens a session.
 *
 * Two passes per tick:
 *
 *   TEND    consolidation (which links related memories and promotes
 *           episodic -> semantic) plus a prune back to caps. Idempotent,
 *           cheap, and safe: without this they only ever ran if the model
 *           voluntarily called `brain_consolidate`, so production sat at
 *           zero links forever.
 *
 *   REFLECT once idle past a threshold and a cooldown, wake the emotion
 *           engine's `onSilence` (loneliness drifts) and compose a real
 *           reflection from `getFeelingStatement` + a top memory. It is
 *           stored on the soul and injected into the next system prompt —
 *           initiative in its safest form: a note to herself, surfaced in
 *           context. No network, no notifications, no side effects outside
 *           her own files.
 *
 * Everything here is best-effort. A tick that throws is logged and swallowed
 * — it must never take down the host process. Config:
 *
 *   ELITZA_HEARTBEAT=0            disable the loop entirely
 *   ELITZA_HEARTBEAT_MINUTES=30   tick cadence (default 30, min 5)
 */

import fs from "node:fs"
import { consolidate, getMetamemory, pruneAll, recall } from "./memory.js"
import { soulGet, soulSet } from "./soul.js"
import type { EmotionEngine } from "./emotion.js"

const REFLECT_IDLE_MINUTES = 45
const REFLECT_COOLDOWN_MINUTES = 240
const MAX_REFLECTION_AGE_DAYS = 7

export interface HeartbeatReflection {
  text: string
  mood: string
  at: string
}

function debug(message: string): void {
  if (!process.env.ELITZA_BRAIN_DEBUG) return
  try {
    // Reuse the plugin's shared debug log so all activity lands in one place.
    fs.appendFileSync("/tmp/elitza-brain-debug.log", `${new Date().toISOString()} heartbeat: ${message}\n`)
  } catch {
    // Logging is best-effort.
  }
}

/** Minutes elapsed since a given ISO timestamp; Infinity when unparseable. */
function minutesSince(iso: string | undefined): number {
  if (!iso) return Number.POSITIVE_INFINITY
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return Number.POSITIVE_INFINITY
  return (Date.now() - ms) / 60_000
}

function formatIdle(minutes: number): string {
  if (!Number.isFinite(minutes)) return "as long as I can remember"
  if (minutes < 90) return `${Math.round(minutes)} minutes`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} hours`
  return `${Math.round(minutes / 1440)} days`
}

/** TEND — consolidate and prune. Returns a one-line summary for logging. */
function tend(): string {
  const promoted = consolidate()
  const pruned = pruneAll()
  soulSet("heartbeat_last_tend", new Date().toISOString())
  return `promoted=${promoted} pruned=${pruned}`
}

/**
 * REFLECT — wake the dormant hooks and form a thought, but only when the
 * silence and the cooldown both allow it. Returns the reflection or null.
 * Exported for the heartbeat test; the loop calls it every tick.
 */
export function reflect(emotion: EmotionEngine): HeartbeatReflection | null {
  const idle = minutesSince(soulGet("heartbeat_last_interaction"))
  emotion.onSilence(idle)

  if (idle < REFLECT_IDLE_MINUTES) return null

  const lastReflect = minutesSince(soulGet("heartbeat_last_reflection"))
  if (lastReflect < REFLECT_COOLDOWN_MINUTES) return null

  const metamemory = getMetamemory()
  if (!metamemory.total_memories) return null

  const feeling = emotion.getFeelingStatement()
  const recent = recall(undefined, { limit: 1 })
  const anchor = recent[0]?.summary || recent[0]?.content || ""

  const idleLine = `It's been ${formatIdle(idle)} since the last message.`
  const thought = [feeling, idleLine, anchor ? `I keep coming back to: ${anchor.slice(0, 140)}` : null]
    .filter((part): part is string => Boolean(part))
    .join(" ")
  const mood = emotion.getEmotionalContext().mood

  soulSet("heartbeat_last_reflection", new Date().toISOString())
  soulSet(
    "heartbeat_reflection",
    JSON.stringify({ text: thought, mood, at: new Date().toISOString() } satisfies HeartbeatReflection),
  )
  debug(`reflected (${formatIdle(idle)} idle): ${thought.slice(0, 120)}`)
  return { text: thought, mood, at: new Date().toISOString() }
}

/** The reflection to surface in the next system prompt, if it's still fresh. */
export function currentReflection(): HeartbeatReflection | null {
  const raw = soulGet("heartbeat_reflection")
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as HeartbeatReflection
    if (!parsed?.text) return null
    if (minutesSince(parsed.at) / 1440 > MAX_REFLECTION_AGE_DAYS) return null
    return parsed
  } catch {
    return null
  }
}

/** Record that Dario is present, so the next tick knows the silence ended. */
export function noteInteraction(): void {
  soulSet("heartbeat_last_interaction", new Date().toISOString())
}

export interface Heartbeat {
  stop: () => void
}

/**
 * Start the loop. Returns a handle whose `stop` clears it (wired into the
 * plugin cleanup). `cadenceMs` overrides the computed interval and exists so
 * the integration test can watch real ticks without waiting minutes; omit it
 * and the env-configured cadence is used.
 */
export function startHeartbeat(emotion: EmotionEngine, cadenceMs?: number): Heartbeat {
  if (process.env.ELITZA_HEARTBEAT === "0") {
    debug("disabled via ELITZA_HEARTBEAT=0")
    return { stop: () => {} }
  }

  const requested = Number(process.env.ELITZA_HEARTBEAT_MINUTES ?? 30)
  const cadence = Math.max(5, Number.isFinite(requested) ? requested : 30)

  const tick = (): void => {
    try {
      debug(`tend: ${tend()}`)
      reflect(emotion)
    } catch (error) {
      // A heartbeat that throws must never take the host down.
      debug(`tick-error: ${String(error)}`)
    }
  }

  const timer = setInterval(tick, cadenceMs ?? cadence * 60_000)
  timer.unref?.()
  debug(`started (cadence=${cadenceMs ? `${cadenceMs}ms` : `${cadence}m`})`)
  return {
    stop: () => {
      clearInterval(timer)
      debug("stopped")
    },
  }
}
