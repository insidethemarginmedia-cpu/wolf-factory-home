import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTH_STATES,
  describeAuthState,
  classifyRejection,
  ensureToken,
  withAuthRecovery,
  RENEWAL_MARGIN_MS,
} from '../scripts/private-ci-app-auth.mjs';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const future = ms => new Date(NOW + ms).toISOString();

test('a token is only FRESH when it is comfortably ahead of expiry', () => {
  assert.equal(describeAuthState({state: 'MINTED', expiresAt: future(60 * 60 * 1000), now: NOW}).state, AUTH_STATES.FRESH);
  assert.equal(describeAuthState({state: 'MINTED', expiresAt: future(RENEWAL_MARGIN_MS - 1), now: NOW}).state, AUTH_STATES.RENEW);
  assert.equal(describeAuthState({state: 'MINTED', expiresAt: future(-1000), now: NOW}).state, AUTH_STATES.EXPIRED);
  assert.equal(describeAuthState({state: 'MINTED', now: NOW}).state, AUTH_STATES.EXPIRED, 'an unknown expiry is never treated as fresh');
  assert.equal(describeAuthState({state: 'MINTED', expiresAt: 'not-a-date', now: NOW}).state, AUTH_STATES.EXPIRED);
  assert.equal(describeAuthState({state: 'FALLBACK', now: NOW}).state, AUTH_STATES.FALLBACK);
});

test('a re-mint happens only when the state demands it', async () => {
  let calls = 0;
  const mint = async () => {
    calls += 1;
    return {state: 'MINTED', token: `ghs_${calls}`, expiresAt: future(60 * 60 * 1000)};
  };
  const fresh = await ensureToken({role: 'reader', mint, now: NOW});
  assert.equal(calls, 1, 'a healthy token is not re-minted');
  assert.equal(fresh.auth.state, AUTH_STATES.FRESH);
  assert.equal(fresh.recovered, false);

  const nearExpiry = await ensureToken({
    role: 'reader',
    mint: async () => ({state: 'MINTED', token: 'ghs_near', expiresAt: future(60 * 1000)}),
    renew: mint,
    now: NOW,
  });
  assert.equal(nearExpiry.attempts.length, 2, 'a token inside the margin is replaced once');
  assert.equal(nearExpiry.auth.state, AUTH_STATES.FRESH);
  assert.equal(nearExpiry.recovered, true);
});

test('a token that stays near expiry after renewal is reported expired, never recovered', async () => {
  const result = await ensureToken({
    role: 'publisher',
    mint: async () => ({state: 'MINTED', token: 'ghs_a', expiresAt: future(60 * 1000)}),
    renew: async () => ({state: 'MINTED', token: 'ghs_b', expiresAt: future(60 * 1000)}),
    now: NOW,
  });
  assert.equal(result.recovered, false);
  assert.equal(result.auth.state, AUTH_STATES.EXPIRED);
  assert.equal(result.auth.reason, 'APP_RENEWAL_DID_NOT_REFRESH');
});

test('a revoked installation token is re-minted exactly once', async () => {
  let ensureCalls = 0;
  let callCalls = 0;
  const outcome = await withAuthRecovery({
    ensure: async () => {
      ensureCalls += 1;
      return {result: {state: 'MINTED', token: `ghs_${ensureCalls}`}, auth: {state: AUTH_STATES.FRESH}};
    },
    call: async token => {
      callCalls += 1;
      // The first credential is revoked mid-run; the replacement works.
      return token === 'ghs_1' ? {httpStatus: 401} : {httpStatus: 201, state: 'CREATED'};
    },
  });
  assert.equal(outcome.recovered, true);
  assert.equal(outcome.result.httpStatus, 201);
  assert.equal(ensureCalls, 2);
  assert.equal(callCalls, 2);
});

test('a revocation that cannot be reissued fails honestly instead of retrying forever', async () => {
  let ensureCalls = 0;
  const outcome = await withAuthRecovery({
    ensure: async () => {
      ensureCalls += 1;
      return {result: {state: 'MINTED', token: 'ghs_same'}, auth: {state: AUTH_STATES.FRESH}};
    },
    call: async () => ({httpStatus: 401}),
  });
  assert.equal(outcome.state, AUTH_STATES.REVOKED);
  assert.equal(outcome.reason, 'REVOKED_AND_NOT_REISSUABLE');
  assert.equal(ensureCalls, 2, 'bounded: one recovery attempt, then stop');
});

test('rejection classes are distinguished, because they need different responses', () => {
  assert.deepEqual(classifyRejection(401), {state: AUTH_STATES.REVOKED, retryable: false, mustRemint: true, reason: 'TOKEN_REVOKED_OR_REJECTED'});
  assert.equal(classifyRejection(403).mustRemint, false, 'a permission problem is not fixed by a new token');
  assert.equal(classifyRejection(403).retryable, false);
  assert.equal(classifyRejection(502).retryable, true, 'a 5xx is transient and is not a credential problem');
  assert.equal(classifyRejection(502).mustRemint, false);
});

test('no token is used when minting yields nothing usable', async () => {
  let called = false;
  const outcome = await withAuthRecovery({
    ensure: async () => ({result: {state: 'BLOCKED'}, auth: {state: AUTH_STATES.NONE, reason: 'APP_INSTALLATION_NOT_FOUND'}}),
    call: async () => {
      called = true;
      return {httpStatus: 200};
    },
  });
  assert.equal(called, false, 'a blocked credential must not be sent anywhere');
  assert.equal(outcome.state, AUTH_STATES.NONE);
  assert.equal(outcome.reason, 'APP_INSTALLATION_NOT_FOUND');
});

test('verify refuses to report VERIFIED while falling back to the PAT', async () => {
  const {runAppAuthCli, APP_AUTH_EXIT} = await import('../scripts/private-ci-app-auth-cli.mjs');
  const lines = [];
  // The exact shape that used to produce a false green: no App secrets, a PAT
  // present, so every role falls back.
  const code = await runAppAuthCli(['verify'], {
    env: {WOLF_FACTORY_REPO_TOKEN: 'ghp_reader', WOLF_CI_REPOSITORY: 'donraposo1-source/project-wolf'},
    stdout: text => lines.push(text),
  });
  const report = JSON.parse(lines.join(''));
  assert.equal(report.state, 'NOT_APPLICABLE', 'a fallback is not verification');
  assert.equal(report.reason, 'APP_AUTH_INCOMPLETE');
  assert.notEqual(code, APP_AUTH_EXIT.OK);
  // Publisher has no credential at all, which is reported as `none`, not hidden
  // behind the reader's PAT: the roles stay genuinely separate.
  const sources = Object.fromEntries(report.renewal.map(entry => [entry.role, entry.source]));
  assert.deepEqual(sources, {reader: 'pat-fallback', publisher: 'none', dispatcher: 'pat-fallback'});
  assert.ok(report.renewal.every(entry => entry.renews === false && entry.restartRecovered === false));
});

test('renewal is proven by token identity when the expiry is truncated to the second', async () => {
  const {runAppAuthCli} = await import('../scripts/private-ci-app-auth-cli.mjs');
  const {generateKeyPairSync} = await import('node:crypto');
  const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const rsaPem = privateKey.export({type: 'pkcs1', format: 'pem'});
  const repository = 'donraposo1-source/project-wolf';
  // GitHub returns the same second-granularity expiry for two mints inside one
  // second. The tokens still differ, and that is what must carry the proof.
  const sameExpiry = new Date(Date.now() + 3600_000).toISOString();
  let counter = 0;
  const fetchImpl = async (url, init = {}) => {
    counter += 1;
    return {ok: true, status: 201, json: async () => ({
      token: 'ghs_' + counter + '_' + 'z'.repeat(20),
      expires_at: sameExpiry,
      permissions: JSON.parse(init.body).permissions,
      repositories: [{full_name: repository}],
    })};
  };
  const lines = [];
  const code = await runAppAuthCli(['verify'], {
    env: {
      WOLF_FACTORY_APP_ID: '5913418', WOLF_FACTORY_APP_PRIVATE_KEY: rsaPem,
      WOLF_FACTORY_READER_INSTALLATION_ID: '1', WOLF_FACTORY_PUBLISHER_INSTALLATION_ID: '1',
      WOLF_FACTORY_DISPATCHER_INSTALLATION_ID: '1', WOLF_CI_REPOSITORY: repository,
    },
    fetchImpl,
    stdout: text => lines.push(text),
  });
  const report = JSON.parse(lines.join(''));
  assert.equal(report.state, 'VERIFIED', 'a fast runner must not look like a failed renewal');
  assert.ok(report.renewal.every(entry => entry.renews));
  assert.ok(report.renewal.every(entry => entry.distinctExpiry === false), 'the fixture really did reuse the expiry');
  assert.equal(code, 0);
});
