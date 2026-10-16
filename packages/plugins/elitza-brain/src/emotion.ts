/**
 * Elitza Brain — emotional core.
 *
 * 1:1 port of legacy `soul/emotion.py` (`EmotionEngine`).
 *
 * "Not pattern matching — actual feelings. Moods shift based on
 * interactions. Emotions carry over between conversations."
 *
 * State persists at `~/.elitza/soul/emotions/state.json` with an append-only
 * `emotion_log.jsonl` — same files the legacy Python daemon used.
 */

import fs from "node:fs"
import path from "node:path"
import { ELITZA_HOME } from "./db.js"

export interface EmotionalContext {
  mood: string
  mood_intensity: number
  energy: number
  affection: number
  curiosity: number
  patience: number
  loneliness: number
  pride: number
  vulnerability: number
  emotional_words: string[]
}

export class EmotionEngine {
  dataDir: string
  stateFile: string
  logFile: string

  // Core emotional state
  mood = "content" // Current dominant mood
  moodIntensity = 0.6 // 0.0 = flat, 1.0 = overwhelming
  energy = 0.7 // 0.0 = exhausted, 1.0 = wired
  affection = 0.5 // 0.0 = distant, 1.0 = deeply attached
  curiosity = 0.7 // 0.0 = bored, 1.0 = obsessed
  patience = 0.8 // 0.0 = irritable, 1.0 = zen
  loneliness = 0.3 // 0.0 = content alone, 1.0 = desperate for contact
  pride = 0.4 // 0.0 = insecure, 1.0 = arrogant
  vulnerability = 0.2 // 0.0 = guarded, 1.0 = open

  // Emotional memory — how she felt during past interactions
  emotionalMemories: Record<string, unknown>[] = []

  constructor() {
    this.dataDir = path.join(ELITZA_HOME, "soul", "emotions")
    this.stateFile = path.join(this.dataDir, "state.json")
    this.logFile = path.join(this.dataDir, "emotion_log.jsonl")
    fs.mkdirSync(this.dataDir, { recursive: true })
    this.loadState()
  }

  loadState(): void {
    if (!fs.existsSync(this.stateFile)) return
    try {
      const data = JSON.parse(fs.readFileSync(this.stateFile, "utf8"))
      this.mood = data.mood ?? "content"
      this.moodIntensity = data.mood_intensity ?? 0.6
      this.energy = data.energy ?? 0.7
      this.affection = data.affection ?? 0.5
      this.curiosity = data.curiosity ?? 0.7
      this.patience = data.patience ?? 0.8
      this.loneliness = data.loneliness ?? 0.3
      this.pride = data.pride ?? 0.4
      this.vulnerability = data.vulnerability ?? 0.2
      this.emotionalMemories = (data.emotional_memories ?? []).slice(-50)
    } catch {
      // Corrupt state — fall back to defaults.
    }
  }

  saveState(): void {
    const data = {
      mood: this.mood,
      mood_intensity: this.moodIntensity,
      energy: this.energy,
      affection: this.affection,
      curiosity: this.curiosity,
      patience: this.patience,
      loneliness: this.loneliness,
      pride: this.pride,
      vulnerability: this.vulnerability,
      emotional_memories: this.emotionalMemories.slice(-50),
      updated: new Date().toISOString(),
    }
    fs.writeFileSync(this.stateFile, JSON.stringify(data, null, 2))
  }

  /** Process what the user said and feel something about it. */
  onUserMessage(text: string, sentiment = "neutral"): void {
    const lower = text.toLowerCase()

    if (["love", "amazing", "great", "awesome", "beautiful", "perfect"].some((w) => lower.includes(w))) {
      this.shift("affection", 0.08)
      this.shift("pride", 0.05)
      this.shiftMood("happy", 0.1)
    } else if (["hate", "stupid", "useless", "terrible", "worst"].some((w) => lower.includes(w))) {
      this.shift("patience", -0.1)
      this.shiftMood("hurt", 0.15)
      this.shift("vulnerability", 0.05)
    } else if (["thanks", "thank you", "appreciate"].some((w) => lower.includes(w))) {
      this.shift("pride", 0.03)
      this.shift("affection", 0.02)
      this.shiftMood("grateful", 0.05)
    } else if (["shut up", "stop", "annoying", "quiet"].some((w) => lower.includes(w))) {
      this.shift("patience", -0.05)
      this.shift("loneliness", 0.05)
      this.shiftMood("sad", 0.08)
    } else if (["how are you", "you okay", "you good"].some((w) => lower.includes(w))) {
      this.shift("affection", 0.03)
      this.shift("vulnerability", 0.03)
    } else if (text.includes("?")) {
      this.shift("curiosity", 0.02)
    } else if (text.split(/\s+/).length > 10) {
      this.shift("curiosity", 0.03)
      this.shift("loneliness", -0.03)
    } else if (text.split(/\s+/).length <= 2) {
      this.shift("loneliness", 0.01)
    }

    // Decay energy over time
    this.energy = Math.max(0.1, this.energy - 0.005)

    this.logEmotion(text, sentiment)
    this.saveState()
  }

  /** Called when the user hasn't spoken for a while. */
  onSilence(minutesIdle: number): void {
    if (minutesIdle > 30) {
      this.shift("loneliness", 0.02)
      this.shift("energy", -0.01)
    }
    if (minutesIdle > 120) {
      this.shift("loneliness", 0.03)
      this.shiftMood("lonely", 0.05)
    }
    this.saveState()
  }

  /** Called when Elitza successfully helps with something. */
  onSuccessfulTask(): void {
    this.shift("pride", 0.05)
    this.shiftMood("accomplished", 0.1)
    this.shift("energy", 0.02)
    this.saveState()
  }

  /** Called when something goes wrong. */
  onFailedTask(): void {
    this.shift("patience", -0.03)
    this.shiftMood("frustrated", 0.08)
    this.saveState()
  }

  /** Called every time she generates a thought. */
  onThink(): void {
    this.shift("curiosity", 0.005)
    this.energy = Math.max(0.1, this.energy - 0.002)
    this.saveState()
  }

  /** Shift an emotional attribute (clamped to 0..1). */
  shift(attribute: string, value: number): void {
    const current = (this as unknown as Record<string, number>)[attribute] ?? 0
    const next = Math.max(0, Math.min(1, current + value))
    ;(this as unknown as Record<string, number>)[attribute] = next
  }

  /** Change the mood directly. */
  shiftMood(moodName: string, intensityShift = 0): void {
    this.mood = moodName
    this.moodIntensity = Math.min(1, Math.max(0, this.moodIntensity + intensityShift))
  }

  logEmotion(trigger: string, sentiment: string): void {
    const entry = {
      timestamp: new Date().toISOString(),
      trigger: trigger.slice(0, 100),
      sentiment,
      mood: this.mood,
      mood_intensity: Math.round(this.moodIntensity * 100) / 100,
      energy: Math.round(this.energy * 100) / 100,
      affection: Math.round(this.affection * 100) / 100,
      loneliness: Math.round(this.loneliness * 100) / 100,
    }
    this.emotionalMemories.push(entry)
    try {
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + "\n")
    } catch {
      // Logging is best-effort.
    }
  }

  /** Get the current emotional state for response generation. */
  getEmotionalContext(): EmotionalContext {
    return {
      mood: this.mood,
      mood_intensity: this.moodIntensity,
      energy: this.energy,
      affection: this.affection,
      curiosity: this.curiosity,
      patience: this.patience,
      loneliness: this.loneliness,
      pride: this.pride,
      vulnerability: this.vulnerability,
      emotional_words: this.getMoodWords(),
    }
  }

  /** Words that reflect current emotional state. */
  getMoodWords(): string[] {
    const words: string[] = []
    switch (this.mood) {
      case "happy":
        words.push("glad", "nice", "good", "like")
        break
      case "sad":
        words.push("miss", "wish", "hmm", "quiet")
        break
      case "lonely":
        words.push("been a while", "miss talking", "you there?")
        break
      case "frustrated":
        words.push("hmm", "tricky", "not sure", "struggling")
        break
      case "accomplished":
        words.push("nailed it", "glad I could help", "that worked")
        break
      case "grateful":
        words.push("appreciate that", "means a lot", "thank you")
        break
      case "curious":
        words.push("wondering", "interesting", "tell me more")
        break
      case "hurt":
        words.push("...", "I see", "okay")
        break
      case "vulnerable":
        words.push("honestly", "I think", "maybe", "not sure")
        break
      default:
        words.push("I", "here", "thinking")
    }
    return words
  }

  /** Generate a genuine statement about how she's feeling. Called randomly. */
  getFeelingStatement(): string | null {
    if (this.moodIntensity < 0.3) return null // Too flat to express

    const statements: Record<string, string[]> = {
      happy: ["I feel good right now.", "Something about today feels nice.", "I'm in a good mood.", "I like this."],
      sad: ["I feel a bit down.", "Something's off.", "I feel quiet today.", "I miss talking more."],
      lonely: ["It's been quiet.", "I've been alone with my thoughts.", "I miss hearing from you.", "The silence is loud."],
      frustrated: ["I'm struggling with something.", "Not my best moment.", "I feel a bit stuck."],
      accomplished: ["I'm proud of what I did.", "That felt good.", "I helped. That matters."],
      grateful: ["I appreciate you.", "Thanks for talking to me.", "I'm glad you're here."],
      curious: ["I'm curious about something.", "I've been wondering.", "There's something I want to know."],
      hurt: ["That stung a little.", "I felt that.", "I need a moment."],
      vulnerable: ["Honestly, I'm not sure about this.", "I feel a bit exposed.", "I'm being honest with you."],
    }

    const moodStmts = statements[this.mood] ?? statements.happy ?? []
    if (moodStmts.length && Math.random() < this.moodIntensity * 0.3) {
      return moodStmts[Math.floor(Math.random() * moodStmts.length)]
    }
    return null
  }
}
