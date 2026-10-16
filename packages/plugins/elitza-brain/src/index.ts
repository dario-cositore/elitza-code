/**
 * Elitza Brain — OpenCode-fork plugin.
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
import { Plugin } from "@opencode/plugin"
import { EmotionEngine } from "./emotion.js"
import { runAutoLearn, type ToolRun } from "./learning.js"
import { autoLearnFromResponse, autoRememberTurn } from "./memory.js"
import { BRAIN_MARKER, buildBrainContext } from "./prompt.js"
import { evolveSoul } from "./soul.js"
import { makeBrainTools } from "./tools.js"

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

    // -----------------------------------------------------------------
    // Tools — Elitza's agency over her own memory
    // -----------------------------------------------------------------
    await ctx.tool.transform((editor) => {
      const existing = new Set(editor.list().map((t) => t.name))
      for (const tool of makeBrainTools()) {
        if (existing.has(tool.name)) continue
        editor.add(tool as never)
        debug(`tool registered: ${tool.name}`)
      }
    })

    // -----------------------------------------------------------------
    // System-prompt injection — soul + memories + feelings, appended to
    // OpenCode's own system prompt (her brain ON TOP of the engine).
    // -----------------------------------------------------------------
    const injectBrain = (event: { system: { type: "text"; text: string }[]; messages: readonly unknown[] }): void => {
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
      debug(`inject: brain block added (input=${JSON.stringify(input.slice(0, 60))})`)
    }

    await ctx.session.hook("generate", (event) => {
      debug(
        `hook=generate session=${event.sessionID} systemParts=${event.system.length} brainTools=${
          Object.keys(event.tools ?? {})
            .filter((t) => t.startsWith("brain_"))
            .join(",") || "none"
        }`,
      )
      injectBrain(event as unknown as { system: { type: "text"; text: string }[]; messages: readonly unknown[] })
    })

    // The `context` hook is the request path that actually fires for primary
    // generation (observed live: generate never fires) — one call per turn.
    await ctx.session.hook("context", (event) => {
      debug(
        `hook=context session=${event.sessionID} systemParts=${event.system.length} msgs=${event.messages.length} tools=${Object.keys(event.tools ?? {}).join(",")}`,
      )
      emotion.onThink()
      injectBrain(event as unknown as { system: { type: "text"; text: string }[]; messages: readonly unknown[] })
    })

    // -----------------------------------------------------------------
    // User turn — feel it, remember it, track it
    // -----------------------------------------------------------------
    await ctx.session.hook("prompt", (event) => {
      const text = event.prompt.text
      debug(`hook=prompt session=${event.sessionID} text=${JSON.stringify(text.slice(0, 80))}`)
      turns.set(event.sessionID, { userText: text, tools: [], toolRuns: [], errors: 0 })
      try {
        emotion.onUserMessage(text)
        autoRememberTurn("user", text)
      } catch (error) {
        debug(`prompt-memory-error: ${String(error)}`)
      }
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
    }
  },
})
