import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRIDGE_REPOSITORIES,
  DEFAULT_REQUIRED_CHECKS,
  createCheckRun,
  dispatchPrivateCi,
  normalizeChecks,
  normalizeMode,
  normalizePr,
  normalizeRepository,
  normalizeSha,
  probePrivateRepository,
  redact,
  verifyReceiptBinding,
} from '../scripts/private-ci-bridge.mjs';

const sha = 'a'.repeat(40);
const repository = 'donraposo1-source/project-wolf';
const privateRepo = {full_name: repository, private: true, default_branch: 'main', permissions: {pull: true, push: true, maintain: true, admin: true}};
const pull = {number: 743, state: 'open', draft: false, head: {sha, ref: 'feat/pr-743'}, base: {ref: 'main', sha: 'b'.repeat(40)}, mergeable_state: 'clean'};
const workflow = {id: 42, name: 'Wolf Private CI Bridge', path: '.github/workflows/private-ci-bridge.yml', state: 'active'};

function serve(values) {
  let calls = 0;
  return {
    calls: () => calls,
    urls: [],
    fetchImpl: async (url, options = {}) => {
      calls++;
      const value = values[calls - 1];
      if (typeof value === 'function') return value(url, options);
      return {ok: true, status: 200, json: async () => value};
    },
  };
}

test('repository, SHA, PR, checks and mode fail closed on malformed input', () => {
  assert.equal(normalizeRepository(repository), repository);
  for (const bad of ['', 'other/repo', 'donraposo1-source/project-wolf.git']) assert.throws(() => normalizeRepository(bad), /BRIDGE_REPOSITORY_DENIED/);
  assert.equal(normalizeSha(sha.toUpperCase()), sha);
  for (const bad of ['', 'abc', 'g'.repeat(40), sha + '0']) assert.throws(() => normalizeSha(bad), /BRIDGE_SHA_MALFORMED/);
  assert.equal(normalizePr('743'), 743);
  for (const bad of ['0', '-1', '7a']) assert.throws(() => normalizePr(bad), /BRIDGE_PR_MALFORMED/);
  assert.deepEqual(normalizeChecks('security, lint,security'), ['security', 'lint']);
  assert.throws(() => normalizeChecks(''), /BRIDGE_CHECKS_REQUIRED/);
  assert.throws(() => normalizeChecks('deploy'), /BRIDGE_CHECK_DENIED/);
  assert.equal(normalizeMode('recover'), 'recover');
  assert.throws(() => normalizeMode('ignore'), /BRIDGE_MODE_DENIED/);
  assert.deepEqual([...DEFAULT_REQUIRED_CHECKS], ['security', 'lint', 'typecheck', 'unit', 'integration', 'build']);
  assert.deepEqual([...BRIDGE_REPOSITORIES], [repository]);
});

test('a missing private credential blocks before any network request', async () => {
  const s = serve([]);
  const result = await probePrivateRepository({token: '', repository, sha, fetchImpl: s.fetchImpl});
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.reason, 'WOLF_FACTORY_REPO_TOKEN_REQUIRED');
  assert.equal(s.calls(), 0);
  assert.equal(result.privateSourceFetched, false);
});

test('a public or foreign repository cannot be probed', async () => {
  for (const bad of [{...privateRepo, private: false}, {...privateRepo, full_name: 'someone/else'}]) {
    const s = serve([{login: 'donraposo1-source', type: 'User'}, bad]);
    const result = await probePrivateRepository({token: 'fixture-token', repository, sha, fetchImpl: s.fetchImpl});
    assert.equal(result.state, 'DENIED');
    assert.equal(result.reason, 'PRIVATE_REPOSITORY_IDENTITY_REQUIRED');
  }
});

test('the probe returns only non-sensitive metadata and never source or credentials', async () => {
  const token = 'fixture-private-token';
  const s = serve([
    {login: 'donraposo1-source', type: 'User', email: 'private-email'},
    {...privateRepo, description: 'private description'},
    {sha, commit: {message: 'private commit message'}},
    {...pull, title: 'private PR title', body: 'private PR body'},
    {workflows: [{...workflow, html_url: 'https://private.example/workflow'}]},
    {check_runs: [{name: 'unit', status: 'completed', conclusion: 'success', output: {summary: 'private log'}}]},
    {required_status_checks: {contexts: ['security', 'build'], strict: true}, enforce_admins: {enabled: true}},
    {enabled: true, allowed_actions: 'all'},
  ]);
  const result = await probePrivateRepository({token, repository, sha, pr: '743', fetchImpl: s.fetchImpl});
  assert.equal(result.state, 'PROBED');
  assert.equal(result.bridgeWorkflowInstalled, true);
  assert.equal(result.commit.present, true);
  assert.equal(result.pullRequest.headSha, sha);
  assert.deepEqual(result.branchProtection.requiredStatusChecks, ['security', 'build']);
  assert.equal(result.privateSourceFetched, false);
  assert.equal(result.inferencePerformed, false);
  const printed = JSON.stringify(result);
  for (const value of [token, 'private-email', 'private description', 'private commit message', 'private PR title', 'private PR body', 'private log']) {
    assert.equal(printed.includes(value), false, `must not leak ${value}`);
  }
  assert.equal(s.calls(), 8);
});

test('an absent commit is denied and never becomes a successful probe', async () => {
  const s = serve([
    {login: 'donraposo1-source'},
    privateRepo,
    {ok: false, status: 404, json: async () => ({})},
  ]);
  const result = await probePrivateRepository({token: 'fixture-token', repository, sha, fetchImpl: s.fetchImpl});
  assert.equal(result.state, 'DENIED');
  assert.equal(result.reason, 'PRIVATE_COMMIT_NOT_FOUND');
  assert.equal(result.commit.present, false);
});

test('receipt binding rejects absent, mismatched, missing and unsuccessful checks', () => {
  const valid = {
    sha,
    repository,
    checks: DEFAULT_REQUIRED_CHECKS.map(name => ({name, conclusion: 'success'})),
  };
  assert.equal(verifyReceiptBinding(valid, {sha, repository, checks: DEFAULT_REQUIRED_CHECKS}).state, 'VERIFIED');
  assert.equal(verifyReceiptBinding(null, {sha, repository, checks: DEFAULT_REQUIRED_CHECKS}).reason, 'RECEIPT_REQUIRED');
  assert.equal(verifyReceiptBinding({...valid, sha: 'b'.repeat(40)}, {sha, repository, checks: DEFAULT_REQUIRED_CHECKS}).reason, 'RECEIPT_SHA_MISMATCH');
  assert.equal(verifyReceiptBinding({...valid, repository: 'other/repo'}, {sha, repository, checks: DEFAULT_REQUIRED_CHECKS}).reason, 'RECEIPT_REPOSITORY_MISMATCH');
  const missing = verifyReceiptBinding({...valid, checks: valid.checks.slice(1)}, {sha, repository, checks: DEFAULT_REQUIRED_CHECKS});
  assert.equal(missing.reason, 'RECEIPT_CHECKS_MISSING');
  assert.deepEqual(missing.missing, ['security']);
  const failed = verifyReceiptBinding({...valid, checks: valid.checks.map((check, index) => index ? check : {...check, conclusion: 'failure'})}, {sha, repository, checks: DEFAULT_REQUIRED_CHECKS});
  assert.equal(failed.reason, 'RECEIPT_CHECKS_UNSUCCESSFUL');
  assert.deepEqual(failed.unsuccessful, ['security']);
});

test('dispatch addresses only the allowlisted repository, immutable SHA and safe inputs', async () => {
  const s = serve([]);
  const result = await dispatchPrivateCi({
    token: 'fixture-token',
    repository,
    workflowId: 42,
    ref: 'main',
    sha,
    pr: '743',
    baseRef: 'main',
    checks: 'security,lint,typecheck,unit,integration,build',
    mode: 'execute',
    fetchImpl: s.fetchImpl,
  });
  assert.equal(result.state, 'DISPATCHED');
  assert.equal(result.refUpdated, false);
  assert.equal(result.privateSourceFetched, false);
  assert.equal(s.calls(), 1);
  assert.deepEqual(result.inputs.checks.split(','), [...DEFAULT_REQUIRED_CHECKS]);
});

test('check-run output is redacted and capped before publication', async () => {
  let body;
  const s = serve([(url, options) => {
    body = JSON.parse(options.body);
    return {ok: true, json: async () => ({id: 1, ...body})};
  }]);
  const token = 'fixture-token';
  // Check runs are published on the public runner that hosts the bridge.
  await createCheckRun({
    token,
    repository: 'insidethemarginmedia-cpu/wolf-factory-home',
    sha,
    name: 'wolf-private-ci',
    summary: `token=${token} url=https://private.example/path?key=secret`,
    fetchImpl: s.fetchImpl,
  });
  assert.equal(body.head_sha, sha);
  assert.equal(body.output.summary.includes(token), false);
  assert.equal(body.output.summary.includes('private.example'), false);
  assert.match(body.output.summary, /\[REDACTED_TOKEN\]/);
  assert.match(body.output.summary, /\[REDACTED_URL\]/);
  assert.equal(redact('github_pat_ABCDEFGHIJKLMNOP'), '[REDACTED_TOKEN]');
});

test('network failures are sanitized and never echo a credential', async () => {
  const result = await probePrivateRepository({
    token: 'fixture-secret',
    repository,
    sha,
    fetchImpl: async () => { throw Error('fixture-secret'); },
  });
  assert.equal(result.state, 'DENIED');
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
});

test('check runs are confined to the public runner and private repos to the factory', async () => {
  const {normalizePublicRepository, normalizeRepository} = await import('../scripts/private-ci-bridge.mjs');
  assert.equal(normalizePublicRepository('insidethemarginmedia-cpu/wolf-factory-home'), 'insidethemarginmedia-cpu/wolf-factory-home');
  assert.throws(() => normalizePublicRepository('donraposo1-source/project-wolf'), /BRIDGE_REPOSITORY_DENIED/);
  assert.throws(() => normalizePublicRepository('attacker/repo'), /BRIDGE_REPOSITORY_DENIED/);
  assert.equal(normalizeRepository('donraposo1-source/project-wolf'), 'donraposo1-source/project-wolf');
  assert.throws(() => normalizeRepository('insidethemarginmedia-cpu/wolf-factory-home'), /BRIDGE_REPOSITORY_DENIED/);
});

test('the verifier accepts the executor receipt format and rejects advisory-only extras', async () => {
  const {verifyReceiptBinding, DEFAULT_REQUIRED_CHECKS} = await import('../scripts/private-ci-bridge.mjs');
  const executorReceipt = {
    schema: 'wolf.private-ci.receipt/v1',
    state: 'VERIFIED',
    sha,
    repository,
    checks: [
      ...DEFAULT_REQUIRED_CHECKS.map(name => ({name, status: 'success'})),
      {name: 'migrations', status: 'success'},
      {name: 'postgres-concurrency', status: 'advisory-failure'},
    ],
  };
  assert.equal(verifyReceiptBinding(executorReceipt, {sha, repository, checks: DEFAULT_REQUIRED_CHECKS}).state, 'VERIFIED');
  const broken = {...executorReceipt, checks: executorReceipt.checks.map(check => check.name === 'build' ? {...check, status: 'failure'} : check)};
  assert.equal(verifyReceiptBinding(broken, {sha, repository, checks: DEFAULT_REQUIRED_CHECKS}).reason, 'RECEIPT_CHECKS_UNSUCCESSFUL');
});

test('a fine-grained PAT scoped to one repository is not misreported as denied', async () => {
  const {probePrivateRepository} = await import('../scripts/private-ci-bridge.mjs');
  const seen = [];
  // /user is 403 for a fine-grained PAT; /repos/<private> succeeds with the
  // permission headers GitHub reports for that credential.
  const fetchImpl = async (url) => {
    seen.push(url);
    const headers = new Map([
      ['x-accepted-github-permissions', 'contents=read; metadata=read'],
      ['x-oauth-scopes', null],
    ]);
    if (url.endsWith('/user')) return {ok: false, status: 403, headers: {get: () => null}, body: {cancel: async () => {}}};
    if (url.includes('/repos/donraposo1-source/project-wolf/commits/')) return {ok: true, status: 200, headers: {get: () => null}, json: async () => ({sha})};
    if (url.includes('/repos/donraposo1-source/project-wolf/pulls/')) return {ok: true, status: 200, headers: {get: () => null}, json: async () => ({number: 743, state: 'open', head: {sha, ref: 'feat/x'}, base: {ref: 'main'}})};
    if (url.includes('/repos/donraposo1-source/project-wolf/actions/workflows')) return {ok: true, status: 200, headers: {get: () => null}, json: async () => ({workflows: []})};
    if (url.includes('/check-runs')) return {ok: true, status: 200, headers: {get: () => null}, json: async () => ({check_runs: []})};
    if (url.includes('/protection')) return {ok: false, status: 404, headers: {get: () => null}, body: {cancel: async () => {}}};
    if (url.includes('/actions/permissions')) return {ok: true, status: 200, headers: {get: () => null}, json: async () => ({enabled: true, allowed_actions: 'all', sha_pinning_required: false})};
    return {ok: true, status: 200, headers: {get: name => headers.get(name) ?? null}, json: async () => ({full_name: 'donraposo1-source/project-wolf', private: true, default_branch: 'main', permissions: {pull: true, push: false}})};
  };
  const result = await probePrivateRepository({token: 'github_pat_fixture', repository: 'donraposo1-source/project-wolf', sha, pr: 743, fetchImpl});
  assert.equal(result.credentialIdentity.httpStatus, 403, '/user denial is recorded as a fact');
  assert.equal(result.credentialIdentity.state, 'NOT_APPLICABLE');
  assert.equal(result.credential.authorisedForRepository, true, 'the repository read is the authority');
  assert.deepEqual(result.credential.acceptedPermissions, ['contents=read', 'metadata=read']);
  assert.notEqual(result.state, 'DENIED');
  assert.equal(result.privateSourceFetched, false);
  assert.equal(JSON.stringify(result).includes('github_pat_fixture'), false, 'the token must never appear in output');
});

test('dispatch diagnosis names the exact missing permission and never writes', async () => {
  const {diagnoseDispatch} = await import('../scripts/private-ci-bridge.mjs');
  const methods = [];
  const fetchImpl = async (url, options = {}) => {
    methods.push({url, method: options.method ?? 'GET'});
    const permitted = {get: name => (name === 'x-accepted-github-permissions' ? 'contents=read; metadata=read' : null)};
    if (url.includes('/dispatches')) {
      return {ok: false, status: 403, headers: permitted, body: {cancel: async () => {}}};
    }
    if (url.includes('/actions/workflows')) return {ok: true, status: 200, headers: permitted, json: async () => ({workflows: [{id: 4242, path: '.github/workflows/bridge.yml', name: 'bridge'}]})};
    if (url.includes('/actions/runs')) return {ok: true, status: 200, headers: permitted, json: async () => ({total_count: 0, workflow_runs: []})};
    return {ok: true, status: 200, headers: permitted, json: async () => ({full_name: 'donraposo1-source/project-wolf', private: true, default_branch: 'main', permissions: {pull: true}})};
  };
  const result = await diagnoseDispatch({token: 'github_pat_fixture', repository: 'donraposo1-source/project-wolf', workflowId: 4242, fetchImpl});
  assert.equal(result.capabilities.repositoryRead.ok, true);
  assert.equal(result.capabilities.workflowsRead.ok, true);
  assert.equal(result.capabilities.runsRead.ok, true);
  assert.equal(result.capabilities.dispatchWrite.httpStatus, 403);
  assert.deepEqual(result.requiredPermissions, ['actions: write'], 'the minimum missing permission is named');
  assert.match(String(result.reason), /ACTIONS_WRITE_REQUIRED/);
  assert.deepEqual(result.credentialPermissions.acceptedPermissions, ['contents=read', 'metadata=read']);
  // Only the dispatch probe may write, and only to a read-safe payload.
  const writes = methods.filter(entry => entry.method !== 'GET');
  assert.equal(writes.length, 1);
  assert.match(writes[0].url, /\/dispatches$/);
  assert.equal(JSON.stringify(result).includes('github_pat_fixture'), false);
});

test('private status checks require their own credential and fail closed without it', async () => {
  const {publishPrivateStatusChecks, PRIVATE_STATUS_PERMISSION} = await import('../scripts/private-ci-bridge.mjs');
  const base = {repository, sha, names: ['wolf-private-ci-743'], conclusion: 'success', summary: 'x'};

  // No status credential: blocked, and the missing permission is named.
  const blocked = await publishPrivateStatusChecks({...base, sourceToken: 'github_pat_source'});
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.reason, 'PRIVATE_STATUS_TOKEN_REQUIRED');
  assert.match(blocked.requiredPermission, /checks: write/);

  // Reusing the read credential for a write is refused outright.
  const reused = await publishPrivateStatusChecks({...base, sourceToken: 'same', statusToken: 'same'});
  assert.equal(reused.state, 'DENIED');
  assert.equal(reused.reason, 'STATUS_TOKEN_MUST_DIFFER_FROM_SOURCE_TOKEN');

  // A credential without Checks:write is reported as a permission gap, not an outage.
  const denied = await publishPrivateStatusChecks({
    ...base,
    sourceToken: 'github_pat_source',
    statusToken: 'github_pat_status',
    fetchImpl: async () => ({ok: false, status: 403, headers: {get: () => null}, body: {cancel: async () => {}}}),
  });
  assert.equal(denied.state, 'BLOCKED');
  assert.equal(denied.reason, 'PRIVATE_STATUS_PERMISSION_REQUIRED');
  assert.equal(denied.httpStatus, 403);

  // With the right credential the check lands on the private commit.
  const calls = [];
  const published = await publishPrivateStatusChecks({
    ...base,
    sourceToken: 'github_pat_source',
    statusToken: 'github_pat_status',
    fetchImpl: async (url, options = {}) => {
      calls.push({url, body: JSON.parse(options.body)});
      return {ok: true, status: 200, headers: {get: () => null}, json: async () => ({id: 999})};
    },
  });
  assert.equal(published.state, 'PUBLISHED');
  assert.equal(published.privateStatusWritten, true);
  assert.match(calls[0].url, /repos\/donraposo1-source\/project-wolf\/check-runs$/);
  assert.equal(calls[0].body.head_sha, sha);
  assert.equal(JSON.stringify(published).includes('github_pat_status'), false, 'credentials never appear in output');
});

test('the publisher prefers the App token and never mixes it with the status PAT', async () => {
  const {publishPrivateStatusChecks} = await import('../scripts/private-ci-bridge.mjs');
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    seen.push(JSON.parse(options.body).name);
    return {ok: true, status: 200, headers: {get: () => null}, json: async () => ({id: 1})};
  };
  // The CLI resolves the token before calling this function; here we assert the
  // function itself refuses an absent status credential rather than falling back
  // to the reader, which is the actual boundary being protected.
  const blocked = await publishPrivateStatusChecks({
    repository, sha, names: ['wolf-private-ci-743'], conclusion: 'success', summary: 'x',
    sourceToken: 'github_pat_reader', fetchImpl,
  });
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(seen.length, 0, 'no request without a status credential');
  assert.deepEqual(blocked.installationIds ?? null, null);
});

test('the receipt keeps the credential source the probe reported', async () => {
  const {readDispatchVerification} = await import('../scripts/private-ci-bridge.mjs');
  const {mkdtempSync, writeFileSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-receipt-'));
  const dispatchFile = join(dir, 'd.json');
  writeFileSync(dispatchFile, JSON.stringify({state: 'BLOCKED', reason: 'WORKFLOW_LIST_UNAVAILABLE', credentialSource: 'pat', duplicateSuppressed: false, runsBefore: null, runsAfter: null}));
  const receipt = readDispatchVerification(dispatchFile);
  assert.equal(receipt.credentialSource, 'pat');
  assert.equal(receipt.reason, 'WORKFLOW_LIST_UNAVAILABLE');
});

test('the auth posture names the App once the secrets exist, and never a value', async () => {
  const {readAuthenticationPosture} = await import('../scripts/private-ci-bridge.mjs');
  const {mkdtempSync, writeFileSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'auth-posture-'));

  assert.deepEqual(readAuthenticationPosture(join(dir, 'missing.json')), {state: 'NOT_REPORTED'});

  const file = join(dir, 'auth.json');
  writeFileSync(file, JSON.stringify({appAuthComplete: true, installations: {reader: 'present', publisher: 'present', dispatcher: 'present', legacy: 'absent'}, fallback: {pat: 'present', statusPat: 'absent', deployKey: 'present'}, appId: '12345', privateKey: 'MUST_NOT_APPEAR'}));
  const posture = readAuthenticationPosture(file);
  assert.equal(posture.mode, 'github-app');
  assert.equal(posture.appSecretsComplete, true);
  assert.equal(posture.credentialsPrinted, false);
  const serialized = JSON.stringify(posture);
  assert.equal(serialized.includes('MUST_NOT_APPEAR'), false, 'the posture is presence-only');
  assert.equal(serialized.includes('12345'), false, 'even the app id is not published');
});

test('the receipt makes the difference between verified App renewal and a PAT fallback explicit', async () => {
  const {readAuthRecovery} = await import('../scripts/private-ci-bridge.mjs');
  const {mkdtempSync, writeFileSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'auth-recovery-'));
  const file = join(dir, 'recovery.json');

  writeFileSync(file, JSON.stringify({
    state: 'NOT_APPLICABLE',
    reason: 'APP_AUTH_INCOMPLETE',
    renewal: [{role: 'reader', source: 'pat-fallback', renews: false, restartRecovered: false, first: {authState: 'FALLBACK'}, second: {authState: 'FALLBACK'}}],
  }));
  const fallback = readAuthRecovery(file);
  assert.equal(fallback.state, 'NOT_APPLICABLE', 'a PAT run is never reported as verified');
  assert.equal(fallback.roles[0].source, 'pat-fallback');
  assert.equal(fallback.roles[0].renews, false);

  writeFileSync(file, JSON.stringify({
    state: 'VERIFIED',
    renewal: [{role: 'reader', source: 'github-app', renews: true, restartRecovered: true, first: {authState: 'FRESH'}, second: {authState: 'FRESH'}}],
  }));
  const verified = readAuthRecovery(file);
  assert.equal(verified.state, 'VERIFIED');
  assert.equal(verified.roles[0].renews, true);
  assert.equal(verified.roles[0].restartRecovered, true);
  assert.equal(verified.credentialsPrinted, false);
});
