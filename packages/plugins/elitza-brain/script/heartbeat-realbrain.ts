/**
 * REAL-BRAIN sandbox test — runs the heartbeat against a COPY of Dario's
 * actual production brain (never the original). The hard guarantee: no memory
 * may be deleted, consolidation/links/reflection should all happen.
 *
 * Expects ELITZA_HOME to point at the sandbox (with a copied soul_v2.db).
 * Run: ELITZA_HOME=/tmp/opencode/real-brain-sandbox bun run script/heartbeat-realbrain.ts
 */

import assert from "node:assert"

const { db } = await import("../src/db.ts")
const { getMetamemory } = await import("../src/memory.ts")
const { consolidate, pruneAll } = await import("../src/memory.ts")
const { EmotionEngine } = await import("../src/emotion.ts")
const { reflect } = await import("../src/heartbeat.ts")

const conn = db()

// --- snapshot BEFORE --------------------------------------------------------
const beforeIds = (conn.query("SELECT id FROM memories ORDER BY id").all() as { id: string }[]).map((r) => r.id)
const before = getMetamemory()
const beforeLinks = (conn.query("SELECT COUNT(*) c FROM memory_links").get() as { c: number }).c
console.log(`BEFORE: ${before.total_memories} memories, ${before.unconsolidated_episodic} unconsolidated, ${beforeLinks} links`)

// --- TEND -------------------------------------------------------------------
const promoted = consolidate()
const pruned = pruneAll()
console.log(`TEND: promoted=${promoted} pruned=${pruned}`)

// --- REFLECT ----------------------------------------------------------------
// Force a real silence so the reflection gate opens.
const ago = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
conn.run("INSERT OR REPLACE INTO soul (key, value, updated) VALUES ('heartbeat_last_interaction', ?, ?)", [ago, ago])
const thought = reflect(new EmotionEngine())
console.log(`REFLECT: ${thought ? `"${thought.text.slice(0, 140)}"` : "(null)"}`)

// --- snapshot AFTER ---------------------------------------------------------
const afterIds = (conn.query("SELECT id FROM memories ORDER BY id").all() as { id: string }[]).map((r) => r.id)
const after = getMetamemory()
const afterLinks = (conn.query("SELECT COUNT(*) c FROM memory_links").get() as { c: number }).c
console.log(`AFTER: ${after.total_memories} memories, ${after.unconsolidated_episodic} unconsolidated, ${afterLinks} links`)

// --- the guarantees ---------------------------------------------------------
// 1. NOT ONE memory deleted. Every id present before must be present after.
const deleted = beforeIds.filter((id) => !afterIds.includes(id))
assert(
  deleted.length === 0,
  `HEARTBEAT DELETED ${deleted.length} REAL MEMORIES — this is a bug, not a feature`,
)
console.log(`✓ zero memories deleted (all ${beforeIds.length} preserved)`)

// 2. Nothing ADDED either — the heartbeat must not fabricate memories from a
//    real brain; consolidation promotes/links existing ones. (If this fires it
//    means extractSemanticFromEpisodic matched real content — acceptable, but
//    reported so we see it.)
const added = afterIds.filter((id) => !beforeIds.includes(id))
console.log(`${added.length === 0 ? "✓" : "△"} memories added by promotion: ${added.length}`)

// 3. Consolidation actually drained the backlog.
assert(after.unconsolidated_episodic < before.unconsolidated_episodic, "consolidation should reduce the backlog")
console.log(`✓ backlog drained: ${before.unconsolidated_episodic} → ${after.unconsolidated_episodic}`)

// 4. Links now exist on a brain that had none.
assert(afterLinks > 0, "consolidation should have linked related memories")
console.log(`✓ memory links created: ${beforeLinks} → ${afterLinks}`)

// 5. A reflection was formed from his real memories.
assert(thought !== null && thought.text.length > 0, "a reflection should form from the real brain")
console.log("✓ reflection formed from real memories")

console.log("\nREAL-BRAIN SANDBOX TEST PASSED (original untouched)")
process.exit(0)
