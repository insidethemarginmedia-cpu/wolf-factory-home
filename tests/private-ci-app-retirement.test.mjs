import assert from 'node:assert/strict';
import test from 'node:test';
import {decideFallbackRetirement, fallbackAllowed, RETIREMENT_STATES} from '../scripts/private-ci-app-auth.mjs';

const accepted = {
  acceptance: {state: 'ACCEPTED', accepted: true, checks: [
    {check: 'installation-mapping', state: 'PASS'}, {check: 'independent-tokens', state: 'PASS'},
    {check: 'exact-sha-read', state: 'PASS'}, {check: 'private-check', state: 'PASS'},
    {check: 'dispatch', state: 'PASS'}, {check: 'renewal-restart', state: 'PASS'},
    {check: 'expiry-denial', state: 'PASS'},
  ]},
  authentication: {mode: 'github-app'},
  renewal: {state: 'VERIFIED', renewal: [
    {role: 'reader', source: 'github-app'}, {role: 'publisher', source: 'github-app'}, {role: 'dispatcher', source: 'github-app'},
  ]},
};

test('the fallback is retired only on a fully accepted, fully App-backed run', () => {
  const decision = decideFallbackRetirement(accepted);
  assert.equal(decision.state, RETIREMENT_STATES.RETIRE_FALLBACK);
  assert.equal(decision.retire, true);
  assert.deepEqual(decision.reasons, []);
  assert.equal(fallbackAllowed(decision), false);
});

test('a single blocked check keeps the fallback', () => {
  const decision = decideFallbackRetirement({...accepted, acceptance: {...accepted.acceptance, checks: [...accepted.acceptance.checks, {check: 'dispatch', state: 'BLOCKED'}]}});
  assert.equal(decision.retire, false);
  assert.ok(decision.reasons.some(reason => reason.startsWith('CHECKS_NOT_ALL_PASS')));
  assert.equal(fallbackAllowed(decision), true);
});

test('a PAT-backed run never retires the fallback, however green it looks', () => {
  const decision = decideFallbackRetirement({...accepted, authentication: {mode: 'pat-fallback'}});
  assert.equal(decision.retire, false);
  assert.ok(decision.reasons.includes('AUTH_MODE_NOT_GITHUB_APP'));
});

test('one role falling back keeps the fallback for everyone', () => {
  const decision = decideFallbackRetirement({...accepted, renewal: {state: 'VERIFIED', renewal: [
    {role: 'reader', source: 'github-app'}, {role: 'publisher', source: 'github-app'}, {role: 'dispatcher', source: 'pat-fallback'},
  ]}});
  assert.equal(decision.retire, false);
  assert.ok(decision.reasons.includes('RENEWAL_USED_FALLBACK'));
});

test('absent evidence keeps the fallback: ambiguity is not acceptance', () => {
  for (const input of [{}, {acceptance: null}, {acceptance: accepted.acceptance}]) {
    const decision = decideFallbackRetirement(input);
    assert.equal(decision.retire, false, 'missing evidence must not retire a working credential');
    assert.ok(decision.reasons.length > 0);
    assert.equal(decision.evaluated, true);
  }
});

test('an unreadable acceptance state is named, not treated as absent', () => {
  const decision = decideFallbackRetirement({...accepted, acceptance: {state: 'UNREADABLE', accepted: false, checks: []}});
  assert.equal(decision.retire, false);
  assert.ok(decision.reasons.some(reason => reason.includes('UNREADABLE')));
});

test('the receipt records the retirement decision from this run evidence', async () => {
  const {readRetirementDecision, readAcceptance, readAuthRecovery, readAuthenticationPosture} = await import('../scripts/private-ci-bridge.mjs');
  const {mkdtempSync, writeFileSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'retirement-'));

  const acceptanceFile = join(dir, 'a.json');
  const authFile = join(dir, 'auth.json');
  const renewalFile = join(dir, 'renewal.json');
  writeFileSync(acceptanceFile, JSON.stringify({state: 'ACCEPTED', accepted: true, checks: [{check: 'dispatch', state: 'PASS'}]}));
  writeFileSync(authFile, JSON.stringify({appAuthComplete: true, installations: {reader: 'present'}, fallback: {pat: 'present'}, credentialsPrinted: false}));
  writeFileSync(renewalFile, JSON.stringify({state: 'VERIFIED', renewal: [{role: 'reader', source: 'github-app'}]}));

  const decision = readRetirementDecision({
    acceptance: readAcceptance(acceptanceFile),
    authentication: readAuthenticationPosture(authFile),
    renewal: readAuthRecovery(renewalFile),
  });
  assert.equal(decision.retire, true);
  assert.equal(decision.credentialsPrinted, false);

  // With no artefacts at all the fallback is kept, which is the safe default.
  const blank = readRetirementDecision({
    acceptance: readAcceptance(join(dir, 'missing.json')),
    authentication: readAuthenticationPosture(join(dir, 'missing.json')),
    renewal: readAuthRecovery(join(dir, 'missing.json')),
  });
  assert.equal(blank.retire, false);
  assert.ok(blank.reasons.length > 0);
});
