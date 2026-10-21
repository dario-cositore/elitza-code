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
