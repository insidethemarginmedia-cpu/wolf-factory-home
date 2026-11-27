// Durable retirement: the difference between a decision and an enforcement.
//
// The per-run flag records what one run decided. The ledger is what makes the
// decision survive the end of that run. These tests exist because a per-run flag
// is trivially bypassed: start a fresh run and the flag is gone.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  LEDGER_STATES,
  parseLedger,
  reduceLedger,
  readLedgerVerdict,
  retirementRecord,
  isRetiredDurably,
} from '../scripts/private-ci-retirement-ledger.mjs';
import {selectCredential} from '../scripts/private-ci-app-auth.mjs';

const PAT_ENV = {WOLF_FACTORY_REPO_TOKEN: 'ghp_present_but_must_not_be_used'};

test('a fresh run with no flag regains the fallback when no ledger exists', () => {
  // This is the bypass. Documented as a test so the fix is measured against it.
  const selection = selectCredential('reader', {env: PAT_ENV});
  assert.equal(selection.source, 'pat-fallback');
});

test('a fresh run is denied the fallback by an earlier run\'s ledger record', () => {
  const ledger = JSON.stringify(retirementRecord({retire: true, reasons: []}, {now: Date.parse('2026-11-24T00:00:00Z'), commit: 'a'.repeat(40)}));
  // No WOLF_CI_RETIRE_PAT in env at all: this run never saw the decision.
  const selection = selectCredential('reader', {env: PAT_ENV, ledgerText: ledger});
  assert.equal(selection.source, 'none');
  assert.equal(selection.reason, 'PAT_FALLBACK_RETIRED');
  assert.equal(selection.retired, true);
  assert.equal(selection.retirementSource, 'ledger');
  assert.equal(selection.withheldCredential, 'pat');
});

test('the ledger closes the fallback for every role, not just the reader', () => {
  const ledger = JSON.stringify(retirementRecord({retire: true, reasons: []}));
  for (const role of ['reader', 'publisher', 'dispatcher']) {
    const env = {WOLF_FACTORY_REPO_TOKEN: 'ghp_x', WOLF_FACTORY_STATUS_TOKEN: 'ghp_y'};
    const selection = selectCredential(role, {env, ledgerText: ledger});
    assert.equal(selection.source, 'none', role + ' must not fall back');
    assert.equal(selection.reason, 'PAT_FALLBACK_RETIRED');
  }
});

test('the App path is unaffected by retirement', () => {
  const appEnv = {
    WOLF_FACTORY_APP_ID: '5913418',
    WOLF_FACTORY_APP_PRIVATE_KEY: 'k',
    WOLF_FACTORY_READER_INSTALLATION_ID: '176017917',
    WOLF_FACTORY_REPO_TOKEN: 'ghp_x',
  };
  const ledger = JSON.stringify(retirementRecord({retire: true, reasons: []}));
  const selection = selectCredential('reader', {env: appEnv, ledgerText: ledger});
  // Retiring the fallback must never take away the working credential.
  assert.equal(selection.source, 'github-app');
});

test('an absent ledger is not evidence of retirement', () => {
  const verdict = readLedgerVerdict(null);
  assert.equal(verdict.state, LEDGER_STATES.UNKNOWN);
  assert.equal(verdict.retired, false);
  assert.equal(verdict.readable, false);
});

test('an unreadable or corrupt ledger never resurrects the fallback', () => {
  // A malformed line is skipped, but a valid RETIRE line elsewhere still counts.
  const good = JSON.stringify(retirementRecord({retire: true, reasons: []}));
  const text = 'not json at all\n' + good + '\n{broken';
  const verdict = readLedgerVerdict(text);
  assert.equal(verdict.retired, true);
  assert.equal(verdict.malformed, 2);
});

test('a later KEEP record does not un-retire', () => {
  const text = [
    JSON.stringify(retirementRecord({retire: true, reasons: []}, {now: Date.parse('2026-11-24T00:00:00Z')})),
    JSON.stringify(retirementRecord({retire: false, reasons: []}, {now: Date.parse('2026-11-25T00:00:00Z')})),
  ].join('\n');
  const verdict = readLedgerVerdict(text);
  assert.equal(verdict.retired, true, 'reinstating a fallback must be a deliberate deletion, not a green run');
  assert.equal(verdict.evidenceCount, 1);
});

test('retirement evidence names when it began and which commit asserted it', () => {
  const early = retirementRecord({retire: true, reasons: []}, {now: Date.parse('2026-11-20T00:00:00Z'), commit: '1'.repeat(40)});
  const late = retirementRecord({retire: true, reasons: []}, {now: Date.parse('2026-11-24T00:00:00Z'), commit: '2'.repeat(40)});
  const verdict = readLedgerVerdict([late, early].map(r => JSON.stringify(r)).join('\n'));
  assert.equal(verdict.since, new Date(Date.parse('2026-11-20T00:00:00Z')).toISOString());
  assert.equal(verdict.sinceCommit, '1'.repeat(40));
  assert.equal(verdict.evidenceCount, 2);
});

test('a record never contains a credential', () => {
  const record = retirementRecord({retire: true, reasons: ['x']}, {commit: 'a'.repeat(40), runId: 123});
  const serialised = JSON.stringify(record);
  assert.ok(!/gh[opsu]_/.test(serialised));
  assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY/.test(serialised));
  assert.equal(record.credentialsPrinted, false);
});

test('retirement record rejects a non-40-hex commit rather than storing it', () => {
  const record = retirementRecord({retire: true}, {commit: 'deadbeef'});
  assert.equal(record.commit, null);
});

test('per-run flag and ledger are reported distinctly, and both together are named', () => {
  const ledger = JSON.stringify(retirementRecord({retire: true, reasons: []}));
  const both = isRetiredDurably({env: {WOLF_CI_RETIRE_PAT: 'true'}, ledgerText: ledger});
  assert.equal(both.retired, true);
  assert.equal(both.source, 'per-run-and-ledger');

  const perRun = isRetiredDurably({env: {WOLF_CI_RETIRE_PAT: 'true'}, ledgerText: null});
  assert.equal(perRun.source, 'per-run');

  const neither = isRetiredDurably({env: {}, ledgerText: null});
  assert.equal(neither.retired, false);
  assert.equal(neither.source, 'none');
});

test('an empty ledger reduces to ACTIVE, not an error', () => {
  assert.deepEqual(parseLedger(''), {records: [], malformed: 0});
  assert.equal(reduceLedger([]).state, LEDGER_STATES.ACTIVE);
  assert.equal(readLedgerVerdict('').retired, false);
});
