import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync} from 'node:crypto';
import {
  checkRenewalWithClock,
  inventoryEnvironment, checkExactShaRead, checkPrivateCheckPublication, checkDispatch,
  checkExpiryAndDenial, summarise, ACCEPTANCE_STATES,
} from '../scripts/private-ci-app-acceptance.mjs';

const SHA = 'a'.repeat(40);
const repo = 'donraposo1-source/project-wolf';
// A throwaway RSA key: the loader rejects anything that is not a real RSA PEM,
// which is why a placeholder string cannot stand in here.
const {privateKey: acceptanceRsa} = generateKeyPairSync('rsa', {modulusLength: 2048});
const rsaPem = acceptanceRsa.export({type: 'pkcs1', format: 'pem'});

test('the environment inventory reports presence and nothing else', () => {
  const inventory = inventoryEnvironment({WOLF_FACTORY_APP_ID: '1', WOLF_FACTORY_APP_PRIVATE_KEY: rsaPem, WOLF_FACTORY_READER_INSTALLATION_ID: '2'});
  assert.equal(inventory.appId, 'present');
  assert.equal(inventory.privateKey, 'present');
  assert.equal(inventory.installations.publisher, 'absent');
  assert.equal(inventory.fallback.pat, 'absent');
  assert.equal(JSON.stringify(inventory).includes('"k"'), false, 'no value is echoed');
  assert.equal(inventory.credentialsPrinted, false);
});

test('reading the exact SHA passes only when the returned SHA matches', async () => {
  const matching = await checkExactShaRead({token: 't', repository: repo, sha: SHA, fetchImpl: async () => ({ok: true, status: 200, json: async () => ({sha: SHA, commit: {tree: {sha: 'b'.repeat(40)}}})})});
  assert.equal(matching.state, ACCEPTANCE_STATES.PASS);
  assert.equal(matching.sourceFetched, false, 'no source is fetched');

  const wrong = await checkExactShaRead({token: 't', repository: repo, sha: SHA, fetchImpl: async () => ({ok: true, status: 200, json: async () => ({sha: 'c'.repeat(40)})})});
  assert.equal(wrong.state, ACCEPTANCE_STATES.FAIL, 'a different commit is a failure, not a pass');
  assert.equal(wrong.reason, 'SHA_MISMATCH');
});

test('a missing reader token is blocked, never treated as a pass', async () => {
  const result = await checkExactShaRead({token: undefined, repository: repo, sha: SHA});
  assert.equal(result.state, ACCEPTANCE_STATES.BLOCKED);
  assert.equal(result.reason, 'READER_TOKEN_ABSENT');
});

test('the private check is published to the exact SHA and duplicates are keyed by external_id', async () => {
  let body = null;
  const result = await checkPrivateCheckPublication({
    token: 'ghs_pub', repository: repo, sha: SHA,
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      return {ok: true, status: 201, json: async () => ({id: 99, head_sha: SHA, conclusion: 'success'})};
    },
  });
  assert.equal(result.state, ACCEPTANCE_STATES.PASS);
  assert.equal(body.head_sha, SHA);
  assert.equal(body.external_id, 'wolf-acceptance-' + SHA.slice(0, 12));
  assert.equal(result.publishedToExactSha, true);
});

test('a 403 on check publication is blocked and names the missing permission', async () => {
  const result = await checkPrivateCheckPublication({token: 't', repository: repo, sha: SHA, fetchImpl: async () => ({ok: false, status: 403, json: async () => ({})})});
  assert.equal(result.state, ACCEPTANCE_STATES.BLOCKED);
  assert.equal(result.reason, 'CHECKS_WRITE_ABSENT');
});

test('a dispatch reports whether it actually created a run', async () => {
  let runs = 4;
  const fetchImpl = async (url, init = {}) => {
    if (url.includes('/runs?per_page=1')) return {ok: true, status: 200, json: async () => ({total_count: runs})};
    if (url.endsWith('/workflows/private-ci.yml')) return {ok: true, status: 200, json: async () => ({workflow_dispatch_inputs: [{name: 'sha'}, {name: 'pr'}]})};
    if (url.includes('/dispatches')) {
      runs += 1;
      return {ok: true, status: 204, json: async () => ({})};
    }
    throw Error('unexpected ' + url);
  };
  const result = await checkDispatch({token: 't', repository: repo, workflow: 'private-ci.yml', sha: SHA, settleMs: 0, sleep: async () => {}, fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.PASS);
  assert.equal(result.runsBefore, 4);
  assert.equal(result.runsAfterFirst, 5);
  assert.equal(result.createdRun, true, 'a dispatch that creates no run must not look successful');
});

test('a refused dispatch is blocked, not a pass', async () => {
  const result = await checkDispatch({token: 't', repository: repo, workflow: 'w.yml', sha: SHA, settleMs: 0, sleep: async () => {}, fetchImpl: async url => (url.includes('/runs') ? {ok: true, status: 200, json: async () => ({total_count: 1})} : {ok: false, status: 403, json: async () => ({})})});
  assert.equal(result.state, ACCEPTANCE_STATES.BLOCKED);
  assert.equal(result.reason, 'ACTIONS_WRITE_ABSENT');
});

test('renewal requires a distinct token per role, not just a second call', async () => {
  // A faithful fixture: GitHub issues a 1-hour token, so the expiry must be
  // relative to the clock the token was minted on. Returning a fixed offset made
  // the simulated restart look like an expiry, which was the fixture's bug.
  let counter = 0;
  let mintClock = Date.now();
  const env = {
    WOLF_FACTORY_APP_ID: '1', WOLF_FACTORY_APP_PRIVATE_KEY: rsaPem, WOLF_CI_REPOSITORY: repo,
    WOLF_FACTORY_READER_INSTALLATION_ID: '2', WOLF_FACTORY_PUBLISHER_INSTALLATION_ID: '2', WOLF_FACTORY_DISPATCHER_INSTALLATION_ID: '2',
  };
  const fetchImpl = async (url, init = {}) => {
    counter += 1;
    return {ok: true, status: 201, json: async () => ({
      token: 'ghs_' + counter,
      expires_at: new Date(mintClock + 3600_000).toISOString(),
      permissions: JSON.parse(init.body).permissions,
      repositories: [{full_name: repo}],
    })};
  };
  // Drive the simulated clock forward between the two rounds, exactly as an hour
  // elapsing would.
  const realNow = Date.now();
  const result = await checkRenewalWithClock({env, fetchImpl, now: realNow, advance: () => { mintClock = realNow + 1000; }});
  assert.equal(result.state, ACCEPTANCE_STATES.PASS);
  assert.ok(result.roles.every(entry => entry.renewed), 'each role gets a distinct second token');
  assert.ok(result.roles.every(entry => entry.restartRecovered));
  assert.equal(JSON.stringify(result).includes('ghs_'), false, 'no token is echoed');
});

test('expiry and denial are proven against a real token, and a 200 on a write is a failure', async () => {
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
    // The read-only token is refused, which is the correct behaviour.
    return {ok: false, status: 403, json: async () => ({})};
  };
  const result = await checkExpiryAndDenial({env, fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.PASS);
  assert.equal(result.detail.denialRefused, true);
  assert.equal(result.detail.denialStatus, 403);
  assert.equal(result.detail.expiredStateIsExpired, true);
});

test('a permission leak is a failure, not a pass: a 200 where a 403 is required', async () => {
  const env = {WOLF_FACTORY_APP_ID: '1', WOLF_FACTORY_APP_PRIVATE_KEY: rsaPem, WOLF_CI_REPOSITORY: repo, WOLF_FACTORY_READER_INSTALLATION_ID: '2'};
  const fetchImpl = async (url, init = {}) => {
    if (url.includes('/access_tokens')) {
      return {ok: true, status: 201, json: async () => ({token: 'ghs_reader', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: JSON.parse(init.body).permissions, repositories: [{full_name: repo}]})};
    }
    // An over-privileged reader that can list workflows is exactly what must fail.
    return {ok: true, status: 200, json: async () => ({workflows: []})};
  };
  const result = await checkExpiryAndDenial({env, fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.FAIL);
  assert.equal(result.detail.denialRefused, false);
});

test('acceptance requires every check to pass; one blocked check blocks the whole run', () => {
  const partial = summarise([{state: 'PASS'}, {state: 'PASS'}, {state: 'BLOCKED'}]);
  assert.equal(partial.accepted, false);
  assert.equal(partial.state, 'BLOCKED');

  const failed = summarise([{state: 'PASS'}, {state: 'FAIL'}]);
  assert.equal(failed.state, 'REPAIR_REQUIRED');

  const all = summarise([{state: 'PASS'}, {state: 'PASS'}]);
  assert.equal(all.accepted, true);
  assert.equal(all.state, 'ACCEPTED');

  assert.equal(summarise([]).accepted, false, 'an empty run is not acceptance');
});

test('a wrong workflow name is resolved, not reported as unreadable', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    if (url.includes('/workflows?per_page=100')) {
      return {ok: true, status: 200, json: async () => ({workflows: [
        {id: 77, path: '.github/workflows/private-ci.yml', created_at: '2026-01-01T00:00:00Z'},
      ]})};
    }
    if (url.includes('/workflows/private-ci.yml/')) return {ok: false, status: 404, json: async () => ({})};
    if (url.endsWith('/workflows/77')) return {ok: true, status: 200, json: async () => ({id: 77, workflow_dispatch_inputs: [{name: 'sha'}]})};
    if (url.includes('/workflows/77/runs')) return {ok: true, status: 200, json: async () => ({total_count: 2})};
    if (url.includes('/workflows/77/dispatches')) return {ok: true, status: 204, json: async () => ({})};
    return {ok: false, status: 500, json: async () => ({})};
  };
  const result = await checkDispatch({token: 't', repository: repo, workflow: 'private-ci.yml', sha: SHA, settleMs: 0, sleep: async () => {}, fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.PASS);
  assert.equal(result.workflowResolved, true);
  assert.equal(result.workflow, '.github/workflows/private-ci.yml');
  assert.ok(calls.some(url => url.includes('/workflows?per_page=100')), 'discovery was actually performed');
});

test('when no workflow is visible, the reason says so instead of blaming permissions', async () => {
  const fetchImpl = async url => (url.includes('/workflows?per_page=100')
    ? {ok: true, status: 200, json: async () => ({workflows: []})}
    : {ok: false, status: 404, json: async () => ({})});
  const result = await checkDispatch({token: 't', repository: repo, workflow: 'nope.yml', sha: SHA, settleMs: 0, sleep: async () => {}, fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.BLOCKED);
  // An empty list is caught by the dispatchability scan, so the reason names the
  // real problem: nothing visible can be dispatched.
  assert.ok(['NO_WORKFLOW_FOUND', 'NO_DISPATCHABLE_WORKFLOW'].includes(result.reason));
  assert.equal(result.configuredWorkflow, 'nope.yml');
});


test('only declared workflow inputs are sent, and an undeclared one is never guessed at', async () => {
  const bodies = [];
  const fetchImpl = async (url, init = {}) => {
    if (url.includes('/runs?per_page=1')) return {ok: true, status: 200, json: async () => ({total_count: 1})};
    if (url.endsWith('/workflows/schema.yml')) return {ok: true, status: 200, json: async () => ({workflow_dispatch_inputs: [{name: 'sha'}]})};
    if (url.includes('/dispatches')) {
      bodies.push(JSON.parse(init.body));
      return {ok: true, status: 204, json: async () => ({})};
    }
    return {ok: false, status: 404, json: async () => ({})};
  };
  const result = await checkDispatch({token: 't', repository: repo, workflow: 'schema.yml', sha: SHA, pr: '743', settleMs: 0, sleep: async () => {}, fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.PASS);
  assert.deepEqual(Object.keys(bodies[0].inputs), ['sha'], 'pr and mode are not sent because they are not declared');
  assert.deepEqual(result.deliveredInputs, ['sha']);
  assert.deepEqual(result.declaredInputs, ['sha']);
});

test('a 422 on declared inputs is retried once with none, and the drop is reported', async () => {
  const bodies = [];
  const fetchImpl = async (url, init = {}) => {
    if (url.includes('/runs?per_page=1')) return {ok: true, status: 200, json: async () => ({total_count: 1})};
    if (url.endsWith('/workflows/strict.yml')) return {ok: true, status: 200, json: async () => ({workflow_dispatch_inputs: [{name: 'sha'}]})};
    if (url.includes('/dispatches')) {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1
        ? {ok: false, status: 422, json: async () => ({message: 'Unexpected inputs provided'})}
        : {ok: true, status: 204, json: async () => ({})};
    }
    return {ok: false, status: 404, json: async () => ({})};
  };
  const result = await checkDispatch({token: 't', repository: repo, workflow: 'strict.yml', sha: SHA, settleMs: 0, sleep: async () => {}, fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.PASS);
  assert.deepEqual(bodies[1].inputs, {}, 'the second attempt sends nothing rather than guessing again');
  assert.deepEqual(result.deliveredInputs, [], 'dropping inputs is visible, not silent');
});

test('a dispatch failure carries the API message', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/runs?per_page=1')) return {ok: true, status: 200, json: async () => ({total_count: 1})};
    if (url.endsWith('/workflows/w.yml')) return {ok: false, status: 404, json: async () => ({})};
    if (url.includes('/workflows?per_page=100')) return {ok: true, status: 200, json: async () => ({workflows: [{id: 5, path: '.github/workflows/w.yml', created_at: '2026-01-01T00:00:00Z'}]})};
    if (url.includes('/dispatches')) return {ok: false, status: 422, json: async () => ({message: 'Workflow does not have workflow_dispatch trigger'})};
    return {ok: false, status: 422, json: async () => ({message: 'no trigger'})};
  };
  const result = await checkDispatch({token: 't', repository: repo, workflow: 'w.yml', sha: SHA, settleMs: 0, sleep: async () => {}, fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.FAIL);
  assert.match(result.apiMessage, /does not have workflow_dispatch/);
});


test('a workflow without a dispatch trigger is skipped, not chosen by age', async () => {
  const fetchImpl = async url => {
    if (url.includes('/workflows/skip.yml/')) return {ok: false, status: 404, json: async () => ({})};
    if (url.includes('/workflows?per_page=100')) return {ok: true, status: 200, json: async () => ({workflows: [
      {id: 1, path: '.github/workflows/test.yml', created_at: '2025-01-01T00:00:00Z'},
      {id: 2, path: '.github/workflows/dispatchable.yml', created_at: '2026-01-01T00:00:00Z'},
    ]})};
    if (url.endsWith('/workflows/1')) return {ok: true, status: 200, json: async () => ({id: 1})}; // no inputs: not dispatchable
    if (url.endsWith('/workflows/2')) return {ok: true, status: 200, json: async () => ({id: 2, workflow_dispatch_inputs: []})};
    if (url.includes('/workflows/2/runs')) return {ok: true, status: 200, json: async () => ({total_count: 3})};
    if (url.includes('/workflows/2/dispatches')) return {ok: true, status: 204, json: async () => ({})};
    return {ok: false, status: 404, json: async () => ({})};
  };
  const result = await checkDispatch({token: 't', repository: repo, workflow: 'skip.yml', sha: SHA, settleMs: 0, sleep: async () => {}, fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.PASS);
  assert.equal(result.workflow, '.github/workflows/dispatchable.yml', 'the dispatchable workflow wins over the older one');
});

test('when nothing can be dispatched, that is the stated reason', async () => {
  const fetchImpl = async url => {
    if (url.includes('/workflows/x.yml/')) return {ok: false, status: 404, json: async () => ({})};
    if (url.includes('/workflows?per_page=100')) return {ok: true, status: 200, json: async () => ({workflows: [{id: 1, path: '.github/workflows/test.yml', created_at: '2025-01-01T00:00:00Z'}]})};
    if (url.endsWith('/workflows/1')) return {ok: true, status: 200, json: async () => ({id: 1})};
    return {ok: false, status: 404, json: async () => ({})};
  };
  const result = await checkDispatch({token: 't', repository: repo, workflow: 'x.yml', sha: SHA, settleMs: 0, sleep: async () => {}, fetchImpl});
  assert.equal(result.state, ACCEPTANCE_STATES.BLOCKED);
  assert.equal(result.reason, 'NO_DISPATCHABLE_WORKFLOW');
  assert.equal(result.examined[0].path, '.github/workflows/test.yml');
  assert.equal(result.examined[0].dispatchable, false);
});
