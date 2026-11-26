// Proves the dispatch capability against the private repository instead of
// assuming it. The probe is deliberately split from `dispatchPrivateCi`: that
// function performs the real dispatch, this one verifies that a dispatch is both
// accepted and not duplicated.
//
// Only repository, workflow id, SHA and HTTP metadata appear in the result. No
// token, response body or private content is ever returned or printed.
import {credentialForRole} from './private-ci-app-auth.mjs';

const API = 'https://api.github.com';

export const DISPATCH_PROBE_STATES = Object.freeze({
  NOT_ATTEMPTED: 'NOT_ATTEMPTED',
  DISPATCHED: 'DISPATCHED',
  DISPATCHED_WITH_NEW_RUN: 'DISPATCHED_WITH_NEW_RUN',
  BLOCKED: 'BLOCKED',
});

const headersFor = token => ({
  authorization: 'Bearer ' + token,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
});

const request = async (url, token, init = {}, fetchImpl = globalThis.fetch) => {
  const response = await fetchImpl(url, {...init, headers: {...headersFor(token), ...(init.headers ?? {})}});
  const ok = response.ok === true || response.status === 204;
  let body = null;
  if (ok && typeof response.json === 'function' && response.status !== 204) {
    try {
      body = await response.json();
    } catch {
      body = null;
    }
  }
  return {ok, httpStatus: response.status, body};
};

const normalisePath = value => String(value ?? '').replace(/^\.\//, '');

/**
 * Resolves the target workflow without an operator setting: an explicit id wins,
 * then an explicit file, then the oldest workflow the token can see, which is
 * the pinned `private-ci` pipeline rather than the probe that was added later.
 * A wrong pick is visible in the result, so nothing is hidden by the guess.
 */
export async function resolveWorkflow({token, repository, workflowId, workflowFile, fetchImpl = globalThis.fetch} = {}) {
  if (Number.isInteger(workflowId) && workflowId > 0) {
    return {workflowId, workflowFile: null, discovered: false};
  }
  if (workflowFile) {
    // GitHub accepts the file name in place of the id, so no lookup is needed.
    return {workflowId: 0, workflowFile: normalisePath(workflowFile), discovered: false};
  }
  const listed = await request(API + '/repos/' + repository + '/actions/workflows?per_page=100', token, {}, fetchImpl);
  if (!listed.ok || !Array.isArray(listed.body?.workflows)) {
    return {workflowId: 0, workflowFile: null, discovered: false, reason: 'WORKFLOW_LIST_UNAVAILABLE'};
  }
  const candidates = listed.body.workflows
    .filter(workflow => typeof workflow?.path === 'string' && workflow.path.startsWith('.github/workflows/'))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id);
  const chosen = candidates[0];
  if (!chosen) return {workflowId: 0, workflowFile: null, discovered: false, reason: 'WORKFLOW_LIST_EMPTY'};
  return {workflowId: chosen.id, workflowFile: null, discovered: true, discoveredName: chosen.name ?? null, discoveredPath: chosen.path};
}

/**
 * Dispatches the private workflow once and compares the run count before and
 * after. A duplicate is reported, never retried: re-dispatching to "make sure"
 * is exactly how the same SHA gets executed twice.
 */
export async function probeDispatch({
  token,
  repository,
  workflowId,
  workflowFile,
  ref = 'main',
  sha,
  pr = '743',
  mode = 'verify',
  settleMs = 4000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  fetchImpl = globalThis.fetch,
} = {}) {
  const result = {
    state: DISPATCH_PROBE_STATES.NOT_ATTEMPTED,
    reason: null,
    credentialSource: token ? (token.source ?? null) : null,
    repository: repository ?? null,
    workflowId: workflowId ?? null,
    workflowFile: workflowFile ? normalisePath(workflowFile) : null,
    duplicateSuppressed: false,
    runsBefore: null,
    runsAfter: null,
  };
  if (!token || !token.value) return {...result, reason: 'DISPATCH_CREDENTIAL_REQUIRED'};
  if (!repository) return {...result, reason: 'REPOSITORY_REQUIRED'};

  const resolved = await resolveWorkflow({token: token.value, repository, workflowId, workflowFile, fetchImpl});
  if (resolved.reason) return {...result, state: DISPATCH_PROBE_STATES.BLOCKED, reason: resolved.reason};
  const target = resolved.workflowFile ?? resolved.workflowId;
  result.workflowId = resolved.workflowId || null;
  result.workflowFile = resolved.workflowFile;
  result.workflowDiscovered = resolved.discovered === true;
  if (resolved.discoveredName) result.discoveredWorkflow = {name: resolved.discoveredName, path: resolved.discoveredPath};

  const base = API + '/repos/' + repository + '/actions/workflows/' + target;
  const listed = await request(base, token.value, {}, fetchImpl);
  result.workflowReadable = {ok: listed.ok, httpStatus: listed.httpStatus};
  if (!listed.ok) return {...result, state: DISPATCH_PROBE_STATES.BLOCKED, reason: 'WORKFLOW_NOT_READABLE'};

  const before = await request(base + '/runs?per_page=1', token.value, {}, fetchImpl);
  result.runsBefore = before.body?.total_count ?? null;

  const dispatched = await request(base + '/dispatches', token.value, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({ref, inputs: {sha: sha ?? '', pr, mode}}),
  }, fetchImpl);
  result.dispatch = {ok: dispatched.ok, httpStatus: dispatched.httpStatus};
  if (!dispatched.ok) {
    return {
      ...result,
      state: DISPATCH_PROBE_STATES.BLOCKED,
      reason: dispatched.httpStatus === 403 || dispatched.httpStatus === 404 ? 'ACTIONS_WRITE_REQUIRED' : 'DISPATCH_FAILED',
    };
  }

  await sleep(settleMs);
  const after = await request(base + '/runs?per_page=1', token.value, {}, fetchImpl);
  result.runsAfter = after.body?.total_count ?? null;
  result.duplicateSuppressed = result.runsBefore !== null && result.runsBefore === result.runsAfter;
  return {
    ...result,
    state: result.duplicateSuppressed ? DISPATCH_PROBE_STATES.DISPATCHED : DISPATCH_PROBE_STATES.DISPATCHED_WITH_NEW_RUN,
  };
}

export const DISPATCH_PROBE_EXIT = Object.freeze({OK: 0, DEFECT: 1, USAGE: 2, BLOCKED: 78});

/**
 * CLI entry point. It never throws for a blocked capability: a capability that
 * is not yet granted is a fail-closed outcome, not a crash.
 */
export async function dispatchProbeCli(argv = [], env = process.env, {
  fetchImpl = globalThis.fetch,
  write = () => {},
  writeError = () => {},
} = {}) {
  const outPath = argv.find(arg => arg.startsWith('--out='))?.slice('--out='.length) ?? env.WOLF_CI_DISPATCH_FILE;
  const selected = credentialForRole('dispatcher', {env});
  const token = selected.token ? {value: selected.token, source: selected.source} : null;
  const result = await probeDispatch({
    token,
    repository: env.WOLF_CI_REPOSITORY,
    workflowId: Number(env.WOLF_CI_WORKFLOW_ID) || 0,
    workflowFile: env.WOLF_CI_WORKFLOW_FILE,
    ref: env.WOLF_CI_REF || 'main',
    sha: env.WOLF_CI_SHA,
    pr: env.WOLF_CI_PR || '743',
    mode: env.WOLF_CI_MODE || 'verify',
    fetchImpl,
  });
  if (outPath) {
    const {writeFileSync} = await import('node:fs');
    writeFileSync(outPath, JSON.stringify(result));
  }
  write(result.state + ' ' + (result.reason ?? '-') + ' source=' + (result.credentialSource ?? 'none') + '\n');
  // A capability that could not even be attempted is blocked, not fine: an
  // unexercised dispatch must never be reported as a passing verification.
  if (result.state === DISPATCH_PROBE_STATES.BLOCKED || result.reason) return DISPATCH_PROBE_EXIT.BLOCKED;
  return DISPATCH_PROBE_EXIT.OK;
}

if (import.meta.url === 'file://' + process.argv[1]) {
  dispatchProbeCli(process.argv.slice(2)).then(
    code => process.exit(code),
    error => {
      process.stderr.write(String(error?.message ?? error) + '\n');
      process.exit(DISPATCH_PROBE_EXIT.DEFECT);
    },
  );
}
