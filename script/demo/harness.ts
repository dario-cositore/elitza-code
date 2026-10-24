/**
 * Harness check for the demo recorder.
 *
 * Proves the three things every recording needs before the real script runs:
 * the dev target boots, the brain plugin loads into the driven server, and a
 * simulated model can invoke a REAL plugin tool (undeclared tools keep their
 * OpenCode implementation — only declared ones are intercepted).
 *
 * Run from script/demo: `bun run harness.ts` (see record.sh for the env).
 */

import { homedir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Llm, OpenCodeDriver } from "opencode-drive"

// Drive composes BUN_OPTIONS from the dev path, and a path with spaces in it
// is split into stray bun arguments (this repository lives under
// "2. Elitza Ecosystem"). record.sh creates a space-free symlink and passes
// it here; cwd alone gets realpath'd back to the spaced path.
const REPO = process.env.DEMO_REPO ?? process.cwd()
const BRAIN = path.join(homedir(), ".elitza", "agent", "elitza-brain")

export default OpenCodeDriver.use(
  {
    keepArtifacts: true,
    opencode: { dev: REPO },
    config: {
      model: "elitza/xiaomi/mimo-v2.6-flash",
      plugins: [BRAIN],
      providers: {
        elitza: {
          name: "Xiaomi MiMo",
          package: "@elitza/ai/providers/openai-compatible",
          env: ["XIAOMI_API_KEY"],
          settings: { baseURL: "https://api.xiaomimimo.com/v1" },
          models: { "xiaomi/mimo-v2.6-flash": { name: "MiMo V2.6 Flash", modelID: "mimo-v2.6-flash" } },
        },
      },
      permission: { edit: "allow", bash: "allow", webfetch: "allow" },
      autoupdate: false,
    },
    tui: { viewport: { cols: 100, rows: 30 } },
    project: { name: "harness-check", git: true, files: { "README.md": "# Harness check\n" } },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      yield* llm.queue(
        Llm.text("Checking the brain."),
        Llm.toolCall({ index: 0, id: "call_stats", name: "brain_stats", input: {} }),
        Llm.finish("tool-calls"),
      )
      yield* llm.queue(Llm.text("HARNESS OK"))
      yield* ui.submit("show the brain status")
      yield* Effect.sleep(15_000)
      yield* ui.screenshot("mid-flight")
      // Default wait is 5s; first turn also loads the plugin and seeds it.
      yield* ui.waitFor("HARNESS OK", { timeout: 60_000 })
      yield* ui.screenshot("harness-ok")
    }),
)
