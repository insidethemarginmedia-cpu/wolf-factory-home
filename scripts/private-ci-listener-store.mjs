// Durable replay protection for Home mission admission.
//
// An in-memory `seenKeys` list is not replay protection across workflow runs. This
// store uses a dedicated branch, append-only JSONL, a SHA-256 chain, an external
// head anchor, and GitHub Contents API blob-SHA preconditions. The API writes are
// not a transaction: the ledger is committed before the anchor, and any partial or
// conflicting pair blocks execution. The anchor is same-writer evidence, not an
// independent verifier.
import {createHash} from 'node:crypto';

import {admitMission, admissionRecord} from './private-ci-listener.mjs';
import {missionKey, missionBindingDigest} from './private-ci-mission.mjs';

export const LISTENER_STORE_REPOSITORY = 'insidethemarginmedia-cpu/wolf-factory-home';
export const LISTENER_STORE_BRANCH = 'wolf-mission-admissions';
export const LISTENER_STORE_LEDGER_PATH = '.wolf-ci/mission-admissions.jsonl';
export const LISTENER_STORE_ANCHOR_PATH = '.wolf-ci/mission-admissions-head.json';
export const LISTENER_STORE_EXIT = Object.freeze({OK: 0, BLOCKED: 78});

const API = 'https://api.github.com';
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BASE_HEADERS = Object.freeze({
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
});

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
}

function hashEntry({seq, prev, admission}) {
  return createHash('sha256').update(stableJson({seq, prev, admission})).digest('hex');
}

function makeSummary(state, fields = {}) {
  return {
    state,
    credentialsPrinted: false,
    trustModel: 'SAME_WRITER_ANCHORED_LEDGER',
    independentVerifierRequired: true,
    ...fields,
  };
}

async function responseJson(response) {
  try { return await response.json(); } catch { return null; }
}

async function request(url, {token, method = 'GET', body, fetchImpl}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        ...BASE_HEADERS,
        authorization: 'Bearer ' + token,
        ...(body === undefined ? {} : {'content-type': 'application/json'}),
      },
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return {ok: false, status: 0, body: null};
  }
  return {ok: response.ok === true, status: Number.isInteger(response.status) ? response.status : 0, body: await responseJson(response)};
}

const validBase64 = value => /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);

function parseContents(body) {
  if (!body || body.encoding !== 'base64' || typeof body.content !== 'string' || !SHA1.test(String(body.sha ?? ''))) return {ok: false};
  const encoded = body.content.replace(/\s+/g, '');
  if (encoded && !validBase64(encoded)) return {ok: false};
  const text = Buffer.from(encoded, 'base64').toString('utf8');
  if (Buffer.byteLength(text, 'utf8') > 1_000_000) return {ok: false};
  return {ok: true, text, sha: body.sha};
}

async function getContents({repository, file, token, fetchImpl}) {
  const url = `${API}/repos/${repository}/contents/${file}?ref=${encodeURIComponent(LISTENER_STORE_BRANCH)}`;
  const result = await request(url, {token, fetchImpl});
  if (result.status === 404) return {found: false, status: 404};
  if (!result.ok) return {found: null, status: result.status};
  const parsed = parseContents(result.body);
  return parsed.ok ? {found: true, status: result.status, text: parsed.text, sha: parsed.sha} : {found: null, status: result.status};
}

/** Verify every admission record and its predecessor link. */
export function verifyAdmissionLedger(text) {
  if (typeof text !== 'string') return {state: 'UNREADABLE', records: [], reason: 'LEDGER_ABSENT'};
  if (!text.trim()) return {state: 'SUSPECT_EMPTY', records: [], reason: 'EMPTY_LEDGER'};
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch {
      return {state: 'TAMPERED', records, reason: 'MALFORMED_LINE'};
    }
    const admission = entry?.admission;
    const validMissionBinding = SHA256.test(String(admission?.missionBindingDigest ?? ''));
    const hasPublishedPrivateIdentity = ['missionKey', 'missionId', 'targetRepository', 'targetSha']
      .some(key => Object.hasOwn(admission ?? {}, key));
    const validRecordedAt = typeof admission?.recordedAt === 'string'
      && Number.isFinite(Date.parse(admission.recordedAt));
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || !Number.isSafeInteger(entry.seq) || entry.seq !== records.length + 1
        || (entry.prev !== null && !SHA256.test(String(entry.prev)))
        || !admission || typeof admission !== 'object' || Array.isArray(admission)
        || admission.schemaVersion !== 2 || admission.ledger !== 'listener-admissions'
        || admission.state !== 'ADMITTED' || admission.admitted !== true
        || admission.credentialsRequired !== false
        || !validMissionBinding || hasPublishedPrivateIdentity
        || !SHA1.test(String(admission.executorSha ?? ''))
        || typeof admission.sender !== 'string' || !admission.sender.trim()
        || typeof admission.deliveryId !== 'string' || !/^[A-Za-z0-9-]{8,128}$/.test(admission.deliveryId)
        || typeof admission.runId !== 'string' || !/^\d{1,20}$/.test(admission.runId)
        || !validRecordedAt
        || !SHA256.test(String(entry.hash ?? ''))) {
      return {state: 'TAMPERED', records, reason: 'RECORD_SHAPE_INVALID'};
    }
    const expectedPrev = records.length ? records[records.length - 1].hash : null;
    if (entry.prev !== expectedPrev || entry.hash !== hashEntry(entry)) {
      return {state: 'TAMPERED', records, reason: entry.prev !== expectedPrev ? 'BROKEN_LINK' : 'HASH_MISMATCH', atSeq: entry.seq};
    }
    records.push(entry);
  }
  if (!records.length) return {state: 'SUSPECT_EMPTY', records, reason: 'NO_RECORDS'};
  return {state: 'INTACT', records, head: records.at(-1).hash, sequence: records.length, reason: null};
}

export function buildAdmissionAnchor(verification, {now = Date.now()} = {}) {
  return {
    schemaVersion: 1,
    head: verification?.head ?? null,
    sequence: verification?.sequence ?? null,
    recordCount: Array.isArray(verification?.records) ? verification.records.length : null,
    recordedAt: new Date(now).toISOString(),
    credentialsPrinted: false,
  };
}

/** An older anchor is consistent with a longer valid ledger; a shorter one is not. */
export function compareAdmissionAnchor(verification, anchor) {
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) {
    return {checked: true, consistent: false, reason: 'ANCHOR_UNREADABLE'};
  }
  const {sequence, recordCount, head} = anchor;
  if (anchor.schemaVersion !== 1 || !Number.isSafeInteger(sequence) || sequence < 1
      || !Number.isSafeInteger(recordCount) || recordCount !== sequence || !SHA256.test(String(head ?? ''))) {
    return {checked: true, consistent: false, reason: 'ANCHOR_UNREADABLE'};
  }
  const records = Array.isArray(verification?.records) ? verification.records : [];
  if (verification?.state !== 'INTACT' || sequence > verification.sequence || recordCount > records.length) {
    return {checked: true, consistent: false, reason: 'LEDGER_SHORTER_THAN_ANCHOR', expectedSequence: sequence, actualSequence: verification?.sequence ?? null};
  }
  if (records[sequence - 1]?.hash !== head) {
    return {checked: true, consistent: false, reason: 'ANCHOR_HEAD_MISMATCH', expectedSequence: sequence};
  }
  return {
    checked: true,
    consistent: true,
    reason: verification.sequence > sequence ? 'LEDGER_AHEAD_OF_ANCHOR' : null,
    expectedSequence: sequence,
    actualSequence: verification.sequence,
    expectedRecordCount: recordCount,
    actualRecordCount: records.length,
  };
}

async function getBranch({repository, token, fetchImpl}) {
  return request(`${API}/repos/${repository}/git/ref/heads/${LISTENER_STORE_BRANCH}`, {token, fetchImpl});
}

async function createBranch({repository, token, executorCommit, fetchImpl}) {
  return request(`${API}/repos/${repository}/git/refs`, {
    token,
    method: 'POST',
    body: {ref: `refs/heads/${LISTENER_STORE_BRANCH}`, sha: executorCommit},
    fetchImpl,
  });
}

function readRemoteAnchor(text) {
  try {
    const anchor = JSON.parse(text);
    return anchor && typeof anchor === 'object' && !Array.isArray(anchor) ? anchor : null;
  } catch {
    return null;
  }
}

async function writeContents({repository, file, text, sha, token, fetchImpl, message}) {
  return request(`${API}/repos/${repository}/contents/${file}`, {
    token,
    method: 'PUT',
    body: {
      message,
      content: Buffer.from(text, 'utf8').toString('base64'),
      branch: LISTENER_STORE_BRANCH,
      ...(sha ? {sha} : {}),
    },
    fetchImpl,
  });
}

const retryableConflict = result => [0, 409, 422].includes(result.status);

function admissionFromStored(record, mission) {
  return {
    state: 'ADMITTED',
    admitted: true,
    reason: null,
    detail: null,
    executorSha: record.admission.executorSha,
    mission,
    missionKey: missionKey(mission),
    missionBindingDigest: record.admission.missionBindingDigest,
    deliveryId: record.admission.deliveryId,
    sender: record.admission.sender,
    credentialsRequired: false,
    admittedAt: record.admission.recordedAt,
  };
}

/**
 * Admit once and persist the accepted mission before the workflow handoff.
 * Refused events are returned with a machine-readable reason but do not write to
 * the durable ledger; their GitHub Actions run log is their refusal record.
 */
export async function admitMissionDurably({
  event,
  policy = {},
  token,
  repository,
  executorCommit,
  runId,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  maxConflictRetries = 3,
} = {}) {
  const blocked = (reason, fields = {}) => ({
    admission: {
      state: 'REFUSED', admitted: false, reason: 'LISTENER_DURABLE_STORE_BLOCKED',
      detail: {storeReason: reason}, executorSha: null, mission: null, credentialsRequired: false,
    },
    persistence: makeSummary('BLOCKED', {reason, ...fields}),
    exitCode: LISTENER_STORE_EXIT.BLOCKED,
  });
  // Give policy refusals their precise reason without requiring API credentials or
  // making a network request. A valid admission is never returned from this local
  // preflight; it must pass all durable-store checks below.
  const baseDecision = admitMission(event, {...policy, deliveries: [], recentAdmissions: [], now});
  if (baseDecision.admitted !== true) {
    return {
      admission: baseDecision,
      persistence: makeSummary('NOT_STORED', {reason: baseDecision.reason, appended: false}),
      exitCode: LISTENER_STORE_EXIT.OK,
    };
  }

  if (typeof token !== 'string' || !token.trim()) return blocked('GITHUB_TOKEN_REQUIRED');
  if (repository !== LISTENER_STORE_REPOSITORY) return blocked('CONTROLLER_REPOSITORY_REQUIRED');
  if (!SHA1.test(String(executorCommit ?? ''))) return blocked('EXECUTOR_COMMIT_REQUIRED');
  if (!/^\d{1,20}$/.test(String(runId ?? ''))) return blocked('GITHUB_RUN_ID_REQUIRED');
  const targetBindingDigest = missionBindingDigest(baseDecision.mission);
  const runIdText = String(runId);
  let createdByThisInvocation = false;
  let lastFailure = null;

  for (let attempt = 0; attempt <= maxConflictRetries; attempt += 1) {
    let ref = await getBranch({repository, token, fetchImpl});
    let branchCreatedHere = createdByThisInvocation;
    if (ref.status === 404) {
      const created = await createBranch({repository, token, executorCommit, fetchImpl});
      if (created.ok && [200, 201].includes(created.status)) {
        createdByThisInvocation = true;
        branchCreatedHere = true;
        ref = created;
      } else if (created.status === 422 && attempt < maxConflictRetries) {
        lastFailure = 'BRANCH_CREATE_RACE';
        continue;
      } else {
        return blocked('BRANCH_CREATE_FAILED', {httpStatus: created.status});
      }
    }
    const branchSha = ref.body?.object?.sha ?? ref.body?.sha ?? null;
    if (!ref.ok || !SHA1.test(String(branchSha ?? ''))) return blocked('BRANCH_UNAVAILABLE', {httpStatus: ref.status});

    const [ledgerFile, anchorFile] = await Promise.all([
      getContents({repository, file: LISTENER_STORE_LEDGER_PATH, token, fetchImpl}),
      getContents({repository, file: LISTENER_STORE_ANCHOR_PATH, token, fetchImpl}),
    ]);
    if (ledgerFile.found === null || anchorFile.found === null) {
      return blocked('LEDGER_OR_ANCHOR_UNREADABLE', {ledgerHttpStatus: ledgerFile.status, anchorHttpStatus: anchorFile.status});
    }
    const bothAbsent = ledgerFile.found === false && anchorFile.found === false;
    if (!bothAbsent && (ledgerFile.found !== true || anchorFile.found !== true)) {
      if (attempt < maxConflictRetries && (createdByThisInvocation || lastFailure === 'BRANCH_CREATE_RACE')) {
        lastFailure = 'INITIAL_PAIR_NOT_YET_VISIBLE';
        continue;
      }
      return blocked('LEDGER_ANCHOR_PAIR_INCOMPLETE', {ledgerPresent: ledgerFile.found === true, anchorPresent: anchorFile.found === true});
    }
    if (bothAbsent && !branchCreatedHere) return blocked('EXISTING_BRANCH_HAS_NO_ADMISSION_EVIDENCE');

    let verification = {state: 'INTACT', records: [], head: null, sequence: 0};
    let previousAnchor = null;
    let anchorCheck = null;
    if (!bothAbsent) {
      verification = verifyAdmissionLedger(ledgerFile.text);
      previousAnchor = readRemoteAnchor(anchorFile.text);
      if (verification.state !== 'INTACT') return blocked('LEDGER_NOT_INTACT', {integrity: verification.state, integrityReason: verification.reason});
      anchorCheck = compareAdmissionAnchor(verification, previousAnchor);
      if (anchorCheck.checked !== true || anchorCheck.consistent !== true) {
        return blocked('ANCHOR_MISMATCH', {anchorReason: anchorCheck.reason, integrity: verification.state});
      }
    }

    const records = verification.records;
    const existingForThisRun = records.find(entry => entry.admission.runId === runIdText
      && entry.admission.missionBindingDigest === targetBindingDigest
      && entry.admission.deliveryId === event.deliveryId
      && entry.admission.executorSha === event.executorSha
      && entry.admission.sender === event.sender);

    // A stale but prefix-consistent anchor can only be repaired by retrying the
    // exact same run whose final ledger record is unanchored. A different mission
    // must not advance the anchor over a pending admission and accidentally make
    // that old record eligible for the execution gate later.
    if (anchorCheck?.reason === 'LEDGER_AHEAD_OF_ANCHOR'
        && (!existingForThisRun || records.at(-1) !== existingForThisRun)) {
      return blocked('ANCHOR_REPAIR_REQUIRED', {
        expectedSequence: anchorCheck.expectedSequence,
        actualSequence: anchorCheck.actualSequence,
      });
    }

    let admission;
    if (existingForThisRun) {
      // A retry of this same workflow run may have stored the admission but lost
      // the response or anchor update. Repair the anchor before allowing handoff.
      admission = admissionFromStored(existingForThisRun, baseDecision.mission);
    } else {
      const deliveries = records.map(entry => ({
        deliveryId: entry.admission.deliveryId,
        missionBindingDigest: entry.admission.missionBindingDigest,
      }));
      const recentAdmissions = records.map(entry => ({
        sender: entry.admission.sender,
        at: Date.parse(entry.admission.recordedAt),
      }));
      admission = admitMission(event, {...policy, deliveries, recentAdmissions, now});
      if (admission.admitted !== true) {
        return {
          admission,
          persistence: makeSummary('NOT_STORED', {reason: admission.reason, appended: false}),
          exitCode: LISTENER_STORE_EXIT.OK,
        };
      }
    }

    let finalVerification = verification;
    let ledgerStored = Boolean(existingForThisRun);
    if (!existingForThisRun) {
      const nextSeq = records.length + 1;
      const admissionEntry = admissionRecord(admission, {now, runId: runIdText});
      const entry = {
        seq: nextSeq,
        prev: records.length ? records.at(-1).hash : null,
        admission: admissionEntry,
      };
      entry.hash = hashEntry(entry);
      const ledgerText = (bothAbsent ? '' : ledgerFile.text)
        + (bothAbsent || ledgerFile.text.endsWith('\n') ? '' : '\n')
        + JSON.stringify(entry) + '\n';
      finalVerification = verifyAdmissionLedger(ledgerText);
      if (finalVerification.state !== 'INTACT') return blocked('APPEND_NOT_INTACT', {integrity: finalVerification.state});
      const ledgerWrite = await writeContents({
        repository,
        file: LISTENER_STORE_LEDGER_PATH,
        text: ledgerText,
        sha: ledgerFile.found ? ledgerFile.sha : null,
        token,
        fetchImpl,
        message: `ci(mission): record admission sequence ${nextSeq}`,
      });
      if (!ledgerWrite.ok) {
        if (retryableConflict(ledgerWrite) && attempt < maxConflictRetries) {
          lastFailure = 'LEDGER_WRITE_CONFLICT';
          continue;
        }
        return blocked('LEDGER_WRITE_FAILED', {httpStatus: ledgerWrite.status});
      }
      ledgerStored = true;
    }

    const nextAnchor = buildAdmissionAnchor(finalVerification, {now});
    const anchorMatches = previousAnchor
      && previousAnchor.head === nextAnchor.head
      && previousAnchor.sequence === nextAnchor.sequence
      && previousAnchor.recordCount === nextAnchor.recordCount;
    let anchorStored = Boolean(anchorMatches);
    if (!anchorMatches) {
      const anchorWrite = await writeContents({
        repository,
        file: LISTENER_STORE_ANCHOR_PATH,
        text: JSON.stringify(nextAnchor, null, 2) + '\n',
        sha: anchorFile.found ? anchorFile.sha : null,
        token,
        fetchImpl,
        message: `ci(mission): anchor admission ledger sequence ${nextAnchor.sequence}`,
      });
      if (!anchorWrite.ok) {
        if (retryableConflict(anchorWrite) && attempt < maxConflictRetries) {
          lastFailure = 'ANCHOR_WRITE_CONFLICT';
          continue;
        }
        return {
          admission: {...admission, admitted: false, state: 'REFUSED', reason: 'LISTENER_DURABLE_STORE_BLOCKED'},
          persistence: makeSummary(ledgerStored ? 'PARTIAL' : 'BLOCKED', {
            reason: ledgerStored ? 'LEDGER_STORED_ANCHOR_WRITE_FAILED' : 'ANCHOR_WRITE_FAILED',
            httpStatus: anchorWrite.status,
            ledgerStored,
            anchorStored: false,
            missionBindingDigest: targetBindingDigest,
          }),
          exitCode: LISTENER_STORE_EXIT.BLOCKED,
        };
      }
      anchorStored = true;
    }

    return {
      admission,
      persistence: makeSummary('PERSISTED', {
        branch: LISTENER_STORE_BRANCH,
        ledgerPath: LISTENER_STORE_LEDGER_PATH,
        anchorPath: LISTENER_STORE_ANCHOR_PATH,
        appended: !existingForThisRun,
        alreadyRecordedForRun: Boolean(existingForThisRun),
        ledgerStored,
        anchorStored,
        anchorConsistent: compareAdmissionAnchor(finalVerification, nextAnchor).consistent === true,
        integrity: finalVerification.state,
        missionBindingDigest: targetBindingDigest,
        head: finalVerification.head,
        sequence: finalVerification.sequence,
        recordCount: finalVerification.records.length,
      }),
      exitCode: LISTENER_STORE_EXIT.OK,
    };
  }

  return blocked(lastFailure ?? 'CONCURRENT_WRITE_RETRIES_EXHAUSTED', {retryCount: maxConflictRetries});
}

/** Read-only second gate used by the privileged reusable workflow. */
export async function verifyStoredMissionAdmission({
  token,
  repository,
  targetRepository,
  missionId,
  targetSha,
  deliveryId,
  executorSha,
  runId,
  fetchImpl = globalThis.fetch,
} = {}) {
  const denied = reason => makeSummary('BLOCKED', {reason, admitted: false, credentialsPrinted: false});
  if (typeof token !== 'string' || !token.trim()) return denied('GITHUB_TOKEN_REQUIRED');
  if (repository !== LISTENER_STORE_REPOSITORY) return denied('CONTROLLER_REPOSITORY_REQUIRED');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(String(missionId ?? ''))) return denied('MISSION_ID_INVALID');
  if (typeof targetRepository !== 'string' || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(targetRepository)) return denied('MISSION_REPOSITORY_INVALID');
  if (!SHA1.test(String(targetSha ?? ''))) return denied('MISSION_SHA_INVALID');
  if (!SHA1.test(String(executorSha ?? ''))) return denied('EXECUTOR_SHA_INVALID');
  if (!/^run-[A-Za-z0-9-]{1,32}$/.test(String(deliveryId ?? ''))) return denied('DELIVERY_ID_INVALID');
  if (!/^\d{1,20}$/.test(String(runId ?? ''))) return denied('GITHUB_RUN_ID_REQUIRED');
  let expectedBindingDigest;
  try {
    expectedBindingDigest = missionBindingDigest({missionId, repository: targetRepository, sha: targetSha});
  } catch {
    return denied('MISSION_BINDING_INVALID');
  }

  const ref = await getBranch({repository, token, fetchImpl});
  const branchSha = ref.body?.object?.sha ?? ref.body?.sha ?? null;
  if (!ref.ok || !SHA1.test(String(branchSha ?? ''))) return denied('ADMISSION_BRANCH_UNAVAILABLE');
  const [ledgerFile, anchorFile] = await Promise.all([
    getContents({repository, file: LISTENER_STORE_LEDGER_PATH, token, fetchImpl}),
    getContents({repository, file: LISTENER_STORE_ANCHOR_PATH, token, fetchImpl}),
  ]);
  if (ledgerFile.found !== true || anchorFile.found !== true) return denied('ADMISSION_EVIDENCE_UNAVAILABLE');
  const verification = verifyAdmissionLedger(ledgerFile.text);
  if (verification.state !== 'INTACT') return denied('ADMISSION_LEDGER_NOT_INTACT');
  const anchor = readRemoteAnchor(anchorFile.text);
  const anchorCheck = compareAdmissionAnchor(verification, anchor);
  if (anchorCheck.checked !== true || anchorCheck.consistent !== true) return denied('ADMISSION_ANCHOR_MISMATCH');
  // The writer may append a ledger record and then fail before updating the anchor.
  // A prefix-consistent anchor is useful when the next writer repairs the pair, but
  // it is not sufficient evidence to start the unanchored mission.
  if (anchorCheck.expectedSequence !== verification.sequence
      || anchorCheck.expectedRecordCount !== verification.records.length
      || anchorCheck.reason === 'LEDGER_AHEAD_OF_ANCHOR') {
    return denied('ADMISSION_ANCHOR_STALE');
  }

  const match = verification.records.find(entry => {
    const a = entry.admission;
    return a.admitted === true
      && a.missionBindingDigest === expectedBindingDigest
      && a.deliveryId === deliveryId
      && a.executorSha === executorSha
      && a.runId === String(runId);
  });
  if (!match) return denied('ADMISSION_RECORD_NOT_FOUND');
  return makeSummary('VERIFIED', {
    admitted: true,
    missionBindingVerified: true,
    anchorConsistent: true,
    trustModel: 'SAME_WRITER_ANCHORED_LEDGER',
    independentVerifierRequired: true,
  });
}
