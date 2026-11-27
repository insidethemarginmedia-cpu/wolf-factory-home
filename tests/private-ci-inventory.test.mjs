import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePackageScripts, parseWorkflowMetadata, normalizeSha, inventoryPrivateRepository, buildPublicInventoryAggregate} from '../scripts/private-ci-inventory.mjs';

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
  const result = await inventoryPrivateRepository({repository: 'donraposo1-source/project-wolf', sha: 'a'.repeat(40), pr: '743', deployKey: ''});
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.reason, 'DEPLOY_KEY_REQUIRED');
  assert.equal(result.privateSourceFetched, false);
  assert.equal(result.sourcePublished, false);
});

test('inventory rejects a malformed deploy key before any clone', async () => {
  const result = await inventoryPrivateRepository({repository: 'donraposo1-source/project-wolf', sha: 'a'.repeat(40), pr: '743', deployKey: 'not-a-key'});
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.reason, 'DEPLOY_KEY_REQUIRED');
});

test('public inventory receipts are aggregate-only and redact every private selector and filename', () => {
  const privateResult = {
    state: 'INVENTORIED', repository: 'donraposo1-source/project-wolf', sha: 'a'.repeat(40),
    pullRequestNumber: 743, workflows: [{path: '.github/workflows/private.yml', name: 'Private CI'}],
    packageScripts: ['private-test'], scriptCandidates: ['scripts/private-runner.mjs'],
    workflowCommands: [{path: '.github/workflows/private.yml', commands: [{executable: 'node', firstArg: 'scripts/private-runner.mjs'}]}],
    sourcePublished: false, privateSourceFetched: false,
  };
  const aggregate = buildPublicInventoryAggregate(privateResult);
  assert.equal(aggregate.state, 'COMPLETED');
  const serialized = JSON.stringify(aggregate);
  for (const privateValue of ['donraposo1-source/project-wolf', 'a'.repeat(40), '743', 'private.yml', 'private-test', 'private-runner.mjs']) {
    assert.equal(serialized.includes(privateValue), false, `public inventory summary must omit ${privateValue}`);
  }
  assert.equal(aggregate.privateSourcePublished, false);
  assert.equal(aggregate.privateLogsPublished, false);
  assert.equal(aggregate.credentialsPrinted, false);
});
