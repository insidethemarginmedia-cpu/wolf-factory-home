// Durable request journal, cancellation and recovery for the private CI bridge.
//
// Requests live in an append-only JSON file so a trigger that arrives while an
// execution is in flight is not lost. Everything is keyed by repository + SHA:
// a journal entry can only ever describe the immutable commit it was created
// for, and a cancelled request can never start a later run.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const SHA_PATTERN = /^[a-f0-9]{40}$/;

export const JOURNAL_STATES = Object.freeze(['pending', 'leased', 'completed', 'cancelled', 'failed']);

export function normalizeJournalSha(value) {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!SHA_PATTERN.test(sha)) throw Error('JOURNAL_SHA_MALFORMED');
  return sha;
}

// A stable identity per immutable commit. Repeated triggers for the same SHA
// collapse onto one journal entry instead of queuing duplicate executions.
export function requestKey({repository, sha}) {
  return createHash('sha256').update(`${repository}@${normalizeJournalSha(sha)}`).digest('hex').slice(0, 32);
}

function emptyJournal() {
  return {schema: 'wolf.private-ci.journal/v1', requests: {}, order: []};
}

export function readJournal(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.requests !== 'object') return emptyJournal();
    return {schema: 'wolf.private-ci.journal/v1', requests: parsed.requests ?? {}, order: Array.isArray(parsed.order) ? parsed.order : Object.keys(parsed.requests ?? {})};
  } catch {
    return emptyJournal();
  }
}

export function writeJournal(file, journal) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(journal, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(temporary, file);
}

export function enqueueRequest(journal, {repository, sha, reason = 'push', runId = null, now = new Date().toISOString()}) {
  const key = requestKey({repository, sha});
  const existing = journal.requests[key];
  if (existing) {
    // A cancelled or completed commit is never silently re-armed.
    existing.observations = (existing.observations ?? 0) + 1;
    existing.lastSeenAt = now;
    if (reason) existing.reason = reason;
    return {state: 'DUPLICATE', key, request: existing};
  }
  const request = {
    key,
    repository,
    sha: normalizeJournalSha(sha),
    state: 'pending',
    reason,
    runId: runId === null ? null : Number(runId),
    attempts: 0,
    observations: 1,
    createdAt: now,
    lastSeenAt: now,
    leaseOwner: null,
    leaseExpiresAt: null,
    cancellation: null,
    recoveredFrom: null,
  };
  journal.requests[key] = request;
  journal.order.push(key);
  return {state: 'ENQUEUED', key, request};
}

export function cancelRequest(journal, {repository, sha, reason = 'CANCELLED_BY_OPERATOR', now = new Date().toISOString()}) {
  const key = requestKey({repository, sha});
  const request = journal.requests[key];
  if (!request) return {state: 'ABSENT', key};
  if (request.state === 'completed') return {state: 'DENIED', key, reason: 'REQUEST_ALREADY_COMPLETED'};
  if (request.state === 'cancelled') return {state: 'DUPLICATE', key, request};
  request.state = 'cancelled';
  request.cancellation = {reason, at: now};
  request.leaseOwner = null;
  request.leaseExpiresAt = null;
  return {state: 'CANCELLED', key, request};
}

// Atomically take the oldest pending request. A lease that is still valid can
// never be stolen; an expired lease is reclaimed so a crashed runner cannot
// stall the queue forever.
export function claimNext(journal, {owner, leaseMs = 20 * 60 * 1000, now = Date.now()}) {
  const nowIso = new Date(now).toISOString();
  const reclaimable = Object.values(journal.requests).filter(request => {
    if (request.state === 'pending') return true;
    if (request.state !== 'leased') return false;
    const expires = request.leaseExpiresAt ? Date.parse(request.leaseExpiresAt) : 0;
    return !Number.isFinite(expires) || expires <= now;
  });
  if (!reclaimable.length) return {state: 'IDLE'};
  reclaimable.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const request = reclaimable[0];
  const recoveredFrom = request.state === 'leased' ? request.leaseOwner ?? 'UNKNOWN' : null;
  request.state = 'leased';
  request.leaseOwner = owner;
  request.leaseExpiresAt = new Date(now + leaseMs).toISOString();
  request.attempts = (request.attempts ?? 0) + 1;
  if (recoveredFrom) request.recoveredFrom = recoveredFrom;
  return {state: recoveredFrom ? 'RECOVERED' : 'CLAIMED', key: request.key, request, recoveredFrom, claimedAt: nowIso};
}

export function settleRequest(journal, {key, state, detail = null, now = new Date().toISOString()}) {
  if (!['completed', 'failed'].includes(state)) throw Error('JOURNAL_SETTLE_STATE_INVALID');
  const request = journal.requests[key];
  if (!request) return {state: 'ABSENT', key};
  request.state = state;
  request.settledAt = now;
  request.leaseOwner = null;
  request.leaseExpiresAt = null;
  if (detail) request.detail = detail;
  return {state: state.toUpperCase(), key, request};
}

// Summarizes the queue without exposing private content.
export function summarizeJournal(journal, {limit = 20} = {}) {
  const requests = Object.values(journal.requests);
  const counts = Object.fromEntries(JOURNAL_STATES.map(state => [state, requests.filter(request => request.state === state).length]));
  return {
    schema: journal.schema,
    total: requests.length,
    counts,
    recent: requests
      .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
      .slice(0, limit)
      .map(request => ({
        sha: request.sha,
        state: request.state,
        attempts: request.attempts,
        reason: request.reason,
        recoveredFrom: request.recoveredFrom,
        createdAt: request.createdAt,
        settledAt: request.settledAt ?? null,
      })),
    privateSourcePublished: false,
    inferencePerformed: false,
  };
}
