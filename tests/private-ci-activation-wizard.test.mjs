import assert from 'node:assert/strict';
import test from 'node:test';
import {buildWizardHtml, secretInstructions, ACCOUNTS, WIZARD_STEPS} from '../scripts/private-ci-activation-wizard.mjs';

const html = buildWizardHtml();

test('the wizard contains no secret material of any kind', () => {
  // A wizard that leaks a key defeats its own purpose, so this is checked by
  // pattern rather than by eyeballing the output.
  assert.equal(/BEGIN [A-Z ]*PRIVATE KEY/.test(html), false, 'no private key');
  assert.equal(/gh[pousr]_[A-Za-z0-9]{16,}/.test(html), false, 'no token');
  assert.equal(/ghs_[A-Za-z0-9]{16,}/.test(html), false, 'no installation token');
  assert.equal(/WOLF_FACTORY_APP_PRIVATE_KEY=[^\s<]/.test(html), false, 'no assigned secret value');
});

test('every link targets a personal account, never an organization', () => {
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(match => match[1]);
  assert.ok(hrefs.length >= 4);
  assert.equal(hrefs.some(href => href.includes('/organizations/')), false);
  assert.ok(hrefs.includes('https://github.com/settings/apps/new'));
  assert.ok(hrefs.includes('https://github.com/settings/installations'));
  assert.ok(hrefs.some(href => href.endsWith('/installations/select_target')), 'the account chooser is offered, since an existing install hides it');
});

test('the repository restriction is stated for both accounts', () => {
  assert.ok(html.includes('project-wolf'));
  assert.ok(html.includes('wolf-factory-home'));
  assert.ok(html.includes('Only select repositories'));
  assert.ok(html.includes('Never &quot;All repositories&quot;') || html.includes('Never "All repositories"'));
});

test('the public-visibility requirement is explained, not just asserted', () => {
  assert.ok(html.includes('must be public'));
  assert.ok(html.includes('installed on the account that owns it'));
});

test('the wizard states that the three role installation IDs are equal on purpose', () => {
  assert.ok(html.includes('Why the three installation IDs are equal'));
  const plan = secretInstructions();
  const idSecrets = plan.filter(item => item.name.endsWith('INSTALLATION_ID'));
  assert.equal(idSecrets.length, 3);
  assert.ok(idSecrets.every(item => item.note.includes('expected') || item.note.includes('Repeats')));
});

test('the App ID and private key are requested, and the key is flagged as never-shared', () => {
  const names = secretInstructions().map(item => item.name);
  assert.ok(names.includes('WOLF_FACTORY_APP_ID'));
  assert.ok(names.includes('WOLF_FACTORY_APP_PRIVATE_KEY'));
  const key = secretInstructions().find(item => item.name === 'WOLF_FACTORY_APP_PRIVATE_KEY');
  assert.match(key.note, /never see/);
});

test('the wizard covers four ordered steps and both account types are User', () => {
  assert.deepEqual(WIZARD_STEPS.map(step => step.id), ['create', 'install', 'ids', 'secrets']);
  assert.ok(ACCOUNTS.every(account => account.type === 'User'));
  assert.deepEqual(ACCOUNTS.map(account => account.login), ['donraposo1-source', 'insidethemarginmedia-cpu']);
});

test('the wizard is valid, complete HTML rather than a fragment', () => {
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<\/html>\s*$/);
  assert.equal((html.match(/<h2>/g) ?? []).length >= 4, true);
});

test('the error table names the failures an operator will actually hit', () => {
  for (const reason of ['APP_INSTALLATION_NOT_FOUND', 'APP_GRANT_DIFFERS', 'OVER_SCOPED', 'APP_JWT_REJECTED']) {
    assert.ok(html.includes(reason), `missing guidance for ${reason}`);
  }
});
