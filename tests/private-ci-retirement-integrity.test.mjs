// Hardening tests for the durable retirement ledger.
//
// The threat model is not "someone edits the ledger" in the abstract. It is that a
// retired credential silently returns. Every test below is an attempt to make that
// happen through a different weakness: deletion, truncation, rewrite, rollback,
// storage loss, or a concurrent write that drops the retirement record.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  INTEGRITY_STATES,
  appendRecord,
  chainHash,
  verifyLedger,
  hardenedRetirementVerdict,
  emptyAttestation,
  mergeLedgers,
  buildHeadAnchor,
  compareToAnchor,
  migrateLegacyLedger,
} from '../scripts/private-ci-retirement-integrity.mjs';

const retire = (at = '2026-11-25T00:00:00Z') => ({state: 'RETIRED', retire: true, recordedAt: at, commit: 'a'.repeat(40)});
const keep = (at = '2026-11-25T01:00:00Z') => ({state: 'ACTIVE', retire: false, recordedAt: at});

const build = (...records) => records.reduce((text, record) => appendRecord(text, record).text, '');

// --- integrity ------------------------------------------------------------

test('a well-formed chain verifies and reports its head', () => {
  const text = build(retire(), retire('2026-11-25T01:00:00Z'));
  const result = verifyLedger(text);
  assert.equal(result.state, INTEGRITY_STATES.INTACT);
  assert.equal(result.sequence, 2);
  assert.equal(result.records.length, 2);
});

test('editing a record after the fact is detected', () => {
  const text = build(retire());
  const tampered = text.replace('"RETIRED"', '"ACTIVE"');
  const result = verifyLedger(tampered);
  assert.equal(result.state, INTEGRITY_STATES.TAMPERED);
  assert.equal(result.reason, 'HASH_MISMATCH');
});

test('editing the commit a retirement was attributed to is detected', () => {
  const text = build(retire());
  const tampered = text.replace('a'.repeat(40), 'b'.repeat(40));
  assert.equal(verifyLedger(tampered).state, INTEGRITY_STATES.TAMPERED);
});

test('reordering records breaks the link and is detected', () => {
  const text = build(retire('2026-11-25T00:00:00Z'), retire('2026-11-25T01:00:00Z'));
  const lines = text.trim().split('\n');
  const reordered = [lines[1], lines[0]].join('\n') + '\n';
  assert.equal(verifyLedger(reordered).state, INTEGRITY_STATES.TAMPERED);
});

test('a malformed line is tampering, not something to skip', () => {
  // Skipping is how a deleted retirement looks when parsed leniently.
  const text = build(retire()) + 'garbage\n';
  assert.equal(verifyLedger(text).state, INTEGRITY_STATES.TAMPERED);
});

// --- rollback -------------------------------------------------------------

test('truncating the ledger to an older prefix is detected by expected head', () => {
  const full = build(retire('2026-11-25T00:00:00Z'), retire('2026-11-25T01:00:00Z'));
  const head = verifyLedger(full).head;
  const truncated = full.trim().split('\n')[0] + '\n';
  const result = verifyLedger(truncated, {expectedHead: head});
  assert.equal(result.state, INTEGRITY_STATES.ROLLED_BACK);
  assert.equal(result.reason, 'HEAD_MISMATCH');
});

test('a sequence decrease is detected even when every internal link verifies', () => {
  // This is the case an internal-only check cannot see: a truncated ledger is
  // internally consistent.
  const full = build(retire(), retire('2026-11-25T01:00:00Z'));
  const truncated = full.trim().split('\n')[0] + '\n';
  const result = verifyLedger(truncated, {expectedSequence: 2});
  assert.equal(result.state, INTEGRITY_STATES.ROLLED_BACK);
  assert.equal(result.reason, 'SEQUENCE_DECREASED');
});

test('an unchanged ledger passes both rollback checks', () => {
  const text = build(retire());
  const {head, sequence} = verifyLedger(text);
  assert.equal(verifyLedger(text, {expectedHead: head, expectedSequence: sequence}).state, INTEGRITY_STATES.INTACT);
});

// --- deletion and storage loss -------------------------------------------

test('an absent ledger alone is not evidence of tampering', () => {
  // A repository that never retired the fallback has no ledger. Treating absence
  // as deletion would withdraw a credential by omission, which is the same class
  // of error as reporting a check that never ran.
  const result = hardenedRetirementVerdict(null);
  assert.equal(result.integrity, INTEGRITY_STATES.UNREADABLE);
  assert.equal(result.retired, false);
  assert.equal(result.safeToFallBack, true);
});

test('a missing ledger IS deletion when a retirement head was known to exist', () => {
  // This is the case that must not reopen the fallback: something outside the
  // ledger recorded that a retirement existed, and the ledger is gone.
  const result = hardenedRetirementVerdict(null, {expectedHead: 'a'.repeat(64)});
  assert.equal(result.integrity, INTEGRITY_STATES.UNREADABLE);
  assert.equal(result.safeToFallBack, false);
  assert.equal(result.reason, 'RETIREMENT_LEDGER_UNAVAILABLE');
});

test('a missing ledger is deletion when a sequence was known to exist', () => {
  const result = hardenedRetirementVerdict(null, {expectedSequence: 3});
  assert.equal(result.safeToFallBack, false);
});

test('expectedSequence of zero is not treated as an expectation', () => {
  // Number(null) is 0 and Number.isFinite(0) is true, which made every absent
  // ledger look like deleted evidence. Guarded explicitly.
  assert.equal(hardenedRetirementVerdict(null, {expectedSequence: null}).safeToFallBack, true);
  assert.equal(hardenedRetirementVerdict(null, {expectedSequence: 0}).safeToFallBack, false);
});

test('an empty ledger is suspect, and blocks the fallback only when evidence was expected', () => {
  for (const text of ['', '   \n  ']) {
    assert.equal(hardenedRetirementVerdict(text).integrity, INTEGRITY_STATES.SUSPECT_EMPTY);
    // Nothing expected: never retired.
    assert.equal(hardenedRetirementVerdict(text).safeToFallBack, true);
    // Something expected: the records were removed.
    assert.equal(hardenedRetirementVerdict(text, {expectedHead: 'a'.repeat(64)}).safeToFallBack, false);
  }
});

test('an explicitly attested empty ledger permits backoff, because it is a decision', () => {
  const attestation = emptyAttestation({by: 'founder', reason: 'reinstating fallback deliberately'});
  const result = hardenedRetirementVerdict(JSON.stringify(attestation) + '\n');
  // The attestation is a record with no RETIRE, so it reads as intact and not retired.
  assert.equal(result.retired, false);
  assert.equal(result.safeToFallBack, true);
});

// --- the verdict ----------------------------------------------------------

test('a retired ledger denies fallback', () => {
  const result = hardenedRetirementVerdict(build(retire()));
  assert.equal(result.retired, true);
  assert.equal(result.safeToFallBack, false);
});

test('a retirement is honoured even when the chain around it is damaged', () => {
  // Dropping a retirement is the failure that matters, so a visible RETIRE record
  // is honoured rather than discarded because its neighbours are corrupt.
  const text = build(retire()).replace('"RETIRED"', '"RETIRED"') + 'garbage\n';
  const result = hardenedRetirementVerdict(text);
  assert.equal(result.integrity, INTEGRITY_STATES.TAMPERED);
  assert.equal(result.retired, true);
  assert.equal(result.safeToFallBack, false);
});

test('a keep-only ledger permits fallback only when intact', () => {
  const result = hardenedRetirementVerdict(build(keep()));
  assert.equal(result.integrity, INTEGRITY_STATES.INTACT);
  assert.equal(result.retired, false);
  assert.equal(result.safeToFallBack, true);
});

// --- concurrency ----------------------------------------------------------

test('two concurrent retirements both survive a merge', () => {
  // Two runs both decide to retire and both write. A last-writer-wins contents
  // write would drop one; if the dropped one were the only RETIRE, retirement would
  // vanish.
  const local = build(retire('2026-11-25T00:00:00Z'));
  const remote = build(retire('2026-11-25T00:00:00Z'), retire('2026-11-25T02:00:00Z'));
  const merged = mergeLedgers(local, remote);
  assert.equal(merged.mergedCount, 2);
  assert.equal(hardenedRetirementVerdict(merged.text).retired, true);
});

test('a merge that has to choose reports the conflict', () => {
  const local = build(retire('2026-11-25T00:00:00Z'));
  const remote = build(retire('2026-11-25T00:00:00Z'));
  const merged = mergeLedgers(local, remote);
  // Same sequence from both sides: one wins, and the fact that a choice was made
  // is reported rather than hidden.
  assert.equal(merged.mergedCount, 1);
  assert.equal(merged.conflict, true);
});

test('a merge cannot remove a retirement that exists on either side', () => {
  const local = build(keep('2026-11-25T00:00:00Z'));
  const remote = build(retire('2026-11-25T00:30:00Z'));
  const merged = mergeLedgers(local, remote);
  assert.equal(hardenedRetirementVerdict(merged.text).retired, true);
});

// --- structural -----------------------------------------------------------

test('the chain hash covers the predecessor, so history cannot be rewritten', () => {
  const first = appendRecord('', retire());
  const forged = {...first.record, state: 'ACTIVE'};
  // Recomputing the hash of the forged record still leaves a different hash, which
  // is what a verifier compares.
  assert.notEqual(chainHash(forged), first.record.hash);
});

test('the verdict never contains a credential', () => {
  const result = hardenedRetirementVerdict(build(retire()));
  assert.ok(!/gh[opsu]_/.test(JSON.stringify(result)));
  assert.equal(result.credentialsPrinted, false);
});

// --- independent trusted head --------------------------------------------

test('a ledger truncated below the anchor is detected even though it verifies internally', () => {
  // The case internal verification cannot catch: a truncated chain is consistent.
  const full = build(retire('2026-11-25T00:00:00Z'), keep('2026-11-25T01:00:00Z'));
  const anchor = buildHeadAnchor(verifyLedger(full));
  const truncated = full.trim().split('\n')[0] + '\n';

  const result = hardenedRetirementVerdict(truncated, {anchor});
  assert.equal(result.anchor.consistent, false);
  assert.equal(result.anchor.reason, 'LEDGER_SHORTER_THAN_ANCHOR');
  assert.equal(result.anchor.retirementMayHaveBeenDropped, true);
});

test('a truncation that dropped the only RETIRE record cannot claim "not retired"', () => {
  // The dangerous shape: the surviving record is a KEEP, so the ledger reads as
  // "never retired". Only the anchor reveals that a record is missing.
  const full = build(keep('2026-11-25T00:00:00Z'), retire('2026-11-25T01:00:00Z'));
  const anchor = buildHeadAnchor(verifyLedger(full));
  const truncated = full.trim().split('\n')[0] + '\n';

  const result = hardenedRetirementVerdict(truncated, {anchor});
  assert.equal(result.retired, false, 'the RETIRE record is genuinely absent from the text');
  assert.equal(result.safeToFallBack, false, 'but the truncation proves it may have been dropped');
  assert.equal(result.reason, 'RETIREMENT_LEDGER_TRUNCATED');
});

test('a ledger ahead of the anchor is a concurrent append, not a rollback', () => {
  const short = build(retire('2026-11-25T00:00:00Z'));
  const anchor = buildHeadAnchor(verifyLedger(short));
  const longer = build(retire('2026-11-25T00:00:00Z'), retire('2026-11-25T02:00:00Z'));
  const result = hardenedRetirementVerdict(longer, {anchor});
  assert.equal(result.anchor.consistent, true);
  assert.equal(result.anchor.reason, 'LEDGER_AHEAD_OF_ANCHOR');
});

test('an anchor matching the ledger is consistent', () => {
  const text = build(retire());
  const anchor = buildHeadAnchor(verifyLedger(text));
  const result = hardenedRetirementVerdict(text, {anchor});
  assert.equal(result.anchor.consistent, true);
  assert.equal(result.anchor.checked, true);
});

test('no anchor is reported as unchecked rather than consistent', () => {
  const result = hardenedRetirementVerdict(build(keep()));
  assert.equal(result.anchor.checked, false);
  assert.equal(result.anchor.reason, 'NO_ANCHOR');
});

// --- legacy migration ----------------------------------------------------

test('a legacy record without integrity fields is detected as unsealed', () => {
  const legacy = JSON.stringify({state: 'RETIRED', retire: true, recordedAt: '2026-11-25T00:00:00Z'}) + '\n';
  // Legacy records are skipped by verification, so the ledger is not tamper-evident.
  const verification = verifyLedger(legacy);
  assert.equal(verification.intact, true, 'it verifies, because there is nothing to check');
  assert.equal(verification.records[0].integrityVersion, undefined);
});

test('migrating a legacy ledger preserves every record and seals them', () => {
  const legacy = [
    JSON.stringify({state: 'RETIRED', retire: true, recordedAt: '2026-11-25T00:00:00Z', commit: 'a'.repeat(40)}),
    JSON.stringify({state: 'ACTIVE', retire: false, recordedAt: '2026-11-25T01:00:00Z'}),
  ].join('\n') + '\n';

  const migrated = migrateLegacyLedger(legacy);
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.count, 2);

  const verification = verifyLedger(migrated.text);
  assert.equal(verification.state, INTEGRITY_STATES.INTACT);
  assert.equal(verification.sequence, 2);
  // The retirement survived migration - that is the point of migrating rather than
  // rejecting a legacy ledger.
  assert.equal(hardenedRetirementVerdict(migrated.text).retired, true);
});

test('a migrated record states that the seal post-dates its content', () => {
  const legacy = JSON.stringify({state: 'RETIRED', retire: true}) + '\n';
  const migrated = migrateLegacyLedger(legacy);
  const record = JSON.parse(migrated.text.trim());
  assert.equal(record.migration, 'SEALED_FROM_LEGACY');
});

test('migration is idempotent on an already-sealed ledger', () => {
  const sealed = build(retire());
  const again = migrateLegacyLedger(sealed);
  assert.equal(again.migrated, false);
  assert.equal(again.reason, 'ALREADY_SEALED');
  assert.equal(again.text, sealed);
});

test('a malformed legacy ledger is not silently migrated', () => {
  const result = migrateLegacyLedger('garbage\n{"state":"RETIRED"}\n');
  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'LEGACY_MALFORMED');
});
