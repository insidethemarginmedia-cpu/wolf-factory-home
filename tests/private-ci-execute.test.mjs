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

test('a failing extra check fails the verdict instead of being downgraded', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const {executePrivateCi} = await import('../scripts/private-ci-execute.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-ci-strict-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'x', scripts: {test: 'node -e "process.exit(0)"'}}));
  fs.mkdirSync(path.join(root, '.github', 'workflows'), {recursive: true});
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'postgres-concurrency-evidence.yml'), [
    'jobs:',
    '  measure-postgres-concurrency:',
    '    steps:',
    '      - name: Measure',
    '        run: node -e "process.exit(9)"',
  ].join('\n'));
  const receipt = executePrivateCi({
    root,
    sha: 'a'.repeat(40),
    checks: 'unit,postgres-concurrency',
    logDir: path.join(root, 'logs'),
    env: {},
    runnerTemp: root,
  });
  assert.equal(receipt.state, 'FAILED', 'a failing extra check must fail the run');
  assert.equal(receipt.failure, 'postgres-concurrency:1');
  assert.deepEqual(receipt.failedChecks, ['postgres-concurrency']);
  assert.equal(receipt.checks.find(check => check.name === 'postgres-concurrency').status, 'failure');
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

test('migrations are applied in lexical order before a workflow runs', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const {listMigrations, listVerificationFiles, schemaBootstrapSteps} = await import('../scripts/private-ci-execute.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-ci-schema-'));
  fs.mkdirSync(path.join(root, 'supabase', 'migrations'), {recursive: true});
  fs.mkdirSync(path.join(root, 'supabase', 'tests'), {recursive: true});
  for (const name of ['003-c.sql', '001-a.sql', '002-b.sql', 'notes.txt']) fs.writeFileSync(path.join(root, 'supabase', 'migrations', name), 'select 1;');
  fs.writeFileSync(path.join(root, 'supabase', 'tests', 'verify-all.sql'), 'select 1;');

  assert.deepEqual(listMigrations(root), ['supabase/migrations/001-a.sql', 'supabase/migrations/002-b.sql', 'supabase/migrations/003-c.sql']);
  assert.deepEqual(listVerificationFiles(root), ['supabase/tests/verify-all.sql']);

  const steps = schemaBootstrapSteps({root, database: 'wolf_test'});
  // Platform provisioning, ordered migrations, then the repository's own tests.
  assert.equal(steps.length, 3);
  assert.equal(steps[0].label, 'platform-provisioning');
  assert.match(steps[0].args[1], /create role authenticated/);
  assert.match(steps[0].args[1], /create schema if not exists auth/);
  assert.equal(steps[1].label, 'schema-bootstrap');
  assert.equal(steps[1].env.PGDATABASE, 'wolf_test');
  assert.deepEqual(steps[1].args.slice(3), ['supabase/migrations/001-a.sql', 'supabase/migrations/002-b.sql', 'supabase/migrations/003-c.sql']);
  assert.match(steps[1].args[1], /ON_ERROR_STOP=1/);
  assert.match(steps[1].args[1], /exit 1/, 'a failed migration must fail the bootstrap');
  assert.equal(steps[2].label, 'schema-verification-tests');
  fs.rmSync(root, {recursive: true, force: true});
});

test('workflow steps are taken from the workflow definition, not invented', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const {workflowSteps, classifyWorkflowStep, WORKFLOW_CHECKS} = await import('../scripts/private-ci-execute.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-ci-wfsteps-'));
  fs.mkdirSync(path.join(root, '.github', 'workflows'), {recursive: true});
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'postgres-concurrency-evidence.yml'), [
    'jobs:',
    '  measure-postgres-concurrency:',
    '    steps:',
    '      - name: Build synthetic canonical database evidence',
    '        run: |',
    '          psql -f scripts/verify-invoice-core.sql',
    '      - name: Measure',
    '        run: node scripts/measure-postgres-concurrency.mjs',
    '      - name: External',
    '        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  ].join('\n'));

  assert.deepEqual(Object.keys(WORKFLOW_CHECKS).sort(), ['http-load-evidence', 'ocr-paddle', 'ocr-tesseract', 'postgres-concurrency', 'postgres-schema', 'test']);

  const steps = workflowSteps({root, check: 'postgres-concurrency', database: 'wolf_test'});
  assert.equal(steps.length, 3);
  assert.match(steps[0].args[1], /psql -f scripts\/verify-invoice-core\.sql/);
  assert.equal(steps[0].env.PGDATABASE, 'wolf_test');
  assert.match(steps[1].args[1], /measure-postgres-concurrency\.mjs/);
  assert.equal(steps[2].skippedReason, 'STEP_USES_EXTERNAL_ACTION', 'an external action is recorded, never silently passed');

  assert.equal(classifyWorkflowStep({run: 'echo hi'}).runnable, true);
  assert.equal(classifyWorkflowStep({run: 'docker compose up'}).reason, 'STEP_NOT_REPRODUCIBLE');
  assert.equal(classifyWorkflowStep({uses: 'x/y@z'}).reason, 'STEP_USES_EXTERNAL_ACTION');
  assert.equal(classifyWorkflowStep({}).reason, 'STEP_HAS_NO_COMMAND');
  fs.rmSync(root, {recursive: true, force: true});
});

test('an absent workflow fails closed rather than reporting a pass', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const {workflowSteps} = await import('../scripts/private-ci-execute.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-ci-absent-'));
  assert.throws(() => workflowSteps({root, check: 'test', database: 'wolf_test'}), /EXECUTOR_WORKFLOW_ABSENT/);
  assert.throws(() => workflowSteps({root, check: 'not-a-check'}), /EXECUTOR_WORKFLOW_CHECK_UNKNOWN/);
  const {normalizeChecks} = await import('../scripts/private-ci-execute.mjs');
  assert.throws(() => normalizeChecks('postgres-schema', ['unit']), /EXECUTOR_CHECK_DENIED/);
  fs.rmSync(root, {recursive: true, force: true});
});

test('postgres failures publish a SQLSTATE and never the offending statement', async () => {
  const {errorDetail} = await import('../scripts/private-ci-execute.mjs');
  const output = [
    'MIGRATION_FAILED_PATH_CLASS=supabase/migrations/002.sql',
    'psql:supabase/migrations/002.sql:14: ERROR:  relation "wolf.private_table" does not exist',
    'LINE 3:     insert into wolf.private_table values (1);',
    'DETAIL:  secret-column-detail',
    'HINT:  create the table first',
  ].join('\n');
  const detail = errorDetail(output);
  assert.equal(detail.sqlstate, null, 'no bare SQLSTATE token means none is invented');
  assert.match(detail.errorLine, /relation/);
  assert.equal(detail.detail.DETAIL, 'secret-column-detail');
  assert.equal(detail.detail.HINT, 'create the table first');
  assert.equal(JSON.stringify(detail).includes('insert into'), false, 'the statement must not be published');

  // A real psql prefix carries the SQLSTATE and must be extracted.
  const structured = errorDetail('psql:file.sql:1: ERROR:  42P01: relation "x" does not exist');
  assert.equal(structured.sqlstate, '42P01');
});
