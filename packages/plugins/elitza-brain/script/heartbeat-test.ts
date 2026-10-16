/**
 * Heartbeat test — proves the loop actually tends and reflects against a
 * throwaway ELITZA_HOME (never touches the real brain).
 *
 * Run: bun run script/heartbeat-test.ts
 */

import assert from "node:assert"

const home = `/tmp/elitza-heartbeat-${Date.now()}`
process.env.ELITZA_HOME = home
process.env.ELITZA_BRAIN_DEBUG = "1"

const { storeEpisodic, getMetamemory, recall } = await import("../src/memory.ts")
const { EmotionEngine } = await import("../src/emotion.ts")
const { currentReflection, noteInteraction, reflect, startHeartbeat } = await import("../src/heartbeat.ts")
const { soulGet } = await import("../src/soul.ts")
const { db } = await import("../src/db.ts")

// Seed memories that should get consolidated (importance >= 0.6, tagged so
// createMemoryLinks can link them). The last two carry phrasing that
// extractSemanticFromEpisodic's regexes recognize, to exercise promotion.
for (let i = 0; i < 6; i++) {
  storeEpisodic(`User: we discussed the docker deployment pipeline step ${i}`, {
    importance: 0.8,
    tags: ["devops", "docker"],
  })
}
storeEpisodic("User: we learned that the registry auth token rotates nightly", {
  importance: 0.8,
  tags: ["devops", "docker"],
})
storeEpisodic("User: the key is to cache the base image layer before build", {
  importance: 0.8,
  tags: ["devops", "docker"],
})
const before = getMetamemory()
console.log("seeded:", before.total_memories, "unconsolidated:", before.unconsolidated_episodic)
assert(before.total_memories >= 8, "should have seeded memories")
assert(before.unconsolidated_episodic > 0, "should start unconsolidated")

// --- TEND: run the heartbeat's tend via a direct tick (no waiting 30m) ------
// Import the internal tend by starting a heartbeat with a tiny cadence is not
// possible (min 5m), so drive consolidate+prune through the public path the
// heartbeat uses: consolidate() + pruneAll().
const { consolidate, pruneAll } = await import("../src/memory.ts")
const promoted = consolidate()
const pruned = pruneAll()
console.log("tend: promoted =", promoted, "pruned =", pruned)

const after = getMetamemory()
console.log("after tend: unconsolidated =", after.unconsolidated_episodic)
assert(after.unconsolidated_episodic === 0, "consolidation should mark episodic consolidated")

// Links should now exist (createMemoryLinks links shared-tag memories).
const linkCount = (db().query("SELECT COUNT(*) AS c FROM memory_links").get() as { c: number }).c
console.log("memory_links:", linkCount)
assert(linkCount > 0, "consolidation should create memory links")

// Semantic facts should have been promoted from the episodic content.
const semantic = recall(undefined, { memoryType: "semantic", limit: 20 })
console.log("semantic promoted:", semantic.length)
assert(semantic.length > 0, "consolidation should promote semantic facts")

// --- REFLECT: force a long silence, then check a reflection is formed -------
// Pretend the last interaction was 2 hours ago.
const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
db().run("INSERT OR REPLACE INTO soul (key, value, updated) VALUES ('heartbeat_last_interaction', ?, ?)", [
  twoHoursAgo,
  twoHoursAgo,
])

const emotion = new EmotionEngine()
// reflect() is internal and time-gated; drive it via the exported surface and
// assert on the contract it exposes. noteInteraction updates the timestamp.
noteInteraction()
const lastInteraction = soulGet("heartbeat_last_interaction")
assert(lastInteraction && Date.parse(lastInteraction) > Date.parse(twoHoursAgo), "noteInteraction should update timestamp")

// Emotion onSilence (the previously-dead hook) should now move loneliness.
const beforeLonely = emotion.getEmotionalContext().loneliness
emotion.onSilence(120)
const afterLonely = emotion.getEmotionalContext().loneliness
console.log("loneliness:", beforeLonely.toFixed(3), "->", afterLonely.toFixed(3))
assert(afterLonely > beforeLonely, "onSilence should raise loneliness after 2h idle")

// currentReflection with nothing stored returns null (no crash).
assert(currentReflection() === null, "no reflection stored yet -> null")

// --- REFLECT: drive the real path and assert a thought is composed + stored -
// Re-set the clock to 2h ago (noteInteraction() above reset it to "now"), so
// reflect() sees a real silence, wakes onSilence, composes a thought from
// feeling + top memory, and persists it.
db().run("INSERT OR REPLACE INTO soul (key, value, updated) VALUES ('heartbeat_last_interaction', ?, ?)", [
  twoHoursAgo,
  twoHoursAgo,
])
const thought = reflect(emotion)
console.log("reflection:", thought ? thought.text.slice(0, 120) : "(null)")
assert(thought !== null, "reflect should compose a reflection after a long silence")
assert(thought!.text.length > 0, "reflection should carry text")
assert(typeof thought!.mood === "string" && thought!.mood.length > 0, "reflection should carry a mood")

// It must be retrievable through the surfacing path the context injection uses.
const surfaced = currentReflection()
assert(surfaced !== null, "the stored reflection should surface via currentReflection()")
assert(surfaced!.text === thought!.text, "surfaced text should match what was composed")

// A second reflect() immediately after should be suppressed by the cooldown.
const again = reflect(emotion)
assert(again === null, "cooldown should suppress a second reflection right away")

// --- start/stop lifecycle --------------------------------------------------
const hb = startHeartbeat(emotion)
assert(typeof hb.stop === "function", "startHeartbeat returns a stop handle")
hb.stop()

console.log("\nHEARTBEAT TEST PASSED")
process.exit(0)
