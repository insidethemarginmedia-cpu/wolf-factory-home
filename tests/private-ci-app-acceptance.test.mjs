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
  const result = await checkRenewalWithClock({env, fetchImpl, now: realNow, advance: () => { mintClock = realNow + 3600_000; }});
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
