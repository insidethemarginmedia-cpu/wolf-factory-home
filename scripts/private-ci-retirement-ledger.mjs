// Durable fallback retirement.
//
// The per-run flag `WOLF_CI_RETIRE_PAT` cannot prove that the PAT is retired,
// because it is scoped to one workflow run. Any later run — a fresh dispatch, a
// retry, a different workflow, a manual invocation — starts with the flag unset
// and silently regains the fallback. That is the difference between *recording*
// a retirement and *enforcing* one.
//
// This module makes retirement persistent. When a run decides RETIRE_FALLBACK it
// appends a record to a ledger kept on a dedicated branch in this repository.
// Every later run reads that ledger *before* choosing a credential. A retirement,
// once written, applies to runs that never saw the decision that caused it.
//
// The gate is deliberately fail-safe in the direction that cannot cause an
// outage of the App path:
//
//   * No ledger, or an unreadable ledger  -> not retired. Ambiguity never
//     withdraws a working credential, and the App path does not depend on the PAT.
//   * Any RETIRE record                   -> retired, permanently.
//   * A later KEEP record does NOT un-retire. Reinstating a retired fallback
//     requires deleting the ledger deliberately, which is an auditable act rather
//     than an emergent side effect of one green run.
//
// Nothing here holds or prints a credential. A record names the decision, its
// reasons and the commit that produced it; the PAT is never in the ledger.

export const RETIREMENT_LEDGER_SCHEMA_VERSION = 1;

/** The dedicated branch that carries retirement records. Never the default branch. */
export const RETIREMENT_LEDGER_BRANCH = 'wolf-ci-retirement';

/** Default path of the ledger inside that branch. */
export const RETIREMENT_LEDGER_PATH = '.wolf-ci/retirement-ledger.jsonl';

export const LEDGER_STATES = Object.freeze({
  RETIRED: 'RETIRED',
  ACTIVE: 'ACTIVE',
  UNKNOWN: 'UNKNOWN',
});

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Parses a JSON-lines ledger. Malformed lines are skipped rather than fatal: a
 * corrupt line must not resurrect a fallback, but it must not destroy the
 * evidence of a valid RETIRE line either.
 */
export function parseLedger(text) {
  if (typeof text !== 'string') return {records: [], malformed: 0};
  const records = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (isRecord(parsed) && typeof parsed.state === 'string') records.push(parsed);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return {records, malformed};
}

/**
 * Reduces ledger records to a single verdict.
 *
 * `retired` is true if any record says RETIRED. `since` is the first such record,
 * so the evidence names when retirement began rather than when it was last seen.
 */
export function reduceLedger(records = []) {
  const retireRecords = records.filter(record => record?.state === LEDGER_STATES.RETIRED);
  if (retireRecords.length === 0) {
    return {
      state: LEDGER_STATES.ACTIVE,
      retired: false,
      since: null,
      evidenceCount: 0,
      credentialsPrinted: false,
    };
  }
  const sorted = [...retireRecords].sort((a, b) => String(a.recordedAt ?? '').localeCompare(String(b.recordedAt ?? '')));
  const first = sorted[0];
  return {
    state: LEDGER_STATES.RETIRED,
    retired: true,
    since: typeof first.recordedAt === 'string' ? first.recordedAt : null,
    // The commit that first asserted retirement, so the claim is attributable.
    sinceCommit: typeof first.commit === 'string' ? first.commit : null,
    evidenceCount: retireRecords.length,
    credentialsPrinted: false,
  };
}

/**
 * Reads a retirement verdict from ledger text without trusting the caller.
 * An absent or unreadable ledger yields UNKNOWN with `retired: false`; callers
 * must treat UNKNOWN as "not retired" so a missing file can never be mistaken
 * for a withdrawn credential, but must also never treat it as proof of anything.
 */
export function readLedgerVerdict(text) {
  if (typeof text !== 'string') {
    return {state: LEDGER_STATES.UNKNOWN, retired: false, since: null, evidenceCount: 0, readable: false, credentialsPrinted: false};
  }
  const {records, malformed} = parseLedger(text);
  return {...reduceLedger(records), readable: true, malformed, recordCount: records.length};
}

/**
 * Builds the record a run writes when it decides to retire the fallback.
 * No credential, no fragment of one, and no private content.
 */
export function retirementRecord(decision, {now = Date.now(), commit = null, runId = null, source = 'retirement-step'} = {}) {
  const retire = decision?.retire === true;
  return {
    schemaVersion: RETIREMENT_LEDGER_SCHEMA_VERSION,
    state: retire ? LEDGER_STATES.RETIRED : LEDGER_STATES.ACTIVE,
    retire,
    reasons: Array.isArray(decision?.reasons) ? decision.reasons : [],
    recordedAt: new Date(now).toISOString(),
    commit: typeof commit === 'string' && /^[0-9a-f]{40}$/.test(commit) ? commit : null,
    runId: runId === null || runId === undefined ? null : String(runId),
    source,
    credentialsPrinted: false,
  };
}

/**
 * The single question the credential selector asks.
 *
 * Combining the run's own decision with the durable ledger means a run is blocked
 * from the fallback if *either* says so. `env` supplies the per-run flag; `ledger`
 * supplies every earlier run. Neither alone is sufficient evidence of retirement,
 * and together they cannot be bypassed by starting a fresh run.
 */
export function isRetiredDurably({env = process.env, ledgerText = null, perRunFlag = null} = {}) {
  const flagValue = perRunFlag ?? env?.WOLF_CI_RETIRE_PAT;
  const perRun = String(flagValue ?? '').trim().toLowerCase();
  const perRunRetired = perRun === 'true' || perRun === '1' || perRun === 'retired';
  const ledger = readLedgerVerdict(ledgerText);
  if (perRunRetired || ledger.retired) {
    return {
      retired: true,
      source: perRunRetired ? (ledger.retired ? 'per-run-and-ledger' : 'per-run') : 'ledger',
      since: ledger.since ?? null,
      ledger,
    };
  }
  return {retired: false, source: 'none', since: null, ledger};
}
