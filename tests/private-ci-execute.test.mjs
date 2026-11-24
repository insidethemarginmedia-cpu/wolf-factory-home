import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {REQUIRED_CHECKS, executePrivateCi, normalizeChecks, normalizeSha} from '../scripts/private-ci-execute.mjs';

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-ci-executor-'));
  fs.mkdirSync(path.join(root, 'scripts'), {recursive: true});
  fs.writeFileSync(path.join(root, 'scripts', 'run-actionlint.sh'), '#!/usr/bin/env bash\nset -euo pipefail\necho "fixture-private-secret-value"\n', {mode: 0o700});
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'fixture', scripts: {build: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"'}}));
  return root;
}

test('executor accepts only the six required plus two explicit extra checks', () => {
  assert.equal(normalizeSha('A'.repeat(40)), 'a'.repeat(40));
  assert.throws(() => normalizeSha('abc'), /EXECUTOR_SHA_MALFORMED/);
  assert.deepEqual(normalizeChecks('security,lint,typecheck,unit,integration,build'), [...REQUIRED_CHECKS]);
  assert.throws(() => normalizeChecks(''), /EXECUTOR_CHECKS_REQUIRED/);
  assert.throws(() => normalizeChecks('deploy'), /EXECUTOR_CHECK_DENIED/);
});

test('a passing lint check produces a verified SHA-bound receipt without private output', () => {
  const root = fixtureRoot();
  const logDir = path.join(root, 'logs');
  const receiptPath = path.join(root, 'receipt.json');
  const receipt = executePrivateCi({root, sha: 'a'.repeat(40), checks: 'lint', logDir, receiptPath});
  assert.equal(receipt.state, 'VERIFIED');
  assert.equal(receipt.sha, 'a'.repeat(40));
  assert.equal(receipt.checks.length, 1);
  assert.equal(receipt.checks[0].name, 'lint');
  assert.equal(receipt.checks[0].status, 'success');
  assert.match(receipt.receiptHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(receipt).includes('fixture-private-secret-value'), false);
  assert.equal(fs.readFileSync(receiptPath, 'utf8').includes('fixture-private-secret-value'), false);
  const log = fs.readFileSync(path.join(logDir, 'lint-1.log'), 'utf8');
  assert.equal(log.includes('fixture-private-secret-value'), true, 'private output stays in the ephemeral log');
  fs.rmSync(root, {recursive: true, force: true});
});

test('a failing check fails the receipt closed', () => {
  const root = fixtureRoot();
  fs.writeFileSync(path.join(root, 'scripts', 'run-actionlint.sh'), '#!/usr/bin/env bash\nexit 7\n', {mode: 0o700});
  const receipt = executePrivateCi({root, sha: 'b'.repeat(40), checks: 'lint', logDir: path.join(root, 'logs'), receiptPath: path.join(root, 'receipt.json')});
  assert.equal(receipt.state, 'FAILED');
  assert.equal(receipt.checks[0].steps[0].exitCode, 7);
  assert.equal(receipt.checks[0].status, 'failure');
  fs.rmSync(root, {recursive: true, force: true});
});

test('psql sequence extraction follows the private workflow and rejects escape paths', async () => {
  const {extractPsqlSequence} = await import('../scripts/private-ci-execute.mjs');
  const workflow = [
    'jobs:',
    '  measure:',
    '    steps:',
    '      - run: |',
    '          psql -f supabase/tests/a.sql',
    '          psql -v ON_ERROR_STOP=1 -f "./supabase/tests/b.sql"',
    '          psql -f ../outside.sql',
    '          psql -f /etc/absolute.sql',
    '          psql -f "$UNEXPANDED.sql"',
    '          echo psql -f notacommand.sql',
  ].join('\n');
  assert.deepEqual(extractPsqlSequence(workflow), ['supabase/tests/a.sql', 'supabase/tests/b.sql', 'notacommand.sql']);
  assert.deepEqual(extractPsqlSequence(''), []);
});

test('advisory checks never block the six required checks', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const {executePrivateCi} = await import('../scripts/private-ci-execute.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-ci-advisory-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'x', scripts: {test: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"'}}));
  fs.mkdirSync(path.join(root, 'scripts'), {recursive: true});
  fs.writeFileSync(path.join(root, 'scripts', 'measure-postgres-concurrency.mjs'), 'process.exit(9)');
  const receipt = executePrivateCi({
    root,
    sha: 'a'.repeat(40),
    checks: 'unit,postgres-concurrency',
    logDir: path.join(root, 'logs'),
    env: {},
    runnerTemp: root,
  });
  assert.equal(receipt.state, 'VERIFIED');
  assert.deepEqual(receipt.advisoryFailures, ['postgres-concurrency']);
  assert.equal(receipt.checks.find(check => check.name === 'postgres-concurrency').status, 'advisory-failure');
  fs.rmSync(root, {recursive: true, force: true});
});
