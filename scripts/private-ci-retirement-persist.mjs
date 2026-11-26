// Append a fallback-retirement decision to the durable, anchored ledger.
//
// The branch ref, ledger and anchor are fetched independently. An existing
// ledger is never reconstructed from the current run's local checkout, and any
// missing, malformed, truncated or unverifiable evidence blocks publication.
// The ledger is written before its anchor: during the short non-atomic Contents
// API window a visible RETIRED record denies fallback even if the anchor has not
// caught up yet. Both objects are controlled by the same GitHub writer; the
// anchor detects accidental/mismatched rollback, not a malicious rewrite by that
// writer, and is not independent verification.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

import {appendRecord, buildHeadAnchor, compareToAnchor, verifyLedger} from './private-ci-retirement-integrity.mjs';
import {retirementRecord, RETIREMENT_LEDGER_BRANCH, RETIREMENT_LEDGER_PATH} from './private-ci-retirement-ledger.mjs';

export const RETIREMENT_ANCHOR_PATH = '.wolf-ci/retirement-head.json';
export const RETIREMENT_PERSIST_EXIT = Object.freeze({OK: 0, DEFECT: 1, USAGE: 2, BLOCKED: 78});

const API = 'https://api.github.com';
const CONTROLLER_REPOSITORY = 'insidethemarginmedia-cpu/wolf-factory-home';
const BASE_HEADERS = Object.freeze({
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
});

const responseJson = async response => {
  try { return await response.json(); } catch { return null; }
};

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
  return {
    ok: response.ok === true,
    status: Number.isInteger(response.status) ? response.status : 0,
    body: await responseJson(response),
  };
}

const hasValidSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const validBase64 = value => /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);

function decodeContents(body) {
  if (!body || body.encoding !== 'base64' || typeof body.content !== 'string' || !hasValidSha(body.sha)) return {ok: false};
  const encoded = body.content.replace(/\s+/g, '');
  if (encoded && !validBase64(encoded)) return {ok: false};
  return {ok: true, text: Buffer.from(encoded, 'base64').toString('utf8'), sha: body.sha};
}

async function getContents({repository, file, branch, token, fetchImpl}) {
  const endpoint = `${API}/repos/${repository}/contents/${file}?ref=${encodeURIComponent(branch)}`;
  const result = await request(endpoint, {token, fetchImpl});
  if (result.status === 404) return {found: false, status: 404};
  if (!result.ok) return {found: null, status: result.status};
  const decoded = decodeContents(result.body);
  return decoded.ok
    ? {found: true, status: result.status, text: decoded.text, sha: decoded.sha}
    : {found: null, status: result.status};
}

const summary = (state, fields = {}) => ({
  state,
  credentialsPrinted: false,
  trustModel: 'SAME_WRITER_ANCHOR',
  independentVerifierRequired: true,
  ...fields,
});

/**
 * Persist one RETIRED decision. This performs only the required GitHub Contents
 * API writes and never prints or returns the bearer token or remote file bytes.
 */
export async function persistRetirementEvidence({
  decision,
  token,
  repository,
  commit,
  runId,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (decision?.retire !== true) {
    return {result: summary('NOT_REQUIRED', {reason: 'DECISION_KEEPS_FALLBACK', appended: false}) , exitCode: RETIREMENT_PERSIST_EXIT.OK};
  }
  if (typeof token !== 'string' || !token.trim()) {
    return {result: summary('BLOCKED', {reason: 'GITHUB_TOKEN_REQUIRED', appended: false}), exitCode: RETIREMENT_PERSIST_EXIT.BLOCKED};
  }
  if (repository !== CONTROLLER_REPOSITORY) {
    return {result: summary('BLOCKED', {reason: 'CONTROLLER_REPOSITORY_REQUIRED', appended: false}), exitCode: RETIREMENT_PERSIST_EXIT.BLOCKED};
  }
  if (!hasValidSha(commit)) {
    return {result: summary('BLOCKED', {reason: 'CONTROLLER_COMMIT_REQUIRED', appended: false}), exitCode: RETIREMENT_PERSIST_EXIT.BLOCKED};
  }
  if (runId === undefined || runId === null || String(runId).trim() === '') {
    return {result: summary('BLOCKED', {reason: 'RUN_ID_REQUIRED', appended: false}), exitCode: RETIREMENT_PERSIST_EXIT.BLOCKED};
  }

  const refUrl = `${API}/repos/${repository}/git/ref/heads/${RETIREMENT_LEDGER_BRANCH}`;
  let ref = await request(refUrl, {token, fetchImpl});
  let branchCreatedHere = false;
  if (ref.status === 404) {
    const created = await request(`${API}/repos/${repository}/git/refs`, {
      token,
      method: 'POST',
      body: {ref: `refs/heads/${RETIREMENT_LEDGER_BRANCH}`, sha: commit},
      fetchImpl,
    });
    if (created.ok && [200, 201].includes(created.status)) {
      branchCreatedHere = true;
      ref = created;
    } else if (created.status === 422) {
      // A concurrent run may have created the ref. Re-read it; never assume an
      // error means absence, and never replace its contents with a local copy.
      ref = await request(refUrl, {token, fetchImpl});
    } else {
      return {result: summary('BLOCKED', {reason: 'RETIREMENT_BRANCH_CREATE_FAILED', httpStatus: created.status, appended: false}), exitCode: RETIREMENT_PERSIST_EXIT.BLOCKED};
    }
  }
  const branchSha = ref.body?.object?.sha ?? ref.body?.sha ?? null;
  if (!ref.ok || !hasValidSha(branchSha)) {
    return {result: summary('BLOCKED', {reason: 'RETIREMENT_BRANCH_UNAVAILABLE', httpStatus: ref.status, appended: false}), exitCode: RETIREMENT_PERSIST_EXIT.BLOCKED};
  }

  const [ledgerFile, anchorFile] = await Promise.all([
    getContents({repository, file: RETIREMENT_LEDGER_PATH, branch: RETIREMENT_LEDGER_BRANCH, token, fetchImpl}),
    getContents({repository, file: RETIREMENT_ANCHOR_PATH, branch: RETIREMENT_LEDGER_BRANCH, token, fetchImpl}),
  ]);
  if (ledgerFile.found === null || anchorFile.found === null) {
    return {result: summary('BLOCKED', {
      reason: 'RETIREMENT_FILES_UNREADABLE',
      ledgerHttpStatus: ledgerFile.status,
      anchorHttpStatus: anchorFile.status,
      appended: false,
    }), exitCode: RETIREMENT_PERSIST_EXIT.BLOCKED};
  }

  const bothAbsent = ledgerFile.found === false && anchorFile.found === false;
  if (!bothAbsent && (ledgerFile.found !== true || anchorFile.found !== true)) {
    return {result: summary('BLOCKED', {
      reason: 'RETIREMENT_LEDGER_ANCHOR_PAIR_INCOMPLETE',
      ledgerPresent: ledgerFile.found === true,
      anchorPresent: anchorFile.found === true,
      appended: false,
    }), exitCode: RETIREMENT_PERSIST_EXIT.BLOCKED};
  }
  if (bothAbsent && !branchCreatedHere) {
    return {result: summary('BLOCKED', {reason: 'EXISTING_RETIREMENT_BRANCH_HAS_NO_EVIDENCE', appended: false}), exitCode: RETIREMENT_PERSIST_EXIT.BLOCKED};
  }

  let ledgerText = '';
  let previousAnchor = null;
  if (!bothAbsent) {
    ledgerText = ledgerFile.text;
    try { previousAnchor = JSON.parse(anchorFile.text); } catch {
      return {result: summary('BLOCKED', {reason: 'RETIREMENT_ANCHOR_UNREADABLE', appended: false}), exitCode: RETIREMENT_PERSIST_EXIT.BLOCKED};
    }
    const verification = verifyLedger(ledgerText);
    if (verification.state !== 'INTACT') {
      return {result: summary('BLOCKED', {reason: 'RETIREMENT_LEDGER_NOT_INTACT', integrity: verification.state, integrityReason: verification.reason ?? null, appended: false}), exitCode: RETIREMENT_PERSIST_EXIT.BLOCKED};
    }
    if (!verification.records.length || verification.records.some(record => record.integrityVersion !== 1)) {
      // Do not silently upgrade unanchored legacy history: it needs a separately
      // reviewed migration/attestation so old retirements cannot disappear.
      return {result: summary('BLOCKED', {reason: 'LEGACY_RETIREMENT_HISTORY_REQUIRES_REVIEW', integrity: verification.state, appended: false}), exitCode: RETIREMENT_PERSIST_EXIT.BLOCKED};
    }
    const anchorCheck = compareToAnchor(verification, previousAnchor);
    if (anchorCheck.checked !== true || anchorCheck.consistent !== true) {
      return {result: summary('BLOCKED', {
        reason: anchorCheck.reason === 'LEDGER_SHORTER_THAN_ANCHOR' ? 'RETIREMENT_LEDGER_TRUNCATED' : 'RETIREMENT_ANCHOR_MISMATCH',
        anchorReason: anchorCheck.reason,
        integrity: verification.state,
        appended: false,
      }), exitCode: RETIREMENT_PERSIST_EXIT.BLOCKED};
    }
  }

  const verificationBefore = verifyLedger(ledgerText);
  const matchingRunRecords = verificationBefore.records.filter(record => String(record.runId ?? '') === String(runId));
  if (matchingRunRecords.some(record => record.state !== 'RETIRED' || record.retire !== true)) {
    return {result: summary('BLOCKED', {reason: 'RUN_ID_CONFLICTS_WITH_EXISTING_RETIREMENT_RECORD', appended: false}), exitCode: RETIREMENT_PERSIST_EXIT.BLOCKED};
  }
  if (matchingRunRecords.length > 1) {
    return {result: summary('BLOCKED', {reason: 'DUPLICATE_RUN_ID_RECORDS', appended: false}), exitCode: RETIREMENT_PERSIST_EXIT.BLOCKED};
  }

  let appended = false;
  let finalText = ledgerText;
  let record = matchingRunRecords[0] ?? null;
  if (!record) {
    const pending = retirementRecord(decision, {commit, runId, now, source: 'retirement-persist'});
    const next = appendRecord(ledgerText, pending);
    finalText = next.text;
    record = next.record;
    appended = true;
  }
  const finalVerification = verifyLedger(finalText);
  if (finalVerification.state !== 'INTACT' || finalVerification.records.some(entry => entry.integrityVersion !== 1)) {
    return {result: summary('BLOCKED', {reason: 'RETIREMENT_APPEND_NOT_INTACT', integrity: finalVerification.state, appended: false}), exitCode: RETIREMENT_PERSIST_EXIT.BLOCKED};
  }
  const currentAnchorCheck = previousAnchor === null ? null : compareToAnchor(finalVerification, previousAnchor);
  if (currentAnchorCheck && (currentAnchorCheck.checked !== true || currentAnchorCheck.consistent !== true)) {
    return {result: summary('BLOCKED', {reason: 'RETIREMENT_ANCHOR_MISMATCH_AFTER_APPEND', anchorReason: currentAnchorCheck.reason, appended: false}), exitCode: RETIREMENT_PERSIST_EXIT.BLOCKED};
  }

  const nextAnchor = buildHeadAnchor(finalVerification, {commit, now});
  const sameAnchor = previousAnchor
    && previousAnchor.head === nextAnchor.head
    && previousAnchor.sequence === nextAnchor.sequence
    && previousAnchor.recordCount === nextAnchor.recordCount;
  let ledgerStored = !appended;
  let ledgerWriteStatus = null;
  if (appended) {
    const body = {
      message: `chore(ci): append fallback retirement for run ${String(runId).slice(0, 64)}`,
      content: Buffer.from(finalText, 'utf8').toString('base64'),
      branch: RETIREMENT_LEDGER_BRANCH,
      ...(ledgerFile.found ? {sha: ledgerFile.sha} : {}),
    };
    const written = await request(`${API}/repos/${repository}/contents/${RETIREMENT_LEDGER_PATH}`, {
      token,
      method: 'PUT',
      body,
      fetchImpl,
    });
    ledgerWriteStatus = written.status;
    if (!written.ok) {
      return {result: summary('BLOCKED', {reason: written.status === 409 ? 'RETIREMENT_LEDGER_WRITE_CONFLICT' : 'RETIREMENT_LEDGER_WRITE_FAILED', httpStatus: written.status, appended: false, integrity: finalVerification.state}), exitCode: RETIREMENT_PERSIST_EXIT.BLOCKED};
    }
    ledgerStored = true;
  }

  let anchorStored = Boolean(sameAnchor);
  let anchorWriteStatus = null;
  if (!sameAnchor) {
    const body = {
      message: `chore(ci): advance fallback retirement anchor for run ${String(runId).slice(0, 64)}`,
      content: Buffer.from(JSON.stringify(nextAnchor, null, 2) + '\n', 'utf8').toString('base64'),
      branch: RETIREMENT_LEDGER_BRANCH,
      ...(anchorFile.found ? {sha: anchorFile.sha} : {}),
    };
    const written = await request(`${API}/repos/${repository}/contents/${RETIREMENT_ANCHOR_PATH}`, {
      token,
      method: 'PUT',
      body,
      fetchImpl,
    });
    anchorWriteStatus = written.status;
    if (!written.ok) {
      return {
        result: summary(ledgerStored ? 'PARTIAL' : 'BLOCKED', {
          reason: ledgerStored ? 'RETIREMENT_LEDGER_STORED_ANCHOR_WRITE_FAILED' : 'RETIREMENT_ANCHOR_WRITE_FAILED',
          httpStatus: written.status,
          appended,
          ledgerStored,
          ledgerWriteStatus,
          anchorStored: false,
          anchorWriteStatus,
          head: finalVerification.head,
          sequence: finalVerification.sequence,
          integrity: finalVerification.state,
        }),
        exitCode: RETIREMENT_PERSIST_EXIT.BLOCKED,
      };
    }
    anchorStored = true;
  }

  return {
    result: summary('PERSISTED', {
      branch: RETIREMENT_LEDGER_BRANCH,
      ledgerPath: RETIREMENT_LEDGER_PATH,
      anchorPath: RETIREMENT_ANCHOR_PATH,
      appended,
      alreadyRecordedForRun: !appended,
      ledgerStored,
      ledgerWriteStatus,
      anchorStored,
      anchorWriteStatus,
      anchorConsistent: compareToAnchor(finalVerification, nextAnchor).consistent === true,
      integrity: finalVerification.state,
      head: finalVerification.head,
      sequence: finalVerification.sequence,
      recordCount: finalVerification.records.length,
      recordRunId: record.runId ?? null,
    }),
    exitCode: RETIREMENT_PERSIST_EXIT.OK,
  };
}

const flag = (argv, name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

export async function runRetirementPersistCli(argv = process.argv.slice(2), {
  env = process.env,
  fetchImpl = globalThis.fetch,
  stdout = text => process.stdout.write(text),
} = {}) {
  if (argv[0] !== 'persist') {
    stdout(JSON.stringify(summary('FAILED', {reason: 'PERSIST_COMMAND_REQUIRED'})) + '\n');
    return RETIREMENT_PERSIST_EXIT.USAGE;
  }
  const decisionPath = flag(argv, '--decision') ?? env.WOLF_CI_RETIREMENT_FILE;
  let decision = null;
  try { decision = JSON.parse(fs.readFileSync(decisionPath, 'utf8')); } catch {}
  if (!decision || typeof decision !== 'object') {
    const result = summary('BLOCKED', {reason: 'RETIREMENT_DECISION_UNAVAILABLE', appended: false});
    const outPath = flag(argv, '--out') ?? env.WOLF_CI_RETIREMENT_PERSIST_FILE;
    if (outPath) {
      fs.mkdirSync(path.dirname(outPath), {recursive: true});
      fs.writeFileSync(outPath, JSON.stringify(result) + '\n', {mode: 0o600});
    }
    stdout(JSON.stringify(result) + '\n');
    return RETIREMENT_PERSIST_EXIT.BLOCKED;
  }
  const {result, exitCode} = await persistRetirementEvidence({
    decision,
    token: env.GITHUB_TOKEN,
    repository: env.GITHUB_REPOSITORY,
    commit: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    fetchImpl,
  });
  const outPath = flag(argv, '--out') ?? env.WOLF_CI_RETIREMENT_PERSIST_FILE;
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), {recursive: true});
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', {mode: 0o600});
  }
  stdout(JSON.stringify(result) + '\n');
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runRetirementPersistCli();
  } catch {
    process.stderr.write(JSON.stringify(summary('FAILED', {reason: 'RETIREMENT_PERSIST_FAILED'})) + '\n');
    process.exitCode = RETIREMENT_PERSIST_EXIT.DEFECT;
  }
}
