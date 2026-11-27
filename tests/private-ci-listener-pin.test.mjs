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

function pinnedJob(name) {
  const workflow = showAtPin(BRIDGE);
  const start = workflow.indexOf('\n  ' + name + ':\n');
  assert.ok(start >= 0, 'pinned executor must contain job ' + name);
  const remainder = workflow.slice(start + 1);
  const next = remainder.slice(1).search(/^  [a-z_][a-z0-9_-]*:\s*$/m);
  return next < 0 ? remainder : remainder.slice(0, next + 1);
}

test('the invoked executor enforces exact-target and economic gates before private execution', () => {
  const target = pinnedJob('target_verification');
  const execute = pinnedJob('execute');
  assert.match(target, /private-ci-resolve-target-cli\.mjs gate/);
  assert.match(target, /WOLF_CI_SHA: \$\{\{ inputs\.sha \}\}/);
  assert.match(execute, /needs: \[mission_admission, target_verification\]/);
  assert.match(execute, /needs\.target_verification\.outputs\.verified == 'true'/);
  for (const gate of ['ZERO_COST_RUNNER_AUTHORIZED', 'BILLING_VERIFIED', 'PROVIDER_VERIFIED', 'PRIVATE_RUNNER_ISOLATION_VERIFIED']) {
    assert.ok(execute.includes("vars.WOLF_CI_" + gate + " == 'true'"), 'pinned executor must enforce ' + gate);
  }
  assert.match(execute, /permissions:\n      contents: read\n/);
  assert.doesNotMatch(execute, /contents: write|checks: write|actions\/upload-artifact|private-ci-publish-receipt\.mjs/);
});

test('the invoked executor isolates aggregate status publication from private source execution', () => {
  const publisher = pinnedJob('publish_status');
  assert.match(publisher, /needs: \[mission_admission, target_verification, execute\]/);
  assert.match(publisher, /needs\.execute\.result/);
  assert.match(publisher, /permission-checks: write/);
  assert.match(publisher, /private-ci-publish-job-status\.mjs/);
  assert.doesNotMatch(publisher, /actions\/upload-artifact|private-ci-publish-receipt\.mjs|WOLF_FACTORY_DEPLOY_KEY/);
});
