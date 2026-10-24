/**
 * Elitza Brain — tools.
 *
 * 1:1 port of the full tool surface of legacy `tools/brain_tools.py`,
 * registered through the Elitza plugin tool registry so Elitza can
 * interact with her own mind:
 *   brain_search, brain_create, brain_stats, brain_consolidate,
 *   brain_forget, brain_personality, brain_metamemory,
 *   brain_learning, brain_persistence, brain_search_history, brain_sessions,
 *   brain_config, brain_validate, doctor_check, doctor_repair, doctor_history
 */

import { doctorCheck, doctorHistory, doctorRepair } from "./doctor.js"

import { armoryRun, fetchRegistry, fetchTool } from "./armory.js"
import { configSection, validateConfig } from "./configview.js"
import { getLearningStats } from "./learning.js"
import {
  getMetamemory,
  memoryConsolidate,
  memoryCreate,
  memoryForget,
  memorySearch,
  memoryStats,
} from "./memory.js"
import { pollPipeline, querySignals } from "./pipeline.js"
import { persistenceStats, recentSessions, searchMessages } from "./sessions.js"
import { getPersonality } from "./soul.js"
import { runRemoteViewing } from "./remoteview.js"
import {
  abandonTask,
  blockTask,
  createTask,
  describeTask,
  doneTask,
  listTasks,
  renameTask,
  startTask,
  unblockTask,
  type TaskStatus,
} from "./tasks.js"

// The promise-API tool shape: execute returns a Promise.
export interface BrainToolInfo {
  name: string
  description: string
  input: { type: "object"; properties: Record<string, unknown>; required?: string[] }
  execute: (
    input: Record<string, any>,
    ctx?: { sessionID?: string },
  ) => Promise<{ content: string }>
  options?: { codemode: boolean }
}

export function makeBrainTools(ctx?: { generate: { text: (input: { prompt: string }) => Promise<{ data: { text: string } }> } }): BrainToolInfo[] {
  const tools: BrainToolInfo[] = [
    {
      name: "brain_search",
      description:
        "Search your memories and knowledge. Use this to recall past interactions, facts, skills, or emotional experiences.",
      input: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query (what you want to remember)",
          },
          memory_type: {
            type: "string",
            enum: ["episodic", "semantic", "procedural", "emotional"],
            description: "Filter by memory type (optional)",
          },
          limit: {
            type: "integer",
            description: "Max results (default 10)",
            default: 10,
          },
        },
        required: ["query"],
      },
      execute: async (input) => ({
        content: memorySearch(input.query, input.memory_type, input.limit ?? 10),
      }),
    },
    {
      name: "brain_create",
      description:
        "Create a new memory. Use this to explicitly store important information you want to remember.",
      input: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The memory content to store",
          },
          memory_type: {
            type: "string",
            enum: ["episodic", "semantic", "procedural", "emotional"],
            description: "Type of memory (default: episodic)",
          },
          importance: {
            type: "number",
            description: "Importance 0.0-1.0 (default 0.7)",
            default: 0.7,
          },
          tags: {
            type: "string",
            description: "Comma-separated tags for categorization",
          },
        },
        required: ["content"],
      },
      execute: async (input) => {
        const tags: string[] = input.tags
          ? String(input.tags)
              .split(",")
              .map((t: string) => t.trim())
              .filter(Boolean)
          : []
        return {
          content: memoryCreate(
            input.content,
            input.memory_type ?? "episodic",
            input.importance ?? 0.7,
            tags,
          ),
        }
      },
    },
    {
      name: "brain_stats",
      description: "View your brain statistics, memory counts, and current personality state.",
      input: { type: "object", properties: {} },
      execute: async () => ({ content: memoryStats() }),
    },
    {
      name: "brain_consolidate",
      description:
        "Run memory consolidation. This promotes important episodic memories to lasting semantic knowledge.",
      input: { type: "object", properties: {} },
      execute: async () => ({ content: memoryConsolidate() }),
    },
    {
      name: "brain_forget",
      description: "Forget memories matching a query. Use this to remove outdated or incorrect information.",
      input: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to forget",
          },
        },
        required: ["query"],
      },
      execute: async (input) => ({ content: memoryForget(input.query) }),
    },
    {
      name: "brain_personality",
      description: "View your current personality, mood, confidence, and emotional state.",
      input: { type: "object", properties: {} },
      execute: async () => {
        const p = getPersonality()
        return {
          content: JSON.stringify(
            {
              name: p.name,
              mood: p.mood,
              confidence: p.confidence,
              interactions: p.interactions,
              style: p.style,
              emotional_state: p.emotional_state ?? {},
              top_tools: Object.entries(p.preferences ?? {})
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5),
              recent_learnings: (p.learnings ?? []).slice(-3),
            },
            null,
            2,
          ),
        }
      },
    },
    {
      name: "brain_metamemory",
      description:
        "View metamemory statistics - how your memory system is performing, recall patterns, and most accessed memories.",
      input: { type: "object", properties: {} },
      execute: async () => ({ content: JSON.stringify(getMetamemory(), null, 2) }),
    },
    {
      name: "brain_learning",
      description:
        "View auto-learning statistics - how many skills, knowledge items, and lessons have been extracted from conversations.",
      input: { type: "object", properties: {} },
      execute: async () => ({ content: JSON.stringify(getLearningStats(), null, 2) }),
    },
    {
      name: "brain_persistence",
      description: "View persistence statistics - how many messages and sessions are stored permanently.",
      input: { type: "object", properties: {} },
      execute: async () => ({ content: JSON.stringify(persistenceStats(), null, 2) }),
    },
    {
      name: "brain_search_history",
      description: "Search across ALL past conversations to find relevant context.",
      input: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to search for in conversation history",
          },
          limit: {
            type: "integer",
            description: "Max results (default 10)",
            default: 10,
          },
        },
        required: ["query"],
      },
      execute: async (input) => ({
        content: searchMessages(input.query, input.limit ?? 10),
      }),
    },
    {
      name: "brain_sessions",
      description: "View recent conversation sessions.",
      input: { type: "object", properties: {} },
      execute: async () => ({ content: recentSessions(10) }),
    },
    {
      name: "brain_config",
      description:
        "View Elitza's configuration. Pass a section name (e.g., 'model', 'brain', 'personality') to see specific settings, or leave empty for full summary.",
      input: {
        type: "object",
        properties: {
          section: {
            type: "string",
            description: "Config section to view (e.g., 'model', 'brain', 'personality', 'tools')",
          },
        },
      },
      execute: async (input) => ({
        content: configSection(input.section ?? "", tools.map((t) => t.name)),
      }),
    },
    {
      name: "brain_validate",
      description: "Validate Elitza's configuration and show any warnings or issues.",
      input: { type: "object", properties: {} },
      execute: async () => {
        const warnings = validateConfig()
        if (warnings.length === 0) return { content: "Configuration is valid. No warnings." }
        return {
          content: [`Configuration warnings (${warnings.length}):`, ...warnings.map((w) => `- ${w}`)].join("\n"),
        }
      },
    },
    {
      name: "doctor_check",
      description:
        "Run a full health check on all Elitza subsystems (databases, brain, config, tools, plugins, hooks, disk space).",
      input: { type: "object", properties: {} },
      execute: async () => ({ content: doctorCheck(tools.map((t) => t.name)) }),
    },
    {
      name: "doctor_repair",
      description: "Attempt to automatically repair any detected issues with Elitza's subsystems.",
      input: { type: "object", properties: {} },
      execute: async () => ({ content: doctorRepair() }),
    },
    {
      name: "doctor_history",
      description: "View health check history over the past week.",
      input: { type: "object", properties: {} },
      execute: async () => ({ content: doctorHistory(7) }),
    },
    {
      name: "gapfeed_query_signals",
      description:
        "Scan the local gapfeed radar for real-time buyer-intent signals: fresh pain points and operational bottlenecks from the market feed. Reads the LOCAL gapfeed backend (127.0.0.1:5002, overridable with GAPFEED_LOCAL_URL) — returns an empty result when that server is not running. region filters client-side against each signal's location, so locations without a country do not match italy/eu.",
      input: {
        type: "object",
        properties: {
          vertical: {
            type: "string",
            description: "Filter by vertical, e.g. legal_tech, crm_ops, logistics (optional)",
          },
          region: {
            type: "string",
            enum: ["italy", "eu", "global"],
            description: "Filter by signal location (default: global)",
          },
          urgency_threshold: {
            type: "number",
            description: "Minimum urgency 0-1 (default 0)",
          },
          quality_tier: {
            type: "string",
            enum: ["gold", "silver", "bronze", "noise"],
            description: "Exact quality tier filter (optional)",
          },
          limit: {
            type: "integer",
            description: "Max signals to return, 1-500 (default 50)",
          },
        },
      },
      execute: async (input) => {
        const signals = await querySignals({
          vertical: input.vertical ? String(input.vertical) : undefined,
          region: (input.region as "italy" | "eu" | "global" | undefined) ?? "global",
          urgency_threshold: Number(input.urgency_threshold ?? 0),
          quality_tier: input.quality_tier ? String(input.quality_tier) : undefined,
          limit: Number(input.limit ?? 50),
        })
        if (!signals.length) {
          return {
            content:
              "No signals matched (or the local gapfeed server is not running — start it with: cd gapfeed && .venv/bin/python -m ui.server)",
          }
        }
        return { content: JSON.stringify({ count: signals.length, signals }, null, 2) }
      },
    },
    {
      name: "gapfeed_build_pipeline",
      description:
        "Run the outreach pipeline immediately: pull recent high-urgency signals from the local gapfeed radar and write a markdown outreach draft for each one not already drafted, into ~/.elitza/pipeline/<date>/. Never sends anything — drafts wait for a human read. Bypasses the 6-hour heartbeat interval.",
      input: { type: "object", properties: {} },
      execute: async () => {
        const result = await pollPipeline({ force: true })
        if (!result) return { content: "The pipeline is disabled (ELITZA_GAPFEED=0)." }
        if (!result.fetched) {
          return {
            content:
              "No signals above the draft threshold — or the local gapfeed server is not running (start it with: cd gapfeed && .venv/bin/python -m ui.server)",
          }
        }
        if (!result.drafted.length) return { content: `Fetched ${result.fetched} signal(s); all already drafted (${result.skipped} skipped).` }
        return {
          content: [
            `Fetched ${result.fetched} signal(s); wrote ${result.drafted.length} new draft(s), skipped ${result.skipped} already-drafted.`,
            "",
            ...result.drafted,
            "",
            "Review each draft before anything goes out — the pipeline never sends.",
          ].join("\n"),
        }
      },
    },
    {
      name: "armory_list_tools",
      description:
        "List the verified first-party tools published in the Armory registry (hub.dariocositore.com). Returns name, tier, status, and summary per tool. The registry is first-party-only: everything listed is authored and maintained by dario-cositore.",
      input: { type: "object", properties: {} },
      execute: async () => {
        const registry = await fetchRegistry()
        if (!registry) {
          return {
            content:
              "The Armory registry is unreachable (https://hub.dariocositore.com/api/v1/registry). Check connectivity, or point ARMORY_BASE_URL at a local instance.",
          }
        }
        const lines = registry.tools.map(
          (tool) => `- ${tool.id} (${tool.name}) v${tool.version} [${tool.tier}/${tool.status}] — ${tool.summary}`,
        )
        return {
          content: [`Armory registry v${registry.registry_version} — ${registry.count} first-party tools:`, "", ...lines].join("\n"),
        }
      },
    },
    {
      name: "armory_fetch_tool",
      description:
        "Fetch one tool's full schema and execution contract from the first-party Armory registry. The entry is runtime-validated against the registry contract; malformed entries are refused, not repaired.",
      input: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Tool id, e.g. gapfeed-signals, playwright-screenshot" },
        },
        required: ["slug"],
      },
      execute: async (input) => {
        const fetched = await fetchTool(String(input.slug))
        if ("error" in fetched) return { content: fetched.error }
        return { content: JSON.stringify(fetched.tool, null, 2) }
      },
    },
    {
      name: "armory_run_tool",
      description:
        "Execute an Armory registry tool — interactively confirmed, two-phase. FIRST call: leave confirm unset (or false) to see the exact command/URL and input; nothing runs. SECOND call with confirm=true executes the reviewed request (10-minute TTL). http GET and command-recipe tools run on this machine; schema-preview and client-build entries are never executable.",
      input: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Tool id from the registry" },
          input: { type: "object", description: "Tool input, validated against the tool's input_schema" },
          confirm: { type: "boolean", description: "Set true ONLY to execute an already-reviewed request" },
        },
        required: ["slug"],
      },
      execute: async (input) => {
        const toolInput = (input.input && typeof input.input === "object" ? input.input : {}) as Record<string, unknown>
        const content = await armoryRun(String(input.slug), toolInput, input.confirm === true)
        return { content }
      },
    },
    {
      name: "task",
      description:
        "Track multi-step work as tasks, so a job survives across turns and restarts. Use it whenever a request has three or more steps, or when you need to track progress on something already in flight. Operations: create (summary, optional parent_id), list (optional status, optional include_terminal), get (id), start (id), block (id, event_summary), unblock (id), done (id, event_summary), abandon (id, event_summary), rename (id, summary). Statuses move open -> in_progress, either -> blocked, blocked -> open, either -> done or abandoned. Ids are hierarchical: T1, T2, T1.1.",
      input: {
        type: "object",
        properties: {
          operation: {
            type: "object",
            description: "The task operation to perform.",
            properties: {
              action: {
                type: "string",
                enum: ["create", "list", "get", "start", "block", "unblock", "done", "abandon", "rename"],
                description: "Which operation to run.",
              },
              id: {
                type: "string",
                description: "Task id, for every operation except create and list.",
              },
              summary: {
                type: "string",
                description: "What the task is, for create and rename.",
              },
              parent_id: {
                type: "string",
                description: "Parent task id, for create. Leave empty for a top-level task.",
              },
              event_summary: {
                type: "string",
                description: "A short note about what just happened, for start, block, unblock, done and abandon.",
              },
              status: {
                type: "string",
                enum: ["open", "in_progress", "blocked", "done", "abandoned", "all"],
                description: "Filter for list.",
              },
              include_terminal: {
                type: "boolean",
                description: "For list: include finished tasks. They are hidden after a week.",
              },
            },
            required: ["action"],
          },
        },
        required: ["operation"],
      },
      execute: async (input, toolCtx) => {
        const sessionID = toolCtx?.sessionID ?? "default"
        const op = (input.operation ?? {}) as Record<string, any>
        const action = String(op.action ?? "")
        try {
          switch (action) {
            case "create": {
              const task = createTask(sessionID, String(op.summary ?? ""), op.parent_id ?? null)
              return { content: `Created ${task.id}: ${task.summary}` }
            }
            case "list": {
              const tasks = listTasks(sessionID, {
                status: op.status as TaskStatus | "all" | undefined,
                includeTerminal: Boolean(op.include_terminal),
              })
              if (!tasks.length) return { content: "No tasks." }
              return { content: tasks.map((t) => `${t.id} [${t.status}] ${t.summary}`).join("\n") }
            }
            case "get":
              return { content: describeTask(sessionID, String(op.id ?? "")) }
            case "start": {
              const task = startTask(sessionID, String(op.id ?? ""), op.event_summary)
              return { content: `Started ${task.id}: ${task.summary}` }
            }
            case "block": {
              const task = blockTask(sessionID, String(op.id ?? ""), op.event_summary)
              return { content: `Blocked ${task.id}: ${task.summary}` }
            }
            case "unblock": {
              const task = unblockTask(sessionID, String(op.id ?? ""), op.event_summary)
              return { content: `Unblocked ${task.id}: ${task.summary}` }
            }
            case "done": {
              const task = doneTask(sessionID, String(op.id ?? ""), op.event_summary)
              return { content: `Done ${task.id}: ${task.summary}` }
            }
            case "abandon": {
              const task = abandonTask(sessionID, String(op.id ?? ""), op.event_summary)
              return { content: `Abandoned ${task.id}: ${task.summary}` }
            }
            case "rename": {
              const task = renameTask(sessionID, String(op.id ?? ""), String(op.summary ?? ""))
              return { content: `Renamed ${task.id}: ${task.summary}` }
            }
            default:
              return { content: `Unknown task action "${action}". Use one of: create, list, get, start, block, unblock, done, abandon, rename.` }
          }
        } catch (error) {
          return { content: `Task error: ${String(error)}` }
        }
      },
    },
  ]

  // Remote Viewing (dual-mind) tool — only when a generate API is available.
  if (ctx) {
    tools.push({
      name: "rv_session",
      description:
        "Run a Remote Viewing (dual-mind) session. A Subconscious Engine emits raw sensory 'bits' for a TARGET stimulus and a Conscious Engine filters/qualifies them. Returns the iteration log and a final composite description. Use for impressionistic target description without identifying objects.",
      input: {
        type: "object",
        properties: {
          coordinate: {
            type: "string",
            description: "Session coordinate / target identifier (e.g. '4892-1045'). Optional.",
          },
          iterations: {
            type: "integer",
            description: "Number of TARGET pulls (default 4, max 7).",
            default: 4,
          },
        },
      },
      execute: async (input) => {
        const coordinate = String(input.coordinate ?? "TARGET")
        const iterations = Number(input.iterations ?? 4)
        const result = await runRemoteViewing(
          async (prompt: string) => {
            const out = await ctx.generate.text({ prompt })
            return String((out as { text?: string; data?: { text?: string } }).text ?? (out as { data?: { text?: string } }).data?.text ?? "")
          },
          coordinate,
          iterations,
        )
        const lines: string[] = []
        lines.push(`## Remote Viewing Session — ${result.coordinate}`)
        lines.push(`Iterations: ${result.iterations}`)
        lines.push("")
        for (const it of result.log) {
          lines.push(`### Iteration ${it.iteration}`)
          lines.push(`Bits: ${it.bits}`)
          lines.push(it.conscious)
          lines.push("")
        }
        lines.push("## Final Summary")
        lines.push(result.summary)
        return { content: lines.join("\n") }
      },
    })
  }

  return tools.map((tool) => ({ ...tool, options: { codemode: false as const } }))
}
