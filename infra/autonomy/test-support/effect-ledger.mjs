// ============================================================================
// TEST SUPPORT ONLY -- NOT A DURABLE AUTHORITY.
//
// DBOS remains the durable workflow authority in the real Factory. This file is
// a test harness that lets the suite prove the *replay decisions* in
// p2-effect-guard.mjs against real persisted state and a real observable
// external effect (an append-only file whose line count is the ground truth).
//
// It must never be wired into a production path: doing so would create the
// duplicate database authority the architecture forbids.
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS effect_receipt (
  mission_id    TEXT NOT NULL,
  execution_key TEXT NOT NULL,
  state         TEXT NOT NULL,
  effect_kind   TEXT,
  commit_sha    TEXT,
  recorded_at   TEXT NOT NULL,
  PRIMARY KEY (mission_id, execution_key)
) WITHOUT ROWID;
`;

export function openEffectLedger(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = 10000;`);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return {
    db,
    read(missionId, executionKey) {
      const row = db
        .prepare('SELECT * FROM effect_receipt WHERE mission_id = ? AND execution_key = ?')
        .get(missionId, executionKey);
      if (!row) return null;
      return {
        missionId: row.mission_id,
        executionKey: row.execution_key,
        state: row.state,
        effectKind: row.effect_kind,
        commitSha: row.commit_sha,
        recordedAt: row.recorded_at,
      };
    },
    write({ missionId, executionKey, state, effectKind = null, commitSha = null, recordedAt = new Date().toISOString() }) {
      db.prepare(
        `INSERT INTO effect_receipt (mission_id, execution_key, state, effect_kind, commit_sha, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(mission_id, execution_key) DO UPDATE SET
           state = excluded.state,
           effect_kind = excluded.effect_kind,
           commit_sha = excluded.commit_sha,
           recorded_at = excluded.recorded_at`,
      ).run(missionId, executionKey, state, effectKind, commitSha, recordedAt);
    },
    close() { db.close(); },
  };
}

/**
 * Perform the external effect. The effect is a real append; the number of lines
 * in the file is the observable "how many times did this happen" counter.
 */
export function performExternalEffect(effectPath, payload) {
  appendFileSync(effectPath, `${JSON.stringify(payload)}\n`);
  return { lines: readFileSync(effectPath, 'utf8').trim().split('\n').filter(Boolean).length };
}

export function countEffects(effectPath) {
  if (!existsSync(effectPath)) return 0;
  return readFileSync(effectPath, 'utf8').trim().split('\n').filter(Boolean).length;
}
