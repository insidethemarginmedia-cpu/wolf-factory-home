// Executes the target resolver the way the workflow does.
//
// The module tests passed while the command printed nothing and exited 0, so the
// workflow wrote an empty file and the receipt reported NOT_REPORTED - a green run
// with a resolution step that resolved nothing. This is the same class of defect as
// the undefined `flag` helper: unit-tested module, broken entry point.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {buildPublicTargetAggregate} from '../scripts/private-ci-resolve-target-cli.mjs';

const CLI = 'scripts/private-ci-resolve-target-cli.mjs';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-target-'));

const run = (args, env = {}) => {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: {...process.env, ...env},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {code: 0, stdout};
  } catch (error) {
    return {code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '')};
  }
};

test('the command emits a decision rather than printing nothing', () => {
  // The specific regression: exit 0 with empty stdout.
  const result = run(['resolve'], {
    WOLF_CI_REPOSITORY: 'donraposo1-source/project-wolf',
    WOLF_CI_PR: '743',
    WOLF_CI_SHA: '8d319fc50be4e4d225e3bb80de963583899c25ec',
    WOLF_CI_APP_READER_TOKEN: '',
    WOLF_FACTORY_REPO_TOKEN: '',
  });
  assert.equal(result.code, 0);
  assert.ok(result.stdout.trim().length > 0, 'the command must print a decision');
  const decision = JSON.parse(result.stdout.trim().split('\n')[0]);
  assert.equal(decision.state, 'BLOCKED');
  assert.equal(decision.reason, 'NO_READER_CREDENTIAL');
  assert.equal(decision.acceptanceValid, false);
});

test('a blocked resolution is never reported as valid acceptance and omits the private target SHA', () => {
  const targetSha = '8d319fc50be4e4d225e3bb80de963583899c25ec';
  const result = run(['resolve'], {
    WOLF_CI_REPOSITORY: 'donraposo1-source/project-wolf',
    WOLF_CI_PR: '743',
    WOLF_CI_SHA: targetSha,
  });
  const decision = JSON.parse(result.stdout.trim().split('\n')[0]);
  assert.equal(decision.acceptanceValid, false);
  assert.equal(result.stdout.includes(targetSha), false);
});

test('a public target-resolution summary contains no private repo, PR number or SHA', () => {
  const targetSha = '8d319fc50be4e4d225e3bb80de963583899c25ec';
  const summary = buildPublicTargetAggregate({
    state: 'RESOLVED', relation: 'CURRENT', prHead: targetSha, pinnedSha: targetSha,
    treeIdentity: {identical: true},
  }, {acceptanceValid: true, reason: null});
  assert.equal(summary.acceptanceValid, true);
  assert.equal(summary.treeIdentical, true);
  const serialized = JSON.stringify(summary);
  for (const privateValue of ['donraposo1-source/project-wolf', '743', targetSha]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test('the output file is written when requested, so later steps read a file', () => {
  const dir = tmp();
  const out = path.join(dir, 'nested', 'target.json');
  run(['resolve', '--out', out], {
    WOLF_CI_REPOSITORY: 'donraposo1-source/project-wolf',
    WOLF_CI_PR: '743',
    WOLF_CI_SHA: '8d319fc50be4e4d225e3bb80de963583899c25ec',
  });
  assert.ok(fs.existsSync(out), 'the output file must exist even when blocked');
  const written = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(written.verdict.acceptanceValid, false);
  assert.equal(written.credentialsPrinted, false);
});

test('an unknown command is a usage error, not a silent success', () => {
  const result = run(['nonsense'], {});
  assert.equal(result.code, 2);
  assert.match(result.stdout, /RESOLVE_COMMAND_REQUIRED/);
});
