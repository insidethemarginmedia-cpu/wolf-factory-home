import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
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

test('the publisher token is minted inside the execute job, before it is published', async () => {
  // The mint was first inserted into the probe job, where it could never reach the
  // publish step. A workflow-level assertion is the only thing that catches a
  // step landing in the wrong job.
  const mintIndex = workflow.indexOf('name: Mint the publisher token for the private check');
  const publishIndex = workflow.indexOf('name: Publish the authenticated check to the private commit');
  assert.ok(mintIndex > 0 && publishIndex > 0);

  const jobFor = index => {
    const before = workflow.slice(0, index);
    const matches = [...before.matchAll(/^  ([a-z][a-z0-9-]*):$/gm)];
    return matches.length ? matches[matches.length - 1][1] : null;
  };
  assert.equal(jobFor(mintIndex), 'execute', 'the mint must live in the execute job');
  assert.ok(mintIndex < publishIndex, 'the token must be minted before the step that uses it');
  assert.match(workflow.slice(mintIndex, publishIndex), /GITHUB_ENV/, 'it must reach later steps through GITHUB_ENV');
});
