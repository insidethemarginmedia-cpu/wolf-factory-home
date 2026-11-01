/*
 * Wolf Omega P0 -- trusted pre-effect admission boundary.
 *
 * INTENDED WIRING (Loop 3 integration, no replacement of existing components):
 *
 *   import {createPreEffectGate, withPreEffectAdmission} from '<this module>';
 *   const gate = createPreEffectGate(existingFactoryAuthorityPorts, existingPolicyConfig);
 *   const dispatch = withPreEffectAdmission(existingOmegaAdapter.dispatch, gate);
 *   const result = await dispatch(request);   // gate runs BEFORE the existing POST /api/runs
 *
 * The gate performs no HTTP request, writes no authority, creates no second
 * authority system and starts no workflow. It only READS the existing KCT/DBOS
 * authority + immutable ledger through `ports`, re-verifies their authenticity,
 * binds a one-shot admission to the exact mission/attempt/worker/request and
 * denies before any external effect. A caller-supplied boolean, string, hash or
 * JSON object is never treated as proof.
 */
import {
  POLICY, SHA256_HEX, MAX_BODY_BYTES, assertIdentifier, canonical,
  canonicalDigest, deny, failClosed, isPlainObject, readPort, sha256, trustedUrl,
} from './policy.mjs';
import {assertWorkerAllowed, DEFAULT_ALLOWED_WORKER_TYPES} from './worker-evidence.mjs';

export const DEFAULT_TRUSTED_ENDPOINT_ORIGINS = Object.freeze(new Set([
  'https://api.groq.com',
  'https://factory.internal.invalid',
]));
export const DEFAULT_TRUSTED_WORKER_ENDPOINT_ORIGINS = Object.freeze(new Set([
  'https://openhands.factory.internal.invalid',
]));
export const DEFAULT_ALLOWED_PROVIDERS = Object.freeze(new Set(['groq']));
export const DEFAULT_QUALIFIED_ACCOUNTS = Object.freeze(new Set(['groq-free-verified']));
export const DEFAULT_SUPPORTED_MODELS = Object.freeze(new Set(['openai/gpt-oss-120b']));
export const DEFAULT_ALLOWED_PATHS = Object.freeze(new Set([
  '/api/runs', '/openai/v1/chat/completions',
]));

/* Any field in this set is a caller-supplied claim of authority and is rejected
 * outright. Authorization is only ever derived from the existing ledger. */
export const FORBIDDEN_DECLARATION_FIELDS = Object.freeze(new Set([
  'fence', 'fencingtoken', 'fencinggeneration', 'declaredfence', 'kctfence',
  'kctauthorized', 'kctclaim', 'authorized', 'authorization', 'authority',
  'economicauthorized', 'economicauthorization', 'economicreceipt', 'receipt',
  'receiptdigest', 'costusd', 'priceknown', 'paidfallback', 'trialcredit',
  'completion', 'completed', 'verified', 'independentverification',
  'identity', 'identityproof', 'signature', 'proof', 'admitted', 'admission',
]));

const REQUEST_IDENTIFIER_FIELDS = Object.freeze([
  'missionId', 'attemptId', 'workflowId', 'workerId', 'workerType',
  'provider', 'account', 'method',
]);
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const REQUEST_DIGEST_FIELDS = Object.freeze([
  'missionId', 'attemptId', 'executionKey', 'idempotencyKey', 'workflowId',
  'workerId', 'workerType', 'workerEndpoint', 'provider', 'account', 'model',
  'endpoint', 'method', 'path', 'body',
]);

export function normalizeConfig(config = {}) {
  return {
    trustedEndpointOrigins: config.trustedEndpointOrigins || DEFAULT_TRUSTED_ENDPOINT_ORIGINS,
    trustedWorkerEndpointOrigins: config.trustedWorkerEndpointOrigins || DEFAULT_TRUSTED_WORKER_ENDPOINT_ORIGINS,
    allowedProviders: config.allowedProviders || DEFAULT_ALLOWED_PROVIDERS,
    qualifiedAccounts: config.qualifiedAccounts || DEFAULT_QUALIFIED_ACCOUNTS,
    supportedModels: config.supportedModels || DEFAULT_SUPPORTED_MODELS,
    allowedPaths: config.allowedPaths || DEFAULT_ALLOWED_PATHS,
    allowedWorkerTypes: config.allowedWorkerTypes || DEFAULT_ALLOWED_WORKER_TYPES,
    maxBodyBytes: Number.isSafeInteger(config.maxBodyBytes) ? config.maxBodyBytes : MAX_BODY_BYTES,
    timeoutMs: Number.isSafeInteger(config.timeoutMs) ? config.timeoutMs : 20000,
    issuer: typeof config.issuer === 'string' ? config.issuer : 'wolf-existing-factory-authority',
    now: typeof config.now === 'function' ? config.now : () => Date.now(),
  };
}

export function validateRequestShape(request, config = normalizeConfig()) {
  if (!isPlainObject(request)) deny('REQUEST_SHAPE_INVALID', 'request must be an object');
  for (const key of Object.keys(request)) {
    if (FORBIDDEN_DECLARATION_FIELDS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) {
      deny('CALLER_SUPPLIED_AUTHORITY_DECLARATION', key);
    }
  }
  for (const field of REQUEST_IDENTIFIER_FIELDS) assertIdentifier(request[field], field);
  if (typeof request.model !== 'string' || !MODEL_PATTERN.test(request.model)) {
    deny('REQUEST_SHAPE_INVALID', 'model');
  }
  for (const field of ['executionKey', 'idempotencyKey']) {
    if (typeof request[field] !== 'string' || !SHA256_HEX.test(request[field])) {
      deny('REQUEST_SHAPE_INVALID', field);
    }
  }
  if (typeof request.endpoint !== 'string' || typeof request.workerEndpoint !== 'string' ||
      typeof request.path !== 'string' ||
      typeof request.body !== 'string' || Buffer.byteLength(request.body, 'utf8') > config.maxBodyBytes) {
    deny('REQUEST_SHAPE_INVALID', 'endpoint/workerEndpoint/body');
  }
  if (request.method !== 'POST') deny('REQUEST_SHAPE_INVALID', 'method must be POST');
  if (!config.allowedPaths.has(request.path)) deny('ENDPOINT_PATH_NOT_ALLOWED', request.path);
  for (const field of REQUEST_DIGEST_FIELDS) {
    if (request[field] === undefined) deny('REQUEST_SHAPE_INVALID', 'missing ' + field);
  }
  return true;
}

export function externalRequestDigest(request) {
  return sha256(canonical({
    method: request.method, endpoint: request.endpoint, path: request.path,
    body: request.body, missionId: request.missionId, attemptId: request.attemptId,
    executionKey: request.executionKey, idempotencyKey: request.idempotencyKey,
    workflowId: request.workflowId, workerId: request.workerId,
    workerType: request.workerType, workerEndpoint: request.workerEndpoint,
    provider: request.provider, account: request.account, model: request.model,
  }));
}

export function assertBoundExternalRequest(admission, request) {
  if (!isPlainObject(admission) || !isPlainObject(request)) return {ok: false, reason: 'ADMISSION_MISSING'};
  for (const field of REQUEST_DIGEST_FIELDS) {
    if (admission[field] !== request[field]) return {ok: false, reason: 'ADMISSION_BINDING_MISMATCH'};
  }
  if (admission.requestDigest !== externalRequestDigest(request)) {
    return {ok: false, reason: 'ADMISSION_BINDING_MISMATCH'};
  }
  if (typeof admission.bindingDigest !== 'string' || !SHA256_HEX.test(admission.bindingDigest)) {
    return {ok: false, reason: 'ADMISSION_DIGEST_MISSING'};
  }
  return {ok: true, reason: 'BOUND'};
}

async function read(ports, name, arg) {
  return readPort(ports, name, arg);
}

/**
 * Trusted pre-effect admission. Ten independent authority facts are verified
 * against the EXISTING Factory authority/ledger; any missing, stale, forged or
 * mismatched fact denies before an HTTP request can be constructed.
 */
export async function admitExternalEffect(request, ports, config = {}) {
  const cfg = normalizeConfig(config);
  try {
    validateRequestShape(request, cfg);
    const now = cfg.now();
    const requestDigest = externalRequestDigest(request);
    const identity = {
      missionId: request.missionId, attemptId: request.attemptId,
      executionKey: request.executionKey, idempotencyKey: request.idempotencyKey,
    };

    // 10. Absence of an unresolved UNKNOWN external effect. Never replay.
    const effect = await read(ports, 'readExternalEffect', identity);
    if (!isPlainObject(effect)) deny('EXTERNAL_EFFECT_DISPOSITION_UNKNOWN');
    if (effect.state === 'UNKNOWN') deny('UNKNOWN_EXTERNAL_EFFECT_RECONCILE_ONLY');
    if (effect.state !== 'NONE' && effect.state !== 'ABSENT') deny('EXTERNAL_EFFECT_DUPLICATE_DENIED');

    // 1/2/3. Existing mission identity, exact attempt, execution + idempotency keys.
    const mission = await read(ports, 'readMission', {missionId: request.missionId});
    if (!isPlainObject(mission) || mission.missionId !== request.missionId) deny('MISSION_NOT_FOUND');
    if (mission.terminal === true || ['COMPLETED', 'FINAL', 'CLOSED', 'TERMINAL'].includes(mission.state)) {
      deny('MISSION_TERMINAL_STATE_DENIED');
    }
    if (mission.attemptId !== request.attemptId) deny('ATTEMPT_MISMATCH');
    if (mission.executionKey !== request.executionKey) deny('EXECUTION_KEY_MISMATCH');
    if (mission.idempotencyKey !== request.idempotencyKey) deny('IDEMPOTENCY_KEY_MISMATCH');
    if (await read(ports, 'verifyMission', {record: mission}) !== true) deny('MISSION_AUTHORITY_UNVERIFIED');

    // 4/5. Active KCT owner and current fencing generation.
    const claim = await read(ports, 'readKctClaim', {missionId: request.missionId});
    if (!isPlainObject(claim) || claim.active !== true || claim.released === true ||
        claim.taskId !== request.missionId) deny('KCT_CLAIM_NOT_ACTIVE');
    if (await read(ports, 'verifyKctClaim', {record: claim}) !== true) deny('KCT_CLAIM_UNVERIFIED');
    if (!Number.isSafeInteger(claim.fencingToken) || claim.fencingToken < 1) deny('KCT_FENCE_INVALID');
    if (typeof claim.owner !== 'string' || !claim.owner) deny('KCT_OWNER_MISSING');
    if (!Number.isFinite(claim.expiresAt) || claim.expiresAt <= now) deny('KCT_LEASE_EXPIRED');
    const currentFence = await read(ports, 'readCurrentFencingGeneration', {missionId: request.missionId});
    if (!Number.isSafeInteger(currentFence) || currentFence < 1) deny('KCT_FENCE_INVALID');
    if (claim.fencingToken !== currentFence) deny('STALE_FENCING_GENERATION');

    // 6. DBOS workflow ownership bound to this exact mission and attempt.
    const workflow = await read(ports, 'readWorkflowOwnership', {workflowId: request.workflowId, missionId: request.missionId});
    if (!isPlainObject(workflow) || workflow.workflowId !== request.workflowId ||
        workflow.missionId !== request.missionId || workflow.attemptId !== request.attemptId ||
        workflow.status !== 'ACTIVE' || workflow.owner !== claim.owner ||
        workflow.workflowFence !== currentFence) deny('DBOS_WORKFLOW_OWNERSHIP_MISMATCH');
    if (await read(ports, 'verifyWorkflowOwnership', {record: workflow}) !== true) {
      deny('DBOS_WORKFLOW_OWNERSHIP_UNVERIFIED');
    }

    // 7. Mission lease validity.
    const lease = await read(ports, 'readLease', {missionId: request.missionId});
    if (!isPlainObject(lease) || lease.valid !== true || !Number.isFinite(lease.expiresAt) || lease.expiresAt <= now) {
      deny('MISSION_LEASE_INVALID');
    }
    if (lease.holder !== claim.owner) deny('MISSION_LEASE_HOLDER_MISMATCH');
    if (lease.generation !== currentFence) deny('STALE_FENCING_GENERATION');

    // Admission of the worker (Jules is permanently forbidden, including fallback).
    assertWorkerAllowed({
      workerType: request.workerType, workerId: request.workerId,
      allowedTypes: cfg.allowedWorkerTypes,
    });
    const worker = await read(ports, 'readWorkerRegistry', {workerId: request.workerId, workerType: request.workerType});
    if (!isPlainObject(worker) || worker.authorized !== true || worker.active !== true ||
        worker.workerId !== request.workerId || worker.workerType !== request.workerType) {
      deny('WORKER_IDENTITY_UNAUTHORIZED');
    }
    if (await read(ports, 'verifyWorkerIdentity', {record: worker}) !== true) deny('WORKER_IDENTITY_UNVERIFIED');
    if (!trustedUrl(request.workerEndpoint, cfg.trustedWorkerEndpointOrigins, null)) {
      deny('WORKER_ENDPOINT_UNTRUSTED');
    }
    if (worker.endpoint !== request.workerEndpoint) deny('WORKER_ENDPOINT_MISMATCH');

    // 9. Authorized provider, account, model and endpoint provenance.
    if (!cfg.allowedProviders.has(request.provider)) deny('PROVIDER_NOT_AUTHORIZED');
    if (!cfg.qualifiedAccounts.has(request.account)) deny('ACCOUNT_NOT_QUALIFIED');
    if (!cfg.supportedModels.has(request.model)) deny('MODEL_UNSUPPORTED');
    if (!trustedUrl(request.endpoint, cfg.trustedEndpointOrigins, cfg.allowedPaths)) {
      deny('ENDPOINT_ORIGIN_UNTRUSTED');
    }
    const endpointRecord = await read(ports, 'readEndpointRegistry', {endpoint: request.endpoint});
    if (!isPlainObject(endpointRecord) || endpointRecord.trusted !== true ||
        endpointRecord.provider !== request.provider || endpointRecord.account !== request.account ||
        !Array.isArray(endpointRecord.models) || !endpointRecord.models.includes(request.model)) {
      deny('ENDPOINT_ORIGIN_UNTRUSTED');
    }

    // 8. Trusted economic authorization, re-verified -- never a caller declaration.
    const economic = await read(ports, 'readEconomicAuthorization', {
      ...identity, provider: request.provider, account: request.account,
      model: request.model, endpoint: request.endpoint, requestDigest,
    });
    if (!isPlainObject(economic) || economic.authorized !== true) deny('ECONOMIC_AUTHORIZATION_MISSING');
    if (await read(ports, 'verifyEconomicReceipt', {record: economic}) !== true) {
      deny('ECONOMIC_RECEIPT_UNTRUSTED');
    }
    if (!SHA256_HEX.test(economic.receiptDigest || '')) deny('ECONOMIC_RECEIPT_UNTRUSTED');
    if (economic.binding?.missionId !== request.missionId ||
        economic.binding?.attemptId !== request.attemptId ||
        economic.binding?.executionKey !== request.executionKey ||
        economic.binding?.idempotencyKey !== request.idempotencyKey ||
        economic.binding?.provider !== request.provider ||
        economic.binding?.account !== request.account ||
        economic.binding?.model !== request.model ||
        economic.binding?.endpoint !== request.endpoint ||
        economic.binding?.requestDigest !== requestDigest) deny('ECONOMIC_BINDING_MISMATCH');
    if (economic.priceKnown !== true || typeof economic.costUsd !== 'number' || !Number.isFinite(economic.costUsd)) {
      deny('PROVIDER_COST_UNKNOWN');
    }
    if (POLICY.COST_UNKNOWN === 'DENY' && economic.costUsd !== 0) deny('COST_NOT_ZERO');
    if (POLICY.PAID_FALLBACK === 'DENY' && economic.paidFallback === true) deny('PAID_FALLBACK_DENIED');
    if (POLICY.TRIAL_CREDIT === 'DENY' && economic.trialCredit === true) deny('TRIAL_CREDIT_DENIED');
    if (economic.trialCredit !== false || economic.paidFallback !== false) deny('ECONOMIC_FLAGS_UNKNOWN');

    const admission = {
      schema: 'WolfPreEffectAdmission/v1',
      ...identity,
      workflowId: request.workflowId,
      workerId: request.workerId, workerType: request.workerType,
      workerEndpoint: request.workerEndpoint,
      provider: request.provider, account: request.account, model: request.model,
      endpoint: request.endpoint, method: request.method, path: request.path,
      body: request.body,
      requestDigest,
      kctOwner: claim.owner,
      fencingGeneration: currentFence,
      economicReceiptDigest: economic.receiptDigest,
      issuer: cfg.issuer,
      issuedAt: now,
      scope: 'ONE_EXTERNAL_REQUEST_ONLY',
    };
    admission.bindingDigest = canonicalDigest(admission);
    for (const field of REQUEST_DIGEST_FIELDS) {
      if (admission[field] !== request[field]) deny('ADMISSION_BINDING_MISMATCH');
    }
    return Object.freeze({
      state: 'ADMITTED', reason: 'TRUSTED_PRE_EFFECT_ADMISSION',
      admission: Object.freeze(admission),
      automaticRetryAuthorized: false,
      externalEffectPerformed: false,
    });
  } catch (error) {
    return failClosed(error);
  }
}

export function createPreEffectGate(ports, config = {}) {
  const cfg = normalizeConfig(config);
  return async function gate(request) {
    return admitExternalEffect(request, ports, cfg);
  };
}

/**
 * Wrap the EXISTING external-effect dispatch. One request at most, no retry after
 * an uncertain effect, no fabricated completion. A response is an effect submission,
 * never proof of real worker completion (see worker-evidence.mjs).
 */
export function withPreEffectAdmission(dispatch, gate, config = {}) {
  if (typeof dispatch !== 'function' || typeof gate !== 'function') {
    throw new TypeError('PRE_EFFECT_WIRING_INVALID');
  }
  const cfg = normalizeConfig(config);
  return async function guardedDispatch(request) {
    const verdict = await gate(request);
    if (!isPlainObject(verdict) || verdict.state !== 'ADMITTED') {
      return {
        state: 'DENIED_BEFORE_EFFECT',
        reason: isPlainObject(verdict) ? verdict.reason : 'ADMISSION_REQUIRED',
        httpCalls: 0, externalEffectPerformed: false, automaticRetryAuthorized: false,
      };
    }
    const bound = assertBoundExternalRequest(verdict.admission, request);
    if (!bound.ok) {
      return {state: 'DENIED_BEFORE_EFFECT', reason: bound.reason, httpCalls: 0, externalEffectPerformed: false};
    }
    const init = {
      method: 'POST', redirect: 'error',
      headers: {'content-type': 'application/json'},
      signal: AbortSignal.timeout(Number.isSafeInteger(cfg.timeoutMs) ? cfg.timeoutMs : 20000),
    };
    let dispatched;
    try {
      dispatched = await dispatch({...request, admission: verdict.admission, init});
    } catch {
      // A lost response is NOT evidence that the external operation failed.
      return {
        state: 'EFFECT_UNKNOWN', reason: 'EXTERNAL_RESPONSE_LOST',
        disposition: POLICY.UNKNOWN_EXTERNAL_EFFECT,
        httpCalls: 1, externalEffectPerformed: true,
        automaticRetryAuthorized: false, replayAuthorized: false,
        requiresIndependentVerification: true,
      };
    }
    return {
      state: 'EFFECT_SUBMITTED', reason: 'EXTERNAL_REQUEST_DISPATCHED',
      httpCalls: isPlainObject(dispatched) && Number.isSafeInteger(dispatched.httpCalls) ? dispatched.httpCalls : 1,
      externalEffectPerformed: true,
      automaticRetryAuthorized: false,
      requiresIndependentVerification: true,
      completionVerified: false,
      submission: dispatched,
    };
  };
}

/** The only plan allowed after an uncertain external effect. */
export function planAfterUncertainEffect(result) {
  const unknown = !isPlainObject(result) || result.state === 'EFFECT_UNKNOWN' || result.reason === 'EXTERNAL_RESPONSE_LOST';
  return Object.freeze({
    state: unknown ? 'RECONCILE_ONLY' : 'PROCEED_WITH_INDEPENDENT_VERIFICATION',
    action: 'READ_ONLY_RECONCILIATION',
    automaticRetry: false,
    replay: false,
    newExternalEffect: false,
    disposition: POLICY.UNKNOWN_EXTERNAL_EFFECT,
  });
}
