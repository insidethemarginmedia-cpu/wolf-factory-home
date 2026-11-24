import assert from 'node:assert/strict';
import test from 'node:test';
import {buildAppManifest, buildManifestForm, APP_NAME, MANIFEST_ENDPOINTS} from '../scripts/private-ci-app-manifest.mjs';
import {assertInstallableAcrossAccounts} from '../scripts/private-ci-app-installations.mjs';

test('the manifest requests exactly the four permissions the roles need, and no more', () => {
  const manifest = buildAppManifest();
  assert.equal(manifest.name, APP_NAME);
  assert.deepEqual(manifest.default_permissions, {
    contents: 'read',
    metadata: 'read',
    checks: 'write',
    actions: 'write',
  });
  // Anything beyond this set is privilege the bridge never uses.
  assert.equal(Object.keys(manifest.default_permissions).length, 4);
  assert.deepEqual(manifest.default_events, [], 'no webhook events are consumed');
});

test('the manifest registers no webhook, because an unverified endpoint is attack surface', () => {
  const manifest = buildAppManifest();
  assert.equal(manifest.hook_attributes.active, false);
  assert.equal(manifest.hook_attributes.url, undefined);
});

test('the authorized repositories are named, so the install is scoped by instruction', () => {
  const manifest = buildAppManifest();
  assert.deepEqual(manifest.repositories_hint, ['project-wolf', 'wolf-factory-home']);
});

test('the form targets the right GitHub endpoint for a personal and an organization account', () => {
  const personal = buildManifestForm({manifest: buildAppManifest()});
  assert.match(personal, /action="https:\/\/github\.com\/settings\/apps\/new"/);
  const org = buildManifestForm({manifest: buildAppManifest(), organization: 'donraposo1-source'});
  assert.match(org, /action="https:\/\/github\.com\/organizations\/donraposo1-source\/settings\/apps\/new"/);
  assert.equal(MANIFEST_ENDPOINTS.personal, 'https://github.com/settings/apps/new');
});

test('the embedded manifest is HTML-escaped, so the form cannot break or be injected into', () => {
  const html = buildManifestForm({manifest: buildAppManifest({name: 'Wolf "Factory" <Automation>'})});
  const value = html.match(/name="manifest" value="([^"]*)"/)[1];
  assert.equal(value.includes('<'), false);
  assert.equal(value.includes('"'), false);
  // The escaped entity survives and unescapes back to the original name.
  assert.equal(value.includes('&quot;'), true);
  assert.equal(value.includes('&lt;'), true);
});

test('a manifest cannot be produced without a name', () => {
  assert.throws(() => buildAppManifest({name: ''}), /MANIFEST_NAME_REQUIRED/);
});

test('an over-privileged App is rejected before its key is ever stored', async () => {
  const {auditGrantedPermissions} = await import('../scripts/private-ci-app-manifest.mjs');
  const excess = auditGrantedPermissions({contents: 'write', checks: 'write', actions: 'write', metadata: 'read'});
  assert.equal(excess.state, 'EXCESS');
  assert.ok(excess.excess.some(item => item.permission === 'contents' && item.granted === 'write'));

  const within = auditGrantedPermissions({contents: 'read', metadata: 'read', checks: 'write', actions: 'write'});
  assert.equal(within.state, 'WITHIN_MINIMUM');
  assert.deepEqual(within.excess, []);
});

test('an under-privileged App is reported insufficient rather than failing later at mint time', async () => {
  const {auditGrantedPermissions} = await import('../scripts/private-ci-app-manifest.mjs');
  const result = auditGrantedPermissions({checks: 'write'});
  assert.equal(result.state, 'INSUFFICIENT');
  assert.deepEqual(result.missing.map(item => item.permission).sort(), ['contents', 'metadata']);
});

test('a conversion summary never carries the private key', async () => {
  const {readConversion} = await import('../scripts/private-ci-app-manifest.mjs');
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nSECRET\n-----END RSA PRIVATE KEY-----';
  const {summary, privateKey} = readConversion({id: 12345, slug: 'wolf-factory-automation', owner: {login: 'insidethemarginmedia-cpu'}, pem, permissions: {contents: 'read', metadata: 'read', checks: 'write', actions: 'write'}, events: []});
  assert.equal(summary.appId, 12345);
  assert.equal(summary.hasPrivateKey, true);
  assert.equal(summary.audit, 'WITHIN_MINIMUM');
  assert.equal(JSON.stringify(summary).includes('SECRET'), false, 'the key is returned separately, never in the summary');
  assert.equal(privateKey, pem);
});

test('a personal account targets the personal endpoint, never the organization one', () => {
  const form = buildManifestForm({manifest: buildAppManifest({accountType: 'user'})});
  assert.match(form, /action="https:\/\/github\.com\/settings\/apps\/new"/);
  assert.equal(form.includes('/organizations/'), false, 'neither Wolf account is an organization');
});

test('the manifest is public, because a private App installs on one account only', () => {
  const manifest = buildAppManifest();
  assert.equal(manifest.public, true);
  // A public manifest must pass the gate, and a private one must not.
  assert.equal(assertInstallableAcrossAccounts(manifest), true);
  assert.throws(() => assertInstallableAcrossAccounts({...manifest, public: false}), /APP_MUST_BE_PUBLIC_FOR_MULTI_ACCOUNT_INSTALL/);
});

test('the redirect is an absolute https URL GitHub can actually return to', () => {
  const manifest = buildAppManifest({owner: 'insidethemarginmedia-cpu'});
  assert.match(manifest.redirect_url, /^https:\/\//);
  assert.equal(manifest.redirect_url.includes('/actions'), false, 'a repository tab is not a callback');
});

test('an organization form still requires naming the organization', () => {
  assert.throws(() => buildManifestForm({manifest: buildAppManifest(), accountType: 'organization'}), /MANIFEST_ORGANIZATION_REQUIRED/);
});
