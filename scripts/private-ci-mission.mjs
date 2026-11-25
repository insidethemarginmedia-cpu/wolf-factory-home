// Cross-repository mission contract.
//
// The Home bridge is the only authenticated interface between the private Factory
// and this public repository. This module defines what a mission is, validates it
// strictly enough that an untrusted sender cannot smuggle authority in, and binds
// every mission to one exact commit SHA.
//
// Design constraints, each with a reason:
//
//   - The payload is data, never configuration. A mission may say *which SHA to
//     verify*; it may never say which workflow to run, which credential to use, or
//     where to publish. Those are fixed here.
//   - A mission without a full 40-character SHA is rejected. A branch name is a
//     moving target, and "the SHA I meant" is not an auditable claim.
//   - Duplicate suppression is part of the contract, not the caller's job. The same
//     mission id delivered twice must never execute twice.
//   - Bounded failure: every mission has a deadline, and an expired mission is
//     refused rather than executed late against a stale ref.

export const MISSION_SCHEMA_VERSION = 1;

// The only event type the bridge accepts from another repository.
export const MISSION_EVENT_TYPE = 'wolf-private-ci';

export const MISSION_STATES = Object.freeze({
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  DUPLICATE: 'DUPLICATE',
  EXPIRED: 'EXPIRED',
});

// Fixed by the contract. A mission cannot override any of these.
export const MISSION_POLICY = Object.freeze({
  // The workflow is chosen by the bridge, never by the caller.
  workflow: 'private-ci-bridge.yml',
  // Credentials are App installation tokens, per role, minted at run time.
  credentialSource: 'github-app',
  // A mission may not request a permission; these are the roles that exist.
  roles: ['reader', 'publisher', 'dispatcher'],
  // The longest a mission may sit unclaimed before it is refused.
  maxAgeMs: 60 * 60 * 1000,
  // Hard ceiling on missions per sender per hour, so one caller cannot crowd out
  // the others by volume.
  maxPerSenderPerHour: 12,
  // A paid execution is never permitted, whatever the mission says.
  allowPaidExecution: false,
});

const SHA_PATTERN = /^[0-9a-f]{40}$/;
// Mission ids are opaque but bounded: they key the durable journal, so they must be
// stable, comparable and free of characters that could confuse a filename or a log.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * Validates a mission payload from a `repository_dispatch` event.
 *
 * Returns a decision, never throws: a rejected mission must produce a durable,
 * inspectable reason rather than a crash that loses the evidence.
 */
export function validateMission(payload, {now = Date.now(), allowlist = null} = {}) {
  const reject = (reason, detail = null) => ({state: MISSION_STATES.REJECTED, reason, detail, accepted: false});

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return reject('MISSION_PAYLOAD_REQUIRED');
  if (payload.schemaVersion !== MISSION_SCHEMA_VERSION) {
    return reject('MISSION_SCHEMA_UNSUPPORTED', {expected: MISSION_SCHEMA_VERSION, received: payload.schemaVersion ?? null});
  }
  if (typeof payload.missionId !== 'string' || !ID_PATTERN.test(payload.missionId)) return reject('MISSION_ID_INVALID');
  if (typeof payload.sha !== 'string' || !SHA_PATTERN.test(payload.sha)) {
    // A branch, a short SHA and a tag are all refused for the same reason: none of
    // them identify the code that ran.
    return reject('MISSION_SHA_INVALID');
  }
  if (typeof payload.repository !== 'string' || !REPOSITORY_PATTERN.test(payload.repository)) return reject('MISSION_REPOSITORY_INVALID');
  if (allowlist && !allowlist.includes(payload.repository)) return reject('MISSION_REPOSITORY_NOT_ALLOWED', {repository: payload.repository});

  // A caller may not select the workflow or the credential. Those are policy, and
  // policy that a payload can override is not policy.
  for (const forbidden of ['workflow', 'workflowFile', 'token', 'permissions', 'credentials', 'ref']) {
    if (payload[forbidden] !== undefined) return reject('MISSION_MAY_NOT_SPECIFY_' + forbidden.toUpperCase());
  }
  // Any present value is refused, not just `true`. A truthy string like "no" or
  // "false" would otherwise pass a `=== true` check while still reading as paid to
  // anything downstream that only tests truthiness - and a mission has no reason to
  // mention payment at all.
  if (payload.paid !== undefined || payload.allowPaidExecution !== undefined) {
    return reject('MISSION_MAY_NOT_AUTHORISE_PAID_EXECUTION');
  }

  const issuedAt = Number(payload.issuedAt);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return reject('MISSION_ISSUED_AT_REQUIRED');
  if (issuedAt > now + 5 * 60 * 1000) return reject('MISSION_ISSUED_IN_FUTURE');
  if (now - issuedAt > MISSION_POLICY.maxAgeMs) return reject('MISSION_EXPIRED', {ageMs: now - issuedAt, maxAgeMs: MISSION_POLICY.maxAgeMs});

  const checks = Array.isArray(payload.checks) ? payload.checks : null;
  if (checks !== null) {
    if (!checks.length || checks.length > 64) return reject('MISSION_CHECKS_INVALID');
    if (checks.some(name => typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name))) return reject('MISSION_CHECK_NAME_INVALID');
  }

  return {
    state: MISSION_STATES.ACCEPTED,
    accepted: true,
    reason: null,
    mission: {
      missionId: payload.missionId,
      sha: payload.sha,
      repository: payload.repository,
      issuedAt,
      checks: checks ?? null,
      // Delivery order matters for an audit trail, and a caller-supplied attempt
      // number is evidence of retries rather than a hint to skip work.
      attempt: Number.isInteger(payload.attempt) && payload.attempt > 0 ? payload.attempt : 1,
      requestedBy: typeof payload.requestedBy === 'string' ? payload.requestedBy.slice(0, 64) : null,
    },
    policy: MISSION_POLICY,
  };
}

/**
 * A stable key for duplicate suppression.
 *
 * Deliberately excludes `issuedAt` and `attempt`: a retry of the same mission is
 * the same mission, and treating it as new is what produces duplicate execution.
 */
export function missionKey(mission) {
  if (!mission?.missionId || !mission?.sha) throw Error('MISSION_KEY_REQUIRES_ID_AND_SHA');
  return mission.missionId + '@' + mission.sha;
}

/**
 * The journal entry a mission produces. Written before execution, so a crash
 * leaves evidence of intent rather than a gap.
 */
export function missionRecord(decision, {now = Date.now(), runId = null, event = null} = {}) {
  if (!decision?.accepted) {
    return {
      schemaVersion: MISSION_SCHEMA_VERSION,
      state: decision?.state ?? MISSION_STATES.REJECTED,
      reason: decision?.reason ?? 'MISSION_INVALID',
      detail: decision?.detail ?? null,
      recordedAt: new Date(now).toISOString(),
      runId,
      event,
      credentialsPrinted: false,
    };
  }
  return {
    schemaVersion: MISSION_SCHEMA_VERSION,
    state: MISSION_STATES.ACCEPTED,
    key: missionKey(decision.mission),
    mission: decision.mission,
    workflow: MISSION_POLICY.workflow,
    credentialSource: MISSION_POLICY.credentialSource,
    recordedAt: new Date(now).toISOString(),
    runId,
    event,
    // The invariant that makes this contract safe to publish: nothing here can be
    // replayed as a credential, and nothing here is private source.
    credentialsPrinted: false,
    privateSourceIncluded: false,
  };
}

/**
 * Decides what to do with a mission given the journal's existing keys.
 * Separated from validation because duplicate detection needs history, and a
 * validator that needs history is hard to test in isolation.
 */
export function dedupe(decision, {seenKeys = [], now = Date.now()} = {}) {
  if (!decision?.accepted) return decision;
  const key = missionKey(decision.mission);
  if (seenKeys.includes(key)) {
    return {
      state: MISSION_STATES.DUPLICATE,
      accepted: false,
      reason: 'MISSION_ALREADY_RECORDED',
      key,
      mission: decision.mission,
      policy: decision.policy,
    };
  }
  return decision;
}

/**
 * Retry policy for a failed mission: bounded, and never a mask for a systemic
 * problem. Two retries, then the failure is final and reported as such.
 */
export const RETRY_POLICY = Object.freeze({maxAttempts: 3, backoffMs: [0, 60_000, 300_000]});

export function nextAttempt({attempt, failure, now = Date.now()} = {}) {
  const current = Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
  if (!failure) return {retry: false, reason: 'NO_FAILURE'};
  // A credential or permission failure is never retried: repeating it burns quota
  // and hides the real cause behind a retry count.
  if (['PAT_FALLBACK_RETIRED', 'PERMISSION_OR_RATE_LIMIT', 'NOT_FOUND_OR_NO_ACCESS'].includes(failure.reason)) {
    return {retry: false, reason: 'NON_RETRYABLE_' + failure.reason, terminal: true};
  }
  if (current >= RETRY_POLICY.maxAttempts) return {retry: false, reason: 'RETRIES_EXHAUSTED', terminal: true, attempt: current};
  return {
    retry: true,
    attempt: current + 1,
    afterMs: RETRY_POLICY.backoffMs[Math.min(current, RETRY_POLICY.backoffMs.length - 1)],
    notBefore: new Date(now + RETRY_POLICY.backoffMs[Math.min(current, RETRY_POLICY.backoffMs.length - 1)]).toISOString(),
  };
}
