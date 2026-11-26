import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {
  APP_SETUP_STATUS,
  MANIFEST_ENDPOINTS,
  buildAppManifest,
  buildManifestForm,
  auditGrantedPermissions,
  readConversion,
} from '../scripts/private-ci-app-manifest.mjs';

test('new App manifest and form generation fail closed while setup is unauthorized', () => {
  assert.equal(APP_SETUP_STATUS, 'WITHDRAWN');
  assert.deepEqual(MANIFEST_ENDPOINTS, {});
  assert.throws(() => buildAppManifest(), /APP_SETUP_NOT_AUTHORIZED/);
  assert.throws(() => buildManifestForm(), /APP_SETUP_NOT_AUTHORIZED/);
});

test('the manifest CLI emits a blocked decision rather than a creation form', () => {
  const result = spawnSync(process.execPath, ['scripts/private-ci-app-manifest.mjs'], {encoding: 'utf8'});
  assert.equal(result.status, 78);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.state, 'BLOCKED');
  assert.equal(report.reason, 'APP_SETUP_NOT_AUTHORIZED');
  assert.deepEqual(report.authorizedActions, []);
  assert.equal(report.credentialsPrinted, false);
  assert.equal(result.stdout.includes('<form'), false);
});

test('read-only permission audit preserves the least-privilege boundary', () => {
  const within = auditGrantedPermissions({contents: 'read', metadata: 'read', checks: 'write', actions: 'write'});
  assert.equal(within.state, 'WITHIN_MINIMUM');
  assert.deepEqual(within.excess, []);
  assert.deepEqual(within.missing, []);

  const excess = auditGrantedPermissions({contents: 'write', metadata: 'read', checks: 'write', actions: 'write'});
  assert.equal(excess.state, 'EXCESS');
  assert.ok(excess.excess.some(item => item.permission === 'contents' && item.granted === 'write'));

  const insufficient = auditGrantedPermissions({checks: 'write'});
  assert.equal(insufficient.state, 'INSUFFICIENT');
  assert.deepEqual(insufficient.missing.map(item => item.permission).sort(), ['contents', 'metadata']);
});

test('a conversion summary never contains private-key material', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nSYNTHETIC_TEST_KEY\n-----END RSA PRIVATE KEY-----';
  const {summary, privateKey} = readConversion({
    id: 12345,
    slug: 'synthetic-test-app',
    owner: {login: 'example-owner'},
    pem,
    permissions: {contents: 'read', metadata: 'read', checks: 'write', actions: 'write'},
    events: [],
  });
  assert.equal(summary.appId, 12345);
  assert.equal(summary.hasPrivateKey, true);
  assert.equal(summary.audit, 'WITHIN_MINIMUM');
  assert.equal(summary.credentialsPrinted, false);
  assert.equal(JSON.stringify(summary).includes('SYNTHETIC_TEST_KEY'), false);
  assert.equal(privateKey, pem, 'the local auditor returns the key separately, never in its summary');
});
