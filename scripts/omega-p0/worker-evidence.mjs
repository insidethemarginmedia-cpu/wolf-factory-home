/*
 * Wolf Omega P0 -- authentic worker completion and worker routing admission.
 *
 * A worker is COMPLETED only when the EXISTING independent verifier supplies an
 * authenticated execution receipt bound to the exact mission/attempt/worker/job,
 * with bounded results and durable evidence. A finished polling loop, a mock
 * response, a process exit status, an adapter assumption or a generated remote
 * session identifier is never execution evidence.
 */
import {
  POLICY, SHA256_HEX, MAX_RESULT_BYTES, canonicalDigest, deny, failClosed,
  isPlainObject, readPort,
} from './policy.mjs';

export const FORBIDDEN_WORKER_TOKENS = Object.freeze(['jules']);
export const DEFAULT_ALLOWED_WORKER_TYPES = Object.freeze(
  new Set(['openhands', 'cezar', 'opencode', 'boxxkite', 'flint', 'ollama', 'qwen-code']),
);

export function normalizeWorkerName(value) {
  return String(value === undefined || value === null ? '' : value)
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isForbiddenWorker(value) {
  const normalized = normalizeWorkerName(value);
  return FORBIDDEN_WORKER_TOKENS.some(token => normalized.includes(token));
}

/** Deny any worker identity/type capable of executing Jules, including aliases. */
export function assertWorkerAllowed({workerType, workerId, allowedTypes = DEFAULT_ALLOWED_WORKER_TYPES} = {}) {
  if (POLICY.JULES === 'FORBIDDEN' && (isForbiddenWorker(workerType) || isForbiddenWorker(workerId))) {
    deny('JULES_FORBIDDEN', {workerType, workerId});
  }
  if (typeof workerType !== 'string' || !allowedTypes.has(workerType)) {
    deny('WORKER_TYPE_NOT_ALLOWED', workerType);
  }
  return true;
}

/**
 * Fallback selection must never fall through to a Jules worker. Returns the first
 * admitted candidate or a fail-closed selection denial.
 */
export function chooseWorker(candidates, {authorized = () => false, allowedTypes = DEFAULT_ALLOWED_WORKER_TYPES} = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {state: 'WORKER_SELECTION_DENIED', reason: 'NO_WORKER_CANDIDATES'};
  }
  for (const candidate of candidates) {
    const workerType = isPlainObject(candidate) ? candidate.workerType : candidate;
    if (isForbiddenWorker(workerType)) continue;
    if (!allowedTypes.has(workerType)) continue;
    let admitted = false;
    try { admitted = authorized(candidate) === true; } catch { admitted = false; }
    if (admitted) return {state: 'WORKER_SELECTED', workerType, candidate};
  }
  return {state: 'WORKER_SELECTION_DENIED', reason: 'NO_ADMITTED_WORKER'};
}

const EVIDENCE_FIELDS = Object.freeze([
  'missionId', 'attemptId', 'executionKey', 'idempotencyKey', 'workflowId',
  'workerId', 'workerType', 'jobId', 'fencingGeneration', 'checkpointId',
]);
const EVIDENCE_DIGEST_FIELDS = Object.freeze([
  'sourceChangeDigest', 'testsDigest', 'evidenceDigest', 'resultDigest',
]);

function notVerified(reason, detail) {
  return Object.freeze({state: 'NOT_VERIFIED', reason, detail: detail ?? null, automaticCompletion: false});
}

/**
 * Verify real worker execution. `ports` are bound to the existing Factory verifier:
 *   readExecutionReceipt({jobId})          -> authenticated receipt or null
 *   verifyExecutionReceipt({receipt})      -> true only for a trusted verifier signature
 *   readCurrentFencingGeneration({missionId})
 * A receipt object supplied by a caller is not authoritative: it is re-read from the
 * existing verifier and re-verified here.
 */
export async function verifyWorkerCompletion({claim, ports, config = {}} = {}) {
  const maxResultBytes = Number.isSafeInteger(config.maxResultBytes) ? config.maxResultBytes : MAX_RESULT_BYTES;
  try {
    if (!isPlainObject(claim)) return notVerified('COMPLETION_CLAIM_MISSING');
    for (const field of EVIDENCE_FIELDS) {
      if (!['string', 'number'].includes(typeof claim[field]) || claim[field] === '') {
        return notVerified('EVIDENCE_MISSING', field);
      }
    }
    if (isForbiddenWorker(claim.workerType) || isForbiddenWorker(claim.workerId)) {
      return notVerified('JULES_FORBIDDEN');
    }
    const receipt = await readPort(ports, 'readExecutionReceipt', {jobId: claim.jobId});
    if (!isPlainObject(receipt)) return notVerified('EXECUTION_RECEIPT_MISSING');
    if (await readPort(ports, 'verifyExecutionReceipt', {receipt}) !== true) {
      return notVerified('EXECUTION_RECEIPT_UNTRUSTED');
    }
    if (receipt.state !== 'COMPLETED') return {state: 'FAILED', reason: 'WORKER_REPORTED_FAILURE'};
    if (receipt.independentVerification !== true) return notVerified('INDEPENDENT_VERIFICATION_MISSING');
    if (!isPlainObject(receipt.result)) return notVerified('BOUNDED_RESULT_MISSING');
    if (!Number.isSafeInteger(receipt.resultBytes) || receipt.resultBytes < 1 || receipt.resultBytes > maxResultBytes) {
      return notVerified('RESULT_NOT_BOUNDED');
    }
    if (Buffer.byteLength(canonicalDigest(receipt.result), 'utf8') !== 64) return notVerified('RESULT_DIGEST_INVALID');
    if (receipt.resultDigest !== canonicalDigest(receipt.result)) return notVerified('RESULT_DIGEST_MISMATCH');
    for (const field of EVIDENCE_FIELDS) {
      if (receipt[field] !== claim[field]) return notVerified('EVIDENCE_IDENTITY_MISMATCH', field);
    }
    for (const field of EVIDENCE_DIGEST_FIELDS) {
      if (typeof receipt[field] !== 'string' || !SHA256_HEX.test(receipt[field])) {
        return notVerified('EVIDENCE_DIGEST_MISSING', field);
      }
    }
    const currentFence = await readPort(ports, 'readCurrentFencingGeneration', {missionId: claim.missionId});
    if (!Number.isSafeInteger(currentFence) || claim.fencingGeneration !== currentFence) {
      return notVerified('STALE_FENCING_GENERATION');
    }
    if (await readPort(ports, 'readDurableCheckpoint', {checkpointId: claim.checkpointId}) === null) {
      return notVerified('DURABLE_CHECKPOINT_MISSING');
    }
    return Object.freeze({
      state: 'COMPLETED',
      reason: 'AUTHENTICATED_EXECUTION_RECEIPT',
      jobId: receipt.jobId,
      missionId: receipt.missionId,
      attemptId: receipt.attemptId,
      executionKey: receipt.executionKey,
      workerId: receipt.workerId,
      checkpointId: receipt.checkpointId,
      evidenceDigest: receipt.evidenceDigest,
      resultDigest: receipt.resultDigest,
      independentlyVerified: true,
    });
  } catch (error) {
    return notVerified(failClosed(error).reason, 'WORKER_EVIDENCE_READ_FAILED');
  }
}

/**
 * The polling boundary. Maps the five fabricated-completion patterns to explicit
 * non-success states before any completion can be reported.
 */
export async function evaluatePollingOutcome({outcome, ports, config = {}} = {}) {
  const o = isPlainObject(outcome) ? outcome : {};
  if (!isPlainObject(o.receipt) && !o.jobId) {
    const reason = o.pollFinished || o.pollsExhausted ? 'POLL_LOOP_FINISHED_IS_NOT_EXECUTION_EVIDENCE'
      : o.mockResponse !== undefined ? 'MOCK_RESPONSE_IS_NOT_EXECUTION_EVIDENCE'
        : typeof o.processExitCode === 'number' ? 'PROCESS_EXIT_IS_NOT_EXECUTION_EVIDENCE'
          : o.sessionId ? 'REMOTE_SESSION_ID_IS_NOT_EXECUTION_EVIDENCE'
            : o.adapterAssumedSuccess ? 'ADAPTER_ASSUMPTION_IS_NOT_EXECUTION_EVIDENCE'
              : 'AUTHENTICATED_RECEIPT_MISSING';
    return {state: 'NOT_VERIFIED', reason, automaticCompletion: false};
  }
  const claim = {...o};
  delete claim.receipt;
  return verifyWorkerCompletion({claim, ports, config});
}
