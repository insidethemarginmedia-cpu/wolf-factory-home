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
  assert.equal(verdict.missionBindingVerified, true);
  assert.equal(verdict.targetSha, undefined);
  assert.equal(verdict.targetRepository, undefined);
  assert.equal(verdict.missionId, undefined);
  assert.equal(verdict.deliveryId, undefined);
  assert.equal(verdict.runId, undefined);
  assert.equal(verdict.credentialsPrinted, false);
  assert.equal(output.includes(LISTENER_TEST_TOKEN), false);
  for (const privateValue of ['mission-0001', TARGET_REPOSITORY, TARGET]) {
    assert.equal(output.includes(privateValue), false, `public gate output must not include ${privateValue}`);
  }
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
  assert.match(execute, /needs: \[mission_admission, target_verification\]/);
  const admissionStart = workflow.indexOf('\n  mission_admission:\n');
  const targetStartForOrdering = workflow.indexOf('\n  target_verification:\n');
  const executeStartForOrdering = workflow.indexOf('\n  execute:\n');
  assert.ok(admissionStart >= 0 && targetStartForOrdering > admissionStart && executeStartForOrdering > targetStartForOrdering);
  const admissionTail = workflow.slice(admissionStart, targetStartForOrdering);
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

test('durable admission gates both metadata access and the private source checkout', () => {
  const workflow = fs.readFileSync('.github/workflows/private-ci-bridge.yml', 'utf8');
  const admissionStart = workflow.indexOf('\n  mission_admission:\n');
  const targetStart = workflow.indexOf('\n  target_verification:\n');
  const executeStart = workflow.indexOf('\n  execute:\n');
  assert.ok(admissionStart >= 0 && targetStart > admissionStart && executeStart > targetStart);

  const admission = workflow.slice(admissionStart, targetStart);
  const target = workflow.slice(targetStart, executeStart);
  const publishStart = workflow.indexOf('\n  publish_status:\n', executeStart);
  const execute = workflow.slice(executeStart, publishStart);
  assert.match(jobCondition(admission), /github\.event_name == 'repository_dispatch'/);
  assert.match(admission, /contents: read/);
  assert.doesNotMatch(admission, /secrets\./);

  // The read-only admission job must finish before the metadata-only App token
  // can be minted in target_verification.
  assert.match(target, /needs: mission_admission/);
  assert.match(jobCondition(target), /needs\.mission_admission\.outputs\.verified == 'true'/);
  const metadataMint = target.indexOf('Mint a read-only App token for private PR metadata');
  const resolve = target.indexOf('Resolve the authoritative PR head');
  const targetGate = target.indexOf('Require the current exact PR target');
  assert.ok(metadataMint >= 0 && resolve > metadataMint && targetGate > resolve);
  assert.match(target, /steps\.target_reader\.outputs\.token/);

  // The per-job admission re-check is before any private source credential or
  // checkout in the execution job, and target verification is a required need.
  assert.match(execute, /needs: \[mission_admission, target_verification\]/);
  const secondGate = execute.indexOf('Re-verify durable mission admission before private access');
  const sourceMint = execute.indexOf('Mint the least-privilege read token for private source checkout');
  const privateCheckout = execute.indexOf('Checkout the private target at the immutable SHA');
  assert.ok(secondGate >= 0 && sourceMint > secondGate && privateCheckout > sourceMint);
  assert.match(execute, /steps\.source_reader\.outputs\.token/);
});
