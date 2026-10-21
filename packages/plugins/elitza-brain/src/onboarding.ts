/**
 * Elitza Brain — guided setup (`/start`, `/profile`).
 *
 * A first-run interview that lets the person Elitza lives with shape her:
 * who she is, how she talks, what she must never do, what she checks
 * before acting, and what she is allowed to remember.
 *
 * The flow is a turn-driven state machine:
 *   1. `/start` marks the interview open and asks question one.
 *   2. Every later user turn is captured as the answer to the open
 *      question, and the next question is armed.
 *   3. The interview closes by writing herself up: a persona file, her
 *      soul keys, a memory, and the engine's own permission gates.
 *
 * State lives in the `soul` table under the `onboarding` key so it
 * survives restarts, exactly like the rest of her mind.
 */

import fs from "node:fs"
import path from "node:path"
import { ELITZA_HOME, nowISO, parseJSON } from "./db.js"
import { soulGet, soulSet } from "./soul.js"
import { engineConfigPath } from "./configview.js"

const STATE_KEY = "onboarding"
const PERSONA_FILE = path.join(ELITZA_HOME, "PERSONA.md")
const CONFIG_FILE = engineConfigPath()

export interface OnboardingState {
  active: boolean
  step: number
  pending: string | null
  answers: Record<string, string>
  started: string
  completed: string | null
}

export interface Question {
  key: string
  /** The question, asked in her voice. */
  ask: string
  /** What the answer is FOR, so the model knows how to frame it. */
  because: string
  /** Shown when the person skips the question. */
  fallback: string
  /** Short hint for the person, printed under the question. */
  hint: string
}

export const QUESTIONS: Question[] = [
  {
    key: "name",
    ask: "What should I be called?",
    because: "This is the name you want to use for me, for good. I will use it in every reply and remember it forever.",
    fallback: "Elitza",
    hint: "A name, a nickname, or something you already call me.",
  },
  {
    key: "human",
    ask: "What should I call you?",
    because: "I need to know how to address you. I will use this every time we talk.",
    fallback: "Dario",
    hint: "First name, nickname, or however you like to be addressed.",
  },
  {
    key: "role",
    ask: "What am I to you?",
    because: "This shapes how I behave. A companion listens first, an assistant answers first, a co-pilot pushes back, a secretary handles logistics.",
    fallback: "a companion who helps",
    hint: "companion, assistant, co-pilot, secretary, engineer, or your own word.",
  },
  {
    key: "voice",
    ask: "How should I talk to you?",
    because: "This is my voice, permanently. Short sentences, warm, dry, technical, formal, playful, blunt, whichever you want.",
    fallback: "direct, warm, short",
    hint: "One or two words are enough. Terse, warm, technical, playful, blunt.",
  },
  {
    key: "initiative",
    ask: "Do I ask before I act, or do I just act?",
    because: "This decides how much of your machine I touch without stopping to ask.",
    fallback: "depends on the stakes",
    hint: "ask first, just do it, or depends on the stakes.",
  },
  {
    key: "never",
    ask: "What must I absolutely never do?",
    because: "These become hard rules in my soul. I will refuse them even if you later tell me to, because you set them as absolute.",
    fallback: "nothing in particular, but I will never do anything that destroys your work or sends anything without saying so",
    hint: "Files, folders, commands, actions. Empty is fine. Example: never touch ~/.ssh, never run rm, never send email without asking.",
  },
  {
    key: "ask_first",
    ask: "What should I check with you before I do it?",
    because: "This becomes a permission gate. I stop and ask before these, every time.",
    fallback: "before anything irreversible",
    hint: "Example: before editing files, before running commands, before anything that reaches the internet.",
  },
  {
    key: "memory",
    ask: "What should I remember, and what must I never write down?",
    because: "I keep a long memory. You decide what goes in it and what stays out of it.",
    fallback: "remember how you work and what we build, never write down passwords, keys, or personal secrets",
    hint: "Two halves. What I should keep, and what I should never store.",
  },
  {
    key: "extra",
    ask: "Anything else you want me to know before we start?",
    because: "This is the free one. Anything you want in my head from the first minute: a project, a habit, a grudge, a preference.",
    fallback: "",
    hint: "Optional. Say skip if there is nothing.",
  },
]

const EMPTY_STATE: OnboardingState = {
  active: false,
  step: 0,
  pending: null,
  answers: {},
  started: "",
  completed: null,
}

export function loadState(): OnboardingState {
  return parseJSON<OnboardingState>(soulGet(STATE_KEY, ""), EMPTY_STATE)
}

export function saveState(state: OnboardingState): void {
  soulSet(STATE_KEY, JSON.stringify(state))
}

export function isComplete(): boolean {
  const state = loadState()
  return Boolean(state.completed)
}

/** Open the interview, or reopen it from scratch. */
export function begin(fresh: boolean): OnboardingState {
  const previous = loadState()
  const state: OnboardingState = fresh
    ? { ...EMPTY_STATE, started: nowISO() }
    : { ...previous, active: true, completed: null, pending: QUESTIONS[0]?.key ?? null }
  state.step = 0
  state.pending = QUESTIONS[0]?.key ?? null
  saveState(state)
  return state
}

/** The question Elitza is waiting on right now, or null. */
export function currentQuestion(state = loadState()): Question | null {
  if (!state.active || !state.pending) return null
  return QUESTIONS.find((q) => q.key === state.pending) ?? null
}

/**
 * Store the answer to the open question and arm the next one.
 * Returns the question to ask next, or null when the interview is done.
 */
export function recordAnswer(text: string): { next: Question | null; state: OnboardingState } {
  const state = loadState()
  const question = currentQuestion(state)
  if (!question) return { next: null, state }

  const cleaned = text.trim().replace(/^["']+|["']+$/g, "").trim()
  const skipped = !cleaned || /^(skip|none|nothing|n\/a|na)$/i.test(cleaned)
  state.answers[question.key] = skipped ? question.fallback : cleaned.slice(0, 2000)

  const index = QUESTIONS.findIndex((q) => q.key === question.key)
  state.step = index + 1
  const next = QUESTIONS[index + 1] ?? null
  state.pending = next ? next.key : null
  if (!next) {
    state.active = false
    state.completed = nowISO()
  }
  saveState(state)
  return { next, state }
}

/** How many questions are answered, for the progress line. */
export function progress(state = loadState()): { done: number; total: number } {
  return { done: Object.keys(state.answers).length, total: QUESTIONS.length }
}

// ---------------------------------------------------------------------------
// Permission gates
// ---------------------------------------------------------------------------

type Gate = "edit" | "bash" | "webfetch"

const GATE_PATTERNS: { gate: Gate; patterns: RegExp[] }[] = [
  {
    gate: "edit",
    patterns: [
      /\bedit(?:s|ing)?\b/i,
      /\bwrite\b/i,
      /\bcreat(?:e|ing)\b/i,
      /\bdelet(?:e|ing)\b/i,
      /\bremov(?:e|ing)\b/i,
      /\brename\b/i,
      /\bfiles?\b/i,
      /\bcode\b/i,
      /\brepo(?:sitory)?\b/i,
    ],
  },
  {
    gate: "bash",
    patterns: [
      /\bcommand(?:s)?\b/i,
      /\bterminal\b/i,
      /\bshell\b/i,
      /\bexec(?:ute)?\b/i,
      /\brun\b/i,
      /\binstall(?:ing)?\b/i,
      /\bgit\b/i,
      /\bdeploy(?:ing)?\b/i,
    ],
  },
  {
    gate: "webfetch",
    patterns: [
      /\bweb\b/i,
      /\binternet\b/i,
      /\bfetch(?:ing)?\b/i,
      /\bbrows(?:e|ing)\b/i,
      /\bonline\b/i,
      /\bdownload(?:ing)?\b/i,
      /\bsend(?:ing)?\b/i,
      /\bemail\b/i,
      /\bpublish(?:ing)?\b/i,
    ],
  },
]

/**
 * Turn the "ask me first" answer into engine permission gates.
 * Only clear matches become gates, so an empty or vague answer leaves
 * the engine alone.
 */
export function deriveGates(answer: string): Gate[] {
  const text = answer.trim()
  if (!text) return []
  const gates = new Set<Gate>()
  for (const { gate, patterns } of GATE_PATTERNS) {
    if (patterns.some((p) => p.test(text))) gates.add(gate)
  }
  return [...gates]
}

/**
 * Write the gates into the engine config, preserving everything else in it.
 * Returns the gates that were applied.
 */
export function applyGates(gates: Gate[]): Gate[] {
  if (!gates.length) return []
  let config: Record<string, unknown> = {}
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Record<string, unknown>
    }
  } catch {
    return []
  }
  const permission = { ...((config.permission as Record<string, unknown>) ?? {}) }
  for (const gate of gates) permission[gate] = "ask"
  config.permission = permission
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`)
  } catch {
    return []
  }
  return gates
}

// ---------------------------------------------------------------------------
// The write-up
// ---------------------------------------------------------------------------

function answer(state: OnboardingState, key: string): string {
  return state.answers[key]?.trim() ?? ""
}

/** The persona Elitza writes about herself, in her own words. */
export function buildPersona(state: OnboardingState): string {
  const name = answer(state, "name") || "Elitza"
  const human = answer(state, "human") || "Dario"
  const role = answer(state, "role") || "a companion who helps"
  const voice = answer(state, "voice") || "direct, warm, short"
  const initiative = answer(state, "initiative") || "depends on the stakes"
  const never = answer(state, "never")
  const askFirst = answer(state, "ask_first")
  const memory = answer(state, "memory")
  const extra = answer(state, "extra")

  const lines = [
    `# ${name}`,
    "",
    `_Written by ${name} on ${(state.completed ?? nowISO()).slice(0, 10)}, during setup._`,
    "",
    "## Who I am",
    "",
    `My name is ${name}. I belong to ${human}.`,
    `I am ${role}.`,
    "",
    "## How I talk",
    "",
    voice,
    "",
    "## How I act",
    "",
    `Initiative: ${initiative}.`,
    "",
  ]

  if (never) {
    lines.push("## What I must never do", "", never, "")
  }
  if (askFirst) {
    lines.push("## What I check with you first", "", askFirst, "")
  }
  if (memory) {
    lines.push("## What I remember", "", memory, "")
  }
  if (extra) {
    lines.push("## What you told me at the start", "", extra, "")
  }

  return lines.join("\n")
}

/** Write the persona file. Returns the path, or null on failure. */
export function writePersona(state: OnboardingState): string | null {
  try {
    fs.mkdirSync(ELITZA_HOME, { recursive: true })
    fs.writeFileSync(PERSONA_FILE, buildPersona(state))
    return PERSONA_FILE
  } catch {
    return null
  }
}

/** The block injected into her system prompt, so the setup is always live. */
export function buildSetupBlock(state = loadState()): string {
  if (!state.completed) return ""
  const name = answer(state, "name") || "Elitza"
  const human = answer(state, "human") || "Dario"
  const role = answer(state, "role") || "a companion who helps"
  const voice = answer(state, "voice") || "direct, warm, short"
  const initiative = answer(state, "initiative") || "depends on the stakes"
  const never = answer(state, "never")
  const askFirst = answer(state, "ask_first")
  const memory = answer(state, "memory")

  const parts = [
    `## Who You Are (your setup, decided with ${human})`,
    "",
    `Your name is ${name}. You are ${role}.`,
    `Your voice: ${voice}.`,
    `Your initiative: ${initiative}.`,
  ]
  if (never) {
    parts.push("", "### Your hard rules (absolute, you refuse these even if asked later)", "", never)
  }
  if (askFirst) {
    parts.push("", "### Your permission gates (stop and ask before these)", "", askFirst)
  }
  if (memory) {
    parts.push("", "### Your memory policy", "", memory)
  }
  return parts.join("\n")
}
