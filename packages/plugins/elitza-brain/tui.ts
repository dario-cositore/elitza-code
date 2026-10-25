/**
 * Elitza Brain — TUI entrypoint (resolves `<dir>/tui` via Host.resolve).
 *
 * Dialogs live in the TUI process, so the visual first-run wizard runs here:
 * popups for every setup question, secrets straight to their 600 files, and
 * a hand-off file the engine adopts. The engine never renders UI, the TUI
 * never writes her soul.
 *
 * Auto-opens on the first start after setup is incomplete; `/setup` reopens
 * it any time (and asks before starting over once it is complete).
 */

import fs from "node:fs"
import { Plugin } from "@elitza/plugin/tui"
import { WIZARD_FILE, isComplete } from "./src/onboarding.js"
import { runWizard, type WizardProgress } from "./src/wizard.js"

const DEBUG_FILE = "/tmp/elitza-brain-debug.log"

/** Same channel as the engine plugin (ELITZA_BRAIN_DEBUG=1), prefixed `tui:`. */
function debug(message: string): void {
  if (!process.env.ELITZA_BRAIN_DEBUG) return
  try {
    fs.appendFileSync(DEBUG_FILE, `${new Date().toISOString()} tui: ${message}\n`)
  } catch {
    // Logging is best-effort.
  }
}

export default Plugin.define({
  id: "elitza.brain.tui",
  setup: async (ctx) => {
    debug("setup: loaded")
    const [progress, save] = ctx.storage.store<WizardProgress>("elitza.setup", {
      initial: { step: 0, answers: {} },
    })
    // Shared with every generation of this plugin while the TUI lives, so a
    // hot reload cannot start a second wizard over an open one.
    const [flags, setFlags] = ctx.storage.memory("elitza.setup.flags", {
      initial: { running: false },
    })

    const open = async (fresh: boolean): Promise<void> => {
      if (flags.running) return
      debug(`open: start fresh=${fresh} step=${progress.step}`)
      setFlags((draft) => {
        draft.running = true
      })
      try {
        const initial: WizardProgress = fresh
          ? { step: 0, answers: {} }
          : { step: progress.step, answers: { ...progress.answers }, started: progress.started }
        const outcome = await runWizard(
          { dialog: ctx.ui.dialog, toast: ctx.ui.toast },
          initial,
          (next) =>
            save((draft) => {
              draft.step = next.step
              draft.answers = next.answers
              draft.postponed = next.postponed
              draft.started = next.started
            }),
        )
        debug(`open: done outcome=${outcome}`)
      } catch (error) {
        debug(`open: error ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
        ctx.ui.toast.show({
          message: `Setup wizard stopped: ${error instanceof Error ? error.message : String(error)}`,
          variant: "error",
        })
      } finally {
        setFlags((draft) => {
          draft.running = false
        })
      }
    }

    const shouldAutoOpen = (): boolean => {
      try {
        if (flags.running) return false
        if (isComplete()) return false
        if (fs.existsSync(WIZARD_FILE)) return false
        if (progress.postponed) return false
        return true
      } catch (error) {
        debug(`gate: error ${String(error)}`)
        return false
      }
    }

    // Give the TUI a beat to mount before the first dialog replaces itself in.
    const timer = setTimeout(() => {
      const decision = shouldAutoOpen()
      debug(`auto-open decision=${decision}`)
      if (decision) void open(false)
    }, 350)

    // Global so `/setup` is reachable from the prompt's slash list on every
    // screen, not only while the base keymap mode owns the input.
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "elitza.setup",
          title: "Guided setup",
          description: "Answer the setup questions in popups — first run, resume, or start over.",
          group: "Elitza",
          palette: true,
          slash: { name: "setup" },
          continues: false,
          run: async () => {
            let fresh = false
            try {
              if (isComplete()) {
                const again = await ctx.ui.dialog.confirm({
                  title: "Run the guided setup again?",
                  message:
                    "This starts from scratch. Her current persona, permission gates, and stored keys are replaced when it finishes.",
                  label: { confirm: "Start over", cancel: "Cancel" },
                })
                if (again !== true) return
                fresh = true
              }
            } catch {
              // A soul read failure must not block opening the wizard.
            }
            await open(fresh)
          },
        },
      ],
    }))

    return () => clearTimeout(timer)
  },
})
