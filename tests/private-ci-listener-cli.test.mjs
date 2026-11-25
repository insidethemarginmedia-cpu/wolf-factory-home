// Executes the listener CLI the way the workflow does.
//
// The module tests prove the admission logic. These prove the *entry point*: that
// the command exits cleanly, emits a decision the workflow can parse, and refuses
// when it cannot decide. A crash here would leave `admitted` unset, and an unset
// output compared to 'true' is false - safe, but silent. These tests make the
// refusal explicit instead.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

const CLI = 'scripts/private-ci-listener-cli.mjs';
const EXECUTOR = '96cab355878d6ca37dcd6d40ab79b7ac595d1c22';
const TARGET = '8d319fc50be4e4d225e3bb80de963583899c25ec';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-listener-'));

const baseEnv = {
  WOLF_LISTENER_AUTHORIZED_SENDERS: 'donraposo1-source',
  WOLF_LISTENER_APPROVED_EXECUTOR_SHAS: EXECUTOR,
  WOLF_LISTENER_EXECUTOR_SHA: EXECUTOR,
  WOLF_LISTENER_REPOSITORY_ALLOWLIST: 'donraposo1-source/project-wolf',
  GITHUB_RUN_ID: '99001',
};

const run = (args, env = {}, extra = {}) => {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: {...process.env, ...env},
      stdio: ['ignore', 'pipe', 'pipe'],
      ...extra,
    });
    return {code: 0, stdout};
  } catch (error) {
    return {code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '')};
  }
};

const writeEvent = (payload, overrides = {}) => {
  const dir = tmp();
  const file = path.join(dir, 'event.json');
  fs.writeFileSync(file, JSON.stringify({
    sender: {login: 'donraposo1-source'},
    client_payload: payload,
    ...overrides,
  }));
  return file;
};

const freshMission = (overrides = {}) => ({
  schemaVersion: 1,
  missionId: 'factory-nightly-0001',
  repository: 'donraposo1-source/project-wolf',
  sha: TARGET,
  issuedAt: Date.now() - 1000,
  executorSha: EXECUTOR,
  ...overrides,
});

const decision = result => JSON.parse(result.stdout.trim().split('\n')[0]);

test('a valid event is admitted and the decision is parseable', () => {
  const file = writeEvent(freshMission());
  const result = run(['admit', '--event', file], baseEnv);
  assert.equal(result.code, 0);
  const d = decision(result);
  assert.equal(d.admitted, true);
  assert.equal(d.executorSha, EXECUTOR);
  assert.equal(d.credentialsRequired, false);
});

test('the CLI emits an admission record alongside the decision', () => {
  const file = writeEvent(freshMission());
  const result = run(['admit', '--event', file], baseEnv);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 2, 'decision and record must both be emitted');
  const record = JSON.parse(lines[1]).admissionRecord;
  assert.equal(record.state, 'ADMITTED');
  assert.equal(record.credentialsRequired, false);
});

test('an unauthorized sender is refused with a machine-readable reason', () => {
  const file = writeEvent(freshMission(), {sender: {login: 'attacker'}});
  const result = run(['admit', '--event', file], baseEnv);
  assert.equal(result.code, 0, 'a refusal is a successful decision');
  const d = decision(result);
  assert.equal(d.admitted, false);
  assert.equal(d.reason, 'LISTENER_SENDER_UNAUTHORIZED');
});

test('an unreadable event refuses and does not admit by omission', () => {
  const result = run(['admit', '--event', '/nonexistent/event.json'], baseEnv);
  const d = decision(result);
  assert.equal(d.admitted, false);
  assert.equal(d.reason, 'LISTENER_EVENT_UNREADABLE');
});

test('the event cannot override the executor SHA pinned by the workflow', () => {
  // The caller proposes a different commit; the workflow's pin is authoritative and
  // the disagreement is a refusal, not a preference.
  const file = writeEvent(freshMission({executorSha: 'b'.repeat(40)}));
  const result = run(['admit', '--event', file], baseEnv);
  const d = decision(result);
  assert.equal(d.admitted, false);
  assert.equal(d.reason, 'LISTENER_EXECUTOR_SHA_NOT_APPROVED');
});

test('the sender is taken from the authenticated account, not the payload', () => {
  // A payload claiming a different sender must not help: the sender field is read
  // from the event envelope that GitHub attributes.
  const file = writeEvent(freshMission({sender: 'donraposo1-source'}));
  const result = run(['admit', '--event', file], {...baseEnv});
  assert.equal(decision(result).admitted, true, 'the envelope sender is authorized');

  const forged = writeEvent(freshMission(), {sender: {login: 'attacker'}});
  const forgedResult = run(['admit', '--event', forged], baseEnv);
  assert.equal(decision(forgedResult).admitted, false, 'a forged envelope sender is refused');
});

test('an event with no sender is refused', () => {
  const file = writeEvent(freshMission(), {sender: undefined});
  const result = run(['admit', '--event', file], baseEnv);
  assert.equal(decision(result).admitted, false);
});

test('the delivery identity comes from the run id and the caller cannot choose it', () => {
  const file = writeEvent(freshMission());
  const result = run(['admit', '--event', file], {...baseEnv, GITHUB_RUN_ID: '44556677'});
  const [dec] = result.stdout.trim().split('\n');
  const record = JSON.parse(result.stdout.trim().split('\n')[1]).admissionRecord;
  assert.equal(JSON.parse(dec).admitted, true);
  assert.equal(record.deliveryId, 'run-44556677');
});

test('a branch name as the private target SHA is refused', () => {
  const file = writeEvent(freshMission({sha: 'main'}));
  const result = run(['admit', '--event', file], baseEnv);
  const d = decision(result);
  assert.equal(d.admitted, false);
  assert.equal(d.reason, 'LISTENER_MISSION_REJECTED');
});

test('an expired mission is refused', () => {
  const file = writeEvent(freshMission({issuedAt: Date.now() - 2 * 60 * 60 * 1000}));
  const result = run(['admit', '--event', file], baseEnv);
  const d = decision(result);
  assert.equal(d.admitted, false);
  assert.equal(d.detail.missionReason, 'MISSION_EXPIRED');
});

test('an empty sender allowlist refuses everything', () => {
  const file = writeEvent(freshMission());
  const result = run(['admit', '--event', file], {...baseEnv, WOLF_LISTENER_AUTHORIZED_SENDERS: ''});
  const d = decision(result);
  assert.equal(d.admitted, false);
  assert.equal(d.detail.reason, 'ALLOWLIST_EMPTY');
});
