// Immutable-source guard for the existing public preflight.
//
// One verified pinned Factory SHA is compared with the live canonical branch
// before any journal write, and again before any publication. The guard never
// pushes, never force-pushes, never merges divergent histories and never treats
// a stale pin as a concurrent branch advancement.
import { spawnSync } from 'node:child_process';

export const FACTORY_REPOSITORY = 'donraposo1-source/project-wolf';
export const FACTORY_BRANCH = 'feat/factory-real-worker-m1-20261006';
const PIN = /^[a-f0-9]{40}$/;

export const SOURCE_PIN_EXIT = Object.freeze({
  SOURCE_PIN_OK: 0,
  SOURCE_PIN_DEFECT: 1,
  SOURCE_PIN_UNPUBLISHED: 75,
  SOURCE_PIN_CHECKOUT_MISMATCH: 76,
  SOURCE_PIN_CONCURRENCY: 77,
  SOURCE_PIN_DENIED: 78,
  SOURCE_PIN_STALE: 79,
});

export function assertSourcePin(expectedSha) {
  if (typeof expectedSha !== 'string' || !PIN.test(expectedSha)) throw Error('SOURCE_PIN_MALFORMED');
  return expectedSha;
}

function receipt(state, { expectedSha, localHead, remoteHead, compareStatus } = {}, { exitCode, publicationRefused = true, admitted = false } = {}) {
  return {
    state,
    exitCode,
    admitted,
    publicationRefused,
    expectedSha: PIN.test(expectedSha || '') ? expectedSha : null,
    localHead: PIN.test(localHead || '') ? localHead : null,
    remoteHead: PIN.test(remoteHead || '') ? remoteHead : null,
    compareStatus: typeof compareStatus === 'string' ? compareStatus : null,
    repository: FACTORY_REPOSITORY,
    branch: FACTORY_BRANCH,
    refUpdated: false,
    forcePush: false,
    automaticMerge: false,
    inferencePerformed: false,
  };
}

// Read-only source identity check used before any durable journal write.
export function classifySourcePin({ expectedSha, localHead, remoteHead, compareStatus } = {}) {
  assertSourcePin(expectedSha);
  const scope = { expectedSha, localHead, remoteHead, compareStatus };
  if (typeof remoteHead !== 'string' || !PIN.test(remoteHead)) return receipt('SOURCE_REF_UNRESOLVED', scope, { exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_DENIED });
  if (typeof localHead !== 'string' || !PIN.test(localHead)) return receipt('SOURCE_PIN_CHECKOUT_UNVERIFIABLE', scope, { exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_STALE });
  if (localHead !== expectedSha) return receipt('STALE_CHECKOUT_REFUSED', scope, { exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_CHECKOUT_MISMATCH });
  if (remoteHead === expectedSha) return receipt('PIN_VERIFIED_IN_SYNC', scope, { exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_OK, publicationRefused: false, admitted: true });
  if (compareStatus === 'ahead') return receipt('STALE_PINNED_SOURCE', scope, { exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_STALE });
  if (compareStatus === 'behind') return receipt('PIN_UNPUBLISHED_SOURCE', scope, { exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_UNPUBLISHED });
  if (compareStatus === 'diverged') return receipt('REMOTE_CONCURRENCY_DIVERGED', scope, { exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_CONCURRENCY });
  return receipt('SOURCE_COMPARISON_UNAVAILABLE', scope, { exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_DENIED });
}

// Remote-only identity check, for the gate that runs before any private checkout.
export function classifyPinnedRemote({ expectedSha, remoteHead, compareStatus } = {}) {
  assertSourcePin(expectedSha);
  const scope = { expectedSha, localHead: null, remoteHead, compareStatus };
  if (typeof remoteHead !== 'string' || !PIN.test(remoteHead)) return receipt('SOURCE_REF_UNRESOLVED', scope, { exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_DENIED });
  if (remoteHead === expectedSha) return receipt('PIN_VERIFIED_IN_SYNC', scope, { exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_OK, publicationRefused: false, admitted: true });
  if (compareStatus === 'ahead') return receipt('STALE_PINNED_SOURCE', scope, { exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_STALE });
  if (compareStatus === 'behind') return receipt('PIN_UNPUBLISHED_SOURCE', scope, { exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_UNPUBLISHED });
  if (compareStatus === 'diverged') return receipt('REMOTE_CONCURRENCY_DIVERGED', scope, { exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_CONCURRENCY });
  return receipt('SOURCE_COMPARISON_UNAVAILABLE', scope, { exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_DENIED });
}

// Publication admission. A checkout that does not match the pin can never publish.
export function classifyPublicationAdmission({ expectedSha, localHead, remoteHead, compareStatus } = {}) {
  assertSourcePin(expectedSha);
  const scope = { expectedSha, localHead, remoteHead, compareStatus };
  if (typeof remoteHead !== 'string' || !PIN.test(remoteHead)) return receipt('SOURCE_REF_UNRESOLVED', scope, { exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_DENIED });
  if (typeof localHead !== 'string' || !PIN.test(localHead) || localHead !== expectedSha) {
    return receipt('STALE_CHECKOUT_REFUSED', scope, { exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_CHECKOUT_MISMATCH });
  }
  if (remoteHead === localHead) return receipt('ALREADY_UP_TO_DATE', scope, { exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_OK, publicationRefused: false, admitted: true });
  if (compareStatus === 'ahead') return receipt('CONCURRENT_BRANCH_ADVANCED', scope, { exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_CONCURRENCY });
  if (compareStatus === 'behind') return receipt('PUBLICATION_FAST_FORWARD_ADMITTED', scope, { exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_OK, publicationRefused: false, admitted: true });
  if (compareStatus === 'diverged') return receipt('DIVERGENT_HISTORY_REFUSED', scope, { exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_CONCURRENCY });
  return receipt('SOURCE_COMPARISON_UNAVAILABLE', scope, { exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_DENIED });
}

// Transport failures are never reported as branch concurrency. Ancestry evidence
// decides concurrency; this only classifies what Git actually said.
export function classifyGitTransportFailure(stderr, exitCode) {
  const text = typeof stderr === 'string' ? stderr : '';
  const status = Number.isInteger(exitCode) ? exitCode : null;
  const deny = state => ({ state, exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_DENIED, refUpdated: false });
  if (/publickey|permission denied \(publickey\)|authentication failed|could not read from remote|could not read username|terminal prompts disabled/i.test(text)) return deny('AUTHENTICATION_FAILED');
  if (/403|write access.*not granted|permission.*denied|protected branch/i.test(text)) return deny('WRITE_ACCESS_DENIED');
  if (/shallow|unshallow|deepen/i.test(text)) return deny('SHALLOW_HISTORY_DENIED');
  if (/could not resolve host|connection timed out|connection refused|network is unreachable|ssl|tls/i.test(text)) return deny('TRANSPORT_UNAVAILABLE');
  if (/non-fast-forward|fetch first|tip of your current branch is behind|\[rejected\]|failed to push some refs/i.test(text)) return { state: 'NON_FAST_FORWARD_REJECTED', exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_CONCURRENCY, refUpdated: false };
  if (status === 0) return { state: 'TRANSPORT_AUTHORIZED', exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_OK, refUpdated: false };
  return { state: 'GENUINE_GIT_DEFECT', exitCode: SOURCE_PIN_EXIT.SOURCE_PIN_DEFECT, refUpdated: false };
}

export function redactGitOutput(text, secret) {
  let safe = String(text || '').replace(/https?:\/\/[^\s]+/g, '[REDACTED_URL]').replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[REDACTED_TOKEN]');
  if (typeof secret === 'string' && secret.length) safe = safe.split(secret).join('[REDACTED_TOKEN]');
  return safe.slice(0, 4000);
}

async function readJson(fetchImpl, url, token) {
  let response;
  try {
    response = await fetchImpl(url, { headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'user-agent': 'WolfFactorySourcePin' }, redirect: 'error', signal: AbortSignal.timeout(20000) });
  } catch {
    return { state: 'SOURCE_REF_UNRESOLVED', reason: 'SOURCE_REF_NETWORK_FAILED' };
  }
  if (!response.ok) { try { await response.body?.cancel(); } catch {} return { state: 'SOURCE_REF_DENIED', reason: 'SOURCE_REF_DENIED', httpStatus: response.status }; }
  try { return { state: 'OK', body: await response.json() }; } catch { return { state: 'SOURCE_REF_DENIED', reason: 'SOURCE_REF_INVALID', httpStatus: response.status }; }
}

// Resolve the live branch head and its ancestry relationship to the pin without
// writing anything and without exposing the credential.
export async function readLiveSource({ expectedSha, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  assertSourcePin(expectedSha);
  const required = ['WOLF_FACTORY_REPO_TOKEN'];
  const missing = required.filter(key => typeof env[key] !== 'string' || !env[key]);
  if (missing.length) return { state: 'BLOCKED', reason: 'SOURCE_PIN_CONFIGURATION_REQUIRED', missing, privateSourceFetched: false };
  const token = env.WOLF_FACTORY_REPO_TOKEN;
  const head = await readJson(fetchImpl, `https://api.github.com/repos/${FACTORY_REPOSITORY}/git/ref/heads/${FACTORY_BRANCH}`, token);
  if (head.state !== 'OK') return head;
  const remoteHead = head.body?.object?.sha;
  if (head.body?.ref !== `refs/heads/${FACTORY_BRANCH}` || !PIN.test(remoteHead || '')) return { state: 'SOURCE_REF_DENIED', reason: 'SOURCE_REF_INVALID', privateSourceFetched: false };
  if (remoteHead === expectedSha) return { state: 'OK', remoteHead, compareStatus: 'identical', privateSourceFetched: false };
  const compare = await readJson(fetchImpl, `https://api.github.com/repos/${FACTORY_REPOSITORY}/compare/${expectedSha}...${remoteHead}?per_page=1`, token);
  if (compare.state !== 'OK') return compare;
  const status = compare.body?.status;
  if (!['ahead', 'behind', 'diverged', 'identical'].includes(status)) return { state: 'SOURCE_REF_DENIED', reason: 'SOURCE_COMPARISON_INVALID', remoteHead, privateSourceFetched: false };
  return { state: 'OK', remoteHead, compareStatus: status, commitCount: compare.body?.total_commits ?? null, privateSourceFetched: false };
}

export function readLocalHead(repositoryPath = '.', spawn = spawnSync) {
  const result = spawn('git', ['rev-parse', 'HEAD'], { cwd: repositoryPath, encoding: 'utf8', timeout: 20000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const head = String(result?.stdout || '').trim();
  return PIN.test(head) ? head : null;
}

function summarise(state, detail) {
  const output = { state, ...detail, credentialSource: 'GitHub repository secret WOLF_FACTORY_REPO_TOKEN', inferencePerformed: false };
  console.log('WOLF_FACTORY_SOURCE_PIN=' + JSON.stringify(output));
}

export async function verifySourcePin({ env = process.env, fetchImpl = globalThis.fetch, spawn = spawnSync, repositoryPath = '.' } = {}) {
  const expectedSha = assertSourcePin(env.WOLF_FACTORY_EXPECTED_SHA);
  const live = await readLiveSource({ expectedSha, fetchImpl, env });
  if (live.state !== 'OK') {
    const denied = ['SOURCE_REF_DENIED', 'SOURCE_REF_UNRESOLVED', 'BLOCKED'].includes(live.state);
    return {
      state: live.state === 'OK' ? 'SOURCE_REF_UNRESOLVED' : live.state,
      exitCode: denied ? SOURCE_PIN_EXIT.SOURCE_PIN_DENIED : SOURCE_PIN_EXIT.SOURCE_PIN_DEFECT,
      reason: live.reason || null,
      expectedSha,
      remoteHead: live.remoteHead || null,
      localHead: null,
      publicationRefused: true,
      refUpdated: false,
    };
  }
  const localHead = readLocalHead(repositoryPath, spawn);
  return classifySourcePin({ expectedSha, localHead, remoteHead: live.remoteHead, compareStatus: live.compareStatus });
}

export async function verifyPinnedRemote({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const expectedSha = assertSourcePin(env.WOLF_FACTORY_EXPECTED_SHA);
  const live = await readLiveSource({ expectedSha, fetchImpl, env });
  if (live.state !== 'OK') {
    const denied = ['SOURCE_REF_DENIED', 'SOURCE_REF_UNRESOLVED', 'BLOCKED'].includes(live.state);
    return { state: live.state, exitCode: denied ? SOURCE_PIN_EXIT.SOURCE_PIN_DENIED : SOURCE_PIN_EXIT.SOURCE_PIN_DEFECT, reason: live.reason || null, expectedSha, localHead: null, remoteHead: live.remoteHead || null, publicationRefused: true, refUpdated: false };
  }
  return classifyPinnedRemote({ expectedSha, remoteHead: live.remoteHead, compareStatus: live.compareStatus });
}

export async function admitPublication({ env = process.env, fetchImpl = globalThis.fetch, spawn = spawnSync, repositoryPath = '.' } = {}) {
  const expectedSha = assertSourcePin(env.WOLF_FACTORY_EXPECTED_SHA);
  const localHead = readLocalHead(repositoryPath, spawn);
  const live = await readLiveSource({ expectedSha, fetchImpl, env });
  if (live.state !== 'OK') {
    const denied = ['SOURCE_REF_DENIED', 'SOURCE_REF_UNRESOLVED', 'BLOCKED'].includes(live.state);
    return { state: live.state, exitCode: denied ? SOURCE_PIN_EXIT.SOURCE_PIN_DENIED : SOURCE_PIN_EXIT.SOURCE_PIN_DEFECT, reason: live.reason || null, expectedSha, localHead, remoteHead: null, publicationRefused: true, refUpdated: false };
  }
  const admission = classifyPublicationAdmission({ expectedSha, localHead, remoteHead: live.remoteHead, compareStatus: live.compareStatus });
  // A refused admission must never reach the transport. This is what stops a
  // stale checkout from producing a publication attempt at all.
  if (!admission.admitted) return admission;
  const push = spawn('git', ['push', '--dry-run', 'origin', `HEAD:refs/heads/${FACTORY_BRANCH}`], { cwd: repositoryPath, encoding: 'utf8', timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const stderr = String(push?.stderr || '');
  const transport = classifyGitTransportFailure(stderr, Number.isInteger(push?.status) ? push.status : null);
  console.log('WOLF_GIT_ORIGINAL_ERROR=' + JSON.stringify({ stderr: redactGitOutput(stderr, env.WOLF_FACTORY_REPO_TOKEN), errorCode: push?.error?.code || null }));
  console.log('WOLF_GIT_PUBLICATION_DRY_RUN=' + JSON.stringify({ exitCode: Number.isInteger(push?.status) ? push.status : null, reason: transport.state, ancestryState: admission.state, refUpdated: false }));
  return { ...admission, state: transport.state === 'TRANSPORT_AUTHORIZED' ? admission.state : transport.state, exitCode: transport.exitCode, transportState: transport.state, publicationRefused: transport.exitCode !== SOURCE_PIN_EXIT.SOURCE_PIN_OK };
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href;
if (invokedDirectly) {
  const command = process.argv[2];
  const allowed = new Set(['verify', 'verify-remote', 'admit-publication']);
  const run = command === 'verify' ? verifySourcePin : command === 'verify-remote' ? verifyPinnedRemote : command === 'admit-publication' ? admitPublication : null;
  if (!run) {
    console.error('WOLF_FACTORY_SOURCE_PIN=' + JSON.stringify({ state: 'COMMAND_DENIED', allowed: [...allowed] }));
    process.exitCode = SOURCE_PIN_EXIT.SOURCE_PIN_DEFECT;
  } else {
    try {
      const result = await run();
      summarise(result.state, result);
      process.exitCode = result.exitCode === undefined ? SOURCE_PIN_EXIT.SOURCE_PIN_DEFECT : result.exitCode;
    } catch (error) {
      const code = String(error?.message || '');
      const known = ['SOURCE_PIN_MALFORMED'].includes(code);
      console.error('WOLF_FACTORY_SOURCE_PIN=' + JSON.stringify({ state: known ? code : 'SOURCE_PIN_FAILED', reason: known ? null : code.replace(/[^A-Z_]/g, '').slice(0, 120) }));
      process.exitCode = SOURCE_PIN_EXIT.SOURCE_PIN_DEFECT;
    }
  }
}
