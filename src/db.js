import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';

const DB_DIR = join(homedir(), '.agent-replay-mcp');
if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });

const DB_PATH = join(DB_DIR, 'replay.db');

const db = new Database(DB_PATH);

// WAL mode for concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id    TEXT PRIMARY KEY,
    agent_id      TEXT NOT NULL,
    task          TEXT,
    status        TEXT NOT NULL DEFAULT 'recording',
    started_at    TEXT NOT NULL,
    ended_at      TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    tool_name     TEXT,
    args_json     TEXT,
    result_json   TEXT,
    timestamp     TEXT NOT NULL,
    duration_ms   REAL DEFAULT 0,
    tokens_used   INTEGER DEFAULT 0,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
  );

  CREATE TABLE IF NOT EXISTS checkpoints (
    checkpoint_id TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL,
    state_json    TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
  );

  CREATE INDEX IF NOT EXISTS idx_events_session_id      ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_checkpoints_session_id ON checkpoints(session_id);
`);

// ── Sessions ────────────────────────────────────────────────────────────────

const stmtInsertSession = db.prepare(`
  INSERT INTO sessions (session_id, agent_id, task, status, started_at, ended_at, metadata_json)
  VALUES (@session_id, @agent_id, @task, @status, @started_at, @ended_at, @metadata_json)
`);

const stmtGetSession = db.prepare(`SELECT * FROM sessions WHERE session_id = ?`);

const stmtUpdateSession = db.prepare(`
  UPDATE sessions SET status = @status, ended_at = @ended_at WHERE session_id = @session_id
`);

const stmtListSessions = db.prepare(`SELECT * FROM sessions ORDER BY started_at DESC`);

export function createSession({ session_id, agent_id, metadata = {}, status = 'recording', started_at }) {
  const task = metadata?.task ?? null;
  stmtInsertSession.run({
    session_id,
    agent_id,
    task,
    status,
    started_at,
    ended_at: null,
    metadata_json: JSON.stringify(metadata),
  });
}

export function getSession(session_id) {
  const row = stmtGetSession.get(session_id);
  if (!row) return null;
  return hydrateSession(row);
}

export function updateSessionStatus(session_id, status, ended_at = null) {
  stmtUpdateSession.run({ session_id, status, ended_at });
}

export function listSessions() {
  return stmtListSessions.all().map(hydrateSession);
}

function hydrateSession(row) {
  const metadata = JSON.parse(row.metadata_json || '{}');
  const actions = getEvents(row.session_id);
  return {
    session_id: row.session_id,
    agent_id: row.agent_id,
    task: row.task,
    status: row.status,
    started_at: row.started_at,
    stopped_at: row.ended_at ?? null,
    metadata,
    actions,
  };
}

// ── Events ───────────────────────────────────────────────────────────────────

const stmtInsertEvent = db.prepare(`
  INSERT INTO events (session_id, event_type, tool_name, args_json, result_json, timestamp, duration_ms, tokens_used)
  VALUES (@session_id, @event_type, @tool_name, @args_json, @result_json, @timestamp, @duration_ms, @tokens_used)
`);

const stmtGetEvents = db.prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY id ASC`);

const stmtCountEvents = db.prepare(`SELECT COUNT(*) as cnt FROM events WHERE session_id = ?`);

export function insertEvent({ session_id, action_type, input, output, reasoning = '', duration_ms = 0, timestamp, tokens_used = 0 }) {
  stmtInsertEvent.run({
    session_id,
    event_type: action_type,
    tool_name: input?.tool ?? null,
    args_json: JSON.stringify(input ?? null),
    result_json: JSON.stringify(output ?? null),
    timestamp,
    duration_ms,
    tokens_used,
  });
  // Return the step number (count after insert)
  return stmtCountEvents.get(session_id).cnt;
}

export function getEvents(session_id) {
  return stmtGetEvents.all(session_id).map((row, i) => ({
    step: i + 1,
    action_type: row.event_type,
    input: JSON.parse(row.args_json ?? 'null'),
    output: JSON.parse(row.result_json ?? 'null'),
    reasoning: '',   // legacy field — not stored in DB but kept for API compat
    duration_ms: row.duration_ms ?? 0,
    timestamp: row.timestamp,
  }));
}

// ── Checkpoints ───────────────────────────────────────────────────────────────

const stmtInsertCheckpoint = db.prepare(`
  INSERT OR REPLACE INTO checkpoints (checkpoint_id, session_id, state_json, created_at)
  VALUES (@checkpoint_id, @session_id, @state_json, @created_at)
`);

const stmtGetCheckpoint = db.prepare(`SELECT * FROM checkpoints WHERE checkpoint_id = ?`);

const stmtGetCheckpointsBySession = db.prepare(`SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at ASC`);

export function saveCheckpoint({ checkpoint_id, session_id, state, created_at }) {
  stmtInsertCheckpoint.run({
    checkpoint_id,
    session_id,
    state_json: JSON.stringify(state),
    created_at,
  });
}

export function getCheckpoint(checkpoint_id) {
  const row = stmtGetCheckpoint.get(checkpoint_id);
  if (!row) return null;
  return { checkpoint_id: row.checkpoint_id, session_id: row.session_id, state: JSON.parse(row.state_json), created_at: row.created_at };
}

export function getCheckpointsBySession(session_id) {
  return stmtGetCheckpointsBySession.all(session_id).map(row => ({
    checkpoint_id: row.checkpoint_id,
    session_id: row.session_id,
    state: JSON.parse(row.state_json),
    created_at: row.created_at,
  }));
}

export { db };
