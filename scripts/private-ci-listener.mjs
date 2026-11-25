// Mission listener admission.
//
// The listener lives on the default branch, so it is the first code an external
// caller can reach. It is deliberately the least powerful component in the system:
// it holds no GitHub App credentials, never checks out private source, and cannot
// publish. Its only job is to decide whether an event becomes a privileged
// execution, and to answer "no" in a way that is recorded.
//
// A credential-free listener is not, by itself, a security guarantee. Removing
// credentials removes what an attacker gains from *reaching* the listener; it says
// nothing about whether the listener admits a request it should refuse. So every
// decision here is an allow decision with positive evidence, never a default:
//
//   - sender authorisation      the event's sender must be on an explicit list
//   - executor pinning          execution runs one approved immutable SHA, and the
//                               SHA is checked to be exactly 40 hex characters
//   - schema validation         a strict mission contract, reused from the bridge
//   - replay protection         a delivery may be admitted once, ever
//   - bounded admission         concurrency and per-sender volume are capped
//
// Every refusal carries a machine-readable reason and is never swallowed: an
// unauthorised request produces evidence that it was refused, which is what makes
// "this cannot trigger privileged execution" a claim with something behind it.

import {validateMission, MISSION_STATES, missionKey} from './private-ci-mission.mjs';

export const LISTENER_SCHEMA_VERSION = 1;

export const LISTENER_EVENT_TYPE = 'wolf-private-ci';

export const LISTENER_STATES = Object.freeze({
  ADMITTED: 'ADMITTED',
  REFUSED: 'REFUSED',
});

// Why a request was refused. These are stable strings so an alert can match them.
export const REFUSAL = Object.freeze({
  EVENT_TYPE_INVALID: 'LISTENER_EVENT_TYPE_INVALID',
  SENDER_UNAUTHORIZED: 'LISTENER_SENDER_UNAUTHORIZED',
  SENDER_MISSING: 'LISTENER_SENDER_MISSING',
  EXECUTOR_SHA_INVALID: 'LISTENER_EXECUTOR_SHA_INVALID',
  EXECUTOR_SHA_NOT_APPROVED: 'LISTENER_EXECUTOR_SHA_NOT_APPROVED',
  DELIVERY_ID_REQUIRED: 'LISTENER_DELIVERY_ID_REQUIRED',
  REPLAY_DETECTED: 'LISTENER_REPLAY_DETECTED',
  MISSION_REJECTED: 'LISTENER_MISSION_REJECTED',
  RATE_LIMITED: 'LISTENER_RATE_LIMITED',
});

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DELIVERY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

/**
 * Bounded admission policy.
 *
 * The values are ceilings, not defaults: a caller cannot raise them, because a
 * mission payload cannot reach this object.
 */
export const LISTENER_POLICY = Object.freeze({
  // At most this many privileged executions in flight for the whole repository.
  maxConcurrentExecutions: 1,
  // At most this many admitted missions per sender per rolling hour.
  maxAdmissionsPerSenderPerHour: 12,
  // A delivery may only be admitted within this window of its event.
  maxDeliveryAgeMs: 60 * 60 * 1000,
});

/**
 * Decides whether one event becomes a privileged execution.
 *
 * `deliveries` is the durable record of previously admitted delivery ids and
 * mission keys. It is passed in rather than read here so the decision is pure and
 * the same function can be exercised adversarially in tests.
 */
export function admitMission(event, {
  now = Date.now(),
  authorizedSenders = [],
  approvedExecutorShas = [],
  repositoryAllowlist = [],
  deliveries = [],
  recentAdmissions = [],
} = {}) {
  const refuse = (reason, detail = null) => ({
    state: LISTENER_STATES.REFUSED,
    admitted: false,
    reason,
    detail,
    executorSha: null,
    mission: null,
    credentialsRequired: false,
  });

  if (!event || typeof event !== 'object') return refuse(REFUSAL.EVENT_TYPE_INVALID, {received: null});

  const eventType = event.eventType ?? event.event_type ?? null;
  if (eventType !== LISTENER_EVENT_TYPE) return refuse(REFUSAL.EVENT_TYPE_INVALID, {received: eventType});

  // Sender authorisation. An absent sender is refused rather than treated as
  // "unknown but probably fine": the absence of evidence is not permission.
  const sender = event.sender ?? null;
  if (typeof sender !== 'string' || !sender.trim()) return refuse(REFUSAL.SENDER_MISSING);
  if (!Array.isArray(authorizedSenders) || authorizedSenders.length === 0) {
    // An empty allowlist refuses everything. Failing open here would mean a
    // configuration mistake silently admits the world.
    return refuse(REFUSAL.SENDER_UNAUTHORIZED, {sender, reason: 'ALLOWLIST_EMPTY'});
  }
  if (!authorizedSenders.includes(sender)) return refuse(REFUSAL.SENDER_UNAUTHORIZED, {sender});

  // Executor pinning. The listener runs one approved immutable commit; it cannot be
  // asked to run a branch, a tag, or a SHA that was not reviewed.
  const executorSha = event.executorSha ?? null;
  if (typeof executorSha !== 'string' || !SHA_PATTERN.test(executorSha)) {
    return refuse(REFUSAL.EXECUTOR_SHA_INVALID, {received: typeof executorSha === 'string' ? executorSha : null});
  }
  if (!Array.isArray(approvedExecutorShas) || !approvedExecutorShas.includes(executorSha)) {
    return refuse(REFUSAL.EXECUTOR_SHA_NOT_APPROVED, {executorSha, approvedCount: Array.isArray(approvedExecutorShas) ? approvedExecutorShas.length : 0});
  }

  // Replay protection, before the schema so a replayed garbage payload still
  // records as a replay rather than as a malformed mission.
  const deliveryId = event.deliveryId ?? null;
  if (typeof deliveryId !== 'string' || !DELIVERY_PATTERN.test(deliveryId)) {
    return refuse(REFUSAL.DELIVERY_ID_REQUIRED, {received: typeof deliveryId === 'string' ? deliveryId.slice(0, 64) : null});
  }
  const seen = Array.isArray(deliveries) ? deliveries : [];
  if (seen.some(entry => entry?.deliveryId === deliveryId)) {
    return refuse(REFUSAL.REPLAY_DETECTED, {deliveryId});
  }

  // Volume bound, so one authorized caller cannot crowd the others out or turn a
  // permitted channel into a sustained execution pump.
  const admissions = Array.isArray(recentAdmissions) ? recentAdmissions : [];
  const recentForSender = admissions.filter(entry => entry?.sender === sender && now - Number(entry.at ?? 0) < 60 * 60 * 1000);
  if (recentForSender.length >= LISTENER_POLICY.maxAdmissionsPerSenderPerHour) {
    return refuse(REFUSAL.RATE_LIMITED, {sender, recent: recentForSender.length, limit: LISTENER_POLICY.maxAdmissionsPerSenderPerHour});
  }

  // Strict mission contract. Reused rather than reimplemented: two validators that
  // disagree is how one path becomes weaker than the other.
  const decision = validateMission(event.mission ?? {}, {now, allowlist: repositoryAllowlist});
  if (decision.state !== MISSION_STATES.ACCEPTED) {
    return refuse(REFUSAL.MISSION_REJECTED, {missionReason: decision.reason, detail: decision.detail ?? null});
  }

  const key = missionKey(decision.mission);
  if (seen.some(entry => entry?.missionKey === key)) {
    return refuse(REFUSAL.REPLAY_DETECTED, {deliveryId, missionKey: key});
  }

  return {
    state: LISTENER_STATES.ADMITTED,
    admitted: true,
    reason: null,
    detail: null,
    // The exact commit the privileged execution will run. Returned so the caller
    // can pass it to the reusable workflow without recomputing it.
    executorSha,
    mission: decision.mission,
    missionKey: key,
    deliveryId,
    sender,
    // Positive statement of what the listener needed: nothing secret.
    credentialsRequired: false,
    admittedAt: new Date(now).toISOString(),
  };
}

/**
 * Builds the record a listener appends when it admits a mission.
 *
 * Written for the same append-only journal the bridge uses, so admission evidence
 * and execution evidence sit in one place. No credential and no private content.
 */
export function admissionRecord(admission, {now = Date.now()} = {}) {
  return {
    schemaVersion: LISTENER_SCHEMA_VERSION,
    ledger: 'listener-admissions',
    state: admission?.admitted === true ? LISTENER_STATES.ADMITTED : LISTENER_STATES.REFUSED,
    admitted: admission?.admitted === true,
    reason: admission?.reason ?? null,
    deliveryId: admission?.deliveryId ?? null,
    missionKey: admission?.missionKey ?? null,
    sender: admission?.sender ?? null,
    executorSha: admission?.executorSha ?? null,
    recordedAt: new Date(now).toISOString(),
    credentialsRequired: false,
  };
}

/**
 * The gate a privileged job consults immediately before it starts work.
 *
 * This is the second line of defence. Even if the admission job were bypassed or
 * its output tampered with, the privileged job re-checks that it was told to run
 * an approved commit and that an admission was actually recorded. A privileged job
 * that starts on an unapproved SHA refuses itself.
 */
export function assertExecutionAllowed({executorSha, approvedExecutorShas = [], admission} = {}) {
  const refuse = reason => ({allowed: false, reason, executorSha: executorSha ?? null});
  if (typeof executorSha !== 'string' || !SHA_PATTERN.test(executorSha)) return refuse(REFUSAL.EXECUTOR_SHA_INVALID);
  if (!Array.isArray(approvedExecutorShas) || !approvedExecutorShas.includes(executorSha)) return refuse(REFUSAL.EXECUTOR_SHA_NOT_APPROVED);
  if (!admission || admission.admitted !== true) return refuse(REFUSAL.MISSION_REJECTED);
  if (admission.executorSha !== executorSha) {
    // The admission names a different commit than the job intends to run. Treat as
    // tampering rather than as a mismatch to be reconciled.
    return refuse(REFUSAL.EXECUTOR_SHA_NOT_APPROVED);
  }
  return {allowed: true, reason: null, executorSha};
}
