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

test('the audit follows job-wide environments into target execution', () => {
  const unsafe = [
    'jobs:',
    '  execute:',
    '    env:',
    '      WOLF_FACTORY_REPO_TOKEN: ${{ secrets.WOLF_FACTORY_REPO_TOKEN }}',
    '    steps:',
    '      - name: Execute private commands',
    '        run: node scripts/private-ci-execute.mjs',
  ].join('\n');
  const audit = auditCredentialExposure(unsafe);
  assert.equal(audit.state, 'EXPOSURE_RISK');
  assert.ok(audit.findings.some(finding => finding.vector === 'target-process-job-environment'));
});

test('the receipt signer is not trusted in an execution step without OS-user isolation', () => {
  const unsafe = [
    'jobs:',
    '  execute:',
    '    steps:',
    '      - name: Execute private commands',
    '        env:',
    '          WOLF_CI_RECEIPT_SIGNING_KEY: ${{ secrets.WOLF_CI_RECEIPT_SIGNING_KEY }}',
    '        run: node scripts/private-ci-execute.mjs',
  ].join('\n');
  const audit = auditCredentialExposure(unsafe);
  assert.equal(audit.state, 'EXPOSURE_RISK');
  assert.ok(audit.findings.some(finding => finding.vector === 'target-process-environment'));
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

test('the publisher token is minted in a protected directory and only a successful mint is sourced', () => {
  const {parseWorkflowJobs} = require('../scripts/private-ci-workflow.mjs');
  const parsed = Object.fromEntries(parseWorkflowJobs(workflow).map(job => [job.name, job.steps.map(step => step.name)]));
  const execute = parsed.execute;
  const prepareName = 'Prepare a separate OS identity for target-code execution';
  const executeName = 'Execute the required checks with source-bound receipts and isolated child environments';
  const mintName = 'Mint the publisher token for the private check';
  const publishName = 'Publish the authenticated check to the private commit';
  const prepareAt = execute.indexOf(prepareName);
  const executeAt = execute.indexOf(executeName);
  const mintAt = execute.indexOf(mintName);
  const publishAt = execute.indexOf(publishName);
  assert.ok(prepareAt >= 0 && executeAt > prepareAt && mintAt > executeAt && publishAt > mintAt);
  for (const [job, steps] of Object.entries(parsed)) {
    if (job !== 'execute') assert.equal(steps.includes(mintName), false, `the mint must not live in ${job}`);
  }

  const prepareStart = workflow.indexOf('name: ' + prepareName);
  const executeStart = workflow.indexOf('name: ' + executeName, prepareStart);
  const mintStart = workflow.indexOf('name: ' + mintName, executeStart);
  const publishStart = workflow.indexOf('name: ' + publishName, mintStart);
  const publishEnd = workflow.indexOf('      - name: Publish the sanitized public receipt', publishStart);
  const prepareBlock = workflow.slice(prepareStart, executeStart);
  const mintBlock = workflow.slice(mintStart, publishStart);
  const publishBlock = workflow.slice(publishStart, publishEnd);
  assert.match(prepareBlock, /WOLF_CI_APP_TOKEN_DIR: \$\{\{ runner\.temp \}\}\/wolf-ci-app-token-/);
  assert.match(prepareBlock, /mkdir -m 700 -- "\$WOLF_CI_APP_TOKEN_DIR"/);
  assert.match(mintBlock, /WOLF_CI_TOKEN_FILE: \$\{\{ runner\.temp \}\}\/wolf-ci-app-token-.*publisher-token\.env/);
  assert.match(mintBlock, /app_token_minted=true/);
  assert.match(mintBlock, /app_token_minted=false/);
  assert.doesNotMatch(mintBlock, /GITHUB_ENV/, 'the token is not exported job-wide');
  assert.match(publishBlock, /steps\.publisher_mint\.outputs\.app_token_minted/);
  assert.match(publishBlock, /\. \"\$WOLF_CI_TOKEN_FILE\"/);
  assert.match(publishBlock, /unset WOLF_CI_APP_PUBLISHER_TOKEN/);
  assert.match(publishBlock, /rm -f \"\$WOLF_CI_TOKEN_FILE\"/);
  assert.doesNotMatch(publishBlock, /\/tmp\/wolf-ci-publisher-token\.env/);
});
