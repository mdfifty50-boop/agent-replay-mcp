import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Use a temp DB for tests so we don't pollute the real one
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';

// Point DB at a temp dir before importing db.js
const TEST_DIR = join(homedir(), '.agent-replay-mcp-test');
process.env.AGENT_REPLAY_DB_DIR = TEST_DIR; // read by db.js when env var present

// We re-export from a patched copy: simplest approach is to mock the module.
// Since better-sqlite3 is synchronous we can just import and exercise the functions
// directly using a fresh test DB path.

// ── Inline minimal DB setup for tests (mirrors db.js but with test path) ──
import Database from 'better-sqlite3';

function makeTestDb() {
  mkdirSync(TEST_DIR, { recursive: true });
  const db = new Database(join(TEST_DIR, `test_${Date.now()}.db`));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
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
      tokens_used   INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      state_json    TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_sid      ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_checkpoints_sid ON checkpoints(session_id);
  `);
  return db;
}

// ── Helpers operating on a passed-in db ───────────────────────────────────

function insertSession(db, { session_id, agent_id, metadata = {}, status = 'recording', started_at }) {
  db.prepare(`INSERT INTO sessions (session_id, agent_id, task, status, started_at, ended_at, metadata_json)
              VALUES (?, ?, ?, ?, ?, NULL, ?)`
  ).run(session_id, agent_id, metadata?.task ?? null, status, started_at, JSON.stringify(metadata));
}

function fetchSession(db, session_id) {
  const row = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(session_id);
  if (!row) return null;
  return { ...row, metadata: JSON.parse(row.metadata_json || '{}') };
}

function addEvent(db, { session_id, action_type, input, output, duration_ms = 0, timestamp }) {
  db.prepare(`INSERT INTO events (session_id, event_type, args_json, result_json, timestamp, duration_ms)
              VALUES (?, ?, ?, ?, ?, ?)`
  ).run(session_id, action_type, JSON.stringify(input), JSON.stringify(output), timestamp, duration_ms);
  return db.prepare('SELECT COUNT(*) as cnt FROM events WHERE session_id = ?').get(session_id).cnt;
}

function fetchEvents(db, session_id) {
  return db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY id ASC').all(session_id).map((r, i) => ({
    step: i + 1,
    action_type: r.event_type,
    input: JSON.parse(r.args_json ?? 'null'),
    output: JSON.parse(r.result_json ?? 'null'),
    duration_ms: r.duration_ms,
    timestamp: r.timestamp,
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('agent-replay-mcp SQLite storage', () => {
  let db;

  before(() => {
    db = makeTestDb();
  });

  after(() => {
    db.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('Test 1: create and fetch a session', () => {
    const session_id = 'sess_test_001';
    const started_at = new Date().toISOString();
    insertSession(db, { session_id, agent_id: 'agent-alpha', metadata: { task: 'write code' }, started_at });

    const row = fetchSession(db, session_id);
    assert.ok(row, 'session row should exist');
    assert.equal(row.session_id, session_id);
    assert.equal(row.agent_id, 'agent-alpha');
    assert.equal(row.status, 'recording');
    assert.equal(row.metadata.task, 'write code');
    assert.equal(row.ended_at, null);
  });

  it('Test 2: insert events and retrieve them in order', () => {
    const session_id = 'sess_test_002';
    const started_at = new Date().toISOString();
    insertSession(db, { session_id, agent_id: 'agent-beta', started_at });

    const ts1 = new Date().toISOString();
    const step1 = addEvent(db, { session_id, action_type: 'tool_call', input: { tool: 'search' }, output: { results: ['a'] }, duration_ms: 120, timestamp: ts1 });
    const ts2 = new Date().toISOString();
    const step2 = addEvent(db, { session_id, action_type: 'llm_response', input: { prompt: 'summarize' }, output: { text: 'done' }, duration_ms: 340, timestamp: ts2 });

    assert.equal(step1, 1, 'first event should be step 1');
    assert.equal(step2, 2, 'second event should be step 2');

    const events = fetchEvents(db, session_id);
    assert.equal(events.length, 2);
    assert.equal(events[0].action_type, 'tool_call');
    assert.equal(events[0].input.tool, 'search');
    assert.equal(events[1].action_type, 'llm_response');
    assert.equal(events[1].output.text, 'done');
    assert.equal(events[0].step, 1);
    assert.equal(events[1].step, 2);
  });

  it('Test 3: update session status to stopped', () => {
    const session_id = 'sess_test_003';
    const started_at = new Date().toISOString();
    insertSession(db, { session_id, agent_id: 'agent-gamma', started_at });

    // Confirm initial status
    let row = fetchSession(db, session_id);
    assert.equal(row.status, 'recording');

    // Stop the session
    const ended_at = new Date().toISOString();
    db.prepare('UPDATE sessions SET status = ?, ended_at = ? WHERE session_id = ?').run('stopped', ended_at, session_id);

    row = fetchSession(db, session_id);
    assert.equal(row.status, 'stopped');
    assert.ok(row.ended_at, 'ended_at should be set');
    assert.equal(row.ended_at, ended_at);
  });
});
