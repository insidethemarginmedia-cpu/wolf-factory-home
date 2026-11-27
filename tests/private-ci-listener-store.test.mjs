import assert from 'node:assert/strict';
import {test} from 'node:test';

import {runListenerCli} from '../scripts/private-ci-listener-cli.mjs';
import {missionBindingDigest} from '../scripts/private-ci-mission.mjs';
import {
  LISTENER_STORE_ANCHOR_PATH,
  LISTENER_STORE_BRANCH,
  LISTENER_STORE_LEDGER_PATH,
  admitMissionDurably,
  verifyAdmissionLedger,
  verifyStoredMissionAdmission,
} from '../scripts/private-ci-listener-store.mjs';
import {
  LISTENER_TEST_ANCHOR,
  LISTENER_TEST_BRANCH,
  LISTENER_TEST_LEDGER,
  LISTENER_TEST_REPOSITORY,
  LISTENER_TEST_TOKEN,
  makeListenerGitHub,
} from './private-ci-listener-fake-github.mjs';

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const EXECUTOR = 'f'.repeat(40);
const TARGET = '8'.repeat(40);
const TARGET_NEXT = '9'.repeat(40);
const SENDER = 'donraposo1-source';
const TARGET_REPOSITORY = 'donraposo1-source/project-wolf';

const mission = ({missionId = 'mission-0001', sha = TARGET} = {}) => ({
  schemaVersion: 1,
  missionId,
  repository: TARGET_REPOSITORY,
  sha,
  issuedAt: NOW - 1_000,
});

const event = ({missionId = 'mission-0001', sha = TARGET, runId = '1001'} = {}) => ({
  eventType: 'wolf-private-ci',
  sender: SENDER,
  executorSha: EXECUTOR,
  deliveryId: `run-${runId}`,
  mission: mission({missionId, sha}),
});

const policy = {
  now: NOW,
  authorizedSenders: [SENDER],
  approvedExecutorShas: [EXECUTOR],
  repositoryAllowlist: [TARGET_REPOSITORY],
};

const persist = (fake, requestEvent = event(), runId = requestEvent.deliveryId.slice(4), overrides = {}) => admitMissionDurably({
  event: requestEvent,
  policy,
  token: LISTENER_TEST_TOKEN,
  repository: LISTENER_TEST_REPOSITORY,
  executorCommit: EXECUTOR,
  runId,
  now: NOW,
  fetchImpl: fake.fetchImpl,
  ...overrides,
});

const gate = (fake, overrides = {}) => verifyStoredMissionAdmission({
  token: LISTENER_TEST_TOKEN,
  repository: LISTENER_TEST_REPOSITORY,
  targetRepository: TARGET_REPOSITORY,
  missionId: 'mission-0001',
  targetSha: TARGET,
  deliveryId: 'run-1001',
  executorSha: EXECUTOR,
  runId: '1001',
  fetchImpl: fake.fetchImpl,
  ...overrides,
});

const firstLine = output => JSON.parse(output.trim().split('\n')[0]);

test('a first admission durably writes a hash-chained record and matching anchor before returning admitted', async () => {
  const fake = makeListenerGitHub();
  const result = await persist(fake);

  assert.equal(result.exitCode, 0);
  assert.equal(result.admission.admitted, true);
  assert.equal(result.persistence.state, 'PERSISTED');
  assert.equal(result.persistence.branch, LISTENER_STORE_BRANCH);
  assert.equal(result.persistence.ledgerPath, LISTENER_STORE_LEDGER_PATH);
  assert.equal(result.persistence.anchorPath, LISTENER_STORE_ANCHOR_PATH);
  assert.equal(result.persistence.ledgerStored, true);
  assert.equal(result.persistence.anchorStored, true);
  assert.deepEqual(fake.writes.map(write => write.kind), ['create-branch', 'ledger', 'anchor']);

  const ledgerText = fake.files.get(LISTENER_TEST_LEDGER).text;
  const verification = verifyAdmissionLedger(ledgerText);
  assert.equal(verification.state, 'INTACT');
  assert.equal(verification.sequence, 1);
  assert.equal(verification.records[0].admission.missionBindingDigest, missionBindingDigest({
    missionId: 'mission-0001', repository: TARGET_REPOSITORY, sha: TARGET,
  }));
  assert.equal(verification.records[0].admission.deliveryId, 'run-1001');
  assert.equal(verification.records[0].admission.runId, '1001');
  for (const privateValue of ['mission-0001', TARGET_REPOSITORY, TARGET]) {
    assert.equal(ledgerText.includes(privateValue), false, `public ledger must not include ${privateValue}`);
  }
  const anchor = JSON.parse(fake.files.get(LISTENER_TEST_ANCHOR).text);
  assert.equal(anchor.head, verification.head);
  assert.equal(anchor.sequence, 1);
  assert.equal(anchor.recordCount, 1);
  assert.equal(JSON.stringify(result).includes(LISTENER_TEST_TOKEN), false);
});

test('policy refusals are reported but never appended to the durable admission ledger', async () => {
  const fake = makeListenerGitHub();
  const refused = await persist(fake, {...event(), sender: 'unauthorized-sender'});

  assert.equal(refused.exitCode, 0);
  assert.equal(refused.admission.admitted, false);
  assert.equal(refused.admission.reason, 'LISTENER_SENDER_UNAUTHORIZED');
  assert.equal(refused.persistence.state, 'NOT_STORED');
  assert.equal(refused.persistence.appended, false);
  assert.equal(fake.writes.length, 0);
  assert.equal(fake.files.has(LISTENER_TEST_LEDGER), false);
  assert.equal(fake.files.has(LISTENER_TEST_ANCHOR), false);
});

test('same-run retries are idempotent and a re-delivery in another run is suppressed by missionKey', async () => {
  const fake = makeListenerGitHub();
  const original = event();
  const first = await persist(fake, original, '1001');
  const writesAfterFirst = fake.writes.length;

  const sameRunRetry = await persist(fake, original, '1001');
  assert.equal(sameRunRetry.admission.admitted, true);
  assert.equal(sameRunRetry.persistence.state, 'PERSISTED');
  assert.equal(sameRunRetry.persistence.appended, false);
  assert.equal(sameRunRetry.persistence.alreadyRecordedForRun, true);
  assert.equal(fake.writes.length, writesAfterFirst, 'idempotent replay performs no second write');

  const laterDelivery = await persist(fake, event({runId: '1002'}), '1002');
  assert.equal(laterDelivery.exitCode, 0, 'a policy refusal is a completed decision');
  assert.equal(laterDelivery.admission.admitted, false);
  assert.equal(laterDelivery.admission.reason, 'LISTENER_REPLAY_DETECTED');
  assert.equal(laterDelivery.persistence.state, 'NOT_STORED');
  assert.equal(fake.writes.length, writesAfterFirst, 'a replay does not append or hand off');
  assert.equal(first.persistence.sequence, 1);
});

test('the listener CLI uses the durable store at runtime and suppresses a second mission run', async () => {
  const fake = makeListenerGitHub();
  const githubEvent = {sender: {login: SENDER}, client_payload: mission()};
  const baseEnv = {
    WOLF_LISTENER_STORE_REQUIRED: 'true',
    WOLF_LISTENER_EXECUTOR_SHA: EXECUTOR,
    WOLF_LISTENER_APPROVED_EXECUTOR_SHAS: EXECUTOR,
    WOLF_LISTENER_AUTHORIZED_SENDERS: SENDER,
    WOLF_LISTENER_REPOSITORY_ALLOWLIST: TARGET_REPOSITORY,
    GITHUB_TOKEN: LISTENER_TEST_TOKEN,
    GITHUB_REPOSITORY: LISTENER_TEST_REPOSITORY,
    GITHUB_RUN_ID: '2001',
  };
  let output = '';
  const firstExit = await runListenerCli(['admit', '--event', '/fixture/event.json'], {
    env: baseEnv,
    now: NOW,
    readFile: () => JSON.stringify(githubEvent),
    stdout: text => { output += text; },
    fetchImpl: fake.fetchImpl,
  });
  const first = firstLine(output);
  assert.equal(firstExit, 0);
  assert.equal(first.admitted, true);
  assert.equal(first.persistence.state, 'PERSISTED');
  assert.equal(first.deliveryId, 'run-2001');
  assert.equal(output.includes(LISTENER_TEST_TOKEN), false);
  for (const privateValue of ['factory-nightly-0001', TARGET_REPOSITORY, TARGET]) {
    assert.equal(output.includes(privateValue), false, `public listener output must not include ${privateValue}`);
  }

  const writesAfterFirst = fake.writes.length;
  output = '';
  const replayExit = await runListenerCli(['admit', '--event', '/fixture/event.json'], {
    env: {...baseEnv, GITHUB_RUN_ID: '2002'},
    now: NOW,
    readFile: () => JSON.stringify(githubEvent),
    stdout: text => { output += text; },
    fetchImpl: fake.fetchImpl,
  });
  const replay = firstLine(output);
  assert.equal(replayExit, 0);
  assert.equal(replay.admitted, false);
  assert.equal(replay.reason, 'LISTENER_REPLAY_DETECTED');
  assert.equal(fake.writes.length, writesAfterFirst);
});

test('a stale Contents API blob SHA conflict retries from the remote head without dropping prior admissions', async () => {
  const fake = makeListenerGitHub();
  await persist(fake, event({missionId: 'mission-0001', sha: TARGET}), '1001');
  const existingText = fake.files.get(LISTENER_TEST_LEDGER).text;
  fake.conflictNextLedgerWrite();

  const second = await persist(fake, event({missionId: 'mission-0002', sha: TARGET_NEXT, runId: '1002'}), '1002');
  assert.equal(second.exitCode, 0);
  assert.equal(second.admission.admitted, true);
  assert.equal(second.persistence.state, 'PERSISTED');
  const ledgerWrites = fake.writes.filter(write => write.kind === 'ledger');
  assert.equal(ledgerWrites.length, 3, 'one initial write, one rejected precondition, then one retry');

  const verification = verifyAdmissionLedger(fake.files.get(LISTENER_TEST_LEDGER).text);
  assert.equal(verification.state, 'INTACT');
  assert.equal(verification.records.length, 2);
  assert.equal(verification.records[0].admission.missionBindingDigest, missionBindingDigest({
    missionId: 'mission-0001', repository: TARGET_REPOSITORY, sha: TARGET,
  }));
  assert.equal(verification.records[1].admission.missionBindingDigest, missionBindingDigest({
    missionId: 'mission-0002', repository: TARGET_REPOSITORY, sha: TARGET_NEXT,
  }));
  const publicLedger = fake.files.get(LISTENER_TEST_LEDGER).text;
  for (const privateValue of ['mission-0001', 'mission-0002', TARGET_REPOSITORY, TARGET, TARGET_NEXT]) {
    assert.equal(publicLedger.includes(privateValue), false, `public ledger must not include ${privateValue}`);
  }
  assert.equal(verification.records[1].prev, verification.records[0].hash);
  assert.equal(existingText.split('\n').filter(Boolean).length, 1);
});

test('a branch-create race without a complete evidence pair blocks rather than initializing over it', async () => {
  const fake = makeListenerGitHub({createBranchRace: true});
  const result = await persist(fake);
  assert.equal(result.exitCode, 78);
  assert.equal(result.admission.admitted, false);
  assert.equal(result.persistence.state, 'BLOCKED');
  assert.equal(result.persistence.reason, 'EXISTING_BRANCH_HAS_NO_ADMISSION_EVIDENCE');
  assert.deepEqual(fake.writes.map(write => write.kind), ['create-branch']);
});

test('ledger success followed by anchor failure is PARTIAL and cannot pass the execution gate', async () => {
  const fake = makeListenerGitHub({failAnchorWrites: 1});
  const partial = await persist(fake);
  assert.equal(partial.exitCode, 78);
  assert.equal(partial.admission.admitted, false);
  assert.equal(partial.persistence.state, 'PARTIAL');
  assert.equal(partial.persistence.reason, 'LEDGER_STORED_ANCHOR_WRITE_FAILED');
  assert.equal(partial.persistence.ledgerStored, true);
  assert.equal(partial.persistence.anchorStored, false);
  assert.equal(fake.files.has(LISTENER_TEST_LEDGER), true);
  assert.equal(fake.files.has(LISTENER_TEST_ANCHOR), false);

  const denied = await gate(fake);
  assert.equal(denied.state, 'BLOCKED');
  assert.equal(denied.reason, 'ADMISSION_EVIDENCE_UNAVAILABLE');
  assert.equal(denied.credentialsPrinted, false);

  const retry = await persist(fake, event(), '1001');
  assert.equal(retry.exitCode, 78);
  assert.equal(retry.admission.admitted, false);
  assert.equal(retry.persistence.reason, 'LEDGER_ANCHOR_PAIR_INCOMPLETE');
});

test('a stale anchor cannot be advanced over a different pending mission, and the same run can repair its own final entry', async () => {
  const fake = makeListenerGitHub();
  await persist(fake, event({missionId: 'mission-0001', sha: TARGET}), '1001');
  fake.failNextAnchorWrite();
  const pending = event({missionId: 'mission-0002', sha: TARGET_NEXT, runId: '1002'});
  const partial = await persist(fake, pending, '1002');
  assert.equal(partial.exitCode, 78);
  assert.equal(partial.persistence.state, 'PARTIAL');

  const pendingGate = await verifyStoredMissionAdmission({
    token: LISTENER_TEST_TOKEN,
    repository: LISTENER_TEST_REPOSITORY,
    targetRepository: TARGET_REPOSITORY,
    missionId: 'mission-0002',
    targetSha: TARGET_NEXT,
    deliveryId: 'run-1002',
    executorSha: EXECUTOR,
    runId: '1002',
    fetchImpl: fake.fetchImpl,
  });
  assert.equal(pendingGate.state, 'BLOCKED');
  assert.equal(pendingGate.reason, 'ADMISSION_ANCHOR_STALE');

  const writesBeforeDifferentMission = fake.writes.length;
  const otherMission = await persist(fake, event({missionId: 'mission-0003', sha: '7'.repeat(40), runId: '1003'}), '1003');
  assert.equal(otherMission.exitCode, 78);
  assert.equal(otherMission.persistence.reason, 'ANCHOR_REPAIR_REQUIRED');
  assert.equal(fake.writes.length, writesBeforeDifferentMission, 'a different write cannot anchor the pending record');

  const sameRunRepair = await persist(fake, pending, '1002');
  assert.equal(sameRunRepair.exitCode, 0);
  assert.equal(sameRunRepair.admission.admitted, true);
  assert.equal(sameRunRepair.persistence.alreadyRecordedForRun, true);
  const repairedGate = await verifyStoredMissionAdmission({
    token: LISTENER_TEST_TOKEN,
    repository: LISTENER_TEST_REPOSITORY,
    targetRepository: TARGET_REPOSITORY,
    missionId: 'mission-0002',
    targetSha: TARGET_NEXT,
    deliveryId: 'run-1002',
    executorSha: EXECUTOR,
    runId: '1002',
    fetchImpl: fake.fetchImpl,
  });
  assert.equal(repairedGate.state, 'VERIFIED');
  assert.equal(repairedGate.anchorConsistent, true);
});

test('a valid same-writer anchor is a consistency check, not an independent-verifier claim', async () => {
  const fake = makeListenerGitHub();
  await persist(fake);
  const verified = await gate(fake);
  assert.equal(verified.state, 'VERIFIED');
  assert.equal(verified.admitted, true);
  assert.equal(verified.anchorConsistent, true);
  assert.equal(verified.trustModel, 'SAME_WRITER_ANCHORED_LEDGER');
  assert.equal(verified.independentVerifierRequired, true);

  const wrongRun = await gate(fake, {runId: '999'});
  assert.equal(wrongRun.state, 'BLOCKED');
  assert.equal(wrongRun.reason, 'ADMISSION_RECORD_NOT_FOUND');
  assert.deepEqual(fake.writes.map(write => write.kind), ['create-branch', 'ledger', 'anchor']);
});

test('hash corruption and an incomplete ledger shape fail verification', async () => {
  const fake = makeListenerGitHub();
  await persist(fake);
  const stored = fake.files.get(LISTENER_TEST_LEDGER);
  const entry = JSON.parse(stored.text.trim());
  entry.admission.missionBindingDigest = 'd'.repeat(64);
  fake.files.set(LISTENER_TEST_LEDGER, {...stored, text: JSON.stringify(entry) + '\n'});
  const verdict = await gate(fake);
  assert.equal(verdict.state, 'BLOCKED');
  assert.equal(verdict.reason, 'ADMISSION_LEDGER_NOT_INTACT');

  assert.equal(verifyAdmissionLedger('{"seq":1,"admission":{"admitted":true}}\n').state, 'TAMPERED');
});
