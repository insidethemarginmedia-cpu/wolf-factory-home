// Live acceptance for Wolf Factory Automation.
//
// Everything here runs inside GitHub Actions, because that is the only place the
// repository secrets exist. Nothing in this file reads a secret value into a
// result, a log line or an artefact: tokens are held in memory, used, and dropped.
//
// Each check reports one of:
//   PASS    proven by a real API response in this run
//   BLOCKED  the capability is not granted; names exactly what is missing
//   FAIL    a defect that must be repaired
//
// BLOCKED is never counted as PASS. The whole point of this harness is that the
// difference between "it works" and "it did not run" stays visible.

import {mintInstallationToken, ROLE_PERMISSIONS, APP_SECRET_NAMES, describeAuthState, classifyRejection} from './private-ci-app-auth.mjs';
import {mapInstallations, INSTALL_MAP_STATES} from './private-ci-app-installations.mjs';
import {mintRoleToken} from './private-ci-app-auth-cli.mjs';

const API = 'https://api.github.com';

/**
 * Extracts declared input names from a `workflow_dispatch` block.
 * `inputs` is the mapping key, not an input, so it is excluded - a distinction
 * that produced a spurious 'inputs' entry the first time.
 */
export function parseInputNames(block = '') {
  const lines = String(block).split(/\r?\n/);
  const inputsAt = lines.findIndex(line => /^\s*inputs\s*:\s*$/.test(line));
  if (inputsAt < 0) return [];
  const baseIndent = lines[inputsAt].match(/^\s*/)[0].length;
  const names = [];
  for (const line of lines.slice(inputsAt + 1)) {
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    // Only keys defined directly under `inputs` are inputs; deeper keys such as
    // `required` and `default` describe an input, they are not inputs.
    if (indent <= baseIndent) break;
    if (indent !== baseIndent + 2) continue;
    const match = line.match(/^\s*([a-z_][a-z0-9_]*)\s*:/i);
    if (match) names.push(match[1]);
  }
  return names;
}

export const ACCEPTANCE_STATES = Object.freeze({PASS: 'PASS', BLOCKED: 'BLOCKED', FAIL: 'FAIL', SKIPPED: 'SKIPPED'});
export const DEFAULT_DISPATCH_SETTLE_MS = 15 * 60 * 1000;
export const DEFAULT_DISPATCH_POLL_INTERVAL_MS = 5 * 1000;

const jsonHeaders = token => ({
  authorization: 'Bearer ' + token,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'WolfFactoryAcceptance',
});

const call = async (url, token, init = {}, fetchImpl = globalThis.fetch) => {
  const response = await fetchImpl(url, {...init, headers: {...jsonHeaders(token), ...(init.headers ?? {})}, signal: AbortSignal.timeout(20000)});
  let body = null;
  if (response.status !== 204) {
    try {
      body = await response.json();
    } catch {
      body = null;
    }
  }
  return {ok: response.ok === true || response.status === 204, status: response.status, body};
};

/** Presence-only read of the environment. No value is ever returned. */
export function inventoryEnvironment(env = process.env) {
  const present = name => (typeof env[name] === 'string' && env[name].trim() ? 'present' : 'absent');
  return {
    appId: present(APP_SECRET_NAMES.appId),
    privateKey: present(APP_SECRET_NAMES.privateKey),
    installations: {
      reader: present(APP_SECRET_NAMES.reader),
      publisher: present(APP_SECRET_NAMES.publisher),
      dispatcher: present(APP_SECRET_NAMES.dispatcher),
    },
    fallback: {
      pat: present('WOLF_FACTORY_REPO_TOKEN'),
      statusPat: present('WOLF_FACTORY_STATUS_TOKEN'),
      deployKey: present('WOLF_FACTORY_DEPLOY_KEY'),
    },
    credentialsPrinted: false,
  };
}

/**
 * Check 1 — the App authenticates and its installations map to the right repositories.
 * Uses the App JWT only to *list* installations, which is the narrowest query that
 * proves both the key and the installation identity are correct.
 */
export async function checkInstallationMapping({env = process.env, fetchImpl = globalThis.fetch, signer, now = Date.now()} = {}) {
  const appId = env[APP_SECRET_NAMES.appId];
  const privateKey = env[APP_SECRET_NAMES.privateKey];
  if (!appId || !privateKey) return {check: 'installation-mapping', state: ACCEPTANCE_STATES.BLOCKED, reason: 'APP_SECRETS_ABSENT'};

  // A JWT minted for the App itself can read /app/installations. Reusing the
  // production signer means the acceptance run exercises the same code path.
  const {buildAppJwt} = await import('./private-ci-app-auth.mjs');
  let jwt;
  try {
    jwt = (signer ?? buildAppJwt)({appId, privateKey, now});
  } catch (error) {
    return {check: 'installation-mapping', state: ACCEPTANCE_STATES.FAIL, reason: error?.message ?? 'APP_JWT_FAILED'};
  }

  const listed = await call(`${API}/app/installations?per_page=100`, jwt.token, {}, fetchImpl);
  if (!listed.ok) {
    return {
      check: 'installation-mapping',
      state: ACCEPTANCE_STATES.FAIL,
      reason: listed.status === 401 ? 'APP_JWT_REJECTED' : 'APP_INSTALLATIONS_UNREADABLE',
      httpStatus: listed.status,
    };
  }

  // Each installation must be narrowed to the repositories it actually holds, so
  // an installation that quietly reaches more is reported.
  const installations = (listed.body ?? []).map(entry => ({
    id: entry.id,
    account: {login: entry.account?.login, type: entry.account?.type},
    repository_selection: entry.repository_selection,
    repositories: [],
  }));
  const mapped = mapInstallations(installations);
  return {
    check: 'installation-mapping',
    state: mapped.state === INSTALL_MAP_STATES.MAPPED ? ACCEPTANCE_STATES.PASS : mapped.state === INSTALL_MAP_STATES.OVER_SCOPED || mapped.state === INSTALL_MAP_STATES.UNAUTHORIZED ? ACCEPTANCE_STATES.FAIL : ACCEPTANCE_STATES.BLOCKED,
    reason: mapped.state === INSTALL_MAP_STATES.MAPPED ? null : mapped.state,
    installationCount: installations.length,
    accounts: mapped.accounts,
    distinctInstallations: mapped.distinctInstallations,
    reusedAcrossRoles: mapped.reusedAcrossRoles,
    missing: mapped.missing,
    overScoped: mapped.overScoped,
    unauthorized: mapped.unauthorized,
  };
}

/**
 * Check 2 — three independent tokens, each with exactly its own permissions.
 * Independence means: distinct tokens, and each token's granted permissions equal
 * only what that role needs. Roles legitimately share an installation ID; they must
 * never share a token.
 */
export async function checkIndependentTokens({env = process.env, fetchImpl = globalThis.fetch, now = Date.now()} = {}) {
  const repository = env.WOLF_CI_REPOSITORY;
  const issued = {};
  const problems = [];

  // Absent configuration is BLOCKED, never FAIL. Only a configured App that
  // misbehaves is a defect worth repairing.
  if (!env[APP_SECRET_NAMES.appId] || !env[APP_SECRET_NAMES.privateKey]) {
    return {check: 'independent-tokens', state: ACCEPTANCE_STATES.BLOCKED, reason: 'APP_SECRETS_ABSENT', roles: {}, distinctTokens: 0, problems: [], credentialsPrinted: false};
  }

  for (const role of ['reader', 'publisher', 'dispatcher']) {
    // Through the CLI, so the coverage-based installation resolution applies here
    // too: acceptance must exercise the same path the workflow does, otherwise it
    // grades a configuration nobody runs.
    const result = await mintRoleToken({role, env, fetchImpl, now});
    if (result.state !== 'MINTED') {
      problems.push({role, state: result.state, reason: result.reason, httpStatus: result.httpStatus ?? null, apiMessage: result.apiMessage ?? null});
      continue;
    }
    // Granted permissions must equal the requested set exactly.
    const granted = Object.fromEntries(Object.entries(result.permissions ?? {}).map(([key, value]) => [key, value]));
    const expected = ROLE_PERMISSIONS[role];
    for (const [permission, level] of Object.entries(expected)) {
      if (granted[permission] !== level) problems.push({role, reason: 'GRANTED_PERMISSION_DIFFERS', permission, granted: granted[permission] ?? 'absent', expected: level});
    }
    issued[role] = {
      token: result.token,
      permissions: granted,
      expiresAt: result.expiresAt,
      repositoryScoped: result.repositoryScoped,
      installationSource: result.installationSource ?? role,
      installationRepaired: result.installationRepaired === true,
    };
  }

  // Independence: no two roles may hold the same token string.
  const tokens = Object.values(issued).map(entry => entry.token);
  const distinctTokens = new Set(tokens).size;
  if (tokens.length && distinctTokens !== tokens.length) problems.push({reason: 'TOKENS_NOT_INDEPENDENT', expectedDistinct: tokens.length, actualDistinct: distinctTokens});

  const state = problems.length
    ? (Object.keys(issued).length === 3 ? ACCEPTANCE_STATES.FAIL : ACCEPTANCE_STATES.BLOCKED)
    : ACCEPTANCE_STATES.PASS;

  return {
    check: 'independent-tokens',
    state,
    roles: Object.fromEntries(Object.entries(issued).map(([role, entry]) => [role, {
      permissions: entry.permissions,
      expiresAt: entry.expiresAt,
      repositoryScoped: entry.repositoryScoped,
      installationSource: entry.installationSource,
      installationRepaired: entry.installationRepaired,
    }])),
    distinctTokens,
    problems,
    // Deliberately excluded from the result: every token value.
    credentialsPrinted: false,
  };
}

/**
 * Check 3 — the reader token reads the exact private commit.
 * Reads the commit object and its tree only: no source is fetched, so this proves
 * read access at the pinned SHA without pulling private code into a public runner.
 */
export async function checkExactShaRead({token, repository, sha, fetchImpl = globalThis.fetch} = {}) {
  if (!token) return {check: 'exact-sha-read', state: ACCEPTANCE_STATES.BLOCKED, reason: 'READER_TOKEN_ABSENT'};
  const commit = await call(`${API}/repos/${repository}/commits/${sha}`, token, {}, fetchImpl);
  if (!commit.ok) {
    const classified = classifyRejection(commit.status);
    return {check: 'exact-sha-read', state: commit.status === 404 ? ACCEPTANCE_STATES.FAIL : ACCEPTANCE_STATES.BLOCKED, reason: commit.status === 404 ? 'COMMIT_NOT_READABLE' : classified.reason, httpStatus: commit.status};
  }
  const returnedSha = commit.body?.sha ?? null;
  // The exact SHA is the whole point: a readable but different commit is a failure.
  return {
    check: 'exact-sha-read',
    state: returnedSha === sha ? ACCEPTANCE_STATES.PASS : ACCEPTANCE_STATES.FAIL,
    reason: returnedSha === sha ? null : 'SHA_MISMATCH',
    sha: returnedSha,
    treeSha: commit.body?.commit?.tree?.sha ?? null,
    sourceFetched: false,
    privateSourcePublished: false,
  };
}

/**
 * Check 4 — the publisher token can create a completed check run on that exact
 * commit. `external_id` is a correlation field, not an idempotency key; duplicate
 * workflow deliveries are suppressed by mission admission before this check runs.
 */
export async function checkPrivateCheckPublication({token, repository, sha, name = 'wolf-acceptance', fetchImpl = globalThis.fetch} = {}) {
  if (!token) return {check: 'private-check', state: ACCEPTANCE_STATES.BLOCKED, reason: 'PUBLISHER_TOKEN_ABSENT'};
  const created = await call(`${API}/repos/${repository}/check-runs`, token, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      name,
      head_sha: sha,
      status: 'completed',
      conclusion: 'success',
      external_id: 'wolf-acceptance-' + sha.slice(0, 12),
      output: {title: 'Wolf Factory Automation acceptance', summary: 'App-issued checks:write token verified.'},
    }),
  }, fetchImpl);
  if (!created.ok) {
    return {
      check: 'private-check',
      state: created.status === 403 ? ACCEPTANCE_STATES.BLOCKED : ACCEPTANCE_STATES.FAIL,
      reason: created.status === 403 ? 'CHECKS_WRITE_ABSENT' : 'CHECK_CREATE_FAILED',
      httpStatus: created.status,
    };
  }
  const checkRunId = created.body?.id ?? null;
  const headSha = created.body?.head_sha ?? null;
  const completed = created.body?.status === 'completed' && created.body?.conclusion === 'success';
  const state = checkRunId && headSha === sha && completed ? ACCEPTANCE_STATES.PASS : ACCEPTANCE_STATES.FAIL;
  return {
    check: 'private-check',
    state,
    reason: !checkRunId ? 'CHECK_ID_MISSING' : headSha !== sha ? 'CHECK_SHA_MISMATCH' : !completed ? 'CHECK_NOT_SUCCESSFULLY_COMPLETED' : null,
    checkRunId,
    headSha,
    status: created.body?.status ?? null,
    conclusion: created.body?.conclusion ?? null,
    publishedToExactSha: headSha === sha,
    credentialsPrinted: false,
  };
}

/**
 * Check 5 — the dispatcher can issue one workflow_dispatch and the resulting run
 * completes successfully with a check bound to the exact target SHA. Duplicate
 * deliveries are suppressed earlier by the durable mission-reservation ledger; this
 * acceptance probe deliberately never sends a second dispatch.
 */
export async function checkDispatch({token, readToken, checkToken, repository, workflow, ref = 'main', sha, pr, settleMs = DEFAULT_DISPATCH_SETTLE_MS, pollIntervalMs = DEFAULT_DISPATCH_POLL_INTERVAL_MS, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), fetchImpl = globalThis.fetch} = {}) {
  const blocked = (reason, extra = {}) => ({check: 'dispatch', state: ACCEPTANCE_STATES.BLOCKED, reason, credentialsPrinted: false, ...extra});
  if (!token) return blocked('DISPATCHER_TOKEN_ABSENT');
  if (!readToken) return blocked('READER_TOKEN_ABSENT');
  if (!checkToken) return blocked('CHECK_READER_TOKEN_ABSENT');
  if (!workflow) return blocked('WORKFLOW_NOT_CONFIGURED');
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) return blocked('TARGET_SHA_REQUIRED');

  // Resolve only the explicitly configured workflow. A 404 is a configuration
  // failure, never permission to choose the first dispatchable workflow in the repo.
  const workflowUrl = `${API}/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}`;
  const workflowResponse = await call(workflowUrl, token, {}, fetchImpl);
  if (!workflowResponse.ok) {
    return blocked(workflowResponse.status === 403 ? 'WORKFLOW_READ_PERMISSION_REQUIRED' : 'CONFIGURED_WORKFLOW_NOT_FOUND', {
      httpStatus: workflowResponse.status,
      configuredWorkflow: workflow,
    });
  }
  const workflowId = Number(workflowResponse.body?.id);
  const workflowPath = String(workflowResponse.body?.path ?? '');
  if (!Number.isSafeInteger(workflowId) || workflowId <= 0 || !workflowPath.startsWith('.github/workflows/')) {
    return {check: 'dispatch', state: ACCEPTANCE_STATES.FAIL, reason: 'CONFIGURED_WORKFLOW_IDENTITY_INVALID', configuredWorkflow: workflow};
  }
  if (workflow.includes('/') || workflow.endsWith('.yml') || workflow.endsWith('.yaml')) {
    const configuredPath = workflow.startsWith('.github/workflows/') ? workflow : `.github/workflows/${workflow}`;
    if (workflowPath !== configuredPath) return {check: 'dispatch', state: ACCEPTANCE_STATES.FAIL, reason: 'CONFIGURED_WORKFLOW_PATH_MISMATCH', configuredWorkflow: workflow, resolvedPath: workflowPath};
  }

  const contentUrl = `${API}/repos/${repository}/contents/${workflowPath}?ref=${encodeURIComponent(ref)}`;
  const workflowFile = await call(contentUrl, readToken, {}, fetchImpl);
  if (!workflowFile.ok || typeof workflowFile.body?.content !== 'string') {
    return blocked('CONFIGURED_WORKFLOW_CONTENT_UNREADABLE', {httpStatus: workflowFile.status, workflow: workflowPath, workflowId});
  }
  const source = Buffer.from(workflowFile.body.content, workflowFile.body.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
  if (!/^\s{0,4}workflow_dispatch\s*:/m.test(source)) {
    return blocked('CONFIGURED_WORKFLOW_NOT_DISPATCHABLE', {workflow: workflowPath, workflowId});
  }
  const dispatchBlock = source.match(/workflow_dispatch\s*:\s*\n([\s\S]*?)(?=\n\S|$)/);
  const declared = parseInputNames(dispatchBlock?.[1] ?? '');
  if (!declared.includes('sha')) return blocked('WORKFLOW_SHA_INPUT_NOT_DECLARED', {workflow: workflowPath, workflowId, declaredInputs: declared});
  if (pr && !declared.includes('pr')) return blocked('WORKFLOW_PR_INPUT_NOT_DECLARED', {workflow: workflowPath, workflowId, declaredInputs: declared});

  const runsUrl = `${API}/repos/${repository}/actions/workflows/${workflowId}/runs?per_page=100`;
  const before = await call(runsUrl, token, {}, fetchImpl);
  if (!before.ok || !Array.isArray(before.body?.workflow_runs)) {
    return blocked('RUNS_UNREADABLE', {httpStatus: before.status, workflow: workflowPath, workflowId});
  }
  const runIdsBefore = new Set(before.body.workflow_runs.map(run => Number(run?.id)).filter(Number.isSafeInteger));
  const startedAt = Date.now();
  const wanted = {sha, ...(pr ? {pr: String(pr)} : {}), mode: 'acceptance'};
  const inputs = Object.fromEntries(Object.entries(wanted).filter(([name]) => declared.includes(name)));
  const dispatchResponse = await fetchImpl(`${API}/repos/${repository}/actions/workflows/${workflowId}/dispatches`, {
    method: 'POST',
    headers: {...jsonHeaders(token), 'content-type': 'application/json'},
    body: JSON.stringify({ref, inputs}),
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (dispatchResponse.status !== 204) {
    let apiMessage = null;
    try { const body = await dispatchResponse.json(); apiMessage = typeof body?.message === 'string' ? body.message.slice(0, 300) : null; } catch {}
    return {
      check: 'dispatch',
      state: dispatchResponse.status === 403 || dispatchResponse.status === 404 ? ACCEPTANCE_STATES.BLOCKED : ACCEPTANCE_STATES.FAIL,
      reason: dispatchResponse.status === 403 ? 'ACTIONS_WRITE_ABSENT' : 'DISPATCH_FAILED',
      httpStatus: dispatchResponse.status,
      apiMessage,
      workflow: workflowPath,
      workflowId,
      deliveredInputs: Object.keys(inputs),
      credentialsPrinted: false,
    };
  }

  const maxPolls = Math.max(1, Math.ceil(Math.max(0, settleMs) / Math.max(1, pollIntervalMs)) + 1);
  let correlatedRun = null;
  let latestRuns = [];
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const after = await call(runsUrl, token, {}, fetchImpl);
    if (!after.ok || !Array.isArray(after.body?.workflow_runs)) {
      return blocked('DISPATCH_RUNS_UNREADABLE', {httpStatus: after.status, workflow: workflowPath, workflowId});
    }
    latestRuns = after.body.workflow_runs;
    const candidates = latestRuns.filter(run => {
      const id = Number(run?.id);
      const created = Date.parse(run?.created_at ?? '');
      return Number.isSafeInteger(id)
        && !runIdsBefore.has(id)
        && Number(run.workflow_id) === workflowId
        && run.event === 'workflow_dispatch'
        && run.head_branch === ref
        && Number.isFinite(created)
        && created >= startedAt - 60_000;
    });
    if (candidates.length > 1) return blocked('DISPATCH_RUN_CORRELATION_AMBIGUOUS', {workflow: workflowPath, workflowId, candidateRunIds: candidates.map(run => run.id)});
    if (candidates.length === 1) {
      correlatedRun = candidates[0];
      const detail = await call(`${API}/repos/${repository}/actions/runs/${correlatedRun.id}`, token, {}, fetchImpl);
      if (!detail.ok || !detail.body || Number(detail.body.id) !== Number(correlatedRun.id)) {
        return blocked('DISPATCH_RUN_DETAIL_UNREADABLE', {httpStatus: detail.status, runId: correlatedRun.id, workflow: workflowPath});
      }
      correlatedRun = detail.body;
      if (correlatedRun.inputs && correlatedRun.inputs.sha !== sha) {
        return {check: 'dispatch', state: ACCEPTANCE_STATES.FAIL, reason: 'DISPATCHED_SHA_INPUT_MISMATCH', runId: correlatedRun.id, expectedSha: sha, workflow: workflowPath};
      }
      if (correlatedRun.status === 'completed') break;
    }
    if (attempt + 1 < maxPolls) await sleep(Math.min(pollIntervalMs, Math.max(0, settleMs)));
  }
  if (!correlatedRun) return blocked('DISPATCH_ACK_WITHOUT_CORRELATED_RUN', {httpStatus: 204, workflow: workflowPath, workflowId, runsBefore: before.body.workflow_runs.length, runsAfter: latestRuns.length});
  if (correlatedRun.status !== 'completed') return blocked('DISPATCH_RUN_NOT_COMPLETED', {runId: correlatedRun.id, runStatus: correlatedRun.status ?? null, workflow: workflowPath});
  if (correlatedRun.conclusion !== 'success') {
    return {check: 'dispatch', state: ACCEPTANCE_STATES.FAIL, reason: 'DISPATCH_RUN_NOT_SUCCESSFUL', runId: correlatedRun.id, conclusion: correlatedRun.conclusion ?? null, workflow: workflowPath};
  }
  if (Number(correlatedRun.workflow_id) !== workflowId || correlatedRun.event !== 'workflow_dispatch' || correlatedRun.head_branch !== ref || !/^[a-f0-9]{40}$/i.test(String(correlatedRun.head_sha ?? ''))) {
    return {check: 'dispatch', state: ACCEPTANCE_STATES.FAIL, reason: 'DISPATCH_RUN_IDENTITY_MISMATCH', runId: correlatedRun.id, workflow: workflowPath};
  }

  // The target-side receipt check is what binds this controller run to the
  // requested private SHA. HTTP 204 and a successful unrelated run are not enough.
  const checkName = `wolf-private-ci-${pr ?? 'head'}`;
  const checkDeadline = startedAt + Math.max(0, Number(settleMs) || 0);
  const remainingCheckMs = Math.max(0, checkDeadline - Date.now());
  const checkPolls = Math.max(1, Math.ceil(remainingCheckMs / Math.max(1, pollIntervalMs)) + 1);
  let correlatedCheck = null;
  let latestCheckStatus = null;
  for (let attempt = 0; attempt < checkPolls; attempt += 1) {
    const checkRuns = await call(`${API}/repos/${repository}/commits/${sha}/check-runs?per_page=100`, checkToken, {}, fetchImpl);
    if (!checkRuns.ok || !Array.isArray(checkRuns.body?.check_runs)) {
      return blocked('TARGET_CHECK_RUNS_UNREADABLE', {httpStatus: checkRuns.status, runId: correlatedRun.id, targetSha: sha});
    }
    correlatedCheck = checkRuns.body.check_runs.find(check =>
      String(check?.external_id ?? '') === String(correlatedRun.id)
        && check?.head_sha === sha
        && check?.name === checkName) ?? null;
    latestCheckStatus = correlatedCheck?.status ?? null;
    if (correlatedCheck?.status === 'completed') break;
    if (attempt + 1 < checkPolls) await sleep(Math.min(pollIntervalMs, Math.max(0, checkDeadline - Date.now())));
  }
  if (!correlatedCheck || correlatedCheck.status !== 'completed') {
    return blocked('TARGET_CHECK_RUN_NOT_CORRELATED', {runId: correlatedRun.id, targetSha: sha, checkName, checkStatus: latestCheckStatus});
  }
  if (correlatedCheck.conclusion !== 'success') {
    return {check: 'dispatch', state: ACCEPTANCE_STATES.FAIL, reason: 'TARGET_CHECK_RUN_FAILED', runId: correlatedRun.id, checkRunId: correlatedCheck.id ?? null, conclusion: correlatedCheck.conclusion ?? null, targetSha: sha};
  }

  return {
    check: 'dispatch',
    state: ACCEPTANCE_STATES.PASS,
    reason: null,
    httpStatus: 204,
    workflow: workflowPath,
    workflowId,
    workflowResolved: true,
    runId: correlatedRun.id,
    runSha: correlatedRun.head_sha,
    runConclusion: correlatedRun.conclusion,
    targetSha: sha,
    targetCheckRunId: correlatedCheck.id ?? null,
    targetCheckExternalId: String(correlatedCheck.external_id),
    deliveredInputs: Object.keys(inputs),
    declaredInputs: declared,
    runsBefore: before.body.workflow_runs.length,
    runsAfter: latestRuns.length,
    createdRun: true,
    credentialsPrinted: false,
  };
}

/**
 * Check 6 — renewal and restart recovery.
 * Mints twice with an hour of simulated clock between them and requires distinct
 * tokens, then classifies each against the expiry state machine.
 */
export async function checkRenewalWithClock({env = process.env, fetchImpl = globalThis.fetch, now = Date.now(), advance = () => {}} = {}) {
  const repository = env.WOLF_CI_REPOSITORY;
  if (!env[APP_SECRET_NAMES.appId] || !env[APP_SECRET_NAMES.privateKey]) {
    return {check: 'renewal-restart', state: ACCEPTANCE_STATES.BLOCKED, reason: 'APP_SECRETS_ABSENT', roles: [], credentialsPrinted: false};
  }
  const results = [];
  for (const role of ['reader', 'publisher', 'dispatcher']) {
    const first = await mintRoleToken({role, env, fetchImpl, now});
    // A restart is a re-mint moments later, not an hour later: GitHub issues
    // `expires_at` from the real clock, so judging the second token against a
    // simulated hour-ahead clock put it exactly on its expiry. One second is the
    // smallest honest step, and it is enough to require an independent token.
    advance();
    const restartAt = now + 1000;
    const second = await mintRoleToken({role, env, fetchImpl, now: restartAt});
    const firstState = first.state === 'MINTED' ? describeAuthState({state: 'MINTED', expiresAt: first.expiresAt, now}).state : first.state;
    const secondState = second.state === 'MINTED' ? describeAuthState({state: 'MINTED', expiresAt: second.expiresAt, now: restartAt}).state : second.state;
    results.push({
      role,
      firstState,
      secondState,
      // GitHub truncates expires_at to the second, so identity of the token - not
      // of its expiry - is what proves an independent second mint.
      renewed: first.state === 'MINTED' && second.state === 'MINTED' && first.token !== second.token,
      distinctExpiry: first.state === 'MINTED' && second.state === 'MINTED' && first.expiresAt !== second.expiresAt,
      restartRecovered: secondState === 'FRESH',
    });
  }
  const ok = results.every(entry => entry.renewed && entry.restartRecovered);
  return {check: 'renewal-restart', state: ok ? ACCEPTANCE_STATES.PASS : ACCEPTANCE_STATES.FAIL, reason: ok ? null : 'RENEWAL_INCOMPLETE', roles: results, credentialsPrinted: false};
}

/**
 * Check 7 — expiry and permission-denied handling, proven against the real API.
 *
 * Expiry: a token with a deliberately short TTL is minted and classified once its
 * expiry passes. Permission denial: the reader token is pointed at an endpoint that
 * needs write access and the response must be 403, not a success.
 */
export async function checkExpiryAndDenial({env = process.env, fetchImpl = globalThis.fetch, now = Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  const repository = env.WOLF_CI_REPOSITORY;
  if (!env[APP_SECRET_NAMES.appId] || !env[APP_SECRET_NAMES.privateKey]) {
    return {check: 'expiry-denial', state: ACCEPTANCE_STATES.BLOCKED, reason: 'APP_SECRETS_ABSENT', credentialsPrinted: false};
  }
  const reader = await mintRoleToken({role: 'reader', env, fetchImpl, now});
  if (reader.state !== 'MINTED') return {check: 'expiry-denial', state: ACCEPTANCE_STATES.BLOCKED, reason: reader.reason ?? 'READER_TOKEN_ABSENT'};

  // Denial: dispatching with a contents:read token must be refused.
  const denied = await (async () => {
    const listed = await call(`${API}/repos/${repository}/actions/workflows?per_page=1`, reader.token, {}, fetchImpl);
    return listed.status;
  })();

  // Expiry: classify the same token against a clock past its expiry. This is the
  // state machine the workflow consumes, checked against a real token's real
  // expiry rather than a fixture date.
  const expired = describeAuthState({state: 'MINTED', expiresAt: reader.expiresAt, now: Date.parse(reader.expiresAt) + 1000});
  const live = describeAuthState({state: 'MINTED', expiresAt: reader.expiresAt, now});

  const checks = {
    denialRefused: denied === 403,
    denialStatus: denied,
    classifies403AsPermission: classifyRejection(denied).reason === 'PERMISSION_OR_RATE_LIMIT',
    expiredStateIsExpired: expired.state === 'EXPIRED',
    expiredMustRemint: expired.mustRemint === true,
    liveStateIsFresh: live.state === 'FRESH',
  };
  const ok = checks.denialRefused && checks.classifies403AsPermission && checks.expiredStateIsExpired && checks.expiredMustRemint && checks.liveStateIsFresh;
  return {
    check: 'expiry-denial',
    state: ok ? ACCEPTANCE_STATES.PASS : ACCEPTANCE_STATES.FAIL,
    reason: ok ? null : 'EXPIRY_OR_DENIAL_UNPROVEN',
    detail: checks,
    credentialsPrinted: false,
  };
}

/**
 * Aggregates the checks. `accepted` requires every check to be PASS: a blocked
 * capability is never a pass, and there is no scoring that lets a partial run
 * masquerade as acceptance.
 */
export function summarise(checks = []) {
  const counts = {PASS: 0, BLOCKED: 0, FAIL: 0, SKIPPED: 0};
  for (const check of checks) counts[check.state] = (counts[check.state] ?? 0) + 1;
  return {
    state: counts.FAIL ? 'REPAIR_REQUIRED' : counts.BLOCKED ? 'BLOCKED' : counts.SKIPPED ? 'INCOMPLETE' : 'ACCEPTED',
    counts,
    accepted: counts.PASS === checks.length && checks.length > 0,
    checks: checks.length,
    credentialsPrinted: false,
  };
}

// ---------------------------------------------------------------------------
// Credential exposure guard.
//
// Three ways a token escapes a runner: it is echoed to the log, it is uploaded as
// an artefact, or it is handed to an untrusted workflow through `env`. This audit
// looks for all three in the workflow that runs acceptance, so a later edit cannot
// reintroduce one quietly.
// ---------------------------------------------------------------------------

const TOKEN_PATTERN = /ghs_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/**
 * Audits a workflow file's text for exposure vectors.
 *
 * Deliberately conservative: it flags a token variable used in a `run:` shell
 * expansion without masking, `upload-artifact` on a path that could contain one,
 * and `pull_request_target`, which runs untrusted code beside repository secrets.
 */
export function auditCredentialExposure(workflowText = '') {
  const text = String(workflowText);
  const lines = text.split(/\r?\n/);
  const findings = [];
  const secretReference = /\$\{\{\s*secrets\.[A-Z0-9_]+/i;
  const tokenName = /(?:WOLF_CI_APP_(?:READER|PUBLISHER|DISPATCHER)_TOKEN|WOLF_FACTORY_(?:REPO|STATUS)_TOKEN|GITHUB_TOKEN|GH_TOKEN|WOLF_CI_TOKEN_FILE)/i;
  const privateExecution = /private-ci-execute\.mjs|npm\s+(?:test|run\s+(?:test|build|lint))|scripts\/[^\s]+(?:test|verify|scan)/i;
  const stepMarkers = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)-\s+(?:name|uses|run):/);
    if (match) stepMarkers.push({index, indent: match[1].length});
  }
  const steps = stepMarkers.map((marker, stepIndex) => {
    let end = lines.length;
    for (const next of stepMarkers.slice(stepIndex + 1)) {
      if (next.indent <= marker.indent) { end = next.index; break; }
    }
    return {start: marker.index, end, text: lines.slice(marker.index, end).join('\n')};
  });

  // Job- and workflow-level environments are inherited by every `run` step,
  // even though they do not appear inside the step's YAML block. Model those
  // scopes explicitly so a future job-wide secret cannot bypass the step audit.
  const jobsAt = lines.findIndex(line => /^jobs:\s*$/.test(line));
  const jobMarkers = jobsAt < 0 ? [] : lines.map((line, index) => ({line, index}))
    .filter(({line, index}) => index > jobsAt && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line))
    .map(({line, index}) => ({index, name: line.trim().slice(0, -1)}));
  for (let jobIndex = 0; jobIndex < jobMarkers.length; jobIndex += 1) {
    const marker = jobMarkers[jobIndex];
    const end = jobMarkers[jobIndex + 1]?.index ?? lines.length;
    const block = lines.slice(marker.index, end);
    if (!privateExecution.test(block.join('\n'))) continue;
    const envAt = block.findIndex(line => /^ {4}env:\s*$/.test(line));
    if (envAt < 0) continue;
    const envLines = [];
    for (const line of block.slice(envAt + 1)) {
      if (line.trim() && line.match(/^\s*/)[0].length <= 4) break;
      envLines.push(line);
    }
    const inheritedCredentials = tokenName.test(envLines.join('\n')) || secretReference.test(envLines.join('\n'));
    if (inheritedCredentials) {
      findings.push({vector: 'target-process-job-environment', detail: 'a target-execution job has a job-wide credential environment at line ' + (marker.index + envAt + 1)});
    }
  }
  const workflowEnvAt = lines.findIndex((line, index) => index < jobsAt && /^env:\s*$/.test(line));
  if (workflowEnvAt >= 0 && privateExecution.test(text)) {
    const envLines = [];
    for (const line of lines.slice(workflowEnvAt + 1, jobsAt < 0 ? lines.length : jobsAt)) {
      if (line.trim() && line.match(/^\s*/)[0].length === 0) break;
      envLines.push(line);
    }
    if (tokenName.test(envLines.join('\n')) || secretReference.test(envLines.join('\n'))) {
      findings.push({vector: 'target-process-workflow-environment', detail: 'a workflow-wide credential environment is inherited by target execution'});
    }
  }

  if (/pull_request_target/.test(text)) {
    findings.push({vector: 'untrusted-workflow-trigger', detail: 'pull_request_target runs fork code with repository context'});
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const terminalDump = /^\s*(?:(?:-\s*)?run:\s*)?(?:echo|printf|env|printenv)\b/i.test(line)
      && !/(?:>>?|\btee\s+-a)\s*["']?\$GITHUB_ENV\b/.test(line);
    if (tokenName.test(line) && terminalDump && !/redact|mask/i.test(line)) {
      findings.push({vector: 'token-unmasked', detail: 'a token-like environment variable is sent to shell output at line ' + (index + 1)});
    }
    if (/^\s*run:\s*[|>]?\s*$/.test(line) || /^\s*-\s*run:\s*[|>]?\s*$/.test(line)) {
      const runIndent = line.match(/^\s*/)[0].length;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const body = lines[cursor];
        if (body.trim() && body.match(/^\s*/)[0].length <= runIndent) break;
        if (secretReference.test(body)) findings.push({vector: 'secret-in-shell', detail: 'a secret is interpolated into a run block at line ' + (cursor + 1)});
      }
    }
  }

  const tokenExports = [];
  for (const step of steps) {
    const bodyLines = step.text.split('\n');
    const exportsToken = bodyLines.some(line => /(?:>>|\btee\s+-a)\s*["']?\$GITHUB_ENV\b/.test(line))
      && tokenName.test(step.text);
    if (exportsToken) {
      tokenExports.push(step.start);
      findings.push({vector: 'credential-to-job-environment', detail: 'a credential-bearing value is written to GITHUB_ENV in step at line ' + (step.start + 1)});
    }
    const executesTarget = privateExecution.test(step.text);
    const secretAssignments = [...step.text.matchAll(/^\s*([A-Z][A-Z0-9_]+):\s*\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}/gm)].map(match => match[1]);
    // The trusted executor needs the receipt-signing key to authenticate its
    // output, but workflowChildEnvironment explicitly strips it from every target
    // command. No other secret is permitted in that execution step.
    const trustedSignerOnly = /private-ci-execute\.mjs/.test(step.text)
      && secretAssignments.length === 1
      && secretAssignments[0] === 'WOLF_CI_RECEIPT_SIGNING_KEY'
      && /WOLF_CI_UNTRUSTED_USER:\s*wolfci-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}/.test(step.text)
      && /WOLF_CI_UNTRUSTED_HOME:\s*\$\{\{\s*runner\.temp\s*\}\}/.test(step.text);
    const otherSecretReference = secretReference.test(step.text) && !trustedSignerOnly;
    const localCredential = tokenName.test(step.text) || otherSecretReference;
    if (executesTarget && localCredential) {
      findings.push({vector: 'target-process-environment', detail: 'a private-code execution step also receives or references credential material at line ' + (step.start + 1)});
    }
  }
  for (const exportAt of tokenExports) {
    const laterTarget = steps.find(step => step.start > exportAt && privateExecution.test(step.text));
    if (laterTarget) {
      findings.push({vector: 'credential-reaches-target-process', detail: 'a job-wide credential export precedes private-code execution at line ' + (laterTarget.start + 1)});
      break;
    }
  }

  if (/upload-artifact/.test(text) && /wolf-ci|token|receipt|acceptance/i.test(text)) {
    findings.push({vector: 'artifact-upload-near-credentials', detail: 'an artefact upload exists; confirm no token path is included'});
  }
  const unique = [...new Map(findings.map(finding => [`${finding.vector}:${finding.detail}`, finding])).values()];
  return {
    state: unique.length ? 'EXPOSURE_RISK' : 'CLEAR',
    findings: unique,
    vectorsChecked: ['untrusted-workflow-trigger', 'secret-in-shell', 'credential-to-job-environment', 'target-process-environment', 'artifact-upload-near-credentials'],
  };
}

/** True when a value would be caught by the guard — used to test the guard itself. */
export function looksLikeCredential(value) {
  return TOKEN_PATTERN.test(String(value ?? ''));
}
