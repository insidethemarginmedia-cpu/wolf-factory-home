import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync} from 'node:crypto';
import {
  checkRenewalWithClock,
  inventoryEnvironment,
  checkExactShaRead,
  checkPrivateCheckPublication,
  checkDispatch,
  checkExpiryAndDenial,
  parseInputNames,
  summarise,
  ACCEPTANCE_STATES,
  DEFAULT_DISPATCH_SETTLE_MS,
  DEFAULT_DISPATCH_POLL_INTERVAL_MS,
  auditCredentialExposure,
} from '../scripts/private-ci-app-acceptance.mjs';

const SHA = 'a'.repeat(40);
const RUN_SHA = 'b'.repeat(40);
const repo = 'donraposo1-source/project-wolf';
const workflowPath = '.github/workflows/private-ci.yml';
const workflowId = 77;
const runId = 101;
const {privateKey: acceptanceRsa} = generateKeyPairSync('rsa', {modulusLength: 2048});
const rsaPem = acceptanceRsa.export({type: 'pkcs1', format: 'pem'});

function workflowContents({inputs = ['sha', 'pr'], dispatch = true} = {}) {
  const lines = ['name: Private CI', 'on:'];
  if (dispatch) lines.push('  workflow_dispatch:');
  if (dispatch && inputs.length) {
    lines.push('    inputs:');
    for (const name of inputs) lines.push(`      ${name}:`, '        required: false');
  }
  lines.push('jobs:', '  verify:', '    steps:', '      - run: echo verified');
  return {
    ok: true,
    status: 200,
    json: async () => ({encoding: 'base64', content: Buffer.from(lines.join('\n')).toString('base64')}),
  };
}

function completedRun(overrides = {}) {
  return {
    id: runId,
    workflow_id: workflowId,
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_sha: RUN_SHA,
    created_at: new Date().toISOString(),
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  };
}

function correlatedCheck(overrides = {}) {
  return {
    id: 9001,
    external_id: String(runId),
    name: 'wolf-private-ci-743',
    head_sha: SHA,
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  };
}

function dispatchFixture({
  workflowStatus = 200,
  contentOptions = {},
  preRuns = [],
  postRuns = [],
  runDetails = null,
  checkRuns = [],
  dispatchStatus = 204,
} = {}) {
  const calls = [];
  let runListCalls = 0;
  let checkListCalls = 0;
  let dispatchCalls = 0;
  const detailsById = new Map((postRuns.length ? postRuns : runDetails ? [runDetails] : []).map(run => [Number(run.id), run]));
  if (runDetails) detailsById.set(Number(runDetails.id), runDetails);
  const fetchImpl = async (url, init = {}) => {
    calls.push({url, init});
    if (url.endsWith(`/actions/workflows/${workflowPath.split('/').at(-1)}`)) {
      return {ok: workflowStatus === 200, status: workflowStatus, json: async () => workflowStatus === 200 ? {id: workflowId, path: workflowPath, state: 'active'} : {}};
    }
    if (url.includes(`/contents/${workflowPath}`)) return workflowContents(contentOptions);
    if (url.includes(`/actions/workflows/${workflowId}/runs?per_page=100`)) {
      runListCalls += 1;
      const rows = runListCalls === 1 ? preRuns : postRuns;
      return {ok: true, status: 200, json: async () => ({total_count: rows.length, workflow_runs: rows})};
    }
    if (url.includes(`/actions/runs/${runId}`)) {
      const run = detailsById.get(runId);
      return {ok: Boolean(run), status: run ? 200 : 404, json: async () => run ?? {}};
    }
    if (url.includes(`/commits/${SHA}/check-runs`)) {
      checkListCalls += 1;
      const currentChecks = typeof checkRuns === 'function' ? checkRuns(checkListCalls) : checkRuns;
      return {ok: true, status: 200, json: async () => ({check_runs: currentChecks})};
    }
    if (url.endsWith('/dispatches')) {
      dispatchCalls += 1;
      return {ok: dispatchStatus === 204, status: dispatchStatus, json: async () => ({message: dispatchStatus === 204 ? '' : 'synthetic dispatch failure'})};
    }
    return {ok: false, status: 404, json: async () => ({})};
  };
  return {calls, fetchImpl, counts: () => ({dispatchCalls, runListCalls})};
}

test('environment inventory reports presence only', () => {
  const inventory = inventoryEnvironment({WOLF_FACTORY_APP_ID: '1', WOLF_FACTORY_APP_PRIVATE_KEY: rsaPem, WOLF_FACTORY_READER_INSTALLATION_ID: '2'});
  assert.equal(inventory.appId, 'present');
  assert.equal(inventory.privateKey, 'present');
  assert.equal(inventory.installations.publisher, 'absent');
  assert.equal(inventory.fallback.pat, 'absent');
  assert.equal(JSON.stringify(inventory).includes(rsaPem), false);
  assert.equal(inventory.credentialsPrinted, false);
});

test('exact-SHA read passes only for the exact returned commit and tree metadata', async () => {
  const matching = await checkExactShaRead({token: 'reader', repository: repo, sha: SHA, fetchImpl: async () => ({ok: true, status: 200, json: async () => ({sha: SHA, commit: {tree: {sha: 'c'.repeat(40)}}})})});
  assert.equal(matching.state, ACCEPTANCE_STATES.PASS);
  assert.equal(matching.sourceFetched, false);

  const wrong = await checkExactShaRead({token: 'reader', repository: repo, sha: SHA, fetchImpl: async () => ({ok: true, status: 200, json: async () => ({sha: RUN_SHA})})});
  assert.equal(wrong.state, ACCEPTANCE_STATES.FAIL);
  assert.equal(wrong.reason, 'SHA_MISMATCH');
});

test('a missing reader token is blocked, never treated as a pass', async () => {
  const result = await checkExactShaRead({token: undefined, repository: repo, sha: SHA});
  assert.equal(result.state, ACCEPTANCE_STATES.BLOCKED);
  assert.equal(result.reason, 'READER_TOKEN_ABSENT');
});

test('check publication passes only for a completed success on the exact SHA', async () => {
  let body = null;
  const result = await checkPrivateCheckPublication({
    token: 'publisher', repository: repo, sha: SHA,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return {ok: true, status: 201, json: async () => ({id: 99, head_sha: SHA, status: 'completed', conclusion: 'success'})};
    },
  });
  assert.equal(result.state, ACCEPTANCE_STATES.PASS);
  assert.equal(body.head_sha, SHA);
  assert.equal(body.external_id, 'wolf-acceptance-' + SHA.slice(0, 12));
  assert.equal(result.publishedToExactSha, true);

  const wrongSha = await checkPrivateCheckPublication({token: 'publisher', repository: repo, sha: SHA, fetchImpl: async () => ({ok: true, status: 201, json: async () => ({id: 100, head_sha: RUN_SHA, status: 'completed', conclusion: 'success'})})});
  assert.equal(wrongSha.state, ACCEPTANCE_STATES.FAIL);
  assert.equal(wrongSha.reason, 'CHECK_SHA_MISMATCH');
  const incomplete = await checkPrivateCheckPublication({token: 'publisher', repository: repo, sha: SHA, fetchImpl: async () => ({ok: true, status: 201, json: async () => ({id: 101, head_sha: SHA, status: 'in_progress', conclusion: null})})});
  assert.equal(incomplete.state, ACCEPTANCE_STATES.FAIL);
  assert.equal(incomplete.reason, 'CHECK_NOT_SUCCESSFULLY_COMPLETED');
});

test('a 403 on check publication is blocked and names the missing permission', async () => {
  const result = await checkPrivateCheckPublication({token: 'publisher', repository: repo, sha: SHA, fetchImpl: async () => ({ok: false, status: 403, json: async () => ({})})});
  assert.equal(result.state, ACCEPTANCE_STATES.BLOCKED);
  assert.equal(result.reason, 'CHECKS_WRITE_ABSENT');
});

test('HTTP 204 without a newly created correlated run is blocked, not accepted', async () => {
  const mock = dispatchFixture();
  const result = await checkDispatch({token: 'dispatcher', readToken: 'reader', checkToken: 'publisher', repository: repo, workflow: 'private-ci.yml', sha: SHA, pr: '743', settleMs: 0, sleep: async () => {}, fetchImpl: mock.fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.BLOCKED);
  assert.equal(result.reason, 'DISPATCH_ACK_WITHOUT_CORRELATED_RUN');
  assert.equal(mock.counts().dispatchCalls, 1, 'one acceptance call sends exactly one dispatch');
});

test('a configured-workflow 404 never falls back to an unrelated workflow', async () => {
  const mock = dispatchFixture({workflowStatus: 404});
  const result = await checkDispatch({token: 'dispatcher', readToken: 'reader', checkToken: 'publisher', repository: repo, workflow: 'private-ci.yml', sha: SHA, settleMs: 0, fetchImpl: mock.fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.BLOCKED);
  assert.equal(result.reason, 'CONFIGURED_WORKFLOW_NOT_FOUND');
  assert.equal(mock.calls.some(call => call.url.includes('/workflows?')), false);
  assert.equal(mock.counts().dispatchCalls, 0);
});

test('a non-dispatchable workflow is blocked before any dispatch', async () => {
  const mock = dispatchFixture({contentOptions: {dispatch: false}});
  const result = await checkDispatch({token: 'dispatcher', readToken: 'reader', checkToken: 'publisher', repository: repo, workflow: 'private-ci.yml', sha: SHA, settleMs: 0, fetchImpl: mock.fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.BLOCKED);
  assert.equal(result.reason, 'CONFIGURED_WORKFLOW_NOT_DISPATCHABLE');
  assert.equal(mock.counts().dispatchCalls, 0);
});

test('workflow dispatch must declare the SHA input; the bridge never drops it to retry', async () => {
  const mock = dispatchFixture({contentOptions: {inputs: ['pr']}});
  const result = await checkDispatch({token: 'dispatcher', readToken: 'reader', checkToken: 'publisher', repository: repo, workflow: 'private-ci.yml', sha: SHA, pr: '743', settleMs: 0, fetchImpl: mock.fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.BLOCKED);
  assert.equal(result.reason, 'WORKFLOW_SHA_INPUT_NOT_DECLARED');
  assert.equal(mock.counts().dispatchCalls, 0);
});

test('dispatch PASS requires a new completed run and its exact-SHA correlated check', async () => {
  const run = completedRun();
  const mock = dispatchFixture({postRuns: [run], runDetails: run, checkRuns: [correlatedCheck()]});
  const result = await checkDispatch({token: 'dispatcher', readToken: 'reader', checkToken: 'publisher', repository: repo, workflow: 'private-ci.yml', sha: SHA, pr: '743', settleMs: 0, sleep: async () => {}, fetchImpl: mock.fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.PASS);
  assert.equal(result.runId, runId);
  assert.equal(result.runSha, RUN_SHA, 'workflow host SHA is distinct from the exact target SHA input');
  assert.equal(result.targetSha, SHA);
  assert.equal(result.targetCheckRunId, 9001);
  assert.equal(result.targetCheckExternalId, String(runId));
  assert.deepEqual(result.deliveredInputs, ['sha', 'pr']);
  const dispatchCall = mock.calls.find(call => call.url.endsWith('/dispatches'));
  assert.deepEqual(JSON.parse(dispatchCall.init.body).inputs, {sha: SHA, pr: '743'});
  assert.ok(mock.calls.filter(call => call.url.includes(`/contents/${workflowPath}`)).every(call => call.init.headers.authorization === 'Bearer reader'));
  assert.ok(mock.calls.filter(call => call.url.endsWith('/dispatches')).every(call => call.init.headers.authorization === 'Bearer dispatcher'));
  assert.ok(mock.calls.filter(call => call.url.includes(`/commits/${SHA}/check-runs`)).every(call => call.init.headers.authorization === 'Bearer publisher'));
});

test('dispatch waits for eventual visibility of the completed correlated target check', async () => {
  const run = completedRun();
  const mock = dispatchFixture({
    postRuns: [run],
    runDetails: run,
    checkRuns: call => call < 2 ? [] : [correlatedCheck()],
  });
  const result = await checkDispatch({token: 'dispatcher', readToken: 'reader', checkToken: 'publisher', repository: repo, workflow: 'private-ci.yml', sha: SHA, pr: '743', settleMs: 1000, pollIntervalMs: 1, sleep: async () => {}, fetchImpl: mock.fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.PASS);
  assert.equal(result.targetCheckRunId, 9001);
  assert.equal(mock.calls.filter(call => call.url.includes(`/commits/${SHA}/check-runs`)).length, 2);
});

test('a successful new workflow run without its exact target check remains blocked', async () => {
  const run = completedRun();
  const mock = dispatchFixture({postRuns: [run], runDetails: run, checkRuns: []});
  const result = await checkDispatch({token: 'dispatcher', readToken: 'reader', checkToken: 'publisher', repository: repo, workflow: 'private-ci.yml', sha: SHA, pr: '743', settleMs: 0, sleep: async () => {}, fetchImpl: mock.fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.BLOCKED);
  assert.equal(result.reason, 'TARGET_CHECK_RUN_NOT_CORRELATED');
});

test('a target check with another run id cannot be mistaken for the dispatched run', async () => {
  const run = completedRun();
  const mock = dispatchFixture({postRuns: [run], runDetails: run, checkRuns: [correlatedCheck({external_id: '999'})]});
  const result = await checkDispatch({token: 'dispatcher', readToken: 'reader', checkToken: 'publisher', repository: repo, workflow: 'private-ci.yml', sha: SHA, pr: '743', settleMs: 0, sleep: async () => {}, fetchImpl: mock.fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.BLOCKED);
  assert.equal(result.reason, 'TARGET_CHECK_RUN_NOT_CORRELATED');
});

test('an old or wrong-branch run is not correlated to a fresh dispatch', async () => {
  const oldRun = completedRun({created_at: '2020-01-01T00:00:00.000Z'});
  const wrongBranch = completedRun({id: 102, head_branch: 'other'});
  const mock = dispatchFixture({postRuns: [oldRun, wrongBranch], runDetails: wrongBranch, checkRuns: []});
  const result = await checkDispatch({token: 'dispatcher', readToken: 'reader', checkToken: 'publisher', repository: repo, workflow: 'private-ci.yml', sha: SHA, pr: '743', settleMs: 0, sleep: async () => {}, fetchImpl: mock.fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.BLOCKED);
  assert.equal(result.reason, 'DISPATCH_ACK_WITHOUT_CORRELATED_RUN');
});

test('a correlated run must complete successfully', async () => {
  const failed = completedRun({conclusion: 'failure'});
  const mock = dispatchFixture({postRuns: [failed], runDetails: failed, checkRuns: []});
  const result = await checkDispatch({token: 'dispatcher', readToken: 'reader', checkToken: 'publisher', repository: repo, workflow: 'private-ci.yml', sha: SHA, pr: '743', settleMs: 0, sleep: async () => {}, fetchImpl: mock.fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.FAIL);
  assert.equal(result.reason, 'DISPATCH_RUN_NOT_SUCCESSFUL');
});

test('a 403 dispatch response is blocked and is not retried with a weaker input set', async () => {
  const mock = dispatchFixture({dispatchStatus: 403});
  const result = await checkDispatch({token: 'dispatcher', readToken: 'reader', checkToken: 'publisher', repository: repo, workflow: 'private-ci.yml', sha: SHA, pr: '743', settleMs: 0, fetchImpl: mock.fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.BLOCKED);
  assert.equal(result.reason, 'ACTIONS_WRITE_ABSENT');
  assert.equal(mock.counts().dispatchCalls, 1);
});

test('a dispatch HTTP failure preserves its API message and never retries without inputs', async () => {
  const mock = dispatchFixture({dispatchStatus: 422});
  const result = await checkDispatch({token: 'dispatcher', readToken: 'reader', checkToken: 'publisher', repository: repo, workflow: 'private-ci.yml', sha: SHA, pr: '743', settleMs: 0, fetchImpl: mock.fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.FAIL);
  assert.equal(result.reason, 'DISPATCH_FAILED');
  assert.equal(result.apiMessage, 'synthetic dispatch failure');
  assert.equal(mock.counts().dispatchCalls, 1);
});

test('dispatch settlement is long enough to observe a completed run without excessive polling', () => {
  assert.equal(DEFAULT_DISPATCH_SETTLE_MS, 15 * 60 * 1000);
  assert.equal(DEFAULT_DISPATCH_POLL_INTERVAL_MS, 5 * 1000);
});

test('the input parser excludes the inputs mapping key and nested metadata', () => {
  const block = '    inputs:\n      sha:\n        required: false\n      pr:\n        required: false\n';
  assert.deepEqual(parseInputNames(block), ['sha', 'pr']);
  assert.deepEqual(parseInputNames('    description: no inputs here'), []);
});

test('renewal requires a distinct token per role and restart recovery', async () => {
  let counter = 0;
  let mintClock = Date.now();
  const env = {
    WOLF_FACTORY_APP_ID: '1', WOLF_FACTORY_APP_PRIVATE_KEY: rsaPem, WOLF_CI_REPOSITORY: repo,
    WOLF_FACTORY_READER_INSTALLATION_ID: '2', WOLF_FACTORY_PUBLISHER_INSTALLATION_ID: '2', WOLF_FACTORY_DISPATCHER_INSTALLATION_ID: '2',
  };
  const fetchImpl = async (_url, init = {}) => {
    counter += 1;
    return {ok: true, status: 201, json: async () => ({
      token: 'ghs_' + counter,
      expires_at: new Date(mintClock + 3600_000).toISOString(),
      permissions: JSON.parse(init.body).permissions,
      repositories: [{full_name: repo}],
    })};
  };
  const realNow = Date.now();
  const result = await checkRenewalWithClock({env, fetchImpl, now: realNow, advance: () => { mintClock = realNow + 1000; }});
  assert.equal(result.state, ACCEPTANCE_STATES.PASS);
  assert.ok(result.roles.every(entry => entry.renewed));
  assert.ok(result.roles.every(entry => entry.restartRecovered));
  assert.equal(JSON.stringify(result).includes('ghs_'), false);
});

test('expiry and permission denial are proven against a real token response', async () => {
  const env = {WOLF_FACTORY_APP_ID: '1', WOLF_FACTORY_APP_PRIVATE_KEY: rsaPem, WOLF_CI_REPOSITORY: repo, WOLF_FACTORY_READER_INSTALLATION_ID: '2'};
  const fetchImpl = async (url, init = {}) => {
    if (url.includes('/access_tokens')) {
      return {ok: true, status: 201, json: async () => ({
        token: 'ghs_reader',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        permissions: JSON.parse(init.body).permissions,
        repositories: [{full_name: repo}],
      })};
    }
    return {ok: false, status: 403, json: async () => ({})};
  };
  const result = await checkExpiryAndDenial({env, fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.PASS);
  assert.equal(result.detail.denialRefused, true);
  assert.equal(result.detail.denialStatus, 403);
  assert.equal(result.detail.expiredStateIsExpired, true);
});

test('an over-privileged reader that can enumerate workflows fails the denial control', async () => {
  const env = {WOLF_FACTORY_APP_ID: '1', WOLF_FACTORY_APP_PRIVATE_KEY: rsaPem, WOLF_CI_REPOSITORY: repo, WOLF_FACTORY_READER_INSTALLATION_ID: '2'};
  const fetchImpl = async (url, init = {}) => {
    if (url.includes('/access_tokens')) {
      return {ok: true, status: 201, json: async () => ({
        token: 'ghs_reader',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        permissions: JSON.parse(init.body).permissions,
        repositories: [{full_name: repo}],
      })};
    }
    return {ok: true, status: 200, json: async () => ({workflows: []})};
  };
  const result = await checkExpiryAndDenial({env, fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.FAIL);
  assert.equal(result.detail.denialRefused, false);
  assert.equal(result.detail.denialStatus, 200);
});

test('credential exposure audit detects credentials in the target step and token export', () => {
  const unsafe = [
    'jobs:', '  execute:', '    steps:',
    '      - name: Authenticate', '        run: |',
    '          cat "$WOLF_CI_TOKEN_FILE" >> "$GITHUB_ENV"',
    '      - name: Execute private commands', '        run: node scripts/private-ci-execute.mjs',
    '        env:', '          WOLF_CI_APP_READER_TOKEN: ${{ secrets.READER_TOKEN }}',
  ].join('\n');
  assert.equal(auditCredentialExposure(unsafe).state, 'EXPOSURE_RISK');
  assert.ok(auditCredentialExposure(unsafe).findings.some(finding => finding.vector === 'credential-to-job-environment'));
});

test('acceptance requires every check to pass; blocked and empty runs are never accepted', () => {
  assert.equal(summarise([{state: 'PASS'}, {state: 'PASS'}, {state: 'BLOCKED'}]).state, 'BLOCKED');
  assert.equal(summarise([{state: 'PASS'}, {state: 'FAIL'}]).state, 'REPAIR_REQUIRED');
  assert.equal(summarise([{state: 'PASS'}, {state: 'PASS'}]).accepted, true);
  assert.equal(summarise([]).accepted, false);
});
