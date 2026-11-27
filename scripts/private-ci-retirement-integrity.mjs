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
  const prefix = String(existingText ?? '');
  const separator = prefix && !prefix.endsWith('\n') ? '\n' : '';
  return {text: prefix + separator + JSON.stringify(sealed) + '\n', record: sealed};
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

  const attestation = records.length === 1 ? records[0] : null;
  if (attestation?.state === 'ATTESTED_EMPTY'
      && attestation.integrityVersion === LEDGER_INTEGRITY_VERSION
      && attestation.seq === 0 && attestation.prev === null && attestation.retire === false) {
    return {state: INTEGRITY_STATES.ATTESTED_EMPTY, intact: true, records, head: null, sequence: 0, reason: null};
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
export function hardenedRetirementVerdict(text, {
  expectedHead = null,
  expectedSequence = null,
  anchor = null,
  requireAnchor = false,
} = {}) {
  const integrity = verifyLedger(text, {expectedHead, expectedSequence});
  const anchorCheck = compareToAnchor(integrity, anchor);
  const retireRecords = integrity.records.filter(record => record?.state === 'RETIRED');
  const retired = retireRecords.length > 0;

  // A visible RETIRE is honoured even if the surrounding chain is damaged. In
  // every other case, only a verified clean ledger plus the configured trust
  // evidence can authorize fallback; malformed, rolled-back, or missing evidence
  // is not a reason to reactivate a credential.
  const sequenceExpected = expectedSequence !== null && expectedSequence !== undefined && expectedSequence !== ''
    && Number.isFinite(Number(expectedSequence));
  const evidenceWasExpected = Boolean(expectedHead) || sequenceExpected || Boolean(anchor);
  let safeToFallBack = false;
  let reason = null;

  if (retired) {
    reason = 'PAT_FALLBACK_RETIRED';
  } else if (integrity.state === INTEGRITY_STATES.TAMPERED) {
    reason = 'RETIREMENT_LEDGER_TAMPERED';
  } else if (integrity.state === INTEGRITY_STATES.ROLLED_BACK) {
    reason = 'RETIREMENT_LEDGER_ROLLED_BACK';
  } else if (integrity.state === INTEGRITY_STATES.UNREADABLE) {
    reason = evidenceWasExpected
      ? 'RETIREMENT_LEDGER_UNAVAILABLE'
      : requireAnchor ? 'RETIREMENT_ANCHOR_UNAVAILABLE' : null;
    safeToFallBack = !evidenceWasExpected && !requireAnchor;
  } else if (integrity.state === INTEGRITY_STATES.SUSPECT_EMPTY) {
    reason = evidenceWasExpected
      ? 'RETIREMENT_EVIDENCE_UNVERIFIABLE'
      : requireAnchor ? 'RETIREMENT_ANCHOR_UNAVAILABLE' : null;
    safeToFallBack = !evidenceWasExpected && !requireAnchor;
  } else if (integrity.state === INTEGRITY_STATES.ATTESTED_EMPTY) {
    // A local attestation cannot override the standing prohibition on reviving a
    // retired PAT. Reactivation requires a separately authorized process that is
    // intentionally not implemented by this runtime selector.
    reason = 'RETIRED_CREDENTIAL_REACTIVATION_DENIED';
  } else if (anchorCheck.consistent === false) {
    reason = anchorCheck.reason === 'LEDGER_SHORTER_THAN_ANCHOR'
      ? 'RETIREMENT_LEDGER_TRUNCATED'
      : 'RETIREMENT_ANCHOR_MISMATCH';
  } else if (requireAnchor && anchorCheck.checked !== true) {
    reason = 'RETIREMENT_ANCHOR_UNAVAILABLE';
  } else if (integrity.state !== INTEGRITY_STATES.INTACT) {
    reason = 'RETIREMENT_EVIDENCE_UNVERIFIABLE';
  } else {
    safeToFallBack = true;
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
    anchor: anchorCheck,
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

/**
 * Migrates a legacy ledger into the chain format, preserving every record.
 *
 * The ledger written before integrity existed has no `seq` and no `hash`, so
 * `verifyLedger` legitimately skips those records - which means a legacy ledger is
 * not tamper-evident at all. Migrating rather than rejecting keeps the evidence
 * (a RETIRE record must never be discarded) while making it verifiable from that
 * point forward.
 *
 * The migration is explicit about what it cannot do: it seals the records as they
 * are *now*, so it attests to their content at migration time, not to their history.
 * That limitation is recorded on each migrated record.
 */
export function migrateLegacyLedger(text) {
  const {records, malformed} = parseLedgerRecords(text);
  if (malformed > 0) {
    return {migrated: false, reason: 'LEGACY_MALFORMED', text, count: 0};
  }
  const already = records.length > 0 && records.every(record => record.integrityVersion === LEDGER_INTEGRITY_VERSION);
  if (already) return {migrated: false, reason: 'ALREADY_SEALED', text, count: records.length};

  let next = '';
  let count = 0;
  for (const record of records) {
    const {text: appended} = appendRecord(next, {
      state: record.state ?? null,
      retire: record.retire === true,
      recordedAt: record.recordedAt ?? null,
      commit: record.commit ?? null,
      runId: record.runId ?? null,
      source: record.source ?? null,
      // States plainly that the seal attests to content at migration time.
      migration: 'SEALED_FROM_LEGACY',
      credentialsPrinted: false,
    });
    next = appended;
    count += 1;
  }
  return {migrated: count > 0, reason: count > 0 ? null : 'NOTHING_TO_MIGRATE', text: next, count};
}

/**
 * The trusted head anchor.
 *
 * `verifyLedger` can only detect a rollback if it is told what to expect. Reading
 * that expectation from the ledger itself would be circular - a ledger cannot vouch
 * for its own completeness. The anchor has to come from somewhere the ledger's
 * owner does not control, so it is committed as a file on the branch that the
 * *workflow* pins, and it is updated only by the run that produced the record.
 *
 * The anchor is deliberately tiny: head hash, sequence, the commit that wrote it.
 * It says nothing about the content of the ledger, only how long it should be.
 */
export function buildHeadAnchor(verification, {commit = null, now = Date.now()} = {}) {
  return {
    schemaVersion: LEDGER_INTEGRITY_VERSION,
    head: verification?.head ?? null,
    sequence: verification?.sequence ?? null,
    recordCount: Array.isArray(verification?.records) ? verification.records.length : null,
    commit: typeof commit === 'string' && /^[0-9a-f]{40}$/.test(commit) ? commit : null,
    recordedAt: new Date(now).toISOString(),
    credentialsPrinted: false,
  };
}

/**
 * Compares a ledger against a stored anchor.
 *
 * Rollback and truncation are the same event seen from two directions, and both
 * present as "the ledger is shorter than the anchor says". A *longer* ledger is not
 * a rollback: another run appended between this run's read and its write.
 */
export function compareToAnchor(verification, anchor) {
  if (anchor === null || anchor === undefined) {
    return {checked: false, consistent: null, reason: 'NO_ANCHOR'};
  }
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) {
    return {checked: true, consistent: false, reason: 'ANCHOR_UNREADABLE'};
  }

  const expectedSequence = anchor.sequence;
  const expectedCount = anchor.recordCount;
  const validAnchor = anchor.schemaVersion === LEDGER_INTEGRITY_VERSION
    && Number.isSafeInteger(expectedSequence) && expectedSequence >= 0
    && Number.isSafeInteger(expectedCount) && expectedCount >= 1
    && expectedCount >= expectedSequence
    && (expectedSequence === 0
      ? anchor.head === null
      : typeof anchor.head === 'string' && /^[0-9a-f]{64}$/.test(anchor.head));
  if (!validAnchor) {
    return {checked: true, consistent: false, reason: 'ANCHOR_UNREADABLE'};
  }

  const records = Array.isArray(verification?.records) ? verification.records : [];
  const actualSequence = Number(verification?.sequence ?? 0);
  if (!Number.isSafeInteger(actualSequence) || actualSequence < 0) {
    return {checked: true, consistent: false, reason: 'LEDGER_UNREADABLE'};
  }
  if (actualSequence < expectedSequence || records.length < expectedCount) {
    return {
      checked: true,
      consistent: false,
      reason: 'LEDGER_SHORTER_THAN_ANCHOR',
      actualSequence,
      expectedSequence,
      actualRecordCount: records.length,
      expectedRecordCount: expectedCount,
      retirementMayHaveBeenDropped: true,
    };
  }

  if (expectedSequence > 0) {
    const anchorRecord = records.find((record, index) => Number(record?.seq ?? index + 1) === expectedSequence);
    if (!anchorRecord || anchorRecord.hash !== anchor.head) {
      return {
        checked: true,
        consistent: false,
        reason: 'ANCHOR_HEAD_MISMATCH',
        actualSequence,
        expectedSequence,
        expectedHead: anchor.head,
        actualHeadAtExpectedSequence: anchorRecord?.hash ?? null,
        retirementMayHaveBeenDropped: true,
      };
    }
  }

  const headMatches = actualSequence > expectedSequence
    || (verification?.head ?? null) === anchor.head;
  if (!headMatches) {
    return {
      checked: true,
      consistent: false,
      reason: 'ANCHOR_HEAD_MISMATCH',
      actualSequence,
      expectedSequence,
      expectedHead: anchor.head,
      actualHead: verification?.head ?? null,
      retirementMayHaveBeenDropped: true,
    };
  }

  return {
    checked: true,
    consistent: true,
    reason: actualSequence > expectedSequence ? 'LEDGER_AHEAD_OF_ANCHOR' : null,
    actualSequence,
    expectedSequence,
    actualRecordCount: records.length,
    expectedRecordCount: expectedCount,
    retirementMayHaveBeenDropped: false,
  };
}
