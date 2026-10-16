process.env.ELITZA_HOME = "/tmp/ebt-r2"
const { recall, storeEpisodic } = await import("../src/memory.ts")
const { db } = await import("../src/db.ts")

storeEpisodic("User: Dario asked about the docker deployment pipeline", {
  importance: 0.8,
  tags: ["devops", "docker"],
})

const conn = db()

const query = "deployment docker"
const whereClause = "1=1"
const params: (string | number)[] = []
const limit = 10
const columns = `id, memory_type, content, summary, importance,
       emotional_valence, emotional_arousal, mood, context,
       source, tags, created, access_count, confidence`

const tokens = query
  .split(/\s+/)
  .filter(Boolean)
  .slice(0, 5)
  .map((w) => `"${w.replace(/"/g, '""')}"`)
const ftsQuery = tokens.join(" OR ")
console.log("ftsQuery:", JSON.stringify(ftsQuery))

let rows: unknown[] = []
try {
  const sql = `SELECT ${columns}
           FROM memories
           WHERE rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)
           AND ${whereClause}
           ORDER BY importance DESC, created DESC
           LIMIT ?`
  rows = conn.query(sql).all(...([ftsQuery, ...params, limit * 2] as never[]))
  console.log("FTS branch rows:", rows.length)
} catch (e) {
  console.log("FTS branch THREW:", (e as Error).message)
}
console.log("first row:", rows[0] ? JSON.stringify(rows[0]).slice(0, 300) : "none")

// now the REAL recall for comparison
console.log("recall deployment docker:", recall("deployment docker").length)
