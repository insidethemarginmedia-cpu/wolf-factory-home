import assert from 'node:assert/strict';
import test from 'node:test';
import {mapInstallations, buildSecretPlan, assertInstallableAcrossAccounts, INSTALL_MAP_STATES, ROLE_TARGET_REPOSITORY} from '../scripts/private-ci-app-installations.mjs';

const factory = {id: 176017917, account: {login: 'donraposo1-source', type: 'User'}, repository_selection: 'selected', repositories: [{name: 'project-wolf'}]};
const home = {id: 176144552, account: {login: 'insidethemarginmedia-cpu', type: 'User'}, repository_selection: 'selected', repositories: [{name: 'wolf-factory-home'}]};

test('two personal installations map every role, reusing one installation across roles', () => {
  const result = mapInstallations([factory, home]);
  assert.equal(result.state, INSTALL_MAP_STATES.MAPPED);
  assert.deepEqual(Object.keys(result.roles).sort(), ['dispatcher', 'publisher', 'reader']);
  assert.equal(result.roles.reader.installationId, '176017917');
  assert.equal(result.roles.publisher.installationId, '176017917');
  assert.equal(result.roles.dispatcher.installationId, '176017917');
  // Three roles, one Factory installation: reuse is intended, not a mistake.
  assert.equal(result.distinctInstallations, 1);
  assert.equal(result.reusedAcrossRoles, 2);
  assert.equal(result.home.state, 'PRESENT');
  assert.equal(result.home.installationId, '176144552');
});

test('the secret plan reuses the ID but keeps a distinct secret name per role', () => {
  const result = mapInstallations([factory, home]);
  const plan = result.secrets;
  assert.equal(plan.WOLF_FACTORY_READER_INSTALLATION_ID.value, '176017917');
  assert.equal(plan.WOLF_FACTORY_PUBLISHER_INSTALLATION_ID.value, '176017917');
  assert.equal(plan.WOLF_FACTORY_DISPATCHER_INSTALLATION_ID.value, '176017917');
  // Distinct keys, identical values: a personal account cannot host three.
  assert.equal(new Set(Object.keys(plan)).size, 3);
  assert.ok(Object.values(plan).every(entry => entry.shared === 'reused-across-roles-for-this-account'));
});

test('an all-repositories install on a personal account is refused as over-scoped', () => {
  const result = mapInstallations([{...factory, repository_selection: 'all', repositories: undefined}, home]);
  assert.equal(result.state, INSTALL_MAP_STATES.OVER_SCOPED);
  assert.equal(result.overScoped[0].reason, 'REPOSITORY_SELECTION_ALL');
});

test('an installation reaching an unauthorized repository is reported, not used', () => {
  const result = mapInstallations([{...factory, repositories: [{name: 'project-wolf'}, {name: 'some-other-repo'}]}, home]);
  assert.equal(result.state, INSTALL_MAP_STATES.UNAUTHORIZED);
  assert.deepEqual(result.unauthorized[0].repositories, ['donraposo1-source/some-other-repo']);
});

test('a missing Home installation is incomplete rather than silently ignored', () => {
  const result = mapInstallations([factory]);
  assert.equal(result.state, INSTALL_MAP_STATES.INCOMPLETE);
  assert.equal(result.home.state, 'MISSING');
  assert.equal(result.roles.reader.installationId, '176017917', 'the Factory roles still map');
});

test('a missing Factory installation blocks every Factory role and names the reason', () => {
  const result = mapInstallations([home]);
  assert.equal(result.state, INSTALL_MAP_STATES.INCOMPLETE);
  assert.equal(Object.keys(result.roles).length, 0);
  assert.ok(result.missing.every(entry => entry.reason === 'NO_INSTALLATION_FOR_ACCOUNT'));
  assert.equal(result.missing[0].account, 'donraposo1-source');
});

test('an installation that excludes the target repository does not map that role', () => {
  const result = mapInstallations([{...factory, repositories: [{name: 'different-repo'}]}, home]);
  assert.equal(Object.keys(result.roles).length, 0);
  assert.ok(result.missing.some(entry => entry.reason === 'REPOSITORY_NOT_IN_INSTALLATION'));
});

test('a selected install wins over an all install for the same account', () => {
  const result = mapInstallations([{...factory, id: 1, repository_selection: 'all'}, {...factory, id: 2, repository_selection: 'selected'}, home]);
  assert.equal(result.roles.reader.installationId, '2');
});

test('the mapping publishes no credential material', () => {
  const result = mapInstallations([factory, home]);
  assert.equal(result.credentialsPrinted, false);
  const serialized = JSON.stringify(result);
  assert.equal(/ghs_|ghp_|BEGIN [A-Z ]*PRIVATE KEY/.test(serialized), false);
});

test('a private App is rejected, because it cannot be installed on a second account', () => {
  assert.throws(() => assertInstallableAcrossAccounts({public: false}), /APP_MUST_BE_PUBLIC_FOR_MULTI_ACCOUNT_INSTALL/);
  assert.equal(assertInstallableAcrossAccounts({public: true}), true);
});

test('every role targets an authorized repository', () => {
  const targets = new Set(Object.values(ROLE_TARGET_REPOSITORY));
  assert.deepEqual([...targets].sort(), ['donraposo1-source/project-wolf', 'insidethemarginmedia-cpu/wolf-factory-home']);
});
