import assert from 'node:assert/strict';
import {test} from 'node:test';

import {persistRetirementEvidence, RETIREMENT_ANCHOR_PATH} from '../scripts/private-ci-retirement-persist.mjs';
import {appendRecord, buildHeadAnchor, verifyLedger} from '../scripts/private-ci-retirement-integrity.mjs';
import {RETIREMENT_LEDGER_BRANCH, RETIREMENT_LEDGER_PATH} from '../scripts/private-ci-retirement-ledger.mjs';

const REPOSITORY = 'insidethemarginmedia-cpu/wolf-factory-home';
const COMMIT = 'a'.repeat(40);
const TOKEN = 'ghp_fixture_never_print_this';
const decision = {state: 'RETIRE_FALLBACK', retire: true, reasons: ['APP_ACCEPTED']};
const response = (status, body = null) => ({status, ok: status >= 200 && status < 300, json: async () => body});

function fakeGitHub({branch = false, ledger = null, anchor = null, failAnchorWrite = false, createBranchConflict = false, afterLedgerRead = null} = {}) {
  let branchExists = branch;
  const contents = new Map();
  const writes = [];
  let nextBlob = 1;
  if (ledger !== null) contents.set(RETIREMENT_LEDGER_PATH, {text: ledger, sha: 'c'.repeat(40)});
  if (anchor !== null) contents.set(RETIREMENT_ANCHOR_PATH, {text: anchor, sha: 'd'.repeat(40)});

  const fetchImpl = async (url, init = {}) => {
    assert.equal(init.headers.authorization, 'Bearer ' + TOKEN);
    assert.equal(init.redirect, 'error');
    const parsed = new URL(url);
    const method = init.method ?? 'GET';
    const apiPath = parsed.pathname.replace(`/repos/${REPOSITORY}`, '');
    if (apiPath === `/git/ref/heads/${RETIREMENT_LEDGER_BRANCH}` && method === 'GET') {
      return branchExists ? response(200, {object: {sha: 'b'.repeat(40)}}) : response(404, {message: 'Not Found'});
    }
    if (apiPath === '/git/refs' && method === 'POST') {
      writes.push({kind: 'create-branch'});
      branchExists = true;
      return response(201, {ref: `refs/heads/${RETIREMENT_LEDGER_BRANCH}`, object: {sha: COMMIT}});
    }
    const filePath = apiPath.startsWith('/contents/') ? apiPath.slice('/contents/'.length) : null;
    if (filePath && method === 'GET') {
      const stored = contents.get(filePath);
      if (!stored) return response(404, {message: 'Not Found'});
      return response(200, {
        encoding: 'base64',
        content: Buffer.from(stored.text, 'utf8').toString('base64'),
        sha: stored.sha,
      });
    }
    if (filePath && method === 'PUT') {
      const body = JSON.parse(init.body);
      const stored = contents.get(filePath);
      if (stored && body.sha !== stored.sha) return response(409, {message: 'Conflict'});
      if (!stored && body.sha) return response(409, {message: 'Unexpected sha'});
      if (filePath === RETIREMENT_ANCHOR_PATH && failAnchorWrite) return response(500, {message: 'simulated'});
      writes.push({kind: filePath === RETIREMENT_LEDGER_PATH ? 'ledger' : 'anchor'});
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      contents.set(filePath, {text, sha: String(nextBlob++).padStart(40, '0')});
      return response(201, {content: {path: filePath}, commit: {sha: 'e'.repeat(40)}});
    }
    return response(404, {message: 'Unexpected route'});
  };
  return {
    fetchImpl,
    writes,
    files: contents,
    hasBranch: () => branchExists,
  };
}

const persist = (fake, overrides = {}) => persistRetirementEvidence({
  decision,
  token: TOKEN,
  repository: REPOSITORY,
  commit: COMMIT,
  runId: 'run-101',
  now: Date.UTC(2026, 10, 24, 12, 0, 0),
  fetchImpl: fake.fetchImpl,
  ...overrides,
});

test('first retirement creates the dedicated branch, then persists ledger before anchor', async () => {
  const fake = fakeGitHub();
  const {result, exitCode} = await persist(fake);
  assert.equal(exitCode, 0);
  assert.equal(result.state, 'PERSISTED');
  assert.equal(result.branch, RETIREMENT_LEDGER_BRANCH);
  assert.equal(result.trustModel, 'SAME_WRITER_ANCHOR');
  assert.equal(result.independentVerifierRequired, true);
  assert.deepEqual(fake.writes.map(write => write.kind), ['create-branch', 'ledger', 'anchor']);
  assert.equal(fake.hasBranch(), true);

  const ledger = fake.files.get(RETIREMENT_LEDGER_PATH).text;
  const verified = verifyLedger(ledger);
  assert.equal(verified.state, 'INTACT');
  assert.equal(verified.records.length, 1);
  assert.equal(verified.records[0].state, 'RETIRED');
  assert.equal(verified.records[0].runId, 'run-101');
  const anchor = JSON.parse(fake.files.get(RETIREMENT_ANCHOR_PATH).text);
  assert.equal(anchor.head, verified.head);
  assert.equal(anchor.sequence, 1);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('an existing anchored ledger is fetched and appended, never replaced by a local one-record file', async () => {
  const first = appendRecord('', {state: 'ACTIVE', retire: false, recordedAt: '2026-11-24T11:00:00.000Z'});
  const oldAnchor = buildHeadAnchor(verifyLedger(first.text));
  const fake = fakeGitHub({branch: true, ledger: first.text, anchor: JSON.stringify(oldAnchor)});
  const {result, exitCode} = await persist(fake);
  assert.equal(exitCode, 0);
  assert.equal(result.state, 'PERSISTED');
  const ledger = fake.files.get(RETIREMENT_LEDGER_PATH).text;
  const verified = verifyLedger(ledger);
  assert.equal(verified.state, 'INTACT');
  assert.equal(verified.records.length, 2);
  assert.equal(verified.records[0].hash, first.record.hash);
  assert.equal(verified.records[1].seq, 2);
  assert.equal(verified.records[1].state, 'RETIRED');
  const anchor = JSON.parse(fake.files.get(RETIREMENT_ANCHOR_PATH).text);
  assert.equal(anchor.head, verified.head);
  assert.equal(anchor.sequence, 2);
});

test('an existing branch with a missing ledger/anchor pair blocks without writing', async () => {
  const first = appendRecord('', {state: 'ACTIVE', retire: false, recordedAt: '2026-11-24T11:00:00.000Z'});
  const fake = fakeGitHub({branch: true, ledger: first.text});
  const {result, exitCode} = await persist(fake);
  assert.equal(exitCode, 78);
  assert.equal(result.reason, 'RETIREMENT_LEDGER_ANCHOR_PAIR_INCOMPLETE');
  assert.deepEqual(fake.writes, []);
});

test('a locally valid prefix shorter than the remote anchor cannot overwrite either object', async () => {
  const first = appendRecord('', {state: 'ACTIVE', retire: false, recordedAt: '2026-11-24T11:00:00.000Z'});
  const full = appendRecord(first.text, {state: 'RETIRED', retire: true, recordedAt: '2026-11-24T11:30:00.000Z'});
  const fake = fakeGitHub({branch: true, ledger: first.text, anchor: JSON.stringify(buildHeadAnchor(verifyLedger(full.text)))});
  const {result, exitCode} = await persist(fake);
  assert.equal(exitCode, 78);
  assert.equal(result.reason, 'RETIREMENT_LEDGER_TRUNCATED');
  assert.deepEqual(fake.writes, []);
  assert.equal(fake.files.get(RETIREMENT_LEDGER_PATH).text, first.text);
});

test('legacy or unsealed remote history is not silently re-sealed', async () => {
  const legacy = JSON.stringify({state: 'ACTIVE', retire: false, recordedAt: '2026-11-24T11:00:00.000Z'}) + '\n';
  const fake = fakeGitHub({branch: true, ledger: legacy, anchor: JSON.stringify({})});
  const {result, exitCode} = await persist(fake);
  assert.equal(exitCode, 78);
  assert.equal(result.reason, 'LEGACY_RETIREMENT_HISTORY_REQUIRES_REVIEW');
  assert.deepEqual(fake.writes, []);
});

test('an anchor write failure is reported as partial while the durable RETIRE record remains', async () => {
  const fake = fakeGitHub({failAnchorWrite: true});
  const {result, exitCode} = await persist(fake);
  assert.equal(exitCode, 78);
  assert.equal(result.state, 'PARTIAL');
  assert.equal(result.reason, 'RETIREMENT_LEDGER_STORED_ANCHOR_WRITE_FAILED');
  assert.equal(result.ledgerStored, true);
  assert.equal(result.anchorStored, false);
  assert.equal(verifyLedger(fake.files.get(RETIREMENT_LEDGER_PATH).text).records[0].state, 'RETIRED');
});

test('a keep decision performs no network request and does not create evidence', async () => {
  let called = false;
  const result = await persistRetirementEvidence({
    decision: {state: 'KEEP_FALLBACK', retire: false},
    token: TOKEN,
    repository: REPOSITORY,
    commit: COMMIT,
    runId: 'run-101',
    fetchImpl: async () => { called = true; throw Error('must not run'); },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.result.state, 'NOT_REQUIRED');
  assert.equal(called, false);
});

test('a missing anchor on an existing branch is not treated as a first-run branch', async () => {
  const fake = fakeGitHub({branch: true});
  const {result, exitCode} = await persist(fake);
  assert.equal(exitCode, 78);
  assert.equal(result.reason, 'EXISTING_RETIREMENT_BRANCH_HAS_NO_EVIDENCE');
  assert.deepEqual(fake.writes, []);
});
