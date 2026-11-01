// ============================================================================
// TEST SUPPORT ONLY -- NOT THE FACTORY.
//
// This is a REFERENCE implementation of the canonical mission-lease contract,
// written so that the P2 gate can be exercised against a lease engine with real
// semantics, real SQLite durability, real file locking and real multi-process
// concurrency in an environment where the private Factory repository is not
// reachable.
//
// It implements exactly the four canonical exports:
//   claimMission, assertMissionClaim, releaseMissionClaim,
//   withMissionClaimWriteAuthority
//
// It is NOT infra/autonomy/mission-lease.mjs. Its digest is NOT the canonical
// digest, and the gate records `leaseMode: UNVERIFIED_INTERFACE_ONLY` whenever
// it is used, so no receipt produced with it can be mistaken for production
// acceptance. Do not import this from production code.
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mission_lease (
  namespace     TEXT    NOT NULL,
  mission_id    TEXT    NOT NULL,
  fencing_token INTEGER NOT NULL,
  owner_id      TEXT    NOT NULL,
  claim_id      TEXT    NOT NULL,
  state         TEXT    NOT NULL,
  expires_at    INTEGER NOT NULL,
  PRIMARY KEY (namespace, mission_id)
) WITHOUT ROWID;
`;

function fail(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function openLeaseDatabase(path, { busyTimeoutMs = 10000 } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

export function createReferenceLeaseEngine({ path, clock = () => Date.now(), ownsConnection = true }) {
  const db = openLeaseDatabase(path);

  function readRow(namespace, missionId) {
    return db
      .prepare('SELECT * FROM mission_lease WHERE namespace = ? AND mission_id = ?')
      .get(namespace, missionId);
  }

  function claimMission({ missionId, namespace = 'core', ownerId = 'worker', ttlMs = 60000 } = {}) {
    if (!missionId) throw fail('LEASE_MISSION_REQUIRED');
    const now = clock();
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = readRow(namespace, missionId);
      if (row && row.state === 'ACTIVE' && row.expires_at > now && row.owner_id !== ownerId) {
        // Held by somebody else and still live: this is the serialization point.
        throw fail('LEASE_ALREADY_HELD', 'mission lease is held by another owner');
      }
      const nextFence = Number(row?.fencing_token ?? 0) + 1;
      const claim = {
        missionId,
        namespace,
        ownerId,
        claimId: randomUUID(),
        fencingToken: nextFence,
        expiresAt: now + ttlMs,
        state: 'ACTIVE',
      };
      db.prepare(
        `INSERT INTO mission_lease
           (namespace, mission_id, fencing_token, owner_id, claim_id, state, expires_at)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)
         ON CONFLICT(namespace, mission_id) DO UPDATE SET
           fencing_token = excluded.fencing_token,
           owner_id      = excluded.owner_id,
           claim_id      = excluded.claim_id,
           state         = 'ACTIVE',
           expires_at    = excluded.expires_at`,
      ).run(namespace, missionId, nextFence, ownerId, claim.claimId, claim.expiresAt);
      db.exec('COMMIT');
      return claim;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error;
    }
  }

  function assertMissionClaim(claim) {
    if (!claim || !claim.claimId) throw fail('LEASE_CLAIM_INVALID', 'claim is malformed');
    const row = readRow(claim.namespace ?? 'core', claim.missionId);
    if (!row) throw fail('LEASE_NOT_HELD', 'no lease recorded for this mission');
    if (row.mission_id !== claim.missionId) throw fail('LEASE_MISSION_MISMATCH', 'mission mismatch');
    if (row.state === 'RELEASED') throw fail('LEASE_RELEASED', 'lease was released');
    if (row.claim_id !== claim.claimId) {
      // A different claim owns the lease now: our fence is by definition stale.
      throw fail('LEASE_FENCED_OUT', 'lease superseded by a newer claim');
    }
    if (row.fencing_token !== Number(claim.fencingToken)) {
      throw fail('LEASE_FENCE_STALE', 'fencing token is stale');
    }
    if (row.expires_at <= clock()) throw fail('LEASE_EXPIRED', 'lease expired');
    return { valid: true, fencingToken: row.fencing_token };
  }

  function releaseMissionClaim(claim) {
    if (!claim || !claim.claimId) throw fail('LEASE_CLAIM_INVALID');
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = readRow(claim.namespace ?? 'core', claim.missionId);
      if (!row) throw fail('LEASE_NOT_HELD');
      // Only the current holder may release; a stale worker must not be able to
      // release the lease that superseded it.
      if (row.claim_id !== claim.claimId) throw fail('LEASE_FENCE_STALE', 'cannot release a superseded lease');
      db.prepare(
        `UPDATE mission_lease SET state = 'RELEASED' WHERE namespace = ? AND mission_id = ?`,
      ).run(claim.namespace ?? 'core', claim.missionId);
      db.exec('COMMIT');
      return { released: true, fencingToken: row.fencing_token };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    }
  }

  function withMissionClaimWriteAuthority(claim, fn) {
    assertMissionClaim(claim);
    return fn({
      claim,
      fencingToken: Number(claim.fencingToken),
      missionId: claim.missionId,
      namespace: claim.namespace ?? 'core',
    });
  }

  return {
    claimMission,
    assertMissionClaim,
    releaseMissionClaim,
    withMissionClaimWriteAuthority,
    close() { if (ownsConnection) db.close(); else db.close(); },
    _db: db,
  };
}
