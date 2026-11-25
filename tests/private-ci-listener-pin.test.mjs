// The listener's executor pin must resolve to a workflow that can actually be called.
//
// The first version pinned 96cab35, which predates the `workflow_call` trigger. The
// reference was syntactically valid, the SHA was immutable and approved, and the
// first real mission would have failed with "workflow is not reusable". Pinning an
// immutable commit is necessary but not sufficient: the commit must carry the
// interface the caller uses.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {test} from 'node:test';

const LISTENER = '.github/workflows/mission-listener.yml';
const BRIDGE = '.github/workflows/private-ci-bridge.yml';
const text = fs.readFileSync(LISTENER, 'utf8');

const pinned = (() => {
  const match = text.match(/private-ci-bridge\.yml@([0-9a-f]{40})/);
  return match ? match[1] : null;
})();

test('the listener pins an immutable 40-hex executor', () => {
  assert.ok(pinned, 'the listener must pin the bridge by full SHA');
  assert.match(pinned, /^[0-9a-f]{40}$/);
});

test('the pinned executor commit is reachable in this repository', () => {
  // A pin to a SHA that does not exist is a reference that fails at call time, not
  // at review time.
  const type = execFileSync('git', ['cat-file', '-t', pinned], {encoding: 'utf8'}).trim();
  assert.equal(type, 'commit');
});

test('the pinned commit actually declares workflow_call, or it cannot be reused', () => {
  // This is the defect: 96cab35 was immutable and approved but had no
  // workflow_call trigger, so a job-level `uses:` against it could not run.
  const bridgeAtPin = execFileSync('git', ['show', `${pinned}:${BRIDGE}`], {encoding: 'utf8'});
  assert.match(bridgeAtPin, /^  workflow_call:/m, 'the pinned commit must expose the reusable interface the listener calls');
});

test('the pinned commit accepts the inputs the listener passes', () => {
  const bridgeAtPin = execFileSync('git', ['show', `${pinned}:${BRIDGE}`], {encoding: 'utf8'});
  const block = bridgeAtPin.slice(bridgeAtPin.indexOf('  workflow_call:'), bridgeAtPin.indexOf('  workflow_dispatch:'));
  for (const input of ['sha:', 'missionId:', 'deliveryId:']) {
    assert.ok(block.includes(input), `the pinned bridge must declare input ${input}`);
  }
});

test('every executor reference agrees, and action pins are separately allowed', () => {
  // `actions/checkout` is also pinned by SHA, which is correct and unrelated. The
  // check is that no executor reference disagrees with the approved value.
  const envSha = text.match(/WOLF_LISTENER_EXECUTOR_SHA:\s*([0-9a-f]{40})/)?.[1];
  const approvedSha = text.match(/WOLF_LISTENER_APPROVED_EXECUTOR_SHAS:\s*([0-9a-f]{40})/)?.[1];
  assert.equal(envSha, pinned, 'the workflow pin and the uses: reference must agree');
  assert.equal(approvedSha, pinned, 'the approved list must contain the pin');

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
