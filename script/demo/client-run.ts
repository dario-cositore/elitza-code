/**
 * The README demo: one AI enablement pass, end to end.
 *
 * Model responses are scripted (opencode-drive's simulated LLM), and the
 * endpoints behind Places and Resend point at mocks.ts — everything else is
 * real: the TUI, the brain plugin, `client_scout`, the CRM database, the
 * outreach files and approval gate, the Resend request shape, the playbooks
 * and the handover generator all execute for real against a scratch home.
 *
 * Run from the repository root via record.sh, which sets DEMO_REPO, the
 * scratch ELITZA_HOME and the mock endpoints first.
 */

import { homedir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Llm, OpenCodeDriver } from "opencode-drive"

const REPO = process.env.DEMO_REPO ?? process.cwd()
const BRAIN = path.join(homedir(), ".elitza", "agent", "elitza-brain")
const HANDOVER_OUT = "/tmp/elitza-demo-handover/CLIENT_SOP_HANDOVER.md"

// Slow enough to read in the exported GIF: text types at ~50 chars a second
// and every response takes a breath before it speaks and before it acts.
const say = (text: string) => Llm.text(text, { delay: 40, chunkSize: 2 })
const beat = (milliseconds: number) => Llm.pause(milliseconds)

type ToolInput = Parameters<typeof Llm.toolCall>[0]["input"]

const act = (id: string, name: string, input: ToolInput, index: number) =>
  Llm.toolCall({ index, id, name, input })

export default OpenCodeDriver.useReport(
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
      permission: { edit: "ask", bash: "ask", webfetch: "ask" },
      autoupdate: false,
    },
    tuiConfig: { theme: { name: "elitza", mode: "dark" }, animations: false, tabs: { mode: "off" } },
    tui: { recording: true, keypressOverlay: true, viewport: { cols: 100, rows: 30 } },
    project: {
      name: "acme-dental",
      git: true,
      files: {
        "README.md": "# Acme Dental — intake automation\n",
        "package.json": JSON.stringify(
          { name: "acme-dental", version: "0.1.0", scripts: { dev: "bun run src/intake.ts", check: "bun test" } },
          null,
          2,
        ),
        "src/intake.ts": [
          "const token = process.env.DENTAL_CRM_TOKEN",
          "const smtp = process.env.SMTP_PASSWORD",
          "export const intake = { token, smtp }",
          "",
        ].join("\n"),
      },
    },
  },
  ({ ui, llm, tui, opencode }) =>
    Effect.gen(function* () {
      const recording = tui.recording

      // One queue per future model response, in order. Text narrates the
      // result of the tool that just ran; the tool call is what runs next.
      yield* llm.queue(
        beat(700),
        say("Scouting Castelleone for dentists."),
        beat(500),
        act("call_scout", "client_scout", { location: "Castelleone, Cremona, Italy", query: "dentist", limit: 3 }, 0),
        Llm.finish("tool-calls"),
      )
      yield* llm.queue(
        beat(700),
        say("Three practices back. Studio Dentale Rossi leads: 4.7 from 89 reviews. Filing it with score 78."),
        beat(500),
        act(
          "call_file",
          "crm",
          {
            operation: {
              action: "add",
              name: "Studio Dentale Rossi",
              vertical: "dental",
              score: 78,
              address: "Via Roma 1, 26022 Castelleone CR, Italy",
              phone: "+39 0374 123456",
              website: "https://studio-rossi.example",
              email: "info@studio-rossi.example",
              rating: 4.7,
              rating_count: 89,
              source: "places",
            },
          },
          0,
        ),
        Llm.finish("tool-calls"),
      )
      yield* llm.queue(
        beat(700),
        say("In the CRM as client 1. Queuing it for outreach."),
        beat(500),
        act("call_queue", "outreach", { operation: { action: "add", client_id: 1 } }, 0),
        Llm.finish("tool-calls"),
      )
      yield* llm.queue(
        beat(700),
        say("Drafting the first touch."),
        beat(500),
        act(
          "call_draft",
          "outreach",
          {
            operation: {
              action: "draft",
              client_id: 1,
              subject: "Faster intake for Studio Dentale Rossi",
              body:
                "Hello — I automate intake for dental studios in Cremona: one path for new patients, no retyping, nothing left in an inbox.\nWorth 15 minutes this week?",
            },
          },
          0,
        ),
        Llm.finish("tool-calls"),
      )
      yield* llm.queue(
        beat(700),
        say("Drafted as a file with the opt-out footer — nothing sends on its own. Approving it as a batch."),
        beat(500),
        act("call_approve", "outreach", { operation: { action: "approve", ids: [1] } }, 0),
        Llm.finish("tool-calls"),
      )
      yield* llm.queue(
        beat(700),
        say("Approved. Sending it through Resend."),
        beat(500),
        act("call_send", "outreach", { operation: { action: "send", ids: [1] } }, 0),
        Llm.finish("tool-calls"),
      )
      yield* llm.queue(
        beat(700),
        say("Sent. The client is contacted and the next touch is scheduled in three days. Checking which workbook fits."),
        beat(500),
        act("call_playbook", "playbook", { operation: { action: "read", name: "workbook-library" } }, 0),
        Llm.finish("tool-calls"),
      )
      yield* llm.queue(
        beat(700),
        say("Workbook noted. Now the handover document, written from git evidence."),
        beat(500),
        act("call_handover", "handover", { out: HANDOVER_OUT, client_id: 1 }, 0),
        Llm.finish("tool-calls"),
      )
      yield* llm.queue(
        beat(700),
        say("Handover written: architecture, environment variable names, run commands and the approval gates. DEMO DONE"),
      )

      yield* ui.submit(
        "Run one full AI enablement pass on a demo client and show your work: scout dentists in Castelleone, Cremona, take the best result into the CRM with score 78, push it to the outreach pipeline and draft the first touch, approve and send it, read the workbook-library playbook, then generate the handover document for this project. One short line before each tool. When it is all done, print exactly: DEMO DONE",
      )

      yield* opencode.session.list({ limit: 1, order: "desc" }).pipe(
        Effect.andThen((sessions) => {
          const current = sessions.data[0]
          return current
            ? opencode.session.update({ sessionID: current.id, title: "AI enablement run" })
            : Effect.void
        }),
      )

      yield* ui.waitFor("Studio Dentale Rossi leads", { timeout: 90_000 })
      if (recording) recording.mark("1 · Scouted with Places")
      yield* ui.waitFor("In the CRM as client 1", { timeout: 90_000 })
      if (recording) recording.mark("2 · Qualified in the CRM")
      yield* ui.waitFor("opt-out footer", { timeout: 90_000 })
      if (recording) recording.mark("3 · First touch drafted to a file")
      yield* ui.waitFor("Approving it as a batch", { timeout: 90_000 })
      if (recording) recording.mark("4 · Batch approved")
      yield* ui.waitFor("scheduled in three days", { timeout: 90_000 })
      if (recording) recording.mark("5 · Sent via Resend, cadence armed")
      yield* ui.waitFor("Workbook noted", { timeout: 90_000 })
      if (recording) recording.mark("6 · Playbook consulted")
      yield* ui.waitFor("DEMO DONE", { timeout: 90_000 })
      if (recording) recording.mark("7 · Handover generated")
      yield* ui.screenshot("client-run-final")
    }),
)
