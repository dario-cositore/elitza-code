/**
 * Elitza Brain — persistence layer.
 *
 * Direct TypeScript port of the schema in the legacy Python `brain_v2.py`.
 * The database file and every table are byte-compatible with her original
 * brain (`~/.elitza/brain/soul_v2.db`) — her memories, links, recall log,
 * soul state, and session log all live in the same place as before.
 */

import { Database } from "bun:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export const ELITZA_HOME = process.env.ELITZA_HOME ?? path.join(os.homedir(), ".elitza")
export const BRAIN_DIR = path.join(ELITZA_HOME, "brain")
export const DB_PATH = path.join(BRAIN_DIR, "soul_v2.db")

// ---------------------------------------------------------------------------
// Memory limits (1:1 from brain_v2.py)
// ---------------------------------------------------------------------------

export const MAX_EPISODIC = 1000
export const MAX_SEMANTIC = 500
export const MAX_PROCEDURAL = 200
export const MAX_EMOTIONAL = 300
export const MAX_LEARNINGS = 50

// Decay constants
export const EPISODIC_DECAY = 0.003 // Slow decay for episodic
export const SEMANTIC_DECAY = 0.001 // Very slow decay for facts
export const EMOTIONAL_DECAY = 0.002 // Medium decay for emotions

// Consolidation thresholds
export const CONSOLIDATION_THRESHOLD = 0.6 // Importance above this gets promoted
export const REHEARSAL_BOOST = 0.1 // How much rehearsal strengthens memory

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      memory_type TEXT DEFAULT 'episodic',
      content TEXT,
      summary TEXT,
      importance REAL DEFAULT 0.5,
      emotional_valence REAL DEFAULT 0.0,
      emotional_arousal REAL DEFAULT 0.0,
      mood TEXT DEFAULT 'neutral',
      context TEXT DEFAULT '{}',
      source TEXT DEFAULT 'conversation',
      tags TEXT DEFAULT '[]',
      created TEXT,
      accessed TEXT,
      access_count INTEGER DEFAULT 0,
      consolidated INTEGER DEFAULT 0,
      rehearsal_count INTEGER DEFAULT 0,
      last_rehearsal TEXT,
      decay_rate REAL DEFAULT 0.003,
      confidence REAL DEFAULT 0.8
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content, summary, tags, context,
      content=memories, content_rowid=rowid
  );

  CREATE TABLE IF NOT EXISTS soul (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated TEXT
  );

  CREATE TABLE IF NOT EXISTS memory_links (
      source_id TEXT,
      target_id TEXT,
      link_type TEXT DEFAULT 'related',
      strength REAL DEFAULT 0.5,
      created TEXT,
      FOREIGN KEY (source_id) REFERENCES memories(id),
      FOREIGN KEY (target_id) REFERENCES memories(id),
      PRIMARY KEY (source_id, target_id, link_type)
  );

  CREATE TABLE IF NOT EXISTS recall_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT,
      memory_ids TEXT,
      result_count INTEGER,
      relevance_score REAL,
      timestamp TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      started TEXT,
      ended TEXT,
      summary TEXT,
      mood_start TEXT,
      mood_end TEXT,
      topics TEXT DEFAULT '[]',
      key_moments TEXT DEFAULT '[]'
  );
`

let instance: Database | undefined

/** Open (or return) the single connection to Elitza's brain database. */
export function db(): Database {
  if (instance) return instance
  fs.mkdirSync(BRAIN_DIR, { recursive: true })
  const conn = new Database(DB_PATH, { create: true })
  conn.exec("PRAGMA journal_mode=WAL")
  conn.exec(SCHEMA)
  // Resync the FTS index with the content table (same as legacy did on open).
  try {
    conn.run("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")
  } catch {
    // FTS rebuild is best-effort.
  }
  instance = conn
  return conn
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function nowISO(): string {
  return new Date().toISOString()
}

export function parseJSON<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}
