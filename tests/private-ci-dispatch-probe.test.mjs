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

test('the probe never dispatches without a credential or a workflow id', async () => {
  const {calls, fetchImpl} = harness();
  const noToken = await probeDispatch({repository: 'r/r', workflowId: 1, fetchImpl});
  assert.equal(noToken.reason, 'DISPATCH_CREDENTIAL_REQUIRED');
  const noId = await probeDispatch({token: {value: 't', source: 'app'}, repository: 'r/r', fetchImpl});
  assert.equal(noId.reason, 'WORKFLOW_ID_REQUIRED');
  assert.equal(calls.length, 0, 'no request may be made while the inputs are incomplete');
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
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).credentialSource, 'app');
});

test('the token never appears in the probe output', async () => {
  const secret = 'ghs_supersecretvalue';
  const {fetchImpl} = harness();
  const result = await probeDispatch({token: {value: secret, source: 'app'}, repository: 'r/r', workflowId: 1, sha: 'e'.repeat(40), settleMs: 0, sleep: async () => {}, fetchImpl});
  assert.equal(JSON.stringify(result).includes(secret), false);
});
