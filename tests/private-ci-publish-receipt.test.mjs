import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {publishPrivateReceipt} from '../scripts/private-ci-publish-receipt.mjs';

const sha = 'a'.repeat(40);

test('receipt publication fails closed without a deploy key or receipt', async () => {
  assert.deepEqual(await publishPrivateReceipt({repository: 'donraposo1-source/project-wolf', sha, receiptPath: '/nonexistent', deployKey: ''}), {state: 'BLOCKED', reason: 'DEPLOY_KEY_REQUIRED', refUpdated: false});
  assert.deepEqual(await publishPrivateReceipt({repository: 'donraposo1-source/project-wolf', sha, receiptPath: '/nonexistent', deployKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'}), {state: 'BLOCKED', reason: 'RECEIPT_REQUIRED', refUpdated: false});
});

test('receipt publication rejects a SHA mismatch before any Git access', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-ci-receipt-test-'));
  const receiptPath = path.join(root, 'receipt.json');
  fs.writeFileSync(receiptPath, JSON.stringify({sha: 'b'.repeat(40), receiptHash: 'c'.repeat(64)}));
  const result = await publishPrivateReceipt({repository: 'donraposo1-source/project-wolf', sha, receiptPath, deployKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'});
  assert.equal(result.state, 'DENIED');
  assert.equal(result.reason, 'RECEIPT_SHA_MISMATCH');
  assert.equal(result.refUpdated, false);
  fs.rmSync(root, {recursive: true, force: true});
});

test('receipt publication rejects a malformed SHA', async () => {
  await assert.rejects(publishPrivateReceipt({repository: 'donraposo1-source/project-wolf', sha: 'abc', receiptPath: '/nonexistent', deployKey: 'key'}), /RECEIPT_SHA_MALFORMED/);
});

test('receipt publication never force-overwrites its immutable SHA branch', () => {
  const source = fs.readFileSync('scripts/private-ci-publish-receipt.mjs', 'utf8');
  assert.doesNotMatch(source, /['\"]--force(?:-with-lease)?['\"]/);
  assert.doesNotMatch(source, /forcePush:\s*true/);
});

test('a new receipt ref uses a normal create-only push', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-ci-receipt-create-'));
  const receiptPath = path.join(root, 'receipt.json');
  fs.writeFileSync(receiptPath, JSON.stringify({sha, receiptHash: 'c'.repeat(64)}));
  const commands = [];
  const runImpl = (command, args) => {
    commands.push([command, args]);
    if (args[0] === 'clone') fs.mkdirSync(args.at(-1), {recursive: true});
    if (args[0] === 'ls-remote') return {status: 2, stdout: '', stderr: ''};
    return {status: 0, stdout: '', stderr: ''};
  };
  const result = await publishPrivateReceipt({
    repository: 'donraposo1-source/project-wolf', sha, receiptPath,
    deployKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----',
    runnerTemp: root, runImpl,
  });
  assert.equal(result.state, 'PUBLISHED');
  assert.equal(result.refUpdated, true);
  assert.equal(result.forcePush, false);
  const push = commands.find(([, args]) => args[0] === 'push');
  assert.ok(push);
  assert.equal(push[1].includes('--force'), false);
  fs.rmSync(root, {recursive: true, force: true});
});

test('an identical existing receipt is an idempotent read and a different one is blocked', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-ci-receipt-existing-'));
  const receipt = {sha, receiptHash: 'd'.repeat(64)};
  const receiptPath = path.join(root, 'receipt.json');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  const ref = `refs/heads/wolf-ci-receipts/${sha}`;
  const runFor = stored => (command, args) => {
    if (args[0] === 'clone') fs.mkdirSync(args.at(-1), {recursive: true});
    if (args[0] === 'ls-remote') return {status: 0, stdout: `${'a'.repeat(40)}\t${ref}\n`, stderr: ''};
    if (args[0] === 'show') return {status: 0, stdout: stored, stderr: ''};
    return {status: 0, stdout: '', stderr: ''};
  };
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----';
  const identical = await publishPrivateReceipt({repository: 'donraposo1-source/project-wolf', sha, receiptPath, deployKey: key, runnerTemp: root, runImpl: runFor(JSON.stringify(receipt, null, 2) + '\n')});
  assert.equal(identical.state, 'PUBLISHED');
  assert.equal(identical.idempotent, true);
  assert.equal(identical.refUpdated, false);
  const conflict = await publishPrivateReceipt({repository: 'donraposo1-source/project-wolf', sha, receiptPath, deployKey: key, runnerTemp: root, runImpl: runFor('{}\n')});
  assert.equal(conflict.state, 'BLOCKED');
  assert.equal(conflict.reason, 'RECEIPT_BRANCH_CONFLICT');
  assert.equal(conflict.refUpdated, false);
  fs.rmSync(root, {recursive: true, force: true});
});
