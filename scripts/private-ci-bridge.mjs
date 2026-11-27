// Secure CI bridge for private Wolf commits.
//
// The public repository never receives private source. This module only reads
// non-sensitive GitHub metadata, dispatches the private-side executor, and
// publishes SHA-bound receipts. Every credential is used in memory, never
// printed, never persisted, and never placed in a URL or process argument.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {credentialForRole, decideFallbackRetirement} from './private-ci-app-auth.mjs';

export const BRIDGE_REPOSITORIES = Object.freeze(['donraposo1-source/project-wolf']);
// The runner that hosts this bridge. It is only ever touched to publish the
// sanitized receipt and a status check run; no private source reaches it.
export const BRIDGE_PUBLIC_REPOSITORIES = Object.freeze(['insidethemarginmedia-cpu/wolf-factory-home']);
export const DEFAULT_REQUIRED_CHECKS = Object.freeze(['security', 'lint', 'typecheck', 'unit', 'integration', 'build']);
export const BRIDGE_WORKFLOW_PATH = '.github/workflows/private-ci-bridge.yml';
export const SHA_PATTERN = /^[a-f0-9]{40}$/;
export const PR_PATTERN = /^[1-9][0-9]*$/;

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
export function readRetirementPersistence(file) {
  const parsed = readJsonArtefact(file);
  if (parsed === null) return {state: 'NOT_REPORTED'};
  if (parsed === 'UNREADABLE') return {state: 'UNREADABLE'};
  return {
    state: parsed.state ?? 'UNKNOWN',
    reason: parsed.reason ?? null,
    branch: parsed.branch ?? null,
    ledgerPath: parsed.ledgerPath ?? null,
    anchorPath: parsed.anchorPath ?? null,
    appended: parsed.appended === true,
    alreadyRecordedForRun: parsed.alreadyRecordedForRun === true,
    ledgerStored: parsed.ledgerStored === true,
    anchorStored: parsed.anchorStored === true,
    anchorConsistent: parsed.anchorConsistent === true,
    integrity: parsed.integrity ?? null,
    head: parsed.head ?? null,
    sequence: Number.isSafeInteger(parsed.sequence) ? parsed.sequence : null,
    recordCount: Number.isSafeInteger(parsed.recordCount) ? parsed.recordCount : null,
    trustModel: parsed.trustModel ?? null,
    independentVerifierRequired: parsed.independentVerifierRequired === true,
    credentialsPrinted: false,
  };
}

export function readDurableLedgerProof(file) {
  const parsed = readJsonArtefact(file);
  if (parsed === null) return {state: 'NOT_REPORTED'};
  if (parsed === 'UNREADABLE') return {state: 'UNREADABLE'};
  const observed = parsed.enforcedByDurableRetirement === true;
  const fallbackWithheld = parsed.patFallbackDenied === true;
  return {
    state: observed ? 'OBSERVED_RETIRED'
      : fallbackWithheld ? 'FALLBACK_WITHHELD_NOT_PROVEN_RETIRED'
        : 'NOT_PROVEN',
    ledgerState: parsed.ledger?.state ?? null,
    retired: parsed.ledger?.retired === true,
    anchorState: parsed.anchor?.state ?? null,
    perRunFlagPresent: parsed.perRunFlagPresent === true,
    patFallbackDenied: fallbackWithheld,
    enforcedByDurableRetirement: observed,
    selectorSource: parsed.selector?.source ?? null,
    selectorReason: parsed.selector?.reason ?? null,
    credentialsPrinted: false,
  };
}

const SAFE_MISSION_ADMISSION_REASONS = new Set([
  'GITHUB_TOKEN_REQUIRED',
  'CONTROLLER_REPOSITORY_REQUIRED',
  'MISSION_ID_INVALID',
  'MISSION_SHA_INVALID',
  'MISSION_REPOSITORY_INVALID',
  'MISSION_BINDING_INVALID',
  'EXECUTOR_SHA_INVALID',
  'DELIVERY_ID_INVALID',
  'GITHUB_RUN_ID_REQUIRED',
  'ADMISSION_BRANCH_UNAVAILABLE',
  'ADMISSION_EVIDENCE_UNAVAILABLE',
  'ADMISSION_LEDGER_NOT_INTACT',
  'ADMISSION_ANCHOR_MISMATCH',
  'ADMISSION_ANCHOR_STALE',
  'ADMISSION_RECORD_NOT_FOUND',
  'ADMISSION_VERIFICATION_FAILED',
]);

/** Whitelist the read-only admission-gate verdict into the public receipt. */
export function readMissionAdmission(file) {
  const parsed = readJsonArtefact(file);
  if (parsed === null) return {state: 'NOT_REPORTED', admitted: false, credentialsPrinted: false};
  if (parsed === 'UNREADABLE') return {state: 'UNREADABLE', admitted: false, credentialsPrinted: false};
  const state = parsed.state === 'VERIFIED' ? 'VERIFIED' : parsed.state === 'BLOCKED' ? 'BLOCKED' : 'UNKNOWN';
  return {
    state,
    admitted: state === 'VERIFIED' && parsed.admitted === true,
    reason: state === 'BLOCKED' && SAFE_MISSION_ADMISSION_REASONS.has(parsed.reason) ? parsed.reason : null,
    missionBindingVerified: state === 'VERIFIED' && parsed.missionBindingVerified === true,
    anchorConsistent: parsed.anchorConsistent === true,
    trustModel: parsed.trustModel === 'SAME_WRITER_ANCHORED_LEDGER' ? parsed.trustModel : null,
    independentVerifierRequired: parsed.independentVerifierRequired === true,
    credentialsPrinted: false,
  };
}

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
  const raw = String(value ?? env.WOLF_CI_CHECKS ?? DEFAULT_REQUIRED_CHECKS.join(','));
  const checks = [...new Set(raw.split(',').map(item => item.trim().toLowerCase()).filter(Boolean))];
  if (!checks.length) throw Error('BRIDGE_CHECKS_REQUIRED');
  const allowed = new Set(DEFAULT_REQUIRED_CHECKS);
  for (const check of checks) if (!allowed.has(check)) throw Error('BRIDGE_CHECK_DENIED');
  return checks;
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
export async function createCheckRun({token, repository, sha, name, conclusion = 'success', title, summary, detailsUrl, fetchImpl = globalThis.fetch, surface = 'public'}) {
  if (!['success', 'failure', 'neutral', 'cancelled', 'timed_out', 'skipped', 'action_required'].includes(conclusion)) throw Error('BRIDGE_CHECK_CONCLUSION_INVALID');
  const body = {
    name,
    head_sha: normalizeSha(sha),
    status: 'completed',
    conclusion,
    ...(detailsUrl ? {details_url: detailsUrl} : {}),
    output: {
      title: redact(title ?? name).slice(0, 255),
      summary: redact(summary ?? '', [token]).slice(0, 65535),
      annotations: [],
    },
  };
  // `surface` decides which allowlist applies: the public runner hosts the
  // sanitized receipt, the private repository hosts the authenticated check.
  const target = surface === 'private' ? normalizeRepository(repository) : normalizePublicRepository(repository);
  return githubJson(`${API}/repos/${target}/check-runs`, {token, method: 'POST', body, fetchImpl});
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

  // A live dispatch permission probe is not read-only: even a "probe" payload
  // can create a private workflow run. Record the capability as untested and do
  // not send a POST, regardless of the supplied workflow id.
  result.capabilities.dispatchWrite = {
    ok: false,
    httpStatus: null,
    attempted: false,
    reason: 'DISPATCH_PROBE_WITHHELD',
  };
  result.requiredPermissions = ['actions: write'];
  result.reason = 'DISPATCH_PROBE_WITHHELD';
  return result;
}

// Publish the receipt's check runs directly onto the private commit. This is
// the only operation in the bridge that writes to the private repository, so it
// uses a *separate* credential (WOLF_FACTORY_STATUS_TOKEN) from the source
// reader. If that credential is absent the bridge fails closed and names the
// exact permission required rather than silently degrading.
export const PRIVATE_STATUS_PERMISSION = 'checks: write (Checks: write on donraposo1-source/project-wolf)';

export async function publishPrivateStatusChecks({statusToken, sourceToken, statusIdentity, repository, sha, names, conclusion, summary, fetchImpl = globalThis.fetch, detailsUrl} = {}) {
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
      const created = await createCheckRun({token: statusToken, repository: normalizedRepository, sha: normalizedSha, name: checkName, conclusion, title: 'Wolf private CI', summary, detailsUrl, fetchImpl, surface: 'private'});
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

// Raw private-workflow dispatch is retired. The only admissible future handoff is
// the separately reviewed default-branch listener invoking its pinned reusable
// workflow after durable admission; this bridge never POSTs a dispatch event.
export async function dispatchPrivateCi() {
  return {
    state: 'BLOCKED',
    reason: 'LEGACY_DIRECT_DISPATCH_DISABLED',
    dispatchAttempted: false,
    refUpdated: false,
    privateSourceFetched: false,
    credentialsPrinted: false,
  };
}

// Verify the receipt that the private-side executor attached to the exact SHA.
// A missing or mismatched SHA is always a hard failure.
export function verifyReceiptBinding(receipt, {sha, repository, checks} = {}) {
  const normalizedSha = normalizeSha(sha);
  const normalizedRepository = normalizeRepository(repository);
  const required = normalizeChecks(checks);
  if (!receipt || typeof receipt !== 'object') return {state: 'REJECTED', reason: 'RECEIPT_REQUIRED'};
  if (receipt.sha !== normalizedSha) return {state: 'REJECTED', reason: 'RECEIPT_SHA_MISMATCH'};
  if (receipt.repository !== normalizedRepository) return {state: 'REJECTED', reason: 'RECEIPT_REPOSITORY_MISMATCH'};
  const observed = new Map((receipt.checks ?? []).map(check => [String(check.name).toLowerCase(), check]));
  const missing = required.filter(name => !observed.has(name));
  if (missing.length) return {state: 'REJECTED', reason: 'RECEIPT_CHECKS_MISSING', missing};
  // Accept both spellings: the older dispatch receipts use `conclusion`, the
  // executor's SHA-bound receipts use `status`.
  const outcome = check => check?.conclusion ?? check?.status;
  const unsuccessful = required.filter(name => outcome(observed.get(name)) !== 'success');
  if (unsuccessful.length) return {state: 'REJECTED', reason: 'RECEIPT_CHECKS_UNSUCCESSFUL', unsuccessful};
  return {state: 'VERIFIED', sha: normalizedSha, repository: normalizedRepository, checks: required};
}

/**
 * Project private execution evidence into a public, aggregate-only receipt.
 *
 * Verification is performed against the private repository/SHA in memory; those
 * selectors, per-check names/results, logs and error details are deliberately not
 * copied into the public object. The digest/checksum is not a signature or proof of
 * independent verification.
 */
export function buildPublicAggregateReceipt({receipt, expectedSha, expectedRepository, checks} = {}) {
  let binding = {state: 'REJECTED'};
  try {
    binding = verifyReceiptBinding(receipt, {sha: expectedSha, repository: expectedRepository, checks});
  } catch {
    binding = {state: 'REJECTED'};
  }
  const exactShaBindingVerified = binding.state === 'VERIFIED';
  const checksMatchReceipt = exactShaBindingVerified && receipt?.state === 'VERIFIED';
  return {
    schema: 'wolf.private-ci.aggregate/v1',
    state: checksMatchReceipt ? 'CHECKS_MATCHED_UNAUTHENTICATED' : 'NOT_VERIFIED',
    conclusion: 'failure',
    exactShaBindingVerified,
    requiredChecksMatched: exactShaBindingVerified,
    authenticityVerified: false,
    privateSourcePublished: false,
    privateLogsPublished: false,
    credentialsPrinted: false,
  };
}

/** Add the separately verified admission gate as a sanitized, non-acceptance field. */
export function buildPublicBridgeReceipt(options = {}) {
  return {
    ...buildPublicAggregateReceipt(options),
    kind: 'private-ci-receipt',
    missionAdmission: readMissionAdmission(process.env.WOLF_CI_MISSION_ADMISSION_FILE),
  };
}

const PUBLIC_EVIDENCE_STATES = new Map([
  ['PROBED', 'COMPLETED'], ['INVENTORIED', 'COMPLETED'],
  ['BLOCKED', 'BLOCKED'], ['DENIED', 'BLOCKED'],
  ['FAILED', 'FAILED'], ['UNREADABLE', 'UNKNOWN'],
]);

/** Public projection for metadata probes and inventory: no target selectors/items. */
export function buildPublicEvidenceAggregate(result = {}) {
  const inventory = result?.state === 'INVENTORIED';
  const secretInventory = Array.isArray(result?.inventory);
  return {
    schema: 'wolf.private-ci.aggregate/v1',
    kind: secretInventory ? 'credential-inventory' : inventory ? 'private-ci-inventory' : 'private-ci-metadata-probe',
    state: PUBLIC_EVIDENCE_STATES.get(result?.state) ?? 'UNKNOWN',
    privateSourcePublished: false,
    privateLogsPublished: false,
    credentialsPrinted: false,
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
  const summary = JSON.stringify(buildPublicEvidenceAggregate(result), null, 2);
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
    const credential = credentialForRole('reader');
    const result = await probePrivateRepository({
      token: credential.token,
      repository: process.env.WOLF_CI_REPOSITORY,
      sha: process.env.WOLF_CI_SHA,
      pr: process.env.WOLF_CI_PR,
    });
    result.credentialSource = credential.source;
    if (credential.reason) result.credentialReason = credential.reason;
    writeProbeOutput(result);
    try {
      result.checkRun = await publishProbeCheckRun(result);
    } catch (error) {
      result.checkRun = {state: 'FAILED', httpStatus: error.httpStatus ?? 0, reason: error.message === 'BRIDGE_HTTP_DENIED' ? 'CHECK_RUN_DENIED' : 'CHECK_RUN_FAILED'};
    }
    const publicSummary = buildPublicEvidenceAggregate(result);
    const checkRunState = ['PUBLISHED', 'FAILED', 'SKIPPED'].includes(result.checkRun?.state) ? result.checkRun.state : 'UNKNOWN';
    process.stdout.write(JSON.stringify({...publicSummary, checkRunState}) + '\n');
    return result.state === 'PROBED' ? BRIDGE_EXIT.OK : BRIDGE_EXIT.DENIED;
  }
  if (command === 'publish-private-status') {
    const publication = {
      schema: 'wolf.private-ci.aggregate/v1',
      kind: 'private-check-publication',
      state: 'BLOCKED',
      reason: 'UNAUTHENTICATED_RECEIPT_STATUS_PUBLISHING_DISABLED',
      exactShaCheckPublished: false,
      authenticityVerified: false,
      privateSourcePublished: false,
      privateLogsPublished: false,
      credentialsPrinted: false,
    };
    process.stdout.write(JSON.stringify(publication) + '\n');
    return BRIDGE_EXIT.DENIED;
  }
  if (command === 'diagnose-dispatch') {
    const result = {
      state: 'BLOCKED',
      reason: 'DISPATCH_DIAGNOSTIC_WITHHELD',
      dispatchAttempted: false,
      privateMetadataRead: false,
      credentialsPrinted: false,
    };
    if (process.env.WOLF_CI_PROBE_OUTPUT) writeProbeOutput(result);
    process.stdout.write(JSON.stringify(result) + '\n');
    return BRIDGE_EXIT.OK;
  }
  if (command === 'dispatch') {
    const result = await dispatchPrivateCi();
    process.stdout.write(JSON.stringify(result) + '\n');
    return BRIDGE_EXIT.DENIED;
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
    const publicSummary = buildPublicEvidenceAggregate(result);
    await githubJson(`${API}/repos/${repository}/commits/${sha}/comments`, {
      token,
      method: 'POST',
      body: {body: '```json\n' + JSON.stringify(publicSummary, null, 2) + '\n```'},
    });
    process.stdout.write(JSON.stringify({publicationState: 'PUBLISHED', ...publicSummary}) + '\n');
    return BRIDGE_EXIT.OK;
  }
  if (command === 'secret-inventory') {
    const names = String(process.env.WOLF_CI_SECRET_NAMES ?? '')
      .split(',').map(name => name.trim()).filter(Boolean);
    const inventory = names.map(name => ({name, present: String(process.env[name] ?? '').length > 0}));
    const summary = buildPublicEvidenceAggregate({state: 'INVENTORIED', inventory});
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
    const summary = buildPublicBridgeReceipt({
      receipt,
      expectedSha: process.env.WOLF_CI_SHA,
      expectedRepository: process.env.WOLF_CI_REPOSITORY,
      checks: process.env.WOLF_CI_CHECKS,
    });
    // The check run is the status surface the private commit would normally
    // have. It is created first so its outcome is recorded in the receipt
    // comment that follows, instead of being silently discarded.
    let checkRun = {state: 'NOT_CREATED'};
    try {
      const created = await createCheckRun({
        token,
        repository,
        sha,
        name: 'wolf-private-ci-aggregate',
        conclusion: summary.conclusion,
        title: 'Private CI aggregate',
        summary: 'Aggregate private CI outcome: ' + summary.state,
      });
      checkRun = {state: 'CREATED'};
    } catch (error) {
      checkRun = {state: 'FAILED', httpStatus: error?.httpStatus ?? null};
    }
    const publicSummary = {...summary, publicCheckRunState: checkRun.state};
    const body = '```json\n' + JSON.stringify(publicSummary, null, 2) + '\n```';
    await githubJson(`${API}/repos/${repository}/commits/${sha}/comments`, {token, method: 'POST', body: {body}});
    process.stdout.write(JSON.stringify({publicationState: 'PUBLISHED', ...publicSummary}) + '\n');
    return BRIDGE_EXIT.OK;
  }
  if (command === 'verify-receipt') {
    const receiptPath = process.env.WOLF_CI_RECEIPT;
    const receipt = receiptPath ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : null;
    const summary = buildPublicBridgeReceipt({
      receipt,
      expectedSha: process.env.WOLF_CI_SHA,
      expectedRepository: process.env.WOLF_CI_REPOSITORY,
      checks: process.env.WOLF_CI_CHECKS,
    });
    process.stdout.write(JSON.stringify(summary) + '\n');
    return summary.state === 'VERIFIED' ? BRIDGE_EXIT.OK : BRIDGE_EXIT.DENIED;
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
