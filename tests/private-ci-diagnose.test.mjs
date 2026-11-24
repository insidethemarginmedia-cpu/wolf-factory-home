import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {diagnosePrivateCi, extractCommands, extractEnvKeys, extractExitCodes} from '../scripts/private-ci-diagnose.mjs';

test('exit-code extraction reports only numbers', () => {
  assert.deepEqual(extractExitCodes("process.exit(77); process.exitCode = 78; process.exit('bad')"), [77, 78]);
  assert.deepEqual(extractExitCodes(''), []);
});

test('environment extraction reports names, never values', () => {
  const keys = extractEnvKeys("process.env.PGDATABASE; ${PGHOST}; DATABASE_URL=postgres://secret");
  assert.ok(keys.includes('PGDATABASE'));
  assert.ok(keys.includes('PGHOST'));
  assert.ok(keys.includes('DATABASE_URL'));
  assert.equal(keys.includes('secret'), false);
});

test('command extraction reports executables only', () => {
  assert.deepEqual(extractCommands('#!/usr/bin/env bash\npsql -f x.sql\nnode scripts/foo.mjs\nnpm test'), ['node', 'npm', 'psql']);
});

test('diagnostics never publish source lines', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-ci-diag-'));
  fs.mkdirSync(path.join(root, 'scripts'), {recursive: true});
  fs.writeFileSync(path.join(root, 'scripts', 'wolf-dbos-outer-e2e.mjs'), "const x='private-source-marker';process.exit(77);process.env.PGDATABASE;");
  const result = diagnosePrivateCi({root});
  assert.equal(result.state, 'DIAGNOSED');
  assert.deepEqual(result.dbos.exitCodes, [77]);
  assert.ok(result.dbos.envKeys.includes('PGDATABASE'));
  assert.equal(JSON.stringify(result).includes('private-source-marker'), false);
  fs.rmSync(root, {recursive: true, force: true});
});

test('the psql plan exposes structure, never file contents', async () => {
  const {extractPsqlPlan, extractStepNames} = await import('../scripts/private-ci-diagnose.mjs');
  const workflow = [
    '    steps:',
    '      - name: Start postgres',
    '      - name: Apply schema',
    '      - run: |',
    '          psql -v ON_ERROR_STOP=1 -f supabase/tests/verify-a.sql',
    '          psql -f "$UNEXPANDED.sql"',
    '          psql -f RLS.sql',
  ].join('\n');
  assert.deepEqual(extractStepNames(workflow), ['Start postgres', 'Apply schema']);
  const plan = extractPsqlPlan(workflow);
  assert.equal(plan.length, 2, 'a variable path must be skipped');
  assert.deepEqual(plan[0], {dir: 'supabase/tests', base: 'verify-a.sql', onErrorStop: true, flags: ['-v']});
  assert.equal(plan[1].dir, '.');
  assert.equal(JSON.stringify(plan).includes('ON_ERROR_STOP=1 -f supabase'), false, 'only structure is exposed');
});
