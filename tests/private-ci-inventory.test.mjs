import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePackageScripts, parseWorkflowMetadata, normalizeSha, inventoryPrivateRepository} from '../scripts/private-ci-inventory.mjs';

const REPO = 'donraposo1-source/project-wolf';
const SHA = 'a'.repeat(40);
const PR = '743';
const DEPLOY_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic-only\n-----END OPENSSH PRIVATE KEY-----';

test('workflow metadata parser reports name, jobs and triggers without file content', () => {
  const source = `
name: Wolf Private CI
on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:
jobs:
  security:
    runs-on: ubuntu-latest
  build:
    runs-on: ubuntu-latest
  receipt:
    needs: [security, build]
`;
  const parsed = parseWorkflowMetadata(source);
  assert.equal(parsed.name, 'Wolf Private CI');
  assert.deepEqual(parsed.jobs, ['security', 'build', 'receipt']);
  assert.deepEqual(parsed.triggers.sort(), ['pull_request', 'push', 'workflow_dispatch']);
  assert.equal(JSON.stringify(parsed).includes('branches'), false);
});

test('workflow metadata parser fails closed on an empty or jobless workflow', () => {
  assert.deepEqual(parseWorkflowMetadata(''), {name: null, jobs: [], triggers: []});
  assert.deepEqual(parseWorkflowMetadata('name: x\njobs:\n'), {name: 'x', jobs: [], triggers: []});
});

test('package script parser returns only script names', () => {
  const source = JSON.stringify({name: 'private', scripts: {build: 'tsc', test: 'node --test', 'security:scan': 'gitleaks'}});
  assert.deepEqual(parsePackageScripts(source), ['build', 'security:scan', 'test']);
  assert.deepEqual(parsePackageScripts('not json'), []);
  assert.deepEqual(parsePackageScripts('{}'), []);
});

test('inventory requires a deploy key and never touches the network without one', async () => {
  assert.throws(() => normalizeSha('abc'), /INVENTORY_SHA_MALFORMED/);
  const result = await inventoryPrivateRepository({repository: REPO, sha: SHA, pr: PR, deployKey: ''});
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.reason, 'DEPLOY_KEY_REQUIRED');
  assert.equal(result.privateSourceFetched, false);
  assert.equal(result.privateFileContentsRead, false);
  assert.equal(result.sourcePublished, false);
});

test('inventory rejects a malformed deploy key before any clone', async () => {
  const result = await inventoryPrivateRepository({repository: REPO, sha: SHA, pr: PR, deployKey: 'not-a-key'});
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.reason, 'DEPLOY_KEY_REQUIRED');
});

test('inventory rejects an unapproved repository before using the deploy key', async () => {
  const result = await inventoryPrivateRepository({repository: 'someone/else', sha: SHA, pr: PR, deployKey: DEPLOY_KEY});
  assert.equal(result.state, 'DENIED');
  assert.equal(result.reason, 'INVENTORY_REPOSITORY_DENIED');
  assert.equal(result.privateSourceFetched, false);
  assert.deepEqual(result.selectedPrivateFilesRead, []);
});

test('inventory blocks on a PR head mismatch before cloning or reading any private file', async () => {
  const calls = [];
  const result = await inventoryPrivateRepository({
    repository: REPO,
    sha: SHA,
    pr: PR,
    deployKey: DEPLOY_KEY,
    runImpl: async (command, args) => {
      calls.push([...args]);
      if (args[0] === 'ls-remote') return {status: 0, stdout: `${'b'.repeat(40)}\trefs/pull/${PR}/head\n`, stderr: ''};
      throw new Error('clone or private-file operation must not be reached');
    },
  });
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.reason, 'PULL_REQUEST_HEAD_MISMATCH');
  assert.equal(result.pullRequestHeadMatches, false);
  assert.equal(result.privateSourceFetched, false);
  assert.equal(result.privateFileContentsRead, false);
  assert.deepEqual(calls, [['ls-remote', `git@github.com:${REPO}.git`, `refs/pull/${PR}/head`]], 'inventory queries only the configured PR ref');
});

test('inventory reports selected private file reads truthfully and fails if PR identity is unavailable', async () => {
  const workflowText = ['name: Secret fixture', 'on:', '  workflow_dispatch:', 'jobs:', '  test:', '    steps:', '      - run: echo GH_CI_PRIVATE_COMMAND_CANARY'].join('\n');
  const packageText = JSON.stringify({scripts: {test: 'node --test', build: 'vite build'}});
  const calls = [];
  const result = await inventoryPrivateRepository({
    repository: REPO,
    sha: SHA,
    pr: PR,
    deployKey: DEPLOY_KEY,
    runImpl: async (_command, args) => {
      const [subcommand, ...rest] = args;
      calls.push(args.join(' '));
      if (subcommand === 'ls-remote') return {status: 0, stdout: `${SHA}\trefs/pull/${PR}/head\n`, stderr: ''};
      if (subcommand === 'clone') return {status: 0, stdout: '', stderr: ''};
      if (subcommand === 'fetch') return {status: 0, stdout: '', stderr: ''};
      if (subcommand === 'rev-parse') return {status: 0, stdout: SHA, stderr: ''};
      if (subcommand === 'cat-file' && rest[0] === '-t') return {status: 0, stdout: 'commit', stderr: ''};
      if (subcommand === 'ls-tree' && rest.includes('.github/workflows')) return {status: 0, stdout: '.github/workflows/test.yml\n', stderr: ''};
      if (subcommand === 'show' && rest[0] === `${SHA}:.github/workflows/test.yml`) return {status: 0, stdout: workflowText, stderr: ''};
      if (subcommand === 'show' && rest[0] === `${SHA}:package.json`) return {status: 0, stdout: packageText, stderr: ''};
      if (subcommand === 'cat-file' && rest[0] === '-e') return {status: 0, stdout: '', stderr: ''};
      if (subcommand === 'ls-tree' && rest.includes('scripts')) return {status: 0, stdout: 'scripts/verify-db.mjs\n', stderr: ''};
      return {status: 1, stdout: '', stderr: 'unexpected fixture command'};
    },
  });
  assert.equal(result.state, 'INVENTORIED');
  assert.equal(result.pullRequestHeadMatches, true);
  assert.equal(result.privateSourceFetched, true);
  assert.equal(result.privateFileContentsRead, true);
  assert.equal(result.fullPrivateSourceFetched, false);
  assert.deepEqual(result.selectedPrivateFilesRead, ['.github/workflows/test.yml', 'package.json']);
  assert.match(result.sourceFetchScope, /selected workflow and package metadata/);
  assert.deepEqual(result.packageScripts, ['build', 'test']);
  assert.equal(JSON.stringify(result).includes('GH_CI_PRIVATE_COMMAND_CANARY'), false, 'workflow arguments never reach the public inventory');
  assert.ok(calls.some(command => command.includes('fetch --quiet')));

  const noPr = await inventoryPrivateRepository({repository: REPO, sha: SHA, deployKey: DEPLOY_KEY});
  assert.equal(noPr.state, 'BLOCKED');
  assert.equal(noPr.reason, 'PULL_REQUEST_NUMBER_REQUIRED');
});
