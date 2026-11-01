// Canonical P1 mission-memory schema and fixture writer.
//
// The production Factory owns migrations; this module exists so that tests and
// the install self-check can build a *real* SQLite database with the exact
// column contract the reader enforces. It is a writer, and it is deliberately
// the only writer in this package.

import { DatabaseSync } from 'node:sqlite';
import { P1_SCHEMA_VERSION } from './p1-memory-reader.mjs';

export const P1_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mission_memory (
  mission_id    TEXT NOT NULL,
  namespace     TEXT NOT NULL,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  committed_at  TEXT NOT NULL,
  PRIMARY KEY (mission_id, namespace, key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS mission_memory_meta (
  meta_key   TEXT PRIMARY KEY,
  meta_value TEXT NOT NULL
) WITHOUT ROWID;
`;

/**
 * Create/open a writable database with the canonical schema.
 * Used by fixtures and the install self-check only.
 */
export function createMissionMemoryDatabase(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(P1_SCHEMA_SQL);
    db.prepare(
      'INSERT OR REPLACE INTO mission_memory_meta (meta_key, meta_value) VALUES (?, ?)',
    ).run('schema_version', String(P1_SCHEMA_VERSION));
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function seedMemory(db, { missionId, namespace, entries, fencingToken = 1, committedAt = '2026-11-01T00:00:00.000Z' }) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO mission_memory
       (mission_id, namespace, key, value, fencing_token, committed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const [key, value] of Object.entries(entries)) {
    stmt.run(missionId, namespace, key, String(value), fencingToken, committedAt);
  }
}

/**
 * Simulate real on-disk corruption: stop on a clean database, then truncate and
 * scribble over the page-1 header. SQLite must then refuse the file. This is a
 * genuine corrupted database, not a mock.
 */
export function corruptDatabaseFile(path, fs, { keepPrefix = 512 } = {}) {
  const original = fs.readFileSync(path);
  const head = original.subarray(0, Math.min(keepPrefix, original.length));
  const garbage = Buffer.alloc(2400, 0x7a);
  fs.writeFileSync(path, Buffer.concat([head, garbage]));
}

export function truncateDatabaseFile(path, fs, bytes = 4096) {
  const fd = fs.openSync(path, 'r+');
  try {
    fs.ftruncateSync(fd, bytes);
  } finally {
    fs.closeSync(fd);
  }
}
