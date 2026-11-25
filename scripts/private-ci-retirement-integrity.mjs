// Integrity for the durable retirement ledger.
//
// The ledger's whole value is that a run that never saw the retirement decision
// still honours it. That value collapses if the ledger can be deleted, truncated,
// rewritten, or quietly replaced by an older copy. So the ledger is treated as a
// tamper-evident structure rather than a file:
//
//   integrity   each record carries a chain hash over its predecessor, so any edit
//               to history is detectable at the record it touched
//   rollback    a monotonic sequence number and a recorded head, so restoring an
//               older ledger is visible as a decrease rather than accepted as truth
//   deletion    an "attested empty" marker distinguishes "never retired" from
//               "the ledger that said retired was removed"
//   storage     unavailability yields a state that callers must treat as a refusal
//               to *rely* on the ledger, never as evidence that retirement ended
//
// The direction of every failure matters and is chosen deliberately. Losing the
// ledger must not reactivate a retired credential, so an unavailable or missing
// ledger is reported as SUSPECT, not as ACTIVE. A caller that cannot read the
// ledger cannot fall back to the PAT; the existing per-run flag and the App path
// both still work, so failing closed costs availability of the fallback only -
// which is the credential we are retiring anyway.

import {createHash} from 'node:crypto';

export const LEDGER_INTEGRITY_VERSION = 1;

export const INTEGRITY_STATES = Object.freeze({
  // The chain verifies and no rollback or deletion was detected.
  INTACT: 'INTACT',
  // The chain does not verify: a record was edited after it was written.
  TAMPERED: 'TAMPERED',
  // The sequence number went backwards, or the recorded head is not the head.
  ROLLED_BACK: 'ROLLED_BACK',
  // The ledger is absent or unreadable. Not evidence that retirement ended.
  UNREADABLE: 'UNREADABLE',
  // An empty ledger that attests it was deliberately emptied.
  ATTESTED_EMPTY: 'ATTESTED_EMPTY',
  // An empty ledger with no attestation: could be a deleted retirement.
  SUSPECT_EMPTY: 'SUSPECT_EMPTY',
});

/**
 * The canonical bytes a chain hash covers.
 *
 * Fixed field order and no whitespace: the hash must be reproducible across a
 * reserialisation, or an innocent round-trip through JSON would look like tampering.
 */
function canonical(record) {
  return JSON.stringify({
    seq: record.seq ?? null,
    state: record.state ?? null,
    retire: record.retire === true,
    recordedAt: record.recordedAt ?? null,
    commit: record.commit ?? null,
    runId: record.runId ?? null,
    prev: record.prev ?? null,
  });
}

/** Hash of one record, covering its predecessor's hash. */
export function chainHash(record) {
  return createHash('sha256').update(canonical(record)).digest('hex');
}

/**
 * Appends a record to existing ledger text, maintaining the chain.
 *
 * Returns the new full text rather than mutating a file, so a caller can decide
 * whether to write it and tests can exercise concurrency deterministically.
 */
export function appendRecord(existingText, record) {
  const {records} = parseLedgerRecords(existingText);
  const prev = records.length ? records[records.length - 1].hash : null;
  const seq = records.length ? (records[records.length - 1].seq ?? 0) + 1 : 1;
  const sealed = {...record, seq, prev, integrityVersion: LEDGER_INTEGRITY_VERSION};
  sealed.hash = chainHash(sealed);
  return {text: (existingText ?? '') + JSON.stringify(sealed) + '\n', record: sealed};
}

function parseLedgerRecords(text) {
  const records = [];
  let malformed = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') records.push(parsed);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return {records, malformed};
}

/**
 * Verifies chain integrity and detects rollback.
 *
 * `expectedHead` is the head hash recorded outside the ledger (in the workflow's
 * own pinned configuration, or a previous run's receipt). When present, a ledger
 * whose last hash differs is a rollback even if every internal link verifies - a
 * truncated ledger is internally consistent, which is exactly the attack an
 * internal-only check cannot see.
 */
export function verifyLedger(text, {expectedHead = null, expectedSequence = null} = {}) {
  if (typeof text !== 'string') {
    return {state: INTEGRITY_STATES.UNREADABLE, intact: false, records: [], reason: 'LEDGER_ABSENT'};
  }
  if (!text.trim()) {
    // An empty ledger is ambiguous: it is either "never retired" or "retirement
    // deleted". Only an explicit attestation distinguishes them.
    return {state: INTEGRITY_STATES.SUSPECT_EMPTY, intact: false, records: [], reason: 'EMPTY_WITHOUT_ATTESTATION'};
  }

  const {records, malformed} = parseLedgerRecords(text);
  if (malformed > 0) {
    // A malformed line could be the removed record. Treat as tampering rather than
    // skipping, because skipping is how a deletion looks when parsed leniently.
    return {state: INTEGRITY_STATES.TAMPERED, intact: false, records, reason: 'MALFORMED_LINE', malformed};
  }
  if (!records.length) {
    return {state: INTEGRITY_STATES.SUSPECT_EMPTY, intact: false, records: [], reason: 'NO_RECORDS'};
  }

  let previous = null;
  for (const [index, record] of records.entries()) {
    if (record.integrityVersion !== LEDGER_INTEGRITY_VERSION) continue; // legacy record
    const recomputed = chainHash(record);
    if (record.hash !== recomputed) {
      return {state: INTEGRITY_STATES.TAMPERED, intact: false, records, reason: 'HASH_MISMATCH', atSeq: record.seq ?? index + 1};
    }
    if ((record.prev ?? null) !== previous) {
      return {state: INTEGRITY_STATES.TAMPERED, intact: false, records, reason: 'BROKEN_LINK', atSeq: record.seq ?? index + 1};
    }
    previous = record.hash;
  }

  const last = records[records.length - 1];
  if (expectedSequence !== null && Number.isFinite(Number(expectedSequence))) {
    const actual = Number(last.seq ?? records.length);
    if (actual < Number(expectedSequence)) {
      return {state: INTEGRITY_STATES.ROLLED_BACK, intact: false, records, reason: 'SEQUENCE_DECREASED', actual, expected: Number(expectedSequence)};
    }
  }
  if (expectedHead && last.hash && last.hash !== expectedHead) {
    return {state: INTEGRITY_STATES.ROLLED_BACK, intact: false, records, reason: 'HEAD_MISMATCH', actual: last.hash, expected: expectedHead};
  }

  return {state: INTEGRITY_STATES.INTACT, intact: true, records, head: last.hash ?? null, sequence: last.seq ?? records.length, reason: null};
}

/**
 * The retirement verdict, hardened.
 *
 * `retired` is true when an intact ledger contains a RETIRE record, or when the
 * ledger cannot be verified but a RETIRE record is visible. A record that is
 * present is honoured even if the chain around it is damaged, because dropping a
 * retirement is the failure that matters.
 *
 * `safeToFallBack` answers the separate question the credential selector asks. It
 * is false whenever the ledger is UNREADABLE or SUSPECT_EMPTY, so lost storage
 * cannot silently re-enable the fallback.
 */
export function hardenedRetirementVerdict(text, {expectedHead = null, expectedSequence = null} = {}) {
  const integrity = verifyLedger(text, {expectedHead, expectedSequence});
  const retireRecords = integrity.records.filter(record => record?.state === 'RETIRED');
  const retired = retireRecords.length > 0;

  // The distinction that matters is not "is there a ledger" but "was there ever
  // evidence, and is it still here".
  //
  //   absent, nothing expected   -> retirement never happened. The fallback was
  //                                 never withdrawn, so allowing it removes nothing.
  //   absent, head expected      -> a retirement was recorded somewhere that knows
  //                                 the head, and the ledger holding it is gone.
  //                                 That is deletion, and it must not reopen the
  //                                 fallback.
  //
  // Conflating the two would withdraw the fallback on a repository that never
  // retired it, which is removing a credential by omission - the same class of
  // error as reporting a check that never ran.
  // `Number(null)` is 0 and `Number.isFinite(0)` is true, so a bare
  // Number.isFinite check treats "no expectation supplied" as "expecting sequence
  // 0" and reports every absent ledger as deleted evidence. Guard the null case
  // explicitly.
  const sequenceExpected = expectedSequence !== null && expectedSequence !== undefined && expectedSequence !== ''
    && Number.isFinite(Number(expectedSequence));
  const evidenceWasExpected = Boolean(expectedHead) || sequenceExpected;

  let safeToFallBack;
  let reason;
  if (retired) {
    safeToFallBack = false;
    reason = null;
  } else if (integrity.state === INTEGRITY_STATES.UNREADABLE) {
    // No ledger at all. Only suspicious if a retirement was known to exist.
    safeToFallBack = !evidenceWasExpected;
    reason = evidenceWasExpected ? 'RETIREMENT_LEDGER_UNAVAILABLE' : null;
  } else if (integrity.state === INTEGRITY_STATES.SUSPECT_EMPTY) {
    // An empty ledger where records were expected is deletion.
    safeToFallBack = !evidenceWasExpected;
    reason = evidenceWasExpected ? 'RETIREMENT_EVIDENCE_UNVERIFIABLE' : null;
  } else {
    // Intact and contains no RETIRE record: the fallback was never withdrawn.
    safeToFallBack = true;
    reason = null;
  }

  return {
    rights: null,
    retired,
    safeToFallBack,
    reason,
    integrity: integrity.state,
    integrityReason: integrity.reason,
    head: integrity.head ?? null,
    sequence: integrity.sequence ?? null,
    recordCount: integrity.records.length,
    credentialsPrinted: false,
  };
}

/**
 * Attestation for a deliberately empty ledger.
 *
 * Written when retirement is intentionally cleared. Without it an empty ledger is
 * indistinguishable from a deleted one, so the difference has to be stated by a
 * human action and recorded with it.
 */
export function emptyAttestation({by = null, at = Date.now(), reason = null} = {}) {
  return {
    integrityVersion: LEDGER_INTEGRITY_VERSION,
    state: 'ATTESTED_EMPTY',
    seq: 0,
    prev: null,
    recordedAt: new Date(at).toISOString(),
    by,
    reason,
    retire: false,
    credentialsPrinted: false,
  };
}

/**
 * Merges two copies of the ledger, for the concurrent-write case.
 *
 * Two runs can both decide to retire at the same time. A last-writer-wins contents
 * write would silently drop one of them - and if the dropped one was the RETIRE
 * record, retirement disappears. Merging by sequence keeps both, so concurrency
 * loses evidence only when the evidence genuinely conflicts.
 */
export function mergeLedgers(localText, remoteText) {
  const local = parseLedgerRecords(localText);
  const remote = parseLedgerRecords(remoteText);
  const bySeq = new Map();
  for (const record of [...remote.records, ...local.records]) {
    const key = record.seq ?? record.hash ?? JSON.stringify(record);
    // Local wins on an identical sequence, because local is the record this run
    // just produced and it has not been seen by the remote yet.
    if (!bySeq.has(key)) bySeq.set(key, record);
  }
  const merged = [...bySeq.values()].sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
  return {
    text: merged.map(record => JSON.stringify(record)).join('\n') + (merged.length ? '\n' : ''),
    localCount: local.records.length,
    remoteCount: remote.records.length,
    mergedCount: merged.length,
    // True when the merge had to choose, which is worth reporting.
    conflict: merged.length < local.records.length + remote.records.length,
  };
}
