// Runtime credential use must pass through one durable-retirement selector. Presence
// inventory is not enforcement, and a second direct environment read is a bypass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';

import {credentialForRole} from '../scripts/private-ci-app-auth.mjs';
import {appendRecord, buildHeadAnchor, verifyLedger} from '../scripts/private-ci-retirement-integrity.mjs';

const b64 = value => Buffer.from(value).toString('base64');
const record = (state, at) => ({state, retire: state === 'RETIRED', recordedAt: at});
const active = appendRecord('', record('ACTIVE', '2026-11-25T00:00:00Z'));
const retired = appendRecord(active.text, record('RETIRED', '2026-11-25T01:00:00Z'));
const anchor = value => JSON.stringify(buildHeadAnchor(verifyLedger(value)));
const required = {
  WOLF_FACTORY_REPO_TOKEN: 'ghp_fixture_retired_pat',
  WOLF_CI_RETIREMENT_REQUIRE_ANCHOR: 'true',
};

test('credential routing admits only an anchored active fallback', () => {
  const routed = credentialForRole('reader', {
    env: {
      ...required,
      WOLF_CI_RETIREMENT_LEDGER_B64: b64(active.text),
      WOLF_CI_RETIREMENT_ANCHOR_B64: b64(anchor(active.text)),
    },
  });
  assert.equal(routed.source, 'pat-fallback');
  assert.equal(routed.token, 'ghp_fixture_retired_pat');
});

test('credential routing withholds the retired PAT even when it exists', () => {
  const routed = credentialForRole('reader', {
    env: {
      ...required,
      WOLF_CI_RETIREMENT_LEDGER_B64: b64(retired.text),
      WOLF_CI_RETIREMENT_ANCHOR_B64: b64(anchor(retired.text)),
    },
  });
  assert.equal(routed.source, 'none');
  assert.equal(routed.token, null);
  assert.equal(routed.reason, 'PAT_FALLBACK_RETIRED');
  assert.equal(JSON.stringify({...routed, token: null}).includes('ghp_fixture_retired_pat'), false);
});

test('missing anchor blocks a fallback without calling it retired', () => {
  const routed = credentialForRole('reader', {
    env: {...required, WOLF_CI_RETIREMENT_LEDGER_B64: b64(active.text)},
  });
  assert.equal(routed.source, 'none');
  assert.equal(routed.token, null);
  assert.equal(routed.reason, 'RETIREMENT_ANCHOR_UNAVAILABLE');
});

test('an App-issued token wins without a PAT or App secret values in the process', () => {
  const routed = credentialForRole('reader', {
    env: {WOLF_CI_APP_READER_TOKEN: 'ghs_app_reader_fixture', WOLF_FACTORY_REPO_TOKEN: 'ghp_fixture'},
  });
  assert.equal(routed.source, 'github-app');
  assert.equal(routed.token, 'ghs_app_reader_fixture');
});

test('workflow probe and PR resolver do not receive a PAT directly', () => {
  const workflow = fs.readFileSync('.github/workflows/private-ci-bridge.yml', 'utf8');
  const probe = workflow.slice(workflow.indexOf('  probe:'), workflow.indexOf('\n  inventory:'));
  const resolver = workflow.slice(workflow.indexOf('Resolve the authoritative PR head'), workflow.indexOf('Require current exact PR target'));
  assert.doesNotMatch(probe, /WOLF_FACTORY_REPO_TOKEN:\s*\$\{\{\s*secrets\./);
  assert.doesNotMatch(resolver, /WOLF_FACTORY_REPO_TOKEN/);
  assert.match(probe, /WOLF_CI_APP_READER_TOKEN/);
});

test('workflow App tokens are scoped to the metadata resolver and status publisher', () => {
  const workflow = fs.readFileSync('.github/workflows/private-ci-bridge.yml', 'utf8');
  const execute = workflow.slice(workflow.indexOf('  execute:'));
  const resolver = workflow.slice(workflow.indexOf('Resolve the authoritative PR head'), workflow.indexOf('Require current exact PR target'));
  const publisher = workflow.slice(workflow.indexOf('Publish the authenticated check to the private commit'), workflow.indexOf('Publish the sanitized public receipt', workflow.indexOf('Publish the authenticated check to the private commit')));
  assert.match(resolver, /WOLF_CI_APP_READER_TOKEN:\s*\$\{\{\s*steps\.app_reader\.outputs\.token\s*\}\}/);
  assert.doesNotMatch(resolver, /\$\{\{\s*env\.WOLF_CI_APP_READER_TOKEN/);
  assert.match(publisher, /WOLF_CI_APP_PUBLISHER_TOKEN:\s*\$\{\{\s*steps\.publisher_mint\.outputs\.token\s*\}\}/);
  assert.doesNotMatch(publisher, /\$\{\{\s*env\.WOLF_CI_APP_PUBLISHER_TOKEN/);
  assert.doesNotMatch(workflow, /WOLF_CI_APP_(?:READER|PUBLISHER)_TOKEN[^\n]*>>\s*["\']?\$GITHUB_ENV/);
  assert.equal(execute.includes('WOLF_CI_APP_READER_TOKEN: ${{ env.'), false);
  assert.equal(execute.includes('WOLF_CI_APP_PUBLISHER_TOKEN: ${{ env.'), false);
});

test('only the adversarial durable-ledger proof receives the PAT directly', () => {
  const workflow = fs.readFileSync('.github/workflows/private-ci-bridge.yml', 'utf8');
  const start = workflow.indexOf('  execute:');
  const execute = workflow.slice(start);
  const assignments = [...execute.matchAll(/WOLF_FACTORY_(?:REPO|STATUS)_TOKEN:\s*\$\{\{\s*secrets\./g)];
  assert.equal(assignments.length, 1);
  const proofStart = execute.indexOf('Prove durable fallback denial without the per-run flag');
  const nextStep = execute.indexOf('\n      - name:', proofStart + 10);
  const proof = execute.slice(proofStart, nextStep === -1 ? undefined : nextStep);
  assert.ok(proofStart >= 0);
  assert.match(proof, /WOLF_FACTORY_REPO_TOKEN:\s*\$\{\{\s*secrets\./);
  assert.doesNotMatch(execute.slice(0, proofStart), /WOLF_FACTORY_(?:REPO|STATUS)_TOKEN:\s*\$\{\{\s*secrets\./);
  if (nextStep !== -1) assert.doesNotMatch(execute.slice(nextStep), /WOLF_FACTORY_(?:REPO|STATUS)_TOKEN:\s*\$\{\{\s*secrets\./);
});

test('manual private-CI probe uses an App reader output, not a PAT env injection', () => {
  const workflow = fs.readFileSync('.github/workflows/private-controller-preflight.yml', 'utf8');
  const start = workflow.indexOf('  private-ci-probe:');
  const block = workflow.slice(start);
  assert.ok(start >= 0);
  const probe = block.slice(block.indexOf('Probe private CI metadata'), block.indexOf('    run:', block.indexOf('Probe private CI metadata')) + 2200);
  assert.doesNotMatch(probe, /WOLF_FACTORY_REPO_TOKEN:\s*\$\{\{\s*secrets\./);
  assert.match(probe, /WOLF_CI_APP_READER_TOKEN:\s*\$\{\{\s*steps\.probe_app_reader\.outputs\.token\s*\}\}/);
  assert.match(block, /Mint the least-privilege reader token/);
});

test('runtime bridge and dispatch probe route tokens through the selector', () => {
  const bridge = fs.readFileSync('scripts/private-ci-bridge.mjs', 'utf8');
  const dispatch = fs.readFileSync('scripts/private-ci-dispatch-probe.mjs', 'utf8');
  assert.match(bridge, /credentialForRole\('reader'\)/);
  assert.match(bridge, /credentialForRole\('publisher'\)/);
  assert.match(bridge, /credentialForRole\('dispatcher'\)/);
  assert.doesNotMatch(bridge, /process\.env\.WOLF_FACTORY_(?:REPO|STATUS)_TOKEN/);
  assert.match(dispatch, /credentialForRole\('dispatcher'/);
  assert.doesNotMatch(dispatch, /env\.WOLF_FACTORY_REPO_TOKEN/);
});
