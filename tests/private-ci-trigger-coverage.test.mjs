// Every script and test the bridge depends on must be able to trigger the bridge.
//
// The `push` trigger uses an explicit path list. Any file omitted from that list
// can change without the pipeline running, so a commit that breaks the suite
// would merge with no run and no receipt. This is how the durable-retirement
// scripts were added without their tests ever executing on CI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';

const WORKFLOW = '.github/workflows/private-ci-bridge.yml';
const text = fs.readFileSync(WORKFLOW, 'utf8');

// The push block only. Everything before `permissions:` at column 0.
const pushBlock = text.slice(text.indexOf('  push:'), text.indexOf('\npermissions:'));
const listed = [...pushBlock.matchAll(/^\s+- '([^']+)'$/gm)].map(match => match[1]);

// Patterns, not literals: a glob entry covers every file it matches.
const covers = file => listed.some(entry => {
  if (!entry.includes('*')) return entry === file;
  const escaped = entry.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp('^' + escaped + '$').test(file);
});

test('the push trigger lists the bridge workflow itself', () => {
  assert.ok(covers(WORKFLOW), 'the workflow must run when it changes');
});

test('every bridge script and test is covered by the push trigger', () => {
  const missing = [];
  for (const dir of ['scripts', 'tests']) {
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(mjs|test\.mjs)$/.test(name)) continue;
      if (!/private-ci|workflow-env|workflow-pins|private-controller/.test(name)) continue;
      const file = path.join(dir, name);
      if (!covers(file)) missing.push(file);
    }
  }
  assert.deepEqual(missing, [], 'these files change without triggering the bridge: ' + missing.join(', '));
});

test('the durable retirement scripts specifically are covered', () => {
  for (const file of [
    'scripts/private-ci-retirement-ledger.mjs',
    'scripts/probes/durable-ledger-proof.mjs',
    'tests/private-ci-retirement-ledger.test.mjs',
    'tests/private-ci-retirement-ordering.test.mjs',
    'tests/private-ci-retirement-record-cli.test.mjs',
  ]) {
    assert.ok(fs.existsSync(file), file + ' must exist');
    assert.ok(covers(file), file + ' must be able to trigger the bridge');
  }
});
