/**
 * Wolf mission-state adapter contracts (portable, Ruflo-independent).
 *
 * Authority boundaries (unchanged from Project Wolf):
 *  - DBOS remains the durable workflow authority. This module never schedules,
 *    never retries, never runs a timer or loop.
 *  - KCT remains mission admission/authorization. This module records leases
 *    and fences; it does not decide admission on its own.
 *  - Publication, verification and economic gates are enforced here as
 *    preconditions on the state transitions this module records.
 *
 * Storage: one JSON document, written atomically (temp file + fsync + rename),
 * guarded by an exclusive lockfile (O_EXCL) for each read-modify-write so that
 * separate OS processes do not lose updates. A lock older than LOCK_STALE_MS is
 * treated as abandoned by a crashed writer and removed. Durability relies on
 * fsync + rename; no RVF format is used. Concurrency is verified only by
 * tests/wolf-adapter-contracts.test.mjs (multi-process), not by RVF.
 */
import { readFile, rename, open, mkdir, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;

export class WolfContractError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const EMPTY = { version: 1, missions: {}, idempotent: {}, effects: {} };

export class WolfMissionStore {
  constructor(path) {
    this.path = path;
  }

  async load() {
    try {
      const doc = JSON.parse(await readFile(this.path, 'utf8'));
      if (doc.version !== 1) throw new WolfContractError('SCHEMA_VERSION_UNSUPPORTED', `version ${doc.version}`);
      return doc;
    } catch (e) {
      if (e.code === 'ENOENT') return structuredClone(EMPTY);
      if (e instanceof WolfContractError) throw e;
      throw new WolfContractError('STORE_CORRUPT', e.message);
    }
  }

  async save(doc) {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(JSON.stringify(doc, null, 2) + '\n', 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, this.path);
  }

  async #lock() {
    const lockPath = `${this.path}.lock`;
    await mkdir(dirname(this.path), { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const fh = await open(lockPath, 'wx');
        await fh.writeFile(`${process.pid}\n`);
        await fh.close();
        return lockPath;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          const age = Date.now() - (await stat(lockPath)).mtimeMs;
          if (age > LOCK_STALE_MS) { await unlink(lockPath).catch(() => {}); continue; }
        } catch { /* holder released between checks */ }
        if (Date.now() > deadline) throw new WolfContractError('LOCK_TIMEOUT', lockPath);
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
      }
    }
  }

  /** Run a locked read-modify-write. Safe across OS processes sharing this path. */
  async transact(fn) {
    const lockPath = await this.#lock();
    try {
      const doc = await this.load();
      const result = await fn(doc);
      await this.save(doc);
      return result;
    } finally {
      await unlink(lockPath).catch(() => {});
    }
  }
}

/**
 * Lease + fencing. A fence is strictly increasing per mission. A caller must
 * present the current fence for every state change; a stale fence is refused.
 */
export async function acquireLease(store, { missionId, owner, nowMs = Date.now(), ttlMs = 60_000 }) {
  return store.transact((doc) => {
    const m = doc.missions[missionId] ?? { fence: 0 };
    const live = m.lease && m.lease.expiresAt > nowMs;
    if (live && m.lease.owner !== owner) {
      throw new WolfContractError('LEASE_HELD', `held by ${m.lease.owner}`);
    }
    m.fence += 1;
    m.lease = { owner, fence: m.fence, expiresAt: nowMs + ttlMs };
    doc.missions[missionId] = m;
    return { missionId, fence: m.fence };
  });
}

function requireFence(doc, missionId, fence) {
  const m = doc.missions[missionId];
  if (!m || !m.lease) throw new WolfContractError('NO_LEASE', missionId);
  if (fence !== m.fence) throw new WolfContractError('STALE_FENCE', `presented ${fence}, current ${m.fence}`);
  return m;
}

/**
 * Idempotency: a key executes its operation once. Replays return the stored
 * result, including after a restart (the record is persisted before return).
 */
export async function idempotent(store, { missionId, fence, key, operation }) {
  return store.transact(async (doc) => {
    requireFence(doc, missionId, fence);
    const id = `${missionId}:${key}`;
    if (doc.idempotent[id]) return { replayed: true, result: doc.idempotent[id].result };
    const result = await operation();
    doc.idempotent[id] = { result, fence };
    return { replayed: false, result };
  });
}

/** Independent verification: verifier must differ from the executor. */
export async function recordVerification(store, { missionId, fence, executorId, verifierId, commitSha, verdict }) {
  if (verifierId === executorId) throw new WolfContractError('VERIFIER_NOT_INDEPENDENT', verifierId);
  if (!['PASS', 'FAIL'].includes(verdict)) throw new WolfContractError('BAD_VERDICT', String(verdict));
  return store.transact((doc) => {
    const m = requireFence(doc, missionId, fence);
    m.verifications = m.verifications ?? {};
    m.verifications[commitSha] = { verifierId, executorId, verdict, fence };
    return m.verifications[commitSha];
  });
}

/**
 * Publication authority: only the current fence may publish, only a commit
 * with an independent PASS may be published, and no unreconciled UNKNOWN
 * external effect may exist for the mission.
 */
export async function authorizePublication(store, { missionId, fence, commitSha }) {
  return store.transact((doc) => {
    const m = requireFence(doc, missionId, fence);
    const v = m.verifications?.[commitSha];
    if (!v || v.verdict !== 'PASS') throw new WolfContractError('NO_INDEPENDENT_PASS', commitSha);
    const unknown = Object.values(doc.effects).filter((e) => e.missionId === missionId && e.status === 'UNKNOWN');
    if (unknown.length) throw new WolfContractError('UNRECONCILED_EFFECT', `${unknown.length} UNKNOWN`);
    m.published = commitSha;
    return { authorized: true, commitSha, fence };
  });
}

/**
 * Economic admission. Zero-cost policy: cost must be exactly 0 and known.
 * Unknown cost is denied (COST_UNKNOWN=DENY). Any paid fallback is denied.
 */
export function admitEconomic({ costUsd, paidFallback = false, trialCredit = false }) {
  if (trialCredit) return { admitted: false, reason: 'TRIAL_CREDIT=DENY' };
  if (paidFallback) return { admitted: false, reason: 'PAID_FALLBACK=DENY' };
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd)) return { admitted: false, reason: 'COST_UNKNOWN=DENY' };
  if (costUsd !== 0) return { admitted: false, reason: 'EUR_SPEND=0' };
  return { admitted: true, reason: 'ZERO_COST' };
}

/** Record an external effect. Starts UNKNOWN unless a verified receipt is given. */
export async function recordExternalEffect(store, { effectId, missionId, fence, receipt = null }) {
  return store.transact((doc) => {
    requireFence(doc, missionId, fence);
    if (doc.effects[effectId]) throw new WolfContractError('EFFECT_EXISTS', effectId);
    doc.effects[effectId] = {
      missionId, fence,
      status: receipt ? 'CONFIRMED' : 'UNKNOWN',
      receipt: receipt ?? null,
    };
    return doc.effects[effectId];
  });
}

/**
 * Reconcile an UNKNOWN effect only with positive evidence. Absence of evidence
 * keeps it UNKNOWN; this never replays or retries the effect.
 */
export async function reconcileExternalEffect(store, { effectId, evidence }) {
  return store.transact((doc) => {
    const e = doc.effects[effectId];
    if (!e) throw new WolfContractError('NO_EFFECT', effectId);
    if (e.status !== 'UNKNOWN') return e;
    if (evidence && evidence.kind === 'RECEIPT' && evidence.effectId === effectId) {
      e.status = 'CONFIRMED';
      e.receipt = evidence;
    } else if (evidence && evidence.kind === 'ABSENT_WITH_AUTHORITATIVE_AUDIT') {
      e.status = 'NOT_PERFORMED';
      e.receipt = evidence;
    }
    return e;
  });
}
