import assert from 'node:assert/strict';
import test from 'node:test';
import {buildDiagnosisSummary, publishDiagnosis, runDiagnosisCli} from '../scripts/private-ci-app-diagnosis.mjs';

const renewal = {
  state: 'FAILED', reason: 'APP_RENEWAL_FAILED',
  renewal: [
    {role: 'reader', source: 'github-app', renews: true, restartRecovered: true, first: {authState: 'FRESH'}, second: {authState: 'FRESH'}},
    {role: 'dispatcher', source: 'github-app', renews: false, restartRecovered: false, first: {authState: 'NONE'}, second: {authState: 'NONE'}, firstReason: 'APP_TOKEN_REQUEST_FAILED', firstMessage: 'There is at least one error with your input.', requestedPermissions: {actions: 'write', metadata: 'read'}},
  ],
};

test('the summary names the failing role, its reason and the API message', () => {
  const summary = buildDiagnosisSummary({renewal});
  assert.match(summary, /renewal state: FAILED/);
  assert.match(summary, /reader .*renews=true/);
  assert.match(summary, /dispatcher .*renews=false/);
  assert.match(summary, /reason=APP_TOKEN_REQUEST_FAILED/);
  assert.match(summary, /api: There is at least one error/);
  assert.match(summary, /requested: \{"actions":"write"/);
});

test('a missing report is stated, not silently omitted', () => {
  assert.match(buildDiagnosisSummary({}), /renewal: NO REPORT/);
  assert.match(buildDiagnosisSummary({}), /acceptance: NO REPORT/);
});

test('acceptance detail carries problems and reasons so a failure is actionable', () => {
  const summary = buildDiagnosisSummary({acceptance: {state: 'FAIL', accepted: false, checks: [
    {check: 'independent-tokens', state: 'FAIL', reason: 'GRANT_DIFFERS', problems: [{role: 'dispatcher', reason: 'GRANTED_PERMISSION_DIFFERS'}]},
  ]}});
  assert.match(summary, /acceptance state: FAIL/);
  assert.match(summary, /independent-tokens = FAIL \(GRANT_DIFFERS\)/);
  assert.match(summary, /GRANTED_PERMISSION_DIFFERS/);
});

test('the summary is redacted before it is published', () => {
  const summary = buildDiagnosisSummary({renewal: {state: 'FAILED', reason: 'APP_JWT_REJECTED', renewal: [{role: 'reader', source: 'github-app', renews: false, restartRecovered: false, first: {authState: 'NONE'}, second: {authState: 'NONE'}, firstMessage: 'rejected ghp_abcdefghijklmnopqrstuvwx and eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxIn0.c2ln'}]}});
  assert.equal(summary.includes('ghp_'), false);
  assert.equal(summary.includes('eyJhbGci'), false);
});

test('publishing never throws, because the diagnosis must not redden a run', async () => {
  const rejected = await publishDiagnosis({token: 't', repository: 'r/r', sha: 'a'.repeat(40), summary: 'x', fetchImpl: async () => ({ok: false, status: 403})});
  assert.equal(rejected.state, 'REJECTED');
  const broken = await publishDiagnosis({token: 't', repository: 'r/r', sha: 'a'.repeat(40), summary: 'x', fetchImpl: async () => { throw TypeError('network'); }});
  assert.equal(broken.state, 'UNAVAILABLE');
  const skipped = await publishDiagnosis({});
  assert.equal(skipped.state, 'SKIPPED');
});

test('the CLI publishes what it read, and survives an unreadable file', async () => {
  const lines = [];
  let body = null;
  await runDiagnosisCli(
    {GH_TOKEN: 't', PUBLIC_REPOSITORY: 'r/r', GITHUB_SHA_VALUE: 'a'.repeat(40), AUTH_RECOVERY_FILE: 'x', ACCEPTANCE_FILE: 'y'},
    {readFile: () => '{not json', fetchImpl: async (url, init) => { body = JSON.parse(init.body); return {ok: true, status: 201}; }, write: text => lines.push(text)},
  );
  assert.match(body.output.summary, /NO REPORT/, 'an unreadable artefact is reported as absent, not crashed on');
  assert.ok(lines.join('').includes('DIAGNOSIS_PUBLISHED'));
});

test('the installation probe separates a bad ID from a missing permission', async () => {
  const {probeInstallations} = await import('../scripts/private-ci-app-diagnosis.mjs');
  // The reader ID works; the dispatcher ID belongs to the other account, so it
  // cannot see this repository at all. That is the distinction being proven.
  const mint = async ({installationId}) => {
    if (installationId === '176017917') return {state: 'MINTED', token: 'ghs_x'};
    return {state: 'FAILED', reason: 'APP_TOKEN_REQUEST_FAILED', httpStatus: 422, apiMessage: 'There is at least one repository that does not exist or is not accessible to the parent installation.'};
  };
  const probed = await probeInstallations({
    env: {
      WOLF_CI_REPOSITORY: 'donraposo1-source/project-wolf',
      WOLF_FACTORY_APP_ID: '5913418', WOLF_FACTORY_APP_PRIVATE_KEY: 'k',
      WOLF_FACTORY_READER_INSTALLATION_ID: '176017917',
      WOLF_FACTORY_PUBLISHER_INSTALLATION_ID: '176017917',
      WOLF_FACTORY_DISPATCHER_INSTALLATION_ID: '176144552',
    },
    mintInstallationToken: mint,
  });
  assert.deepEqual(probed.rolesWithCoveringId, ['reader', 'publisher']);
  const dispatcher = probed.results.find(entry => entry.role === 'dispatcher');
  assert.equal(dispatcher.idCoversRepository, false);
  assert.match(dispatcher.apiMessage, /not accessible to the parent installation/);
  // Only the shape is reported; the ID itself never appears.
  assert.equal(JSON.stringify(probed).includes('176144552'), false);
});
