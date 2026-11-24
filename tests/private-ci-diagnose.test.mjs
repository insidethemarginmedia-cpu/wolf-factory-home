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
