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
