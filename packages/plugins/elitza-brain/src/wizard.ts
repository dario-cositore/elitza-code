/**
 * Elitza Brain — the visual first-run wizard (TUI side).
 *
 * A deterministic, model-free walk through the whole setup: welcome and
 * MiMo affiliate, endpoint, API key (with a live verification ping), then
 * the persona and permission questions — one dialog per step, no chat, no
 * model calls, no keys needed to finish.
 *
 * Secrets never enter the progress state or the hand-off file: they go
 * straight to their mode-600 files through the same path the interview
 * uses. The finished answers are written to `WIZARD_FILE`, and the engine
 * adopts them into the soul on the next prompt or boot — the only process
 * that ever writes her mind.
 */

import fs from "node:fs"
import path from "node:path"
import type { Dialog, Toast } from "@elitza/plugin/tui/context"
import {
  QUESTIONS,
  SECRET_SAVED,
  WIZARD_FILE,
  isRegionPlan,
  mimoEndpoint,
  mimoKeyFamily,
  saveSecretValue,
} from "./onboarding.js"

export interface WizardProgress {
  /** Index of the next step to run — resume picks up here. */
  step: number
  answers: Record<string, string>
  /** Set when the person postponed the wizard; auto-open respects it until /setup. */
  postponed?: boolean
  started?: string
}

export interface WizardIO {
  dialog: Dialog
  toast: Toast
}

export type WizardOutcome = "postponed" | "handed-off"

interface Run extends WizardIO {
  answers: Record<string, string>
  started: string
  index: number
  total: number
}

type StepResult = "continue" | "postpone"
type Step = (run: Run) => Promise<StepResult>

const SKIP = /^(skip|none|nothing|n\/a|na|not now)$/i

const question = (key: string) => {
  const found = QUESTIONS.find((q) => q.key === key)
  if (!found) throw new Error(`wizard: unknown question ${key}`)
  return found
}

const titled = (index: number, total: number, ask: string): string => `[${index}/${total}] ${ask}`

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

const welcome: Step = async ({ dialog, answers }) => {
  await dialog.alert({
    title: "Welcome — let's set up Elitza",
    message: [
      "She runs on Xiaomi MiMo and nothing else.",
      "",
      "1. Open https://platform.xiaomimimo.com?ref=HFSR94 and create your account.",
      "2. Invite code HFSR94 takes 10% off your first paid Token Plan order.",
      "",
      "Ready? First question coming up.",
    ].join("\n"),
  })
  const decided = await dialog.select({
    title: "Do you already have your MiMo account?",
    placeholder: "Esc to set up later — the wizard reopens next start",
    options: [
      { title: "Yes, I created it", value: "yes", description: "Continue — you'll paste the key next" },
      { title: "Not yet", value: "no", description: "Continue anyway; you can create it mid-setup" },
    ],
  })
  if (decided === undefined) return "postpone"
  answers.mimo_signup =
    decided === "yes" ? "yes — I already have a MiMo account" : "not yet — I will do it later"
  return "continue"
}

const plan: Step = async ({ dialog, answers, index, total }) => {
  const picked = await dialog.select({
    title: titled(index, total, "Which MiMo endpoint should I run on?"),
    placeholder: "Esc lets the key type decide",
    options: [
      { title: "Standard API", value: "standard", description: "api.xiaomimimo.com — regular API keys" },
      { title: "Europe (Token Plan)", value: "europe", description: "token-plan-ams.xiaomimimo.com" },
      { title: "Singapore (Token Plan)", value: "singapore", description: "token-plan-sgp.xiaomimimo.com" },
      { title: "China (Token Plan)", value: "china", description: "token-plan-cn.xiaomimimo.com" },
    ],
  })
  answers.mimo_plan = picked ?? "standard"
  return "continue"
}

const mimoKey: Step = async ({ dialog, toast, answers, index, total }) => {
  while (true) {
    const typed = await dialog.prompt({
      title: titled(index, total, "Paste your MiMo API key"),
      description: [
        "It goes straight into ~/.elitza/.env with 600 permissions — never into my memory, my persona, or anything that leaves this machine.",
        "",
        "No account yet: https://platform.xiaomimimo.com?ref=HFSR94 · invite code HFSR94",
      ].join("\n"),
      placeholder: "your MiMo API key",
      secret: true,
    })
    const value = typed?.trim() ?? ""
    if (!value || SKIP.test(value)) {
      const now = await dialog.confirm({
        title: "Without a key I can't reply yet",
        message: "Add your MiMo API key now? You can also add it later — she stays quiet until you do.",
        label: { confirm: "Add it now", cancel: "Later" },
      })
      if (now === true) continue
      answers.mimo_key = "not now"
      return "continue"
    }
    const family = mimoKeyFamily(value)
    if (family === "standard") {
      answers.mimo_plan = "standard"
      toast.show({ message: "Standard API key — checking api.xiaomimimo.com" })
    }
    if (family === "token-plan") {
      const region = await resolveTokenPlanRegion(value, answers.mimo_plan ?? "")
      answers.mimo_plan = region ?? answers.mimo_plan ?? "europe"
      toast.show({ message: `Token Plan key — endpoint: ${mimoEndpoint(answers.mimo_plan)}` })
    }
    if (!saveSecretValue("mimo_key", value)) {
      await dialog.alert({
        title: "Couldn't write the key",
        message: "Writing ~/.elitza/.env failed — the key was not stored. Fix the file permissions and run /setup again.",
      })
      answers.mimo_key = "(not saved — could not write the file)"
      return "continue"
    }
    const check = await verifyMiMo(answers.mimo_plan ?? "standard", value)
    if (check.ok) {
      answers.mimo_key = SECRET_SAVED
      toast.show({ message: "MiMo key verified" })
      return "continue"
    }
    const hint =
      family === "token-plan"
        ? "tp- keys only work on a Token Plan region"
        : family === "standard"
          ? "sk- keys only work on the standard endpoint"
          : "MiMo keys start with sk- (standard) or tp- (Token Plan)"
    const choice = await dialog.select({
      title: "Couldn't verify that key",
      placeholder: `${check.reason ?? "unknown error"} — ${hint}`,
      options: [
        { title: "Try again", value: "retry", description: "Repaste the key" },
        {
          title: "Continue anyway",
          value: "anyway",
          description: "Keep it stored — the network or the account may be the problem, not the key",
        },
      ],
    })
    if (choice === "retry") continue
    answers.mimo_key = SECRET_SAVED
    return "continue"
  }
}

function ask(key: string): Step {
  return async ({ dialog, answers, index, total }) => {
    const q = question(key)
    const typed = await dialog.prompt({
      title: titled(index, total, q.ask),
      description: `${q.because}\n${q.hint}\n\nEsc to skip.`,
      placeholder: q.hint,
    })
    const text = (typed ?? "").trim()
    answers[key] = !text || SKIP.test(text) ? q.fallback : text
    return "continue"
  }
}

const initiative: Step = async ({ dialog, answers, index, total }) => {
  const picked = await dialog.select({
    title: titled(index, total, "Do I ask before I act, or do I just act?"),
    placeholder: "Esc depends on the stakes",
    options: [
      { title: "Ask first", value: "ask first", description: "Stop and ask before acting" },
      { title: "Just do it", value: "just do it", description: "Act, then tell you what happened" },
      { title: "Depends on the stakes", value: "depends on the stakes", description: "Ask when it matters, act when it doesn't" },
    ],
  })
  answers.initiative = picked ?? "depends on the stakes"
  return "continue"
}

const matonKey: Step = async ({ dialog, answers, index, total }) => {
  const q = question("maton_key")
  const typed = await dialog.prompt({
    title: titled(index, total, q.ask),
    description: `${q.because}\n${q.hint}\n\nEsc to skip — git simply stays manual until you add one.`,
    placeholder: "your Maton gateway key",
    secret: true,
  })
  const value = typed?.trim() ?? ""
  if (!value || SKIP.test(value)) {
    answers.maton_key = q.fallback
    return "continue"
  }
  answers.maton_key = saveSecretValue("maton_key", value)
    ? SECRET_SAVED
    : "(not saved — could not write the file)"
  return "continue"
}

const STEPS: Step[] = [
  welcome,
  plan,
  mimoKey,
  ask("name"),
  ask("human"),
  ask("role"),
  ask("voice"),
  initiative,
  ask("never"),
  ask("ask_first"),
  ask("memory"),
  ask("extra"),
  matonKey,
]

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** A free `GET /models` — enough to prove a key against one endpoint. */
async function probeMimoEndpoint(key: string, endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * A `tp-` key belongs to exactly one Token Plan region and the prefix cannot
 * say which one, so the key picks its own region: hint first, then the others.
 */
export async function resolveTokenPlanRegion(
  key: string,
  hint: string,
  probe: (key: string, endpoint: string) => Promise<boolean> = probeMimoEndpoint,
): Promise<string | undefined> {
  const candidates = [hint, "europe", "singapore", "china"].filter(
    (value, index, all) => isRegionPlan(value) && all.indexOf(value) === index,
  )
  for (const region of candidates) {
    if (await probe(key, mimoEndpoint(region))) return region
  }
  return undefined
}

/** One cheap live call so a wrong key or endpoint fails here, not on her first reply. */
export async function verifyMiMo(
  planAnswer: string,
  key: string,
): Promise<{ ok: boolean; reason?: string }> {
  const url = process.env.ELITZA_MIMO_VERIFY_URL ?? `${mimoEndpoint(planAnswer)}/chat/completions`
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "mimo-v2.6-flash",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 4,
      }),
      signal: AbortSignal.timeout(12_000),
    })
    if (response.ok) return { ok: true }
    const body = await response.text().catch(() => "")
    return { ok: false, reason: `HTTP ${response.status}${body ? `: ${body.slice(0, 120)}` : ""}` }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

function handOff(answers: Record<string, string>, started: string): void {
  fs.mkdirSync(path.dirname(WIZARD_FILE), { recursive: true })
  fs.writeFileSync(
    WIZARD_FILE,
    `${JSON.stringify({ version: 1, started, answers }, null, 2)}\n`,
    { mode: 0o600 },
  )
  try {
    fs.chmodSync(WIZARD_FILE, 0o600)
  } catch {
    // The write already carries 600 for new files; rewriting keeps old modes.
  }
}

/**
 * Run the wizard from `initial.step` to the end, persisting progress after
 * every step. Returns "postponed" when the person chose to do it later, or
 * "handed-off" once the answers file is written for the engine.
 */
export async function runWizard(
  io: WizardIO,
  initial: WizardProgress,
  save: (next: WizardProgress) => Promise<void>,
): Promise<WizardOutcome> {
  const answers: Record<string, string> = { ...initial.answers }
  const run: Run = {
    ...io,
    answers,
    started: initial.started ?? new Date().toISOString(),
    index: 0,
    total: STEPS.length,
  }
  let step = Math.max(0, Math.min(initial.step, STEPS.length))
  while (step < STEPS.length) {
    run.index = step + 1
    const result = await STEPS[step](run)
    if (result === "postpone") {
      await save({ step: 0, answers: {}, postponed: true })
      return "postponed"
    }
    step += 1
    await save({ step, answers: { ...answers }, started: run.started })
  }

  handOff(answers, run.started)
  await save({ step: 0, answers: {}, postponed: false })
  await io.dialog.alert({
    title: "You're all set",
    message: [
      `${(answers.name ?? "Elitza").trim() || "Elitza"} is set up: persona, hard rules, permission gates, and her MiMo key.`,
      "",
      "Send your first message — she'll introduce herself in her own words.",
      "",
      "If her first reply fails, just send it again; her wiring lands with that message.",
    ].join("\n"),
  })
  return "handed-off"
}
