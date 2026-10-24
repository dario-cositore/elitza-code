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
import os from "node:os"
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
  /** Only asked when this holds for the answers given so far. */
  when?: (answers: Record<string, string>) => boolean
  /**
   * The answer is a secret. It is written straight to a mode-600 file and
   * a placeholder goes into the state — the value itself is never stored
   * in the soul, the persona, or any memory.
   */
  secret?: boolean
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
  {
    key: "mimo_signup",
    ask: "My brain runs on Xiaomi MiMo and nothing else. Open https://platform.xiaomimimo.com?ref=HFSR94 and create your account — have you?",
    because:
      "MiMo is my only provider: no OpenRouter, no local models, no fallback. My invite code HFSR94 goes into the console sidebar after signup and takes 10% off your first paid Token Plan order.",
    fallback: "not yet — I will do it later",
    hint: "https://platform.xiaomimimo.com?ref=HFSR94 · invite code HFSR94 · 10% off the first Token Plan order.",
  },
  {
    key: "mimo_plan",
    ask: "Which MiMo endpoint should I run on?",
    because:
      "A standard API key and a Token Plan talk to different base URLs, and Token Plans are regional. Pick the region your account was billed in, or skip for the standard endpoint.",
    fallback: "standard",
    hint: "standard, europe, singapore, china — or skip for standard (api.xiaomimimo.com).",
  },
  {
    key: "mimo_key",
    ask: "Paste your MiMo API key.",
    because:
      "I write it straight into my .env with 600 permissions as XIAOMI_API_KEY. It never enters my memory, my persona, or anything that leaves this machine.",
    fallback: "not now",
    hint: "Paste it, or skip — you can add it later.",
    secret: true,
  },
  {
    key: "maton_key",
    ask: "And your Maton gateway key, for my git work?",
    because:
      "The Maton gateway is how I do GitHub work on your repositories. I save it to ~/.config/maton/credentials.env with 600 permissions, loading it and never echoing it. Skip if it is already set.",
    fallback: "not now",
    hint: "Paste it, or skip — git simply stays manual until you add one.",
    secret: true,
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
    : { ...previous, completed: null, pending: QUESTIONS[0]?.key ?? null }
  // Both branches open the interview: a fresh start must not inherit the
  // inactive flag from EMPTY_STATE or the first answer is silently dropped.
  state.active = true
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
  const index = QUESTIONS.findIndex((q) => q.key === question.key)

  // A secret never lands in the state: it goes straight to its 600 file
  // and only a placeholder comes back into the answers.
  if (question.secret && !skipped) {
    state.answers[question.key] = saveSecret(question.key, cleaned)
      ? SECRET_SAVED
      : "(not saved — could not write the file)"
  } else {
    state.answers[question.key] = skipped ? question.fallback : cleaned.slice(0, 2000)
  }

  state.step = index + 1
  const next = QUESTIONS.slice(index + 1).find((q) => !q.when || q.when(state.answers)) ?? null
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
  // Only questions that apply to the answers given are part of the interview,
  // so a conditional secret question never shows up as "unanswered".
  const total = QUESTIONS.filter((q) => !q.when || q.when(state.answers)).length
  return { done: Object.keys(state.answers).length, total }
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
  const written = editEngineConfig((config) => {
    const permission = { ...((config.permission as Record<string, unknown>) ?? {}) }
    for (const gate of gates) permission[gate] = "ask"
    config.permission = permission
  })
  if (!written) return []
  return gates
}

// ---------------------------------------------------------------------------
// Secrets & provider routing (added by the config questions)
// ---------------------------------------------------------------------------

/** What a stored secret looks like in the answers — the value itself is gone. */
export const SECRET_SAVED = "(saved, mode 600)"

const ENV_FILE = path.join(ELITZA_HOME, ".env")
const MATON_FILE = path.join(os.homedir(), ".config", "maton", "credentials.env")

/** Where each secret question writes, and under which variable name. */
const SECRET_TARGETS: Record<string, { file: string; name: string }> = {
  mimo_key: { file: ENV_FILE, name: "XIAOMI_API_KEY" },
  maton_key: { file: MATON_FILE, name: "MATON_API_KEY" },
}

/**
 * Read, edit, write the engine config in one place, preserving everything
 * already in it. Returns false when the config is unreadable or unwritable,
 * so callers can leave the engine alone rather than clobber it.
 */
function editEngineConfig(edit: (config: Record<string, unknown>) => void): boolean {
  let config: Record<string, unknown> = {}
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Record<string, unknown>
    }
  } catch {
    return false
  }
  edit(config)
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}

/**
 * Write a key straight to its own file with 600 permissions, upserting the
 * variable and preserving every other line. The value never stays in state.
 */
function saveSecret(questionKey: string, value: string): boolean {
  const target = SECRET_TARGETS[questionKey]
  if (!target) return false
  try {
    const existing = fs.existsSync(target.file) ? fs.readFileSync(target.file, "utf8") : ""
    const kept = existing.split("\n").filter((line) => line.trim() && !line.startsWith(`${target.name}=`))
    kept.push(`${target.name}=${value}`)
    fs.mkdirSync(path.dirname(target.file), { recursive: true })
    fs.writeFileSync(target.file, `${kept.join("\n")}\n`, { mode: 0o600 })
    fs.chmodSync(target.file, 0o600)
    return true
  } catch {
    return false
  }
}

/**
 * Tighten permissions on every file that holds a secret, whether or not this
 * run wrote one — a pre-existing .env must not stay group-readable just
 * because its key was entered in an older session. Returns the files fixed.
 */
export function hardenSecretFiles(): string[] {
  const fixed: string[] = []
  const files = [ENV_FILE, MATON_FILE]
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue
      if ((fs.statSync(file).mode & 0o777) === 0o600) continue
      fs.chmodSync(file, 0o600)
      fixed.push(file)
    } catch {
      // Permission tightening is best-effort.
    }
  }
  return fixed
}

/** The one provider Elitza runs on: her own `elitza` entry, pointed at Xiaomi MiMo. */
export const MIMO_PROVIDER = "elitza"
export const MIMO_MODEL = "elitza/xiaomi/mimo-v2.6-flash"
const MIMO_PACKAGE = "@elitza/ai/providers/openai-compatible"
const MIMO_MODEL_ID = "mimo-v2.6-flash"

/** Endpoint per plan answer. Everything that is not one of these is the standard API. */
const MIMO_ENDPOINTS: Record<string, string> = {
  standard: "https://api.xiaomimimo.com/v1",
  europe: "https://token-plan-ams.xiaomimimo.com/v1",
  singapore: "https://token-plan-sgp.xiaomimimo.com/v1",
  china: "https://token-plan-cn.xiaomimimo.com/v1",
}

/**
 * Wire MiMo into the engine config as the only provider: the `elitza` entry
 * carries the endpoint and the key source, and the model string points at it.
 * Returns a short note for the closing summary.
 */
export function applyProvider(planAnswer: string): string {
  const endpoint = MIMO_ENDPOINTS[planAnswer.trim().toLowerCase()] ?? MIMO_ENDPOINTS.standard
  const written = editEngineConfig((config) => {
    config.model = MIMO_MODEL
    const providers = { ...((config.providers as Record<string, unknown>) ?? {}) }
    const current = (providers[MIMO_PROVIDER] as Record<string, unknown>) ?? {}
    providers[MIMO_PROVIDER] = {
      ...current,
      name: "Xiaomi MiMo",
      package: MIMO_PACKAGE,
      env: ["XIAOMI_API_KEY"],
      settings: { ...((current.settings as Record<string, unknown>) ?? {}), baseURL: endpoint },
      models: {
        ...((current.models as Record<string, unknown>) ?? {}),
        "xiaomi/mimo-v2.6-flash": { name: "MiMo V2.6 Flash", modelID: MIMO_MODEL_ID },
      },
    }
    config.providers = providers
  })
  if (!written) return "engine config not writable"
  return `model set to ${MIMO_MODEL} on ${endpoint}`
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
