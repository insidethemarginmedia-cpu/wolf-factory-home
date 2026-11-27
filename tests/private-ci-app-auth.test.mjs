import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {
  APP_ROLES,
  ROLE_PERMISSIONS,
  assertLeastPrivilege,
  buildAppJwt,
  inventoryAppSecrets,
  loadPrivateKey,
  mintInstallationToken,
  needsRenewal,
  normalizeRole,
  selectCredential,
} from '../scripts/private-ci-app-auth.mjs';
import {appendRecord, buildHeadAnchor, verifyLedger} from '../scripts/private-ci-retirement-integrity.mjs';

const {privateKey: rsaPrivate} = generateKeyPairSync('rsa', {modulusLength: 2048});
const rsaPem = rsaPrivate.export({type: 'pkcs1', format: 'pem'});
const {privateKey: ecPrivate} = generateKeyPairSync('ec', {namedCurve: 'P-256'});
const ecPem = ecPrivate.export({type: 'pkcs8', format: 'pem'});

const repository = 'donraposo1-source/project-wolf';

function decodeJwt(token) {
  const [header, payload] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString()),
  };
}

test('roles map to the minimum permission set and cannot be widened', () => {
  assert.deepEqual([...APP_ROLES], ['reader', 'publisher', 'dispatcher']);
  assert.deepEqual(ROLE_PERMISSIONS.reader, {contents: 'read', metadata: 'read', pull_requests: 'read'});
  assert.deepEqual(ROLE_PERMISSIONS.publisher, {checks: 'write', metadata: 'read'});
  assert.deepEqual(ROLE_PERMISSIONS.dispatcher, {actions: 'write', metadata: 'read'});

  // A reader must never be able to ask for write.
  assert.throws(() => assertLeastPrivilege('reader', {contents: 'write'}), /APP_PERMISSION_TOO_BROAD:contents/);
  // Publisher must not smuggle in contents or actions.
  assert.throws(() => assertLeastPrivilege('publisher', {contents: 'read'}), /APP_PERMISSION_NOT_ALLOWED:contents/);
  assert.throws(() => assertLeastPrivilege('dispatcher', {checks: 'write'}), /APP_PERMISSION_NOT_ALLOWED:checks/);
  assert.throws(() => assertLeastPrivilege('owner'), /APP_ROLE_DENIED/);
  assert.deepEqual(assertLeastPrivilege('publisher'), {checks: 'write', metadata: 'read'});
});

test('a JWT is RS256-signed with a short, non-expired lifetime', () => {
  const now = Date.UTC(2026, 10, 24, 12, 0, 0);
  const {token, issuedAt, expiresAt} = buildAppJwt({appId: '4187077', privateKey: rsaPem, now});
  const {header, payload} = decodeJwt(token);
  assert.equal(header.alg, 'RS256');
  assert.equal(payload.iss, '4187077');
  assert.equal(payload.iat, Math.floor(now / 1000) - 60, 'backdated for clock skew');
  assert.ok(expiresAt - issuedAt <= 660, 'lifetime stays inside GitHub limits');
  assert.ok(expiresAt - Math.floor(now / 1000) <= 600, 'exp never exceeds ten minutes');
});

test('the JWT lifetime is clamped regardless of what is requested', () => {
  const now = Date.UTC(2026, 10, 24, 12, 0, 0);
  const long = buildAppJwt({appId: '1', privateKey: rsaPem, now, ttlSeconds: 99999});
  assert.ok(long.expiresAt - Math.floor(now / 1000) <= 600);
  const short = buildAppJwt({appId: '1', privateKey: rsaPem, now, ttlSeconds: 1});
  assert.ok(short.expiresAt - Math.floor(now / 1000) >= 60);
});

test('only RSA private keys are accepted', () => {
  assert.equal(loadPrivateKey(rsaPem).asymmetricKeyType, 'rsa');
  assert.throws(() => loadPrivateKey(ecPem), /APP_PRIVATE_KEY_NOT_RSA/, 'an EC key cannot sign RS256');
  assert.throws(() => loadPrivateKey('not a key'), /APP_PRIVATE_KEY_MALFORMED/);
  assert.throws(() => loadPrivateKey(''), /APP_PRIVATE_KEY_REQUIRED/);
  // Secrets pasted into a web form often carry literal \n sequences.
  assert.equal(loadPrivateKey(rsaPem.replaceAll('\n', '\\n')).asymmetricKeyType, 'rsa');
  assert.throws(() => buildAppJwt({appId: 'abc', privateKey: rsaPem}), /APP_ID_MALFORMED/);
});

test('minting requests a repository-scoped, least-privilege token', async () => {
  let request;
  const result = await mintInstallationToken({
    role: 'publisher',
    appId: '4187077',
    privateKey: rsaPem,
    installationId: '176017917',
    repository,
    fetchImpl: async (url, options) => {
      request = {url, body: JSON.parse(options.body), auth: options.headers.authorization};
      return {
        ok: true,
        status: 201,
        json: async () => ({
          token: 'ghs_fixture_installation_token',
          expires_at: '2026-11-24T13:00:00Z',
          permissions: {checks: 'write', metadata: 'read'},
          repositories: [{full_name: repository}],
        }),
      };
    },
  });
  assert.equal(result.state, 'MINTED');
  assert.match(request.url, /\/app\/installations\/176017917\/access_tokens$/);
  assert.match(request.auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.deepEqual(request.body.repositories, ['project-wolf'], 'scoped to the one repository');
  assert.deepEqual(request.body.permissions, {checks: 'write', metadata: 'read'});
  assert.equal(result.repositoryScoped, true);
  assert.equal(result.permissions.checks, 'write');
  // Neither the private key nor the JWT is echoed back.
  assert.equal(JSON.stringify(result).includes('PRIVATE KEY'), false);
  assert.equal(JSON.stringify(result).includes(request.auth.split(' ')[1]), false);
});

test('the reader scope includes only the read permission needed to verify PR state', async () => {
  let body;
  const result = await mintInstallationToken({
    role: 'reader',
    appId: '4187077',
    privateKey: rsaPem,
    installationId: '176017917',
    repository,
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return {
        ok: true,
        status: 201,
        json: async () => ({
          token: 'ghs_fixture_reader_token',
          expires_at: '2026-11-24T13:00:00Z',
          permissions: {contents: 'read', metadata: 'read', pull_requests: 'read'},
          repositories: [{full_name: repository}],
        }),
      };
    },
  });
  assert.equal(result.state, 'MINTED');
  assert.deepEqual(body.permissions, {contents: 'read', metadata: 'read', pull_requests: 'read'});
  assert.equal(result.token, 'ghs_fixture_reader_token', 'the caller receives the token in memory for step-scoped use');
});

test('a token that arrives with different permissions is refused', async () => {
  const result = await mintInstallationToken({
    role: 'reader',
    appId: '1',
    privateKey: rsaPem,
    installationId: '99',
    repository,
    fetchImpl: async () => ({
      ok: true,
      status: 201,
      json: async () => ({token: 'ghs_x', expires_at: '2026-11-24T13:00:00Z', permissions: {contents: 'write', metadata: 'read'}, repositories: [{full_name: repository}]}),
    }),
  });
  assert.equal(result.state, 'DENIED');
  assert.match(result.reason, /APP_GRANT_DIFFERS:contents/);
  assert.equal(result.token, undefined, 'a denied mint must not yield a usable token');
});

test('missing key material fails closed without requesting anything', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return {ok: true, status: 201, json: async () => ({})}; };
  const noKey = await mintInstallationToken({role: 'reader', appId: '1', privateKey: null, installationId: '1', repository, fetchImpl});
  assert.equal(noKey.state, 'BLOCKED');
  assert.equal(noKey.reason, 'APP_PRIVATE_KEY_REQUIRED');
  const noInstallation = await mintInstallationToken({role: 'reader', appId: '1', privateKey: rsaPem, installationId: '', repository, fetchImpl});
  assert.equal(noInstallation.reason, 'APP_INSTALLATION_ID_REQUIRED');
  const noScope = await mintInstallationToken({role: 'reader', appId: '1', privateKey: rsaPem, installationId: '1', repository: '', fetchImpl});
  assert.equal(noScope.state, 'DENIED');
  assert.equal(noScope.reason, 'APP_REPOSITORY_SCOPE_REQUIRED');
  assert.equal(called, false, 'no network call without complete, scoped input');
});

test('installation failures are classified, not thrown', async () => {
  const cases = [[401, 'APP_JWT_REJECTED'], [403, 'APP_INSTALLATION_FORBIDDEN'], [404, 'APP_INSTALLATION_NOT_FOUND'], [422, 'APP_TOKEN_REQUEST_FAILED']];
  for (const [status, reason] of cases) {
    const result = await mintInstallationToken({
      role: 'reader', appId: '1', privateKey: rsaPem, installationId: '1', repository,
      fetchImpl: async () => ({ok: false, status, body: {cancel: async () => {}}}),
    });
    assert.equal(result.reason, reason);
    assert.equal(result.token, undefined);
  }
});

test('renewal is required inside the safety margin or on a bad expiry', () => {
  const now = Date.UTC(2026, 10, 24, 12, 0, 0);
  assert.equal(needsRenewal('2026-11-24T13:00:00Z', now), false);
  assert.equal(needsRenewal('2026-11-24T12:04:00Z', now), true, 'inside the five minute margin');
  assert.equal(needsRenewal('2026-11-24T12:05:00Z', now), true, 'boundary counts as expiring');
  assert.equal(needsRenewal(null, now), true);
  assert.equal(needsRenewal('not-a-date', now), true);
});

test('credential selection prefers the App and falls back to the PAT explicitly', () => {
  const appEnv = {
    WOLF_FACTORY_APP_ID: '4187077',
    WOLF_FACTORY_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----',
    WOLF_FACTORY_PUBLISHER_INSTALLATION_ID: '176017917',
    WOLF_FACTORY_REPO_TOKEN: 'github_pat_reader',
    WOLF_FACTORY_STATUS_TOKEN: 'github_pat_status',
  };
  assert.equal(selectCredential('publisher', {env: appEnv}).source, 'github-app');
  // Reader has no installation id configured, so it must fall back and say so.
  const reader = selectCredential('reader', {env: appEnv});
  assert.equal(reader.source, 'pat-fallback');
  assert.equal(reader.fallback, true);
  assert.equal(reader.reason, 'APP_AUTH_INCOMPLETE');

  const patOnly = {WOLF_FACTORY_REPO_TOKEN: 'github_pat_reader', WOLF_FACTORY_STATUS_TOKEN: 'github_pat_status'};
  assert.equal(selectCredential('reader', {env: patOnly}).source, 'pat-fallback');
  assert.equal(selectCredential('publisher', {env: patOnly}).source, 'pat-fallback');
  assert.equal(selectCredential('dispatcher', {env: patOnly}).source, 'pat-fallback');
  assert.equal(selectCredential('publisher', {env: {}}).source, 'none');
});

test('credential selection checks the exact hydrated anchor before PAT fallback', () => {
  const first = appendRecord('', {state: 'ACTIVE', retire: false, recordedAt: '2026-11-25T00:00:00Z'});
  const full = appendRecord(first.text, {state: 'RETIRED', retire: true, recordedAt: '2026-11-25T01:00:00Z'});
  const anchor = JSON.stringify(buildHeadAnchor(verifyLedger(full.text)));
  const fallbackEnv = {
    WOLF_FACTORY_REPO_TOKEN: 'ghp_must_never_escape',
    WOLF_CI_RETIREMENT_REQUIRE_ANCHOR: 'true',
  };
  const encoded = value => Buffer.from(value).toString('base64');

  const intact = selectCredential('reader', {
    env: {
      ...fallbackEnv,
      WOLF_CI_RETIREMENT_LEDGER_B64: encoded(first.text),
      WOLF_CI_RETIREMENT_ANCHOR_B64: encoded(JSON.stringify(buildHeadAnchor(verifyLedger(first.text)))),
    },
  });
  assert.equal(intact.source, 'pat-fallback', 'an intact, anchored non-retirement history permits the explicit legacy fallback');

  const truncated = selectCredential('reader', {
    env: {
      ...fallbackEnv,
      WOLF_CI_RETIREMENT_LEDGER_B64: encoded(first.text),
      WOLF_CI_RETIREMENT_ANCHOR_B64: encoded(anchor),
    },
  });
  assert.equal(truncated.source, 'none');
  assert.equal(truncated.reason, 'RETIREMENT_LEDGER_TRUNCATED');
  assert.equal(truncated.withheldCredential, 'pat');

  const missingAnchor = selectCredential('reader', {
    env: {...fallbackEnv, WOLF_CI_RETIREMENT_LEDGER_B64: encoded(first.text)},
  });
  assert.equal(missingAnchor.source, 'none');
  assert.equal(missingAnchor.reason, 'RETIREMENT_ANCHOR_UNAVAILABLE');

  const retired = selectCredential('reader', {
    env: {
      ...fallbackEnv,
      WOLF_CI_RETIREMENT_LEDGER_B64: encoded(full.text),
      WOLF_CI_RETIREMENT_ANCHOR_B64: encoded(anchor),
    },
  });
  assert.equal(retired.source, 'none');
  assert.equal(retired.reason, 'PAT_FALLBACK_RETIRED');
  assert.equal(JSON.stringify([intact, truncated, missingAnchor, retired]).includes('ghp_must_never_escape'), false);
});

test('a retirement file path cannot be mistaken for readable ledger contents', () => {
  const selected = selectCredential('reader', {
    env: {
      WOLF_FACTORY_REPO_TOKEN: 'ghp_must_not_be_selected',
      WOLF_CI_RETIREMENT_REQUIRE_ANCHOR: 'true',
      WOLF_CI_RETIREMENT_LEDGER_TEXT: '/tmp/retirement-ledger.jsonl',
      WOLF_CI_RETIREMENT_ANCHOR_TEXT: '/tmp/retirement-head.json',
    },
  });
  assert.equal(selected.source, 'none');
  assert.equal(selected.reason, 'RETIREMENT_LEDGER_TAMPERED');
});

test('the secret inventory reports presence only', () => {
  const inventory = inventoryAppSecrets({
    WOLF_FACTORY_APP_ID: '4187077',
    WOLF_FACTORY_APP_PRIVATE_KEY: 'secret-material',
    WOLF_FACTORY_REPO_TOKEN: 'github_pat_x',
    WOLF_FACTORY_DEPLOY_KEY: 'key',
  });
  assert.equal(inventory.appId, 'present');
  assert.equal(inventory.privateKey, 'present');
  assert.equal(inventory.installations.reader, 'absent');
  assert.equal(inventory.fallback.pat, 'present');
  assert.equal(inventory.appAuthComplete, false, 'an app without role installation ids is not complete');
  const serialized = JSON.stringify(inventory);
  assert.equal(serialized.includes('secret-material'), false);
  assert.equal(serialized.includes('github_pat_x'), false);
  assert.throws(() => normalizeRole('admin'), /APP_ROLE_DENIED/);
});

test('the CLI masks the token before writing it and never prints it', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const {runAppAuthCli, ROLE_ENV} = await import('../scripts/private-ci-app-auth-cli.mjs');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-app-cli-'));
  const env = {
    WOLF_FACTORY_APP_ID: '4187077',
    WOLF_FACTORY_APP_PRIVATE_KEY: rsaPem,
    WOLF_FACTORY_PUBLISHER_INSTALLATION_ID: '176017917',
    WOLF_CI_REPOSITORY: repository,
    WOLF_CI_TOKEN_FILE: path.join(dir, 'token.env'),
  };
  const lines = [];
  const stdout = text => lines.push(text);
  const fetchImpl = async () => ({
    ok: true,
    status: 201,
    json: async () => ({token: 'ghs_fixture_secret_token', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {checks: 'write', metadata: 'read'}, repositories: [{full_name: repository}]}),
  });

  const code = await runAppAuthCli(['mint', 'publisher'], {env, fetchImpl, stdout});
  assert.equal(code, 0);
  const output = lines.join('');
  assert.match(output, /::add-mask::ghs_fixture_secret_token/, 'the token is masked');
  // Exactly one occurrence: the add-mask directive itself. It must not be echoed
  // again in the JSON summary or written to the log.
  assert.equal(output.split('ghs_fixture_secret_token').length - 1, 1, 'the token appears only in the mask directive');

  const file = fs.readFileSync(env.WOLF_CI_TOKEN_FILE, 'utf8');
  assert.match(file, new RegExp(`^${ROLE_ENV.publisher}=ghs_fixture_secret_token$`, 'm'));
  assert.equal(fs.statSync(env.WOLF_CI_TOKEN_FILE).mode & 0o777, 0o600, 'token file is root-only');
  fs.rmSync(dir, {recursive: true, force: true});
});

test('the CLI falls back explicitly and blocks when nothing is available', async () => {
  const {runAppAuthCli} = await import('../scripts/private-ci-app-auth-cli.mjs');
  const lines = [];
  const stdout = text => lines.push(text);

  // No App secrets, but the PAT fallback exists.
  const fallback = await runAppAuthCli(['mint', 'reader'], {env: {WOLF_FACTORY_REPO_TOKEN: 'github_pat_x'}, stdout});
  assert.equal(fallback, 0);
  assert.match(lines.join(''), /"state":"FALLBACK"/);

  // Nothing at all.
  lines.length = 0;
  const blocked = await runAppAuthCli(['mint', 'publisher'], {env: {}, stdout});
  assert.equal(blocked, 78);
  assert.match(lines.join(''), /"state":"BLOCKED"/);

  // Inventory exposes presence only.
  lines.length = 0;
  assert.equal(await runAppAuthCli(['inventory'], {env: {WOLF_FACTORY_APP_PRIVATE_KEY: 'super-secret'}, stdout}), 0);
  assert.equal(lines.join('').includes('super-secret'), false);
});

test('renewal is proven from a cold start, as a restarted runner sees it', async () => {
  const {runAppAuthCli} = await import('../scripts/private-ci-app-auth-cli.mjs');
  const env = {
    WOLF_FACTORY_APP_ID: '4187077',
    WOLF_FACTORY_APP_PRIVATE_KEY: rsaPem,
    WOLF_FACTORY_READER_INSTALLATION_ID: '176017917',
    WOLF_FACTORY_PUBLISHER_INSTALLATION_ID: '176017917',
    WOLF_FACTORY_DISPATCHER_INSTALLATION_ID: '176017917',
    WOLF_CI_REPOSITORY: repository,
  };
  let minted = 0;
  const fetchImpl = async (url, options = {}) => {
    minted += 1;
    // GitHub returns exactly what was requested; the fixture does the same so
    // the grant check is exercised realistically rather than by call order.
    const requested = JSON.parse(options.body).permissions;
    return {
      ok: true,
      status: 201,
      json: async () => ({
        token: `ghs_token_${minted}`,
        expires_at: new Date(Date.now() + minted * 3600_000).toISOString(),
        permissions: requested,
        repositories: [{full_name: repository}],
      }),
    };
  };
  const lines = [];
  const code = await runAppAuthCli(['verify'], {env, fetchImpl, stdout: text => lines.push(text)});
  const report = JSON.parse(lines.join(''));
  assert.equal(report.state, 'VERIFIED');
  assert.equal(report.credentialsPrinted, false);
  assert.ok(report.renewal.every(entry => entry.renews), 'each role renews to a distinct token');
  assert.ok(report.renewal.every(entry => entry.restartRecovered), 'a restarted runner gets a fresh token for every role');
  assert.ok(report.renewal.every(entry => entry.source === 'github-app'), 'verification only counts when the App issued the token');
  // Twelve, not six: each role is minted twice, and each mint first resolves its
  // installation with a probe mint. The probe exists so a mispointed installation
  // ID self-repairs instead of failing the run.
  assert.equal(minted, 12, 'three roles, two rounds, each preceded by a coverage probe');
});

test('mint leaves no token file when it falls back, so a caller cannot source a missing file', async () => {
  const {runAppAuthCli} = await import('../scripts/private-ci-app-auth-cli.mjs');
  const {existsSync, mkdtempSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const file = join(mkdtempSync(join(tmpdir(), 'mint-fallback-')), 'token.env');
  let printed = '';
  const code = await runAppAuthCli(['mint', 'dispatcher'], {
    env: {WOLF_FACTORY_REPO_TOKEN: 'ghp_reader', WOLF_CI_TOKEN_FILE: file, WOLF_CI_REPOSITORY: 'donraposo1-source/project-wolf'},
    stdout: text => { printed += text; },
  });
  assert.equal(code, 0, 'a fallback is not an error');
  assert.equal(existsSync(file), false, 'no file means the workflow must take the fallback branch');
  assert.equal(printed.includes('ghp_reader'), false, 'the PAT must not reach stdout');
  assert.match(printed, /FALLBACK/);
});


test('a rejected mint reports the API message so the cause is not guessed', async () => {
  const {mintInstallationToken} = await import('../scripts/private-ci-app-auth.mjs');
  const {generateKeyPairSync} = await import('node:crypto');
  const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const pem = privateKey.export({type: 'pkcs1', format: 'pem'});
  const result = await mintInstallationToken({
    role: 'dispatcher', appId: '5913418', privateKey: pem, installationId: '1',
    repository: 'donraposo1-source/project-wolf', permissions: {actions: 'write', metadata: 'read'},
    fetchImpl: async () => ({ok: false, status: 422, json: async () => ({message: 'There is at least one error with your input.'})}),
  });
  assert.equal(result.state, 'FAILED');
  assert.equal(result.httpStatus, 422);
  assert.match(result.apiMessage, /error with your input/);
  assert.deepEqual(result.requestedPermissions, {actions: 'write', metadata: 'read'});
});

test('the API message is redacted before it is retained', async () => {
  const {mintInstallationToken} = await import('../scripts/private-ci-app-auth.mjs');
  const {generateKeyPairSync} = await import('node:crypto');
  const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const pem = privateKey.export({type: 'pkcs1', format: 'pem'});
  const result = await mintInstallationToken({
    role: 'dispatcher', appId: '1', privateKey: pem, installationId: '1',
    repository: 'r/r', permissions: {actions: 'write'},
    fetchImpl: async () => ({ok: false, status: 500, json: async () => ({message: 'failed for ghp_aaaaaaaaaaaaaaaaaaaaaaaa'})}),
  });
  assert.equal(result.apiMessage.includes('ghp_'), false);
});
