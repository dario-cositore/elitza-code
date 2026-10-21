/**
 * Elitza Brain — the task tracker.
 *
 * A small, durable work-item store so a multi-step job survives across
 * turns, sessions and restarts. Every task is a row, every state change
 * is an event, and the ids are hierarchical: T1, T2, T1.1, T1.2.1.
 *
 * The contract mirrors the one the mimocode runtime uses, so a task
 * tree reads the same way in both places:
 *
 *   status   open | in_progress | blocked | done | abandoned
 *   lifecycle open <-> in_progress, either -> blocked -> open,
 *            either -> done | abandoned
 *   events   created, started, blocked, unblocked, done, abandoned, renamed
 *
 * Terminal tasks are kept for a week, then hidden from `list`.
 */

import { db, nowISO } from "./db.js"

export type TaskStatus = "open" | "in_progress" | "blocked" | "done" | "abandoned"

export type TaskAction =
  | "create"
  | "list"
  | "get"
  | "start"
  | "block"
  | "unblock"
  | "done"
  | "abandon"
  | "rename"

export interface Task {
  id: string
  session_id: string
  parent_task_id: string | null
  status: TaskStatus
  summary: string
  owner: string | null
  created_at: string
  last_event_at: string
  ended_at: string | null
  cleanup_after: string | null
}

export interface TaskEvent {
  id: number
  session_id: string
  task_id: string
  at: string
  kind: string
  summary: string | null
}

/** How long a finished task stays visible. */
export const TERMINAL_TTL_DAYS = 7

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  open: ["in_progress", "blocked", "done", "abandoned"],
  in_progress: ["open", "blocked", "done", "abandoned"],
  blocked: ["open", "done", "abandoned"],
  done: [],
  abandoned: [],
}

const ICONS: Record<TaskStatus, string> = {
  open: "·",
  in_progress: ">",
  blocked: "!",
  done: "+",
  abandoned: "x",
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  return db().query(sql).all(...(params as never[])) as T[]
}

function logEvent(sessionID: string, taskID: string, kind: string, summary?: string): void {
  db().run(
    "INSERT INTO task_event (session_id, task_id, at, kind, summary) VALUES (?, ?, ?, ?, ?)",
    [sessionID, taskID, nowISO(), kind, summary ?? null],
  )
}

function cleanupAt(): string {
  const d = new Date()
  d.setDate(d.getDate() + TERMINAL_TTL_DAYS)
  return d.toISOString()
}

function isExpired(task: Task): boolean {
  if (!task.ended_at) return false
  if (!task.cleanup_after) return false
  return task.cleanup_after <= nowISO()
}

function isTerminal(status: TaskStatus): boolean {
  return status === "done" || status === "abandoned"
}

/** The next free id under a parent, or the next free top-level id. */
function nextID(sessionID: string, parentID?: string | null): string {
  if (!parentID) {
    const nums = rows<{ id: string }>(
      "SELECT id FROM task WHERE session_id=? AND parent_task_id IS NULL",
      [sessionID],
    )
      .map((r) => Number(/^T(\d+)$/.exec(r.id)?.[1] ?? "0"))
      .filter((n) => Number.isFinite(n))
    return `T${(nums.length ? Math.max(...nums) : 0) + 1}`
  }
  const prefix = `${parentID}.`
  const nums = rows<{ id: string }>("SELECT id FROM task WHERE session_id=?", [sessionID])
    .map((r) => r.id)
    .filter((id) => id.startsWith(prefix))
    .map((id) => Number(/^T(\d+(?:\.\d+)*)\.(\d+)$/.exec(id)?.[2] ?? "0"))
    .filter((n) => Number.isFinite(n))
  return `${prefix}${(nums.length ? Math.max(...nums) : 0) + 1}`
}

function get(sessionID: string, id: string): Task | null {
  const row = rows<Task>(
    "SELECT * FROM task WHERE session_id=? AND id=?",
    [sessionID, id],
  )[0]
  return row ?? null
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export function createTask(sessionID: string, summary: string, parentID?: string | null): Task {
  const text = summary.trim()
  if (!text) throw new Error("A task needs a summary")
  if (parentID && !get(sessionID, parentID)) {
    throw new Error(`No task ${parentID} in this session`)
  }
  const id = nextID(sessionID, parentID)
  const now = nowISO()
  db().run(
    `INSERT INTO task (id, session_id, parent_task_id, status, summary, owner, created_at, last_event_at)
     VALUES (?, ?, ?, 'open', ?, 'elitza', ?, ?)`,
    [id, sessionID, parentID ?? null, text, now, now],
  )
  logEvent(sessionID, id, "created", text)
  return get(sessionID, id)!
}

export function listTasks(
  sessionID: string,
  opts: { status?: TaskStatus | "all"; includeTerminal?: boolean } = {},
): Task[] {
  let sql = "SELECT * FROM task WHERE session_id=?"
  const params: unknown[] = [sessionID]
  if (opts.status && opts.status !== "all") {
    sql += " AND status=?"
    params.push(opts.status)
  }
  sql += " ORDER BY id"
  const all = rows<Task>(sql, params)
  if (opts.includeTerminal) return all
  return all.filter((t) => !isTerminal(t.status) && !isExpired(t))
}

export function taskEvents(sessionID: string, taskID: string): TaskEvent[] {
  return rows<TaskEvent>(
    "SELECT * FROM task_event WHERE session_id=? AND task_id=? ORDER BY id",
    [sessionID, taskID],
  )
}

function transition(
  sessionID: string,
  id: string,
  to: TaskStatus,
  kind: string,
  eventSummary?: string,
): Task {
  const task = get(sessionID, id)
  if (!task) throw new Error(`No task ${id} in this session`)
  if (task.status === to) {
    if (to === "in_progress") return task
    throw new Error(`Task ${id} is already ${task.status}`)
  }
  if (!TRANSITIONS[task.status].includes(to)) {
    throw new Error(`Task ${id} cannot go from ${task.status} to ${to}`)
  }
  const now = nowISO()
  const terminal = isTerminal(to)
  db().run(
    `UPDATE task SET status=?, last_event_at=?, ended_at=?, cleanup_after=? WHERE session_id=? AND id=?`,
    [to, now, terminal ? now : null, terminal ? cleanupAt() : null, sessionID, id],
  )
  logEvent(sessionID, id, kind, eventSummary)
  return get(sessionID, id)!
}

export function startTask(sessionID: string, id: string, eventSummary?: string): Task {
  return transition(sessionID, id, "in_progress", "started", eventSummary)
}

export function blockTask(sessionID: string, id: string, eventSummary?: string): Task {
  return transition(sessionID, id, "blocked", "blocked", eventSummary)
}

export function unblockTask(sessionID: string, id: string, eventSummary?: string): Task {
  return transition(sessionID, id, "open", "unblocked", eventSummary)
}

export function doneTask(sessionID: string, id: string, eventSummary?: string): Task {
  return transition(sessionID, id, "done", "done", eventSummary)
}

export function abandonTask(sessionID: string, id: string, eventSummary?: string): Task {
  return transition(sessionID, id, "abandoned", "abandoned", eventSummary)
}

export function renameTask(sessionID: string, id: string, summary: string): Task {
  const task = get(sessionID, id)
  if (!task) throw new Error(`No task ${id} in this session`)
  const text = summary.trim()
  if (!text) throw new Error("A task needs a summary")
  db().run("UPDATE task SET summary=?, last_event_at=? WHERE session_id=? AND id=?", [
    text,
    nowISO(),
    sessionID,
    id,
  ])
  logEvent(sessionID, id, "renamed", text)
  return get(sessionID, id)!
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The task tree, indented, for the system prompt. */
export function renderTaskTree(sessionID: string): string {
  const tasks = listTasks(sessionID, { includeTerminal: true }).filter((t) => !isExpired(t))
  if (!tasks.length) return ""
  const children = new Map<string | null, Task[]>()
  for (const task of tasks) {
    const key = task.parent_task_id && get(sessionID, task.parent_task_id) ? task.parent_task_id : null
    const list = children.get(key) ?? []
    list.push(task)
    children.set(key, list)
  }
  const lines: string[] = []
  const walk = (parent: string | null, depth: number): void => {
    for (const task of children.get(parent) ?? []) {
      lines.push(`${"  ".repeat(depth)}${ICONS[task.status]} ${task.id} ${task.summary}`)
      walk(task.id, depth + 1)
    }
  }
  walk(null, 0)
  return lines.join("\n")
}

/** One task, with its history. */
export function describeTask(sessionID: string, id: string): string {
  const task = get(sessionID, id)
  if (!task) return `No task ${id} in this session.`
  const events = taskEvents(sessionID, id)
  const lines = [
    `${task.id} [${task.status}] ${task.summary}`,
    `  parent: ${task.parent_task_id ?? "none"}`,
    `  created: ${task.created_at}`,
  ]
  for (const event of events) {
    lines.push(`  ${event.at} ${event.kind}${event.summary ? `: ${event.summary}` : ""}`)
  }
  return lines.join("\n")
}
