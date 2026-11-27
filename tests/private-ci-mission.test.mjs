import assert from 'node:assert/strict';
import test from 'node:test';
import {validateMission, missionKey, missionBindingDigest, missionRecord, dedupe, nextAttempt, MISSION_STATES, MISSION_POLICY, MISSION_SCHEMA_VERSION} from '../scripts/private-ci-mission.mjs';

const NOW = Date.parse('2026-11-25T00:00:00Z');
const SHA = '8d319fc50be4e4d225e3bb80de963583899c25ec';
const base = {
  schemaVersion: MISSION_SCHEMA_VERSION,
  missionId: 'MISSION-2026-11-25-0001',
  sha: SHA,
  repository: 'donraposo1-source/project-wolf',
  issuedAt: NOW - 60_000,
  requestedBy: 'factory-2',
};

test('a well-formed mission is accepted and bound to one exact SHA', () => {
  const decision = validateMission(base, {now: NOW});
  assert.equal(decision.state, MISSION_STATES.ACCEPTED);
  assert.equal(decision.mission.sha, SHA);
  assert.equal(decision.mission.workflow ?? MISSION_POLICY.workflow, 'private-ci-bridge.yml');
});

test('a branch name, short SHA or tag is refused because none identifies the code', () => {
  for (const sha of ['main', '8d319fc', 'v1.2.3', '']) {
    const decision = validateMission({...base, sha}, {now: NOW});
    assert.equal(decision.state, MISSION_STATES.REJECTED);
    assert.equal(decision.reason, 'MISSION_SHA_INVALID', `sha ${JSON.stringify(sha)} must be refused`);
  }
});

test('a mission may not select its own workflow, credential, permissions or ref', () => {
  for (const field of ['workflow', 'workflowFile', 'token', 'permissions', 'credentials', 'ref', 'paid']) {
    const decision = validateMission({...base, [field]: 'anything'}, {now: NOW});
    assert.equal(decision.state, MISSION_STATES.REJECTED, `field ${field} must be refused`);
    assert.match(decision.reason, /MISSION_MAY_NOT_/);
  }
});

test('an expired mission is refused rather than executed late against a stale ref', () => {
  const decision = validateMission({...base, issuedAt: NOW - MISSION_POLICY.maxAgeMs - 1000}, {now: NOW});
  assert.equal(decision.state, MISSION_STATES.REJECTED);
  assert.equal(decision.reason, 'MISSION_EXPIRED');
});

test('a mission from the future beyond clock tolerance is refused', () => {
  const decision = validateMission({...base, issuedAt: NOW + 6 * 60 * 1000}, {now: NOW});
  assert.equal(decision.reason, 'MISSION_ISSUED_IN_FUTURE');
});

test('an unsupported schema version fails closed instead of being guessed at', () => {
  assert.equal(validateMission({...base, schemaVersion: 2}, {now: NOW}).reason, 'MISSION_SCHEMA_UNSUPPORTED');
  assert.equal(validateMission({...base, schemaVersion: undefined}, {now: NOW}).reason, 'MISSION_SCHEMA_UNSUPPORTED');
});

test('a repository outside the allowlist is refused', () => {
  const decision = validateMission(base, {now: NOW, allowlist: ['insidethemarginmedia-cpu/wolf-factory-home']});
  assert.equal(decision.state, MISSION_STATES.REJECTED);
  assert.equal(decision.reason, 'MISSION_REPOSITORY_NOT_ALLOWED');
});

test('the same mission delivered twice is a duplicate, whatever the attempt number', () => {
  const first = validateMission(base, {now: NOW});
  const retry = validateMission({...base, attempt: 4, issuedAt: NOW - 30_000}, {now: NOW});
  const key = missionKey(first.mission);
  assert.equal(missionKey(retry.mission), key, 'issuedAt and attempt must not change identity');
  const result = dedupe(retry, {seenKeys: [key]});
  assert.equal(result.state, MISSION_STATES.DUPLICATE);
  assert.equal(result.accepted, false);
});

test('the public mission binding digest is opaque and binds repository, mission ID and exact SHA', () => {
  const first = validateMission(base, {now: NOW}).mission;
  const retry = validateMission({...base, attempt: 4, issuedAt: NOW - 30_000}, {now: NOW}).mission;
  const digest = missionBindingDigest(first);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(missionBindingDigest(retry), digest, 'attempt and issuedAt are not identity');
  assert.notEqual(missionBindingDigest({...first, missionId: 'MISSION-2026-11-25-0002'}), digest);
  assert.notEqual(missionBindingDigest({...first, repository: 'owner/other-private-repo'}), digest);
  assert.notEqual(missionBindingDigest({...first, sha: '7'.repeat(40)}), digest);
  assert.equal(JSON.stringify(digest).includes(first.sha), false);
  assert.equal(JSON.stringify(digest).includes(first.missionId), false);
  assert.equal(JSON.stringify(digest).includes(first.repository), false);
  assert.throws(() => missionBindingDigest({...first, sha: 'main'}), /MISSION_BINDING_INVALID/);
});

test('a rejected mission still produces a durable record with its reason', () => {
  const decision = validateMission({...base, sha: 'main'}, {now: NOW});
  const record = missionRecord(decision, {now: NOW, runId: '123'});
  assert.equal(record.state, MISSION_STATES.REJECTED);
  assert.equal(record.reason, 'MISSION_SHA_INVALID');
  assert.equal(record.credentialsPrinted, false);
});

test('an accepted record carries no credential and no private source', () => {
  const record = missionRecord(validateMission(base, {now: NOW}), {now: NOW});
  assert.equal(record.credentialsPrinted, false);
  assert.equal(record.privateSourceIncluded, false);
  assert.equal(record.workflow, 'private-ci-bridge.yml');
  assert.equal(record.credentialSource, 'github-app');
  assert.equal(/gh[pousr]_|BEGIN [A-Z ]*PRIVATE KEY/.test(JSON.stringify(record)), false);
});

test('retries are bounded, and a permission failure is never retried', () => {
  assert.deepEqual(nextAttempt({attempt: 1, failure: {reason: 'UPSTREAM_ERROR'}}).retry, true);
  assert.equal(nextAttempt({attempt: 3, failure: {reason: 'UPSTREAM_ERROR'}}).reason, 'RETRIES_EXHAUSTED');
  assert.equal(nextAttempt({attempt: 3, failure: {reason: 'UPSTREAM_ERROR'}}).terminal, true);
  // Repeating a permission failure burns quota and hides the cause.
  assert.equal(nextAttempt({attempt: 1, failure: {reason: 'PERMISSION_OR_RATE_LIMIT'}}).retry, false);
  assert.equal(nextAttempt({attempt: 1, failure: {reason: 'PAT_FALLBACK_RETIRED'}}).retry, false);
  assert.equal(nextAttempt({attempt: 1}).retry, false);
});

test('paid execution is refused by policy, not by convention', () => {
  assert.equal(MISSION_POLICY.allowPaidExecution, false);
  assert.equal(validateMission({...base, allowPaidExecution: true}, {now: NOW}).state, MISSION_STATES.REJECTED);
});
