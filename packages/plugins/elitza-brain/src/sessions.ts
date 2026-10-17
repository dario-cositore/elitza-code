/**
 * Elitza Brain — session persistence views.
 *
 * 1:1 port of the legacy Python `persistence.py` tool surface, rebuilt on the
 * engine's own session store (Elitza owns conversation storage now — no
 * mirror DB). Exposes: recent sessions, cross-conversation history search,
 * and persistence statistics.
 */

import { Database } from "bun:sqlite"
import os from "node:os"
import path from "node:path"

// Same resolution as packages/cli/src/database-path.ts, minus the channel
// suffix (the launcher and mock harness both set OPENCODE_DB explicitly).
export const ENGINE_DB =
  process.env.OPENCODE_DB ??
  path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "opencode", "opencode.db")

interface EngineSession {
  id: string
  title: string | null
  time_created: number
  time_idle: number | null
  message_count: number
}

interface EngineMessage {
  type: string
  data: string
  time_created: number
}

function engineDb(): Database | null {
  if (!Bun.file(ENGINE_DB).size) return null
  return new Database(ENGINE_DB, { readonly: true, strict: true })
}

const iso = (ms: number) => new Date(ms).toISOString()

/** Best-effort text extraction from a stored engine message payload. */
function messageText(data: string): string {
  try {
    const parsed = JSON.parse(data) as { text?: string; content?: { type?: string; text?: string }[] }
    if (typeof parsed.text === "string") return parsed.text
    return (parsed.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n")
  } catch {
    return data
  }
}

// ---------------------------------------------------------------------------
// Recent sessions — legacy get_recent_sessions + brain_sessions formatting
// ---------------------------------------------------------------------------

export function recentSessions(limit = 10): string {
  const conn = engineDb()
  if (!conn) return "No sessions found."

  const rows = conn
    .query<
      EngineSession,
      [number]
    >(
      `SELECT s.id, s.title, s.time_created, s.time_idle,
              (SELECT COUNT(*) FROM session_message m WHERE m.session_id = s.id) AS message_count
       FROM session_v2 s
       ORDER BY s.time_created DESC
       LIMIT ?`,
    )
    .all(limit)
  conn.close()

  if (rows.length === 0) return "No sessions found."

  const lines = ["Recent sessions:"]
  for (const s of rows) {
    const status = s.time_idle ? "completed" : "active"
    const title = (s.title ?? "No summary").slice(0, 80)
    lines.push(`- [${iso(s.time_created).slice(0, 10)}] ${title} (${s.message_count} messages, ${status})`)
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// History search — legacy search_messages (FTS→LIKE fallback becomes LIKE
// over the engine store: no FTS index on session_message.data)
// ---------------------------------------------------------------------------

export function searchMessages(query: string, limit = 10): string {
  const conn = engineDb()
  if (!conn) return "No matching messages found."

  const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`
  const rows = conn
    .query<EngineMessage, [string, number]>(
      `SELECT type, data, time_created
       FROM session_message
       WHERE data LIKE ? ESCAPE '\\' AND type IN ('user', 'assistant')
       ORDER BY time_created DESC
       LIMIT ?`,
    )
    .all(like, limit)
  conn.close()

  if (rows.length === 0) return "No matching messages found."

  const lines = [`Found ${rows.length} messages:`]
  for (const r of rows) {
    const role = r.type === "user" ? "User" : "Elitza"
    lines.push(`- [${iso(r.time_created).slice(0, 10)}] **${role}**: ${messageText(r.data).slice(0, 150)}`)
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Stats — legacy get_persistence_stats
// ---------------------------------------------------------------------------

export function persistenceStats(): Record<string, unknown> {
  const conn = engineDb()
  if (!conn) return { error: `Engine database not found: ${ENGINE_DB}` }

  const totalMessages = (conn.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM session_message").get() ?? { n: 0 }).n
  const totalSessions = (conn.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM session_v2").get() ?? { n: 0 }).n
  const tokens = (
    conn
      .query<{ n: number | null }, []>(
        "SELECT SUM(tokens_input + tokens_output + tokens_cache_read + tokens_cache_write) AS n FROM session_v2",
      )
      .get() ?? { n: 0 }
  ).n
  const current = conn
    .query<{ id: string }, []>("SELECT id FROM session_v2 ORDER BY time_updated DESC LIMIT 1")
    .get()
  conn.close()

  return {
    total_messages: totalMessages,
    total_sessions: totalSessions,
    total_tokens_est: tokens ?? 0,
    current_session: current?.id ?? "",
  }
}
