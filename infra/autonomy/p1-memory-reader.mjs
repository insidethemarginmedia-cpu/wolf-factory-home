// P1 mission memory — real SQLite reader.
//
// Design constraints that are enforced, not documented-and-hoped:
//   1. STRICTLY READ-ONLY. The connection is opened with `readOnly: true`,
//      then pinned with `PRAGMA query_only=ON`. A write attempt from this
//      handle is a hard failure, never a silent no-op.
//   2. SYNCHRONOUS. node:sqlite is a synchronous binding, so every call here
//      completes before the next statement. This is what makes it legal to run
//      inside a synchronous claim-scope: no await, no interleaving, no window
//      in which another task on the same thread can observe half a read.
//   3. NAMESPACE-ISOLATED. Every statement is parameterised on BOTH mission id
//      and namespace. There is no query in this module that can return rows
//      belonging to a different mission.
//   4. FAIL-CLOSED. An unreadable, corrupt, wrongly-schema'd or locked database
//      raises a typed P2Denied. It never returns an empty result set, because
//      "no data" and "could not read" must not be indistinguishable to a caller.

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { P2_CODES, deny } from './p2-errors.mjs';

export const P1_SCHEMA_VERSION = 1;

/** Column contract the reader requires. Anything else is denied, not adapted. */
export const P1_REQUIRED_COLUMNS = Object.freeze([
  'mission_id',
  'namespace',
  'key',
  'value',
  'fencing_token',
  'committed_at',
]);

const CORRUPTION_PATTERNS = [
  'file is not a database',
  'database disk image is malformed',
  'malformed database schema',
  'file is encrypted or is not a database',
  'database corruption',
];

function looksCorrupt(error) {
  const text = `${error?.code ?? ''} ${error?.message ?? ''}`.toLowerCase();
  return CORRUPTION_PATTERNS.some((p) => text.includes(p));
}

function looksUnavailable(error) {
  const text = `${error?.code ?? ''} ${error?.message ?? ''}`.toLowerCase();
  return (
    text.includes('unable to open database') ||
    text.includes('sqlite_cantopen') ||
    text.includes('sqlite_busy') ||
    text.includes('sqlite_locked') ||
    text.includes('database is locked')
  );
}

/**
 * Open the P1 memory database read-only.
 *
 * Returns a reader object. The underlying handle is not exported by name; the
 * caller gets a narrow surface (`get`, `list`, `stats`, `close`) so that no
 * other module can smuggle a `prepare()` call past the namespace filter.
 */
export function openMissionMemory({ path, busyTimeoutMs = 5000 } = {}) {
  if (typeof path !== 'string' || !path) {
    deny(P2_CODES.GATE_CONFIGURATION_DENIED, 'memory path is required');
  }
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    deny(P2_CODES.GATE_CONFIGURATION_DENIED, 'busyTimeoutMs must be a non-negative integer');
  }

  let db;
  try {
    // readOnly is the primary control. query_only below is defence in depth.
    db = new DatabaseSync(path, { readOnly: true, timeout: busyTimeoutMs });
  } catch (error) {
    if (looksCorrupt(error)) deny(P2_CODES.MEMORY_CORRUPT, 'open rejected a non-database file');
    // A missing file is indistinguishable from an unreadable one on purpose.
    deny(P2_CODES.MEMORY_UNAVAILABLE, 'memory database could not be opened read-only');
  }

  try {
    db.exec('PRAGMA query_only = ON;');
    db.exec('PRAGMA trusted_schema = OFF;');
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
  } catch (error) {
    try { db.close(); } catch { /* already unusable */ }
    deny(P2_CODES.MEMORY_UNAVAILABLE, 'memory database rejected read-only pinning');
  }

  let integrityChecked = false;
  let closed = false;

  function requireOpen() {
    if (closed) deny(P2_CODES.MEMORY_UNAVAILABLE, 'memory reader is closed');
  }

  /**
   * Corruption in SQLite is frequently latent: the file opens, then explodes on
   * first page read. So an explicit integrity probe runs before the first data
   * query and its result is cached.
   */
  function assertIntegrity() {
    requireOpen();
    if (integrityChecked) return;
    try {
      const rows = db.prepare('PRAGMA integrity_check(1)').all();
      const verdict = rows?.[0]?.integrity_check;
      if (typeof verdict !== 'string' || verdict.toLowerCase() !== 'ok') {
        deny(P2_CODES.MEMORY_CORRUPT, 'integrity_check did not return ok');
      }
      // Confirm the required table/columns exist before trusting any read.
      const cols = db.prepare('PRAGMA table_info(mission_memory)').all();
      if (!Array.isArray(cols) || cols.length === 0) {
        deny(P2_CODES.MEMORY_SCHEMA_DENIED, 'mission_memory table is absent');
      }
      const present = new Set(cols.map((c) => c.name));
      const missing = P1_REQUIRED_COLUMNS.filter((c) => !present.has(c));
      if (missing.length > 0) {
        deny(P2_CODES.MEMORY_SCHEMA_DENIED, 'mission_memory is missing required columns');
      }
    } catch (error) {
      if (error?.name === 'P2Denied') throw error;
      if (looksCorrupt(error)) deny(P2_CODES.MEMORY_CORRUPT, 'integrity probe failed');
      deny(P2_CODES.MEMORY_READ_FAILED, 'integrity probe could not complete');
    }
    integrityChecked = true;
  }

  function requireScope(scope) {
    if (!scope || typeof scope !== 'object') {
      deny(P2_CODES.NAMESPACE_DENIED, 'scope is required');
    }
    const missionId = scope.missionId;
    const namespace = scope.namespace;
    if (typeof missionId !== 'string' || !missionId.trim()) {
      deny(P2_CODES.NAMESPACE_DENIED, 'missionId is required');
    }
    if (typeof namespace !== 'string' || !namespace.trim()) {
      deny(P2_CODES.NAMESPACE_DENIED, 'namespace is required');
    }
    // Namespace and mission must be distinct concepts; a namespace that silently
    // equals "*" or empty would defeat isolation.
    if (namespace === '*' || namespace === '%') {
      deny(P2_CODES.NAMESPACE_DENIED, 'wildcard namespaces are not permitted');
    }
    return { missionId, namespace };
  }

  function mapRow(row) {
    return Object.freeze({
      missionId: row.mission_id,
      namespace: row.namespace,
      key: row.key,
      value: row.value,
      fencingToken: Number(row.fencing_token),
      committedAt: row.committed_at,
      valueSha256: createHash('sha256').update(String(row.value)).digest('hex'),
    });
  }

  const api = {
    get path() { return path; },

    /** Read exactly one key, scoped to (missionId, namespace). */
    get(scope, key) {
      requireOpen();
      const { missionId, namespace } = requireScope(scope);
      if (typeof key !== 'string' || !key) deny(P2_CODES.NAMESPACE_DENIED, 'key is required');
      assertIntegrity();
      let row;
      try {
        row = db
          .prepare(
            `SELECT mission_id, namespace, key, value, fencing_token, committed_at
               FROM mission_memory
              WHERE mission_id = ? AND namespace = ? AND key = ?`,
          )
          .get(missionId, namespace, key);
      } catch (error) {
        if (looksCorrupt(error)) deny(P2_CODES.MEMORY_CORRUPT, 'corruption during get');
        if (looksUnavailable(error)) deny(P2_CODES.MEMORY_UNAVAILABLE, 'database busy during get');
        deny(P2_CODES.MEMORY_READ_FAILED, 'get failed');
      }
      if (!row) return null;
      // Belt-and-braces: never trust the WHERE clause alone.
      if (row.mission_id !== missionId || row.namespace !== namespace) {
        deny(P2_CODES.NAMESPACE_MISMATCH, 'row escaped its namespace scope');
      }
      return mapRow(row);
    },

    /** List every key in one namespace. Never crosses missions. */
    list(scope, { limit = 1000 } = {}) {
      requireOpen();
      const { missionId, namespace } = requireScope(scope);
      if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
        deny(P2_CODES.GATE_CONFIGURATION_DENIED, 'limit out of range');
      }
      assertIntegrity();
      let rows;
      try {
        rows = db
          .prepare(
            `SELECT mission_id, namespace, key, value, fencing_token, committed_at
               FROM mission_memory
              WHERE mission_id = ? AND namespace = ?
              ORDER BY key ASC
              LIMIT ?`,
          )
          .all(missionId, namespace, limit);
      } catch (error) {
        if (looksCorrupt(error)) deny(P2_CODES.MEMORY_CORRUPT, 'corruption during list');
        if (looksUnavailable(error)) deny(P2_CODES.MEMORY_UNAVAILABLE, 'database busy during list');
        deny(P2_CODES.MEMORY_READ_FAILED, 'list failed');
      }
      for (const row of rows) {
        if (row.mission_id !== missionId || row.namespace !== namespace) {
          deny(P2_CODES.NAMESPACE_MISMATCH, 'row escaped its namespace scope');
        }
      }
      return Object.freeze(rows.map(mapRow));
    },

    /** Non-sensitive counters used by receipts. */
    stats() {
      requireOpen();
      assertIntegrity();
      try {
        const row = db.prepare('SELECT COUNT(*) AS n FROM mission_memory').get();
        return { rows: Number(row?.n ?? 0), schemaVersion: P1_SCHEMA_VERSION };
      } catch (error) {
        if (looksCorrupt(error)) deny(P2_CODES.MEMORY_CORRUPT, 'corruption during stats');
        deny(P2_CODES.MEMORY_READ_FAILED, 'stats failed');
      }
    },

    /**
     * Proves the handle is read-only by attempting a write *inside a rolled-back
     * transaction*. Used by tests and by the install-time self-check; the write
     * must fail, and if it ever succeeds the memory store is deemed unsafe.
     */
    proveReadOnly() {
      requireOpen();
      try {
        db.exec('BEGIN IMMEDIATE;');
      } catch {
        // Even beginning a write transaction is expected to fail; that is proof.
        return { readOnly: true, method: 'BEGIN_DENIED' };
      }
      try {
        db.exec("INSERT INTO mission_memory VALUES ('__probe__','__probe__','__probe__','x',0,'x');");
      } catch (error) {
        try { db.exec('ROLLBACK;'); } catch { /* nothing was written */ }
        return { readOnly: true, method: 'WRITE_DENIED', code: error?.code ?? null };
      }
      try { db.exec('ROLLBACK;'); } catch { /* ignore */ }
      deny(P2_CODES.MEMORY_WRITE_DENIED, 'read-only handle accepted a write');
    },

    close() {
      if (closed) return;
      closed = true;
      try { db.close(); } catch { /* idempotent close */ }
    },
  };

  // Eager probe: a database that opens but is corrupt, text, or schema-drifted
  // must be rejected HERE, not at the first question asked of it.
  assertIntegrity();

  return Object.freeze(api);
}
