import {spawnSync} from 'node:child_process';
import {existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(ROOT, 'docs', 'engineering-workspace.json');
const SHA_RE = /^[0-9a-f]{40}$/i;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

export function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.repositories)) {
    throw new Error('WORKSPACE_MANIFEST_SCHEMA_INVALID');
  }
  if (typeof manifest.workspaceRelPath !== 'string' || path.isAbsolute(manifest.workspaceRelPath) || manifest.workspaceRelPath.split(/[\\/]/).includes('..')) {
    throw new Error('WORKSPACE_PATH_INVALID');
  }
  const ids = new Set();
  for (const entry of manifest.repositories) {
    if (!entry || typeof entry.id !== 'string' || !/^[a-z0-9-]+$/.test(entry.id) || ids.has(entry.id)) {
      throw new Error('WORKSPACE_REPOSITORY_ID_INVALID');
    }
    ids.add(entry.id);
    if (!REPOSITORY_RE.test(entry.repository ?? '') || entry.url !== `https://github.com/${entry.repository}.git`) {
      throw new Error('WORKSPACE_REPOSITORY_URL_INVALID');
    }
    if (!BRANCH_RE.test(entry.branch ?? '') || entry.branch.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('WORKSPACE_BRANCH_INVALID');
    }
    if (!SHA_RE.test(entry.recoverySha ?? '')) throw new Error('WORKSPACE_RECOVERY_SHA_INVALID');
    if (entry.path !== '@current') resolveRepositoryPath(ROOT, manifest.workspaceRelPath, entry.path);
    if (entry.path === '@current' && entry.id !== 'wolf-factory-home') throw new Error('WORKSPACE_CURRENT_REPOSITORY_INVALID');
  }
  if (!manifest.repositories.some(entry => entry.id === 'wolf-factory-home' && entry.path === '@current')) {
    throw new Error('WORKSPACE_HOME_ENTRY_MISSING');
  }
  if (!Array.isArray(manifest.unresolvedTargets)) throw new Error('WORKSPACE_UNRESOLVED_TARGETS_INVALID');
  return manifest;
}

export function resolveRepositoryPath(root, workspaceRelPath, repositoryPath) {
  if (typeof workspaceRelPath !== 'string' || !workspaceRelPath || path.isAbsolute(workspaceRelPath) || workspaceRelPath.split(/[\\/]/).includes('..')) {
    throw new Error('WORKSPACE_PATH_INVALID');
  }
  if (typeof repositoryPath !== 'string' || !repositoryPath || repositoryPath === '@current' || path.isAbsolute(repositoryPath)) {
    if (repositoryPath === '@current') return path.resolve(root);
    throw new Error('WORKSPACE_REPOSITORY_PATH_INVALID');
  }
  const workspace = path.resolve(root, workspaceRelPath);
  const resolved = path.resolve(workspace, repositoryPath);
  if (!resolved.startsWith(`${workspace}${path.sep}`)) throw new Error('WORKSPACE_REPOSITORY_PATH_INVALID');
  return resolved;
}

export function classifySyncState({dirty, currentBranch, expectedBranch, localSha, remoteSha, localIsAncestor, remoteIsAncestor}) {
  if (dirty) return 'DIRTY_NOT_MERGED';
  if (currentBranch !== expectedBranch) return 'WRONG_BRANCH';
  if (localSha === remoteSha) return 'UP_TO_DATE';
  if (localIsAncestor === true) return 'FAST_FORWARD_REQUIRED';
  if (remoteIsAncestor === true) return 'LOCAL_AHEAD';
  if (localIsAncestor === null || remoteIsAncestor === null) return 'ANCESTRY_CHECK_FAILED';
  return 'DIVERGED';
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {...process.env, GIT_TERMINAL_PROMPT: '0'},
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
  };
}

function normalizeGitHubRemote(remote) {
  if (typeof remote !== 'string') return null;
  const ssh = remote.match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/)(.+?)(?:\.git)?$/i);
  if (ssh) return `https://github.com/${ssh[1]}`;
  try {
    const url = new URL(remote);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.search || url.hash) return null;
    const repositoryPath = url.pathname.replace(/\.git$/i, '').replace(/\/$/, '');
    return `https://github.com${repositoryPath}`;
  } catch {
    return null;
  }
}

function isAncestor(cwd, older, newer) {
  const result = git(cwd, ['merge-base', '--is-ancestor', older, newer]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

function getCurrentBranch(cwd) {
  const result = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return result.ok ? result.stdout : null;
}

function isDirty(cwd) {
  const result = git(cwd, ['status', '--porcelain', '--untracked-files=normal']);
  return !result.ok || result.stdout.length > 0;
}

function probeBranch(entry) {
  const result = git(ROOT, ['ls-remote', '--heads', entry.url, `refs/heads/${entry.branch}`]);
  if (!result.ok) return {state: 'ACCESS_UNAVAILABLE'};
  const line = result.stdout.split('\n').find(value => value.endsWith(`refs/heads/${entry.branch}`));
  if (!line) return {state: 'BRANCH_UNAVAILABLE'};
  return {state: 'AVAILABLE', sha: line.split(/\s+/)[0]};
}

function ensureWorkspaceLink(workspacePath, root, linkName, plan) {
  const link = path.join(workspacePath, linkName);
  if (!existsSync(link)) {
    if (plan) return {state: 'WOULD_LINK_EXISTING_HOME_CLONE'};
    try {
      mkdirSync(path.dirname(link), {recursive: true});
      symlinkSync(path.relative(path.dirname(link), root), link, 'dir');
      return {state: 'LINKED_EXISTING_HOME_CLONE'};
    } catch {
      return {state: 'LINK_CREATION_FAILED'};
    }
  }
  try {
    if (lstatSync(link).isSymbolicLink() && realpathSync(link) === realpathSync(root)) return {state: 'HOME_LINK_PRESENT'};
  } catch {
    // A broken or unreadable existing path is a conflict; never replace it.
  }
  return {state: 'HOME_LINK_CONFLICT'};
}

function summarizeRepo(entry, root, workspacePath, plan) {
  const localPath = entry.path === '@current'
    ? root
    : resolveRepositoryPath(root, path.relative(root, workspacePath), entry.path);
  const exists = existsSync(localPath);
  if (plan) {
    return {
      repository: entry.repository,
      branch: entry.branch,
      recoverySha: entry.recoverySha,
      localPath: entry.path,
      state: exists ? 'PLAN_LOCAL_REPO_PRESENT' : 'PLAN_CLONE_IF_READ_ACCESS_IS_AVAILABLE',
    };
  }

  let cloned = false;
  if (!exists) {
    const probe = probeBranch(entry);
    if (probe.state !== 'AVAILABLE') {
      return {repository: entry.repository, branch: entry.branch, recoverySha: entry.recoverySha, localPath: entry.path, state: probe.state};
    }
    try {
      mkdirSync(path.dirname(localPath), {recursive: true});
    } catch {
      return {repository: entry.repository, branch: entry.branch, recoverySha: entry.recoverySha, localPath: entry.path, state: 'WORKSPACE_DIRECTORY_FAILED'};
    }
    const result = git(ROOT, ['clone', '--no-tags', '--single-branch', '--branch', entry.branch, entry.url, localPath]);
    if (!result.ok) {
      return {repository: entry.repository, branch: entry.branch, recoverySha: entry.recoverySha, localPath: entry.path, state: existsSync(localPath) ? 'CLONE_FAILED_PATH_PRESERVED' : 'CLONE_FAILED'};
    }
    cloned = true;
  }

  const repoRoot = git(localPath, ['rev-parse', '--show-toplevel']);
  if (!repoRoot.ok || path.resolve(repoRoot.stdout) !== path.resolve(localPath)) {
    return {repository: entry.repository, branch: entry.branch, recoverySha: entry.recoverySha, localPath: entry.path, state: 'PATH_CONFLICT'};
  }
  const origin = git(localPath, ['remote', 'get-url', 'origin']);
  if (!origin.ok || normalizeGitHubRemote(origin.stdout) !== `https://github.com/${entry.repository}`) {
    return {repository: entry.repository, branch: entry.branch, recoverySha: entry.recoverySha, localPath: entry.path, state: 'REMOTE_IDENTITY_MISMATCH'};
  }

  if (!cloned) {
    const fetched = git(localPath, ['fetch', 'origin', `refs/heads/${entry.branch}:refs/remotes/origin/${entry.branch}`]);
    if (!fetched.ok) return {repository: entry.repository, branch: entry.branch, recoverySha: entry.recoverySha, localPath: entry.path, state: 'FETCH_UNAVAILABLE'};
  }

  const remoteRef = `refs/remotes/origin/${entry.branch}`;
  const remoteResult = git(localPath, ['rev-parse', '--verify', remoteRef]);
  const localResult = git(localPath, ['rev-parse', 'HEAD']);
  if (!remoteResult.ok || !localResult.ok) {
    return {repository: entry.repository, branch: entry.branch, recoverySha: entry.recoverySha, localPath: entry.path, state: 'REF_UNAVAILABLE'};
  }
  const remoteSha = remoteResult.stdout;
  const localSha = localResult.stdout;
  const anchorPresent = git(localPath, ['cat-file', '-e', `${entry.recoverySha}^{commit}`]).ok;
  const anchorInRemoteHistory = anchorPresent ? isAncestor(localPath, entry.recoverySha, remoteSha) : false;
  if (!anchorInRemoteHistory) {
    return {repository: entry.repository, branch: entry.branch, recoverySha: entry.recoverySha, localSha, remoteSha, localPath: entry.path, state: 'RECOVERY_ANCHOR_NOT_IN_REMOTE_HISTORY'};
  }

  const branch = getCurrentBranch(localPath);
  const dirty = isDirty(localPath);
  const localIsAncestor = isAncestor(localPath, localSha, remoteSha);
  const remoteIsAncestor = isAncestor(localPath, remoteSha, localSha);
  const decision = classifySyncState({dirty, currentBranch: branch, expectedBranch: entry.branch, localSha, remoteSha, localIsAncestor, remoteIsAncestor});
  if (decision === 'FAST_FORWARD_REQUIRED') {
    const merged = git(localPath, ['merge', '--ff-only', remoteRef]);
    if (!merged.ok) return {repository: entry.repository, branch: entry.branch, recoverySha: entry.recoverySha, localSha, remoteSha, localPath: entry.path, state: 'FAST_FORWARD_REFUSED'};
    const current = git(localPath, ['rev-parse', 'HEAD']);
    return {repository: entry.repository, branch: entry.branch, recoverySha: entry.recoverySha, localSha: current.ok ? current.stdout : remoteSha, remoteSha, localPath: entry.path, state: cloned ? 'CLONED_AND_CURRENT' : 'FAST_FORWARDED'};
  }
  const state = cloned && decision === 'UP_TO_DATE' ? 'CLONED_AND_CURRENT' : decision;
  return {repository: entry.repository, branch, recoverySha: entry.recoverySha, localSha, remoteSha, localPath: entry.path, state};
}

function readManifest() {
  return validateManifest(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')));
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    console.log('Usage: node scripts/engineering-workspace.mjs [--plan] [--strict]\nDefault: recover missing permitted clones and fast-forward only clean expected branches.');
    return;
  }
  const plan = args.has('--plan');
  const strict = args.has('--strict');
  const manifest = readManifest();
  const workspacePath = path.resolve(ROOT, manifest.workspaceRelPath);
  const home = manifest.repositories.find(entry => entry.id === 'wolf-factory-home');
  const report = {
    workspace: manifest.workspaceRelPath,
    mode: plan ? 'plan' : 'recover-and-sync',
    remoteWrites: false,
    credentialsPersisted: false,
    repositories: [],
    unresolvedTargets: [],
  };

  if (!plan) {
    try {
      mkdirSync(workspacePath, {recursive: true});
    } catch {
      report.repositories.push({repository: home.repository, branch: home.branch, state: 'WORKSPACE_DIRECTORY_FAILED'});
    }
  }
  const link = ensureWorkspaceLink(workspacePath, ROOT, home.workspaceLink ?? home.id, plan);
  report.repositories.push({repository: home.repository, branch: home.branch, localPath: home.path, ...link});

  for (const entry of manifest.repositories) report.repositories.push(summarizeRepo(entry, ROOT, workspacePath, plan));
  for (const target of manifest.unresolvedTargets) {
    report.unresolvedTargets.push({id: target.id, pullRequest: target.pullRequest, state: 'REPOSITORY_IDENTITY_UNRESOLVED'});
  }
  console.log(JSON.stringify(report, null, 2));
  const successful = new Set(['HOME_LINK_PRESENT', 'LINKED_EXISTING_HOME_CLONE', 'UP_TO_DATE', 'CLONED_AND_CURRENT', 'FAST_FORWARDED']);
  const blocked = report.repositories.some(item => item.state && !successful.has(item.state)) || report.unresolvedTargets.length > 0;
  if (strict && blocked) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'WORKSPACE_RECOVERY_FAILED');
    process.exitCode = 1;
  }
}
