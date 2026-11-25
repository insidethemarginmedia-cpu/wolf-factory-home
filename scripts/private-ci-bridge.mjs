// Secure CI bridge for private Wolf commits.
//
// The public repository never receives private source. This module only reads
// non-sensitive GitHub metadata, dispatches the private-side executor, and
// publishes SHA-bound receipts. Every credential is used in memory, never
// printed, never persisted, and never placed in a URL or process argument.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {decideFallbackRetirement} from './private-ci-app-auth.mjs';
import {DEFAULT_REQUIRED_CHECKS, ALL_REQUIRED_CHECKS, ALLOWED_CHECKS, WORKFLOW_CHECKS, normalizeCheckNames} from './private-ci-contract.mjs';
import {verifyReceiptSignature} from './private-ci-receipt.mjs';

export {DEFAULT_REQUIRED_CHECKS};
export const BRIDGE_REPOSITORIES = Object.freeze(['donraposo1-source/project-wolf']);
// The runner that hosts this bridge. It is only ever touched to publish the
// sanitized receipt and a status check run; no private source reaches it.
export const BRIDGE_PUBLIC_REPOSITORIES = Object.freeze(['insidethemarginmedia-cpu/wolf-factory-home']);
export const BRIDGE_WORKFLOW_PATH = '.github/workflows/private-ci-bridge.yml';
export const SHA_PATTERN = /^[a-f0-9]{40}$/;
export const PR_PATTERN = /^[1-9][0-9]*$/;

const SAFE_CHECK_STATUSES = new Set(['success', 'failure']);
const SAFE_STEP_STATUSES = new Set(['success', 'failure', 'timeout']);
const SAFE_WORKFLOW_PATHS = new Set(Object.values(WORKFLOW_CHECKS).map(definition => definition.workflow));

/**
 * Select only fixed-contract names and numeric execution facts from a verified
 * receipt. Free-form target-controlled fields (commands, args, step labels,
 * error text, SQL detail and log tails) are never copied into public output.
 */
export function sanitizeReceiptChecks(checks) {
  if (!Array.isArray(checks)) return [];
  return checks.filter(check => check && ALL_REQUIRED_CHECKS.includes(check.name)).map(check => ({
    name: check.name,
    status: SAFE_CHECK_STATUSES.has(check.status) ? check.status : 'failure',
    durationMs: Number.isSafeInteger(check.durationMs) && check.durationMs >= 0 ? check.durationMs : null,
    steps: (Array.isArray(check.steps) ? check.steps : []).slice(0, 500).map((step, index) => ({
      stepIndex: Number.isSafeInteger(step?.stepIndex) && step.stepIndex >= 0 ? step.stepIndex : index,
      ...(SAFE_WORKFLOW_PATHS.has(step?.workflow) ? {workflow: step.workflow} : {}),
      exitCode: Number.isInteger(step?.exitCode) ? step.exitCode : null,
      expectedExitCodes: Array.isArray(step?.expectedExitCodes) ? step.expectedExitCodes.filter(Number.isInteger).slice(0, 16) : [],
      status: SAFE_STEP_STATUSES.has(step?.status) ? step.status : 'failure',
      durationMs: Number.isSafeInteger(step?.durationMs) && step.durationMs >= 0 ? step.durationMs : null,
    })),
  }));
}

// Reads a JSON artefact written by an earlier step. Presence reporting only:
// neither helper can surface a credential, because neither artefact contains one.
function readJsonArtefact(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return 'UNREADABLE';
  }
}

export function readAuthenticationPosture(file) {
  const parsed = readJsonArtefact(file);
  if (parsed === null) return {state: 'NOT_REPORTED'};
  if (parsed === 'UNREADABLE') return {state: 'UNREADABLE'};
  return {
    mode: parsed.appAuthComplete ? 'github-app' : 'pat-fallback',
    appSecretsComplete: parsed.appAuthComplete ?? false,
    installationIds: parsed.installations ?? null,
    fallbacks: parsed.fallback ?? null,
    credentialsPrinted: false,
  };
}

export function readAuthRecovery(file) {
  const parsed = readJsonArtefact(file);
  if (parsed === null) return {state: 'NOT_REPORTED'};
  if (parsed === 'UNREADABLE') return {state: 'UNREADABLE'};
  return {
    // VERIFIED means the App issued two distinct tokens per role.
    // NOT_APPLICABLE means the PAT did the work and the claim is not made.
    state: parsed.state,
    reason: parsed.reason ?? null,
    roles: Array.isArray(parsed.renewal)
      ? parsed.renewal.map(entry => ({
          role: entry.role,
          source: entry.source ?? null,
          renews: entry.renews === true,
          restartRecovered: entry.restartRecovered === true,
          firstState: entry.first?.authState ?? null,
          secondState: entry.second?.authState ?? null,
        }))
      : [],
    credentialsPrinted: false,
  };
}

/**
 * The fallback-retirement decision, evaluated from this run's own evidence.
 * `retire: true` is the only state in which the PAT may be withdrawn.
 */
export function readRetirementDecision({acceptance, authentication, renewal}) {
  const checks = acceptance?.checks ?? [];
  const classify = {accepted: acceptance?.accepted, authentication, renewal, acceptance: acceptance ? {
    state: acceptance.state, accepted: acceptance.accepted,
    checks: checks.map(check => ({check: check.check, state: check.state})),
  } : null};
  return decideFallbackRetirement(classify);
}

/**
 * Prefers the enforcement step's own verdict. Falls back to recomputing only when
 * that artefact is absent, and reports which source was used.
 */
export function readRetirementArtefact(file, evidence = {}) {
  const parsed = readJsonArtefact(file);
  if (parsed && parsed !== 'UNREADABLE' && typeof parsed === 'object' && 'retire' in parsed) {
    return {
      state: parsed.state,
      retire: parsed.retire === true,
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
      evaluated: true,
      enforced: String(process.env.WOLF_CI_RETIRE_PAT ?? '').toLowerCase() === 'true',
      source: 'enforcement-step',
      credentialsPrinted: false,
    };
  }
  const recomputed = readRetirementDecision(evidence);
  return {
    ...recomputed,
    enforced: String(process.env.WOLF_CI_RETIRE_PAT ?? '').toLowerCase() === 'true',
    source: parsed === 'UNREADABLE' ? 'recomputed-unreadable-artefact' : 'recomputed-no-artefact',
  };
}

export function readAcceptance(file) {
  const parsed = readJsonArtefact(file);
  if (parsed === null) return {state: 'NOT_REPORTED'};
  if (parsed === 'UNREADABLE') return {state: 'UNREADABLE'};
  const checks = Array.isArray(parsed.checks) ? parsed.checks : [];
  return {
    // ACCEPTED requires every check to have passed against the real API. A
    // blocked capability keeps this BLOCKED, which is never a pass.
    state: parsed.state ?? 'UNKNOWN',
    accepted: parsed.accepted === true,
    counts: parsed.counts ?? null,
    generatedAt: parsed.generatedAt ?? null,
    // Per-check outcomes only: no token, no key, no response body.
    checks: checks.map(check => ({
      check: check.check,
      state: check.state,
      reason: check.reason ?? null,
    })),
    credentialsPrinted: false,
  };
}

/**
 * Reconciles the two dispatch signals.
 *
 * There are two paths that exercise dispatch: the narrow probe, which only reads
 * and must run early, and the full acceptance check, which actually dispatches.
 * Reporting the probe's BLOCKED next to an acceptance PASS made the receipt
 * contradict itself, so the stronger, later evidence wins - and the weaker one is
 * still shown, never discarded.
 */
export function reconcileDispatch({probe, acceptance}) {
  const acceptanceDispatch = (acceptance?.checks ?? []).find(entry => entry?.check === 'dispatch') ?? null;
  if (acceptanceDispatch && acceptanceDispatch.state === 'PASS') {
    return {
      state: 'VERIFIED',
      source: 'acceptance',
      httpStatus: null,
      reason: null,
      // Kept for transparency: the early read-only probe could not list workflows.
      earlierProbe: probe ? {state: probe.state, reason: probe.reason ?? null} : null,
      duplicateSuppressed: probe?.duplicateSuppressed === true,
    };
  }
  return probe ?? {state: 'NOT_REPORTED'};
}

export function readDispatchVerification(file) {
  const parsed = readJsonArtefact(file);
  if (parsed === null) return {state: 'NOT_REPORTED'};
  if (parsed === 'UNREADABLE') return {state: 'UNREADABLE'};
  return {
    state: parsed.state,
    reason: parsed.reason ?? null,
    // The probe reports `credentialSource`; accepted either way so the receipt
    // never silently drops which identity was used.
    credentialSource: parsed.credentialSource ?? parsed.source ?? null,
    workflowDiscovered: parsed.workflowDiscovered === true,
    workflowId: parsed.workflowId ?? null,
    workflowFile: parsed.workflowFile ?? null,
    discoveredWorkflow: parsed.discoveredWorkflow ?? null,
    duplicateSuppressed: parsed.duplicateSuppressed === true,
    runsBefore: parsed.runsBefore ?? null,
    runsAfter: parsed.runsAfter ?? null,
  };
}

export const BRIDGE_EXIT = Object.freeze({
  OK: 0,
  DEFECT: 1,
  CONFIGURATION_REQUIRED: 78,
  DENIED: 79,
  NOT_INSTALLED: 80,
});

const API = 'https://api.github.com';
const USER_AGENT = 'WolfPrivateCiBridge';
const TIMEOUT_MS = 20000;

export function normalizeRepository(value, env = process.env, allowed = BRIDGE_REPOSITORIES) {
  const repository = String(value ?? env.WOLF_CI_REPOSITORY ?? '').trim();
  if (!allowed.includes(repository)) throw Error('BRIDGE_REPOSITORY_DENIED');
  return repository;
}

export function normalizePublicRepository(value, env = process.env) {
  return normalizeRepository(value, env, BRIDGE_PUBLIC_REPOSITORIES);
}

export function normalizeSha(value, env = process.env) {
  const sha = String(value ?? env.WOLF_CI_SHA ?? '').trim().toLowerCase();
  if (!SHA_PATTERN.test(sha)) throw Error('BRIDGE_SHA_MALFORMED');
  return sha;
}

export function normalizeChecks(value, env = process.env) {
  try {
    return normalizeCheckNames(value ?? env.WOLF_CI_CHECKS, {
      defaults: DEFAULT_REQUIRED_CHECKS,
      allowed: ALLOWED_CHECKS,
      errorPrefix: 'BRIDGE_CHECKS',
    });
  } catch (error) {
    if (error?.message === 'BRIDGE_CHECKS_DENIED') throw Error('BRIDGE_CHECK_DENIED');
    throw error;
  }
}

export function normalizePr(value, env = process.env) {
  const raw = String(value ?? env.WOLF_CI_PR ?? '').trim();
  if (!raw) return null;
  if (!PR_PATTERN.test(raw)) throw Error('BRIDGE_PR_MALFORMED');
  return Number(raw);
}

export function normalizeMode(value, env = process.env) {
  const mode = String(value ?? env.WOLF_CI_MODE ?? 'execute').trim().toLowerCase();
  if (!['execute', 'recover', 'cancel'].includes(mode)) throw Error('BRIDGE_MODE_DENIED');
  return mode;
}

export function redact(value, extraSecrets = []) {
  let safe = String(value ?? '')
    .replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[REDACTED_TOKEN]')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[REDACTED_TOKEN]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_KEY]')
    .replace(/https?:\/\/[^\s"'<>]+/g, '[REDACTED_URL]');
  for (const secret of extraSecrets) if (typeof secret === 'string' && secret.length > 3) safe = safe.split(secret).join('[REDACTED_TOKEN]');
  return safe.slice(0, 65535);
}

export function summarizeCheckRuns(checkRuns = []) {
  return checkRuns.map(run => ({
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    startedAt: run.started_at ?? null,
    completedAt: run.completed_at ?? null,
    detailsUrl: run.details_url ?? null,
  }));
}

// The scope/permission headers GitHub returns describe what the credential is
// actually allowed to do. They are recorded (never the token itself) so a
// minimal fine-grained PAT can be distinguished from a broken one.
export function credentialHeaders(headers) {
  const read = name => (typeof headers?.get === 'function' ? headers.get(name) : null);
  const accepted = read('x-accepted-github-permissions');
  const oauth = read('x-oauth-scopes');
  return {
    // GitHub reports `contents=read; metadata=read`; normalize to individual
    // permissions so a caller can reason about the minimum set.
    acceptedPermissions: accepted
      ? accepted.split(/[,;]/).map(value => value.trim()).filter(Boolean).sort()
      : null,
    oauthScopes: oauth === null ? null : oauth.split(',').map(value => value.trim()).filter(Boolean).sort(),
    patType: /^github_pat_/.test(String(read('x-token-type') ?? '')) ? 'fine-grained' : read('x-oauth-scopes') === null ? null : 'classic',
  };
}

async function githubJson(url, {token, method = 'GET', body, fetchImpl = globalThis.fetch, capture = null} = {}) {
  if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token)) throw Error('BRIDGE_CREDENTIAL_FORMAT_INVALID');
  const headers = {
    authorization: 'Bearer ' + token,
    accept: 'application/vnd.github+json',
    'user-agent': USER_AGENT,
    'x-github-api-version': '2022-11-28',
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const code = error?.cause?.code;
    throw Error(['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code) ? 'BRIDGE_NETWORK_' + code : 'BRIDGE_NETWORK_FAILED');
  }
  if (capture) capture.credentialHeaders = credentialHeaders(response.headers);
  if (!response.ok) {
    try { await response.body?.cancel(); } catch {}
    const failure = Error('BRIDGE_HTTP_DENIED');
    failure.httpStatus = Number.isInteger(response.status) ? response.status : 0;
    if (capture) failure.credentialHeaders = capture.credentialHeaders;
    throw failure;
  }
  try { return await response.json(); } catch { throw Error('BRIDGE_RESPONSE_INVALID'); }
}

function publicRepositoryView(repository) {
  return {
    fullName: repository.full_name ?? null,
    private: repository.private === true,
    defaultBranch: repository.default_branch ?? null,
    archived: repository.archived === true,
    permissions: {
      pull: repository.permissions?.pull === true,
      push: repository.permissions?.push === true,
      maintain: repository.permissions?.maintain === true,
      admin: repository.permissions?.admin === true,
    },
  };
}

function publicWorkflowView(workflow) {
  return {
    id: workflow.id ?? null,
    name: workflow.name ?? null,
    path: workflow.path ?? null,
    state: workflow.state ?? null,
    createdAt: workflow.created_at ?? null,
    updatedAt: workflow.updated_at ?? null,
  };
}

function publicPullRequestView(pull) {
  if (!pull) return null;
  return {
    number: pull.number ?? null,
    state: pull.state ?? null,
    draft: pull.draft === true,
    headSha: typeof pull.head?.sha === 'string' && SHA_PATTERN.test(pull.head.sha) ? pull.head.sha : null,
    headRef: pull.head?.ref ?? null,
    baseRef: pull.base?.ref ?? null,
    baseSha: typeof pull.base?.sha === 'string' && SHA_PATTERN.test(pull.base.sha) ? pull.base.sha : null,
    mergeableState: pull.mergeable_state ?? null,
  };
}

// Read-only probe of the private CI surface. It never downloads source, diffs,
// issue bodies, comments, check-run output, or any credential-bearing value.
export async function probePrivateRepository({token, repository, sha, pr, fetchImpl = globalThis.fetch} = {}) {
  const base = {
    state: 'PROBED',
    repository: normalizeRepository(repository),
    sha: normalizeSha(sha),
    pullRequestNumber: normalizePr(pr),
    privateSourceFetched: false,
    inferencePerformed: false,
    refUpdated: false,
  };
  if (typeof token !== 'string' || !token.trim()) return {...base, state: 'BLOCKED', reason: 'WOLF_FACTORY_REPO_TOKEN_REQUIRED'};
  if (!/^[\x21-\x7e]+$/.test(token)) throw Error('BRIDGE_CREDENTIAL_FORMAT_INVALID');
  const result = {...base, observedAt: new Date().toISOString()};
  // Authorisation is decided by the private repository, not by /user. A
  // fine-grained PAT scoped to one repository returns 403 on /user even when it
  // is perfectly valid, so /user is only an identity hint.
  let identityCapture = {};
  try {
    const identity = await githubJson(`${API}/user`, {token, fetchImpl, capture: identityCapture});
    result.credentialIdentity = {login: typeof identity?.login === 'string' ? identity.login : null, type: identity?.type ?? null};
  } catch (error) {
    result.credentialIdentity = {state: 'NOT_APPLICABLE', httpStatus: error.httpStatus ?? 0};
  }
  let repoCapture = {};
  try {
    const repositoryMetadata = await githubJson(`${API}/repos/${result.repository}`, {token, fetchImpl, capture: repoCapture});
    result.repositoryMetadata = publicRepositoryView(repositoryMetadata);
    if (result.repositoryMetadata.fullName !== result.repository || result.repositoryMetadata.private !== true) {
      result.state = 'DENIED';
      result.reason = 'PRIVATE_REPOSITORY_IDENTITY_REQUIRED';
      return result;
    }
  } catch (error) {
    result.state = 'DENIED';
    result.reason = 'PRIVATE_REPOSITORY_DENIED';
    result.httpStatus = error.httpStatus ?? 0;
    result.detail = null;
    return result;
  }
  // The repository read succeeded: the credential is authorised for source.
  result.credential = {
    authorisedForRepository: true,
    ...(repoCapture.credentialHeaders ?? {}),
  };
  try {
    const commit = await githubJson(`${API}/repos/${result.repository}/commits/${result.sha}`, {token, fetchImpl});
    result.commit = {sha: commit?.sha === result.sha ? result.sha : null, present: commit?.sha === result.sha};
  } catch (error) {
    result.commit = {sha: null, present: false, httpStatus: error.httpStatus ?? 0};
  }
  if (result.pullRequestNumber) {
    try {
      const pull = await githubJson(`${API}/repos/${result.repository}/pulls/${result.pullRequestNumber}`, {token, fetchImpl});
      result.pullRequest = publicPullRequestView(pull);
    } catch (error) {
      result.pullRequest = {number: result.pullRequestNumber, state: 'DENIED', httpStatus: error.httpStatus ?? 0};
    }
  } else {
    result.pullRequest = null;
  }
  try {
    const workflows = await githubJson(`${API}/repos/${result.repository}/actions/workflows?per_page=100`, {token, fetchImpl});
    result.workflows = Array.isArray(workflows?.workflows) ? workflows.workflows.map(publicWorkflowView) : [];
    result.bridgeWorkflowInstalled = result.workflows.some(workflow => workflow.path === BRIDGE_WORKFLOW_PATH);
  } catch (error) {
    result.workflows = [];
    result.workflowsHttpStatus = error.httpStatus ?? 0;
    result.bridgeWorkflowInstalled = false;
  }
  try {
    const checks = await githubJson(`${API}/repos/${result.repository}/commits/${result.sha}/check-runs?per_page=100`, {token, fetchImpl});
    result.existingCheckRuns = summarizeCheckRuns(checks?.check_runs ?? []);
  } catch (error) {
    result.existingCheckRuns = [];
    result.existingCheckRunsHttpStatus = error.httpStatus ?? 0;
  }
  try {
    const protection = await githubJson(`${API}/repos/${result.repository}/branches/${result.repositoryMetadata.defaultBranch}/protection`, {token, fetchImpl});
    result.branchProtection = {
      requiredStatusChecks: protection?.required_status_checks?.contexts ?? null,
      strict: protection?.required_status_checks?.strict ?? null,
      enforcesAdmins: protection?.enforce_admins?.enabled ?? null,
    };
  } catch (error) {
    result.branchProtection = {state: 'UNAVAILABLE', httpStatus: error.httpStatus ?? 0};
  }
  try {
    const permissions = await githubJson(`${API}/repos/${result.repository}/actions/permissions`, {token, fetchImpl});
    result.actionsPermissions = {enabled: permissions?.enabled === true, allowedActions: permissions?.allowed_actions ?? null};
  } catch (error) {
    result.actionsPermissions = {state: 'UNAVAILABLE', httpStatus: error.httpStatus ?? 0};
  }
  result.state = result.commit.present ? 'PROBED' : 'DENIED';
  if (!result.commit.present) result.reason = 'PRIVATE_COMMIT_NOT_FOUND';
  return result;
}

// Publish a sanitized SHA-bound receipt as a check run. The summary is capped
// and redacted; it never contains source, logs, tokens, or private URLs.
export async function createCheckRun({token, repository, sha, name, conclusion = 'success', title, summary, detailsUrl, externalId, fetchImpl = globalThis.fetch, surface = 'public'}) {
  if (!['success', 'failure', 'neutral', 'cancelled', 'timed_out', 'skipped', 'action_required'].includes(conclusion)) throw Error('BRIDGE_CHECK_CONCLUSION_INVALID');
  const body = {
    name,
    head_sha: normalizeSha(sha),
    status: 'completed',
    conclusion,
    ...(detailsUrl ? {details_url: detailsUrl} : {}),
    ...(externalId ? {external_id: String(externalId).slice(0, 100)} : {}),
    output: {
      title: redact(title ?? name).slice(0, 255),
      summary: redact(summary ?? '', [token]).slice(0, 65535),
      annotations: [],
    },
  };
  // `surface` decides which allowlist applies: the public runner hosts the
  // sanitized receipt, the private repository hosts the authenticated check.
  const target = surface === 'private' ? normalizeRepository(repository) : normalizePublicRepository(repository);
  const created = await githubJson(`${API}/repos/${target}/check-runs`, {token, method: 'POST', body, fetchImpl});
  if (!Number.isSafeInteger(Number(created?.id)) || Number(created.id) <= 0
    || created.head_sha !== body.head_sha || created.name !== name
    || created.status !== 'completed' || created.conclusion !== conclusion) {
    throw Error('BRIDGE_CHECK_RUN_BINDING_MISMATCH');
  }
  return created;
}

// Diagnostic for the dispatch path. It performs the cheapest possible probe of
// each capability the dispatcher needs and reports the exact HTTP status plus
// the permissions GitHub says are required, so a minimal credential can be
// requested instead of broadening an existing one.
export async function diagnoseDispatch({token, repository, workflowId, fetchImpl = globalThis.fetch} = {}) {
  const result = {
    state: 'DIAGNOSED',
    repository: null,
    capabilities: {},
    requiredPermissions: [],
    refUpdated: false,
    privateSourceFetched: false,
    inferencePerformed: false,
  };
  let normalized;
  try {
    normalized = normalizeRepository(repository);
  } catch {
    return {...result, state: 'DENIED', reason: 'BRIDGE_REPOSITORY_DENIED'};
  }
  result.repository = normalized;
  const capture = {};
  const probe = async (url, {method = 'GET', body} = {}) => {
    try {
      const payload = await githubJson(url, {token, method, body, fetchImpl, capture});
      return {ok: true, httpStatus: 200, payload};
    } catch (error) {
      return {ok: false, httpStatus: error.httpStatus ?? 0};
    }
  };

  const repo = await probe(`${API}/repos/${normalized}`);
  result.capabilities.repositoryRead = {ok: repo.ok, httpStatus: repo.httpStatus};
  result.credentialPermissions = capture.credentialHeaders ?? null;

  const workflows = await probe(`${API}/repos/${normalized}/actions/workflows?per_page=100`);
  result.capabilities.workflowsRead = {ok: workflows.ok, httpStatus: workflows.httpStatus};
  const listed = Array.isArray(workflows.payload?.workflows) ? workflows.payload.workflows : [];
  result.capabilities.workflowCount = listed.length;
  const target = listed.find(workflow => workflow.id === workflowId) ?? null;
  result.capabilities.workflowIdPresent = Boolean(target);
  if (target) result.capabilities.workflowPath = target.path;

  const runs = await probe(`${API}/repos/${normalized}/actions/runs?per_page=1`);
  result.capabilities.runsRead = {ok: runs.ok, httpStatus: runs.httpStatus};

  // A read-only Contents credential cannot dispatch: the endpoint needs the
  // Actions permission. This probe records the observable status only; it never
  // attempts a write.
  if (workflowId) {
    const dispatch = await probe(`${API}/repos/${normalized}/actions/workflows/${workflowId}/dispatches`, {
      method: 'POST',
      body: {ref: 'main', inputs: {probe: 'false'}},
    });
    result.capabilities.dispatchWrite = {ok: dispatch.ok, httpStatus: dispatch.httpStatus, attempted: true};
  } else {
    result.capabilities.dispatchWrite = {ok: false, httpStatus: null, attempted: false, reason: 'WORKFLOW_ID_REQUIRED'};
  }

  if (!result.capabilities.dispatchWrite.ok) {
    result.requiredPermissions = ['actions: write'];
    result.reason = 'ACTIONS_WRITE_REQUIRED';
  }
  return result;
}

// Publish the receipt's check runs directly onto the private commit. This is
// the only operation in the bridge that writes to the private repository, so it
// uses a *separate* credential (WOLF_FACTORY_STATUS_TOKEN) from the source
// reader. If that credential is absent the bridge fails closed and names the
// exact permission required rather than silently degrading.
export const PRIVATE_STATUS_PERMISSION = 'checks: write (Checks: write on donraposo1-source/project-wolf)';

export async function publishPrivateStatusChecks({statusToken, sourceToken, statusIdentity, repository, sha, names, conclusion, summary, externalId, fetchImpl = globalThis.fetch, detailsUrl} = {}) {
  const normalizedRepository = normalizeRepository(repository);
  const normalizedSha = normalizeSha(sha);
  const base = {
    repository: normalizedRepository,
    sha: normalizedSha,
    // Which identity published. `app-installation` means no PAT was involved.
    statusIdentity: statusIdentity ?? 'unknown',
    identitySeparation: 'source-read and status-write are distinct credentials',
    privateSourcePublished: false,
    inferencePerformed: false,
  };
  if (typeof statusToken !== 'string' || !statusToken.trim()) {
    // No STATUS PAT is needed once the App can issue a checks:write installation
    // token: the App *is* the separate status-write identity, so the requirement
    // is satisfied by a different mechanism rather than dropped.
    return {
      ...base,
      state: 'BLOCKED',
      reason: 'PRIVATE_STATUS_TOKEN_REQUIRED',
      requiredPermission: PRIVATE_STATUS_PERMISSION,
      alternatives: [
        'WOLF_CI_APP_PUBLISHER_TOKEN minted from the App installation (checks:write)',
        'WOLF_FACTORY_STATUS_TOKEN with checks:write on the private repository',
      ],
    };
  }
  if (typeof sourceToken === 'string' && sourceToken.trim() && sourceToken === statusToken) {
    // Reusing the reader for a write would widen what the read credential can do.
    return {...base, state: 'DENIED', reason: 'STATUS_TOKEN_MUST_DIFFER_FROM_SOURCE_TOKEN'};
  }
  if (!Array.isArray(names) || !names.length) return {...base, state: 'DENIED', reason: 'CHECK_NAMES_REQUIRED'};
  const results = [];
  for (const name of names) {
    const checkName = String(name).slice(0, 100);
    try {
      const created = await createCheckRun({token: statusToken, repository: normalizedRepository, sha: normalizedSha, name: checkName, conclusion, title: 'Wolf private CI', summary, externalId, detailsUrl, fetchImpl, surface: 'private'});
      results.push({name: checkName, state: 'CREATED', id: created?.id ?? null});
    } catch (error) {
      const httpStatus = error?.httpStatus ?? 0;
      const reason = httpStatus === 403 || httpStatus === 404
        ? 'PRIVATE_STATUS_PERMISSION_REQUIRED'
        : httpStatus === 401 ? 'PRIVATE_STATUS_TOKEN_REJECTED' : (error?.message ?? 'PRIVATE_STATUS_FAILED');
      return {...base, state: reason === 'PRIVATE_STATUS_PERMISSION_REQUIRED' ? 'BLOCKED' : 'FAILED', reason, httpStatus, requiredPermission: PRIVATE_STATUS_PERMISSION, results};
    }
  }
  return {...base, state: 'PUBLISHED', results, privateStatusWritten: true};
}

// Dispatch the private-side executor. The target workflow is addressed by its
// immutable numeric id, and the immutable commit SHA is the only source ref.
export async function dispatchPrivateCi({token, repository, workflowId, ref, sha, pr, baseRef, checks, mode = 'execute', fetchImpl = globalThis.fetch} = {}) {
  const normalizedRepository = normalizeRepository(repository);
  const normalizedSha = normalizeSha(sha);
  if (!Number.isSafeInteger(workflowId) || workflowId <= 0) throw Error('BRIDGE_WORKFLOW_ID_REQUIRED');
  if (typeof ref !== 'string' || !ref.trim() || ref.length > 255) throw Error('BRIDGE_REF_REQUIRED');
  const inputs = {
    sha: normalizedSha,
    repository: normalizedRepository,
    ...(pr ? {pr: String(normalizePr(pr))} : {}),
    ...(baseRef ? {base_ref: baseRef} : {}),
    checks: normalizeChecks(checks).join(','),
    mode: normalizeMode(mode),
  };
  await githubJson(`${API}/repos/${normalizedRepository}/actions/workflows/${workflowId}/dispatches`, {
    token,
    method: 'POST',
    body: {ref, inputs},
    fetchImpl,
  });
  return {state: 'DISPATCHED', repository: normalizedRepository, workflowId, ref, sha: normalizedSha, inputs, refUpdated: false, privateSourceFetched: false};
}

// Verify the receipt that the private-side executor attached to the exact SHA.
// A missing or mismatched SHA is always a hard failure.
export function verifyReceiptBinding(receipt, {sha, repository, checks, signingKey, expectedTreeSha, missionId, reservationKey} = {}) {
  const normalizedSha = normalizeSha(sha);
  const normalizedRepository = normalizeRepository(repository);
  let required;
  try {
    required = normalizeChecks(checks ?? ALL_REQUIRED_CHECKS.join(','));
  } catch {
    return {state: 'REJECTED', reason: 'RECEIPT_CHECKS_INVALID'};
  }
  if (required.length !== ALL_REQUIRED_CHECKS.length || ALL_REQUIRED_CHECKS.some(name => !required.includes(name))) {
    return {state: 'REJECTED', reason: 'RECEIPT_REQUIRED_CHECK_CONTRACT_MISMATCH'};
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return {state: 'REJECTED', reason: 'RECEIPT_REQUIRED'};
  if (receipt.schema !== 'wolf.private-ci.receipt/v1') return {state: 'REJECTED', reason: 'RECEIPT_SCHEMA_UNSUPPORTED'};
  // Authenticate before interpreting any claimed result. A tampered receipt must
  // not be allowed to produce a more favorable semantic error or pass path.
  const signature = verifyReceiptSignature(receipt, signingKey);
  if (!signature.valid) return {state: 'REJECTED', reason: signature.reason};
  if (!['VERIFIED', 'FAILED'].includes(receipt.state)) return {state: 'REJECTED', reason: 'RECEIPT_STATE_INVALID'};
  if (receipt.sha !== normalizedSha) return {state: 'REJECTED', reason: 'RECEIPT_SHA_MISMATCH'};
  if (receipt.repository !== normalizedRepository) return {state: 'REJECTED', reason: 'RECEIPT_REPOSITORY_MISMATCH'};
  if (!SHA_PATTERN.test(String(receipt.treeSha ?? ''))) return {state: 'REJECTED', reason: 'RECEIPT_TREE_SHA_REQUIRED'};
  if (expectedTreeSha && receipt.treeSha !== expectedTreeSha) return {state: 'REJECTED', reason: 'RECEIPT_TREE_SHA_MISMATCH'};
  const checkout = receipt.checkout;
  if (!checkout || checkout.sha !== normalizedSha || checkout.treeSha !== receipt.treeSha || checkout.cleanBefore !== true) {
    return {state: 'REJECTED', reason: 'RECEIPT_CHECKOUT_BINDING_MISMATCH'};
  }
  if (checkout.finalSha !== null && checkout.finalSha !== normalizedSha) return {state: 'REJECTED', reason: 'RECEIPT_CHECKOUT_FINAL_SHA_MISMATCH'};
  if (checkout.finalTreeSha !== null && checkout.finalTreeSha !== receipt.treeSha) return {state: 'REJECTED', reason: 'RECEIPT_CHECKOUT_FINAL_TREE_MISMATCH'};
  if (receipt.state === 'VERIFIED' && (checkout.cleanAfter !== true || checkout.finalSha !== normalizedSha || checkout.finalTreeSha !== receipt.treeSha || receipt.sourceIntegrityFailure !== null)) {
    return {state: 'REJECTED', reason: 'RECEIPT_VERIFIED_WITH_DIRTY_CHECKOUT'};
  }
  const startedMs = Date.parse(String(receipt.startedAt ?? ''));
  const completedMs = Date.parse(String(receipt.completedAt ?? ''));
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs) || completedMs < startedMs) {
    return {state: 'REJECTED', reason: 'RECEIPT_TIMESTAMPS_INVALID'};
  }
  if (receipt.testBinding?.sha !== normalizedSha || receipt.testBinding?.treeSha !== receipt.treeSha) {
    return {state: 'REJECTED', reason: 'RECEIPT_TEST_BINDING_MISMATCH'};
  }
  const mission = receipt.missionBinding;
  if (!mission || typeof mission.missionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(mission.missionId) || !/^[a-f0-9]{64}$/.test(String(mission.reservationKey ?? '')) || mission.sha !== normalizedSha) {
    return {state: 'REJECTED', reason: 'RECEIPT_MISSION_BINDING_REQUIRED'};
  }
  if (missionId && mission.missionId !== missionId) return {state: 'REJECTED', reason: 'RECEIPT_MISSION_ID_MISMATCH'};
  if (reservationKey && mission.reservationKey !== reservationKey) return {state: 'REJECTED', reason: 'RECEIPT_MISSION_RESERVATION_MISMATCH'};
  const boundChecks = Array.isArray(receipt.testBinding?.checks) ? receipt.testBinding.checks : [];
  if (new Set(boundChecks).size !== boundChecks.length || boundChecks.length !== required.length || required.some(name => !boundChecks.includes(name))) {
    return {state: 'REJECTED', reason: 'RECEIPT_TEST_CHECKS_MISMATCH'};
  }
  const expectedRequired = required.filter(name => DEFAULT_REQUIRED_CHECKS.includes(name));
  const expectedExtra = required.filter(name => !DEFAULT_REQUIRED_CHECKS.includes(name));
  if (!Array.isArray(receipt.requiredChecks) || !Array.isArray(receipt.extraChecks)
    || receipt.requiredChecks.length !== expectedRequired.length || expectedRequired.some((name, index) => receipt.requiredChecks[index] !== name)
    || receipt.extraChecks.length !== expectedExtra.length || expectedExtra.some((name, index) => receipt.extraChecks[index] !== name)) {
    return {state: 'REJECTED', reason: 'RECEIPT_CHECK_CATEGORIES_MISMATCH'};
  }
  if (!Array.isArray(receipt.checks)) return {state: 'REJECTED', reason: 'RECEIPT_CHECKS_REQUIRED'};
  const names = receipt.checks.map(check => String(check?.name ?? '').toLowerCase());
  if (new Set(names).size !== names.length) return {state: 'REJECTED', reason: 'RECEIPT_CHECKS_DUPLICATED'};
  const missing = required.filter(name => !names.includes(name));
  const unexpected = names.filter(name => !required.includes(name));
  if (missing.length) return {state: 'REJECTED', reason: 'RECEIPT_CHECKS_MISSING', missing};
  if (unexpected.length) return {state: 'REJECTED', reason: 'RECEIPT_CHECKS_UNEXPECTED', unexpected};
  const mismatched = receipt.checks.filter(check => check.sha !== normalizedSha || check.treeSha !== receipt.treeSha).map(check => check.name);
  if (mismatched.length) return {state: 'REJECTED', reason: 'RECEIPT_CHECK_SOURCE_MISMATCH', mismatched};
  const unsuccessful = receipt.checks.filter(check => check.status !== 'success').map(check => check.name);
  const failedChecks = Array.isArray(receipt.failedChecks) ? receipt.failedChecks : null;
  if (!failedChecks || failedChecks.some(name => typeof name !== 'string') || new Set(failedChecks).size !== failedChecks.length) {
    return {state: 'REJECTED', reason: 'RECEIPT_FAILED_CHECKS_REQUIRED'};
  }
  if (!Object.hasOwn(receipt, 'sourceIntegrityFailure') || (receipt.sourceIntegrityFailure !== null && typeof receipt.sourceIntegrityFailure !== 'string')) {
    return {state: 'REJECTED', reason: 'RECEIPT_SOURCE_INTEGRITY_FIELD_INVALID'};
  }
  const expectedFailedChecks = [...unsuccessful];
  if (receipt.sourceIntegrityFailure !== null) expectedFailedChecks.push('source-integrity');
  if (failedChecks.length !== expectedFailedChecks.length || [...failedChecks].sort().some((name, index) => name !== [...expectedFailedChecks].sort()[index])) {
    return {state: 'REJECTED', reason: 'RECEIPT_FAILED_CHECKS_MISMATCH'};
  }
  if (receipt.state === 'VERIFIED' && (unsuccessful.length || failedChecks.length || receipt.failure !== null || receipt.sourceIntegrityFailure !== null)) {
    return {state: 'REJECTED', reason: 'RECEIPT_VERIFIED_WITH_FAILURE', unsuccessful};
  }
  if (receipt.state === 'FAILED' && (!expectedFailedChecks.length || typeof receipt.failure !== 'string' || !receipt.failure.trim())) {
    return {state: 'REJECTED', reason: 'RECEIPT_FAILED_WITHOUT_FAILURE'};
  }
  return {
    state: receipt.state,
    ...(receipt.state === 'FAILED' ? {reason: 'RECEIPT_RUN_FAILED'} : {}),
    sha: normalizedSha,
    treeSha: receipt.treeSha,
    repository: normalizedRepository,
    checks: required,
    unsuccessful,
    failedChecks,
    receiptHash: signature.receiptHash,
    signatureAlgorithm: signature.algorithm,
  };
}

function writeProbeOutput(result) {
  const output = process.env.WOLF_CI_PROBE_OUTPUT;
  if (!output) return;
  fs.mkdirSync(path.dirname(output), {recursive: true, mode: 0o700});
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
}

async function publishProbeCheckRun(result) {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  if (!token || !repository || !sha) return {state: 'SKIPPED', reason: 'CHECK_RUN_CONTEXT_REQUIRED'};
  const summary = JSON.stringify(result, null, 2);
  await createCheckRun({
    token,
    repository,
    sha,
    name: 'wolf-private-ci-probe',
    conclusion: result.state === 'PROBED' ? 'success' : 'failure',
    title: 'Private CI bridge read-only probe',
    summary,
    detailsUrl: process.env.WOLF_CI_PROBE_DETAILS_URL || undefined,
  });
  return {state: 'PUBLISHED'};
}

async function main(argv) {
  const [command] = argv;
  if (command === 'probe') {
    const token = process.env.WOLF_FACTORY_REPO_TOKEN;
    const result = await probePrivateRepository({
      token,
      repository: process.env.WOLF_CI_REPOSITORY,
      sha: process.env.WOLF_CI_SHA,
      pr: process.env.WOLF_CI_PR,
    });
    writeProbeOutput(result);
    try {
      result.checkRun = await publishProbeCheckRun(result);
    } catch (error) {
      result.checkRun = {state: 'FAILED', httpStatus: error.httpStatus ?? 0, reason: error.message === 'BRIDGE_HTTP_DENIED' ? 'CHECK_RUN_DENIED' : 'CHECK_RUN_FAILED'};
    }
    process.stdout.write(JSON.stringify(result) + '\n');
    return result.state === 'PROBED' ? BRIDGE_EXIT.OK : BRIDGE_EXIT.DENIED;
  }
  if (command === 'publish-private-status') {
    const receiptPath = process.env.WOLF_CI_RECEIPT;
    if (!receiptPath || !fs.existsSync(receiptPath)) {
      process.stdout.write(JSON.stringify({state: 'BLOCKED', reason: 'RECEIPT_REQUIRED', requiredPermission: PRIVATE_STATUS_PERMISSION}) + '\n');
      return BRIDGE_EXIT.OK;
    }
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const verification = verifyReceiptBinding(receipt, {
      sha: process.env.WOLF_CI_SHA,
      repository: process.env.WOLF_CI_REPOSITORY,
      checks: process.env.WOLF_CI_CHECKS,
      signingKey: process.env.WOLF_CI_RECEIPT_SIGNING_KEY,
      missionId: process.env.WOLF_CI_MISSION_ID,
      reservationKey: process.env.WOLF_CI_MISSION_RESERVATION,
    });
    if (!['VERIFIED', 'FAILED'].includes(verification.state)) {
      process.stdout.write(JSON.stringify({state: 'BLOCKED', reason: 'RECEIPT_NOT_AUTHENTIC', verification: {state: verification.state, reason: verification.reason}, privateStatusWritten: false}) + '\n');
      return BRIDGE_EXIT.OK;
    }
    const appPublisherToken = process.env.WOLF_CI_APP_PUBLISHER_TOKEN;
    // Once the fallback is retired, a missing App token is a hard stop. Falling
    // through to the PAT here would leave the receipt claiming retirement while the
    // PAT quietly did the work.
    const retired = String(process.env.WOLF_CI_RETIRE_PAT ?? '').toLowerCase() === 'true';
    if (retired && !appPublisherToken) {
      const blocked = {
        state: 'BLOCKED',
        reason: 'PAT_FALLBACK_RETIRED',
        requiredPermission: 'WOLF_CI_APP_PUBLISHER_TOKEN (checks:write)',
        identitySeparation: 'source-read and status-write are distinct credentials',
        retired: true,
        credentialsPrinted: false,
      };
      process.stdout.write(JSON.stringify(blocked) + '\n');
      return BRIDGE_EXIT.OK;
    }
    const result = await publishPrivateStatusChecks({
      // The App-issued publisher token is preferred; the status PAT remains a
      // fallback until the App can publish. Never both.
      statusToken: appPublisherToken || process.env.WOLF_FACTORY_STATUS_TOKEN,
      statusIdentity: appPublisherToken ? 'app-installation' : process.env.WOLF_FACTORY_STATUS_TOKEN ? 'status-pat' : 'none',
      sourceToken: process.env.WOLF_FACTORY_REPO_TOKEN,
      repository: process.env.WOLF_CI_REPOSITORY,
      sha: process.env.WOLF_CI_SHA,
      names: [`wolf-private-ci-${process.env.WOLF_CI_PR ?? 'head'}`],
      conclusion: verification.state === 'VERIFIED' ? 'success' : 'failure',
      externalId: process.env.GITHUB_RUN_ID,
      summary: 'Authenticated SHA-bound private CI receipt: ' + verification.state + ' (' + (receipt.receiptHash ?? '').slice(0, 16) + ')',
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    return BRIDGE_EXIT.OK;
  }
  if (command === 'diagnose-dispatch') {
    const result = await diagnoseDispatch({
      token: process.env.WOLF_FACTORY_REPO_TOKEN,
      repository: process.env.WOLF_CI_REPOSITORY,
      workflowId: Number(process.env.WOLF_CI_WORKFLOW_ID) || 0,
    });
    if (process.env.WOLF_CI_PROBE_OUTPUT) writeProbeOutput(result);
    process.stdout.write(JSON.stringify(result) + '\n');
    return BRIDGE_EXIT.OK;
  }
  if (command === 'dispatch') {
    const result = await dispatchPrivateCi({
      token: process.env.WOLF_FACTORY_REPO_TOKEN,
      repository: process.env.WOLF_CI_REPOSITORY,
      workflowId: Number(process.env.WOLF_CI_WORKFLOW_ID),
      ref: process.env.WOLF_CI_REF,
      sha: process.env.WOLF_CI_SHA,
      pr: process.env.WOLF_CI_PR,
      baseRef: process.env.WOLF_CI_BASE_REF,
      checks: process.env.WOLF_CI_CHECKS,
      mode: process.env.WOLF_CI_MODE,
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    return BRIDGE_EXIT.OK;
  }
  if (command === 'publish-comment') {
    const token = process.env.GITHUB_TOKEN;
    const repository = process.env.GITHUB_REPOSITORY;
    const sha = process.env.GITHUB_SHA;
    const output = process.env.WOLF_CI_PROBE_OUTPUT;
    if (!token || !repository || !sha || !output) {
      process.stderr.write(JSON.stringify({state: 'FAILED', reason: 'PUBLIC_RECEIPT_CONTEXT_REQUIRED'}) + '\n');
      return BRIDGE_EXIT.CONFIGURATION_REQUIRED;
    }
    const result = JSON.parse(fs.readFileSync(output, 'utf8'));
    const publicSummary = {
      state: result.state,
      reason: result.reason ?? null,
      repository: result.repository,
      sha: result.sha,
      pullRequestNumber: result.pullRequestNumber ?? null,
      commitPresent: result.commit?.present === true,
      pullRequestPresent: result.pullRequest?.headSha === result.sha,
      bridgeWorkflowInstalled: result.bridgeWorkflowInstalled === true,
      workflowCount: Array.isArray(result.workflows) ? result.workflows.length : 0,
      existingCheckRuns: Array.isArray(result.existingCheckRuns) ? result.existingCheckRuns.map(run => ({name: run.name, conclusion: run.conclusion})) : [],
      branchProtectionRequiredChecks: Array.isArray(result.branchProtection?.requiredStatusChecks) ? result.branchProtection.requiredStatusChecks : null,
      actionsPermissions: result.actionsPermissions?.state === 'UNAVAILABLE' ? 'UNAVAILABLE' : result.actionsPermissions ?? null,
      credentialIdentity: result.credentialIdentity ?? null,
      httpStatus: result.httpStatus ?? null,
      detail: typeof result.detail === 'string' ? redact(result.detail).slice(0, 4000) : null,
      credentialHttpStatus: result.credentialIdentity?.httpStatus ?? null,
      workflowsHttpStatus: result.workflowsHttpStatus ?? null,
      existingCheckRunsHttpStatus: result.existingCheckRunsHttpStatus ?? null,
      branchProtectionHttpStatus: result.branchProtection?.httpStatus ?? null,
      actionsPermissionsHttpStatus: result.actionsPermissions?.httpStatus ?? null,
      privateSourceFetched: false,
      inferencePerformed: false,
    };
    await githubJson(`${API}/repos/${repository}/commits/${sha}/comments`, {
      token,
      method: 'POST',
      body: {body: '```json\n' + JSON.stringify(publicSummary, null, 2) + '\n```'},
    });
    process.stdout.write(JSON.stringify({state: 'PUBLISHED', ...publicSummary}) + '\n');
    return BRIDGE_EXIT.OK;
  }
  if (command === 'secret-inventory') {
    const names = String(process.env.WOLF_CI_SECRET_NAMES ?? '')
      .split(',').map(name => name.trim()).filter(Boolean);
    const inventory = names.map(name => ({name, present: String(process.env[name] ?? '').length > 0}));
    const summary = {state: 'INVENTORIED', inventory, privateSourceFetched: false, inferencePerformed: false};
    const token = process.env.GITHUB_TOKEN;
    const repository = process.env.GITHUB_REPOSITORY;
    const sha = process.env.GITHUB_SHA;
    if (token && repository && sha) {
      await githubJson(`${API}/repos/${repository}/commits/${sha}/comments`, {
        token,
        method: 'POST',
        body: {body: '```json\n' + JSON.stringify(summary, null, 2) + '\n```'},
      });
    }
    process.stdout.write(JSON.stringify(summary) + '\n');
    return BRIDGE_EXIT.OK;
  }
  if (command === 'publish-receipt') {
    const token = process.env.GITHUB_TOKEN;
    const repository = process.env.GITHUB_REPOSITORY;
    const sha = process.env.GITHUB_SHA;
    const receiptPath = process.env.WOLF_CI_RECEIPT;
    if (!token || !repository || !sha || !receiptPath) {
      process.stderr.write(JSON.stringify({state: 'FAILED', reason: 'RECEIPT_PUBLICATION_CONTEXT_REQUIRED'}) + '\n');
      return BRIDGE_EXIT.CONFIGURATION_REQUIRED;
    }
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const verification = verifyReceiptBinding(receipt, {
      sha: process.env.WOLF_CI_SHA,
      repository: process.env.WOLF_CI_REPOSITORY,
      checks: process.env.WOLF_CI_CHECKS,
      signingKey: process.env.WOLF_CI_RECEIPT_SIGNING_KEY,
      missionId: process.env.WOLF_CI_MISSION_ID,
      reservationKey: process.env.WOLF_CI_MISSION_RESERVATION,
    });
    const authenticatedReceipt = ['VERIFIED', 'FAILED'].includes(verification.state);
    const publishedState = authenticatedReceipt ? verification.state : 'BLOCKED';
    // The private-side publication is recorded by the previous step so its
    // real outcome (never silently "success") is part of the public receipt.
    const privatePublication = process.env.WOLF_CI_PRIVATE_PUBLICATION_FILE && fs.existsSync(process.env.WOLF_CI_PRIVATE_PUBLICATION_FILE)
      ? (() => { try { return JSON.parse(fs.readFileSync(process.env.WOLF_CI_PRIVATE_PUBLICATION_FILE, 'utf8')); } catch { return {state: 'UNREADABLE'}; } })()
      : {state: 'NOT_REPORTED'};
    const summary = {
      state: publishedState,
      repository: authenticatedReceipt ? receipt.repository : process.env.WOLF_CI_REPOSITORY,
      sha: authenticatedReceipt ? receipt.sha : process.env.WOLF_CI_SHA,
      pullRequestNumber: process.env.WOLF_CI_PR ? Number(process.env.WOLF_CI_PR) : null,
      receiptHash: authenticatedReceipt ? receipt.receiptHash : null,
      targetVerification: {state: verification.state, reason: verification.reason ?? null},
      checks: authenticatedReceipt ? sanitizeReceiptChecks(receipt.checks) : [],
      authentication: readAuthenticationPosture(process.env.WOLF_CI_APP_AUTH_FILE),
      dispatchVerification: reconcileDispatch({
        probe: readDispatchVerification(process.env.WOLF_CI_DISPATCH_FILE),
        acceptance: readAcceptance(process.env.WOLF_CI_ACCEPTANCE_FILE),
      }),
      authRecovery: readAuthRecovery(process.env.WOLF_CI_AUTH_RECOVERY_FILE),
      appAcceptance: readAcceptance(process.env.WOLF_CI_ACCEPTANCE_FILE),
      // Read from the artefact the enforcement step wrote, so the receipt shows the
      // decision that actually took effect rather than a second, independent
      // recomputation that could disagree with it.
      fallbackRetirement: readRetirementArtefact(process.env.WOLF_CI_RETIREMENT_FILE, {
        acceptance: readAcceptance(process.env.WOLF_CI_ACCEPTANCE_FILE),
        authentication: readAuthenticationPosture(process.env.WOLF_CI_APP_AUTH_FILE),
        renewal: readAuthRecovery(process.env.WOLF_CI_AUTH_RECOVERY_FILE),
      }),
      privateStatusCheck: (() => {
        const file = process.env.WOLF_CI_PRIVATE_STATUS_FILE;
        if (!file || !fs.existsSync(file)) return {state: 'NOT_REPORTED'};
        try {
          const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
          return {
            state: parsed.state ?? 'UNKNOWN',
            ...(parsed.reason ? {reason: parsed.reason} : {}),
            ...(parsed.requiredPermission ? {requiredPermission: parsed.requiredPermission} : {}),
            ...(parsed.identitySeparation ? {identitySeparation: parsed.identitySeparation} : {}),
          };
        } catch {
          return {state: 'UNREADABLE'};
        }
      })(),
      privateReceipt: {
        state: privatePublication.state ?? 'NOT_REPORTED',
        ...(privatePublication.reason ? {reason: privatePublication.reason} : {}),
        ...(privatePublication.branch ? {branch: privatePublication.branch} : {}),
      },
      privateLogsPublished: false,
      privateSourcePublished: false,
      inferencePerformed: false,
      refUpdated: false,
    };
    // The check run is the status surface the private commit would normally
    // have. It is created first so its outcome is recorded in the receipt
    // comment that follows, instead of being silently discarded.
    let checkRun = {state: 'NOT_CREATED'};
    try {
      const created = await createCheckRun({
        token,
        repository,
        sha,
        name: `wolf-private-ci-${summary.pullRequestNumber ?? 'head'}`,
        conclusion: summary.state === 'VERIFIED' ? 'success' : 'failure',
        externalId: process.env.GITHUB_RUN_ID,
        title: 'Private CI bridge authenticated SHA-bound receipt',
        summary: 'Authenticated SHA-bound private CI receipt: ' + summary.state + (verification.reason ? ' (' + verification.reason + ')' : ''),
      });
      checkRun = {state: 'CREATED', id: created?.id ?? null};
    } catch (error) {
      checkRun = {
        state: 'FAILED',
        reason: redact(error?.message ?? 'CHECK_RUN_FAILED').slice(0, 120),
        httpStatus: error?.httpStatus ?? null,
      };
    }
    summary.checkRun = checkRun;
    const body = '```json\n' + JSON.stringify(summary, null, 2) + '\n```';
    await githubJson(`${API}/repos/${repository}/commits/${sha}/comments`, {token, method: 'POST', body: {body}});
    process.stdout.write(JSON.stringify({state: 'PUBLISHED', ...summary}) + '\n');
    return verification.state === 'VERIFIED' ? BRIDGE_EXIT.OK : verification.state === 'FAILED' ? BRIDGE_EXIT.DEFECT : BRIDGE_EXIT.DENIED;
  }
  if (command === 'verify-receipt') {
    const receiptPath = process.env.WOLF_CI_RECEIPT;
    const receipt = receiptPath ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : null;
    const result = verifyReceiptBinding(receipt, {
      sha: process.env.WOLF_CI_SHA,
      repository: process.env.WOLF_CI_REPOSITORY,
      checks: process.env.WOLF_CI_CHECKS,
      signingKey: process.env.WOLF_CI_RECEIPT_SIGNING_KEY,
      missionId: process.env.WOLF_CI_MISSION_ID,
      reservationKey: process.env.WOLF_CI_MISSION_RESERVATION,
      expectedTreeSha: process.env.WOLF_CI_EXPECTED_TREE_SHA,
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    return result.state === 'VERIFIED' ? BRIDGE_EXIT.OK : BRIDGE_EXIT.DENIED;
  }
  process.stderr.write(JSON.stringify({state: 'FAILED', reason: 'BRIDGE_COMMAND_REQUIRED'}) + '\n');
  return BRIDGE_EXIT.DEFECT;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    const allowed = [
      'BRIDGE_REPOSITORY_DENIED', 'BRIDGE_SHA_MALFORMED', 'BRIDGE_CHECKS_REQUIRED', 'BRIDGE_CHECK_DENIED',
      'BRIDGE_PR_MALFORMED', 'BRIDGE_MODE_DENIED', 'BRIDGE_CREDENTIAL_FORMAT_INVALID', 'BRIDGE_NETWORK_FAILED',
      'BRIDGE_HTTP_DENIED', 'BRIDGE_RESPONSE_INVALID', 'BRIDGE_WORKFLOW_ID_REQUIRED', 'BRIDGE_REF_REQUIRED',
      'BRIDGE_CHECK_CONCLUSION_INVALID',
    ];
    const failure = {state: 'FAILED', reason: allowed.includes(error?.message) ? error.message : 'BRIDGE_FAILED', httpStatus: Number.isInteger(error?.httpStatus) ? error.httpStatus : 0, privateSourceFetched: false, inferencePerformed: false};
    if (command === 'probe' && process.env.WOLF_CI_PROBE_OUTPUT) {
      try {
        fs.mkdirSync(path.dirname(process.env.WOLF_CI_PROBE_OUTPUT), {recursive: true, mode: 0o700});
        fs.writeFileSync(process.env.WOLF_CI_PROBE_OUTPUT, JSON.stringify(failure, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
      } catch {}
    }
    process.stderr.write(JSON.stringify(failure) + '\n');
    process.exitCode = BRIDGE_EXIT.DEFECT;
  }
}
