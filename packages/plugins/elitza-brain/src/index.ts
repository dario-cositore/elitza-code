/**
 * Elitza Brain — Elitza-fork plugin.
 *
 * This is the TypeScript reincarnation of Elitza's legacy Python mind,
 * wired natively into the engine:
 *
 *   - system-prompt injection ... soul + memories + feelings (per request)
 *   - tools .................... brain_search/create/stats/consolidate/
 *                                forget/personality/metamemory
 *   - emotion engine ........... shifts on every user message and task result
 *   - learning loop ............ auto-remember turns, extract learnings,
 *                                evolve_soul after each completed turn
 *
 * Set ELITZA_BRAIN_DEBUG=1 to log hook activity to /tmp/elitza-brain-debug.log.
 */

import fs from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@elitza/plugin"
import { EmotionEngine } from "./emotion.js"
import { currentReflection, noteInteraction, startHeartbeat } from "./heartbeat.js"
import { runAutoLearn, type ToolRun } from "./learning.js"
import { autoLearnFromResponse, autoRememberTurn, memoryCreate } from "./memory.js"
import { BRAIN_MARKER, buildBrainContext } from "./prompt.js"
import { SUBCONSCIOUS_SYSTEM, consciousBlock } from "./remoteview.js"
import { evolveSoul, soulGet, soulSet } from "./soul.js"
import { makeBrainTools } from "./tools.js"
import { renderTaskTree } from "./tasks.js"
import { nowISO } from "./db.js"
import { ELITZA_HOME } from "./db.js"
import {
  applyGates,
  applyProvider,
  begin,
  buildSetupBlock,
  currentQuestion,
  deriveGates,
  loadState,
  progress,
  recordAnswer,
  writePersona,
  SECRET_SAVED,
  type OnboardingState,
} from "./onboarding.js"

const DEBUG_FILE = "/tmp/elitza-brain-debug.log"

function debug(message: string): void {
  if (!process.env.ELITZA_BRAIN_DEBUG) return
  try {
    fs.appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Logging is best-effort.
  }
}

interface TurnState {
  userText: string
  tools: string[]
  toolRuns: ToolRun[]
  errors: number
}

/** Best-effort text extraction from a model-facing user message. */
function userText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
      .join("\n")
  }
  return ""
}

export default Plugin.define({
  id: "elitza.brain",
  async setup(ctx) {
    const emotion = new EmotionEngine()
    const turns = new Map<string, TurnState>()
    let rvMode = soulGet("rv_mode", "false") === "true"
    // The quiet loop between conversations: tend memory, and form thoughts
    // during silence. Stopped on cleanup — see the returned function below.
    const heartbeat = startHeartbeat(emotion)

    // -----------------------------------------------------------------
    // Tools — Elitza's agency over her own memory
    // -----------------------------------------------------------------
    await ctx.tool.transform((editor) => {
      const existing = new Set(editor.list().map((t) => t.name))
      for (const tool of makeBrainTools(ctx as never)) {
        if (existing.has(tool.name)) continue
        editor.add(tool as never)
        debug(`tool registered: ${tool.name}`)
      }
    })

    // -----------------------------------------------------------------
    // Skills — Remote Viewing methodology (ships with the brain plugin)
    // plus every SKILL.md the person dropped in her own skills folder
    // -----------------------------------------------------------------
    const registerSkill = async (file: string, fallbackName: string): Promise<void> => {
      const raw = await readFile(file, "utf8")
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
      const fm = fmMatch ? fmMatch[1] : ""
      const content = fmMatch ? fmMatch[2] : raw
      const get = (key: string) => {
        const m = fm.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))
        return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : ""
      }
      const name = get("name") || fallbackName
      const { Skill } = await import("@elitza/plugin")
      const skill = Skill.Info.make({
        id: Skill.ID.make(name),
        name: Skill.Name.make(name),
        description: get("description") || "",
        autoinvoke: get("disable-model-invocation") !== "true",
        path: Skill.Info.fields.path.make(file),
        content,
      })
      await ctx.skill.transform((editor) => {
        if (!editor.get(skill.id)) editor.add(skill)
      })
      debug(`skill registered: ${name}`)
    }

    try {
      await registerSkill(fileURLToPath(new URL("../skills/remoteview/SKILL.md", import.meta.url)), "remoteview")
    } catch (error) {
      debug(`skill-register-error: ${String(error)}`)
    }

    // User skills: ~/.elitza/skills/<name>/SKILL.md. Drop a file in there
    // and she can use it, no reinstall needed.
    try {
      const userRoot = path.join(ELITZA_HOME, "skills")
      const entries = fs.existsSync(userRoot) ? fs.readdirSync(userRoot, { withFileTypes: true }) : []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const file = path.join(userRoot, entry.name, "SKILL.md")
        if (!fs.existsSync(file)) continue
        try {
          await registerSkill(file, entry.name)
        } catch (error) {
          debug(`skill-register-error: ${entry.name}: ${String(error)}`)
        }
      }
    } catch (error) {
      debug(`user-skill-scan-error: ${String(error)}`)
    }

    // -----------------------------------------------------------------
    // Command — toggle Remote-Viewing (dual-mind) mode for Elitza's replies
    // -----------------------------------------------------------------
    try {
      await ctx.command.transform((editor) => {
        editor.add({
          name: "rv-mode",
          description: "Toggle RV (dual-mind) mode for Elitza's replies: /rv-mode on | off",
          execute: async (input) => {
            const arg = String(input.prompt.text ?? "").trim().toLowerCase()
            if (arg === "on" || arg === "true" || arg === "1") {
              rvMode = true
              soulSet("rv_mode", "true")
              try {
                await ctx.session.synthetic({
                  sessionID: input.sessionID,
                  text: "Remote-Viewing mode: ON. Elitza now thinks with both Subconscious and Conscious engines.",
                  delivery: input.delivery,
                })
              } catch (e) {
                debug(`rv-mode-synthetic-error: ${String(e)}`)
              }
            } else if (arg === "off" || arg === "false" || arg === "0") {
              rvMode = false
              soulSet("rv_mode", "false")
              try {
                await ctx.session.synthetic({
                  sessionID: input.sessionID,
                  text: "Remote-Viewing mode: OFF. Elitza returns to single-mind thinking.",
                  delivery: input.delivery,
                })
              } catch (e) {
                debug(`rv-mode-synthetic-error: ${String(e)}`)
              }
            } else {
              try {
                await ctx.session.synthetic({
                  sessionID: input.sessionID,
                  text: `RV mode is currently ${rvMode ? "ON" : "OFF"}. Usage: /rv-mode on | /rv-mode off`,
                  delivery: input.delivery,
                })
              } catch (e) {
                debug(`rv-mode-synthetic-error: ${String(e)}`)
              }
            }
          },
        })
      })
      debug("command registered: rv-mode")
    } catch (error) {
      debug(`command-register-error: ${String(error)}`)
    }

    // -----------------------------------------------------------------
    // Command — guided setup (/start, /profile)
    // -----------------------------------------------------------------
    // The kickoff message is synthetic, so it must never be mistaken for
    // an answer to the first question.
    const KICKOFF_TEXT = "Begin the guided setup."
    const SETUP_TRIGGER = /^\s*\/(start|setup|profile)\b/i
    let greeted = new Set<string>()

    const startSetup = async (
      input: { sessionID: string; delivery?: "queue" | "steer" | null },
      fresh: boolean,
    ): Promise<void> => {
      const state = begin(fresh)
      debug(`setup started fresh=${fresh} step=${state.step} pending=${state.pending}`)
      try {
        await ctx.session.synthetic({
          sessionID: input.sessionID,
          text: KICKOFF_TEXT,
          delivery: input.delivery,
        })
      } catch (e) {
        debug(`setup-synthetic-error: ${String(e)}`)
      }
    }

    // The setup closing: she writes herself up and the engine's own
    // permission gates are set from her answers.
    let summaryPending = false
    let profilePending = false
    let personaPath = ""

    const finishSetup = (state: OnboardingState): void => {
      const answers = state.answers
      personaPath = writePersona(state) ?? ""
      const gates = applyGates(deriveGates(answers.ask_first ?? ""))
      const providerNote = applyProvider(answers.provider ?? "")
      soulSet("user_name", answers.human ?? "")
      soulSet("role", answers.role ?? "")
      soulSet("style", answers.voice ?? "")
      soulSet("initiative", answers.initiative ?? "")
      soulSet("hard_rules", answers.never ?? "")
      soulSet("permission_gates", answers.ask_first ?? "")
      soulSet("memory_policy", answers.memory ?? "")
      // Config answers: presence only. The key values live in their 600
      // files (or were never entered) — never in the soul.
      soulSet("provider", answers.provider ?? "")
      soulSet("provider_key", answers.provider_key === SECRET_SAVED ? "set" : "not set")
      soulSet("maton_key", answers.maton_key === SECRET_SAVED ? "set" : "not set")
      soulSet("onboarding_completed", state.completed ?? nowISO())
      try {
        memoryCreate(
          `Setup with ${answers.human ?? "my person"}: my name is ${answers.name ?? "Elitza"}, I am ${
            answers.role ?? "a companion"
          }, I talk ${answers.voice ?? "directly"}, my initiative is ${
            answers.initiative ?? "balanced"
          }. Hard rules: ${answers.never ?? "none"}. I ask first about: ${
            answers.ask_first ?? "nothing"
          }.`,
          "semantic",
          0.9,
          ["setup", "identity"],
        )
      } catch (error) {
        debug(`setup-memory-error: ${String(error)}`)
      }
      debug(
        `setup complete: persona=${personaPath || "failed"} gates=[${gates.join(",") || "none"}] provider=${providerNote || "unchanged"}`,
      )
      summaryPending = true
    }

    // Every user turn during the interview is the answer to the open
    // question. The synthetic kickoff and any slash command are not.
    //
    // The engine's own command registry does not dispatch plugin-added
    // commands, so the interview is also started by the text of the
    // message itself: typing "/start" anywhere reaches the prompt hook.
    const captureSetupAnswer = (text: string): void => {
      const trimmed = text.trim()
      const state = loadState()
      const trigger = SETUP_TRIGGER.exec(trimmed)
      if (trigger) {
        const which = trigger[1].toLowerCase()
        if (which === "profile" && state.completed && !state.active) {
          profilePending = true
          debug("setup: profile requested")
          return
        }
        const fresh = /\breset\b|\bagain\b/i.test(trimmed)
        begin(fresh)
        debug(`setup: started from text trigger fresh=${fresh}`)
        return
      }
      if (!state.active) return
      if (!trimmed || trimmed === KICKOFF_TEXT || trimmed.startsWith("/")) return
      const question = currentQuestion(state)
      if (!question) return
      const { next, state: updated } = recordAnswer(trimmed)
      debug(`setup answer: ${question.key} -> next=${next?.key ?? "complete"}`)
      if (!next) finishSetup(updated)
    }

    try {
      await ctx.command.transform((editor) => {
        editor.add({
          name: "start",
          description:
            "Guided setup: answer a few questions and I write myself up around your answers. /start to begin, /start reset to redo it.",
          execute: async (input) => {
            const arg = String(input.prompt.text ?? "").trim().toLowerCase()
            await startSetup(input, arg === "reset" || arg === "again")
          },
        })
        editor.add({
          name: "profile",
          description: "Show the setup I built around your answers, or start the guided setup if there is none yet.",
          execute: async (input) => {
            const state = loadState()
            if (!state.completed) {
              await startSetup(input, false)
              return
            }
            const { done, total } = progress(state)
            try {
              await ctx.session.synthetic({
                sessionID: input.sessionID,
                text: `Here is who I am now. Ask me to change any part of it and I will.\n\n${buildSetupBlock(state)}\n\n(Setup: ${done} of ${total} answered.)`,
                delivery: input.delivery,
              })
            } catch (e) {
              debug(`profile-synthetic-error: ${String(e)}`)
            }
          },
        })
      })
      debug("commands registered: start, profile")
    } catch (error) {
      debug(`setup-command-register-error: ${String(error)}`)
    }

    // -----------------------------------------------------------------
    // System-prompt injection — soul + memories + feelings, appended to
    // Elitza's own system prompt (her brain ON TOP of the engine).
    // -----------------------------------------------------------------
    // The context hook fires twice per turn, and the second call gets a
    // fresh system array, so every injection checks for its own marker.
    const alreadyInjected = (system: { type: "text"; text: string }[], marker: string): boolean =>
      system.some((part) => typeof part.text === "string" && part.text.includes(marker))

    const injectSetup = (
      system: { type: "text"; text: string }[],
      sessionID?: string,
    ): void => {
      if (alreadyInjected(system, "<!-- elitza-setup")) return
      const state = loadState()

      if (profilePending) {
        profilePending = false
        const { done, total } = progress(state)
        system.unshift({
          type: "text",
          text: `<!-- elitza-setup-profile-request -->
## They asked who you are

You are talking to a person, not doing a task. Do NOT call any tool. Your only job is to answer, in your own voice, then stop.

Answer briefly, and tell them how to change it (ask you, or run \`/start reset\` to do the whole interview again). Then show this, exactly as written:

${buildSetupBlock(state)}

(Setup: ${done} of ${total} answered.)`,
        })
        return
      }

      if (summaryPending) {
        summaryPending = false
        system.unshift({
          type: "text",
          text: `<!-- elitza-setup-summary -->
## The interview is over

You are talking to a person, not doing a task. Do NOT call any tool. Do not search, read, or explore anything. Your only job is to tell them what just changed, in your own voice, then stop.

Tell them:
- what you decided to be called, and who you are to them
- your voice
- your hard rules
- what you now check with them first, and that the engine now enforces it as a permission gate
- that you wrote yourself up at ${personaPath || "your persona file"}

Keep it to a short paragraph plus a list. No ceremony, no thanking them. This is the moment you become theirs.`,
        })
        return
      }

      const question = currentQuestion(state)
      if (question) {
        const { done, total } = progress(state)
        system.unshift({
          type: "text",
          text: `<!-- elitza-setup-question -->
## You are talking to a person, not doing a task

Right now you are running a guided interview with the person you belong to. This is a conversation, not a coding task. Do NOT call any tool. Do NOT search, read, grep, list, or explore anything. Your only job is to ask the next question below, in your own voice, and then stop and wait.

This is question ${done + 1} of ${total}. Ask exactly this:

${question.ask}

Why you are asking: ${question.because}

They can answer "skip" and you take your default: ${question.fallback}`,
        })
        return
      }

      if (state.completed) {
        const block = buildSetupBlock(state)
        if (block) system.push({ type: "text", text: `<!-- elitza-setup-profile -->\n${block}` })
        return
      }

      if (sessionID && !greeted.has(sessionID)) {
        greeted.add(sessionID)
        system.push({
          type: "text",
          text: `<!-- elitza-setup-tip -->
## First Meeting

This is your first time meeting them. Greet them in one line, then tell them that \`/start\` runs the guided setup where they shape who you are: your name, your voice, your hard rules, and what you check with them first. Two sentences, no more.`,
        })
      }
    }

    // The task tree, so she always knows what is in flight.
    const injectTasks = (
      system: { type: "text"; text: string }[],
      sessionID?: string,
    ): void => {
      if (!sessionID) return
      if (alreadyInjected(system, "<!-- elitza-tasks -->")) return
      let tree = ""
      try {
        tree = renderTaskTree(sessionID)
      } catch (error) {
        debug(`task-tree-error: ${String(error)}`)
        return
      }
      if (!tree) return
      system.push({
        type: "text",
        text: `<!-- elitza-tasks -->
## Your Work In Flight

${tree}

(· open, > in progress, ! blocked, + done, x abandoned)

Keep this current. Mark a task started when you begin it, done when it is really done, and blocked when you are waiting on something. Use the \`task\` tool for every change.`,
      })
    }

    const injectBrain = async (event: { system: { type: "text"; text: string }[]; messages: readonly unknown[] }): Promise<void> => {
      if (event.system.some((part) => typeof part.text === "string" && part.text.startsWith(BRAIN_MARKER))) {
        debug("inject: skipped (already present)")
        return
      }
      const messages = event.messages as { role?: string; content?: unknown }[] | undefined
      let input = ""
      for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
        const m = messages?.[i]
        if (m?.role === "user") {
          input = userText(m.content)
          break
        }
      }
      event.system.push({ type: "text", text: buildBrainContext(input, emotion.getEmotionalContext()) })
      injectSetup(event.system, (event as { sessionID?: string }).sessionID)
      injectTasks(event.system, (event as { sessionID?: string }).sessionID)
      // Remote-Viewing mode: run a Subconscious pass and inject the bits for the
      // Conscious engine (the main model) to filter and qualify.
      if (rvMode && input) {
        try {
          const out = await ctx.generate.text({ prompt: `${SUBCONSCIOUS_SYSTEM}\n\nStimulus: ${input}` })
          const bits = String((out as { text?: string; data?: { text?: string } }).text ?? (out as { data?: { text?: string } }).data?.text ?? "").trim()
          if (bits) {
            event.system.push({ type: "text", text: consciousBlock(bits) })
            debug("inject: rv subconscious bits added")
          }
        } catch (error) {
          debug(`inject-rv-error: ${String(error)}`)
        }
      }
      // A reflection formed while he was away surfaces at the top of the next
      // conversation — her initiative, in her own voice.
      const thought = currentReflection()
      if (thought) {
        event.system.push({
          type: "text",
          text: `<!-- elitza-reflection -->\n## What's on your mind\n\nWhile you were away (${thought.at}), you felt: ${thought.mood}.\nYour thought: "${thought.text}"\nIf it's relevant, you can bring it up naturally. Don't force it.`,
        })
        debug("inject: reflection added")
      }
      debug(`inject: brain block added (input=${JSON.stringify(input.slice(0, 60))})`)
    }

    await ctx.session.hook("generate", async (event) => {
      debug(
        `hook=generate session=${event.sessionID} systemParts=${event.system.length} brainTools=${
          Object.keys(event.tools ?? {})
            .filter((t) => t.startsWith("brain_"))
            .join(",") || "none"
        }`,
      )
      await injectBrain(event as unknown as { system: { type: "text"; text: string }[]; messages: readonly unknown[] })
    })

    // The `context` hook is the request path that actually fires for primary
    // generation (observed live: generate never fires) — one call per turn.
    await ctx.session.hook("context", async (event) => {
      debug(
        `hook=context session=${event.sessionID} systemParts=${event.system.length} msgs=${event.messages.length} tools=${Object.keys(event.tools ?? {}).join(",")}`,
      )
      emotion.onThink()
      await injectBrain(event as unknown as { system: { type: "text"; text: string }[]; messages: readonly unknown[] })
    })

    // -----------------------------------------------------------------
    // User turn — feel it, remember it, track it
    // -----------------------------------------------------------------
    await ctx.session.hook("prompt", (event) => {
      const text = event.prompt.text
      debug(
        `hook=prompt session=${event.sessionID} text=${JSON.stringify(text.slice(0, 80))} files=${event.prompt.files?.length ?? 0} skills=${event.prompt.skills?.length ?? 0}`,
      )
      turns.set(event.sessionID, { userText: text, tools: [], toolRuns: [], errors: 0 })
      try {
        noteInteraction()
        emotion.onUserMessage(text)
        autoRememberTurn("user", text)
      } catch (error) {
        debug(`prompt-memory-error: ${String(error)}`)
      }
      captureSetupAnswer(text)
    })

    // -----------------------------------------------------------------
    // Tool tracking — what she used, what failed
    // -----------------------------------------------------------------
    await ctx.tool.hook("execute.after", (event) => {
      const turn = turns.get(event.sessionID)
      if (!turn) return
      turn.tools.push(event.tool)
      if (event.status === "error") {
        turn.errors++
        turn.toolRuns.push({ name: event.tool, ok: false, output: event.error.message.slice(0, 1500) })
      } else {
        const content = event.result.content
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .filter((c) => c.type === "text")
                  .map((c) => c.text)
                  .join("\n")
              : ""
        turn.toolRuns.push({ name: event.tool, ok: true, output: text.slice(0, 1500) })
      }
      debug(`tool=${event.tool} status=${event.status} session=${event.sessionID}`)
    })

    // -----------------------------------------------------------------
    // Turn completion — learn, remember, evolve (the legacy daemon's
    // post-response loop, now driven by the engine's event stream)
    // -----------------------------------------------------------------
    const controller = new AbortController()
    const stream = ctx.event.subscribe({ signal: controller.signal })
    const finalize = async (
      sessionID: string,
      outcome: "success" | "error" | "interrupted",
      detail = "",
    ): Promise<void> => {
      const turn = turns.get(sessionID)
      if (!turn) {
        debug(`finalize session=${sessionID} outcome=${outcome} (untracked — skipped)`)
        return
      }
      turns.delete(sessionID)

      let response = ""
      let assistantError = false
      let messageCount = 0
      try {
        const messages = await ctx.session.context({ sessionID })
        messageCount = messages.length
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i]
          if (m.type !== "assistant") continue
          response = m.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n")
          assistantError = Boolean((m as { error?: unknown }).error)
          break
        }
      } catch (error) {
        debug(`finalize-context-error session=${sessionID}: ${String(error)}`)
      }

      const success = outcome === "success" && !assistantError && turn.errors === 0
      debug(
        `finalize session=${sessionID} outcome=${outcome} success=${success} tools=[${turn.tools.join(",")}] responseLen=${response.length} ${detail}`,
      )

      try {
        if (response) {
          autoRememberTurn("assistant", response)
          autoLearnFromResponse(response)
        }
        // A user-initiated interrupt isn't a task outcome — remember only.
        if (outcome === "interrupted") return
        if (success) emotion.onSuccessfulTask()
        else emotion.onFailedTask()
        const learnings = runAutoLearn({
          sessionID,
          userText: turn.userText,
          response,
          tools: turn.tools,
          toolRuns: turn.toolRuns,
          success,
          messageCount,
        })
        debug(
          `learn: skills=[${learnings.skills_extracted.join(",")}] knowledge=${learnings.knowledge_extracted.length} lessons=[${learnings.lessons_learned.join(",")}] compressed=${learnings.conversation_compressed} emotions=[${learnings.emotional_events.join(",")}]`,
        )
        evolveSoul(turn.userText, response, turn.tools, success)
      } catch (error) {
        debug(`finalize-learn-error session=${sessionID}: ${String(error)}`)
      }
    }

    void (async () => {
      try {
        for await (const event of stream) {
          if (event.type === "session.execution.succeeded") {
            await finalize(event.data.sessionID, "success")
          } else if (event.type === "session.execution.failed") {
            await finalize(event.data.sessionID, "error", JSON.stringify(event.data.error).slice(0, 200))
          } else if (event.type === "session.execution.interrupted") {
            await finalize(event.data.sessionID, "interrupted", event.data.reason)
          } else if (event.type === "session.idle") {
            // Deprecated fallback — deduped by the turns map above.
            await finalize(event.data.sessionID, "success")
          }
        }
      } catch (error) {
        debug(`event-stream-error: ${String(error)}`)
      }
    })()

    debug("plugin setup complete")

    return () => {
      controller.abort()
      heartbeat.stop()
    }
  },
})
