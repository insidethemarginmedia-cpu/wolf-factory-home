// The listener's executor pin must resolve to a workflow that can actually be called.
//
// The first version pinned 96cab35, which predates the `workflow_call` trigger. The
// reference was syntactically valid and immutable, but the first real mission would
// have failed with "workflow is not reusable". Pinning an immutable commit is
// necessary but not sufficient: the commit must carry the interface the caller uses.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {ensureCommit} from './private-ci-git-pin-helpers.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const LISTENER = '.github/workflows/mission-listener.yml';
const BRIDGE = '.github/workflows/private-ci-bridge.yml';
const text = fs.readFileSync(path.join(ROOT, LISTENER), 'utf8');

const pinned = (() => {
  const match = text.match(/private-ci-bridge\.yml@([0-9a-f]{40})/);
  return match ? match[1] : null;
})();

function showAtPin(file) {
  if (!ensureCommit(pinned)) throw new Error(`PINNED_EXECUTOR_COMMIT_UNAVAILABLE: ${pinned}`);
  return execFileSync('git', ['show', `${pinned}:${file}`], {cwd: ROOT, encoding: 'utf8'});
}

test('the listener pins an immutable 40-hex executor', () => {
  assert.ok(pinned, 'the listener must pin the bridge by full SHA');
  assert.match(pinned, /^[0-9a-f]{40}$/);
});

test('the pinned executor commit is reachable in this repository', () => {
  // A pin to a SHA that does not exist is a reference that fails at call time, not
  // at review time. Fetching from origin keeps this check valid in shallow CI clones.
  assert.equal(ensureCommit(pinned), true, `executor ${pinned} must resolve from the repository or origin`);
  const type = execFileSync('git', ['cat-file', '-t', pinned], {cwd: ROOT, encoding: 'utf8'}).trim();
  assert.equal(type, 'commit');
});

test('the pinned commit actually declares workflow_call, or it cannot be reused', () => {
  // An immutable but non-reusable commit still fails at call time.
  const bridgeAtPin = showAtPin(BRIDGE);
  assert.match(bridgeAtPin, /^  workflow_call:/m, 'the pinned bridge must expose the reusable interface the listener calls');
});

test('the pinned commit accepts the inputs the listener passes', () => {
  const bridgeAtPin = showAtPin(BRIDGE);
  const block = bridgeAtPin.slice(bridgeAtPin.indexOf('  workflow_call:'), bridgeAtPin.indexOf('  workflow_dispatch:'));
  for (const input of ['sha:', 'missionId:', 'deliveryId:', 'executorSha:']) {
    assert.ok(block.includes(input), `the pinned bridge must declare input ${input}`);
  }
});

test('the pinned executor commit contains durable admission and execution-gate code', () => {
  const bridgeAtPin = showAtPin(BRIDGE);
  const listenerCliAtPin = showAtPin('scripts/private-ci-listener-cli.mjs');
  const storeAtPin = showAtPin('scripts/private-ci-listener-store.mjs');
  const gateAtPin = showAtPin('scripts/private-ci-listener-gate-cli.mjs');
  const bridgeScriptAtPin = showAtPin('scripts/private-ci-bridge.mjs');
  assert.match(listenerCliAtPin, /admitMissionDurably/);
  assert.match(storeAtPin, /verifyAdmissionLedger/);
  assert.match(gateAtPin, /verifyStoredMissionAdmission/);
  assert.match(bridgeScriptAtPin, /SAFE_MISSION_ADMISSION_REASONS/);
  assert.match(bridgeScriptAtPin, /missionAdmission: readMissionAdmission\(process\.env\.WOLF_CI_MISSION_ADMISSION_FILE\)/);
  assert.match(bridgeAtPin, /Re-verify durable mission admission before private access/);
  for (const input of ['sha', 'missionId', 'deliveryId', 'executorSha']) {
    assert.match(bridgeAtPin, new RegExp(`inputs\\.${input} != ''`), `the pinned executor must require ${input}`);
  }
  assert.doesNotMatch(bridgeAtPin, /github\.event_name == 'workflow_call'/,
    'the reusable workflow must not assume github.event_name differs from its caller event');
});

test('the runtime listener requires the durable store and the configured executor pin', () => {
  assert.match(text, /WOLF_LISTENER_STORE_REQUIRED:\s*'true'/);
  assert.match(text, /executorSha:\s*\$\{\{ needs\.admit\.outputs\.executor_sha \}\}/);
  const source = fs.readFileSync(path.join(ROOT, 'scripts/private-ci-listener-cli.mjs'), 'utf8');
  assert.match(source, /admitMissionDurably/);
  assert.match(source, /configuredExecutorShas\.includes\(pinnedExecutorSha\)/);
  assert.doesNotMatch(source, /deliveries:\s*\[\]/);
});

test('the listener cannot start a runner until every economic and isolation gate is verified', () => {
  const start = text.indexOf('  admit:');
  const end = text.indexOf('\n  execute:', start);
  assert.ok(start >= 0 && end > start);
  const admissionJob = text.slice(start, end);
  for (const variable of [
    'WOLF_CI_ZERO_COST_RUNNER_AUTHORIZED',
    'WOLF_CI_BILLING_VERIFIED',
    'WOLF_CI_PROVIDER_VERIFIED',
    'WOLF_CI_PRIVATE_RUNNER_ISOLATION_VERIFIED',
  ]) {
    assert.match(admissionJob, new RegExp(`vars\\.${variable} == 'true'`), `${variable} must be explicitly verified before runner allocation`);
  }
});

test('public listener logs print only an admission aggregate, never the raw mission payload', () => {
  assert.match(text, /LISTENER_ADMITTED=/);
  assert.match(text, /durableState/);
  assert.doesNotMatch(text, /cat "\$WOLF_LISTENER_OUTPUT"/);
  assert.doesNotMatch(text, /cat '\$WOLF_LISTENER_OUTPUT'/);
  const source = fs.readFileSync(path.join(ROOT, 'scripts/private-ci-listener-cli.mjs'), 'utf8');
  assert.match(source, /publicListenerDecision/);
  assert.doesNotMatch(source, /stdout\(JSON\.stringify\(\{\.\.\.admission, persistence\}\)/);
});

test('every executor reference agrees, and action pins are separately allowed', () => {
  // `actions/checkout` is also pinned by SHA, which is correct and unrelated. The
  // check is that no executor reference disagrees with the configured candidate.
  const envSha = text.match(/WOLF_LISTENER_EXECUTOR_SHA:\s*([0-9a-f]{40})/)?.[1];
  const approvedSha = text.match(/WOLF_LISTENER_APPROVED_EXECUTOR_SHAS:\s*([0-9a-f]{40})/)?.[1];
  assert.equal(envSha, pinned, 'the workflow pin and the uses: reference must agree');
  assert.equal(approvedSha, pinned, 'the configured allowlist must contain the pin');

  // Action pins must be immutable too, not floating tags.
  // Anchored to the start of a YAML key, so the literal `uses:` inside comments does
  // not match - a naive regex flagged a comment as a floating tag.
  const actionRefs = [...text.matchAll(/^\s+uses:\s*(\S+)$/gm)].map(match => match[1]);
  for (const ref of actionRefs) {
    assert.match(ref, /@[0-9a-f]{40}$/, 'action ' + ref + ' must be pinned to a commit, not a tag');
  }
});

test('the listener does not pin a branch or tag', () => {
  assert.doesNotMatch(text, /private-ci-bridge\.yml@(main|master|HEAD|\$\{)/);
});
