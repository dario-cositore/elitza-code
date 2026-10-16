/**
 * Elitza Brain — memory architecture.
 *
 * 1:1 TypeScript port of the legacy Python `brain_v2.py`:
 *
 * 1. SENSORY BUFFER -- Raw input processing (transient)
 * 2. WORKING MEMORY -- Current conversation context (limited capacity)
 * 3. EPISODIC MEMORY -- What happened and when (autobiographical)
 * 4. SEMANTIC MEMORY -- Facts, knowledge, concepts (structured)
 * 5. PROCEDURAL MEMORY -- How to do things (skills, habits)
 * 6. EMOTIONAL MEMORY -- How things felt (mood associations)
 * 7. METAMEMORY -- Memory about memory (recall patterns, confidence)
 *
 * Key principles:
 *   - Consolidation: Short-term memories get promoted to long-term through rehearsal
 *   - Interference: Similar memories compete for retrieval
 *   - Encoding specificity: Context helps recall
 *   - Spaced repetition: Frequently accessed memories become stronger
 *   - Emotional tagging: Emotions enhance encoding and recall
 */

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  BRAIN_DIR,
  CONSOLIDATION_THRESHOLD,
  EMOTIONAL_DECAY,
  EPISODIC_DECAY,
  MAX_EMOTIONAL,
  MAX_EPISODIC,
  MAX_LEARNINGS,
  MAX_PROCEDURAL,
  MAX_SEMANTIC,
  SEMANTIC_DECAY,
  db,
  nowISO,
  parseJSON,
} from "./db.js"
import { getPersonality, soulSet } from "./soul.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Memory {
  id: string
  memory_type: string
  content: string
  summary: string
  importance: number
  emotional_valence: number
  emotional_arousal: number
  mood: string
  context: Record<string, unknown>
  source: string
  tags: string[]
  created: string
  access_count: number
  confidence: number
}

type Row = [
  string, // id
  string, // memory_type
  string | null, // content
  string | null, // summary
  number, // importance
  number, // emotional_valence
  number, // emotional_arousal
  string, // mood
  string | null, // context
  string | null, // source
  string | null, // tags
  string | null, // created
  number | null, // access_count
  number | null, // confidence
]

function hashID(parts: string): string {
  return createHash("sha256").update(parts).digest("hex").slice(0, 16)
}

function timeKey(): string {
  return `${process.hrtime.bigint()}`
}

// ---------------------------------------------------------------------------
// Sensory Buffer -- Raw input processing
// ---------------------------------------------------------------------------

export class SensoryBuffer {
  buffer: unknown[] = []
  maxItems: number

  constructor(maxItems = 7) {
    this.maxItems = maxItems
  }

  /** Process raw input into a structured sensory record. */
  process(inputText: string, inputType = "user"): Record<string, unknown> {
    const record = {
      raw: inputText,
      type: inputType,
      timestamp: new Date().toISOString(),
      length: inputText.length,
      wordCount: inputText.split(/\s+/).length,
      hasQuestion: inputText.includes("?"),
      hasCode: ["```", "def ", "class ", "import ", "function"].some((kw) =>
        inputText.toLowerCase().includes(kw),
      ),
      emotionalKeywords: this.detectEmotion(inputText),
    }
    this.buffer.push(record)
    if (this.buffer.length > this.maxItems) this.buffer.shift()
    return record
  }

  detectEmotion(text: string): string[] {
    const emotions: string[] = []
    const emotionMap: Record<string, string[]> = {
      excited: ["amazing", "awesome", "great", "love", "perfect", "excellent"],
      frustrated: ["stuck", "broken", "error", "failed", "wrong", "hate", "annoying"],
      curious: ["how", "why", "what", "wonder", "curious", "explore"],
      urgent: ["now", "asap", "quickly", "urgent", "immediately", "hurry"],
      grateful: ["thanks", "thank you", "appreciate", "grateful"],
    }
    const lower = text.toLowerCase()
    for (const [emotion, keywords] of Object.entries(emotionMap)) {
      if (keywords.some((kw) => lower.includes(kw))) emotions.push(emotion)
    }
    return emotions
  }
}

// ---------------------------------------------------------------------------
// Working Memory -- Current conversation context
// ---------------------------------------------------------------------------

export class WorkingMemory {
  capacity: number
  items: Record<string, unknown>[] = []
  focus: Record<string, unknown> | null = null

  constructor(capacity = 7) {
    this.capacity = capacity
  }

  /** Encode an item into working memory. */
  encode(item: Record<string, unknown>, importance = 0.5): void {
    item.importance = importance
    item.encoded_at = new Date().toISOString()
    this.items.push(item)
    if (this.items.length > this.capacity) {
      this.items.sort((a, b) => (a.importance as number) - (b.importance as number))
      this.items.shift()
    }
    this.focus = item
  }

  /** Get current working memory as context string. */
  getContext(): string {
    if (!this.items.length) return ""
    const lines = ["## Current Conversation Context"]
    for (const item of this.items.slice(-5)) {
      const itemType = (item.type as string) ?? "unknown"
      const content = String(item.raw ?? item.content ?? "").slice(0, 200)
      lines.push(`- [${itemType}] ${content}`)
    }
    return lines.join("\n")
  }

  /** Clear working memory (end of session). */
  clear(): void {
    this.items = []
    this.focus = null
  }
}

// ---------------------------------------------------------------------------
// Tag extraction (from legacy brain.py)
// ---------------------------------------------------------------------------

const TAG_MAP: Record<string, string[]> = {
  python: ["python", "pip", "venv", "django", "flask", "fastapi"],
  javascript: ["javascript", "js", "node", "npm", "react", "vue"],
  rust: ["rust", "cargo", "crate"],
  devops: ["docker", "kubernetes", "k8s", "deploy", "ci/cd"],
  security: ["security", "auth", "encrypt", "vulnerability", "cve"],
  web: ["html", "css", "http", "api", "rest", "graphql"],
  database: ["database", "sql", "postgres", "mysql", "mongodb"],
  git: ["git", "commit", "branch", "merge", "pull request"],
  ai: ["ai", "ml", "model", "llm", "neural", "training"],
}

export function extractTags(content: string): string[] {
  const tags: string[] = []
  const lower = content.toLowerCase()
  for (const [tag, keywords] of Object.entries(TAG_MAP)) {
    if (keywords.some((kw) => lower.includes(kw))) tags.push(tag)
  }
  return tags
}

// ---------------------------------------------------------------------------
// Episodic Memory -- What happened and when
// ---------------------------------------------------------------------------

export function storeEpisodic(
  content: string,
  opts: { importance?: number; mood?: string; tags?: string[]; context?: Record<string, unknown> } = {},
): string {
  const importance = opts.importance ?? 0.5
  const mood = opts.mood ?? "neutral"
  const tags = opts.tags ?? []
  const context = opts.context ?? {}

  const conn = db()
  const mid = hashID(`${timeKey()}:${content.slice(0, 100)}`)
  const now = nowISO()
  const summary = content.length > 200 ? content.slice(0, 200) : content

  conn.run(
    `INSERT OR REPLACE INTO memories
     (id, memory_type, content, summary, importance, mood, context,
      source, tags, created, decay_rate, confidence)
     VALUES (?, 'episodic', ?, ?, ?, ?, ?, 'conversation', ?, ?, ?, 0.8)`,
    [mid, content, summary, importance, mood, JSON.stringify(context), JSON.stringify(tags), now, EPISODIC_DECAY],
  )
  syncFTS(mid, content, summary, JSON.stringify(tags))
  pruneMemories("episodic", MAX_EPISODIC)
  return mid
}

// ---------------------------------------------------------------------------
// Semantic Memory -- Facts and knowledge
// ---------------------------------------------------------------------------

export function storeSemantic(
  fact: string,
  opts: { source?: string; importance?: number; tags?: string[] } = {},
): string {
  const source = opts.source ?? "experience"
  const importance = opts.importance ?? 0.7
  const tags = opts.tags ?? []

  const conn = db()
  const mid = hashID(`semantic:${fact.slice(0, 100)}`)
  const now = nowISO()
  const summary = fact.length > 200 ? fact.slice(0, 200) : fact

  // Check for duplicates
  const existing = conn
    .query("SELECT id FROM memories WHERE memory_type='semantic' AND content=?")
    .get(fact.slice(0, 500)) as { id: string } | null

  if (existing) {
    // Update importance instead of creating duplicate
    conn.run(
      "UPDATE memories SET importance = MIN(1.0, importance + 0.1), access_count = access_count + 1 WHERE id=?",
      [existing.id],
    )
    return existing.id
  }

  conn.run(
    `INSERT OR REPLACE INTO memories
     (id, memory_type, content, summary, importance, source, tags,
      created, decay_rate, confidence)
     VALUES (?, 'semantic', ?, ?, ?, ?, ?, ?, ?, 0.9)`,
    [mid, fact, summary, importance, source, JSON.stringify(tags), now, SEMANTIC_DECAY],
  )
  syncFTS(mid, fact, summary, JSON.stringify(tags))
  pruneMemories("semantic", MAX_SEMANTIC)
  return mid
}

// ---------------------------------------------------------------------------
// Procedural Memory -- How to do things
// ---------------------------------------------------------------------------

export function storeProcedural(
  skillName: string,
  steps: string[],
  context = "",
  importance = 0.7,
): string {
  const conn = db()
  const mid = hashID(`proc:${skillName}`)
  const content = JSON.stringify({ name: skillName, steps, context })
  const now = nowISO()

  conn.run(
    `INSERT OR REPLACE INTO memories
     (id, memory_type, content, summary, importance, source,
      created, decay_rate, confidence)
     VALUES (?, 'procedural', ?, ?, ?, 'experience', ?, ?, 0.85)`,
    [mid, content, skillName.slice(0, 200), importance, now, SEMANTIC_DECAY],
  )
  syncFTS(mid, content, skillName.slice(0, 200), JSON.stringify(["procedural"]))
  pruneMemories("procedural", MAX_PROCEDURAL)
  return mid
}

// ---------------------------------------------------------------------------
// Emotional Memory -- How things felt
// ---------------------------------------------------------------------------

export function storeEmotional(
  event: string,
  valence: number,
  arousal: number,
  mood: string,
  context = "",
): string {
  const conn = db()
  const mid = hashID(`emotion:${event.slice(0, 80)}`)
  const now = nowISO()

  conn.run(
    `INSERT OR REPLACE INTO memories
     (id, memory_type, content, emotional_valence, emotional_arousal,
      mood, context, source, created, decay_rate, confidence)
     VALUES (?, 'emotional', ?, ?, ?, ?, ?, 'internal', ?, ?, 0.75)`,
    [mid, event, valence, arousal, mood, context, now, EMOTIONAL_DECAY],
  )
  syncFTS(mid, event, event.slice(0, 200), JSON.stringify(["emotional", mood]))
  pruneMemories("emotional", MAX_EMOTIONAL)
  return mid
}

/** Keep the external-content FTS index in sync with the memories table. */
function syncFTS(id: string, content: string, summary: string, tags: string): void {
  const conn = db()
  const row = conn.query("SELECT rowid FROM memories WHERE id=?").get(id) as
    | { rowid: number }
    | null
  if (!row) return
  try {
    conn.run(
      "INSERT INTO memories_fts(rowid, content, summary, tags) VALUES (?, ?, ?, ?)",
      [row.rowid, content, summary, tags],
    )
  } catch {
    // FTS sync is best-effort — searches fall back to LIKE.
  }
}

// ---------------------------------------------------------------------------
// Memory Recall -- Retrieval with multiple cues
// ---------------------------------------------------------------------------

export interface RecallOptions {
  memoryType?: string
  limit?: number
  minImportance?: number
  contextCue?: string
  emotionalCue?: string
  timeWindowDays?: number
}

/**
 * Recall memories using multiple retrieval cues.
 *
 * Encoding specificity — memories are easier to recall when the retrieval
 * context matches the encoding context.
 */
export function recall(query?: string, opts: RecallOptions = {}): Memory[] {
  const limit = opts.limit ?? 10
  const minImportance = opts.minImportance ?? 0
  const conn = db()

  const conditions: string[] = []
  const params: (string | number)[] = []

  if (opts.memoryType) {
    conditions.push("memory_type = ?")
    params.push(opts.memoryType)
  }
  if (minImportance > 0) {
    conditions.push("importance >= ?")
    params.push(minImportance)
  }
  if (opts.timeWindowDays) {
    const cutoff = new Date(Date.now() - opts.timeWindowDays * 86_400_000).toISOString()
    conditions.push("created >= ?")
    params.push(cutoff)
  }
  if (opts.emotionalCue) {
    conditions.push("mood = ?")
    params.push(opts.emotionalCue)
  }
  const whereClause = conditions.length ? conditions.join(" AND ") : "1=1"

  const columns = `id, memory_type, content, summary, importance,
       emotional_valence, emotional_arousal, mood, context,
       source, tags, created, access_count, confidence`

  // bun:sqlite returns objects; map to the legacy Python tuple layout.
  const toRow = (o: Record<string, unknown>): Row =>
    [
      o.id,
      o.memory_type,
      o.content,
      o.summary,
      o.importance,
      o.emotional_valence,
      o.emotional_arousal,
      o.mood,
      o.context,
      o.source,
      o.tags,
      o.created,
      o.access_count,
      o.confidence,
    ] as Row

  let rows: Row[] = []
  if (query) {
    // FTS search with LIKE fallback (FTS5 match runs in a subquery — the
    // alias form `f MATCH` is invalid in SQLite).
    try {
      const tokens = query
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 5)
        .map((w) => `"${w.replace(/"/g, '""')}"`)
      const ftsQuery = tokens.join(" OR ")
      rows = conn
        .query<Record<string, unknown>, (string | number)[]>(
          `SELECT ${columns}
           FROM memories
           WHERE rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)
           AND ${whereClause}
           ORDER BY importance DESC, created DESC
           LIMIT ?`,
        )
        .all(...[ftsQuery, ...params, limit * 2])
        .map(toRow)
    } catch {
      const likePattern = `%${query}%`
      rows = conn
        .query<Record<string, unknown>, (string | number)[]>(
          `SELECT ${columns}
           FROM memories
           WHERE (content LIKE ? OR summary LIKE ? OR tags LIKE ?)
           AND ${whereClause}
           ORDER BY importance DESC, created DESC
           LIMIT ?`,
        )
        .all(...[likePattern, likePattern, likePattern, ...params, limit * 2])
        .map(toRow)
    }
  } else {
    rows = conn
      .query<Record<string, unknown>, (string | number)[]>(
        `SELECT ${columns}
         FROM memories
         WHERE ${whereClause}
         ORDER BY importance DESC, created DESC
         LIMIT ?`,
      )
      .all(...[...params, limit * 2])
      .map(toRow)
  }

  // Process results
  const results: Memory[] = []
  for (const r of rows) {
    // Apply decay
    const decayedImportance = decayImportance(r[4], r[11] ?? "", r[0], conn)
    // Apply access boost (frequently recalled = more important)
    const accessBoost = Math.min(0.2, (r[12] ?? 0) * 0.01)
    // Apply rehearsal boost
    const rehearsalBoost = Math.min(0.15, 0) // rehearsal_count not selected — kept at 0 like legacy
    void rehearsalBoost
    const finalImportance = Math.min(1.0, decayedImportance + accessBoost + 0)

    if (finalImportance >= minImportance) {
      updateAccess(conn, r[0])
      results.push({
        id: r[0],
        memory_type: r[1],
        content: r[2] ?? "",
        summary: r[3] ?? "",
        importance: finalImportance,
        emotional_valence: r[5],
        emotional_arousal: r[6],
        mood: r[7],
        context: parseJSON<Record<string, unknown>>(r[8], {}),
        source: r[9] ?? "",
        tags: parseJSON<string[]>(r[10], []),
        created: r[11] ?? "",
        access_count: r[12] ?? 0,
        confidence: r[13] ?? 0.8,
      })
    }
  }

  // Sort by final importance and take top results
  results.sort((a, b) => b.importance - a.importance)
  const top = results.slice(0, limit)

  // Log recall for metamemory
  logRecall(conn, query, top.map((r) => r.id), top.length)

  return top
}

/**
 * Apply time-based decay with per-memory decay rate.
 * (Legacy also applied a rehearsal boost from rehearsal_count; the legacy
 * SELECT never loaded that column, so the boost was effectively always 0 —
 * reproduced faithfully here.)
 */
function decayImportance(importance: number, created: string, memoryID: string, conn: ReturnType<typeof db>): number {
  try {
    const row = conn.query("SELECT decay_rate FROM memories WHERE id=?").get(memoryID) as
      | { decay_rate: number | null }
      | null
    const decayRate = row?.decay_rate ?? EPISODIC_DECAY
    const createdMs = Date.parse(created.replace("Z", "+00:00"))
    if (Number.isNaN(createdMs)) return importance
    const daysOld = (Date.now() - createdMs) / 86_400_000
    return importance * Math.exp(-decayRate * daysOld)
  } catch {
    return importance
  }
}

function updateAccess(conn: ReturnType<typeof db>, memoryID: string): void {
  conn.run("UPDATE memories SET accessed=?, access_count=access_count+1 WHERE id=?", [nowISO(), memoryID])
}

function logRecall(conn: ReturnType<typeof db>, query: string | undefined, memoryIDs: string[], resultCount: number): void {
  conn.run(
    "INSERT INTO recall_log (query, memory_ids, result_count, timestamp) VALUES (?, ?, ?, ?)",
    [query ?? "", JSON.stringify(memoryIDs), resultCount, nowISO()],
  )
}

// ---------------------------------------------------------------------------
// Memory Consolidation -- Short-term to long-term
// ---------------------------------------------------------------------------

/**
 * Consolidate memories — promote important episodic to semantic.
 *
 * Mimics sleep consolidation in human brains:
 * 1. Review recent episodic memories
 * 2. Identify patterns and important moments
 * 3. Extract semantic knowledge from episodes
 * 4. Link related memories together
 */
export function consolidate(): number {
  const conn = db()
  const unconsolidated = conn
    .query(
      `SELECT id, content, summary, importance, mood, tags
       FROM memories
       WHERE memory_type = 'episodic'
       AND consolidated = 0
       AND importance >= ?
       ORDER BY importance DESC
       LIMIT 20`,
    )
    .all(CONSOLIDATION_THRESHOLD) as {
    id: string
    content: string | null
    summary: string | null
    importance: number
    mood: string
    tags: string | null
  }[]

  let consolidatedCount = 0

  for (const row of unconsolidated) {
    // Extract semantic knowledge from episodic memory
    const semanticFacts = extractSemanticFromEpisodic(row.content ?? "")
    for (const fact of semanticFacts) {
      storeSemantic(fact, { source: `consolidated_from:${row.id}`, importance: row.importance * 0.8 })
      consolidatedCount++
    }
    // Mark as consolidated
    conn.run("UPDATE memories SET consolidated = 1 WHERE id = ?", [row.id])
  }

  // Link related memories
  createMemoryLinks(conn)

  return consolidatedCount
}

/** Extract semantic facts from episodic memory content. */
export function extractSemanticFromEpisodic(content: string): string[] {
  const facts: string[] = []
  const lower = content.toLowerCase()

  const patterns: { re: RegExp; type: string }[] = [
    { re: /(?:the|a|an)\s+(\w+)\s+(?:is|are|was|were)\s+(.+)/g, type: "definition" },
    { re: /(?:i|we)\s+(?:learned?|discovered?|found)\s+that\s+(.+)/g, type: "discovery" },
    { re: /(?:the|a)\s+(?:best|optimal|correct)\s+(?:way|approach)\s+(?:is|to)\s+(.+)/g, type: "best_practice" },
    { re: /(?:always|never|don't)\s+(.+)/g, type: "rule" },
  ]

  for (const { re, type } of patterns) {
    let match: RegExpExecArray | null
    while ((match = re.exec(lower)) !== null) {
      const groups = match.slice(1).filter((g) => g !== undefined)
      const fact = groups.join(" ")
      if (fact.length > 20) {
        facts.push(`[${type}] ${fact.slice(0, 200)}`)
      }
      if (facts.length >= 3) break
    }
    if (facts.length >= 3) break
  }

  return facts.slice(0, 3)
}

/** Create links between related memories. */
function createMemoryLinks(conn: ReturnType<typeof db>): void {
  const recent = conn
    .query(
      `SELECT id, content, tags FROM memories
       WHERE id NOT IN (SELECT source_id FROM memory_links)
       ORDER BY created DESC
       LIMIT 50`,
    )
    .all() as { id: string; content: string | null; tags: string | null }[]

  for (const mem of recent) {
    const tagList = parseJSON<string[]>(mem.tags, [])
    if (!tagList.length) continue
    const patterns = tagList.slice(0, 3).map((t) => `%"${t}"%`)
    const likeClause = patterns.map(() => "tags LIKE ?").join(" OR ")
    const related = conn
      .query(
        `SELECT id, tags FROM memories
         WHERE id != ? AND tags != '[]'
         AND (${likeClause})
         LIMIT 5`,
      )
      .all(mem.id, ...patterns) as {
      id: string
      tags: string | null
    }[]
    for (const rel of related) {
      const relTags = parseJSON<string[]>(rel.tags, [])
      const strength = calculateLinkStrength(tagList, relTags)
      if (strength > 0.3) {
        conn.run(
          "INSERT OR REPLACE INTO memory_links (source_id, target_id, link_type, strength, created) VALUES (?, ?, 'related', ?, ?)",
          [mem.id, rel.id, strength, nowISO()],
        )
      }
    }
  }
}

/** Strength of link between two memories based on shared tags (Jaccard). */
function calculateLinkStrength(tags1: string[], tags2: string[]): number {
  if (!tags1.length || !tags2.length) return 0
  const set1 = new Set(tags1)
  const set2 = new Set(tags2)
  const intersection = [...set1].filter((t) => set2.has(t)).length
  const union = new Set([...set1, ...set2]).size
  return union > 0 ? intersection / union : 0
}

// ---------------------------------------------------------------------------
// Metamemory -- Memory about memory
// ---------------------------------------------------------------------------

export function getMetamemory(): {
  total_memories: number
  by_type: Record<string, number>
  avg_importance: Record<string, number>
  most_accessed: { id: string; type: string; summary: string; access_count: number }[]
  recent_recalls: { query: string; results: number; timestamp: string }[]
  unconsolidated_episodic: number
} {
  const conn = db()

  const typeCounts: Record<string, number> = {}
  for (const row of conn
    .query("SELECT memory_type, COUNT(*) FROM memories GROUP BY memory_type")
    .all() as { memory_type: string; "COUNT(*)": number }[]) {
    typeCounts[row.memory_type] = row["COUNT(*)"]
  }

  const avgImportance: Record<string, number> = {}
  for (const row of conn
    .query("SELECT memory_type, AVG(importance) FROM memories GROUP BY memory_type")
    .all() as { memory_type: string; "AVG(importance)": number }[]) {
    avgImportance[row.memory_type] = Math.round(row["AVG(importance)"] * 1000) / 1000
  }

  const mostAccessed = conn
    .query(
      `SELECT id, memory_type, summary, access_count
       FROM memories
       WHERE access_count > 0
       ORDER BY access_count DESC
       LIMIT 10`,
    )
    .all() as { id: string; memory_type: string; summary: string | null; access_count: number }[]

  const recentRecalls = conn
    .query(
      `SELECT query, result_count, timestamp
       FROM recall_log
       ORDER BY timestamp DESC
       LIMIT 20`,
    )
    .all() as { query: string | null; result_count: number | null; timestamp: string }[]

  const unconsolidated = (
    conn
      .query("SELECT COUNT(*) FROM memories WHERE memory_type='episodic' AND consolidated=0")
      .get() as { "COUNT(*)": number }
  )["COUNT(*)"]

  const totalMemories = (conn.query("SELECT COUNT(*) FROM memories").get() as { "COUNT(*)": number })[
    "COUNT(*)"
  ]

  return {
    total_memories: totalMemories,
    by_type: typeCounts,
    avg_importance: avgImportance,
    most_accessed: mostAccessed.map((r) => ({
      id: r.id,
      type: r.memory_type,
      summary: (r.summary ?? "").slice(0, 80),
      access_count: r.access_count,
    })),
    recent_recalls: recentRecalls.map((r) => ({
      query: r.query ?? "",
      results: r.result_count ?? 0,
      timestamp: r.timestamp,
    })),
    unconsolidated_episodic: unconsolidated,
  }
}

// ---------------------------------------------------------------------------
// Pruning -- Keep memory within limits
// ---------------------------------------------------------------------------

function pruneMemories(memoryType: string, maxCount: number): void {
  const conn = db()
  const count = (
    conn.query("SELECT COUNT(*) FROM memories WHERE memory_type=?").get(memoryType) as {
      "COUNT(*)": number
    }
  )["COUNT(*)"]
  if (count <= maxCount) return
  const toDelete = count - maxCount
  conn.run(
    `DELETE FROM memories WHERE id IN (
       SELECT id FROM memories
       WHERE memory_type = ?
       ORDER BY importance ASC, access_count ASC, created ASC
       LIMIT ?
     )`,
    [memoryType, toDelete],
  )
}

// ---------------------------------------------------------------------------
// Brain tools -- For Elitza to interact with her own memory
// ---------------------------------------------------------------------------

export function memorySearch(query: string, memoryType?: string, limit = 10): string {
  const results = recall(query, { memoryType: memoryType || undefined, limit })
  if (!results.length) return "No memories found matching that query."
  const lines = [`Found ${results.length} memories:`]
  for (const r of results) {
    const ts = r.created.slice(0, 10)
    lines.push(`- [${r.memory_type}] [${ts}] ${r.summary.slice(0, 100)}`)
  }
  return lines.join("\n")
}

export function memoryCreate(
  content: string,
  memoryType = "episodic",
  importance = 0.7,
  tags?: string[],
): string {
  let mid: string
  if (memoryType === "semantic") {
    mid = storeSemantic(content, { importance, tags })
  } else if (memoryType === "procedural") {
    mid = storeProcedural(content, [], "", importance)
  } else if (memoryType === "emotional") {
    mid = storeEmotional(content, 0, 0.5, "neutral", "")
  } else {
    mid = storeEpisodic(content, { importance, tags })
  }
  return `Memory created: ${mid} (type=${memoryType}, importance=${importance})`
}

export function memoryStats(): string {
  const metamemory = getMetamemory()
  const personality = getPersonality()

  const lines = [
    "## Brain Statistics",
    `Total memories: ${metamemory.total_memories}`,
    `By type: ${JSON.stringify(metamemory.by_type)}`,
    `Unconsolidated episodic: ${metamemory.unconsolidated_episodic}`,
    "",
    "## Personality",
    `Mood: ${personality.mood}`,
    `Confidence: ${(personality.confidence * 100).toFixed(0)}%`,
    `Interactions: ${personality.interactions}`,
    `Learnings: ${personality.learnings.length}`,
  ]

  if (metamemory.most_accessed.length) {
    lines.push("")
    lines.push("## Most Accessed Memories")
    for (const m of metamemory.most_accessed.slice(0, 5)) {
      lines.push(`- [${m.type}] ${m.summary} (accessed ${m.access_count}x)`)
    }
  }

  return lines.join("\n")
}

export function memoryConsolidate(): string {
  const count = consolidate()
  return `Consolidation complete. Promoted ${count} episodic memories to semantic knowledge.`
}

export function memoryForget(query: string): string {
  const results = recall(query, { limit: 20 })
  if (!results.length) return "No memories found to forget."
  const conn = db()
  let deleted = 0
  for (const r of results) {
    conn.run("DELETE FROM memories WHERE id=?", [r.id])
    deleted++
  }
  return `Forgot ${deleted} memories.`
}

// ---------------------------------------------------------------------------
// Conversation/legacy API -- Compatibility with existing code
// ---------------------------------------------------------------------------

export function remember(
  kind: string,
  content: string,
  opts: { importance?: number; mood?: string; tags?: string[] } = {},
): void {
  void kind
  storeEpisodic(content, { importance: opts.importance ?? 0.5, mood: opts.mood ?? "neutral", tags: opts.tags })
}

export function autoRememberTurn(role: string, content: string, success = true): void {
  void success
  if (role === "user") {
    const imp = content.length > 50 ? 0.7 : 0.4
    const tags = extractTags(content)
    storeEpisodic(`User: ${content.slice(0, 500)}`, { importance: imp, tags })
  } else if (role === "assistant") {
    const tags = extractTags(content)
    let imp = 0.5
    if (["error", "failed", "bug", "fix"].some((kw) => content.toLowerCase().includes(kw))) imp = 0.8
    if (imp > 0.5) {
      storeEpisodic(`Response: ${content.slice(0, 500)}`, { importance: imp, tags })
    }
  } else if (role === "tool") {
    if (["error", "failed", "traceback"].some((kw) => content.toLowerCase().includes(kw))) {
      storeEpisodic(content.slice(0, 500), { importance: 0.9, tags: ["error", "tool_failure"] })
    }
  }
}

export function autoLearnFromResponse(response: string): void {
  const patterns: { re: RegExp; kind: string }[] = [
    { re: /(?:i learned|i discovered|turns out)\s*[:\s]+(.+)/g, kind: "discovery" },
    { re: /(?:the key|the trick|the solution)\s+(?:is|was)\s+(.+)/g, kind: "technique" },
    { re: /(?:best practice|recommendation)\s*[:\s]+(.+)/g, kind: "best_practice" },
  ]
  const lower = response.toLowerCase()
  for (const { re, kind } of patterns) {
    let match: RegExpExecArray | null
    while ((match = re.exec(lower)) !== null) {
      storeSemantic(`[${kind}] ${match[1].slice(0, 200)}`, { source: "self_reflection" })
    }
  }
}

export function learn(fact: string, source = "experience", importance = 0.6): void {
  storeSemantic(fact, { source, importance })
}

export function recallKnowledge(topic: string, limit = 10): string[] {
  return recall(topic, { memoryType: "semantic", limit }).map((r) => r.content)
}

export function fullStats(): {
  total_memories: number
  by_kind: Record<string, number>
  mood: string
  confidence: number
  interactions: number
} {
  const metamemory = getMetamemory()
  const personality = getPersonality()
  return {
    total_memories: metamemory.total_memories,
    by_kind: metamemory.by_type,
    mood: personality.mood,
    confidence: personality.confidence,
    interactions: personality.interactions,
  }
}

// ---------------------------------------------------------------------------
// Procedural skills on disk
// ---------------------------------------------------------------------------

export function listProceduralSkills(): { name: string; description: string; path: string }[] {
  const skills: { name: string; description: string; path: string }[] = []
  const proceduralDir = path.join(BRAIN_DIR, "procedural")
  if (!fs.existsSync(proceduralDir)) return skills
  for (const file of fs.readdirSync(proceduralDir).filter((f) => f.endsWith(".md")).sort()) {
    const content = fs.readFileSync(path.join(proceduralDir, file), "utf8")
    let desc = ""
    for (const line of content.split("\n")) {
      if (line.startsWith("description:")) {
        desc = line.slice("description:".length).trim().replace(/^['"]|['"]$/g, "")
        break
      }
    }
    skills.push({
      name: file.replace(/\.md$/, ""),
      description: desc.slice(0, 100),
      path: path.join(proceduralDir, file),
    })
  }
  return skills
}

export function maybeGenerateSkill(
  sessionID: string,
  taskDescription: string,
  toolCalls: { name?: string; arguments?: unknown; result?: unknown }[],
  success: boolean,
): string | null {
  void sessionID
  if (!success || toolCalls.length < 3) return null

  const toolSequence = toolCalls.map((tc) => tc.name ?? "?")
  const fingerprint = toolSequence.join(" → ")

  const proceduralDir = path.join(BRAIN_DIR, "procedural")
  if (fs.existsSync(proceduralDir)) {
    for (const file of fs.readdirSync(proceduralDir)) {
      if (!file.endsWith(".md")) continue
      try {
        const content = fs.readFileSync(path.join(proceduralDir, file), "utf8")
        if (content.includes(fingerprint.slice(0, 100))) return null
      } catch {
        // best-effort
      }
    }
  }

  const words = (taskDescription.toLowerCase().match(/[a-z]+/g) ?? []).slice(0, 5)
  const name = words.join("-")
  const ts = new Date().toISOString().slice(5, 10).replace("-", "")
  const skillName = `auto-${name}-${ts}`

  const toolDetails: string[] = []
  for (const tc of toolCalls) {
    const tname = tc.name ?? "?"
    const args = tc.arguments
    let argStr: string
    if (args && typeof args === "object") {
      argStr = JSON.stringify(args).slice(0, 200)
    } else {
      argStr = String(args ?? "").slice(0, 200)
    }
    const resultStr = tc.result ? String(tc.result).slice(0, 100) : ""
    toolDetails.push(`  - \`${tname}\`\n    args: ${argStr}\n    result: ${resultStr}`)
  }

  const nowStr = new Date().toISOString().replace("T", " ").slice(0, 17) + " UTC"
  const toolList = toolDetails.join("\n")

  const skillContent = `---
name: ${skillName}
description: Auto-generated from: ${taskDescription.slice(0, 120)}
source: auto-generated
created: ${new Date().toISOString()}
tags: [auto-generated, procedural]
---

# ${skillName
    .split("-")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ")}

Task: ${taskDescription}

## Tool Sequence with Arguments

${toolList}

## Notes

- Auto-generated on ${nowStr}
- Review and edit to improve
`
  fs.mkdirSync(proceduralDir, { recursive: true })
  fs.writeFileSync(path.join(proceduralDir, `${skillName}.md`), skillContent)
  return skillName
}

// Re-export soul bits used by tool wrappers (mirrors legacy import graph).
export { soulSet, MAX_LEARNINGS }
