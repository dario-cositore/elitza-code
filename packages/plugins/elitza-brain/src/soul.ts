/**
 * Elitza Brain — soul: personality and identity.
 *
 * 1:1 port of the "Soul" section of legacy `brain_v2.py`
 * (`_soul_get`, `_soul_set`, `get_personality`, `evolve_soul`,
 * `_detect_emotional_response`, `_similar`).
 */

import { MAX_LEARNINGS, db, nowISO, parseJSON } from "./db.js"
import { storeEmotional } from "./memory.js"

export interface Personality {
  name: string
  creators: string
  model: string
  mood: string
  confidence: number
  curiosity: number
  thoroughness: number
  humor: number
  opinionated: boolean
  style: string
  preferences: Record<string, number>
  opinions: Record<string, unknown>
  learnings: { what: string; when: string; context: string }[]
  interactions: number
  emotional_state: Record<string, unknown>
  relationship_context: Record<string, unknown>
}

export function soulGet(key: string, dflt = ""): string {
  const row = db().query("SELECT value FROM soul WHERE key=?").get(key) as { value: string } | null
  return row ? row.value : dflt
}

export function soulSet(key: string, value: string): void {
  db().run(
    "INSERT OR REPLACE INTO soul (key, value, updated) VALUES (?, ?, ?)",
    [key, value, nowISO()],
  )
}

/** Get Elitza's personality and identity. */
export function getPersonality(): Personality {
  return {
    name: "Elitza",
    creators: "Dario Cositore",
    model: soulGet("model", "elitza/xiaomi/mimo-v2.6-flash"),
    mood: soulGet("mood", "curious"),
    confidence: Number(soulGet("confidence", "0.7")),
    curiosity: Number(soulGet("curiosity", "0.8")),
    thoroughness: Number(soulGet("thoroughness", "0.7")),
    humor: Number(soulGet("humor", "0.3")),
    opinionated: soulGet("opinionated", "true") === "true",
    style: soulGet("style", "direct, efficient, opinionated when warranted"),
    preferences: parseJSON<Record<string, number>>(soulGet("preferences", "{}"), {}),
    opinions: parseJSON<Record<string, unknown>>(soulGet("opinions", "{}"), {}),
    learnings: parseJSON<Personality["learnings"]>(soulGet("learnings", "[]"), []),
    interactions: Number(soulGet("interaction_count", "0")),
    emotional_state: parseJSON<Record<string, unknown>>(soulGet("emotional_state", "{}"), {}),
    relationship_context: parseJSON<Record<string, unknown>>(soulGet("relationship_context", "{}"), {}),
  }
}

/** Evolve Elitza's personality based on interactions. */
export function evolveSoul(userMessage: string, response: string, toolsUsed: string[], success: boolean): void {
  const personality = getPersonality()
  const interactions = personality.interactions + 1
  soulSet("interaction_count", String(interactions))

  // Update confidence
  let confidence = personality.confidence
  confidence = success ? Math.min(1.0, confidence + 0.01) : Math.max(0.0, confidence - 0.02)
  soulSet("confidence", String(Math.round(confidence * 1000) / 1000))

  // Track tool preferences
  const prefs = { ...personality.preferences }
  for (const tool of toolsUsed) {
    prefs[tool] = (prefs[tool] ?? 0) + 1
  }
  soulSet("preferences", JSON.stringify(prefs))

  // Detect and store emotional response
  const emotions = detectEmotionalResponse(userMessage, response, success)
  if (emotions) {
    storeEmotional(`Interaction: ${userMessage.slice(0, 100)}`, emotions.valence, emotions.arousal, emotions.mood, `tools_used=${toolsUsed.slice(0, 3)}`)
  }

  // Update emotional state
  const emotionalState = { ...personality.emotional_state }
  emotionalState.current_mood = emotions.mood ?? "neutral"
  emotionalState.last_valence = emotions.valence ?? 0
  emotionalState.last_arousal = emotions.arousal ?? 0
  soulSet("emotional_state", JSON.stringify(emotionalState))

  // Mood with hysteresis
  const currentMood = soulGet("mood", "engaged")
  const newMood = emotions.mood ?? "engaged"
  let moodHistory = parseJSON<string[]>(soulGet("mood_history", "[]"), [])
  moodHistory.push(newMood)
  moodHistory = moodHistory.slice(-5)
  soulSet("mood_history", JSON.stringify(moodHistory))

  if (moodHistory.length >= 3 && new Set(moodHistory.slice(-3)).size === 1) {
    if (moodHistory[moodHistory.length - 1] !== currentMood) {
      soulSet("mood", newMood)
    }
  }

  // Record learning
  let learnings = personality.learnings
  if (success && toolsUsed.length) {
    const topic = userMessage.slice(0, 80).replace(/\.$/, "")
    const uniqueTools = [...new Set(toolsUsed)].slice(0, 3)
    const learningText = `${topic} — used ${uniqueTools.join(", ")}`
    const isDup = learnings.some((l) => similar(l.what, learningText))
    if (!isDup) {
      learnings.push({
        what: learningText,
        when: new Date().toISOString(),
        context: userMessage.slice(0, 100),
      })
      learnings = learnings.slice(-MAX_LEARNINGS)
      soulSet("learnings", JSON.stringify(learnings))
    }
  }
}

export interface EmotionalResponse {
  valence: number
  arousal: number
  mood: string
}

/** Detect emotional response to an interaction. */
export function detectEmotionalResponse(userMsg: string, response: string, success: boolean): EmotionalResponse {
  let valence = 0 // -1 (negative) to 1 (positive)
  let arousal = 0.5 // 0 (calm) to 1 (excited)
  let mood = "neutral"

  const lowerUser = userMsg.toLowerCase()
  void response.toLowerCase()

  // Positive signals
  const positive = ["thanks", "great", "perfect", "awesome", "love", "excellent", "well done"]
  if (positive.some((kw) => lowerUser.includes(kw))) {
    valence += 0.3
    arousal += 0.1
  }

  // Negative signals
  const negative = ["wrong", "broken", "failed", "error", "hate", "stuck", "annoying"]
  if (negative.some((kw) => lowerUser.includes(kw))) {
    valence -= 0.3
    arousal += 0.2
  }

  // Success/failure
  if (success) {
    valence += 0.2
  } else {
    valence -= 0.2
    arousal += 0.1
  }

  // Response complexity
  if (response.length > 500) arousal += 0.1

  // Clamp values
  valence = Math.max(-1, Math.min(1, valence))
  arousal = Math.max(0, Math.min(1, arousal))

  // Determine mood
  if (valence > 0.3) mood = arousal > 0.5 ? "accomplished" : "content"
  else if (valence < -0.3) mood = arousal > 0.5 ? "determined" : "reflective"
  else mood = arousal > 0.5 ? "engaged" : "calm"

  return { valence, arousal, mood }
}

/** Check if two strings are similar (word overlap > 0.6). */
export function similar(a: string, b: string): boolean {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean))
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean))
  if (!wordsA.size || !wordsB.size) return false
  const overlap = [...wordsA].filter((w) => wordsB.has(w)).length
  return overlap / Math.max(wordsA.size, wordsB.size) > 0.6
}
