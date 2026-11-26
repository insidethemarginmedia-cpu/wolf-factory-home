import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {verifyMissionAdmissionCli} from '../scripts/private-ci-listener-gate-cli.mjs';
import {admitMissionDurably} from '../scripts/private-ci-listener-store.mjs';
import {
  LISTENER_TEST_REPOSITORY,
  LISTENER_TEST_TOKEN,
  makeListenerGitHub,
} from './private-ci-listener-fake-github.mjs';

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const EXECUTOR = 'f'.repeat(40);
const TARGET = '8'.repeat(40);
const TARGET_REPOSITORY = 'donraposo1-source/project-wolf';
const SENDER = 'donraposo1-source';

function jobCondition(source) {
  const match = source.match(/^    if:\s*(.*)$/m);
  if (!match) return '';
  const marker = match[1].trim();
  if (!['>', '>-', '>+', '|', '|-', '|+'].includes(marker)) return marker;
  const start = match.index + match[0].length;
  const lines = source.slice(start).split('\n');
  const body = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!/^\s{6,}\S/.test(line)) break;
    body.push(line.trim());
  }
  return body.join(' ');
}

async function seededGitHub() {
  const fake = makeListenerGitHub();
  const admission = await admitMissionDurably({
    event: {
      eventType: 'wolf-private-ci',
      sender: SENDER,
      executorSha: EXECUTOR,
      deliveryId: 'run-3001',
      mission: {
        schemaVersion: 1,
        missionId: 'mission-0001',
        repository: TARGET_REPOSITORY,
        sha: TARGET,
        issuedAt: NOW - 1_000,
      },
    },
    policy: {
      now: NOW,
      authorizedSenders: [SENDER],
      approvedExecutorShas: [EXECUTOR],
      repositoryAllowlist: [TARGET_REPOSITORY],
    },
    token: LISTENER_TEST_TOKEN,
    repository: LISTENER_TEST_REPOSITORY,
    executorCommit: EXECUTOR,
    runId: '3001',
    now: NOW,
    fetchImpl: fake.fetchImpl,
  });
  assert.equal(admission.admission.admitted, true);
  return fake;
}

const baseEnv = outFile => ({
  GITHUB_TOKEN: LISTENER_TEST_TOKEN,
  GITHUB_REPOSITORY: LISTENER_TEST_REPOSITORY,
  GITHUB_RUN_ID: '3001',
  WOLF_CI_MISSION_ID: 'mission-0001',
  WOLF_CI_MISSION_TARGET_REPOSITORY: TARGET_REPOSITORY,
  WOLF_CI_MISSION_TARGET_SHA: TARGET,
  WOLF_CI_MISSION_DELIVERY_ID: 'run-3001',
  WOLF_CI_MISSION_EXECUTOR_SHA: EXECUTOR,
  WOLF_CI_MISSION_ADMISSION_FILE: outFile,
});

test('the read-only execution gate verifies exact persisted mission identity and writes a safe verdict', async () => {
  const fake = await seededGitHub();
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-listener-gate-')), 'admission.json');
  let output = '';
  const code = await verifyMissionAdmissionCli({
    env: baseEnv(outFile),
    fetchImpl: fake.fetchImpl,
    stdout: text => { output += text; },
  });

  const verdict = JSON.parse(output.trim());
  assert.equal(code, 0);
  assert.equal(verdict.state, 'VERIFIED');
  assert.equal(verdict.missionKey, 'mission-0001@' + TARGET);
  assert.equal(verdict.deliveryId, 'run-3001');
  assert.equal(verdict.runId, '3001');
  assert.equal(verdict.credentialsPrinted, false);
  assert.equal(output.includes(LISTENER_TEST_TOKEN), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(outFile, 'utf8')), verdict);
  assert.equal(fake.writes.length, 3, 'the gate reads evidence and performs no write');
});

test('the gate refuses a mismatched target or missing run correlation', async () => {
  const fake = await seededGitHub();
  let output = '';
  const code = await verifyMissionAdmissionCli({
    env: {...baseEnv(null), WOLF_CI_MISSION_TARGET_SHA: '9'.repeat(40)},
    fetchImpl: fake.fetchImpl,
    stdout: text => { output += text; },
  });
  assert.equal(code, 78);
  assert.equal(JSON.parse(output.trim()).state, 'BLOCKED');
  assert.equal(JSON.parse(output.trim()).reason, 'ADMISSION_RECORD_NOT_FOUND');

  output = '';
  const noRunCode = await verifyMissionAdmissionCli({
    env: {...baseEnv(null), GITHUB_RUN_ID: ''},
    fetchImpl: fake.fetchImpl,
    stdout: text => { output += text; },
  });
  assert.equal(noRunCode, 78);
  assert.equal(JSON.parse(output.trim()).reason, 'GITHUB_RUN_ID_REQUIRED');
});

test('a raw repository_dispatch cannot bypass the listener admission ledger', () => {
  const workflow = fs.readFileSync('.github/workflows/private-ci-bridge.yml', 'utf8');
  const executeStart = workflow.indexOf('\n  execute:\n');
  const executeTail = workflow.slice(executeStart + 1);
  const nextJob = executeTail.slice(1).search(/\n  [A-Za-z0-9_-]+:\n/);
  const execute = nextJob < 0 ? executeTail : executeTail.slice(0, nextJob + 1);
  const condition = jobCondition(execute);
  assert.match(condition, /needs\.mission_admission\.outputs\.verified == 'true'/);
  assert.match(condition, /github\.event_name == 'repository_dispatch'/,
    'the listener caller handles repository_dispatch; the bridge itself has no raw-dispatch trigger');
  assert.match(condition, /github\.workflow_ref == 'insidethemarginmedia-cpu\/wolf-factory-home\/\.github\/workflows\/mission-listener\.yml@refs\/heads\/main'/,
    'only the default-branch listener may call privileged execution');
  assert.match(execute, /needs: mission_admission/);
  const admissionStart = workflow.indexOf('\n  mission_admission:\n');
  const executeStartForOrdering = workflow.indexOf('\n  execute:\n');
  assert.ok(admissionStart >= 0 && admissionStart < executeStartForOrdering);
  const admissionTail = workflow.slice(admissionStart, executeStartForOrdering);
  assert.match(jobCondition(admissionTail), /github\.event_name == 'repository_dispatch'/);
  assert.match(admissionTail, /contents: read/);
  assert.doesNotMatch(admissionTail, /secrets\./);
  for (const name of ['sha', 'missionId', 'deliveryId', 'executorSha']) {
    assert.match(condition, new RegExp(`inputs\\.${name} != ''`), `execution requires ${name}`);
  }
  assert.doesNotMatch(condition, /github\.event_name == 'workflow_call'/,
    'the reusable workflow sees the caller event name, not a synthetic workflow_call event');
  assert.match(execute, /- name: Re-verify durable mission admission before private access\n        id: mission_admission\n        shell: bash/);
  assert.doesNotMatch(execute, /- name: Re-verify durable mission admission before private access\n        if:/,
    'mission admission cannot be made optional by omitting executorSha');
});

test('the gate verdict file is shared with the public receipt builder', () => {
  const workflow = fs.readFileSync('.github/workflows/private-ci-bridge.yml', 'utf8');
  const path = 'WOLF_CI_MISSION_ADMISSION_FILE: /tmp/wolf-ci-mission-admission.json';
  assert.equal(workflow.split(path).length - 1, 2, 'job-level receipt env and gate-step writer must use the same path');
  assert.match(fs.readFileSync('scripts/private-ci-bridge.mjs', 'utf8'), /missionAdmission: readMissionAdmission\(process\.env\.WOLF_CI_MISSION_ADMISSION_FILE\)/);
});

test('the bridge runs the durable admission gate before any private-source checkout or App credential mint', () => {
  const workflow = fs.readFileSync('.github/workflows/private-ci-bridge.yml', 'utf8');
  const executeStart = workflow.indexOf('\n  execute:\n');
  assert.ok(executeStart >= 0, 'execute job exists');
  const executeTail = workflow.slice(executeStart + 1);
  const nextJob = executeTail.slice(1).search(/\n  [A-Za-z0-9_-]+:\n/);
  const execute = nextJob < 0 ? executeTail : executeTail.slice(0, nextJob + 1);
  const readOnlyGate = workflow.indexOf('Verify durable mission admission with a read-only token');
  const gate = execute.indexOf('Re-verify durable mission admission before private access');
  const retirement = execute.indexOf('Hydrate and verify durable retirement evidence before credential selection');
  const appMint = execute.indexOf('Mint the reader installation token with the official action');
  const privateCheckout = execute.indexOf('Clone the private commit at its immutable SHA');
  assert.ok(readOnlyGate >= 0 && readOnlyGate < executeStart, 'read-only admission must pass before the privileged execute job starts');
  assert.ok(gate >= 0, 'reusable execution must re-read the durable admission ledger');
  assert.ok(retirement >= 0 && gate < retirement, 'the second gate runs before retirement or other repository access');
  assert.ok(gate < appMint, 'the gate runs before a private App credential is minted');
  assert.ok(gate < privateCheckout, 'the gate runs before private source checkout');
});
