// Executes the retirement ledger CLI commands as the workflow would.
//
// These tests exist because a unit test of the ledger module passed while the
// command itself crashed on an undefined helper. The step was `continue-on-error:
// true`, so the run stayed green and the ledger was never written - a silent
// failure behind a passing suite. Exercising the real entry point is the only
// way to catch that class of defect.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {appendRecord, buildHeadAnchor, verifyLedger} from '../scripts/private-ci-retirement-integrity.mjs';

const CLI = 'scripts/private-ci-app-auth-cli.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-retire-'));

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

test('retirement-record writes a RETIRE line for a retiring decision', () => {
  const dir = tmp();
  const decision = path.join(dir, 'decision.json');
  const ledger = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(decision, JSON.stringify({state: 'RETIRE_FALLBACK', retire: true, reasons: []}));

  const result = run(['retirement-record'], {
    WOLF_CI_RETIREMENT_FILE: decision,
    WOLF_CI_RETIREMENT_LEDGER_FILE: ledger,
    WOLF_CI_COMMIT: 'a'.repeat(40),
    GITHUB_RUN_ID: '45602368409',
  });

  // A crash here is the silent-failure path: the step is continue-on-error, so a
  // non-zero exit leaves the run green with no ledger and no obvious symptom.
  assert.equal(result.code, 0, 'the command must not crash: ' + (result.stderr ?? ''));
  assert.match(result.stdout, /"appended":true/);
  assert.ok(fs.existsSync(ledger), 'the ledger file must exist');

  const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.state, 'RETIRED');
  assert.equal(record.commit, 'a'.repeat(40));
  assert.equal(record.runId, '45602368409');
  assert.equal(record.integrityVersion, 1);
  assert.equal(record.seq, 1);
  assert.match(record.hash, /^[0-9a-f]{64}$/);
  assert.equal(record.credentialsPrinted, false);
  assert.equal(verifyLedger(fs.readFileSync(ledger, 'utf8')).state, 'INTACT');
});

test('retirement-record writes nothing when the decision keeps the fallback', () => {
  const dir = tmp();
  const decision = path.join(dir, 'decision.json');
  const ledger = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(decision, JSON.stringify({state: 'KEEP_FALLBACK', retire: false, reasons: ['X']}));

  const result = run(['retirement-record'], {
    WOLF_CI_RETIREMENT_FILE: decision,
    WOLF_CI_RETIREMENT_LEDGER_FILE: ledger,
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /"appended":false/);
  assert.equal(fs.existsSync(ledger), false, 'a KEEP decision must not touch the ledger');
});

test('retirement-record is idempotent-append, never truncating', () => {
  const dir = tmp();
  const decision = path.join(dir, 'decision.json');
  const ledger = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(decision, JSON.stringify({state: 'RETIRE_FALLBACK', retire: true, reasons: []}));
  const env = {WOLF_CI_RETIREMENT_FILE: decision, WOLF_CI_RETIREMENT_LEDGER_FILE: ledger};

  run(['retirement-record'], env);
  run(['retirement-record'], env);

  const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'a second run appends rather than replaces');
});

test('retirement-record seals a wholly legacy chain before appending', () => {
  const dir = tmp();
  const decision = path.join(dir, 'decision.json');
  const ledger = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(decision, JSON.stringify({state: 'RETIRE_FALLBACK', retire: true, reasons: ['APP_ACCEPTED']}));
  fs.writeFileSync(ledger, JSON.stringify({state: 'ACTIVE', retire: false, recordedAt: '2026-11-24T00:00:00.000Z'}) + '\n');

  const result = run(['retirement-record'], {WOLF_CI_RETIREMENT_FILE: decision, WOLF_CI_RETIREMENT_LEDGER_FILE: ledger});
  assert.equal(result.code, 0, result.stderr);
  const verification = verifyLedger(fs.readFileSync(ledger, 'utf8'));
  assert.equal(verification.state, 'INTACT');
  assert.equal(verification.records.length, 2);
  assert.ok(verification.records.every(record => record.integrityVersion === 1));
  assert.equal(verification.records[0].state, 'ACTIVE');
  assert.equal(verification.records[1].state, 'RETIRED');
});

test('retirement-record refuses to append across a mixed integrity history', () => {
  const dir = tmp();
  const decision = path.join(dir, 'decision.json');
  const ledger = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(decision, JSON.stringify({state: 'RETIRE_FALLBACK', retire: true, reasons: []}));
  const sealed = appendRecord('', {state: 'ACTIVE', retire: false, recordedAt: '2026-11-24T00:00:00.000Z'});
  const mixed = sealed.text + JSON.stringify({state: 'ACTIVE', retire: false, recordedAt: '2026-11-24T01:00:00.000Z'}) + '\n';
  fs.writeFileSync(ledger, mixed);
  const result = run(['retirement-record'], {WOLF_CI_RETIREMENT_FILE: decision, WOLF_CI_RETIREMENT_LEDGER_FILE: ledger});
  assert.equal(result.code, 78);
  assert.match(result.stdout, /LEDGER_MIXED_INTEGRITY/);
  assert.equal(fs.readFileSync(ledger, 'utf8'), mixed);
});

test('retirement-record refuses to append across a tampered ledger', () => {
  const dir = tmp();
  const decision = path.join(dir, 'decision.json');
  const ledger = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(decision, JSON.stringify({state: 'RETIRE_FALLBACK', retire: true, reasons: []}));
  const first = appendRecord('', {state: 'ACTIVE', retire: false, recordedAt: '2026-11-24T00:00:00.000Z'});
  fs.writeFileSync(ledger, first.text.replace('2026-11-24T00:00:00.000Z', '2026-11-24T02:00:00.000Z'));
  const before = fs.readFileSync(ledger, 'utf8');
  const result = run(['retirement-record'], {WOLF_CI_RETIREMENT_FILE: decision, WOLF_CI_RETIREMENT_LEDGER_FILE: ledger});
  assert.equal(result.code, 78);
  assert.match(result.stdout, /LEDGER_NOT_INTACT/);
  assert.equal(fs.readFileSync(ledger, 'utf8'), before, 'the writer must not overwrite evidence of tampering');
});

test('retirement-check reports RETIRED from the ledger alone, with no per-run flag', () => {
  const dir = tmp();
  const ledger = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(ledger, JSON.stringify({state: 'RETIRED', retire: true, recordedAt: '2026-11-24T00:00:00.000Z'}) + '\n');

  // Deliberately no WOLF_CI_RETIRE_PAT: this run never saw the decision.
  const result = run(['retirement-check'], {WOLF_CI_RETIREMENT_LEDGER_FILE: ledger});
  assert.equal(result.code, 0);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.state, 'RETIRED');
  assert.equal(verdict.retired, true);
  assert.equal(verdict.since, '2026-11-24T00:00:00.000Z');
});

test('retirement-check compares a clean history to its anchor through the real CLI', () => {
  const dir = tmp();
  const ledger = appendRecord('', {state: 'ACTIVE', retire: false, recordedAt: '2026-11-24T00:00:00.000Z'});
  const ledgerFile = path.join(dir, 'ledger.jsonl');
  const anchorFile = path.join(dir, 'head.json');
  fs.writeFileSync(ledgerFile, ledger.text);
  fs.writeFileSync(anchorFile, JSON.stringify(buildHeadAnchor(verifyLedger(ledger.text))));

  const result = run(['retirement-check', '--ledger', ledgerFile, '--anchor', anchorFile, '--require-anchor']);
  assert.equal(result.code, 0, result.stderr);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.state, 'ACTIVE');
  assert.equal(verdict.safeToFallBack, true);
  assert.equal(verdict.anchor.checked, true);
  assert.equal(verdict.anchor.consistent, true);
});

test('retirement-check blocks an internally valid truncated chain against its anchor', () => {
  const dir = tmp();
  const first = appendRecord('', {state: 'ACTIVE', retire: false, recordedAt: '2026-11-24T00:00:00.000Z'});
  const full = appendRecord(first.text, {state: 'RETIRED', retire: true, recordedAt: '2026-11-24T01:00:00.000Z'});
  const ledgerFile = path.join(dir, 'ledger.jsonl');
  const anchorFile = path.join(dir, 'head.json');
  fs.writeFileSync(ledgerFile, first.text);
  fs.writeFileSync(anchorFile, JSON.stringify(buildHeadAnchor(verifyLedger(full.text))));

  const result = run(['retirement-check', '--ledger', ledgerFile, '--anchor', anchorFile, '--require-anchor']);
  assert.equal(result.code, 78);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.state, 'BLOCKED');
  assert.equal(verdict.retired, false);
  assert.equal(verdict.safeToFallBack, false);
  assert.equal(verdict.reason, 'RETIREMENT_LEDGER_TRUNCATED');
});

test('retirement-check blocks missing anchors when the runtime requires one', () => {
  const dir = tmp();
  const ledger = appendRecord('', {state: 'ACTIVE', retire: false, recordedAt: '2026-11-24T00:00:00.000Z'});
  const ledgerFile = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(ledgerFile, ledger.text);
  const result = run(['retirement-check', '--ledger', ledgerFile, '--require-anchor']);
  assert.equal(result.code, 78);
  assert.equal(JSON.parse(result.stdout).reason, 'RETIREMENT_ANCHOR_UNAVAILABLE');
});

test('retirement-check reports UNKNOWN when no ledger exists, and does not throw', () => {
  const result = run(['retirement-check'], {WOLF_CI_RETIREMENT_LEDGER_FILE: '/nonexistent/ledger.jsonl'});
  assert.equal(result.code, 0);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.state, 'UNKNOWN');
  assert.equal(verdict.retired, false);
});
