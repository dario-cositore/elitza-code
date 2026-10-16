/**
 * Heartbeat INTEGRATION test — the unit test drove tend/reflect by hand; this
 * proves the real interval ticks on its own, the disable flag works, and a
 * throwing brain never takes down the host.
 *
 * Run: bun run script/heartbeat-integration.ts
 */

import assert from "node:assert"

const home = `/tmp/elitza-hb-int-${Date.now()}`
process.env.ELITZA_HOME = home

const { storeEpisodic, getMetamemory } = await import("../src/memory.ts")
const { EmotionEngine } = await import("../src/emotion.ts")
const { startHeartbeat } = await import("../src/heartbeat.ts")
const { soulGet } = await import("../src/soul.ts")

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// 1. The interval fires on its own (25ms cadence, no manual driving).
// ---------------------------------------------------------------------------
for (let i = 0; i < 5; i++) {
  storeEpisodic(`User: discussed the release pipeline step ${i}`, {
    importance: 0.8,
    tags: ["release", "ci"],
  })
}
assert(getMetamemory().unconsolidated_episodic > 0, "seeded episodic should be unconsolidated")

const emotion = new EmotionEngine()
const hb = startHeartbeat(emotion, 25)

// Wait for at least 3 ticks.
await sleep(120)
hb.stop()

const lastTend = soulGet("heartbeat_last_tend")
assert(lastTend, "the interval should have run tend() and stamped heartbeat_last_tend")
assert(getMetamemory().unconsolidated_episodic === 0, "auto-tend should have consolidated on its own")
console.log("1. interval ticks on its own + auto-tends: OK")

// After stop(), no further tend should happen. Wait and confirm the stamp is
// unchanged.
const stampAfterStop = soulGet("heartbeat_last_tend")
await sleep(120)
assert(soulGet("heartbeat_last_tend") === stampAfterStop, "stop() should halt further ticks")
console.log("2. stop() halts the loop: OK")

// ---------------------------------------------------------------------------
// 2. ELITZA_HEARTBEAT=0 disables the loop entirely.
// ---------------------------------------------------------------------------
process.env.ELITZA_HEARTBEAT = "0"
const disabled = startHeartbeat(new EmotionEngine(), 25)
// If it had started, a tick would restamp heartbeat_last_tend; freeze it first.
const frozen = "2000-01-01T00:00:00.000Z"
const { soulSet } = await import("../src/soul.ts")
soulSet("heartbeat_last_tend", frozen)
await sleep(100)
disabled.stop()
assert(soulGet("heartbeat_last_tend") === frozen, "ELITZA_HEARTBEAT=0 must prevent any tick")
delete process.env.ELITZA_HEARTBEAT
console.log("3. ELITZA_HEARTBEAT=0 disables the loop: OK")

// ---------------------------------------------------------------------------
// 3. A throwing brain never kills the host — the process keeps running.
//    Point ELITZA_HOME at an unwritable path so db() throws inside tend().
// ---------------------------------------------------------------------------
const badHome = `/proc/elitza-cannot-write-here-${Date.now()}`
process.env.ELITZA_HOME = badHome
const resilient = startHeartbeat(new EmotionEngine(), 25)
await sleep(120)
resilient.stop()
// If we got here without the process dying, the try/catch held.
assert(true, "process survived a throwing brain")
console.log("4. throwing brain does not crash the host: OK")

console.log("\nHEARTBEAT INTEGRATION TEST PASSED")
process.exit(0)
