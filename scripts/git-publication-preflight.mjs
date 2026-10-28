import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export const CANONICAL_REPOSITORY = 'donraposo1-source/project-wolf';
export const CANONICAL_BRANCH = 'feat/factory-real-worker-m1-20261006';
export const MINIMUM_VERIFIED_FACTORY_SHA = '58127da11aa1628a5f6e53376449574b7e2cc20e';
export const GITHUB_SSH_KNOWN_HOST =
  'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n';

const SECRET_ENV_KEYS = Object.freeze([
  'WOLF_FACTORY_REPO_TOKEN',
  'WOLF_FACTORY_DEPLOY_KEY',
  'GITHUB_TOKEN',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'BOXXKITE_API_KEY',
  'WOLF_RUNTIME_CHECKPOINT_TOKEN',
]);

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

export function normalizeOpenSshPrivateKey(raw) {
  if (typeof raw !== 'string') throw Error('PUBLICATION_DEPLOY_KEY_REQUIRED');
  const normalized = raw.replace(/\r\n?/g, '\n').trim();
  if (!normalized.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')) {
    throw Error('PUBLICATION_DEPLOY_KEY_REQUIRED');
  }
  if (
    normalized.includes('\0') ||
    !normalized.endsWith('-----END OPENSSH PRIVATE KEY-----')
  ) {
    throw Error('PUBLICATION_DEPLOY_KEY_INVALID');
  }
  return normalized + '\n';
}

export function cleanupSshPublicationCredential({
  env = process.env,
  runnerTemp = env.RUNNER_TEMP,
} = {}) {
  if (typeof runnerTemp !== 'string' || !runnerTemp.trim()) return;
  for (const name of [
    'wolf-publication-key',
    'wolf-publication-known-hosts',
    'wolf-cas-lease.json',
  ]) {
    fs.rmSync(path.join(runnerTemp, name), {force: true});
  }
}

export function prepareSshPublicationCredential({
  env = process.env,
  runnerTemp = env.RUNNER_TEMP,
  githubEnvPath = env.GITHUB_ENV,
  spawnImpl = spawnSync,
} = {}) {
  if (
    typeof runnerTemp !== 'string' ||
    !runnerTemp.trim() ||
    typeof githubEnvPath !== 'string' ||
    !githubEnvPath.trim()
  ) {
    throw Error('PUBLICATION_RUNNER_ENV_REQUIRED');
  }
  const keyContent = normalizeOpenSshPrivateKey(env.WOLF_FACTORY_DEPLOY_KEY);
  const keyFile = path.join(runnerTemp, 'wolf-publication-key');
  const hostsFile = path.join(runnerTemp, 'wolf-publication-known-hosts');
  try {
    fs.writeFileSync(keyFile, keyContent, {flag: 'wx', mode: 0o600});
  } catch (error) {
    if (error?.code === 'EEXIST') throw Error('DUPLICATE_SSH_KEY_MATERIALIZATION');
    throw Error('PUBLICATION_KEY_WRITE_FAILED');
  }
  try {
    fs.writeFileSync(hostsFile, GITHUB_SSH_KNOWN_HOST, {flag: 'wx', mode: 0o600});
    const check = spawnImpl('ssh-keygen', ['-y', '-f', keyFile], {
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
      timeout: 5000,
    });
    if (check.status !== 0 || check.signal || check.error) {
      throw Error('PUBLICATION_DEPLOY_KEY_INVALID');
    }
    const ssh =
      'ssh -F /dev/null -i ' +
      shellQuote(keyFile) +
      ' -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o UserKnownHostsFile=' +
      shellQuote(hostsFile) +
      ' -o BatchMode=yes -o ConnectTimeout=15';
    fs.appendFileSync(
      githubEnvPath,
      'GIT_SSH_COMMAND=' + ssh + '\nWOLF_FACTORY_GIT_TRANSPORT=ssh-deploy-key\n',
    );
    return {
      state: 'SCOPED_SSH_PUBLICATION_PREPARED',
      transport: 'ssh-deploy-key',
      hostVerification: 'STRICT_ED25519_PINNED',
    };
  } catch (error) {
    cleanupSshPublicationCredential({runnerTemp});
    throw error;
  }
}

export function redactGitPublicationOutput(raw, env = process.env) {
  let safe = String(raw || '');
  safe = safe.replace(
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
    '[REDACTED_KEY]',
  );
  for (const key of SECRET_ENV_KEYS) {
    const val = env?.[key];
    if (typeof val !== 'string' || !val) continue;
    const candidates = new Set([val, val.trim()].filter(Boolean));
    for (const item of [...candidates]) {
      candidates.add(encodeURIComponent(item));
      candidates.add(Buffer.from('x-access-token:' + item).toString('base64'));
      for (const line of item.replace(/\r\n?/g, '\n').split('\n')) {
        const trimmedLine = line.trim();
        if (trimmedLine.length >= 8 && !trimmedLine.startsWith('-----')) {
          candidates.add(trimmedLine);
        }
      }
    }
    for (const secret of candidates) {
      if (secret) safe = safe.split(secret).join('[REDACTED_TOKEN]');
    }
  }
  safe = safe
    .replace(/authorization:\s*(?:basic|bearer)\s+[^\s'"]+/gi, 'Authorization: [REDACTED_AUTH]')
    .replace(/x-access-token:[^\s@'"]+/gi, 'x-access-token:[REDACTED_TOKEN]')
    .replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[REDACTED_TOKEN]')
    .replace(/(?:https?|ssh):\/\/[^\s'"]+/gi, '[REDACTED_URL]');
  if (typeof env?.RUNNER_TEMP === 'string' && env.RUNNER_TEMP.trim()) {
    safe = safe.split(env.RUNNER_TEMP.trim()).join('[REDACTED_RUNNER_TEMP]');
  }
  return safe.slice(0, 4000);
}

export function classifyGitPublicationResult({
  status,
  stderr = '',
  signal = null,
  errorCode = undefined,
} = {}) {
  const text = String(stderr || '');
  if (status === 0 && !signal && !errorCode) return 'AUTHORIZED';
  if (errorCode === 'ETIMEDOUT' || signal === 'SIGTERM' || signal === 'SIGKILL') {
    return 'GIT_PUBLICATION_TIMEOUT';
  }
  if (
    /host key verification failed|remote host identification has changed|no [a-z0-9-]+ host key is known/i.test(
      text,
    )
  ) {
    return 'SSH_HOST_VERIFICATION_FAILED';
  }
  if (
    /load key .*:(?:\s*invalid format|\s*error in libcrypto|\s*bad permissions|\s*no such file)|identity file .* not accessible/i.test(
      text,
    )
  ) {
    return 'SSH_KEY_INVALID';
  }
  if (
    /\b403\b|write access.*not granted|permission to .* denied|permission.*denied|authentication failed|could not read username|could not read password|terminal prompts disabled|repository not found/i.test(
      text,
    )
  ) {
    return 'WRITE_ACCESS_DENIED';
  }
  if (/shallow/i.test(text)) {
    return 'SHALLOW_HISTORY_DENIED';
  }
  if (
    /GH006|GH013|protected branch|repository rule violations|hook declined/i.test(text)
  ) {
    return 'BRANCH_PROTECTION_DENIED';
  }
  if (
    /non-fast-forward|fetch first|tip of your current branch is behind|stale info|cannot lock ref .* expected/i.test(
      text,
    )
  ) {
    return 'CONCURRENT_BRANCH_ADVANCED';
  }
  if (
    /does not appear to be a git repository|no such remote|src refspec .* does not match any|invalid refspec/i.test(
      text,
    )
  ) {
    return 'INVALID_GIT_REMOTE_OR_BRANCH';
  }
  if (
    /could not resolve hostname|connection timed out|operation timed out|connection reset|kex_exchange_identification|network is unreachable/i.test(
      text,
    )
  ) {
    return 'GIT_NETWORK_UNAVAILABLE';
  }
  return 'GIT_PUBLICATION_PREFLIGHT_FAILED';
}

export function verifyAuthorizedGitPublication({
  cwd = process.cwd(),
  env = process.env,
  spawnImpl = spawnSync,
  expectedRepository = CANONICAL_REPOSITORY,
  targetBranch = CANONICAL_BRANCH,
  allowLocalRemoteForTesting = false,
  journalPath = env.WOLF_PUBLICATION_JOURNAL_PATH,
  expectedBaseSha = env.WOLF_FACTORY_EXPECTED_SHA,
  expectedRemoteSha = undefined,
  missionId = env.WOLF_MISSION_ID || null,
  leaseFence = Number(env.WOLF_GIT_PUBLICATION_FENCE || 1),
} = {}) {
  if (targetBranch === 'main' || targetBranch !== CANONICAL_BRANCH) {
    throw Error('UNAUTHORIZED_TARGET_BRANCH');
  }
  if (expectedRepository !== CANONICAL_REPOSITORY) {
    throw Error('UNAUTHORIZED_TARGET_REPOSITORY');
  }
  const hasExplicitRemoteCas = expectedRemoteSha !== undefined && expectedRemoteSha !== null;
  if (hasExplicitRemoteCas && !/^[a-f0-9]{40}$/.test(String(expectedRemoteSha))) {
    throw Error('INVALID_EXPECTED_REMOTE_SHA');
  }
  const effectiveLeaseSha = hasExplicitRemoteCas
    ? String(expectedRemoteSha)
    : expectedBaseSha !== undefined && expectedBaseSha !== null
      ? String(expectedBaseSha)
      : null;

  const branchCheck = spawnImpl('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (branchCheck.status !== 0 || branchCheck.stdout.trim() !== targetBranch) {
    throw Error('UNAUTHORIZED_LOCAL_BRANCH');
  }
  const headCheck = spawnImpl('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
  const headSha = String(headCheck.stdout || '').trim();
  if (headCheck.status !== 0 || !/^[a-f0-9]{40}$/.test(headSha)) {
    throw Error('INVALID_LOCAL_HEAD');
  }

  if (hasExplicitRemoteCas && headSha !== effectiveLeaseSha) {
    const ancestorCheck = spawnImpl(
      'git',
      ['merge-base', '--is-ancestor', effectiveLeaseSha, headSha],
      {cwd, encoding: 'utf8', timeout: 5000},
    );
    if (ancestorCheck.status !== 0) {
      throw Error('NON_FAST_FORWARD_LOCAL_LINEAGE_DENIED');
    }
  }

  if (typeof journalPath === 'string' && journalPath.trim() && fs.existsSync(journalPath)) {
    let entries;
    try {
      entries = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    } catch {
      throw Error('PUBLICATION_JOURNAL_CORRUPT');
    }
    const list = Array.isArray(entries) ? entries : [entries];
    const isPreCommitBaselineCheck =
      effectiveLeaseSha !== null && headSha === effectiveLeaseSha;
    if (
      list.some(entry => {
        if (
          !entry ||
          entry.published !== true ||
          entry.repository !== expectedRepository ||
          entry.branch !== targetBranch
        ) {
          return false;
        }
        if (missionId && entry.missionId && entry.missionId === missionId) {
          return true;
        }
        if (entry.headSha === headSha) {
          return !(isPreCommitBaselineCheck && missionId && entry.missionId !== missionId);
        }
        return false;
      })
    ) {
      throw Error('DUPLICATE_PUBLICATION_PREVENTED');
    }
  }

  const transport = env.WOLF_FACTORY_GIT_TRANSPORT || 'https-token';
  if (transport !== 'ssh-deploy-key' && transport !== 'https-token') {
    throw Error('UNAUTHORIZED_GIT_TRANSPORT');
  }
  const remoteCheck = spawnImpl('git', ['remote', 'get-url', 'origin'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
  const remoteUrl = String(remoteCheck.stdout || '').trim();
  const expectedRemote =
    transport === 'ssh-deploy-key'
      ? `git@github.com:${expectedRepository}.git`
      : `https://github.com/${expectedRepository}.git`;
  if (remoteCheck.status !== 0 || (!allowLocalRemoteForTesting && remoteUrl !== expectedRemote)) {
    throw Error('UNAUTHORIZED_GIT_REMOTE');
  }

  if (!hasExplicitRemoteCas && expectedBaseSha !== undefined) {
    verifyRemotePublishedCommit({
      expectedSha: expectedBaseSha, cwd, env, spawnImpl,
      expectedRepository, targetBranch, allowLocalRemoteForTesting,
    });
  }

  const pushArgs = effectiveLeaseSha
    ? [
        'push',
        '--dry-run',
        `--force-with-lease=refs/heads/${targetBranch}:${effectiveLeaseSha}`,
        'origin',
        `HEAD:refs/heads/${targetBranch}`,
      ]
    : ['push', '--dry-run', 'origin', `HEAD:refs/heads/${targetBranch}`];
  const pushResult = spawnImpl('git', pushArgs, {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: {...env, GIT_TERMINAL_PROMPT: '0', WOLF_GIT_PUBLICATION_FENCE: String(leaseFence)},
  });
  const safeStderr = redactGitPublicationOutput(pushResult.stderr, env);
  const reason = classifyGitPublicationResult({
    status: pushResult.status,
    stderr: String(pushResult.stderr || ''),
    signal: pushResult.signal,
    errorCode: pushResult.error?.code,
  });
  const receipt = {
    exitCode: pushResult.status,
    reason,
    transport,
    refUpdated: false,
    originalError: {
      stderr: safeStderr,
      signal: pushResult.signal ?? null,
      errorCode: pushResult.error?.code,
    },
  };
  if (pushResult.status !== 0 || reason !== 'AUTHORIZED') {
    const failure = Error(reason);
    failure.diagnostic = receipt;
    throw failure;
  }
  return receipt;
}

export const SYNTHETIC_RECEIPT_FILENAME_PATTERN =
  /^(?:OMEGA_[ABC]_[0-9]+|WOLF_WAKEUP_MANUAL_[0-9]+|WOLF_WAKEUP_SCHEDULE_ACCEPTANCE_V[0-9]+)-(provider|integrated-review|remote|verifiers|cleanup)\.json$/;

export function isAuthorizedSyntheticReceiptFilename(name) {
  return typeof name === 'string' && SYNTHETIC_RECEIPT_FILENAME_PATTERN.test(name);
}

export function expectedSyntheticTargetForMissionId(missionId) {
  if (typeof missionId !== 'string') return null;
  const omega = /^OMEGA_([ABC])_([0-9]+)$/.exec(missionId);
  if (omega) {
    return `docs/factory-acceptance/omega-${omega[2]}-${omega[1].toLowerCase()}.py`;
  }
  const manualWakeup = /^WOLF_WAKEUP_MANUAL_([0-9]+)$/.exec(missionId);
  if (manualWakeup) {
    return `docs/factory-acceptance/wolf-wakeup-manual-${manualWakeup[1]}.py`;
  }
  const scheduledWakeup = /^WOLF_WAKEUP_SCHEDULE_ACCEPTANCE_V([0-9]+)$/.exec(missionId);
  if (scheduledWakeup) {
    return `docs/factory-acceptance/wolf-wakeup-schedule-acceptance-v${scheduledWakeup[1]}.py`;
  }
  return null;
}

export function authorizeSyntheticEngineeringScope({missionId, changedFiles} = {}) {
  const expectedTarget = expectedSyntheticTargetForMissionId(missionId);
  if (!expectedTarget) {
    return {authorized: false, reason: 'GROQ_SYNTHETIC_ENGINEERING_SCOPE_DENIED'};
  }
  if (!Array.isArray(changedFiles) || changedFiles.length !== 1) {
    return {authorized: false, reason: 'GROQ_SYNTHETIC_ENGINEERING_SCOPE_DENIED'};
  }
  const candidate = changedFiles[0];
  if (
    typeof candidate !== 'string' ||
    candidate.includes('..') ||
    candidate.includes('\\') ||
    candidate.startsWith('/') ||
    candidate !== expectedTarget
  ) {
    return {authorized: false, reason: 'GROQ_SYNTHETIC_ENGINEERING_SCOPE_DENIED'};
  }
  return {
    authorized: true,
    reason: 'SYNTHETIC_ENGINEERING_SCOPE_AUTHORIZED',
    missionId,
    target: expectedTarget,
  };
}

export function verifyRemotePublishedCommit({
  expectedSha,
  cwd = process.cwd(),
  env = process.env,
  spawnImpl = spawnSync,
  expectedRepository = CANONICAL_REPOSITORY,
  targetBranch = CANONICAL_BRANCH,
  allowLocalRemoteForTesting = false,
} = {}) {
  if (targetBranch === 'main' || targetBranch !== CANONICAL_BRANCH) {
    throw Error('UNAUTHORIZED_TARGET_BRANCH');
  }
  if (expectedRepository !== CANONICAL_REPOSITORY) {
    throw Error('UNAUTHORIZED_TARGET_REPOSITORY');
  }
  if (typeof expectedSha !== 'string' || !/^[a-f0-9]{40}$/.test(expectedSha)) {
    throw Error('INVALID_EXPECTED_COMMIT_SHA');
  }
  const transport = env.WOLF_FACTORY_GIT_TRANSPORT || 'ssh-deploy-key';
  if (transport !== 'ssh-deploy-key' && transport !== 'https-token') {
    throw Error('UNAUTHORIZED_GIT_TRANSPORT');
  }
  const remoteCheck = spawnImpl('git', ['remote', 'get-url', 'origin'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
  const remoteUrl = String(remoteCheck.stdout || '').trim();
  const expectedRemote =
    transport === 'ssh-deploy-key'
      ? `git@github.com:${expectedRepository}.git`
      : `https://github.com/${expectedRepository}.git`;
  if (remoteCheck.status !== 0 || (!allowLocalRemoteForTesting && remoteUrl !== expectedRemote)) {
    throw Error('UNAUTHORIZED_GIT_REMOTE');
  }
  const lsRemote = spawnImpl(
    'git',
    ['ls-remote', '--exit-code', 'origin', `refs/heads/${targetBranch}`],
    {
      cwd,
      encoding: 'utf8',
      timeout: 30000,
      env: {...env, GIT_TERMINAL_PROMPT: '0'},
    },
  );
  const safeStderr = redactGitPublicationOutput(lsRemote.stderr, env);
  if (lsRemote.status !== 0 || lsRemote.signal || lsRemote.error) {
    const reason = classifyGitPublicationResult({
      status: lsRemote.status,
      stderr: String(lsRemote.stderr || ''),
      signal: lsRemote.signal,
      errorCode: lsRemote.error?.code,
    });
    const failure = Error(
      reason === 'GIT_PUBLICATION_PREFLIGHT_FAILED' ? 'REMOTE_COMMIT_UNVERIFIED' : reason,
    );
    failure.diagnostic = {
      exitCode: lsRemote.status,
      reason: failure.message,
      transport,
      originalError: {
        stderr: safeStderr,
        signal: lsRemote.signal ?? null,
        errorCode: lsRemote.error?.code,
      },
    };
    throw failure;
  }
  const match = new RegExp(`^([a-f0-9]{40})\\s+refs/heads/${targetBranch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').exec(
    String(lsRemote.stdout || '').trim(),
  );
  const observedSha = match ? match[1] : null;
  if (!observedSha || observedSha !== expectedSha) {
    const failure = Error('REMOTE_COMMIT_SHA_MISMATCH');
    failure.diagnostic = {
      reason: failure.message,
      exitCode: lsRemote.status,
      expectedSha,
      observedSha,
      branch: targetBranch,
      transport,
    };
    throw failure;
  }
  return {
    verified: true,
    repository: expectedRepository,
    branch: targetBranch,
    commitSha: observedSha,
    transport,
  };
}

export async function resolveAdmittedPrivateSource({
  env = process.env,
  fetchImpl = globalThis.fetch,
  expectedRepository = CANONICAL_REPOSITORY,
  expectedBranch = CANONICAL_BRANCH,
  minVerifiedSha = env.WOLF_FACTORY_MIN_VERIFIED_SHA || MINIMUM_VERIFIED_FACTORY_SHA,
  lockedAdmittedSha = env.WOLF_FACTORY_ADMITTED_SHA || '',
  missionId = env.WOLF_MISSION_ID || null,
  leaseFence = 1,
} = {}) {
  if (expectedBranch === 'main' || expectedBranch !== CANONICAL_BRANCH) {
    throw Error('UNAUTHORIZED_TARGET_BRANCH');
  }
  if (expectedRepository !== CANONICAL_REPOSITORY) {
    throw Error('UNAUTHORIZED_TARGET_REPOSITORY');
  }
  if (typeof minVerifiedSha !== 'string' || !/^[a-f0-9]{40}$/.test(minVerifiedSha)) {
    throw Error('INVALID_MINIMUM_VERIFIED_SHA');
  }
  if (!Number.isSafeInteger(leaseFence) || leaseFence < 1) {
    throw Error('INVALID_LEASE_FENCE');
  }
  const token = env?.WOLF_FACTORY_REPO_TOKEN;
  if (typeof token !== 'string' || !token.trim() || /[\r\n\0]/.test(token)) {
    throw Error('PRIVATE_SOURCE_CREDENTIAL_REQUIRED');
  }
  if (typeof lockedAdmittedSha === 'string' && lockedAdmittedSha.trim()) {
    const trimmed = lockedAdmittedSha.trim();
    if (!/^[a-f0-9]{40}$/.test(trimmed)) {
      throw Error('INVALID_LOCKED_ADMITTED_SHA');
    }
    return Object.freeze({
      admitted: true,
      mode: 'LOCKED_UPSTREAM_ADMISSION',
      repository: expectedRepository,
      branch: expectedBranch,
      admittedSha: trimmed,
      minVerifiedSha,
      missionId: missionId || null,
      leaseFence,
    });
  }

  const headers = {
    Authorization: `Bearer ${token.trim()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'wolf-factory-source-admission',
  };

  async function githubJson(apiPath) {
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${apiPath}`, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw Error('PRIVATE_SOURCE_ADMISSION_NETWORK_UNAVAILABLE');
    }
    if (!response || response.status !== 200) {
      throw Error('PRIVATE_SOURCE_ADMISSION_DENIED');
    }
    try {
      return await response.json();
    } catch {
      throw Error('PRIVATE_SOURCE_ADMISSION_MALFORMED');
    }
  }

  const repoMeta = await githubJson(`/repos/${expectedRepository}`);
  if (
    !repoMeta ||
    repoMeta.full_name !== expectedRepository ||
    repoMeta.private !== true
  ) {
    throw Error('PRIVATE_SOURCE_REPOSITORY_MISMATCH');
  }

  const refMeta = await githubJson(
    `/repos/${expectedRepository}/git/ref/heads/${expectedBranch}`,
  );
  const headSha = refMeta?.object?.sha;
  if (
    refMeta?.ref !== `refs/heads/${expectedBranch}` ||
    refMeta?.object?.type !== 'commit' ||
    typeof headSha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(headSha)
  ) {
    throw Error('PRIVATE_SOURCE_REF_INVALID');
  }

  let aheadBy = 0;
  if (headSha !== minVerifiedSha) {
    const cmp = await githubJson(
      `/repos/${expectedRepository}/compare/${minVerifiedSha}...${headSha}`,
    );
    if (
      !cmp ||
      cmp.status !== 'ahead' ||
      !Number.isSafeInteger(cmp.behind_by) ||
      cmp.behind_by !== 0 ||
      !Number.isSafeInteger(cmp.ahead_by) ||
      cmp.ahead_by < 1
    ) {
      throw Error('PRIVATE_SOURCE_LINEAGE_NOT_FAST_FORWARD');
    }
    aheadBy = cmp.ahead_by;
  }

  return Object.freeze({
    admitted: true,
    mode: 'DYNAMIC_HEAD_ADMISSION',
    repository: expectedRepository,
    branch: expectedBranch,
    admittedSha: headSha,
    minVerifiedSha,
    aheadBy,
    missionId: missionId || null,
    leaseFence,
  });
}

// The pre-push hook records intent before the network effect. A later push may
// reconcile only that exact candidate by immutable remote readback; it never
// follows an arbitrary descendant or retries an unresolved publication.
export function renderCompareAndSwapPrePushGuard({leaseFilePath, nodeExecutable = process.execPath, minLeaseFence = 1, expectedMissionId = null, kctAuthorityPath = null}) {
  return `#!${nodeExecutable}
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const leasePath = ${JSON.stringify(leaseFilePath)};
const minimumFence = ${minLeaseFence};
const canonicalRepository = ${JSON.stringify(CANONICAL_REPOSITORY)};
const canonicalBranch = ${JSON.stringify(CANONICAL_BRANCH)};
const expectedMissionId = ${JSON.stringify(expectedMissionId)};
const kctAuthorityPath = ${JSON.stringify(kctAuthorityPath)};
const deny = reason => { throw Object.assign(new Error(reason), {wolfReason: reason}); };
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const git = args => {
  const result = spawnSync('git', args, {encoding: 'utf8', timeout: 30000, env: {...process.env, GIT_TERMINAL_PROMPT: '0'}});
  if (result.status !== 0 || result.signal || result.error) deny('REMOTE_COMMIT_UNVERIFIED');
  return String(result.stdout || '').trim();
};
let lock;
try {
  if (!fs.existsSync(leasePath)) deny('CAS_LEASE_MISSING');
  try { lock = fs.openSync(leasePath + '.lock', 'wx', 0o600); }
  catch { deny('PUBLICATION_LEASE_BUSY'); }
  const lease = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
  if (lease.repository !== canonicalRepository || lease.branch !== canonicalBranch || !sha(lease.expectedRemoteSha) || !sha(lease.admittedSha)) deny('CAS_LEASE_STATE_MISMATCH');
  const workerFence = Number(process.env.WOLF_GIT_PUBLICATION_FENCE);
  if (!Number.isSafeInteger(lease.leaseFence) || lease.leaseFence < minimumFence || !Number.isSafeInteger(workerFence) || workerFence !== lease.leaseFence) deny('STALE_LEASE_FENCE_REJECTED');
  // P0-A: Mission identity - the lease must carry the admitted mission identity.
  if (expectedMissionId) {
    if (!lease.missionId) deny('LEASE_OWNERSHIP_NOT_VALIDATED');
    if (lease.missionId !== expectedMissionId) deny('LEASE_MISSION_IDENTITY_MISMATCH');
  }
  // P0-A: Fence authority from external KCT/DBOS state - the same process cannot
  // self-authorize by overwriting a sidecar file. Cross-check against the
  // authoritative checkpoint written by a previous recovery cycle.
  let kctFence = null;
  if (kctAuthorityPath) {
    try {
      const kct = JSON.parse(fs.readFileSync(kctAuthorityPath, 'utf8'));
      kctFence = Number.isSafeInteger(kct.newFence) ? kct.newFence : (Number.isSafeInteger(kct.leaseFence) ? kct.leaseFence : null);
    } catch {
      // If the authoritative KCT state is inaccessible, fail closed.
      deny('KCT_AUTHORITY_INACCESSIBLE');
    }
    if (!Number.isSafeInteger(kctFence) || kctFence < 1) deny('KCT_AUTHORITY_INVALID');
  }
  if (kctFence !== null && lease.leaseFence < kctFence) deny('STALE_LEASE_FENCE_REJECTED');
  const lines = fs.readFileSync(0, 'utf8').trim().split(/\\r?\\n/).filter(Boolean);
  if (lines.length > 1) deny('MULTIPLE_PUBLICATION_REFS_DENIED');
  for (const line of lines) {
    const [, localSha, remoteRef, remoteSha] = line.trim().split(/\\s+/);
    const targetRef = 'refs/heads/' + canonicalBranch;
    if (remoteRef !== targetRef || !sha(localSha)) deny('UNAUTHORIZED_TARGET_BRANCH');
    const observed = git(['ls-remote', '--exit-code', process.argv[2] || 'origin', targetRef]).split(/\\s+/)[0];
    const pending = lease.pendingPublication;
    if (pending) {
      if (!sha(pending.candidateSha) || pending.expectedRemoteSha !== lease.expectedRemoteSha) deny('CAS_LEASE_STATE_MISMATCH');
      if (pending.leaseFence !== lease.leaseFence) deny('STALE_LEASE_FENCE_REJECTED');
      if (observed === lease.expectedRemoteSha) deny('PUBLICATION_OUTCOME_RECONCILIATION_REQUIRED');
      if (observed !== pending.candidateSha) deny('CONCURRENT_BRANCH_ADVANCED');
      // Exact readback of our own recorded intent is the only allowed advancement.
      lease.expectedRemoteSha = observed;
      delete lease.pendingPublication;
    }
    if (observed !== lease.expectedRemoteSha || remoteSha !== lease.expectedRemoteSha) deny('CONCURRENT_BRANCH_ADVANCED');
    const ff = spawnSync('git', ['merge-base', '--is-ancestor', lease.expectedRemoteSha, localSha], {encoding: 'utf8', timeout: 5000});
    if (ff.status !== 0 || ff.error || ff.signal) deny('CONCURRENT_BRANCH_ADVANCED');
    if (localSha !== lease.expectedRemoteSha) lease.pendingPublication = {expectedRemoteSha: lease.expectedRemoteSha, candidateSha: localSha, leaseFence: lease.leaseFence};
    const temporary = leasePath + '.tmp-' + process.pid;
    fs.writeFileSync(temporary, JSON.stringify(lease, null, 2) + '\\n', {mode: 0o600});
    fs.renameSync(temporary, leasePath);
  }
} catch (error) {
  console.error(error.wolfReason || 'CAS_PUBLICATION_GUARD_DENIED');
  process.exitCode = 1;
} finally {
  if (lock !== undefined) {
    fs.closeSync(lock);
    fs.rmSync(leasePath + '.lock', {force: true});
  }
}
`;
}

export function installCompareAndSwapPrePushGuard({
  cwd = process.cwd(),
  leaseFilePath,
  expectedRemoteSha,
  expectedRepository = CANONICAL_REPOSITORY,
  targetBranch = CANONICAL_BRANCH,
  leaseFence = 1,
  missionId = null,
  kctAuthorityPath = null,
} = {}) {
  if (targetBranch === 'main' || targetBranch !== CANONICAL_BRANCH) {
    throw Error('UNAUTHORIZED_TARGET_BRANCH');
  }
  if (expectedRepository !== CANONICAL_REPOSITORY) {
    throw Error('UNAUTHORIZED_TARGET_REPOSITORY');
  }
  if (typeof expectedRemoteSha !== 'string' || !/^[a-f0-9]{40}$/.test(expectedRemoteSha)) {
    throw Error('INVALID_EXPECTED_REMOTE_SHA');
  }
  if (typeof leaseFilePath !== 'string' || !leaseFilePath.trim()) {
    throw Error('CAS_LEASE_FILE_REQUIRED');
  }
  if (typeof missionId !== 'string' || !missionId.trim()) {
    throw Error('CAS_LEASE_MISSION_ID_REQUIRED');
  }
  if (!Number.isSafeInteger(leaseFence) || leaseFence < 1) {
    throw Error('INVALID_LEASE_FENCE');
  }

  const gitDir = path.join(cwd, '.git');
  const hooksDir = path.join(gitDir, 'hooks');
  if (!fs.existsSync(gitDir)) {
    throw Error('GIT_WORKTREE_REQUIRED');
  }
  fs.mkdirSync(hooksDir, {recursive: true});

  const leaseState = {
    repository: expectedRepository,
    branch: targetBranch,
    expectedRemoteSha,
    admittedSha: expectedRemoteSha,
    leaseFence,
    missionId: missionId || null,
  };
  fs.writeFileSync(leaseFilePath, JSON.stringify(leaseState, null, 2) + '\n', {
    mode: 0o600,
  });

  const resolvedLeasePath = path.resolve(leaseFilePath);
  const hookScript = renderCompareAndSwapPrePushGuard({leaseFilePath: resolvedLeasePath, minLeaseFence: leaseFence, expectedMissionId: missionId || null, kctAuthorityPath});
  const hookPath = path.join(hooksDir, 'pre-push');
  fs.writeFileSync(hookPath, hookScript, {mode: 0o700});
  return {
    installed: true,
    hookPath,
    leaseFilePath: resolvedLeasePath,
    leaseState,
  };
}

export function advanceCompareAndSwapLease({
  leaseFilePath,
  previousExpectedSha,
  nextExpectedSha,
  minLeaseFence = 1,
  nextLeaseFence = minLeaseFence,
  missionId = undefined,
} = {}) {
  if (typeof leaseFilePath !== 'string' || !fs.existsSync(leaseFilePath)) {
    throw Error('CAS_LEASE_MISSING');
  }
  if (
    typeof previousExpectedSha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(previousExpectedSha) ||
    typeof nextExpectedSha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(nextExpectedSha)
  ) {
    throw Error('INVALID_EXPECTED_REMOTE_SHA');
  }
  if (!Number.isSafeInteger(minLeaseFence) || minLeaseFence < 1 || !Number.isSafeInteger(nextLeaseFence)) {
    throw Error('INVALID_LEASE_FENCE');
  }
  const current = JSON.parse(fs.readFileSync(leaseFilePath, 'utf8'));
  if (!Number.isSafeInteger(current.leaseFence) || current.leaseFence < minLeaseFence) {
    throw Error('STALE_LEASE_FENCE_REJECTED');
  }
  if (nextLeaseFence < current.leaseFence) {
    throw Error('STALE_LEASE_FENCE_REJECTED');
  }
  if (current.expectedRemoteSha !== previousExpectedSha) {
    throw Error('CAS_LEASE_STATE_MISMATCH');
  }
  if (current.pendingPublication && (current.pendingPublication.candidateSha !== nextExpectedSha || current.pendingPublication.leaseFence !== current.leaseFence)) {
    throw Error('PUBLICATION_OUTCOME_RECONCILIATION_REQUIRED');
  }
  const {pendingPublication, ...settled} = current;
  const updated = {
    ...settled,
    expectedRemoteSha: nextExpectedSha,
    leaseFence: nextLeaseFence,
    ...(missionId !== undefined ? {missionId} : {}),
  };
  fs.writeFileSync(leaseFilePath, JSON.stringify(updated, null, 2) + '\n', {
    mode: 0o600,
  });
  return updated;
}

function writePublicationJournal(journalPath, entries) {
  const temporary = journalPath + '.tmp-' + process.pid;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(entries, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, journalPath);
  const directory = fs.openSync(path.dirname(journalPath), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

export function publishCompareAndSwapCommit(options = {}) {
  if ((options.targetBranch ?? CANONICAL_BRANCH) !== CANONICAL_BRANCH) throw Error('UNAUTHORIZED_TARGET_BRANCH');
  if ((options.expectedRepository ?? CANONICAL_REPOSITORY) !== CANONICAL_REPOSITORY) throw Error('UNAUTHORIZED_TARGET_REPOSITORY');
  const journalPath = options.journalPath ?? (options.env ?? process.env).WOLF_PUBLICATION_JOURNAL_PATH;
  if (typeof journalPath !== 'string' || !journalPath.trim()) throw Error('PUBLICATION_JOURNAL_REQUIRED');
  if (!options.missionId && !options.checkpointId) throw Error('PUBLICATION_IDENTITY_REQUIRED');
  fs.mkdirSync(path.dirname(journalPath), {recursive: true});
  let lock;
  try { lock = fs.openSync(journalPath + '.lock', 'wx', 0o600); }
  catch { throw Error('PUBLICATION_JOURNAL_BUSY'); }
  try { return publishCompareAndSwapCommitLocked({...options, journalPath}); }
  finally {
    fs.closeSync(lock);
    fs.rmSync(journalPath + '.lock', {force: true});
  }
}

function publishCompareAndSwapCommitLocked({
  cwd = process.cwd(),
  env = process.env,
  spawnImpl = spawnSync,
  expectedRemoteSha,
  expectedRepository = CANONICAL_REPOSITORY,
  targetBranch = CANONICAL_BRANCH,
  missionId = null,
  checkpointId = null,
  leaseFence = 1,
  leaseState = null,
  journalPath = env.WOLF_PUBLICATION_JOURNAL_PATH,
  allowLocalRemoteForTesting = false,
} = {}) {
  if (targetBranch === 'main' || targetBranch !== CANONICAL_BRANCH) {
    throw Error('UNAUTHORIZED_TARGET_BRANCH');
  }
  if (expectedRepository !== CANONICAL_REPOSITORY) {
    throw Error('UNAUTHORIZED_TARGET_REPOSITORY');
  }
  if (typeof expectedRemoteSha !== 'string' || !/^[a-f0-9]{40}$/.test(expectedRemoteSha)) {
    throw Error('INVALID_EXPECTED_REMOTE_SHA');
  }
  if (!Number.isSafeInteger(leaseFence) || leaseFence < 1) {
    throw Error('INVALID_LEASE_FENCE');
  }
  if (leaseState && Number.isSafeInteger(leaseState.activeFence) && leaseFence < leaseState.activeFence) {
    throw Error('STALE_LEASE_FENCE_REJECTED');
  }

  let journalEntries = [];
  if (typeof journalPath === 'string' && journalPath.trim() && fs.existsSync(journalPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      journalEntries = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw Error('PUBLICATION_JOURNAL_CORRUPT');
    }
    const unknownPending = journalEntries.find(
      entry =>
        entry &&
        ((missionId && entry.missionId === missionId) || (checkpointId && entry.checkpointId === checkpointId)) &&
        entry.externalEffectState === 'UNKNOWN_UNTIL_RECONCILED',
    );
    if (unknownPending) {
      throw Error('UNKNOWN_EXTERNAL_EFFECT_REPLAY_DENIED');
    }
    const alreadyPublished = journalEntries.find(
      entry =>
        entry &&
        entry.published === true &&
        entry.repository === expectedRepository &&
        entry.branch === targetBranch &&
        ((missionId && entry.missionId === missionId) ||
          (checkpointId && entry.checkpointId === checkpointId)),
    );
    if (alreadyPublished) {
      return Object.freeze({
        published: true,
        idempotentReplay: false,
        alreadyCompleted: true,
        repository: expectedRepository,
        branch: targetBranch,
        baseSha: alreadyPublished.baseSha,
        commitSha: alreadyPublished.headSha,
        missionId: alreadyPublished.missionId || null,
        checkpointId: alreadyPublished.checkpointId || null,
        leaseFence: alreadyPublished.leaseFence ?? leaseFence,
      });
    }
  }

  const branchCheck = spawnImpl('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (branchCheck.status !== 0 || branchCheck.stdout.trim() !== targetBranch) {
    throw Error('UNAUTHORIZED_LOCAL_BRANCH');
  }

  const headCheck = spawnImpl('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
  const headSha = String(headCheck.stdout || '').trim();
  if (headCheck.status !== 0 || !/^[a-f0-9]{40}$/.test(headSha)) {
    throw Error('INVALID_LOCAL_HEAD');
  }
  if (headSha === expectedRemoteSha) {
    throw Error('NO_NEW_COMMIT_TO_PUBLISH');
  }

  const ancestorCheck = spawnImpl(
    'git',
    ['merge-base', '--is-ancestor', expectedRemoteSha, headSha],
    {cwd, encoding: 'utf8', timeout: 5000},
  );
  if (ancestorCheck.status !== 0) {
    throw Error('NON_FAST_FORWARD_LOCAL_LINEAGE_DENIED');
  }

  const diffCheck = spawnImpl(
    'git',
    ['diff', '--name-only', `${expectedRemoteSha}..${headSha}`],
    {cwd, encoding: 'utf8', timeout: 5000},
  );
  if (diffCheck.status !== 0) {
    throw Error('LOCAL_DIFF_INSPECTION_FAILED');
  }
  const changedFiles = String(diffCheck.stdout || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (missionId) {
    const scope = authorizeSyntheticEngineeringScope({missionId, changedFiles});
    if (!scope.authorized) {
      throw Error(scope.reason);
    }
  }

  const transport = env.WOLF_FACTORY_GIT_TRANSPORT || 'https-token';
  if (transport !== 'ssh-deploy-key' && transport !== 'https-token') {
    throw Error('UNAUTHORIZED_GIT_TRANSPORT');
  }
  const remoteCheck = spawnImpl('git', ['remote', 'get-url', 'origin'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
  const remoteUrl = String(remoteCheck.stdout || '').trim();
  const expectedRemote =
    transport === 'ssh-deploy-key'
      ? `git@github.com:${expectedRepository}.git`
      : `https://github.com/${expectedRepository}.git`;
  if (remoteCheck.status !== 0 || (!allowLocalRemoteForTesting && remoteUrl !== expectedRemote)) {
    throw Error('UNAUTHORIZED_GIT_REMOTE');
  }

  writePublicationJournal(journalPath, [...journalEntries, {
    published: false, externalEffectState: 'UNKNOWN_UNTIL_RECONCILED',
    repository: expectedRepository, branch: targetBranch,
    baseSha: expectedRemoteSha, headSha, missionId, checkpointId, leaseFence,
  }]);

  const pushResult = spawnImpl(
    'git',
    [
      'push',
      `--force-with-lease=refs/heads/${targetBranch}:${expectedRemoteSha}`,
      'origin',
      `${headSha}:refs/heads/${targetBranch}`,
    ],
    {
      cwd,
      encoding: 'utf8',
      timeout: 30000,
      env: {...env, GIT_TERMINAL_PROMPT: '0', WOLF_GIT_PUBLICATION_FENCE: String(leaseFence)},
    },
  );
  const safeStderr = redactGitPublicationOutput(pushResult.stderr, env);
  const reason = classifyGitPublicationResult({
    status: pushResult.status,
    stderr: String(pushResult.stderr || ''),
    signal: pushResult.signal,
    errorCode: pushResult.error?.code,
  });
  if (pushResult.status !== 0 || reason !== 'AUTHORIZED') {
    const failure = Error(reason);
    failure.diagnostic = {
      exitCode: pushResult.status,
      reason,
      transport,
      expectedRemoteSha,
      candidateSha: headSha,
      originalError: {
        stderr: safeStderr,
        signal: pushResult.signal ?? null,
        errorCode: pushResult.error?.code,
      },
    };
    throw failure;
  }

  const verified = verifyRemotePublishedCommit({
    expectedSha: headSha,
    cwd,
    env,
    spawnImpl,
    expectedRepository,
    targetBranch,
    allowLocalRemoteForTesting,
  });

  if (typeof journalPath === 'string' && journalPath.trim()) {
    const nextRecord = {
      published: true,
      externalEffectState: 'VERIFIED',
      repository: expectedRepository,
      branch: targetBranch,
      baseSha: expectedRemoteSha,
      headSha: verified.commitSha,
      missionId: missionId || null,
      checkpointId: checkpointId || null,
      leaseFence,
    };
    writePublicationJournal(journalPath, [...journalEntries, nextRecord]);
  }

  return Object.freeze({
    published: true,
    idempotentReplay: false,
    alreadyCompleted: false,
    repository: expectedRepository,
    branch: targetBranch,
    baseSha: expectedRemoteSha,
    commitSha: verified.commitSha,
    transport,
    missionId: missionId || null,
    checkpointId: checkpointId || null,
    leaseFence,
  });
}

// P0-B recovery: reconcile durable UNKNOWN_UNTIL_RECONCILED publication records
// against authoritative remote Git state. Never auto-retry an external effect.
// Resume only when the result is proven; preserve checkpoint lineage and mission identity.
export function recoverPublicationUncertainty(options = {}) {
  if ((options.expectedRepository ?? CANONICAL_REPOSITORY) !== CANONICAL_REPOSITORY) throw Error('UNAUTHORIZED_TARGET_REPOSITORY');
  if ((options.targetBranch ?? CANONICAL_BRANCH) !== CANONICAL_BRANCH) throw Error('UNAUTHORIZED_TARGET_BRANCH');
  const journalPath = options.journalPath ?? process.env.WOLF_PUBLICATION_JOURNAL_PATH;
  if (typeof journalPath !== 'string' || !journalPath.trim() || !fs.existsSync(journalPath)) {
    return {recovered: [], unreconciled: [], journalMissing: true};
  }
  // Share the publisher's lock namespace so recovery cannot overwrite a newer intent.
  let lock;
  try { lock = fs.openSync(journalPath + '.lock', 'wx', 0o600); }
  catch { throw Error('PUBLICATION_JOURNAL_BUSY'); }
  try { return recoverPublicationUncertaintyLocked({...options, journalPath}); }
  finally {
    fs.closeSync(lock);
    fs.rmSync(journalPath + '.lock', {force: true});
  }
}

function recoverPublicationUncertaintyLocked({
  journalPath = process.env.WOLF_PUBLICATION_JOURNAL_PATH,
  cwd = process.cwd(),
  env = process.env,
  spawnImpl = spawnSync,
  expectedRepository = CANONICAL_REPOSITORY,
  targetBranch = CANONICAL_BRANCH,
  allowLocalRemoteForTesting = false,
} = {}) {
  const transport = env.WOLF_FACTORY_GIT_TRANSPORT || 'https-token';
  if (!['https-token', 'ssh-deploy-key'].includes(transport)) throw Error('UNAUTHORIZED_GIT_TRANSPORT');
  const remote = spawnImpl('git', ['remote', 'get-url', '--all', 'origin'], {cwd, encoding: 'utf8', timeout: 5000});
  const remoteUrl = String(remote.stdout || '').trim();
  const expectedRemote = transport === 'ssh-deploy-key' ? `git@github.com:${expectedRepository}.git` : `https://github.com/${expectedRepository}.git`;
  const localFixture = allowLocalRemoteForTesting && (path.isAbsolute(remoteUrl) || remoteUrl.startsWith('file://'));
  if (remote.status !== 0 || remote.signal || remote.error || (!localFixture && remoteUrl !== expectedRemote)) throw Error('UNAUTHORIZED_GIT_REMOTE');

  let entries;
  try {
    const parsed = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw Error('PUBLICATION_JOURNAL_CORRUPT');
  }

  const recovered = [];
  const unreconciled = [];

  for (const entry of entries) {
    if (
      !entry ||
      entry.externalEffectState !== 'UNKNOWN_UNTIL_RECONCILED' ||
      entry.repository !== expectedRepository ||
      entry.branch !== targetBranch
    ) {
      continue;
    }

    const lsRemote = spawnImpl(
      'git',
      ['ls-remote', '--exit-code', 'origin', `refs/heads/${targetBranch}`],
      {
        cwd,
        encoding: 'utf8',
        timeout: 30000,
        env: {...env, GIT_TERMINAL_PROMPT: '0'},
      },
    );

    if (lsRemote.status !== 0 || lsRemote.signal || lsRemote.error) {
      unreconciled.push({
        ...entry,
        reconciliationAttemptedAt: new Date().toISOString(),
        reason: 'REMOTE_UNVERIFIABLE',
        diagnostic: {
          exitCode: lsRemote.status,
          signal: lsRemote.signal ?? null,
          errorCode: lsRemote.error?.code ?? null,
        },
      });
      continue;
    }

    const match = new RegExp(
      `^([a-f0-9]{40})\\s+refs/heads/${targetBranch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      'm',
    ).exec(String(lsRemote.stdout || '').trim());

    const observedSha = match ? match[1] : null;

    if (observedSha && observedSha === entry.headSha) {
      const verifiedRecord = {
        ...entry,
        published: true,
        externalEffectState: 'VERIFIED',
        verifiedAt: new Date().toISOString(),
        reconciledFrom: 'UNKNOWN_UNTIL_RECONCILED',
      };
      recovered.push(verifiedRecord);
    } else if (observedSha && observedSha !== entry.headSha) {
      unreconciled.push({
        ...entry,
        reconciliationAttemptedAt: new Date().toISOString(),
        reason: 'CONFLICTING_REMOTE_STATE',
        observedSha,
        expectedSha: entry.headSha,
      });
    } else {
      unreconciled.push({
        ...entry,
        reconciliationAttemptedAt: new Date().toISOString(),
        reason: 'REMOTE_REF_NOT_OBSERVED',
      });
    }
  }

  const updatedEntries = entries.map(entry => {
    const recoveredMatch = recovered.find(r => r.headSha === entry.headSha && r.missionId === entry.missionId);
    if (recoveredMatch) return recoveredMatch;
    const unreconciledMatch = unreconciled.find(u => u.headSha === entry.headSha && u.missionId === entry.missionId);
    if (unreconciledMatch) return unreconciledMatch;
    return entry;
  });

  writePublicationJournal(journalPath, updatedEntries);

  return {
    recovered,
    unreconciled,
    journalMissing: false,
    reconciledAt: new Date().toISOString(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2] || '--verify';
  try {
    if (mode === '--prepare-ssh') {
      prepareSshPublicationCredential();
      console.log('SCOPED_SSH_PUBLICATION_PREPARED=YES');
    } else if (mode === '--cleanup-ssh') {
      cleanupSshPublicationCredential();
    } else if (mode === '--verify-remote-sha') {
      const receipt = verifyRemotePublishedCommit({expectedSha: process.argv[3]});
      console.log('WOLF_REMOTE_COMMIT_VERIFIED=' + JSON.stringify(receipt));
    } else {
      const result = verifyAuthorizedGitPublication();
      console.log('WOLF_GIT_ORIGINAL_ERROR=' + JSON.stringify(result.originalError));
      console.log(
        'WOLF_GIT_PUBLICATION_DRY_RUN=' +
          JSON.stringify({
            exitCode: result.exitCode,
            reason: result.reason,
            transport: result.transport,
            refUpdated: false,
          }),
      );
    }
  } catch (error) {
    if (error?.diagnostic) {
      console.log('WOLF_GIT_ORIGINAL_ERROR=' + JSON.stringify(error.diagnostic.originalError));
      console.log(
        'WOLF_GIT_PUBLICATION_DRY_RUN=' +
          JSON.stringify({
            exitCode: error.diagnostic.exitCode,
            reason: error.diagnostic.reason,
            transport: error.diagnostic.transport,
            refUpdated: false,
          }),
      );
      process.exitCode = 1;
    } else if (
      error?.message === 'PUBLICATION_DEPLOY_KEY_REQUIRED' ||
      error?.message === 'PUBLICATION_DEPLOY_KEY_INVALID'
    ) {
      console.error(error.message);
      process.exitCode = 78;
    } else {
      console.error(error?.message || 'GIT_PUBLICATION_PREFLIGHT_FAILED');
      process.exitCode = 1;
    }
  }
}
