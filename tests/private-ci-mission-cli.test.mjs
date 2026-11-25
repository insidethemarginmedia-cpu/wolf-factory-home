import assert from 'node:assert/strict';
import test from 'node:test';
import {missionCli, MISSION_EXIT, ALLOWED_REPOSITORIES} from '../scripts/private-ci-mission-cli.mjs';
import {MISSION_SCHEMA_VERSION, MISSION_STATES, MISSION_REQUIRED_CHECKS} from '../scripts/private-ci-mission.mjs';

const NOW = Date.parse('2026-11-25T00:00:00Z');
const SHA = '8d319fc50be4e4d225e3bb80de963583899c25ec';
const ACTOR = 'wolf-factory-automation[bot]';
const HOME = 'insidethemarginmedia-cpu/wolf-factory-home';
const RESERVATION = 'f'.repeat(64);
const payload = {
  schemaVersion: MISSION_SCHEMA_VERSION,
  missionId: 'MISSION-2026-11-25-0007',
  sha: SHA,
  repository: 'donraposo1-source/project-wolf',
  pr: 743,
  issuedAt: NOW - 30_000,
  requestedBy: ACTOR,
};

async function run(body, {env: overrides = {}, now = NOW, reservation = null, event = 'repository_dispatch', reserveImpl = null} = {}) {
  const lines = [];
  const outputs = [];
  let reserveCalls = 0;
  const environment = {
    CLIENT_PAYLOAD: typeof body === 'string' ? body : JSON.stringify(body),
    GITHUB_EVENT_NAME: event,
    GITHUB_ACTOR: ACTOR,
    GITHUB_REPOSITORY: HOME,
    GITHUB_RUN_ID: '12345',
    GITHUB_TOKEN: 'fake-home-token',
    WOLF_CI_TARGET_REPOSITORY: 'donraposo1-source/project-wolf',
    WOLF_CI_TARGET_PR: '743',
    WOLF_CI_REQUESTED_PR: '',
    WOLF_CI_MISSION_ALLOWED_ACTORS: ACTOR,
    ...overrides,
  };
  const code = await missionCli([], {
    env: environment,
    now,
    readFile: () => (typeof body === 'string' ? body : JSON.stringify(body)),
    writeFile: () => {},
    stdout: text => lines.push(text),
    writeOutput: line => outputs.push(line),
    writeEnv: () => {},
    reserve: async input => {
      reserveCalls += 1;
      if (reserveImpl) return reserveImpl(input);
      return reservation ?? ({state: 'RESERVED', keyHash: RESERVATION, rateSlot: 0, durable: true, mission: input.mission, actor: input.actor});
    },
  });
  return {code, report: JSON.parse(lines.join('')), outputs, environment, reserveCalls};
}

test('an authenticated immutable mission is durably reserved before acceptance', async () => {
  let reservationFinished = false;
  const {code, report, outputs, reserveCalls} = await run(payload, {
    reserveImpl: async input => {
      await Promise.resolve();
      reservationFinished = true;
      return {state: 'RESERVED', keyHash: RESERVATION, rateSlot: 0, durable: true, mission: input.mission, actor: input.actor};
    },
  });
  assert.equal(code, MISSION_EXIT.ACCEPTED);
  assert.equal(reservationFinished, true);
  assert.equal(reserveCalls, 1);
  assert.equal(report.state, MISSION_STATES.ACCEPTED);
  assert.equal(report.keyHash, RESERVATION);
  assert.equal(report.sha, SHA);
  assert.equal(report.pullRequestNumber, 743);
  assert.equal(report.durable, true);
  assert.ok(outputs.includes('accepted=true'));
  assert.ok(outputs.includes(`sha=${SHA}`));
  assert.ok(outputs.includes(`mission_key=${RESERVATION}`));
});

test('replay is suppressed by the durable reservation backend, not a runner-local journal', async () => {
  const {code, report, outputs} = await run(payload, {reservation: {state: 'DUPLICATE', reason: 'MISSION_ALREADY_RESERVED', keyHash: RESERVATION, durable: true}});
  assert.equal(code, MISSION_EXIT.DUPLICATE);
  assert.equal(report.state, MISSION_STATES.DUPLICATE);
  assert.equal(report.durable, true);
  assert.ok(outputs.includes('accepted=false'));
  assert.equal(outputs.some(line => line.startsWith('sha=')), false);
});

test('missing durable storage blocks execution rather than falling back to local files', async () => {
  const {code, report, outputs} = await run(payload, {reservation: {state: 'BLOCKED', reason: 'MISSION_STORE_PERMISSION_DENIED', durable: false}});
  assert.equal(code, MISSION_EXIT.BLOCKED);
  assert.equal(report.state, MISSION_STATES.BLOCKED);
  assert.equal(report.reason, 'MISSION_STORE_PERMISSION_DENIED');
  assert.equal(report.durable, false);
  assert.equal(outputs.includes('accepted=true'), false);
});

test('rate-limit rejection is explicit, durable and cannot produce an accepted output', async () => {
  const {code, report, outputs} = await run(payload, {reservation: {state: 'RATE_LIMITED', reason: 'MISSION_SENDER_HOURLY_LIMIT', keyHash: RESERVATION, durable: true}});
  assert.equal(code, MISSION_EXIT.RATE_LIMITED);
  assert.equal(report.state, MISSION_STATES.RATE_LIMITED);
  assert.equal(report.durable, true);
  assert.equal(outputs.includes('accepted=true'), false);
});

test('workflow_dispatch is converted to a stable exact-SHA mission and supports an explicit fresh retry id', async () => {
  let admittedMission = null;
  const {code, report} = await run(null, {
    event: 'workflow_dispatch',
    env: {WOLF_CI_REQUESTED_SHA: SHA},
    reserveImpl: async input => { admittedMission = input.mission; return {state: 'RESERVED', keyHash: RESERVATION, rateSlot: 0, durable: true}; },
  });
  assert.equal(code, MISSION_EXIT.ACCEPTED);
  assert.equal(report.sha, SHA);
  assert.equal(report.pullRequestNumber, 743);
  assert.equal(report.state, MISSION_STATES.ACCEPTED);
  assert.equal(admittedMission.missionId, `manual:${SHA}`);

  let retryMission = null;
  const retryId = 'manual-retry-2026-01';
  const retry = await run(null, {
    event: 'workflow_dispatch',
    env: {WOLF_CI_REQUESTED_SHA: SHA, WOLF_CI_REQUESTED_MISSION_ID: retryId},
    reserveImpl: async input => { retryMission = input.mission; return {state: 'RESERVED', keyHash: 'a'.repeat(64), rateSlot: 1, durable: true}; },
  });
  assert.equal(retry.code, MISSION_EXIT.ACCEPTED);
  assert.equal(retryMission.missionId, retryId);
});

test('an actor missing from the explicit allowlist cannot reserve a mission', async () => {
  const {code, report, reserveCalls} = await run(payload, {env: {WOLF_CI_MISSION_ALLOWED_ACTORS: ''}});
  assert.equal(code, MISSION_EXIT.REJECTED);
  assert.equal(report.reason, 'MISSION_ACTOR_ALLOWLIST_REQUIRED');
  assert.equal(reserveCalls, 0);
});

test('an unauthorized repository is rejected before the reservation backend is called', async () => {
  const {code, report, reserveCalls} = await run({...payload, repository: 'someone/else'});
  assert.equal(code, MISSION_EXIT.REJECTED);
  assert.equal(report.reason, 'MISSION_REPOSITORY_NOT_ALLOWED');
  assert.equal(reserveCalls, 0);
});

test('unreadable or missing payloads fail closed', async () => {
  const bad = await run('{not json');
  assert.equal(bad.code, MISSION_EXIT.REJECTED);
  assert.equal(bad.report.reason, 'MISSION_PAYLOAD_REQUIRED');
  const lines = [];
  const code = await missionCli([], {env: {}, now: NOW, stdout: text => lines.push(text), writeOutput: () => {}, writeEnv: () => {}});
  assert.equal(code, MISSION_EXIT.REJECTED);
  assert.equal(JSON.parse(lines.join('')).reason, 'MISSION_PAYLOAD_REQUIRED');
});

test('only the private target repository is accepted and the fixed 13 checks cannot be reduced', async () => {
  assert.deepEqual([...ALLOWED_REPOSITORIES], ['donraposo1-source/project-wolf']);
  assert.equal(MISSION_REQUIRED_CHECKS.length, 13);
  const partial = await run({...payload, checks: ['unit']});
  assert.equal(partial.report.reason, 'MISSION_CHECKS_NOT_ALLOWED');
  assert.equal(partial.reserveCalls, 0);
});

test('the intake output never carries the payload or a credential', async () => {
  const {report} = await run({...payload, note: 'PRIVATE_SOURCE_MARKER'});
  assert.equal(JSON.stringify(report).includes('PRIVATE_SOURCE_MARKER'), false);
  assert.equal(JSON.stringify(report).includes('fake-home-token'), false);
  assert.equal(report.credentialsPrinted, false);
});
