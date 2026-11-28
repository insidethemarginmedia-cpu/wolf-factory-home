// Local, restartable execution-state model for synthetic missions.
//
// This deliberately extends the existing journal instead of adding another
// controller or queue. It exercises atomic persistence, lease/fence transitions,
// callback authentication, idempotency, recovery and terminal receipts on one
// persistent filesystem. It is NOT wired into a production workflow or worker:
// GitHub-hosted runners are ephemeral, the upstream callback contract is not
// approved, and no local file is an independent acceptance source.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, createPublicKey, randomUUID, verify as verifyEd25519} from 'node:crypto';
import {RETRY_POLICY} from './private-ci-mission.mjs';

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const KEY = /^[a-f0-9]{32}$/;
const OWNER = /^[A-Za-z0-9._:@/-]{1,160}$/;
const SAFE_REASON = /^[A-Z0-9][A-Z0-9_:-]{0,95}$/;
const CALLBACK_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const WORKER_KEY_ID = /^[A-Za-z0-9._:-]{1,96}$/;
const CALLBACK_FIELDS = new Set([
  'schema', 'callbackId', 'requestKey', 'idempotencyKey', 'targetDigest',
  'executorSha', 'fence', 'outcome', 'resultDigest', 'occurredAt',
  'workerKeyId', 'signature',
]);
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export const JOURNAL_SCHEMA = 'wolf.private-ci.journal/v2';
export const CALLBACK_SCHEMA = 'wolf.worker.callback/v1';
export const RECEIPT_SCHEMA = 'wolf.execution.receipt/v1';
export const JOURNAL_STATES = Object.freeze([
  'pending', 'leased', 'reconciling', 'completed', 'cancelled', 'failed', 'timed_out',
]);
export const TERMINAL_STATES = Object.freeze(['completed', 'cancelled', 'failed', 'timed_out']);
export const JOURNAL_POLICY = Object.freeze({
  leaseMs: 60_000,
  maxLeaseMs: 5 * 60_000,
  maxAttempts: RETRY_POLICY.maxAttempts,
  staleLockMs: 1_000,
});

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
}

function digest(value) {
  const input = Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : stableJson(value);
  return createHash('sha256').update(input).digest('hex');
}

function timeMs(value, reason = 'JOURNAL_TIME_INVALID') {
  const result = value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value
      : Date.parse(String(value ?? ''));
  if (!Number.isFinite(result)) throw Error(reason);
  return result;
}

function iso(value = Date.now()) {
  return new Date(timeMs(value)).toISOString();
}

function normalizeRepository(value) {
  const repository = String(value ?? '').trim().toLowerCase();
  if (!REPOSITORY.test(repository)) throw Error('JOURNAL_REPOSITORY_MALFORMED');
  return repository;
}

export function normalizeJournalSha(value) {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!SHA1.test(sha)) throw Error('JOURNAL_SHA_MALFORMED');
  return sha;
}

export function normalizeExecutorSha(value) {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!SHA1.test(sha)) throw Error('JOURNAL_EXECUTOR_SHA_MALFORMED');
  return sha;
}

export function requestKey({repository, sha}) {
  const normalizedRepository = normalizeRepository(repository);
  return createHash('sha256')
    .update(`${normalizedRepository}@${normalizeJournalSha(sha)}`)
    .digest('hex')
    .slice(0, 32);
}

export function requestIdempotencyKey({repository, sha}) {
  return digest(`wolf-factory/home/idempotency/v1:${normalizeRepository(repository)}@${normalizeJournalSha(sha)}`);
}

export function targetBindingDigest({repository, sha}) {
  return digest(`wolf-factory/home/target-binding/v1:${normalizeRepository(repository)}@${normalizeJournalSha(sha)}`);
}

function emptyJournal() {
  return {schema: JOURNAL_SCHEMA, requests: {}, order: [], receipts: []};
}

function receiptHash(record) {
  const copy = {...record};
  delete copy.hash;
  return digest(copy);
}

export function verifyReceiptChain(journal) {
  if (!Array.isArray(journal?.receipts)) return {state: 'TAMPERED', reason: 'RECEIPTS_MISSING', count: 0};
  let previous = null;
  const callbacks = new Set();
  for (let index = 0; index < journal.receipts.length; index += 1) {
    const record = journal.receipts[index];
    if (!isObject(record) || record.schema !== RECEIPT_SCHEMA
        || record.sequence !== index + 1
        || record.previousHash !== previous
        || !SHA256.test(String(record.hash ?? ''))
        || record.hash !== receiptHash(record)
        || !KEY.test(String(record.requestKey ?? ''))
        || !SHA256.test(String(record.idempotencyKey ?? ''))
        || !SHA256.test(String(record.targetDigest ?? ''))
        || !SHA1.test(String(record.executorSha ?? ''))
        || !Number.isSafeInteger(record.fence) || record.fence < 0
        || !['LIFECYCLE', 'LOCAL_TERMINAL', 'LEASE_RECOVERY', 'AUTHENTICATED_CALLBACK'].includes(record.event)
        || typeof record.outcome !== 'string' || !SAFE_REASON.test(record.outcome)
        || !JOURNAL_STATES.includes(record.resultingState)
        || typeof record.terminal !== 'boolean'
        || record.terminal !== TERMINAL_STATES.includes(record.resultingState)
        || (record.reason !== null && !SAFE_REASON.test(String(record.reason)))
        || !SHA256.test(String(record.resultDigest ?? ''))
        || (record.callbackId !== null && !CALLBACK_ID.test(String(record.callbackId)))
        || (record.callbackDigest !== null && !SHA256.test(String(record.callbackDigest)))
        || (record.workerIdentityDigest !== null && !SHA256.test(String(record.workerIdentityDigest)))
        || typeof record.recordedAt !== 'string' || !Number.isFinite(Date.parse(record.recordedAt))) {
      return {state: 'TAMPERED', reason: 'RECEIPT_SHAPE_OR_HASH_INVALID', count: index};
    }
    if (record.callbackId !== null) {
      if (!CALLBACK_ID.test(String(record.callbackId)) || callbacks.has(record.callbackId)) {
        return {state: 'TAMPERED', reason: 'CALLBACK_ID_REUSED', count: index};
      }
      callbacks.add(record.callbackId);
    }
    previous = record.hash;
  }
  return {state: 'INTACT', count: journal.receipts.length, head: previous};
}

function assertJournalShape(journal) {
  if (!isObject(journal) || journal.schema !== JOURNAL_SCHEMA
      || !isObject(journal.requests) || !Array.isArray(journal.order)
      || !Array.isArray(journal.receipts)) throw Error('JOURNAL_CORRUPT');
  const seen = new Set();
  for (const key of journal.order) {
    if (!KEY.test(String(key)) || seen.has(key) || !Object.hasOwn(journal.requests, key)) throw Error('JOURNAL_CORRUPT');
    seen.add(key);
  }
  if (seen.size !== Object.keys(journal.requests).length) throw Error('JOURNAL_CORRUPT');
  for (const [key, request] of Object.entries(journal.requests)) {
    if (!isObject(request) || request.key !== key || !JOURNAL_STATES.includes(request.state)
        || !REPOSITORY.test(String(request.repository ?? ''))
        || !SHA1.test(String(request.sha ?? ''))
        || (request.executorSha !== null && !SHA1.test(String(request.executorSha ?? '')))
        || !SHA256.test(String(request.idempotencyKey ?? ''))
        || !SHA256.test(String(request.targetDigest ?? ''))
        || !Number.isSafeInteger(request.fence) || request.fence < 0
        || !Number.isSafeInteger(request.attempts) || request.attempts < 0) throw Error('JOURNAL_CORRUPT');
  }
  const receiptCheck = verifyReceiptChain(journal);
  if (receiptCheck.state !== 'INTACT') throw Error('JOURNAL_RECEIPT_CHAIN_INVALID');
}

function migrateV1(parsed) {
  if (!isObject(parsed.requests) || Array.isArray(parsed.requests)) throw Error('JOURNAL_CORRUPT');
  const migrated = emptyJournal();
  const order = Array.isArray(parsed.order) ? parsed.order : Object.keys(parsed.requests);
  const keyMap = new Map();
  const migrationTime = iso();
  const migratedTimestamp = value => {
    try { return iso(timeMs(value)); } catch { return migrationTime; }
  };

  for (const [oldKey, old] of Object.entries(parsed.requests)) {
    if (!isObject(old)) throw Error('JOURNAL_CORRUPT');
    const repository = normalizeRepository(old.repository);
    const sha = normalizeJournalSha(old.sha);
    const key = requestKey({repository, sha});
    if (Object.hasOwn(migrated.requests, key)) throw Error('JOURNAL_CORRUPT');
    const oldState = validReason(old.state, 'UNKNOWN_LEGACY_STATE');
    const safelyPending = oldState === 'PENDING';
    const createdAt = migratedTimestamp(old.createdAt);
    migrated.requests[key] = {
      key,
      repository,
      sha,
      executorSha: null, // v1 did not pin an executor identity
      idempotencyKey: requestIdempotencyKey({repository, sha}),
      targetDigest: targetBindingDigest({repository, sha}),
      state: safelyPending ? 'pending' : 'reconciling',
      reason: validReason(old.reason, 'LEGACY_REASON_UNAVAILABLE'),
      runId: null,
      attempts: Number.isSafeInteger(old.attempts) && old.attempts >= 0 ? old.attempts : 0,
      dispatchAttempts: 0,
      observations: Number.isSafeInteger(old.observations) && old.observations > 0 ? old.observations : 1,
      createdAt,
      lastSeenAt: migratedTimestamp(old.lastSeenAt ?? old.createdAt),
      deadlineAt: null, // no v1 deadline is trusted for a new exact-SHA attempt
      fence: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      leaseStartedAt: null,
      effectState: safelyPending ? 'NOT_STARTED' : 'UNKNOWN',
      dispatchedAt: null,
      cancellation: null,
      lastLeaseOwner: null,
      reconciliation: safelyPending ? null : {
        reason: 'LEGACY_STATE_HAS_NO_FENCED_RECEIPT',
        previousState: oldState,
        at: migrationTime,
      },
      lastReceiptHash: null,
    };
    keyMap.set(oldKey, key);
  }

  migrated.order = order.map(oldKey => keyMap.get(oldKey)).filter(Boolean);
  for (const key of Object.keys(migrated.requests)) if (!migrated.order.includes(key)) migrated.order.push(key);
  assertJournalShape(migrated);
  return migrated;
}

function checksumSnapshot(snapshot) {
  const body = {...snapshot};
  delete body.integrity;
  return digest(body);
}

export function readJournal(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyJournal();
    throw Error('JOURNAL_UNREADABLE');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Error('JOURNAL_CORRUPT');
  }
  if (!isObject(parsed)) throw Error('JOURNAL_CORRUPT');
  if (parsed.schema === 'wolf.private-ci.journal/v1') return migrateV1(parsed);
  if (parsed.schema !== JOURNAL_SCHEMA || !isObject(parsed.integrity)
      || parsed.integrity.algorithm !== 'SHA-256'
      || parsed.integrity.digest !== checksumSnapshot(parsed)) throw Error('JOURNAL_INTEGRITY_FAILED');
  const journal = {...parsed};
  delete journal.integrity;
  assertJournalShape(journal);
  journal.integrity = parsed.integrity;
  return journal;
}

export function writeJournal(file, journal) {
  const snapshot = {...journal, schema: JOURNAL_SCHEMA, receipts: Array.isArray(journal.receipts) ? journal.receipts : []};
  delete snapshot.integrity;
  assertJournalShape(snapshot);
  snapshot.integrity = {algorithm: 'SHA-256', digest: checksumSnapshot(snapshot)};
  const directory = path.dirname(file);
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    try {
      const directoryFd = fs.openSync(directory, 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    } catch {
      // Some filesystems do not support fsync on a directory. The file itself
      // was still fsynced before its atomic rename.
    }
    Object.assign(journal, snapshot);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch { /* renamed or absent */ }
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function acquireJournalLock(file, {staleLockMs = JOURNAL_POLICY.staleLockMs, now = Date.now()} = {}) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const lockPath = `${file}.lock`;
  const ownerToken = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      const metadata = {pid: process.pid, ownerToken, acquiredAt: iso(now)};
      fs.writeFileSync(descriptor, JSON.stringify(metadata) + '\n', 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      return () => {
        try {
          const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          if (current.ownerToken === ownerToken) fs.unlinkSync(lockPath);
        } catch { /* never remove a lock we cannot prove this transaction owns */ }
      };
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (error?.code !== 'EEXIST') throw Error('JOURNAL_LOCK_FAILED');
      let stale = false;
      try {
        const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        const age = timeMs(now) - timeMs(existing.acquiredAt);
        stale = age >= staleLockMs && !processIsAlive(Number(existing.pid));
      } catch {
        // Malformed lock metadata is not permission to steal the lock.
      }
      if (!stale) throw Error('JOURNAL_LOCKED');
      try { fs.unlinkSync(lockPath); } catch { throw Error('JOURNAL_LOCKED'); }
    }
  }
  throw Error('JOURNAL_LOCKED');
}

/** Serialize a read/modify/write cycle across resident processes on one filesystem. */
export function transactJournal(file, mutator, options = {}) {
  if (typeof mutator !== 'function') throw Error('JOURNAL_MUTATOR_REQUIRED');
  const release = acquireJournalLock(file, options);
  try {
    const journal = readJournal(file);
    const result = mutator(journal);
    if (result && typeof result.then === 'function') throw Error('JOURNAL_MUTATOR_MUST_BE_SYNCHRONOUS');
    writeJournal(file, journal);
    return result;
  } finally {
    release();
  }
}

function validReason(value, fallback = 'UNSPECIFIED') {
  const reason = String(value ?? fallback).toUpperCase();
  return SAFE_REASON.test(reason) ? reason : fallback;
}

function appendReceipt(journal, request, {
  event = 'LIFECYCLE', outcome,
  resultingState = request.state,
  terminal = false,
  reason = null,
  resultDigest = null,
  callbackId = null,
  callbackDigest = null,
  workerIdentityDigest = null,
  fence = request.fence,
  recordedAt = Date.now(),
} = {}) {
  const timestamp = iso(recordedAt);
  const safeReason = reason === null ? null : validReason(reason);
  const result = {
    schema: RECEIPT_SCHEMA,
    sequence: journal.receipts.length + 1,
    previousHash: journal.receipts.at(-1)?.hash ?? null,
    event,
    requestKey: request.key,
    targetDigest: request.targetDigest,
    idempotencyKey: request.idempotencyKey,
    executorSha: request.executorSha,
    fence,
    outcome,
    resultingState,
    terminal,
    reason: safeReason,
    resultDigest: resultDigest ?? digest({requestKey: request.key, fence, outcome, state: resultingState, reason: safeReason}),
    callbackId,
    callbackDigest,
    workerIdentityDigest,
    recordedAt: timestamp,
  };
  result.hash = receiptHash(result);
  journal.receipts.push(result);
  request.lastReceiptHash = result.hash;
  return result;
}

function clearLease(request) {
  request.leaseOwner = null;
  request.leaseExpiresAt = null;
  request.heartbeatAt = null;
}

function terminalizeWithoutCallback(journal, request, state, reason, now) {
  if (!TERMINAL_STATES.includes(state)) throw Error('JOURNAL_TERMINAL_STATE_INVALID');
  request.state = state;
  request.terminalAt = iso(now);
  request.terminalReason = validReason(reason);
  clearLease(request);
  return appendReceipt(journal, request, {
    event: 'LOCAL_TERMINAL',
    outcome: state.toUpperCase(),
    resultingState: state,
    terminal: true,
    reason: request.terminalReason,
    recordedAt: now,
  });
}

export function enqueueRequest(journal, {
  repository, sha, executorSha, timeoutMs,
  reason = 'push', runId = null, now = new Date().toISOString(),
} = {}) {
  const normalizedRepository = normalizeRepository(repository);
  const normalizedSha = normalizeJournalSha(sha);
  const normalizedExecutorSha = normalizeExecutorSha(executorSha);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw Error('JOURNAL_TIMEOUT_REQUIRED');
  const createdAtMs = timeMs(now);
  if (!Number.isSafeInteger(createdAtMs + timeoutMs)) throw Error('JOURNAL_TIMEOUT_INVALID');
  const key = requestKey({repository: normalizedRepository, sha: normalizedSha});
  const existing = journal.requests[key];
  if (existing) {
    if (existing.executorSha !== normalizedExecutorSha || existing.idempotencyKey !== requestIdempotencyKey({repository: normalizedRepository, sha: normalizedSha})) {
      return {state: 'CONFLICT', key, reason: 'DUPLICATE_BINDING_MISMATCH'};
    }
    existing.observations = (existing.observations ?? 0) + 1;
    existing.lastSeenAt = iso(now);
    if (reason) existing.reason = validReason(reason);
    return {state: 'DUPLICATE', key, request: existing};
  }
  const request = {
    key,
    repository: normalizedRepository,
    sha: normalizedSha,
    executorSha: normalizedExecutorSha,
    targetDigest: targetBindingDigest({repository: normalizedRepository, sha: normalizedSha}),
    idempotencyKey: requestIdempotencyKey({repository: normalizedRepository, sha: normalizedSha}),
    state: 'pending',
    reason: validReason(reason),
    runId: runId === null ? null : String(runId),
    attempts: 0,
    dispatchAttempts: 0,
    observations: 1,
    createdAt: iso(now),
    lastSeenAt: iso(now),
    deadlineAt: new Date(createdAtMs + timeoutMs).toISOString(),
    fence: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    leaseStartedAt: null,
    effectState: 'NOT_STARTED',
    dispatchedAt: null,
    cancellation: null,
    lastLeaseOwner: null,
    reconciliation: null,
    lastReceiptHash: null,
  };
  journal.requests[key] = request;
  journal.order.push(key);
  appendReceipt(journal, request, {
    event: 'LIFECYCLE',
    outcome: 'REQUEST_ENQUEUED',
    resultingState: 'pending',
    terminal: false,
    reason: request.reason,
    recordedAt: createdAtMs,
  });
  return {state: 'ENQUEUED', key, request};
}

function validateLeaseMs(leaseMs) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > JOURNAL_POLICY.maxLeaseMs) {
    throw Error('JOURNAL_LEASE_DURATION_INVALID');
  }
}

function requestDeadline(request) {
  return request.deadlineAt ? Date.parse(request.deadlineAt) : NaN;
}

function safeNoEffectRecovery(journal, request, {reason, now, terminalState = null} = {}) {
  const oldOwner = request.leaseOwner;
  request.lastLeaseOwner = oldOwner ?? request.lastLeaseOwner ?? null;
  request.recovery = {reason: validReason(reason), at: iso(now), previousFence: request.fence};
  clearLease(request);
  if (terminalState) {
    return terminalizeWithoutCallback(journal, request, terminalState, reason, now);
  }
  request.state = 'pending';
  request.effectState = 'NOT_STARTED';
  return appendReceipt(journal, request, {
    event: 'LEASE_RECOVERY',
    outcome: 'NO_DISPATCH_PROVEN',
    resultingState: 'pending',
    terminal: false,
    reason,
    recordedAt: now,
  });
}

export function recoverExpiredLeases(journal, {now = Date.now()} = {}) {
  const current = timeMs(now);
  const recovered = [];
  for (const request of Object.values(journal.requests)) {
    if (request.state === 'pending') {
      const deadline = requestDeadline(request);
      if (Number.isFinite(deadline) && deadline <= current) {
        terminalizeWithoutCallback(journal, request, 'timed_out', 'DEADLINE_EXPIRED_BEFORE_START', current);
        recovered.push({key: request.key, state: 'TIMED_OUT'});
      }
      continue;
    }
    if (request.state !== 'leased') continue;
    const leaseExpiry = request.leaseExpiresAt ? Date.parse(request.leaseExpiresAt) : NaN;
    const deadline = requestDeadline(request);
    const deadlineElapsed = Number.isFinite(deadline) && deadline <= current;
    const leaseElapsed = !Number.isFinite(leaseExpiry) || leaseExpiry <= current;
    if (!leaseElapsed && !deadlineElapsed) continue;

    if (request.effectState === 'NOT_STARTED') {
      const cancelRequested = Boolean(request.cancellation?.requestedAt);
      const terminalState = cancelRequested ? 'cancelled' : deadlineElapsed ? 'timed_out' : null;
      const reason = cancelRequested ? 'CANCELLED_BEFORE_DISPATCH'
        : deadlineElapsed ? 'DEADLINE_EXPIRED_BEFORE_DISPATCH' : 'LEASE_EXPIRED_BEFORE_DISPATCH';
      safeNoEffectRecovery(journal, request, {reason, now: current, terminalState});
      recovered.push({key: request.key, state: terminalState ? terminalState.toUpperCase() : 'REQUEUED_NO_EFFECT'});
      continue;
    }

    request.lastLeaseOwner = request.leaseOwner ?? request.lastLeaseOwner ?? null;
    request.state = 'reconciling';
    request.reconciliation = {
      reason: deadlineElapsed ? 'DEADLINE_ELAPSED_OUTCOME_UNKNOWN' : 'LEASE_EXPIRED_OUTCOME_UNKNOWN',
      fence: request.fence,
      at: iso(current),
      cancellationRequested: Boolean(request.cancellation?.requestedAt),
    };
    clearLease(request);
    appendReceipt(journal, request, {
      event: 'LEASE_RECOVERY',
      outcome: 'EFFECT_OUTCOME_UNKNOWN',
      resultingState: 'reconciling',
      terminal: false,
      reason: request.reconciliation.reason,
      recordedAt: current,
    });
    recovered.push({key: request.key, state: 'RECONCILING'});
  }
  return {
    state: recovered.some(entry => entry.state === 'RECONCILING') ? 'RECONCILIATION_REQUIRED'
      : recovered.length ? 'RECOVERED' : 'NOOP',
    recovered,
  };
}

export function claimNext(journal, {
  owner, leaseMs = JOURNAL_POLICY.leaseMs, now = Date.now(),
  approvedExecutorShas = [], maxAttempts = JOURNAL_POLICY.maxAttempts,
} = {}) {
  if (typeof owner !== 'string' || !OWNER.test(owner)) throw Error('JOURNAL_OWNER_REQUIRED');
  validateLeaseMs(leaseMs);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw Error('JOURNAL_MAX_ATTEMPTS_INVALID');
  const current = timeMs(now);
  recoverExpiredLeases(journal, {now: current});

  const active = Object.values(journal.requests).find(request => request.state === 'leased');
  if (active) return {state: 'BUSY', key: active.key, reason: 'EXECUTION_LEASE_ACTIVE'};
  const unresolved = Object.values(journal.requests).find(request => request.state === 'reconciling');
  if (unresolved) return {state: 'RECONCILIATION_REQUIRED', key: unresolved.key, reason: unresolved.reconciliation?.reason ?? 'OUTCOME_UNKNOWN'};

  const key = journal.order.find(item => journal.requests[item]?.state === 'pending');
  if (!key) return {state: 'IDLE'};
  const request = journal.requests[key];
  const deadline = requestDeadline(request);
  if (!Number.isFinite(deadline)) return {state: 'BLOCKED', key, reason: 'EXECUTION_DEADLINE_REQUIRED'};
  if (deadline <= current) {
    recoverExpiredLeases(journal, {now: current});
    return {state: 'BLOCKED', key, reason: 'EXECUTION_DEADLINE_EXPIRED'};
  }
  const approved = new Set(Array.isArray(approvedExecutorShas)
    ? approvedExecutorShas.filter(value => SHA1.test(String(value))).map(value => String(value).toLowerCase()) : []);
  if (!request.executorSha || !approved.has(request.executorSha)) {
    return {state: 'BLOCKED', key, reason: 'EXECUTOR_SHA_NOT_APPROVED'};
  }
  if (request.attempts >= maxAttempts) {
    terminalizeWithoutCallback(journal, request, 'failed', 'MAX_ATTEMPTS_EXHAUSTED', current);
    return {state: 'BLOCKED', key, reason: 'MAX_ATTEMPTS_EXHAUSTED'};
  }

  request.fence += 1;
  request.state = 'leased';
  request.leaseOwner = owner;
  request.leaseStartedAt = iso(current);
  request.leaseExpiresAt = new Date(Math.min(current + leaseMs, deadline)).toISOString();
  request.heartbeatAt = iso(current);
  request.attempts += 1;
  request.effectState = 'NOT_STARTED';
  request.dispatchedAt = null;
  request.reconciliation = null;
  appendReceipt(journal, request, {
    event: 'LIFECYCLE',
    outcome: 'LEASE_CLAIMED',
    resultingState: 'leased',
    terminal: false,
    recordedAt: current,
  });
  return {
    state: 'CLAIMED',
    key,
    fence: request.fence,
    idempotencyKey: request.idempotencyKey,
    targetDigest: request.targetDigest,
    executorSha: request.executorSha,
    leaseExpiresAt: request.leaseExpiresAt,
    deadlineAt: request.deadlineAt,
    request,
  };
}

function checkLease(request, {owner, fence, now}) {
  if (!request) return 'REQUEST_ABSENT';
  if (request.state !== 'leased') return request.state === 'reconciling' ? 'RECONCILIATION_REQUIRED' : 'LEASE_NOT_ACTIVE';
  if (request.leaseOwner !== owner) return 'LEASE_OWNER_MISMATCH';
  if (!Number.isSafeInteger(fence) || fence !== request.fence) return 'STALE_FENCE';
  const expiry = request.leaseExpiresAt ? Date.parse(request.leaseExpiresAt) : NaN;
  if (!Number.isFinite(expiry) || expiry <= now) return 'LEASE_EXPIRED';
  const deadline = requestDeadline(request);
  if (!Number.isFinite(deadline) || deadline <= now) return 'EXECUTION_DEADLINE_EXPIRED';
  return null;
}

export function heartbeat(journal, {key, owner, fence, leaseMs = JOURNAL_POLICY.leaseMs, now = Date.now()} = {}) {
  validateLeaseMs(leaseMs);
  const request = journal.requests[key];
  if (!request) return {state: 'DENIED', reason: 'REQUEST_ABSENT'};
  const current = timeMs(now);
  const failure = checkLease(request, {owner, fence, now: current});
  if (failure) {
    if (failure === 'LEASE_EXPIRED' || failure === 'EXECUTION_DEADLINE_EXPIRED') recoverExpiredLeases(journal, {now: current});
    return {state: 'DENIED', reason: failure, key, currentFence: request.fence, currentState: request.state};
  }
  if (request.cancellation?.requestedAt) return {state: 'CANCEL_REQUESTED', key, fence: request.fence, leaseExpiresAt: request.leaseExpiresAt};
  const deadline = requestDeadline(request);
  request.heartbeatAt = iso(current);
  request.leaseExpiresAt = new Date(Math.min(current + leaseMs, deadline)).toISOString();
  return {state: 'RENEWED', key, fence, heartbeatAt: request.heartbeatAt, leaseExpiresAt: request.leaseExpiresAt};
}

export function beginDispatch(journal, {key, owner, fence, now = Date.now()} = {}) {
  const request = journal.requests[key];
  const current = timeMs(now);
  const failure = checkLease(request, {owner, fence, now: current});
  if (failure) return {state: 'DENIED', reason: failure, key, currentFence: request?.fence ?? null};
  if (request.cancellation?.requestedAt) return {state: 'DENIED', reason: 'CANCELLATION_REQUESTED', key};
  if (request.effectState === 'STARTED') {
    return {state: 'DUPLICATE', reason: 'IDEMPOTENT_DISPATCH_ALREADY_MARKED', key, fence, idempotencyKey: request.idempotencyKey};
  }
  if (request.effectState !== 'NOT_STARTED') return {state: 'DENIED', reason: 'EFFECT_STATE_INVALID', key};
  request.effectState = 'STARTED';
  request.dispatchedAt = iso(current);
  request.dispatchAttempts += 1;
  appendReceipt(journal, request, {
    event: 'LIFECYCLE',
    outcome: 'DISPATCH_MARKED',
    resultingState: 'leased',
    terminal: false,
    recordedAt: current,
  });
  return {
    state: 'DISPATCH_MARKED',
    key,
    fence,
    idempotencyKey: request.idempotencyKey,
    targetDigest: request.targetDigest,
    executorSha: request.executorSha,
    deadlineAt: request.deadlineAt,
  };
}

export function cancelRequest(journal, {
  repository, sha, key: suppliedKey, reason = 'CANCELLED_BY_OPERATOR', now = Date.now(),
} = {}) {
  const key = suppliedKey ?? requestKey({repository, sha});
  const request = journal.requests[key];
  if (!request) return {state: 'ABSENT', key};
  if (request.state === 'completed') return {state: 'DENIED', key, reason: 'REQUEST_ALREADY_COMPLETED'};
  if (TERMINAL_STATES.includes(request.state)) return {state: 'DUPLICATE', key, request};
  const safe = validReason(reason, 'CANCELLED_BY_OPERATOR');
  const current = timeMs(now);
  if (!request.cancellation?.requestedAt) {
    request.cancellation = {reason: safe, requestedAt: iso(current)};
    appendReceipt(journal, request, {
      event: 'LIFECYCLE',
      outcome: 'CANCEL_REQUESTED',
      resultingState: request.state,
      terminal: false,
      reason: safe,
      recordedAt: current,
    });
  }
  if (request.state === 'pending' || (request.state === 'leased' && request.effectState === 'NOT_STARTED')) {
    terminalizeWithoutCallback(journal, request, 'cancelled', 'CANCELLED_BEFORE_DISPATCH', current);
    return {state: 'CANCELLED', key, request};
  }
  return {state: 'CANCEL_REQUESTED', key, fence: request.fence, request};
}

export function settleRequest(journal, {key, owner, fence, state, reason = 'LOCAL_EXECUTION_FAILED', now = Date.now()} = {}) {
  const current = timeMs(now);
  if (!['failed', 'cancelled', 'timed_out'].includes(state)) {
    return {state: 'DENIED', key, reason: 'VERIFIED_CALLBACK_REQUIRED'};
  }
  const request = journal.requests[key];
  const failure = checkLease(request, {owner, fence, now: current});
  if (failure) return {state: 'DENIED', key, reason: failure};
  if (request.effectState !== 'NOT_STARTED') return {state: 'DENIED', key, reason: 'RECONCILIATION_REQUIRED'};
  if (state === 'cancelled' && !request.cancellation?.requestedAt) return {state: 'DENIED', key, reason: 'CANCELLATION_NOT_REQUESTED'};
  if (state === 'timed_out' && requestDeadline(request) > current) return {state: 'DENIED', key, reason: 'EXECUTION_DEADLINE_NOT_REACHED'};
  terminalizeWithoutCallback(journal, request, state, reason, current);
  return {state: state.toUpperCase(), key, request};
}

function normalizeCallback(callback, {requireSignature = true} = {}) {
  if (!isObject(callback) || Object.keys(callback).some(field => !CALLBACK_FIELDS.has(field))
      || callback.schema !== CALLBACK_SCHEMA
      || !CALLBACK_ID.test(String(callback.callbackId ?? ''))
      || !KEY.test(String(callback.requestKey ?? ''))
      || !SHA256.test(String(callback.idempotencyKey ?? ''))
      || !SHA256.test(String(callback.targetDigest ?? ''))
      || !SHA1.test(String(callback.executorSha ?? ''))
      || !Number.isSafeInteger(callback.fence) || callback.fence < 1
      || !['COMPLETED', 'FAILED', 'CANCELLED', 'NO_EFFECT'].includes(callback.outcome)
      || !SHA256.test(String(callback.resultDigest ?? ''))
      || !WORKER_KEY_ID.test(String(callback.workerKeyId ?? ''))
      || typeof callback.occurredAt !== 'string' || !Number.isFinite(Date.parse(callback.occurredAt))
      || (requireSignature && (typeof callback.signature !== 'string' || !/^[A-Za-z0-9_-]{80,100}$/.test(callback.signature)))) {
    throw Error('CALLBACK_SHAPE_INVALID');
  }
  return {
    schema: CALLBACK_SCHEMA,
    callbackId: callback.callbackId,
    requestKey: callback.requestKey,
    idempotencyKey: callback.idempotencyKey,
    targetDigest: callback.targetDigest,
    executorSha: callback.executorSha,
    fence: callback.fence,
    outcome: callback.outcome,
    resultDigest: callback.resultDigest,
    occurredAt: new Date(Date.parse(callback.occurredAt)).toISOString(),
    workerKeyId: callback.workerKeyId,
  };
}

/** Bytes signed by a worker for the proposed, public-safe callback envelope. */
export function canonicalCallbackBytes(callback) {
  const payload = normalizeCallback(callback, {requireSignature: false});
  return Buffer.from('wolf-factory/home/worker-callback/v1\n' + stableJson(payload), 'utf8');
}

export function verifyWorkerCallback(callback, {trustedWorkerKeys = {}} = {}) {
  let payload;
  try { payload = normalizeCallback(callback); } catch (error) {
    return {verified: false, reason: error?.message ?? 'CALLBACK_SHAPE_INVALID'};
  }
  const encodedKey = isObject(trustedWorkerKeys) && Object.hasOwn(trustedWorkerKeys, payload.workerKeyId)
    ? trustedWorkerKeys[payload.workerKeyId] : null;
  if (!encodedKey) return {verified: false, reason: 'CALLBACK_WORKER_KEY_UNTRUSTED'};
  let key;
  try {
    if (typeof encodedKey !== 'string' || !encodedKey.includes('-----BEGIN PUBLIC KEY-----')) {
      return {verified: false, reason: 'CALLBACK_WORKER_KEY_INVALID'};
    }
    key = createPublicKey(encodedKey);
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
      return {verified: false, reason: 'CALLBACK_WORKER_KEY_INVALID'};
    }
  } catch {
    return {verified: false, reason: 'CALLBACK_WORKER_KEY_INVALID'};
  }
  let signature;
  try { signature = Buffer.from(callback.signature, 'base64url'); } catch {
    return {verified: false, reason: 'CALLBACK_SIGNATURE_INVALID'};
  }
  if (signature.length !== 64) return {verified: false, reason: 'CALLBACK_SIGNATURE_INVALID'};
  try {
    const verified = verifyEd25519(null, canonicalCallbackBytes(payload), key, signature);
    if (!verified) return {verified: false, reason: 'CALLBACK_SIGNATURE_INVALID'};
  } catch {
    return {verified: false, reason: 'CALLBACK_SIGNATURE_INVALID'};
  }
  const publicKeyDigest = digest(Buffer.concat([
    Buffer.from(`wolf-factory/home/worker-public-key/v1:${payload.workerKeyId}:`, 'utf8'),
    key.export({type: 'spki', format: 'der'}),
  ]));
  return {
    verified: true,
    workerIdentityDigest: publicKeyDigest,
    callbackDigest: digest(canonicalCallbackBytes(payload)),
    callback: payload,
  };
}

export function acceptWorkerCallback(journal, {callback, trustedWorkerKeys = {}, now = Date.now()} = {}) {
  const integrity = verifyReceiptChain(journal);
  if (integrity.state !== 'INTACT') return {state: 'BLOCKED', reason: 'RECEIPT_CHAIN_TAMPERED'};
  const verified = verifyWorkerCallback(callback, {trustedWorkerKeys});
  if (!verified.verified) return {state: 'DENIED', reason: verified.reason};
  const payload = verified.callback;
  const current = timeMs(now);
  const existingById = journal.receipts.find(receipt => receipt.callbackId === payload.callbackId);
  if (existingById) {
    if (existingById.callbackDigest === verified.callbackDigest
        && existingById.workerIdentityDigest === verified.workerIdentityDigest) {
      return {state: 'DUPLICATE', key: payload.requestKey, receiptHash: existingById.hash, terminal: existingById.terminal};
    }
    return {state: 'DENIED', reason: 'CALLBACK_ID_CONFLICT', key: payload.requestKey};
  }

  const request = journal.requests[payload.requestKey];
  if (!request) return {state: 'DENIED', reason: 'CALLBACK_REQUEST_UNKNOWN'};
  if (payload.idempotencyKey !== request.idempotencyKey) return {state: 'DENIED', reason: 'CALLBACK_IDEMPOTENCY_MISMATCH'};
  if (payload.targetDigest !== request.targetDigest) return {state: 'DENIED', reason: 'CALLBACK_TARGET_MISMATCH'};
  if (payload.executorSha !== request.executorSha) return {state: 'DENIED', reason: 'CALLBACK_EXECUTOR_MISMATCH'};
  if (payload.fence !== request.fence) return {state: 'DENIED', reason: 'CALLBACK_STALE_FENCE'};
  if (!['leased', 'reconciling'].includes(request.state)) {
    const priorTerminal = journal.receipts.find(receipt => receipt.requestKey === request.key && receipt.terminal);
    if (priorTerminal && priorTerminal.fence === payload.fence
        && priorTerminal.idempotencyKey === payload.idempotencyKey
        && priorTerminal.outcome === payload.outcome
        && priorTerminal.resultDigest === payload.resultDigest
        && priorTerminal.workerIdentityDigest === verified.workerIdentityDigest) {
      return {state: 'DUPLICATE', key: request.key, receiptHash: priorTerminal.hash, terminal: true};
    }
    return {state: 'DENIED', reason: 'REQUEST_NOT_RECONCILING', key: request.key};
  }
  if (request.effectState !== 'STARTED') return {state: 'DENIED', reason: 'CALLBACK_WITHOUT_DISPATCH', key: request.key};
  if (request.dispatchedAt && Date.parse(payload.occurredAt) < Date.parse(request.dispatchedAt)) {
    return {state: 'DENIED', reason: 'CALLBACK_PRECEDES_DISPATCH', key: request.key};
  }
  if (Date.parse(payload.occurredAt) > current + 5 * 60_000) return {state: 'DENIED', reason: 'CALLBACK_FROM_FUTURE', key: request.key};

  // An expired lease with a possibly-started side effect is only reconciled, never
  // re-dispatched. Keep its fence stable so a delayed, authentic callback can land.
  if (request.state === 'leased') {
    const expiry = request.leaseExpiresAt ? Date.parse(request.leaseExpiresAt) : NaN;
    const deadline = requestDeadline(request);
    if (!Number.isFinite(expiry) || expiry <= current || (Number.isFinite(deadline) && deadline <= current)) {
      recoverExpiredLeases(journal, {now: current});
    }
  }
  if (!['leased', 'reconciling'].includes(request.state)) return {state: 'DENIED', reason: 'REQUEST_NOT_RECONCILING', key: request.key};

  const cancellationRequested = Boolean(request.cancellation?.requestedAt);
  const deadlineElapsed = requestDeadline(request) <= current;
  let resultingState;
  let terminal;
  let reason = null;
  if (payload.outcome === 'COMPLETED') {
    resultingState = 'completed';
    terminal = true;
  } else if (payload.outcome === 'FAILED') {
    resultingState = 'failed';
    terminal = true;
    reason = 'WORKER_REPORTED_FAILURE';
  } else if (payload.outcome === 'CANCELLED') {
    resultingState = 'cancelled';
    terminal = true;
    reason = cancellationRequested ? 'CANCELLATION_ACKNOWLEDGED' : 'WORKER_CANCELLED';
  } else if (cancellationRequested) {
    resultingState = 'cancelled';
    terminal = true;
    reason = 'CANCELLED_NO_EFFECT_CONFIRMED';
  } else if (deadlineElapsed || request.attempts >= JOURNAL_POLICY.maxAttempts) {
    resultingState = deadlineElapsed ? 'timed_out' : 'failed';
    terminal = true;
    reason = deadlineElapsed ? 'DEADLINE_NO_EFFECT_CONFIRMED' : 'MAX_ATTEMPTS_EXHAUSTED';
  } else {
    resultingState = 'pending';
    terminal = false;
    reason = 'WORKER_CONFIRMED_NO_EFFECT';
  }

  request.state = resultingState;
  request.effectState = payload.outcome === 'NO_EFFECT' ? 'NO_EFFECT_CONFIRMED' : 'TERMINAL';
  request.terminalAt = terminal ? iso(current) : null;
  request.terminalReason = terminal && reason ? reason : null;
  request.reconciliation = null;
  request.lastCallbackId = payload.callbackId;
  request.lastCallbackDigest = verified.callbackDigest;
  clearLease(request);
  const receipt = appendReceipt(journal, request, {
    event: 'AUTHENTICATED_CALLBACK',
    outcome: payload.outcome,
    resultingState,
    terminal,
    reason,
    resultDigest: payload.resultDigest,
    callbackId: payload.callbackId,
    callbackDigest: verified.callbackDigest,
    workerIdentityDigest: verified.workerIdentityDigest,
    fence: payload.fence,
    recordedAt: current,
  });
  return {state: terminal ? 'TERMINAL_RECONCILED' : 'SAFE_TO_RETRY', key: request.key, requestState: request.state, receiptHash: receipt.hash, terminal};
}

export function reconcileJournal(journal, {now = Date.now()} = {}) {
  const chain = verifyReceiptChain(journal);
  if (chain.state !== 'INTACT') return {state: 'BLOCKED', reason: 'RECEIPT_CHAIN_TAMPERED', receiptCount: chain.count};
  const issues = [];
  const active = [];
  for (const request of Object.values(journal.requests)) {
    if (request.state === 'reconciling') issues.push({key: request.key, reason: request.reconciliation?.reason ?? 'OUTCOME_UNKNOWN'});
    if (request.state === 'leased') {
      const expires = request.leaseExpiresAt ? Date.parse(request.leaseExpiresAt) : NaN;
      if (!Number.isFinite(expires) || expires <= timeMs(now)) issues.push({key: request.key, reason: 'EXPIRED_LEASE_NOT_RECOVERED'});
      else active.push(request.key);
    }
    if (TERMINAL_STATES.includes(request.state)) {
      const receipt = journal.receipts.find(item => item.requestKey === request.key && item.terminal
        && item.resultingState === request.state && item.fence === request.fence);
      if (!receipt) issues.push({key: request.key, reason: 'TERMINAL_RECEIPT_MISSING'});
    }
  }
  return {
    state: issues.length ? 'RECONCILIATION_REQUIRED' : active.length ? 'ACTIVE' : 'CONSISTENT',
    issues,
    activeCount: active.length,
    pendingCount: Object.values(journal.requests).filter(request => request.state === 'pending').length,
    terminalCount: Object.values(journal.requests).filter(request => TERMINAL_STATES.includes(request.state)).length,
    receiptCount: chain.count,
    receiptHead: chain.head ?? null,
    liveAcceptance: false,
  };
}

export function summarizeJournal(journal, {limit = 20} = {}) {
  const requests = Object.values(journal.requests);
  const counts = Object.fromEntries(JOURNAL_STATES.map(state => [state, requests.filter(request => request.state === state).length]));
  const chain = verifyReceiptChain(journal);
  return {
    schema: journal.schema,
    total: requests.length,
    counts,
    receiptIntegrity: chain.state,
    receiptCount: chain.count,
    receiptHead: chain.head ?? null,
    recent: requests
      .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
      .slice(0, limit)
      .map(request => ({
        requestKey: request.key,
        targetDigest: request.targetDigest,
        executorSha: request.executorSha,
        state: request.state,
        fence: request.fence,
        attempts: request.attempts,
        dispatchAttempts: request.dispatchAttempts,
        reason: request.reason,
        reconciliationReason: request.reconciliation?.reason ?? null,
        createdAt: request.createdAt,
        settledAt: request.terminalAt ?? null,
      })),
    credentialsPrinted: false,
    privateSourcePublished: false,
    privateLogsPublished: false,
    liveAcceptance: false,
  };
}
