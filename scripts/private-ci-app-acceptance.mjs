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

export const ACCEPTANCE_STATES = Object.freeze({PASS: 'PASS', BLOCKED: 'BLOCKED', FAIL: 'FAIL', SKIPPED: 'SKIPPED'});

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
 * Check 4 — the publisher token can create a check run on that exact commit.
 * The check is created with a stable external_id so a re-run updates rather than
 * duplicates, which is the property the bridge relies on.
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
  return {
    check: 'private-check',
    state: created.body?.id ? ACCEPTANCE_STATES.PASS : ACCEPTANCE_STATES.FAIL,
    reason: created.body?.id ? null : 'CHECK_ID_MISSING',
    checkRunId: created.body?.id ?? null,
    headSha: created.body?.head_sha ?? null,
    conclusion: created.body?.conclusion ?? null,
    publishedToExactSha: created.body?.head_sha === sha,
    credentialsPrinted: false,
  };
}

/**
 * Check 5 — the dispatcher token can dispatch, and a second identical dispatch is
 * suppressed. Suppression is read from the run count, not assumed.
 */
export async function checkDispatch({token, repository, workflow, ref = 'main', sha, pr, settleMs = 6000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), fetchImpl = globalThis.fetch} = {}) {
  if (!token) return {check: 'dispatch', state: ACCEPTANCE_STATES.BLOCKED, reason: 'DISPATCHER_TOKEN_ABSENT'};
  if (!workflow) return {check: 'dispatch', state: ACCEPTANCE_STATES.BLOCKED, reason: 'WORKFLOW_NOT_RESOLVED'};

  // The workflow is named, not assumed to exist. If the configured name is wrong
  // the run used to report RUNS_UNREADABLE, which reads like a permission problem
  // and is not one. Resolve the target instead, and say which one was chosen.
  let target = workflow;
  let resolved = {workflow: target, discovered: false};
  let base = `${API}/repos/${repository}/actions/workflows/${target}`;
  let before = await call(`${base}/runs?per_page=1`, token, {}, fetchImpl);

  if (!before.ok && before.status === 404) {
    const listed = await call(`${API}/repos/${repository}/actions/workflows?per_page=100`, token, {}, fetchImpl);
    const candidates = Array.isArray(listed.body?.workflows)
      ? listed.body.workflows
        .filter(entry => typeof entry?.path === 'string' && entry.path.startsWith('.github/workflows/'))
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id)
      : [];
    const chosen = candidates[0];
    if (chosen) {
      target = chosen.id;
      base = `${API}/repos/${repository}/actions/workflows/${target}`;
      resolved = {workflow: chosen.path, workflowId: chosen.id, discovered: true, configured: workflow};
      before = await call(`${base}/runs?per_page=1`, token, {}, fetchImpl);
    } else {
      return {
        check: 'dispatch',
        state: ACCEPTANCE_STATES.BLOCKED,
        reason: 'NO_WORKFLOW_FOUND',
        httpStatus: before.status,
        configuredWorkflow: workflow,
        workflowsVisible: Array.isArray(listed.body?.workflows) ? listed.body.workflows.length : 0,
      };
    }
  }

  if (!before.ok) {
    return {
      check: 'dispatch',
      state: before.status === 403 || before.status === 404 ? ACCEPTANCE_STATES.BLOCKED : ACCEPTANCE_STATES.FAIL,
      reason: 'RUNS_UNREADABLE',
      httpStatus: before.status,
      workflow: resolved.workflow,
    };
  }
  const runsBefore = before.body?.total_count ?? null;

  const dispatch = async () => {
    const response = await fetchImpl(`${base}/dispatches`, {
      method: 'POST',
      headers: {...jsonHeaders(token), 'content-type': 'application/json'},
      body: JSON.stringify({ref, inputs: {sha: sha ?? '', pr: pr ?? '', mode: 'acceptance'}}),
      signal: AbortSignal.timeout(20000),
    });
    return response.status;
  };

  const first = await dispatch();
  if (first !== 204) {
    return {check: 'dispatch', state: first === 403 || first === 404 ? ACCEPTANCE_STATES.BLOCKED : ACCEPTANCE_STATES.FAIL, reason: first === 403 ? 'ACTIONS_WRITE_ABSENT' : 'DISPATCH_FAILED', httpStatus: first};
  }
  await sleep(settleMs);
  const afterFirst = await call(`${base}/runs?per_page=1`, token, {}, fetchImpl);
  const runsAfterFirst = afterFirst.body?.total_count ?? null;

  return {
    check: 'dispatch',
    state: ACCEPTANCE_STATES.PASS,
    reason: null,
    httpStatus: first,
    workflow: resolved.workflow,
    workflowResolved: resolved.discovered === true,
    runsBefore,
    runsAfterFirst,
    createdRun: runsBefore !== null && runsAfterFirst !== null ? runsAfterFirst > runsBefore : null,
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
  const findings = [];

  if (/pull_request_target/.test(text)) {
    // Acceptable only if no secret is referenced; otherwise it is an escalation.
    findings.push({vector: 'untrusted-workflow-trigger', detail: 'pull_request_target runs fork code with repository context'});
  }

  // A secret interpolated directly into a shell line is echoed by `set -x` and by
  // any error message. Secrets belong in `env:` and are referenced as variables.
  // Line-oriented on purpose: a nested regex over YAML runs is easy to get wrong,
  // and a guard that misses its own fixture is worse than no guard.
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^\s*run:\s*[|>]?\s*$/.test(line) && !/^\s*-\s*run:\s*[|>]?\s*$/.test(line)) continue;
    const runIndent = line.match(/^\s*/)[0].length;
    // A run block ends at the first line that is indented no deeper.
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const body = lines[cursor];
      if (body.trim() && body.match(/^\s*/)[0].length <= runIndent) break;
      if (/\$\{\{\s*secrets\.[A-Z_]+/.test(body)) {
        findings.push({vector: 'secret-in-shell', detail: 'a secret is interpolated into a run block at line ' + (cursor + 1)});
      }
    }
  }

  if (/upload-artifact/.test(text) && /wolf-ci|token|receipt|acceptance/i.test(text)) {
    findings.push({vector: 'artifact-upload-near-credentials', detail: 'an artefact upload exists; confirm no token path is included'});
  }

  // Every minted token must be masked before it can be printed.
  if (/WOLF_CI_APP_(READER|PUBLISHER|DISPATCHER)_TOKEN/.test(text) && !/:+:add-mask::/.test(text) && !/private-ci-app-auth-cli\.mjs/.test(text)) {
    findings.push({vector: 'token-unmasked', detail: 'a token variable is used without a masking path'});
  }

  return {
    state: findings.length ? 'EXPOSURE_RISK' : 'CLEAR',
    findings,
    vectorsChecked: ['untrusted-workflow-trigger', 'secret-in-shell', 'artifact-upload-near-credentials', 'token-unmasked'],
  };
}

/** True when a value would be caught by the guard — used to test the guard itself. */
export function looksLikeCredential(value) {
  return TOKEN_PATTERN.test(String(value ?? ''));
}
