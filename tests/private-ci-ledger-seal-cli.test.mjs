// Executes the ledger seal command the way the workflow does.
//
// Sealing is the step that turns a legacy ledger into a tamper-evident one and
// publishes the anchor that makes truncation detectable. If it silently no-ops, the
// ledger stays unverifiable and nothing reports it.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {appendRecord, buildHeadAnchor, verifyLedger} from '../scripts/private-ci-retirement-integrity.mjs';

const CLI = 'scripts/private-ci-ledger-seal-cli.mjs';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-seal-'));

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

const legacyLine = (overrides = {}) => JSON.stringify({state: 'RETIRED', retire: true, recordedAt: '2026-11-25T00:00:00Z', ...overrides});

test('a legacy ledger is sealed and its retirement preserved', () => {
  const dir = tmp();
  const ledger = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(ledger, legacyLine() + '\n');
  const anchorFile = path.join(dir, 'head.json');

  const result = run(['seal', '--in', ledger, '--anchor-out', anchorFile]);
  assert.equal(result.code, 0, result.stderr ?? '');
  const decision = JSON.parse(result.stdout.trim());
  assert.equal(decision.state, 'SEALED');
  assert.equal(decision.migratedRecords, 1);
  assert.equal(decision.retired, true, 'the retirement must survive migration');
  assert.ok(fs.existsSync(anchorFile), 'the anchor must be written');
});

test('the published anchor records the head and sequence', () => {
  const dir = tmp();
  const ledger = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(ledger, legacyLine() + '\n');
  const anchorFile = path.join(dir, 'head.json');
  run(['seal', '--in', ledger, '--anchor-out', anchorFile]);

  const anchor = JSON.parse(fs.readFileSync(anchorFile, 'utf8'));
  assert.equal(anchor.sequence, 1);
  assert.match(anchor.head, /^[0-9a-f]{64}$/);
  assert.equal(anchor.credentialsPrinted, false);
});

test('sealing is idempotent on an already-sealed ledger', () => {
  const dir = tmp();
  const ledger = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(ledger, legacyLine() + '\n');
  const anchorFile = path.join(dir, 'head.json');

  const first = JSON.parse(run(['seal', '--in', ledger, '--anchor-out', anchorFile]).stdout.trim());
  const second = JSON.parse(run(['seal', '--in', ledger, '--anchor-out', anchorFile]).stdout.trim());
  assert.equal(second.migratedRecords, 0, 'already sealed, so nothing to migrate');
  assert.equal(second.head, first.head, 'the head must not change on a second seal of the same content');
});

test('a longer ledger remains anchor-consistent as a concurrent append', () => {
  const dir = tmp();
  const ledger = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(ledger, legacyLine() + '\n');
  const anchorFile = path.join(dir, 'head.json');
  run(['seal', '--in', ledger, '--anchor-out', anchorFile]);

  // Append two records, seal, then truncate back to one and seal again.
  const sealed = fs.readFileSync(ledger, 'utf8');
  let grown = sealed;
  for (const at of ['2026-11-25T01:00:00Z', '2026-11-25T02:00:00Z']) {
    grown = appendRecord(grown, {state: 'RETIRED', retire: true, recordedAt: at}).text;
  }
  fs.writeFileSync(ledger, grown);
  run(['seal', '--in', ledger, '--anchor-out', anchorFile, '--anchor-in', anchorFile]);

  const result = JSON.parse(run(['seal', '--in', ledger, '--anchor-out', path.join(dir, 'new.json'), '--anchor-in', anchorFile]).stdout.trim());
  // Same content, so no truncation yet.
  assert.equal(result.anchorConsistent, true);
});

test('sealing refuses a truncated ledger and preserves the prior anchor', () => {
  const dir = tmp();
  const ledger = path.join(dir, 'ledger.jsonl');
  const anchorFile = path.join(dir, 'head.json');
  const first = appendRecord('', {state: 'ACTIVE', retire: false, recordedAt: '2026-11-24T00:00:00.000Z'});
  const full = appendRecord(first.text, {state: 'RETIRED', retire: true, recordedAt: '2026-11-24T01:00:00.000Z'});
  const anchor = JSON.stringify(buildHeadAnchor(verifyLedger(full.text)));
  fs.writeFileSync(ledger, first.text);
  fs.writeFileSync(anchorFile, anchor);

  const result = run(['seal', '--in', ledger, '--anchor-out', anchorFile, '--anchor-in', anchorFile]);
  assert.notEqual(result.code, 0, 'a truncated local copy must not be sealed over known history');
  const verdict = JSON.parse(result.stdout.trim());
  assert.equal(verdict.state, 'BLOCKED');
  assert.equal(verdict.reason, 'PREVIOUS_ANCHOR_MISMATCH');
  assert.equal(fs.readFileSync(ledger, 'utf8'), first.text);
  assert.equal(fs.readFileSync(anchorFile, 'utf8'), anchor);
});

test('an invalid previous anchor blocks sealing without overwriting it', () => {
  const dir = tmp();
  const ledger = path.join(dir, 'ledger.jsonl');
  const anchorFile = path.join(dir, 'head.json');
  const record = appendRecord('', {state: 'ACTIVE', retire: false, recordedAt: '2026-11-24T00:00:00.000Z'});
  fs.writeFileSync(ledger, record.text);
  fs.writeFileSync(anchorFile, '{broken');
  const before = fs.readFileSync(anchorFile, 'utf8');

  const result = run(['seal', '--in', ledger, '--anchor-out', anchorFile, '--anchor-in', anchorFile]);
  assert.notEqual(result.code, 0);
  assert.equal(JSON.parse(result.stdout.trim()).reason, 'PREVIOUS_ANCHOR_UNREADABLE');
  assert.equal(fs.readFileSync(anchorFile, 'utf8'), before);
});

test('an absent ledger is not sealed, because sealing it would manufacture evidence', () => {
  // Sealing an empty ledger would create a verifiable artefact attesting to nothing,
  // and an anchor over it would make a later real ledger look like an append. Refusing
  // keeps "no evidence" distinguishable from "evidence of no retirement".
  const dir = tmp();
  const result = run(['seal', '--in', path.join(dir, 'missing.jsonl'), '--anchor-out', path.join(dir, 'head.json')]);
  const decision = JSON.parse(result.stdout.trim());
  assert.equal(decision.state, 'FAILED');
  assert.equal(decision.reason, 'LEDGER_NOT_INTACT');
  assert.equal(decision.integrity, 'SUSPECT_EMPTY');
  assert.equal(fs.existsSync(path.join(dir, 'head.json')), false, 'no anchor over an empty ledger');
});

test('an unknown command is a usage error', () => {
  const result = run(['nonsense'], {});
  assert.equal(result.code, 2);
  assert.match(result.stdout, /SEAL_COMMAND_REQUIRED/);
});
