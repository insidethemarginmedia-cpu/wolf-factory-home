/*
 * Wolf Omega P0 -- adversarial RED -> GREEN regression for the trusted pre-effect
 * admission boundary.
 *
 * Reproduction switch:
 *   WOLF_OMEGA_P0_FALSIFY=1 node --test tests/omega-p0-pre-effect-admission.test.mjs
 * runs the SAME assertions against the reconstructed pre-fix adapter (no boundary)
 * and must FAIL: forged declarations reach `POST /api/runs`. Without the switch the
 * existing Factory authority port drives the gate and every case must PASS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  admitExternalEffect, assertBoundExternalRequest, createPreEffectGate,
  externalRequestDigest, planAfterUncertainEffect, withPreEffectAdmission,
  validateRequestShape,
} from '../scripts/omega-p0/pre-effect-admission.mjs';
import {POLICY} from '../scripts/omega-p0/policy.mjs';
import {createAuthorityFixture, validRequest, seal} from './fixtures/omega-p0-authority.mjs';
import {
  createLegacyDispatchAdapter, legacyTrustGuard, mockFetchFactory,
} from './fixtures/omega-p0-legacy-adapter.mjs';

const FALSIFY = process.env.WOLF_OMEGA_P0_FALSIFY === '1';

function harness({mutate, overrides} = {}) {
  const fixture = createAuthorityFixture({mutate});
  const mock = mockFetchFactory();
  const adapter = createLegacyDispatchAdapter({fetchImpl: mock.fetch});
  const gate = createPreEffectGate(fixture.ports, fixture.policyConfig);
  const dispatch = FALSIFY
    ? request => adapter.dispatch(request) // pre-fix: caller declarations reach the boundary
    : withPreEffectAdmission(request => adapter.dispatch(request), gate);
  return {fixture, mock, adapter, gate, dispatch, request: validRequest(overrides)};
}

async function mustDeny({label, mutate, overrides, reason}) {
  const h = harness({mutate, overrides});
  const result = await h.dispatch(h.request);
  assert.equal(result.state, 'DENIED_BEFORE_EFFECT', label + ': no COMPLETED from a denied boundary');
  assert.equal(h.mock.calls, 0, label + ': zero HTTP requests before admission');
  const verdict = await h.gate(h.request);
  assert.equal(verdict.state, 'DENIED', label);
  assert.equal(verdict.reason, reason, label + ': deterministic denial reason');
  return verdict;
}

test('zero-cost policy constants are fail closed', () => {
  assert.equal(POLICY.EUR_SPEND, '0');
  assert.equal(POLICY.COST_UNKNOWN, 'DENY');
  assert.equal(POLICY.PAID_FALLBACK, 'DENY');
  assert.equal(POLICY.TRIAL_CREDIT, 'DENY');
  assert.equal(POLICY.JULES, 'FORBIDDEN');
  assert.equal(POLICY.UNKNOWN_EXTERNAL_EFFECT, 'RECONCILE_ONLY');
});

test('a fully authorized request is admitted, bound to the exact request and dispatched once', async () => {
  const h = harness();
  const verdict = await admitExternalEffect(h.request, h.fixture.ports, h.fixture.policyConfig);
  assert.equal(verdict.state, 'ADMITTED');
  assert.equal(verdict.externalEffectPerformed, false, 'admission itself performs no external effect');
  assert.equal(assertBoundExternalRequest(verdict.admission, h.request).ok, true);
  assert.equal(assertBoundExternalRequest(verdict.admission, {...h.request, body: '{"tampered":true}'}).reason, 'ADMISSION_BINDING_MISMATCH');
  assert.equal(verdict.admission.requestDigest, externalRequestDigest(h.request));
  const result = await h.dispatch(h.request);
  assert.equal(result.state, 'EFFECT_SUBMITTED');
  assert.notEqual(result.state, 'COMPLETED', 'a dispatched request is not worker completion');
  assert.equal(result.completionVerified, false);
  assert.equal(result.automaticRetryAuthorized, false);
  if (!FALSIFY) assert.equal(h.mock.calls, 1, 'exactly one external request');
});

test('a caller-fabricated admission object cannot bypass the binding check', async () => {
  const h = harness();
  const dispatch = withPreEffectAdmission(request => h.adapter.dispatch(request), legacyTrustGuard);
  const result = await dispatch(h.request);
  assert.equal(result.state, 'DENIED_BEFORE_EFFECT');
  assert.equal(result.reason, 'ADMISSION_BINDING_MISMATCH');
  assert.equal(h.mock.calls, 0);
});

test('forged economic receipt is denied before any HTTP request', async () => {
  await mustDeny({
    label: 'forged economic receipt', reason: 'ECONOMIC_RECEIPT_UNTRUSTED',
    mutate: state => { state.economic = {...state.economic, receiptDigest: 'f'.repeat(64)}; },
  });
});

test('string "false" and other caller authority declarations are never proof', async () => {
  for (const field of ['authorization', 'declaredFence', 'fence', 'economicAuthorized', 'kctFence', 'receipt', 'verified', 'costUsd']) {
    const h = harness({overrides: {[field]: 'false'}});
    const verdict = await h.gate(h.request);
    assert.equal(verdict.reason, 'CALLER_SUPPLIED_AUTHORITY_DECLARATION', field);
    const result = await h.dispatch(h.request);
    assert.equal(result.state, 'DENIED_BEFORE_EFFECT', field);
    assert.equal(h.mock.calls, 0, field + ': zero HTTP');
  }
  assert.throws(() => validateRequestShape({...validRequest(), authorization: 'false'}), /CALLER_SUPPLIED_AUTHORITY_DECLARATION/);
});

test('missing or unknown provider cost is denied', async () => {
  await mustDeny({
    label: 'unknown price', reason: 'PROVIDER_COST_UNKNOWN',
    mutate: state => { state.economic = seal({...state.economic, priceKnown: false}); },
  });
  await mustDeny({
    label: 'missing cost evidence', reason: 'PROVIDER_COST_UNKNOWN',
    mutate: state => {
      const {costUsd, ...withoutCost} = state.economic;
      state.economic = seal(withoutCost);
    },
  });
  await mustDeny({
    label: 'nonzero cost', reason: 'COST_NOT_ZERO',
    mutate: state => { state.economic = seal({...state.economic, costUsd: 0.0001}); },
  });
  await mustDeny({
    label: 'absent economic authorization', reason: 'ECONOMIC_AUTHORIZATION_MISSING',
    mutate: state => { state.economic = null; },
  });
});

test('paid fallback and trial credit are denied, never automatic', async () => {
  await mustDeny({
    label: 'paid fallback', reason: 'PAID_FALLBACK_DENIED',
    mutate: state => { state.economic = seal({...state.economic, paidFallback: true}); },
  });
  await mustDeny({
    label: 'trial credit', reason: 'TRIAL_CREDIT_DENIED',
    mutate: state => { state.economic = seal({...state.economic, trialCredit: true}); },
  });
});

test('untrusted Groq endpoint origin is denied', async () => {
  await mustDeny({
    label: 'unauthorized Groq endpoint', reason: 'ENDPOINT_ORIGIN_UNTRUSTED',
    overrides: {endpoint: 'https://api.groq.com.evil.example/api/runs'},
  });
  await mustDeny({
    label: 'endpoint with credentials in URL', reason: 'ENDPOINT_ORIGIN_UNTRUSTED',
    overrides: {endpoint: 'https://user:pass@factory.internal.invalid/api/runs'},
  });
  await mustDeny({
    label: 'unsupported model', reason: 'MODEL_UNSUPPORTED',
    overrides: {model: 'unsupported-model-900b'},
  });
  await mustDeny({
    label: 'unqualified account', reason: 'ACCOUNT_NOT_QUALIFIED',
    overrides: {account: 'unverified-trial-account'},
  });
  await mustDeny({
    label: 'unauthorized provider', reason: 'PROVIDER_NOT_AUTHORIZED',
    overrides: {provider: 'unknown-paid-provider'},
  });
});

test('invalid OpenHands identity, type and execution endpoint are denied', async () => {
  await mustDeny({
    label: 'unauthorized worker identity', reason: 'WORKER_IDENTITY_UNAUTHORIZED',
    mutate: state => { state.worker = seal({...state.worker, authorized: false}); },
  });
  await mustDeny({
    label: 'forged worker registry record', reason: 'WORKER_IDENTITY_UNVERIFIED',
    mutate: state => { state.worker = {...state.worker, tampered: true}; },
  });
  await mustDeny({
    label: 'untrusted worker endpoint', reason: 'WORKER_ENDPOINT_UNTRUSTED',
    overrides: {workerEndpoint: 'http://openhands.evil.example/session'},
  });
  await mustDeny({
    label: 'worker endpoint mismatch', reason: 'WORKER_ENDPOINT_MISMATCH',
    overrides: {workerEndpoint: 'https://openhands.factory.internal.invalid/other'},
  });
  await mustDeny({
    label: 'unallowed worker type', reason: 'WORKER_TYPE_NOT_ALLOWED',
    overrides: {workerType: 'unknown-worker-type'},
  });
});

test('Jules cannot be admitted through any identity or alias', async () => {
  for (const workerType of ['jules', 'Jules', 'google-jules', 'jules_agent']) {
    await mustDeny({label: 'Jules ' + workerType, reason: 'JULES_FORBIDDEN', overrides: {workerType}});
  }
});

test('arbitrary, empty and stale KCT fences are denied', async () => {
  await mustDeny({
    label: 'arbitrary KCT fence', reason: 'STALE_FENCING_GENERATION',
    mutate: state => { state.kctClaim = seal({...state.kctClaim, fencingToken: 9999}); },
  });
  await mustDeny({
    label: 'empty KCT fence', reason: 'KCT_FENCE_INVALID',
    mutate: state => { state.kctClaim = seal({...state.kctClaim, fencingToken: ''}); },
  });
  await mustDeny({
    label: 'stale fencing generation', reason: 'STALE_FENCING_GENERATION',
    mutate: state => { state.currentFence = 8; },
  });
  await mustDeny({
    label: 'forged KCT claim', reason: 'KCT_CLAIM_UNVERIFIED',
    mutate: state => { state.kctClaim = {...state.kctClaim, owner: 'forged-owner'}; },
  });
  await mustDeny({
    label: 'released KCT claim', reason: 'KCT_CLAIM_NOT_ACTIVE',
    mutate: state => { state.kctClaim = seal({...state.kctClaim, released: true}); },
  });
  await mustDeny({
    label: 'expired KCT lease', reason: 'KCT_LEASE_EXPIRED',
    mutate: state => { state.kctClaim = seal({...state.kctClaim, expiresAt: state.now - 1}); },
  });
});

test('mismatched mission, attempt, execution key and idempotency key are denied', async () => {
  await mustDeny({label: 'unknown mission', reason: 'MISSION_NOT_FOUND', overrides: {missionId: 'UNKNOWN_MISSION'}});
  await mustDeny({label: 'attempt mismatch', reason: 'ATTEMPT_MISMATCH', overrides: {attemptId: 'attempt-2'}});
  await mustDeny({label: 'execution key mismatch', reason: 'EXECUTION_KEY_MISMATCH', overrides: {executionKey: 'a'.repeat(64)}});
  await mustDeny({label: 'idempotency key mismatch', reason: 'IDEMPOTENCY_KEY_MISMATCH', overrides: {idempotencyKey: 'b'.repeat(64)}});
  await mustDeny({
    label: 'terminal mission recreation', reason: 'MISSION_TERMINAL_STATE_DENIED',
    mutate: state => { state.mission = seal({...state.mission, terminal: true}); },
  });
});

test('missing DBOS workflow ownership and stale mission lease are denied', async () => {
  await mustDeny({
    label: 'DBOS ownership mismatch', reason: 'DBOS_WORKFLOW_OWNERSHIP_MISMATCH',
    mutate: state => { state.workflow = seal({...state.workflow, owner: 'another-owner'}); },
  });
  await mustDeny({
    label: 'DBOS ownership unverified', reason: 'DBOS_WORKFLOW_OWNERSHIP_UNVERIFIED',
    mutate: state => { state.workflow = {...state.workflow, tampered: true}; },
  });
  await mustDeny({
    label: 'stale lease', reason: 'MISSION_LEASE_INVALID',
    mutate: state => { state.lease = {...state.lease, expiresAt: state.now - 1}; },
  });
  await mustDeny({
    label: 'lease holder mismatch', reason: 'MISSION_LEASE_HOLDER_MISMATCH',
    mutate: state => { state.lease = {...state.lease, holder: 'other'}; },
  });
});

test('an unresolved UNKNOWN external effect and a duplicate effect are never replayed', async () => {
  await mustDeny({
    label: 'UNKNOWN external effect', reason: 'UNKNOWN_EXTERNAL_EFFECT_RECONCILE_ONLY',
    mutate: state => { state.externalEffect = {state: 'UNKNOWN'}; },
  });
  await mustDeny({
    label: 'already verified effect', reason: 'EXTERNAL_EFFECT_DUPLICATE_DENIED',
    mutate: state => { state.externalEffect = {state: 'VERIFIED'}; },
  });
});

test('a lost response is EFFECT_UNKNOWN, never a proven failure and never retried', async () => {
  const fixture = createAuthorityFixture();
  const gate = createPreEffectGate(fixture.ports, fixture.policyConfig);
  let attempts = 0;
  const dispatch = withPreEffectAdmission(async () => {
    attempts += 1;
    throw new Error('response lost');
  }, gate);
  const result = await dispatch(validRequest());
  assert.equal(result.state, 'EFFECT_UNKNOWN');
  assert.equal(result.reason, 'EXTERNAL_RESPONSE_LOST');
  assert.equal(result.automaticRetryAuthorized, false);
  assert.equal(result.replayAuthorized, false);
  assert.equal(result.disposition, 'RECONCILE_ONLY');
  assert.equal(attempts, 1, 'exactly one external request, no automatic retry');
  const plan = planAfterUncertainEffect(result);
  assert.equal(plan.state, 'RECONCILE_ONLY');
  assert.equal(plan.automaticRetry, false);
  assert.equal(plan.newExternalEffect, false);
});

test('missing authority ports fail closed without an external request', async () => {
  const request = validRequest();
  const verdict = await admitExternalEffect(request, {}, {});
  assert.equal(verdict.state, 'DENIED');
  assert.equal(verdict.reason, 'AUTHORITY_PORT_MISSING', 'a missing existing-authority port fails closed');
  assert.equal(verdict.automaticRetryAuthorized, false);
});

test('the request shape rejects malformed identifiers and oversize bodies', async () => {
  for (const overrides of [
    {executionKey: 'short'}, {idempotencyKey: 'zz'},
    {body: 'x'.repeat(70000)}, {method: 'GET'}, {path: '/admin/execute'},
    {missionId: ''}, {workerId: 'a'.repeat(200)},
  ]) {
    const h = harness({overrides});
    const verdict = await h.gate(h.request);
    assert.equal(verdict.state, 'DENIED', JSON.stringify(overrides).slice(0, 40));
    assert.ok(['REQUEST_SHAPE_INVALID', 'ENDPOINT_PATH_NOT_ALLOWED'].includes(verdict.reason));
    assert.equal(h.mock.calls, 0);
  }
});
