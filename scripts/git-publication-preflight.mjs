import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export const CANONICAL_REPOSITORY = 'donraposo1-source/project-wolf';
export const CANONICAL_BRANCH = 'feat/factory-real-worker-m1-20261006';
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
  for (const name of ['wolf-publication-key', 'wolf-publication-known-hosts']) {
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
} = {}) {
  if (targetBranch === 'main' || targetBranch !== CANONICAL_BRANCH) {
    throw Error('UNAUTHORIZED_TARGET_BRANCH');
  }
  if (expectedRepository !== CANONICAL_REPOSITORY) {
    throw Error('UNAUTHORIZED_TARGET_REPOSITORY');
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

  if (typeof journalPath === 'string' && journalPath.trim() && fs.existsSync(journalPath)) {
    let entries;
    try {
      entries = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    } catch {
      throw Error('PUBLICATION_JOURNAL_CORRUPT');
    }
    const list = Array.isArray(entries) ? entries : [entries];
    if (
      list.some(
        entry =>
          entry &&
          entry.published === true &&
          entry.repository === expectedRepository &&
          entry.branch === targetBranch &&
          entry.headSha === headSha,
      )
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

  const pushResult = spawnImpl(
    'git',
    ['push', '--dry-run', 'origin', `HEAD:refs/heads/${targetBranch}`],
    {
      cwd,
      encoding: 'utf8',
      timeout: 30000,
      env: {...env, GIT_TERMINAL_PROMPT: '0'},
    },
  );
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2] || '--verify';
  try {
    if (mode === '--prepare-ssh') {
      prepareSshPublicationCredential();
      console.log('SCOPED_SSH_PUBLICATION_PREPARED=YES');
    } else if (mode === '--cleanup-ssh') {
      cleanupSshPublicationCredential();
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
