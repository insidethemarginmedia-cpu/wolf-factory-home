// Adversarial regression for the Composio -> Factory admission transport contract.
//
// These tests never dispatch, authenticate or touch the network: the whole point is
// that refusal must be decided locally, before any external effect is possible.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ACTIVE_REF,
  ADMISSION_ENDPOINT,
  ADMISSION_REPOSITORY,
  AUTHORISED_MISSION_IDENTITY,
  ECONOMIC_POLICY,
  MISSION_MODES,
  PROBE_REF,
  PROTECTED_REF,
  RECEIPT_KEYS,
  WORKERS,
  admissionReceipt,
  buildDispatchRequest,
  classifyDispatchOutcome,
  findSecretMaterial,
  reserveOnce,
  validateAdmissionRequest,
  verifyEconomicPolicy,
} from '../scripts/composio-mission-admission.mjs';

const TOKEN = 'ghs_abcdefghijklmnopqrstuvwxyz0123456789';
const ENV = {
  GITHUB_REPOSITORY: ADMISSION_REPOSITORY,
  GITHUB_ACTOR: 'insidethemarginmedia-cpu',
  GITHUB_TOKEN: TOKEN,
  ...ECONOMIC_POLICY,
};
const KEY = 'a'.repeat(64);
const request = (over = {}) => ({
  mode: 'REAL_INFERENCE_QUALIFICATION',
  ref: ACTIVE_REF,
  missionId: 'WOLF_WAKEUP_MANUAL_41300000001',
  executionKey: KEY,
  worker: 'flint',
  ...over,
});

test('a bounded real-inference qualification is admitted on the active branch', () => {
  const admission = validateAdmissionRequest({env: ENV, request: request()});
  assert.equal(admission.authorized, true);
  assert.equal(admission.input, 'qualify_worker');
  assert.equal(admission.model, 'recursive/flint-v1.0:free');
  assert.equal(admission.performsInference, true);
  assert.equal(admission.publishesCode, false);
  assert.equal(WORKERS.flint.maxCostUsd, 0);
});

test('economic policy is mandated exactly and refuses any relaxation before dispatch', () => {
  assert.deepEqual(verifyEconomicPolicy(ENV), {authorized: true, reasons: []});
  for (const delta of [
    {EUR_SPEND: '1'},
    {EUR_SPEND: ''},
    {COST_UNKNOWN: 'ALLOW'},
    {PAID_FALLBACK: 'ALLOW'},
    {TRIAL_CREDIT: 'ALLOW'},
  ]) {
    const env = {...ENV, ...delta};
    const result = validateAdmissionRequest({env, request: request()});
    assert.equal(result.authorized, false, JSON.stringify(delta));
    assert.equal(result.reason, 'ADMISSION_COST_DENIED');
    assert.equal(verifyEconomicPolicy(env).authorized, false);
  }
  for (const key of Object.keys(ECONOMIC_POLICY)) {
    const env = {...ENV};
    delete env[key];
    assert.equal(validateAdmissionRequest({env, request: request()}).reason, 'ADMISSION_COST_DENIED');
  }
});

test('identity, mode, ref and worker are each independently enforced', () => {
  const cases = [
    [{GITHUB_ACTOR: 'outsider'}, {}, 'ADMISSION_ACTOR_DENIED'],
    [{GITHUB_REPOSITORY: 'outsider/fork'}, {}, 'ADMISSION_REPOSITORY_DENIED'],
    [{}, {mode: 'ARBITRARY'}, 'MISSION_MODE_UNAUTHORISED'],
    [{}, {ref: PROTECTED_REF}, 'PROTECTED_REF_DENIED'],
    [{}, {ref: 'refs/heads/unapproved'}, 'ADMISSION_REF_DENIED'],
    [{}, {ref: 'refs/heads/feat/other'}, 'ADMISSION_REF_DENIED'],
    [{}, {ref: undefined}, 'ADMISSION_REF_DENIED'],
    [{}, {worker: 'gpt-9'}, 'WORKER_NOT_AUTHORISED'],
    [{}, {worker: undefined}, 'WORKER_NOT_AUTHORISED'],
    [{}, {worker: 'openrouter-paid'}, 'WORKER_NOT_AUTHORISED'],
  ];
  for (const [envDelta, requestDelta, reason] of cases) {
    const result = validateAdmissionRequest({env: {...ENV, ...envDelta}, request: request(requestDelta)});
    assert.equal(result.authorized, false, JSON.stringify(requestDelta));
    assert.equal(result.reason, reason, JSON.stringify(requestDelta));
  }
});

test('cross-job recovery stays confined to the reviewed branch', () => {
  assert.deepEqual(MISSION_MODES.CROSS_JOB_RECOVERY.refs, [ACTIVE_REF]);
  assert.equal(validateAdmissionRequest({env: ENV, request: request({mode: 'CROSS_JOB_RECOVERY'})}).authorized, true);
  assert.equal(
    validateAdmissionRequest({env: ENV, request: request({mode: 'CROSS_JOB_RECOVERY', ref: PROBE_REF})}).reason,
    'ADMISSION_REF_DENIED',
  );
  // A bounded wakeup remains a legacy-branch manual operation only.
  assert.equal(validateAdmissionRequest({env: ENV, request: request({mode: 'BOUNDED_WAKEUP'})}).reason, 'ADMISSION_REF_DENIED');
  assert.equal(validateAdmissionRequest({env: ENV, request: request({mode: 'BOUNDED_WAKEUP', ref: PROBE_REF})}).authorized, true);
});

test('mission identity and execution key cannot be invented by the caller', () => {
  for (const missionId of ['FLINT-F1', 'OMEGA_D_1', 'omega_b_1', 'WOLF_NEW_1', '../etc/passwd', '']) {
    assert.equal(
      validateAdmissionRequest({env: ENV, request: request({missionId})}).reason,
      'MISSION_IDENTITY_NOT_AUTHORISED',
      missionId,
    );
  }
  for (const missionId of ['OMEGA_B_41040712384', 'WOLF_WAKEUP_MANUAL_41211185406', 'WOLF_WAKEUP_SCHEDULE_ACCEPTANCE_V1']) {
    assert.equal(AUTHORISED_MISSION_IDENTITY.test(missionId), true, missionId);
    assert.equal(validateAdmissionRequest({env: ENV, request: request({missionId})}).authorized, true, missionId);
  }
  for (const executionKey of ['', 'short', 'Z'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
    assert.equal(validateAdmissionRequest({env: ENV, request: request({executionKey})}).reason, 'EXECUTION_KEY_REQUIRED');
  }
});

test('the dispatch payload selects exactly one existing workflow input', () => {
  const built = buildDispatchRequest({env: ENV, request: request()});
  assert.equal(built.method, 'POST');
  assert.equal(built.url, ADMISSION_ENDPOINT);
  assert.equal(built.body.ref, ACTIVE_REF);
  assert.deepEqual(built.body.inputs, {qualify_worker: 'true'});
  assert.equal(built.idempotent, false);
  assert.equal(Object.keys(built.body.inputs).length, 1);
  // Legacy notification input is never combined with an acceptance mode.
  assert.equal(built.body.inputs.night_shift, undefined);
  assert.throws(() => buildDispatchRequest({env: {...ENV, EUR_SPEND: '5'}, request: request()}), /ADMISSION_COST_DENIED/);
});

test('credential material can never reach a payload or a receipt', () => {
  assert.deepEqual(findSecretMaterial('nothing here', ENV), []);
  assert.ok(findSecretMaterial('Bearer ' + TOKEN, ENV).includes('GITHUB_TOKEN'));
  const nested = findSecretMaterial({ref: ACTIVE_REF, inputs: {x: TOKEN}}, ENV);
  assert.ok(nested.includes('GITHUB_TOKEN') && nested.includes('GITHUB_TOKEN_PATTERN'));
  assert.ok(findSecretMaterial('github_pat_' + 'A1b2C3d4E5'.repeat(4), ENV).includes('GITHUB_TOKEN_PATTERN'));
  assert.ok(findSecretMaterial('-----BEGIN OPENSSH PRIVATE KEY-----', ENV).includes('PRIVATE_KEY_BLOCK'));
  assert.ok(findSecretMaterial('x-access-token:abc', ENV).includes('X_ACCESS_TOKEN'));

  // A caller that tries to smuggle the token in the request is refused outright.
  const smuggled = validateAdmissionRequest({env: ENV, request: request({note: TOKEN})});
  assert.equal(smuggled.reason, 'ADMISSION_PAYLOAD_SECRET_DENIED');
  assert.ok(smuggled.fields.includes('GITHUB_TOKEN'));
  assert.ok(smuggled.fields.length >= 1);

  const receipt = admissionReceipt({admission: {missionId: 'WOLF_WAKEUP_MANUAL_1', executionKey: KEY, worker: 'flint', model: WORKERS.flint.model, authorized: true}, outcome: {state: 'MISSION_DISPATCH_ADMITTED', reason: 'ACCEPTED'}});
  assert.ok(!JSON.stringify(receipt).includes(TOKEN));
});

test('transport outcomes map to exact terminal states with no retry and no replay', () => {
  const cases = [
    [204, '', 'ACCEPTED'],
    [200, '{"id":1}', 'ACCEPTED'],
    [401, '', 'DISPATCH_CREDENTIAL_DENIED'],
    [403, '{"message":"Resource not accessible by integration"}', 'DISPATCH_TOKEN_SCOPE_DENIED'],
    [403, '{"message":"Must have admin rights"}', 'DISPATCH_PERMISSION_DENIED'],
    [404, '', 'DISPATCH_WORKFLOW_OR_REPOSITORY_NOT_FOUND'],
    [422, '', 'DISPATCH_PAYLOAD_REJECTED'],
    [429, '', 'DISPATCH_RATE_LIMITED'],
    [503, '', 'DISPATCH_PROVIDER_UNAVAILABLE'],
    [0, '', 'DISPATCH_TRANSPORT_FAILED'],
    [418, '', 'DISPATCH_OUTCOME_UNKNOWN'],
  ];
  for (const [status, body, reason] of cases) {
    const outcome = classifyDispatchOutcome({status, body});
    assert.equal(outcome.reason, reason, String(status));
    assert.equal(outcome.retryAuthorized, false, String(status));
    assert.equal(outcome.idempotent, false, String(status));
    assert.equal(
      outcome.state,
      status === 204 || status === 200 ? 'MISSION_DISPATCH_ADMITTED' : 'BLOCKED',
      String(status),
    );
  }
});

test('a duplicate admission reservation is refused so one dispatch cannot create two runs', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-admission-'));
  try {
    const first = reserveOnce({directory, executionKey: KEY, record: {missionId: 'WOLF_WAKEUP_MANUAL_1'}});
    assert.equal(first.reserved, true);
    assert.equal(fs.statSync(first.file).mode & 0o777, 0o600);
    assert.throws(() => reserveOnce({directory, executionKey: KEY, record: {missionId: 'WOLF_WAKEUP_MANUAL_1'}}), /DUPLICATE_ADMISSION_RESERVED/);
    // A different execution key is a different mission, not a replay.
    assert.equal(reserveOnce({directory, executionKey: 'b'.repeat(64)}).reserved, true);
    assert.equal(fs.readdirSync(directory).length, 2);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
  assert.throws(() => reserveOnce({directory: '/tmp', executionKey: 'nope'}), /EXECUTION_KEY_REQUIRED/);
});

test('the receipt carries every required property and never claims autonomy by default', () => {
  const receipt = admissionReceipt({
    admission: {missionId: 'OMEGA_B_41040712384', executionKey: KEY, worker: 'flint', model: WORKERS.flint.model, authorized: true},
    outcome: classifyDispatchOutcome({status: 403, body: 'Resource not accessible by integration'}),
  });
  for (const key of RECEIPT_KEYS) assert.ok(Object.hasOwn(receipt, key), key);
  assert.equal(receipt.authorized, true);
  assert.equal(receipt.dispatchState, 'BLOCKED');
  assert.equal(receipt.reason, 'DISPATCH_TOKEN_SCOPE_DENIED');
  assert.equal(receipt.durableState, 'NOT_PERSISTED_LOCALLY');
  assert.equal(receipt.retryAuthorized, false);
  assert.equal(receipt.replayAuthorized, false);
  assert.ok(Object.isFrozen(receipt));

  // Nothing is ever admitted by omission.
  const empty = admissionReceipt({});
  assert.equal(empty.authorized, false);
  assert.equal(empty.dispatchState, 'NOT_DISPATCHED');
  assert.equal(empty.reason, 'NO_ADMISSION_EVALUATED');
});

test('the module cannot reach the network, the shell or the Factory credential store', () => {
  const source = fs.readFileSync(new URL('../scripts/composio-mission-admission.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['fetch(', 'node:child_process', 'spawnSync', 'execFile', 'XMLHttpRequest', 'https.request']) {
    assert.ok(!source.includes(forbidden), 'admission contract must not use ' + forbidden);
  }
  // Only the one-shot reservation function touches the filesystem.
  assert.equal(source.match(/writeFileSync/g)?.length, 1);
});
