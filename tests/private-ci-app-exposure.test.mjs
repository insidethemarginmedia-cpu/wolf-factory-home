import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
import {auditCredentialExposure, looksLikeCredential} from '../scripts/private-ci-app-acceptance.mjs';

const workflow = readFileSync(new URL('../.github/workflows/private-ci-bridge.yml', import.meta.url), 'utf8');

test('the shipped workflow passes the exposure audit', () => {
  const audit = auditCredentialExposure(workflow);
  assert.equal(audit.state, 'CLEAR', 'findings: ' + JSON.stringify(audit.findings));
  assert.equal(audit.findings.length, 0);
});

test('the audit catches a secret interpolated straight into a shell line', () => {
  const bad = [
    'jobs:',
    '  x:',
    '    steps:',
    '      - name: leak',
    '        run: |',
    '          echo ${{ secrets.WOLF_FACTORY_APP_PRIVATE_KEY }}',
  ].join('\n');
  const audit = auditCredentialExposure(bad);
  assert.equal(audit.state, 'EXPOSURE_RISK');
  assert.ok(audit.findings.some(finding => finding.vector === 'secret-in-shell'));
});

test('the audit catches an untrusted trigger and artefact upload', () => {
  const audit = auditCredentialExposure(['on: pull_request_target', 'steps:', '  - uses: actions/upload-artifact@v4', '    with:', '      path: /tmp/wolf-ci'].join('\n'));
  assert.equal(audit.state, 'EXPOSURE_RISK');
  assert.ok(audit.findings.some(finding => finding.vector === 'untrusted-workflow-trigger'));
  assert.ok(audit.findings.some(finding => finding.vector === 'artifact-upload-near-credentials'));
});

test('the audit recognises a token used without a masking path', () => {
  const audit = auditCredentialExposure(['steps:', '  - run: echo $WOLF_CI_APP_READER_TOKEN'].join('\n'));
  assert.ok(audit.findings.some(finding => finding.vector === 'token-unmasked'));
});

test('the credential detector recognises the shapes that matter', () => {
  assert.equal(looksLikeCredential('ghs_' + 'a'.repeat(30)), true);
  assert.equal(looksLikeCredential('ghp_' + 'b'.repeat(30)), true);
  assert.equal(looksLikeCredential('-----BEGIN RSA PRIVATE KEY-----'), true);
  assert.equal(looksLikeCredential('donraposo1-source/project-wolf'), false);
  assert.equal(looksLikeCredential('8d319fc50be4e4d225e3bb80de963583899c25ec'), false);
});

test('the workflow never uploads an artefact', () => {
  assert.equal(/upload-artifact/.test(workflow), false, 'nothing is uploaded, so nothing can leak through one');
});

test('the publisher token is minted and scoped only to the private-status publication step', () => {
  // The mint was first inserted into the probe job, where it could never reach the
  // publish step. A job-scoped assertion is the only thing that catches a step
  // landing in the wrong job - a plain indexOf finds the probe job's publish step
  // first and proves nothing.
  // Parsed with the in-repo workflow reader rather than PyYAML: a test that needs a
  // package the runner does not have passes locally and fails in CI, which is
  // exactly what happened here.
  const {parseWorkflowJobs} = require('../scripts/private-ci-workflow.mjs');
  const parsed = Object.fromEntries(parseWorkflowJobs(workflow).map(job => [job.name, job.steps.map(step => step.name)]));

  const execute = parsed.execute;
  const mintName = 'Mint the least-privilege publisher token for the private check';
  const publishName = 'Publish the authenticated check to the private commit';
  const mintAt = execute.indexOf(mintName);
  const publishAt = execute.indexOf(publishName);
  assert.ok(mintAt >= 0, 'the mint step must exist in the execute job');
  assert.ok(publishAt >= 0, 'the publish step must exist in the execute job');
  assert.ok(mintAt < publishAt, 'the token must be minted before the step that uses it');

  // And it must not be duplicated into another job.
  for (const [job, steps] of Object.entries(parsed)) {
    if (job === 'execute') continue;
    assert.equal(steps.includes(mintName), false, `the mint must not live in ${job}`);
  }

  const mintStart = workflow.indexOf('name: ' + mintName);
  const mintBlock = workflow.slice(mintStart, workflow.indexOf('      - name:', mintStart + 10));
  const publishStart = workflow.indexOf('name: ' + publishName);
  const publishBlock = workflow.slice(publishStart, workflow.indexOf('      - name:', publishStart + 10));
  assert.match(mintBlock, /actions\/create-github-app-token@/);
  assert.doesNotMatch(mintBlock, /GITHUB_ENV/, 'the token must not be exported job-wide');
  assert.match(publishBlock, /steps\.publisher_mint\.outputs\.token/);
  assert.doesNotMatch(publishBlock, /\$\{\{\s*env\.WOLF_CI_APP_PUBLISHER_TOKEN/);
});
