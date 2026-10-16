/**
 * Elitza Brain — tools.
 *
 * 1:1 port of the full tool surface of legacy `tools/brain_tools.py`,
 * registered through the OpenCode plugin tool registry so Elitza can
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

// The promise-API tool shape: execute returns a Promise.
export interface BrainToolInfo {
  name: string
  description: string
  input: { type: "object"; properties: Record<string, unknown>; required?: string[] }
  execute: (input: Record<string, any>) => Promise<{ content: string }>
  options?: { codemode: boolean }
}

export function makeBrainTools(): BrainToolInfo[] {
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
  ]
  return tools.map((tool) => ({ ...tool, options: { codemode: false as const } }))
}
