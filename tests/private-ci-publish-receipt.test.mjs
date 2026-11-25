import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {publishPrivateReceipt} from '../scripts/private-ci-publish-receipt.mjs';
import {ALL_REQUIRED_CHECKS} from '../scripts/private-ci-contract.mjs';
import {signReceipt} from '../scripts/private-ci-receipt.mjs';

const sha = 'a'.repeat(40);
const repository = 'donraposo1-source/project-wolf';
const key = 'omega synthetic receipt signing key for publisher tests';
const treeSha = 'd'.repeat(40);

function signedReceipt(targetSha) {
  return signReceipt({
    schema: 'wolf.private-ci.receipt/v1',
    state: 'VERIFIED',
    sha: targetSha,
    treeSha,
    repository,
    checkout: {sha: targetSha, treeSha, cleanBefore: true, cleanAfter: true, finalSha: targetSha, finalTreeSha: treeSha},
    testBinding: {sha: targetSha, treeSha, checks: [...ALL_REQUIRED_CHECKS]},
    missionBinding: {missionId: 'MISSION-PUBLISH-TEST-1', reservationKey: 'e'.repeat(64), sha: targetSha},
    checks: ALL_REQUIRED_CHECKS.map(name => ({name, sha: targetSha, treeSha, status: 'success'})),
    requiredChecks: ALL_REQUIRED_CHECKS.filter(name => ['security', 'lint', 'typecheck', 'unit', 'integration', 'build'].includes(name)),
    extraChecks: ALL_REQUIRED_CHECKS.filter(name => !['security', 'lint', 'typecheck', 'unit', 'integration', 'build'].includes(name)),
    failedChecks: [],
    startedAt: '2026-11-25T00:00:00.000Z',
    completedAt: '2026-11-25T00:00:01.000Z',
    failure: null,
    sourceIntegrityFailure: null,
  }, key);
}

test('receipt publication fails closed without a deploy key or receipt', async () => {
  assert.deepEqual(await publishPrivateReceipt({repository, sha, receiptPath: '/nonexistent', deployKey: ''}), {state: 'BLOCKED', reason: 'DEPLOY_KEY_REQUIRED', refUpdated: false});
  assert.deepEqual(await publishPrivateReceipt({repository, sha, receiptPath: '/nonexistent', deployKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'}), {state: 'BLOCKED', reason: 'RECEIPT_REQUIRED', refUpdated: false});
});

test('receipt publication rejects a target SHA mismatch before any Git access', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-ci-receipt-test-'));
  const receiptPath = path.join(root, 'receipt.json');
  fs.writeFileSync(receiptPath, JSON.stringify(signedReceipt('b'.repeat(40))));
  const result = await publishPrivateReceipt({repository, sha, receiptPath, signingKey: key, checks: ALL_REQUIRED_CHECKS.join(','), deployKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'});
  assert.equal(result.state, 'DENIED');
  assert.equal(result.reason, 'RECEIPT_NOT_AUTHENTIC');
  assert.equal(result.verification.reason, 'RECEIPT_SHA_MISMATCH');
  assert.equal(result.refUpdated, false);
  fs.rmSync(root, {recursive: true, force: true});
});

test('receipt publication rejects a malformed SHA', async () => {
  await assert.rejects(publishPrivateReceipt({repository, sha: 'abc', receiptPath: '/nonexistent', deployKey: 'key'}), /RECEIPT_SHA_MALFORMED/);
});
