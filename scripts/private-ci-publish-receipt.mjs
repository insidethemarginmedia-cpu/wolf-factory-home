// Publish the sanitized SHA-bound receipt to a dedicated private branch using
// the explicitly authorized repository deploy key. The receipt contains no
// source, log, diff or credential. Existing per-SHA refs are immutable: an exact
// retry is idempotent; different content is a conflict, never an overwrite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const PRIVATE_REPOSITORY = 'donraposo1-source/project-wolf';
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const HOST_KEY = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';

function run(command, args, {cwd, env} = {}) {
  const result = spawnSync(command, args, {cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180000});
  return {status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? ''};
}

function redact(text) {
  return String(text ?? '')
    .replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[REDACTED_TOKEN]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_KEY]')
    .replace(/https?:\/\/[^\s"'<>]+/g, '[REDACTED_URL]')
    .slice(0, 4000);
}

export async function publishPrivateReceipt({
  repository,
  sha,
  receiptPath,
  deployKey,
  runnerTemp = process.env.RUNNER_TEMP,
  runImpl = run,
} = {}) {
  if (!SHA_PATTERN.test(String(sha ?? ''))) throw Error('RECEIPT_SHA_MALFORMED');
  if (repository !== PRIVATE_REPOSITORY) return {state: 'DENIED', reason: 'PRIVATE_REPOSITORY_DENIED', refUpdated: false};
  if (typeof deployKey !== 'string' || !/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(deployKey.trim())) {
    return {state: 'BLOCKED', reason: 'DEPLOY_KEY_REQUIRED', refUpdated: false};
  }
  if (!receiptPath || !fs.existsSync(receiptPath)) return {state: 'BLOCKED', reason: 'RECEIPT_REQUIRED', refUpdated: false};
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  if (receipt.sha !== sha) return {state: 'DENIED', reason: 'RECEIPT_SHA_MISMATCH', refUpdated: false};
  const receiptText = JSON.stringify(receipt, null, 2) + '\n';
  const branch = `wolf-ci-receipts/${sha}`;
  const branchRef = `refs/heads/${branch}`;
  const remoteBranchRef = `refs/remotes/origin/${branch}`;
  const root = fs.mkdtempSync(path.join(runnerTemp || os.tmpdir(), 'wolf-ci-receipt-'));
  const keyPath = path.join(root, 'key');
  const hostsPath = path.join(root, 'known_hosts');
  const clonePath = path.join(root, 'private');
  const env = {...process.env};
  const failed = (state, reason, detail = '') => ({state, reason, ...(detail ? {detail: redact(detail)} : {}), refUpdated: false});
  try {
    fs.writeFileSync(keyPath, deployKey.trim() + '\n', {mode: 0o600, flag: 'wx'});
    fs.writeFileSync(hostsPath, HOST_KEY + '\n', {mode: 0o600, flag: 'wx'});
    const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
    const ssh = 'ssh -F /dev/null -i ' + quote(keyPath) + ' -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o UserKnownHostsFile=' + quote(hostsPath) + ' -o BatchMode=yes -o ConnectTimeout=15';
    env.GIT_SSH_COMMAND = ssh;
    env.GIT_TERMINAL_PROMPT = '0';
    const remote = `git@github.com:${repository}.git`;
    const clone = runImpl('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', remote, clonePath], {cwd: root, env});
    if (clone.status !== 0) return failed('DENIED', 'DEPLOY_KEY_CLONE_DENIED', clone.stderr);

    // The receipt ref is immutable per target SHA. Check before creating it so a
    // retry can confirm identical bytes without manufacturing a new history.
    const existing = runImpl('git', ['ls-remote', '--exit-code', '--heads', remote, branchRef], {cwd: clonePath, env});
    if (existing.status === 0) {
      const fetch = runImpl('git', ['fetch', '--depth=1', 'origin', `${branchRef}:${remoteBranchRef}`], {cwd: clonePath, env});
      if (fetch.status !== 0) return failed('FAILED', 'RECEIPT_BRANCH_READ_FAILED', fetch.stderr);
      const stored = runImpl('git', ['show', `${remoteBranchRef}:receipt.json`], {cwd: clonePath, env});
      if (stored.status === 0 && stored.stdout === receiptText) {
        return {state: 'PUBLISHED', branch, sha, receiptHash: receipt.receiptHash ?? null, refUpdated: false, forcePush: false, idempotent: true, target: branch, privateSourcePublished: false, privateLogsPublished: false};
      }
      return failed('BLOCKED', 'RECEIPT_BRANCH_CONFLICT', stored.stderr);
    }
    if (existing.status !== 2) return failed('FAILED', 'RECEIPT_BRANCH_LOOKUP_FAILED', existing.stderr);

    const config = runImpl('git', ['config', 'user.name', 'wolf-private-ci-bridge'], {cwd: clonePath, env});
    if (config.status !== 0) return failed('FAILED', 'GIT_CONFIG_FAILED', config.stderr);
    const email = runImpl('git', ['config', 'user.email', 'wolf-private-ci-bridge@users.noreply.github.com'], {cwd: clonePath, env});
    if (email.status !== 0) return failed('FAILED', 'GIT_CONFIG_FAILED', email.stderr);
    const orphan = runImpl('git', ['checkout', '--orphan', branch], {cwd: clonePath, env});
    if (orphan.status !== 0) return failed('FAILED', 'ORPHAN_BRANCH_FAILED', orphan.stderr);
    const clear = runImpl('git', ['rm', '-rf', '--ignore-unmatch', '.'], {cwd: clonePath, env});
    if (clear.status !== 0) return failed('FAILED', 'RECEIPT_BRANCH_PREPARE_FAILED', clear.stderr);
    fs.writeFileSync(path.join(clonePath, 'receipt.json'), receiptText, {mode: 0o600});
    const add = runImpl('git', ['add', 'receipt.json'], {cwd: clonePath, env});
    if (add.status !== 0) return failed('FAILED', 'RECEIPT_ADD_FAILED', add.stderr);
    const commit = runImpl('git', ['commit', '-m', `ci(receipt): ${sha}`], {cwd: clonePath, env});
    if (commit.status !== 0) return failed('FAILED', 'RECEIPT_COMMIT_FAILED', commit.stderr);
    // A normal push is a create-only operation here. If a concurrent writer won,
    // Git rejects the non-fast-forward update and we report a conflict instead.
    const push = runImpl('git', ['push', remote, `HEAD:${branchRef}`], {cwd: clonePath, env});
    if (push.status !== 0) return failed('DENIED', 'DEPLOY_KEY_PUSH_DENIED', push.stderr);
    return {state: 'PUBLISHED', branch, sha, receiptHash: receipt.receiptHash ?? null, refUpdated: true, forcePush: false, idempotent: false, target: branch, privateSourcePublished: false, privateLogsPublished: false};
  } catch {
    return failed('FAILED', 'RECEIPT_PUBLISH_FAILED');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
    for (const key of ['GIT_SSH_COMMAND', 'GIT_TERMINAL_PROMPT']) delete env[key];
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await publishPrivateReceipt({
      repository: process.env.WOLF_CI_REPOSITORY,
      sha: process.env.WOLF_CI_SHA,
      receiptPath: process.env.WOLF_CI_RECEIPT,
      deployKey: process.env.WOLF_CI_DEPLOY_KEY,
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.state === 'PUBLISHED' ? 0 : 78;
  } catch (error) {
    process.stderr.write(JSON.stringify({state: 'FAILED', reason: error?.message ?? 'RECEIPT_PUBLISH_FAILED', refUpdated: false}) + '\n');
    process.exitCode = 1;
  }
}
