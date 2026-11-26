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

test('the execute workflow gates the target before clone and does not continue on resolver failure', () => {
  const jobs = parseWorkflowJobs(fs.readFileSync(WORKFLOW, 'utf8'));
  const execute = jobs.find(job => job.name === 'execute');
  assert.ok(execute);
  const resolve = execute.steps.findIndex(step => /Resolve the authoritative PR head/.test(step.name ?? ''));
  const gate = execute.steps.findIndex(step => /Require current exact PR target/.test(step.name ?? ''));
  const clone = execute.steps.findIndex(step => /Clone the private commit at its immutable SHA/.test(step.name ?? ''));
  assert.ok(resolve >= 0 && gate > resolve && clone > gate, 'resolve -> enforce -> clone ordering is mandatory');

  const text = fs.readFileSync(WORKFLOW, 'utf8');
  const resolverBlock = text.slice(text.indexOf('Resolve the authoritative PR head'), text.indexOf('- name:', text.indexOf('Resolve the authoritative PR head') + 10));
  assert.doesNotMatch(resolverBlock, /continue-on-error:\s*true/, 'a failed resolver cannot be ignored');
  assert.match(resolverBlock, /WOLF_CI_APP_READER_TOKEN/);
  assert.doesNotMatch(resolverBlock, /WOLF_FACTORY_REPO_TOKEN/);

  const gateBlock = text.slice(text.indexOf('Require current exact PR target'), text.indexOf('- name:', text.indexOf('Require current exact PR target') + 10));
  assert.match(gateBlock, /private-ci-resolve-target-cli\.mjs gate/);
  assert.doesNotMatch(gateBlock, /continue-on-error:\s*true/);

  const executionSteps = execute.steps.slice(gate + 1, execute.steps.findIndex(step => /Validate the cross-repository mission/.test(step.name ?? '')));
  const bypasses = executionSteps.filter(step => /if:\s*always\(\)/.test(String(step.if ?? '')));
  assert.deepEqual(bypasses.map(step => step.name), [], 'target code must rely on the failing gate, not `always()`');
});
