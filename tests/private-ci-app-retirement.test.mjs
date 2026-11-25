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

test('retirement is enforced in credential selection, not merely recorded', async () => {
  const {selectCredential, isFallbackRetired} = await import('../scripts/private-ci-app-auth.mjs');
  const env = {WOLF_FACTORY_REPO_TOKEN: 'ghp_present_but_retired', WOLF_CI_RETIRE_PAT: 'true'};
  assert.equal(isFallbackRetired(env), true);
  const reader = selectCredential('reader', {env});
  assert.equal(reader.source, 'none', 'the PAT must not be selected once retired');
  assert.equal(reader.reason, 'PAT_FALLBACK_RETIRED');
  assert.equal(reader.withheldCredential, 'pat');

  // Before retirement the same environment uses the fallback normally.
  const before = selectCredential('reader', {env: {WOLF_FACTORY_REPO_TOKEN: 'ghp_x'}});
  assert.equal(before.source, 'pat-fallback');
  assert.equal(before.fallback, true);
});

test('retirement never blocks the App path, only the fallback', async () => {
  const {selectCredential} = await import('../scripts/private-ci-app-auth.mjs');
  const env = {
    WOLF_FACTORY_REPO_TOKEN: 'ghp_x',
    WOLF_FACTORY_APP_ID: '5913418', WOLF_FACTORY_APP_PRIVATE_KEY: 'k',
    WOLF_FACTORY_READER_INSTALLATION_ID: '1',
    WOLF_CI_RETIRE_PAT: 'true',
  };
  assert.equal(selectCredential('reader', {env}).source, 'github-app');
});

test('the retirement command writes the flag only when the decision is retire', async () => {
  const {runAppAuthCli} = await import('../scripts/private-ci-app-auth-cli.mjs');
  const {mkdtempSync, writeFileSync, readFileSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'retire-cli-'));

  const run = (renewal, acceptance) => {
    const renewalFile = join(dir, 'r.json');
    const acceptanceFile = join(dir, 'a.json');
    const githubEnv = join(dir, 'env-' + Math.random().toString(36).slice(2));
    writeFileSync(renewalFile, JSON.stringify(renewal));
    writeFileSync(acceptanceFile, JSON.stringify(acceptance));
    writeFileSync(githubEnv, '');
    const lines = [];
    return runAppAuthCli(['retirement'], {
      env: {WOLF_CI_AUTH_RECOVERY_FILE: renewalFile, WOLF_CI_ACCEPTANCE_FILE: acceptanceFile, GITHUB_ENV: githubEnv},
      stdout: text => lines.push(text),
    }).then(code => ({code, lines, githubEnv}));
  };

  const accepted = await run(
    {state: 'VERIFIED', renewal: [{role: 'reader', source: 'github-app'}]},
    {state: 'ACCEPTED', accepted: true, checks: [{check: 'dispatch', state: 'PASS'}]},
  );
  assert.equal(JSON.parse(accepted.lines[0]).retire, true);
  assert.match(readFileSync(accepted.githubEnv, 'utf8'), /WOLF_CI_RETIRE_PAT=true/);

  const blocked = await run(
    {state: 'NOT_APPLICABLE', renewal: [{role: 'reader', source: 'pat-fallback'}]},
    {state: 'BLOCKED', accepted: false, checks: [{check: 'dispatch', state: 'BLOCKED'}]},
  );
  assert.equal(JSON.parse(blocked.lines[0]).retire, false);
  assert.equal(readFileSync(blocked.githubEnv, 'utf8'), '', 'a kept fallback must leave the flag unset');
});

test('the receipt reports the enforced decision, and says so', async () => {
  const {readRetirementArtefact} = await import('../scripts/private-ci-bridge.mjs');
  const {mkdtempSync, writeFileSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'retire-artefact-'));
  const file = join(dir, 'decision.json');
  writeFileSync(file, JSON.stringify({state: 'RETIRE_FALLBACK', retire: true, reasons: [], evaluated: true}));

  const previous = process.env.WOLF_CI_RETIRE_PAT;
  process.env.WOLF_CI_RETIRE_PAT = 'true';
  const enforced = readRetirementArtefact(file);
  assert.equal(enforced.retire, true);
  assert.equal(enforced.source, 'enforcement-step');
  assert.equal(enforced.enforced, true, 'the receipt must show the flag was actually set');
  assert.equal(enforced.credentialsPrinted, false);

  delete process.env.WOLF_CI_RETIRE_PAT;
  assert.equal(readRetirementArtefact(file).enforced, false);
  if (previous !== undefined) process.env.WOLF_CI_RETIRE_PAT = previous;
});

test('a missing decision artefact recomputes and labels itself as doing so', async () => {
  const {readRetirementArtefact} = await import('../scripts/private-ci-bridge.mjs');
  const result = readRetirementArtefact('/nonexistent/decision.json', {acceptance: null, authentication: null, renewal: null});
  assert.equal(result.retire, false);
  assert.equal(result.source, 'recomputed-no-artefact');
});
