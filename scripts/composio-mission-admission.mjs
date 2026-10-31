// Composio -> existing Factory admission: the missing transport contract.
//
// Project Wolf exposes exactly one mission-submission surface: a `workflow_dispatch`
// on `.github/workflows/private-controller-preflight.yml`, gated on
// `github.actor == 'insidethemarginmedia-cpu'`, `github.repository == <public runtime>`
// and a closed set of approved refs, with zero-cost economics enforced in code.
// An external agent platform (Composio) can reach that surface only if it (a) holds a
// credential with `actions:write`, and (b) emits a payload the existing gates accept.
//
// This module supplies ONLY (b): a pure, dependency-free validator/builder/classifier.
// It creates no controller, scheduler, queue or database, and it performs no I/O.
// Every refusal is fail-closed and carries an exact machine-readable reason, so an
// external caller receives an authoritative disposition instead of silence.
//
// Deliberately NOT implemented here: any bypass of the actor/repository/ref gates, any
// economic relaxation, any automatic retry, and any mission identity that the existing
// authority surface has not already authorised.

import fs from 'node:fs';
import path from 'node:path';

export const ADMISSION_SCHEMA = 'WolfMissionAdmission/v1';
export const ADMISSION_REPOSITORY = 'insidethemarginmedia-cpu/wolf-factory-home';
export const ADMISSION_ACTOR = 'insidethemarginmedia-cpu';
export const ADMISSION_WORKFLOW = 'private-controller-preflight.yml';
export const ADMISSION_ENDPOINT =
  'https://api.github.com/repos/' + ADMISSION_REPOSITORY + '/actions/workflows/' + ADMISSION_WORKFLOW + '/dispatches';

export const ACTIVE_REF = 'refs/heads/fix/omega-acceptance-ready-20261028';
export const PROBE_REF = 'refs/heads/feat/public-runtime-probe-20261022';
export const PROTECTED_REF = 'refs/heads/main';

export const ECONOMIC_POLICY = Object.freeze({
  EUR_SPEND: '0',
  COST_UNKNOWN: 'DENY',
  PAID_FALLBACK: 'DENY',
  TRIAL_CREDIT: 'DENY',
});

export const WORKERS = Object.freeze({
  flint: Object.freeze({provider: 'openrouter', model: 'recursive/flint-v1.0:free', maxCostUsd: 0}),
  groq: Object.freeze({provider: 'groq', model: 'openai/gpt-oss-120b', maxCostUsd: 0}),
  ollama: Object.freeze({provider: 'ollama-local', model: 'qwen2.5-coder:0.5b', maxCostUsd: 0}),
});

// One mode -> exactly one existing workflow input. Modes are mutually exclusive so a
// single dispatch can never combine acceptance paths (the workflow repeats this guard).
export const MISSION_MODES = Object.freeze({
  REAL_INFERENCE_QUALIFICATION: Object.freeze({input: 'qualify_worker', refs: [ACTIVE_REF, PROBE_REF], performsInference: true, publishesCode: false}),
  ENGINEERING_MISSION: Object.freeze({input: 'execute_integrated', refs: [ACTIVE_REF, PROBE_REF], performsInference: true, publishesCode: true}),
  CROSS_JOB_RECOVERY: Object.freeze({input: 'verify_cross_job_ab', refs: [ACTIVE_REF], performsInference: true, publishesCode: true}),
  RUNNER_LOSS_RECOVERY: Object.freeze({input: 'verify_runner_loss', refs: [ACTIVE_REF, PROBE_REF], performsInference: true, publishesCode: true}),
  PRIVATE_REGRESSION: Object.freeze({input: 'verify_private_regression', refs: [ACTIVE_REF, PROBE_REF], performsInference: false, publishesCode: false}),
  BOUNDED_WAKEUP: Object.freeze({input: 'night_shift', refs: [PROBE_REF], performsInference: false, publishesCode: false}),
});

// The mission identities the reachable authority surface already recognises. Anything
// else must be authorised by the private Factory's own authority record, which this
// module cannot read; inventing identities here would weaken authorisation.
export const AUTHORISED_MISSION_IDENTITY =
  /^(?:OMEGA_[ABC]_[0-9]+|WOLF_WAKEUP_MANUAL_[0-9]+|WOLF_WAKEUP_SCHEDULE_ACCEPTANCE_V[0-9]+)$/;
export const EXECUTION_KEY = /^[a-f0-9]{64}$/;

const SECRET_ENV_KEYS = Object.freeze([
  'WOLF_FACTORY_REPO_TOKEN',
  'WOLF_FACTORY_DEPLOY_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'BOXXKITE_API_KEY',
  'COMFY_API_KEY',
]);

export function verifyEconomicPolicy(env = process.env) {
  const failures = [];
  for (const [key, expected] of Object.entries(ECONOMIC_POLICY)) {
    if (!Object.hasOwn(env, key)) failures.push(key + '_MISSING');
    else if (env[key] !== expected) failures.push(key + '_DENIED');
  }
  return {authorized: failures.length === 0, reasons: failures};
}

/** Detect any credential material that must never reach a payload or a receipt. */
export function findSecretMaterial(value, env = process.env) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const found = [];
  for (const key of SECRET_ENV_KEYS) {
    const raw = env?.[key];
    if (typeof raw !== 'string' || raw.length < 8) continue;
    const candidates = new Set([raw, raw.trim()]);
    for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length >= 8 && !trimmed.startsWith('-----')) candidates.add(trimmed);
    }
    for (const candidate of candidates) if (candidate && text.includes(candidate)) found.push(key);
  }
  if (/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/.test(text)) found.push('GITHUB_TOKEN_PATTERN');
  if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(text)) found.push('PRIVATE_KEY_BLOCK');
  if (/x-access-token:/i.test(text)) found.push('X_ACCESS_TOKEN');
  return [...new Set(found)];
}

function deny(reason, extra = {}) {
  return {authorized: false, reason, ...extra};
}

/**
 * Validate a mission admission request against the EXISTING gates. Pure: no network,
 * no filesystem, no secrets read beyond the economic/identity fields of `env`.
 */
export function validateAdmissionRequest({env = {}, request = {}} = {}) {
  if (env.GITHUB_REPOSITORY !== undefined && env.GITHUB_REPOSITORY !== '') {
    if (env.GITHUB_REPOSITORY !== ADMISSION_REPOSITORY) return deny('ADMISSION_REPOSITORY_DENIED');
  }
  if (env.GITHUB_ACTOR !== undefined && env.GITHUB_ACTOR !== '') {
    if (env.GITHUB_ACTOR !== ADMISSION_ACTOR) return deny('ADMISSION_ACTOR_DENIED');
  }
  // The protected default branch is refused before any mode is even considered.
  if (request.ref === PROTECTED_REF) return deny('PROTECTED_REF_DENIED');
  if (!Object.hasOwn(MISSION_MODES, request.mode)) return deny('MISSION_MODE_UNAUTHORISED', {mode: request.mode ?? null});
  const mode = MISSION_MODES[request.mode];
  if (typeof request.ref !== 'string' || !mode.refs.includes(request.ref)) {
    return deny('ADMISSION_REF_DENIED', {ref: request.ref ?? null, admissibleRefs: mode.refs});
  }
  if (typeof request.missionId !== 'string' || !AUTHORISED_MISSION_IDENTITY.test(request.missionId)) {
    return deny('MISSION_IDENTITY_NOT_AUTHORISED', {missionId: request.missionId ?? null});
  }
  if (typeof request.executionKey !== 'string' || !EXECUTION_KEY.test(request.executionKey)) {
    return deny('EXECUTION_KEY_REQUIRED');
  }
  if (!Object.hasOwn(WORKERS, request.worker)) return deny('WORKER_NOT_AUTHORISED', {worker: request.worker ?? null});
  const economic = verifyEconomicPolicy(env);
  if (!economic.authorized) return deny('ADMISSION_COST_DENIED', {reasons: economic.reasons});
  const leaked = findSecretMaterial(request, env);
  if (leaked.length) return deny('ADMISSION_PAYLOAD_SECRET_DENIED', {fields: leaked});
  return {
    authorized: true,
    reason: 'ADMISSION_AUTHORISED',
    mode: request.mode,
    input: mode.input,
    ref: request.ref,
    missionId: request.missionId,
    executionKey: request.executionKey,
    worker: request.worker,
    model: WORKERS[request.worker].model,
    performsInference: mode.performsInference,
    publishesCode: mode.publishesCode,
  };
}

/**
 * Build the exact dispatch payload the existing workflow accepts. Throws on refusal so
 * a caller can never accidentally send a partially validated request.
 */
export function buildDispatchRequest({env = {}, request = {}} = {}) {
  const admission = validateAdmissionRequest({env, request});
  if (!admission.authorized) {
    const error = Error(admission.reason);
    error.admission = admission;
    throw error;
  }
  const inputs = {[admission.input]: 'true'};
  const body = {ref: admission.ref, inputs};
  const leaked = findSecretMaterial(body, env);
  if (leaked.length) {
    const error = Error('ADMISSION_PAYLOAD_SECRET_DENIED');
    error.admission = deny('ADMISSION_PAYLOAD_SECRET_DENIED', {fields: leaked});
    throw error;
  }
  return {
    schema: ADMISSION_SCHEMA,
    method: 'POST',
    url: ADMISSION_ENDPOINT,
    body,
    // The credential is read from env by the caller and never placed here.
    requiredCredential: 'ACTIONS_WRITE_TOKEN',
    requiredCredentialScope: 'actions:write on ' + ADMISSION_REPOSITORY,
    idempotent: false,
    admission,
  };
}

/**
 * Classify the transport outcome. `workflow_dispatch` is NOT idempotent: an accepted
 * dispatch creates a run, and a blind retry creates a SECOND run. Retry is therefore
 * never authorised here; recovery requires a fresh one-shot reservation plus a
 * read-only run lookup.
 */
export function classifyDispatchOutcome({status, body = ''} = {}) {
  const text = String(body || '');
  const base = {retryAuthorized: false, idempotent: false, status: Number.isInteger(status) ? status : 0};
  if (status === 204 || status === 200) return {...base, state: 'MISSION_DISPATCH_ADMITTED', reason: 'ACCEPTED'};
  if (status === 401) return {...base, state: 'BLOCKED', reason: 'DISPATCH_CREDENTIAL_DENIED'};
  if (status === 403) {
    return {
      ...base,
      state: 'BLOCKED',
      reason: /resource not accessible by integration/i.test(text) ? 'DISPATCH_TOKEN_SCOPE_DENIED' : 'DISPATCH_PERMISSION_DENIED',
    };
  }
  if (status === 404) return {...base, state: 'BLOCKED', reason: 'DISPATCH_WORKFLOW_OR_REPOSITORY_NOT_FOUND'};
  if (status === 422) return {...base, state: 'BLOCKED', reason: 'DISPATCH_PAYLOAD_REJECTED'};
  if (status === 429) return {...base, state: 'BLOCKED', reason: 'DISPATCH_RATE_LIMITED'};
  if (status >= 500) return {...base, state: 'BLOCKED', reason: 'DISPATCH_PROVIDER_UNAVAILABLE'};
  if (status === 0) return {...base, state: 'BLOCKED', reason: 'DISPATCH_TRANSPORT_FAILED'};
  return {...base, state: 'BLOCKED', reason: 'DISPATCH_OUTCOME_UNKNOWN'};
}

/**
 * One-shot admission reservation: the duplicate-effect guard for a non-idempotent
 * dispatch. Exclusive create (`wx`), owner-only mode, keyed by the execution key.
 * A second reservation for the same key is refused, so a crash-recovery path cannot
 * silently create a duplicate run.
 */
export function reserveOnce({directory, executionKey, record = {}, fsImpl = fs} = {}) {
  if (typeof directory !== 'string' || !directory) throw Error('ADMISSION_DIRECTORY_REQUIRED');
  if (typeof executionKey !== 'string' || !EXECUTION_KEY.test(executionKey)) throw Error('EXECUTION_KEY_REQUIRED');
  const file = path.join(directory, executionKey + '.admission.json');
  try {
    fsImpl.writeFileSync(file, JSON.stringify({schema: ADMISSION_SCHEMA, executionKey, ...record}) + '\n', {flag: 'wx', mode: 0o600});
  } catch (error) {
    if (error?.code === 'EEXIST') throw Error('DUPLICATE_ADMISSION_RESERVED');
    throw error;
  }
  return {reserved: true, file};
}

const RECEIPT_KEYS = Object.freeze([
  'schema',
  'missionId',
  'executionKey',
  'workerIdentity',
  'model',
  'authorized',
  'dispatchState',
  'reason',
  'durableState',
  'retryAuthorized',
  'replayAuthorized',
  'secretFieldsObserved',
]);

/** Structured, secret-free result receipt returned to the delegating agent. */
export function admissionReceipt({admission, outcome, durableState = 'NOT_PERSISTED_LOCALLY'} = {}) {
  const receipt = {
    schema: ADMISSION_SCHEMA,
    missionId: admission?.missionId ?? null,
    executionKey: admission?.executionKey ?? null,
    workerIdentity: admission?.worker ?? null,
    model: admission?.model ?? null,
    authorized: admission?.authorized === true,
    dispatchState: outcome?.state ?? 'NOT_DISPATCHED',
    reason: outcome?.reason ?? admission?.reason ?? 'NO_ADMISSION_EVALUATED',
    durableState,
    retryAuthorized: false,
    replayAuthorized: false,
    secretFieldsObserved: [],
  };
  return Object.freeze(receipt);
}

export {RECEIPT_KEYS, SECRET_ENV_KEYS};
