import assert from 'node:assert/strict';
import test from 'node:test';
import {probeDispatch, DISPATCH_PROBE_STATES, DISPATCH_PROBE_EXIT, dispatchProbeCli} from '../scripts/private-ci-dispatch-probe.mjs';

const ok = body => ({ok: true, status: 200, json: async () => body});

const harness = ({dispatchStatus = 204, before = 7, after = 7, listStatus = 200} = {}) => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({url, method: init.method ?? 'GET'});
    if (url.endsWith('/dispatches')) {
      return {ok: dispatchStatus === 204, status: dispatchStatus, json: async () => ({})};
    }
    if (url.includes('/runs?per_page=1')) {
      calls.filter(c => c.url.includes('/runs')).length; // noop, keeps ordering obvious
      const isAfter = calls.filter(c => c.url.includes('/runs')).length > 1;
      return ok({total_count: isAfter ? after : before});
    }
    if (url.includes('/actions/workflows/')) {
      return listStatus === 200 ? ok({id: 1}) : {ok: false, status: listStatus, json: async () => ({})};
    }
    throw new Error('unexpected url ' + url);
  };
  return {calls, fetchImpl};
};

test('a dispatch with no new run is reported as duplicate-suppressed', async () => {
  const {fetchImpl} = harness({before: 7, after: 7});
  const result = await probeDispatch({token: {value: 't', source: 'app'}, repository: 'donraposo1-source/project-wolf', workflowId: 42, sha: 'a'.repeat(40), settleMs: 0, sleep: async () => {}, fetchImpl});
  assert.equal(result.state, DISPATCH_PROBE_STATES.DISPATCHED);
  assert.equal(result.duplicateSuppressed, true);
  assert.equal(result.runsBefore, 7);
  assert.equal(result.runsAfter, 7);
  assert.equal(result.credentialSource, 'app');
});

test('a dispatch that creates a run is reported, not silently accepted', async () => {
  const {fetchImpl} = harness({before: 7, after: 8});
  const result = await probeDispatch({token: {value: 't', source: 'pat'}, repository: 'r/r', workflowId: 1, sha: 'b'.repeat(40), settleMs: 0, sleep: async () => {}, fetchImpl});
  assert.equal(result.state, DISPATCH_PROBE_STATES.DISPATCHED_WITH_NEW_RUN);
  assert.equal(result.duplicateSuppressed, false);
});

test('a 403 on dispatch is a blocked capability, not a crash', async () => {
  const {fetchImpl} = harness({dispatchStatus: 403});
  const result = await probeDispatch({token: {value: 't', source: 'pat'}, repository: 'r/r', workflowId: 1, sha: 'c'.repeat(40), settleMs: 0, sleep: async () => {}, fetchImpl});
  assert.equal(result.state, DISPATCH_PROBE_STATES.BLOCKED);
  assert.equal(result.reason, 'ACTIONS_WRITE_REQUIRED');
});

test('the probe never dispatches without a credential', async () => {
  const {calls, fetchImpl} = harness();
  const noToken = await probeDispatch({repository: 'r/r', workflowId: 1, fetchImpl});
  assert.equal(noToken.reason, 'DISPATCH_CREDENTIAL_REQUIRED');
  assert.equal(calls.length, 0, 'no request may be made without a credential');
});

test('the workflow is discovered without an operator setting, deterministically', async () => {
  const listed = {workflows: [
    {id: 22, name: 'later', path: '.github/workflows/probe.yml', created_at: '2026-02-01T00:00:00Z'},
    {id: 11, name: 'private-ci', path: '.github/workflows/private-ci.yml', created_at: '2026-01-01T00:00:00Z'},
    {id: 9, name: 'not-a-workflow', path: 'docs/notes.md', created_at: '2025-01-01T00:00:00Z'},
  ]};
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({url, method: init.method ?? 'GET'});
    if (url.includes('/actions/workflows?')) return ok(listed);
    if (url.includes('/dispatches')) return {ok: true, status: 204, json: async () => ({})};
    if (url.includes('/runs?per_page=1')) return ok({total_count: 4});
    return ok({id: 11});
  };
  const result = await probeDispatch({token: {value: 't', source: 'app'}, repository: 'r/r', sha: 'a'.repeat(40), settleMs: 0, sleep: async () => {}, fetchImpl});
  assert.equal(result.workflowDiscovered, true);
  assert.equal(result.workflowId, 11, 'the oldest workflow wins, and a non-workflow path is ignored');
  assert.equal(result.discoveredWorkflow.path, '.github/workflows/private-ci.yml');
  assert.ok(calls.some(c => c.url.includes('/workflows/11/dispatches')), 'the discovered id is what gets dispatched');
});

test('an explicit workflow file is used as given, with no lookup', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    if (url.includes('/dispatches')) return {ok: true, status: 204, json: async () => ({})};
    return ok({total_count: 1});
  };
  const result = await probeDispatch({token: {value: 't', source: 'app'}, repository: 'r/r', workflowFile: './.github/workflows/private-ci.yml', sha: 'a'.repeat(40), settleMs: 0, sleep: async () => {}, fetchImpl});
  assert.equal(result.workflowFile, '.github/workflows/private-ci.yml');
  assert.ok(calls.some(u => u.includes('/workflows/.github/workflows/private-ci.yml/dispatches')));
  assert.equal(calls.some(u => u.includes('?per_page=100')), false, 'no discovery request when the file is known');
});

test('the CLI writes the outcome and exits 78 only for a blocked capability', async () => {
  const {mkdtempSync, readFileSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-probe-'));
  const out = join(dir, 'd.json');

  const blocked = await dispatchProbeCli(['--out=' + out], {WOLF_CI_REPOSITORY: 'r/r', WOLF_CI_WORKFLOW_ID: '1', WOLF_CI_SHA: 'd'.repeat(40)}, {fetchImpl: harness().fetchImpl});
  assert.equal(blocked, DISPATCH_PROBE_EXIT.BLOCKED, 'no token means blocked, and blocked is a distinct exit code');
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).reason, 'DISPATCH_CREDENTIAL_REQUIRED');

  const green = await dispatchProbeCli(['--out=' + out], {WOLF_CI_REPOSITORY: 'r/r', WOLF_CI_WORKFLOW_ID: '1', WOLF_CI_SHA: 'd'.repeat(40), WOLF_CI_APP_DISPATCHER_TOKEN: 'x'}, {fetchImpl: harness().fetchImpl});
  assert.equal(green, DISPATCH_PROBE_EXIT.OK);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).credentialSource, 'github-app');
});

test('the token never appears in the probe output', async () => {
  const secret = 'ghs_supersecretvalue';
  const {fetchImpl} = harness();
  const result = await probeDispatch({token: {value: secret, source: 'app'}, repository: 'r/r', workflowId: 1, sha: 'e'.repeat(40), settleMs: 0, sleep: async () => {}, fetchImpl});
  assert.equal(JSON.stringify(result).includes(secret), false);
});
