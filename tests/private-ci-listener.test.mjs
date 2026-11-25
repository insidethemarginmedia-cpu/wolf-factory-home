// Adversarial tests for the mission listener.
//
// The claim under test is not "the listener has no credentials". It is "an invalid
// or unauthorised request cannot cause privileged execution". Each test is an
// attempt to cause exactly that, from a different direction.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  admitMission,
  admissionRecord,
  assertExecutionAllowed,
  LISTENER_STATES,
  REFUSAL,
  LISTENER_POLICY,
} from '../scripts/private-ci-listener.mjs';

const EXECUTOR = 'a'.repeat(40);
const TARGET = '8d319fc50be4e4d225e3bb80de963583899c25ec';
const NOW = Date.parse('2026-11-25T12:00:00Z');

const validMission = (overrides = {}) => ({
  schemaVersion: 1,
  missionId: 'factory-nightly-0001',
  repository: 'donraposo1-source/project-wolf',
  sha: TARGET,
  issuedAt: NOW - 60_000,
  ...overrides,
});

const validEvent = (overrides = {}) => ({
  eventType: 'wolf-private-ci',
  sender: 'donraposo1-source',
  executorSha: EXECUTOR,
  deliveryId: 'delivery-00000001',
  mission: validMission(),
  ...overrides,
});

const options = (overrides = {}) => ({
  now: NOW,
  authorizedSenders: ['donraposo1-source'],
  approvedExecutorShas: [EXECUTOR],
  repositoryAllowlist: ['donraposo1-source/project-wolf'],
  deliveries: [],
  recentAdmissions: [],
  ...overrides,
});

test('a well-formed mission from an authorized sender is admitted', () => {
  const result = admitMission(validEvent(), options());
  assert.equal(result.state, LISTENER_STATES.ADMITTED);
  assert.equal(result.admitted, true);
  assert.equal(result.executorSha, EXECUTOR);
  assert.equal(result.mission.sha, TARGET);
  assert.equal(result.credentialsRequired, false);
});

// --- sender authorisation -------------------------------------------------

test('an unauthorized sender is refused and cannot reach execution', () => {
  const result = admitMission(validEvent({sender: 'attacker'}), options());
  assert.equal(result.admitted, false);
  assert.equal(result.reason, REFUSAL.SENDER_UNAUTHORIZED);
  assert.equal(result.executorSha, null, 'a refused request must not name an executor');
});

test('a missing sender is refused, not treated as unknown-but-fine', () => {
  for (const sender of [null, undefined, '', '   ']) {
    const result = admitMission(validEvent({sender}), options());
    assert.equal(result.admitted, false);
    assert.equal(result.reason, REFUSAL.SENDER_MISSING);
  }
});

test('an empty allowlist refuses everything rather than admitting everything', () => {
  // The dangerous failure is failing open on a misconfiguration.
  const result = admitMission(validEvent(), options({authorizedSenders: []}));
  assert.equal(result.admitted, false);
  assert.equal(result.reason, REFUSAL.SENDER_UNAUTHORIZED);
  assert.equal(result.detail.reason, 'ALLOWLIST_EMPTY');
});

// --- executor pinning -----------------------------------------------------

test('an unapproved executor SHA is refused even when the mission is perfect', () => {
  const result = admitMission(validEvent({executorSha: 'b'.repeat(40)}), options());
  assert.equal(result.admitted, false);
  assert.equal(result.reason, REFUSAL.EXECUTOR_SHA_NOT_APPROVED);
});

test('a branch name or short SHA as executor is refused', () => {
  for (const executorSha of ['main', 'abc1234', 'refs/heads/main', 'A'.repeat(40)]) {
    const result = admitMission(validEvent({executorSha}), options());
    assert.equal(result.admitted, false);
    assert.equal(result.reason, REFUSAL.EXECUTOR_SHA_INVALID, String(executorSha));
  }
});

// --- event type -----------------------------------------------------------

test('an event of another type is refused', () => {
  for (const eventType of ['push', 'workflow_dispatch', 'wolf-private-ci-evil', null]) {
    const result = admitMission(validEvent({eventType}), options());
    assert.equal(result.admitted, false);
    assert.equal(result.reason, REFUSAL.EVENT_TYPE_INVALID, String(eventType));
  }
});

// --- replay ---------------------------------------------------------------

test('a replayed delivery id is refused', () => {
  const result = admitMission(validEvent(), options({deliveries: [{deliveryId: 'delivery-00000001'}]}));
  assert.equal(result.admitted, false);
  assert.equal(result.reason, REFUSAL.REPLAY_DETECTED);
});

test('a different delivery id carrying the same mission is refused', () => {
  // Replay at the mission level, not just the transport level: a caller cannot
  // re-send the same work under a fresh delivery id to execute it twice.
  const first = admitMission(validEvent(), options());
  const second = admitMission(validEvent({deliveryId: 'delivery-00000002'}), options({deliveries: [{missionKey: first.missionKey}]}));
  assert.equal(second.admitted, false);
  assert.equal(second.reason, REFUSAL.REPLAY_DETECTED);
  assert.equal(second.detail.missionKey, first.missionKey);
});

test('a missing or malformed delivery id is refused', () => {
  for (const deliveryId of [null, '', 'short', 'x'.repeat(200)]) {
    const result = admitMission(validEvent({deliveryId}), options());
    assert.equal(result.admitted, false);
    assert.equal(result.reason, REFUSAL.DELIVERY_ID_REQUIRED);
  }
});

// --- volume ---------------------------------------------------------------

test('a sender at the hourly ceiling is refused', () => {
  const recent = Array.from({length: LISTENER_POLICY.maxAdmissionsPerSenderPerHour}, (_, i) => ({sender: 'donraposo1-source', at: NOW - 1000 * (i + 1)}));
  const result = admitMission(validEvent(), options({recentAdmissions: recent}));
  assert.equal(result.admitted, false);
  assert.equal(result.reason, REFUSAL.RATE_LIMITED);
});

test('admissions outside the rolling hour do not count against the ceiling', () => {
  const old = Array.from({length: 50}, (_, i) => ({sender: 'donraposo1-source', at: NOW - 2 * 60 * 60 * 1000 - i * 1000}));
  const result = admitMission(validEvent(), options({recentAdmissions: old}));
  assert.equal(result.admitted, true);
});

// --- mission contract boundary -------------------------------------------

test('a mission that tries to name a workflow, ref or credential is refused', () => {
  for (const [field, value] of [['workflow', 'evil.yml'], ['ref', 'main'], ['token', 'ghp_x'], ['permissions', {contents: 'write'}], ['credentials', 'x'], ['paid', true], ['allowPaidExecution', false]]) {
    const result = admitMission(validEvent({mission: validMission({[field]: value})}), options());
    assert.equal(result.admitted, false, field + ' must be refused');
    assert.equal(result.reason, REFUSAL.MISSION_REJECTED);
  }
});

test('a mission naming an unlisted repository is refused', () => {
  const result = admitMission(validEvent({mission: validMission({repository: 'attacker/private'})}), options());
  assert.equal(result.admitted, false);
  assert.equal(result.reason, REFUSAL.MISSION_REJECTED);
  assert.equal(result.detail.missionReason, 'MISSION_REPOSITORY_NOT_ALLOWED');
});

test('an expired mission is refused', () => {
  const result = admitMission(validEvent({mission: validMission({issuedAt: NOW - 2 * 60 * 60 * 1000})}), options());
  assert.equal(result.admitted, false);
  assert.equal(result.reason, REFUSAL.MISSION_REJECTED);
  assert.equal(result.detail.missionReason, 'MISSION_EXPIRED');
});

test('a mission with a branch name instead of a SHA is refused', () => {
  const result = admitMission(validEvent({mission: validMission({sha: 'main'})}), options());
  assert.equal(result.admitted, false);
  assert.equal(result.reason, REFUSAL.MISSION_REJECTED);
});

// --- second line of defence ----------------------------------------------

test('a privileged job refuses to start on an unapproved SHA even if told to', () => {
  const admission = {admitted: true, executorSha: EXECUTOR};
  const result = assertExecutionAllowed({executorSha: 'c'.repeat(40), approvedExecutorShas: [EXECUTOR], admission});
  assert.equal(result.allowed, false);
  assert.equal(result.reason, REFUSAL.EXECUTOR_SHA_NOT_APPROVED);
});

test('a privileged job refuses to start without a recorded admission', () => {
  for (const admission of [null, undefined, {}, {admitted: false}]) {
    const result = assertExecutionAllowed({executorSha: EXECUTOR, approvedExecutorShas: [EXECUTOR], admission});
    assert.equal(result.allowed, false);
    assert.equal(result.allowed, false);
  }
});

test('a privileged job refuses when the admission names a different commit', () => {
  // Tampering with the admission output must fail closed.
  const admission = {admitted: true, executorSha: 'd'.repeat(40)};
  const result = assertExecutionAllowed({executorSha: EXECUTOR, approvedExecutorShas: [EXECUTOR], admission});
  assert.equal(result.allowed, false);
  assert.equal(result.reason, REFUSAL.EXECUTOR_SHA_NOT_APPROVED);
});

test('a privileged job starts only when every precondition holds', () => {
  const admission = {admitted: true, executorSha: EXECUTOR};
  const result = assertExecutionAllowed({executorSha: EXECUTOR, approvedExecutorShas: [EXECUTOR], admission});
  assert.equal(result.allowed, true);
});

// --- evidence -------------------------------------------------------------

test('refusals are recorded with a reason and never carry credentials', () => {
  const refused = admitMission(validEvent({sender: 'attacker'}), options());
  const record = admissionRecord(refused, {now: NOW});
  assert.equal(record.state, LISTENER_STATES.REFUSED);
  assert.equal(record.reason, REFUSAL.SENDER_UNAUTHORIZED);
  assert.equal(record.credentialsRequired, false);
  assert.ok(!/gh[opsu]_/.test(JSON.stringify(record)));
});

test('an admitted mission records the executor, sender and mission key', () => {
  const admitted = admitMission(validEvent(), options());
  const record = admissionRecord(admitted, {now: NOW});
  assert.equal(record.state, LISTENER_STATES.ADMITTED);
  assert.equal(record.executorSha, EXECUTOR);
  assert.equal(record.sender, 'donraposo1-source');
  assert.equal(record.missionKey, admitted.missionKey);
});

test('concurrency is capped at one privileged execution', () => {
  // Serialising execution is what keeps two missions from racing over the same
  // receipt path; it is a policy constant, not a caller choice.
  assert.equal(LISTENER_POLICY.maxConcurrentExecutions, 1);
});
