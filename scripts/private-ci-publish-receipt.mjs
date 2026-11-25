// Publish the sanitized SHA-bound receipt to a dedicated private branch using
// the explicitly authorized repository deploy key. The receipt contains no
// source, log, diff or credential. A read-only deploy key fails closed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {BRIDGE_REPOSITORIES, verifyReceiptBinding} from './private-ci-bridge.mjs';
import {ALL_REQUIRED_CHECKS} from './private-ci-contract.mjs';

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

export async function publishPrivateReceipt({repository, sha, receiptPath, deployKey, signingKey = process.env.WOLF_CI_RECEIPT_SIGNING_KEY, checks = process.env.WOLF_CI_CHECKS ?? ALL_REQUIRED_CHECKS.join(','), expectedTreeSha, missionId = process.env.WOLF_CI_MISSION_ID, reservationKey = process.env.WOLF_CI_MISSION_RESERVATION, runnerTemp = process.env.RUNNER_TEMP} = {}) {
  if (!SHA_PATTERN.test(String(sha ?? ''))) throw Error('RECEIPT_SHA_MALFORMED');
  if (!BRIDGE_REPOSITORIES.includes(repository)) return {state: 'DENIED', reason: 'RECEIPT_REPOSITORY_DENIED', refUpdated: false};
  if (typeof deployKey !== 'string' || !/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(deployKey.trim())) {
    return {state: 'BLOCKED', reason: 'DEPLOY_KEY_REQUIRED', refUpdated: false};
  }
  if (!receiptPath || !fs.existsSync(receiptPath)) return {state: 'BLOCKED', reason: 'RECEIPT_REQUIRED', refUpdated: false};
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const verification = verifyReceiptBinding(receipt, {sha, repository, checks, signingKey, expectedTreeSha, missionId, reservationKey});
  if (!['VERIFIED', 'FAILED'].includes(verification.state)) {
    return {state: 'DENIED', reason: 'RECEIPT_NOT_AUTHENTIC', verification: {state: verification.state, reason: verification.reason}, refUpdated: false};
  }
  const branch = `wolf-ci-receipts/${sha}`;
  const root = fs.mkdtempSync(path.join(runnerTemp || os.tmpdir(), 'wolf-ci-receipt-'));
  const keyPath = path.join(root, 'key');
  const hostsPath = path.join(root, 'known_hosts');
  const clonePath = path.join(root, 'private');
  const env = {...process.env};
  try {
    fs.writeFileSync(keyPath, deployKey.trim() + '\n', {mode: 0o600, flag: 'wx'});
    fs.writeFileSync(hostsPath, HOST_KEY + '\n', {mode: 0o600, flag: 'wx'});
    const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
    const ssh = 'ssh -F /dev/null -i ' + quote(keyPath) + ' -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o UserKnownHostsFile=' + quote(hostsPath) + ' -o BatchMode=yes -o ConnectTimeout=15';
    env.GIT_SSH_COMMAND = ssh;
    env.GIT_TERMINAL_PROMPT = '0';
    const remote = `git@github.com:${repository}.git`;
    const existingRef = run('git', ['ls-remote', '--exit-code', '--heads', remote, `refs/heads/${branch}`], {cwd: root, env});
    if (existingRef.status === 0) return {state: 'DENIED', reason: 'RECEIPT_REF_ALREADY_EXISTS', refUpdated: false, forcePush: false};
    if (existingRef.status !== 2) return {state: 'DENIED', reason: 'RECEIPT_REF_CHECK_FAILED', detail: redact(existingRef.stderr), refUpdated: false, forcePush: false};
    const clone = run('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', remote, clonePath], {cwd: root, env});
    if (clone.status !== 0) return {state: 'DENIED', reason: 'DEPLOY_KEY_CLONE_DENIED', detail: redact(clone.stderr), refUpdated: false};
    const config = run('git', ['config', 'user.name', 'wolf-private-ci-bridge'], {cwd: clonePath, env});
    if (config.status !== 0) return {state: 'FAILED', reason: 'GIT_CONFIG_FAILED', detail: redact(config.stderr), refUpdated: false};
    run('git', ['config', 'user.email', 'wolf-private-ci-bridge@users.noreply.github.com'], {cwd: clonePath, env});
    const orphan = run('git', ['checkout', '--orphan', branch], {cwd: clonePath, env});
    if (orphan.status !== 0) return {state: 'FAILED', reason: 'ORPHAN_BRANCH_FAILED', detail: redact(orphan.stderr), refUpdated: false};
    run('git', ['rm', '-rf', '--ignore-unmatch', '.'], {cwd: clonePath, env});
    fs.writeFileSync(path.join(clonePath, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {mode: 0o600});
    const add = run('git', ['add', 'receipt.json'], {cwd: clonePath, env});
    if (add.status !== 0) return {state: 'FAILED', reason: 'RECEIPT_ADD_FAILED', detail: redact(add.stderr), refUpdated: false};
    const commit = run('git', ['commit', '-m', `ci(receipt): ${sha}`], {cwd: clonePath, env});
    if (commit.status !== 0) return {state: 'FAILED', reason: 'RECEIPT_COMMIT_FAILED', detail: redact(commit.stderr), refUpdated: false};
    const push = run('git', ['push', remote, `HEAD:refs/heads/${branch}`], {cwd: clonePath, env});
    if (push.status !== 0) return {state: 'DENIED', reason: 'DEPLOY_KEY_PUSH_DENIED', detail: redact(push.stderr), refUpdated: false, forcePush: false};
    return {state: 'PUBLISHED', branch, sha, receiptHash: receipt.receiptHash ?? null, refUpdated: true, forcePush: false, target: branch, privateSourcePublished: false, privateLogsPublished: false, authenticity: verification.state};
  } catch (error) {
    return {state: 'FAILED', reason: error?.message ?? 'RECEIPT_PUBLISH_FAILED', refUpdated: false};
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
      signingKey: process.env.WOLF_CI_RECEIPT_SIGNING_KEY,
      checks: process.env.WOLF_CI_CHECKS,
      expectedTreeSha: process.env.WOLF_CI_EXPECTED_TREE_SHA,
      missionId: process.env.WOLF_CI_MISSION_ID,
      reservationKey: process.env.WOLF_CI_MISSION_RESERVATION,
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.state === 'PUBLISHED' ? 0 : 78;
  } catch (error) {
    process.stderr.write(JSON.stringify({state: 'FAILED', reason: error?.message ?? 'RECEIPT_PUBLISH_FAILED', refUpdated: false}) + '\n');
    process.exitCode = 1;
  }
}
