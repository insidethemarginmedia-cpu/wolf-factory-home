// Read-only inventory of the private repository CI surface over the explicitly
// authorized repository-scoped SSH deploy key. No source file content, diff,
// log, credential or command output is published: only workflow/job names,
// package script names and immutable-ref metadata.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const HOST_KEY = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';

export function normalizeSha(value) {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!SHA_PATTERN.test(sha)) throw Error('INVENTORY_SHA_MALFORMED');
  return sha;
}

export function parseWorkflowMetadata(source) {
  const lines = String(source ?? '').split('\n');
  const name = lines.find(line => /^name:\s*/.test(line))?.replace(/^name:\s*/, '').trim().replace(/^['"]|['"]$/g, '') ?? null;
  const jobs = [];
  let inJobs = false;
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (inJobs && /^[^\s]/.test(line)) break;
    if (inJobs) {
      const match = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
      if (match) jobs.push(match[1]);
    }
  }
  const triggers = [];
  if (/^on:\s*$/m.test(source ?? '')) {
    const onBlock = String(source ?? '').split(/^on:\s*$/m)[1] ?? '';
    const block = onBlock.split(/^[^\s#]/m)[0] ?? '';
    for (const trigger of ['push', 'pull_request', 'pull_request_target', 'workflow_dispatch', 'repository_dispatch', 'schedule', 'workflow_call', 'workflow_run']) {
      if (new RegExp('^ {2}' + trigger + ':', 'm').test(block)) triggers.push(trigger);
    }
  }
  return {name, jobs, triggers};
}

export function parsePackageScripts(source) {
  try {
    const parsed = JSON.parse(String(source ?? '{}'));
    return Object.keys(parsed?.scripts ?? {}).sort();
  } catch {
    return [];
  }
}

function run(command, args, {cwd, env} = {}) {
  const result = spawnSync(command, args, {cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 300000});
  return {status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? ''};
}

function redact(text) {
  return String(text ?? '')
    .replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[REDACTED_TOKEN]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_KEY]')
    .replace(/https?:\/\/[^\s"'<>]+/g, '[REDACTED_URL]')
    .slice(0, 4000);
}

export async function inventoryPrivateRepository({repository, sha, pr, deployKey, runnerTemp = process.env.RUNNER_TEMP, fetchImpl = globalThis.fetch} = {}) {
  const normalizedSha = normalizeSha(sha);
  const base = {
    state: 'INVENTORIED',
    repository,
    sha: normalizedSha,
    pullRequestNumber: pr ? Number(pr) : null,
    privateSourceFetched: false,
    sourcePublished: false,
    inferencePerformed: false,
    refUpdated: false,
  };
  if (typeof deployKey !== 'string' || !/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(deployKey.trim())) {
    return {...base, state: 'BLOCKED', reason: 'DEPLOY_KEY_REQUIRED'};
  }
  const root = fs.mkdtempSync(path.join(runnerTemp || os.tmpdir(), 'wolf-private-inventory-'));
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
    const refs = run('git', ['ls-remote', remote], {cwd: root, env});
    if (refs.status !== 0) {
      return {...base, state: 'DENIED', reason: 'DEPLOY_KEY_REMOTE_DENIED', detail: redact(refs.stderr)};
    }
    const refLines = refs.stdout.split('\n').filter(Boolean);
    const pullRef = pr ? `refs/pull/${pr}/head` : null;
    const pullLine = pullRef ? refLines.find(line => line.endsWith('\t' + pullRef)) : null;
    const pullHeadSha = pullLine ? pullLine.split('\t')[0] : null;
    const clone = run('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', remote, clonePath], {cwd: root, env});
    if (clone.status !== 0) {
      return {...base, state: 'DENIED', reason: 'DEPLOY_KEY_CLONE_DENIED', detail: redact(clone.stderr)};
    }
    const commit = run('git', ['cat-file', '-t', normalizedSha], {cwd: clonePath, env});
    if (commit.status !== 0 || commit.stdout.trim() !== 'commit') {
      return {...base, state: 'DENIED', reason: 'PRIVATE_COMMIT_NOT_FOUND', pullHeadMatches: pullHeadSha === normalizedSha};
    }
    const tree = run('git', ['ls-tree', '-r', '--name-only', normalizedSha, '--', '.github/workflows'], {cwd: clonePath, env});
    const workflowFiles = tree.status === 0 ? tree.stdout.split('\n').filter(file => /^\.github\/workflows\/[^/]+\.(ya?ml)$/.test(file)).sort() : [];
    const workflows = [];
    for (const file of workflowFiles) {
      const shown = run('git', ['show', `${normalizedSha}:${file}`], {cwd: clonePath, env});
      if (shown.status !== 0) continue;
      workflows.push({path: file, ...parseWorkflowMetadata(shown.stdout)});
    }
    const packageShown = run('git', ['show', `${normalizedSha}:package.json`], {cwd: clonePath, env});
    const packageScripts = packageShown.status === 0 ? parsePackageScripts(packageShown.stdout) : [];
    const hasPackageJson = packageShown.status === 0;
    const hasLockfile = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'].some(file => {
      return run('git', ['cat-file', '-e', `${normalizedSha}:${file}`], {cwd: clonePath, env}).status === 0;
    });
    const scriptTree = run('git', ['ls-tree', '-r', '--name-only', normalizedSha, '--', 'scripts'], {cwd: clonePath, env});
    const scriptCandidates = scriptTree.status === 0
      ? scriptTree.stdout.split('\n').filter(file => /(?:dbos|kct|schema|postgres|migration|security|lint|test|build)/i.test(file)).sort().slice(0, 200)
      : [];
    const workflowCommands = [];
    for (const workflow of workflows) {
      const shown = run('git', ['show', `${normalizedSha}:${workflow.path}`], {cwd: clonePath, env});
      if (shown.status !== 0) continue;
      const runBlocks = [...shown.stdout.matchAll(/(?:^|\n)\s*run:\s*(?:\|[-+]?|>[-+]?)?\s*\n([\s\S]*?)(?=\n\s{0,8}(?:[a-zA-Z_-]+:|-[ ]name:|jobs:|$))/g)].map(match => match[1]);
      const commands = [];
      for (const block of runBlocks) {
        for (const line of block.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const parts = trimmed.split(/\s+/);
          const executable = parts[0]?.replace(/^.*\//, '') ?? '';
          const firstArg = parts[1] ?? '';
          if (!['node', 'npm', 'npx', 'python', 'python3', 'bash', 'sh', 'docker', 'psql', 'git', 'echo', 'test', 'set', 'export'].includes(executable)) continue;
          commands.push({executable, firstArg: firstArg.replace(/^['"]|['"]$/g, '').slice(0, 160), referencesScripts: /(?:^|\/)scripts\//.test(firstArg)});
        }
      }
      workflowCommands.push({path: workflow.path, commands});
    }
    const workflowPaths = new Set(workflows.flatMap(workflow => [workflow.path]));
    const triggerSet = new Set(workflows.flatMap(workflow => workflow.triggers));
    return {
      ...base,
      state: 'INVENTORIED',
      sshAccess: true,
      commitPresent: true,
      pullRequestHeadMatches: pullHeadSha ? pullHeadSha === normalizedSha : null,
      pullRequestHeadRefObserved: Boolean(pullLine),
      workflows,
      workflowPaths: [...workflowPaths].sort(),
      triggers: [...triggerSet].sort(),
      hasPackageJson,
      packageScripts,
      hasLockfile,
      scriptCandidates,
      workflowCommands,
    };
  } catch (error) {
    return {...base, state: 'FAILED', reason: error?.message === 'INVENTORY_SHA_MALFORMED' ? 'INVENTORY_SHA_MALFORMED' : 'INVENTORY_FAILED'};
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
    for (const key of ['GIT_SSH_COMMAND', 'GIT_TERMINAL_PROMPT']) delete env[key];
  }
}

async function publish(result, fetchImpl = globalThis.fetch) {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  if (!token || !repository || !sha) return {state: 'SKIPPED', reason: 'PUBLIC_RECEIPT_CONTEXT_REQUIRED'};
  const body = JSON.stringify(result, null, 2).slice(0, 60000);
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/commits/${sha}/comments`, {
    method: 'POST',
    headers: {authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'WolfPrivateCiInventory'},
    body: JSON.stringify({body: '```json\n' + body + '\n```'}),
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) { await response.body?.cancel(); return {state: 'FAILED', httpStatus: response.status}; }
  return {state: 'PUBLISHED'};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await inventoryPrivateRepository({
      repository: process.env.WOLF_CI_REPOSITORY,
      sha: process.env.WOLF_CI_SHA,
      pr: process.env.WOLF_CI_PR,
      deployKey: process.env.WOLF_CI_DEPLOY_KEY,
    });
    result.publication = await publish(result);
    if (process.env.WOLF_CI_PROBE_OUTPUT) {
      try {
        fs.mkdirSync(path.dirname(process.env.WOLF_CI_PROBE_OUTPUT), {recursive: true, mode: 0o700});
        fs.writeFileSync(process.env.WOLF_CI_PROBE_OUTPUT, JSON.stringify(result, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
      } catch {}
    }
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.state === 'INVENTORIED' ? 0 : 78;
  } catch (error) {
    const failure = {state: 'FAILED', reason: error?.message ?? 'INVENTORY_FAILED', privateSourceFetched: false, sourcePublished: false, inferencePerformed: false};
    try { failure.publication = await publish(failure); } catch {}
    if (process.env.WOLF_CI_PROBE_OUTPUT) {
      try {
        fs.mkdirSync(path.dirname(process.env.WOLF_CI_PROBE_OUTPUT), {recursive: true, mode: 0o700});
        fs.writeFileSync(process.env.WOLF_CI_PROBE_OUTPUT, JSON.stringify(failure, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
      } catch {}
    }
    process.stderr.write(JSON.stringify(failure) + '\n');
    process.exitCode = 1;
  }
}
