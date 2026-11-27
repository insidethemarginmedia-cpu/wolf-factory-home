import assert from 'node:assert/strict';
import test from 'node:test';
import {probeDispatch, resolveWorkflow, DISPATCH_PROBE_STATES, DISPATCH_PROBE_EXIT, dispatchProbeCli} from '../scripts/private-ci-dispatch-probe.mjs';

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

test('a live dispatch probe is blocked even when a credential is supplied', async () => {
  const {calls, fetchImpl} = harness({before: 7, after: 7});
  const result = await probeDispatch({token: {value: 't', source: 'app'}, repository: 'donraposo1-source/project-wolf', workflowId: 42, sha: 'a'.repeat(40), fetchImpl});
  assert.equal(result.state, DISPATCH_PROBE_STATES.BLOCKED);
  assert.equal(result.reason, 'DISPATCH_PROBE_WITHHELD');
  assert.equal(result.dispatchAttempted, false);
  assert.equal(calls.length, 0, 'a diagnostic must not create an Actions run');
});

test('the withheld probe never reports an unobserved run count', async () => {
  const {calls, fetchImpl} = harness({before: 7, after: 8});
  const result = await probeDispatch({token: {value: 't', source: 'pat'}, repository: 'r/r', workflowId: 1, sha: 'b'.repeat(40), fetchImpl});
  assert.equal(result.state, DISPATCH_PROBE_STATES.BLOCKED);
  assert.equal(result.reason, 'DISPATCH_PROBE_WITHHELD');
  assert.equal(result.runsBefore, undefined);
  assert.equal(result.runsAfter, undefined);
  assert.equal(calls.length, 0);
});

test('the probe refuses before any credential-dependent request', async () => {
  const {calls, fetchImpl} = harness({dispatchStatus: 403});
  const noToken = await probeDispatch({repository: 'r/r', workflowId: 1, fetchImpl});
  assert.equal(noToken.state, DISPATCH_PROBE_STATES.BLOCKED);
  assert.equal(noToken.reason, 'DISPATCH_PROBE_WITHHELD');
  assert.equal(noToken.dispatchAttempted, false);
  assert.equal(calls.length, 0, 'no endpoint is called by a withheld probe');
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
  const result = await resolveWorkflow({token: 't', repository: 'r/r', fetchImpl});
  assert.equal(result.discovered, true);
  assert.equal(result.workflowId, 11, 'the oldest workflow wins, and a non-workflow path is ignored');
  assert.equal(result.discoveredPath, '.github/workflows/private-ci.yml');
  assert.equal(calls.length, 1, 'workflow discovery is a read-only request');
  assert.equal(calls[0].method, 'GET');
});

test('an explicit workflow file is used as given, with no lookup', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    if (url.includes('/dispatches')) return {ok: true, status: 204, json: async () => ({})};
    return ok({total_count: 1});
  };
  const result = await resolveWorkflow({token: 't', repository: 'r/r', workflowFile: './.github/workflows/private-ci.yml', fetchImpl});
  assert.equal(result.workflowFile, '.github/workflows/private-ci.yml');
  assert.equal(calls.length, 0, 'an explicit workflow path needs no request and causes no dispatch');
});

test('the CLI writes a fail-closed receipt and never reads or uses a dispatcher credential', async () => {
  const {mkdtempSync, readFileSync, statSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-probe-'));
  const out = join(dir, 'd.json');
  const output = [];

  const blocked = await dispatchProbeCli(['--out=' + out], {
    WOLF_CI_REPOSITORY: 'r/r', WOLF_CI_WORKFLOW_ID: '1', WOLF_CI_SHA: 'd'.repeat(40),
  }, {fetchImpl: harness().fetchImpl, write: text => output.push(text)});
  assert.equal(blocked, DISPATCH_PROBE_EXIT.BLOCKED);
  const first = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(first.reason, 'DISPATCH_PROBE_WITHHELD');
  assert.equal(first.dispatchAttempted, false);
  assert.equal(statSync(out).mode & 0o077, 0, 'the local diagnostic file is owner-only');

  const withToken = await dispatchProbeCli(['--out=' + out], {
    WOLF_CI_REPOSITORY: 'r/r', WOLF_CI_WORKFLOW_ID: '1', WOLF_CI_SHA: 'd'.repeat(40), WOLF_CI_APP_DISPATCHER_TOKEN: 'x',
  }, {fetchImpl: harness().fetchImpl, write: text => output.push(text)});
  assert.equal(withToken, DISPATCH_PROBE_EXIT.BLOCKED);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).reason, 'DISPATCH_PROBE_WITHHELD');
  assert.equal(output.join('').includes('github-app'), false);
});

test('the token never appears in the probe output', async () => {
  const secret = 'ghs_supersecretvalue';
  const {fetchImpl} = harness();
  const result = await probeDispatch({token: {value: secret, source: 'app'}, repository: 'r/r', workflowId: 1, sha: 'e'.repeat(40), settleMs: 0, sleep: async () => {}, fetchImpl});
  assert.equal(JSON.stringify(result).includes(secret), false);
});
