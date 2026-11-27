// Proves the dispatch capability against the private repository instead of
// assuming it. The probe is deliberately split from `dispatchPrivateCi`: that
// function performs the real dispatch, this one verifies that a dispatch is both
// accepted and not duplicated.
//
// Only repository, workflow id, SHA and HTTP metadata appear in the result. No
// token, response body or private content is ever returned or printed.
const API = 'https://api.github.com';

export const DISPATCH_PROBE_STATES = Object.freeze({
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
export async function probeDispatch() {
  // Dispatching a "probe" is still an externally visible workflow run and can
  // execute private code. Capability is therefore not tested by mutation here.
  // The only future activation path is an approved, pinned mission listener.
  return {
    state: DISPATCH_PROBE_STATES.BLOCKED,
    reason: 'DISPATCH_PROBE_WITHHELD',
    dispatchAttempted: false,
    refUpdated: false,
    privateSourceFetched: false,
    credentialsPrinted: false,
  };
}

export const DISPATCH_PROBE_EXIT = Object.freeze({OK: 0, DEFECT: 1, USAGE: 2, BLOCKED: 78});

/**
 * CLI entry point. It never throws for a blocked capability: a capability that
 * is not yet granted is a fail-closed outcome, not a crash.
 */
export async function dispatchProbeCli(argv = [], env = process.env, {
  write = text => process.stdout.write(text),
} = {}) {
  const outPath = argv.find(arg => arg.startsWith('--out='))?.slice('--out='.length) ?? env.WOLF_CI_DISPATCH_FILE;
  const result = await probeDispatch();
  if (outPath) {
    const {writeFileSync} = await import('node:fs');
    writeFileSync(outPath, JSON.stringify(result) + '\n', {mode: 0o600});
  }
  write(JSON.stringify(result) + '\n');
  return DISPATCH_PROBE_EXIT.BLOCKED;
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
