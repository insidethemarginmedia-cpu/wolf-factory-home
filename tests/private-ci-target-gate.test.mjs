// A resolver that reports STALE is not an execution gate. The previous workflow
// continued to clone and test its fixed historical SHA after publishing
// acceptanceValid=false. Exercise both the command and its workflow placement.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {parseWorkflowJobs} from '../scripts/private-ci-workflow.mjs';

const CLI = 'scripts/private-ci-resolve-target-cli.mjs';
const WORKFLOW = '.github/workflows/private-ci-bridge.yml';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-target-gate-'));
const run = (args, env = {}) => {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8', env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {code: 0, stdout};
  } catch (error) {
    return {code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '')};
  }
};
const validSha = 'a'.repeat(40);
const currentTarget = (pinnedSha = validSha) => ({
  target: {
    state: 'RESOLVED', relation: 'CURRENT', prHead: validSha, pinnedSha,
    prState: 'open', prMerged: false,
    treeIdentity: {pinnedTree: 'b'.repeat(40), prHeadTree: 'b'.repeat(40), identical: true},
  },
  verdict: {state: 'CURRENT', acceptanceValid: true, reason: null},
});

test('the real gate CLI allows only a current, exact, tree-resolved target', () => {
  const dir = tmp();
  const input = path.join(dir, 'target.json');
  fs.writeFileSync(input, JSON.stringify(currentTarget()));
  const result = run(['gate', '--in', input], {WOLF_CI_SHA: validSha});
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /"state":"ACCEPTED"/);
  assert.match(result.stdout, /"executionSha":"aaaaaaaa/);
});

test('the gate rejects stale or mismatched target SHAs before checkout', () => {
  const dir = tmp();
  const input = path.join(dir, 'target.json');
  fs.writeFileSync(input, JSON.stringify(currentTarget('c'.repeat(40))));
  const result = run(['gate', '--in', input], {WOLF_CI_SHA: validSha});
  assert.equal(result.code, 79);
  const decision = JSON.parse(result.stdout.trim());
  assert.equal(decision.state, 'BLOCKED');
  assert.equal(decision.acceptanceValid, false);
  assert.equal(decision.reason, 'PIN_NO_LONGER_PR_HEAD');
});

test('missing or forged resolver output is not an acceptance', () => {
  const dir = tmp();
  const missing = run(['gate', '--in', path.join(dir, 'missing.json')], {WOLF_CI_SHA: validSha});
  assert.equal(missing.code, 79);
  assert.equal(JSON.parse(missing.stdout).reason, 'TARGET_OUTPUT_UNAVAILABLE');

  const input = path.join(dir, 'forged.json');
  const forged = currentTarget();
  forged.verdict.acceptanceValid = false;
  forged.verdict.reason = 'forged-pass';
  fs.writeFileSync(input, JSON.stringify(forged));
  const denied = run(['gate', '--in', input], {WOLF_CI_SHA: validSha});
  assert.equal(denied.code, 79);
  assert.equal(JSON.parse(denied.stdout).acceptanceValid, false);
});

test('the target job gates the exact PR SHA before the dependent source checkout', () => {
  const text = fs.readFileSync(WORKFLOW, 'utf8');
  const jobs = parseWorkflowJobs(text);
  const target = jobs.find(job => job.name === 'target_verification');
  const execute = jobs.find(job => job.name === 'execute');
  assert.ok(target && execute);

  const resolve = target.steps.findIndex(step => /Resolve the authoritative PR head/.test(step.name ?? ''));
  const gate = target.steps.findIndex(step => /Require the current exact PR target/.test(step.name ?? ''));
  assert.ok(resolve >= 0 && gate > resolve, 'resolve -> exact-SHA gate ordering is mandatory');

  const targetBlockStart = text.indexOf('  target_verification:');
  const executeBlockStart = text.indexOf('  execute:', targetBlockStart);
  const targetBlock = text.slice(targetBlockStart, executeBlockStart);
  const executeBlockEnd = text.indexOf('  publish_status:', executeBlockStart);
  const executeBlock = text.slice(executeBlockStart, executeBlockEnd);
  assert.match(targetBlock, /private-ci-resolve-target-cli\.mjs gate/);
  assert.doesNotMatch(targetBlock, /continue-on-error:\s*true/);
  assert.match(targetBlock, /WOLF_CI_APP_READER_TOKEN/);
  assert.doesNotMatch(targetBlock, /WOLF_FACTORY_REPO_TOKEN/);
  assert.match(executeBlock, /needs: \[mission_admission, target_verification\]/);
  assert.match(executeBlock, /needs\.target_verification\.outputs\.verified == 'true'/);

  const checkout = execute.steps.find(step => /Checkout the private target at the immutable SHA/.test(step.name ?? ''));
  assert.ok(checkout, 'the source checkout must be explicit');
  assert.equal(checkout.with.ref, '${{ inputs.sha }}');
  assert.equal(checkout.with['persist-credentials'], 'false');
  assert.equal(checkout.with.token, '${{ steps.source_reader.outputs.token }}');
  assert.equal(target.steps.some(step => /Checkout the private target/.test(step.name ?? '')), false,
    'metadata verification must not fetch private source');
});
