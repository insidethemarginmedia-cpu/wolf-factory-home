// The bridge no longer selects a PAT fallback: source checkout uses one
// least-privilege App token, revoked before private dependencies or code run.
// These workflow-level assertions guard that stronger boundary. The dedicated
// retirement-ledger tests continue to exercise the retired fallback protocol.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';

import {parseWorkflowJobs} from '../scripts/private-ci-workflow.mjs';

const WORKFLOW = '.github/workflows/private-ci-bridge.yml';
const text = fs.readFileSync(WORKFLOW, 'utf8');
const statusPublisherSource = fs.readFileSync('scripts/private-ci-publish-job-status.mjs', 'utf8');
const jobs = parseWorkflowJobs(text);
const execute = jobs.find(job => job.name === 'execute');
const target = jobs.find(job => job.name === 'target_verification');
const publisher = jobs.find(job => job.name === 'publish_status');

function jobBlock(name) {
  const start = text.indexOf('  ' + name + ':' + '\n');
  assert.ok(start >= 0, `job ${name} must exist`);
  const tail = text.slice(start);
  const next = tail.slice(1).search(/^  [a-z][a-z0-9_-]*:$/m);
  return tail.slice(0, next < 0 ? undefined : next + 1);
}

test('the execute job exists and contains the bounded exact-SHA CI path', () => {
  assert.ok(execute, 'execute job must exist');
  for (const name of [
    'Re-verify durable mission admission before private access',
    'Checkout the private target at the immutable SHA without persisted credentials',
    'Execute the six required checks, build, migrations and security scans with private logs',
    'Remove private source and ephemeral test state',
  ]) assert.ok(execute.steps.some(step => step.name === name), `missing required step: ${name}`);
  const block = jobBlock('execute');
  assert.ok(block.includes('permissions:' + '\n' + '      contents: read'));
  assert.doesNotMatch(block, /contents: write|checks: write/);
});

test('private source execution has no PAT, deploy-key, dispatcher, or write-token fallback', () => {
  const block = jobBlock('execute');
  assert.doesNotMatch(block, /WOLF_FACTORY_(?:REPO|STATUS|DEPLOY|DISPATCHER)_TOKEN|WOLF_FACTORY_DEPLOY_KEY|WOLF_CI_RETIRE_PAT/);
  assert.doesNotMatch(block, /WOLF_CI_APP_(?:READER|PUBLISHER|DISPATCHER)_TOKEN/);
  assert.ok(block.includes('permission-contents: read'));
  assert.ok(block.includes('persist-credentials: false'));
});

test('the read token is scoped to immutable checkout and revoked before untrusted code', () => {
  const mint = execute.steps.findIndex(step => step.name === 'Mint the least-privilege read token for private source checkout');
  const checkout = execute.steps.findIndex(step => step.name === 'Checkout the private target at the immutable SHA without persisted credentials');
  const revoke = execute.steps.findIndex(step => step.name === 'Revoke the private-source read token before running private code');
  const install = execute.steps.findIndex(step => step.name === 'Install private lockfile dependencies without lifecycle scripts');
  const runPrivate = execute.steps.findIndex(step => step.name === 'Execute the six required checks, build, migrations and security scans with private logs');
  assert.ok(mint >= 0 && checkout > mint && revoke > checkout, 'token mint -> checkout -> revocation order is mandatory');
  assert.ok(install > revoke && runPrivate > revoke, 'dependency and test code must run after token revocation');

  const executeSource = jobBlock('execute');
  const checkoutBlock = JSON.stringify(execute.steps[checkout]);
  const revokeBlock = JSON.stringify(execute.steps[revoke]);
  assert.ok(executeSource.includes('permission-contents: read'));
  assert.ok(executeSource.includes('permission-metadata: read'));
  assert.ok(executeSource.includes('skip-token-revoke: true'));
  assert.ok(checkoutBlock.includes('steps.source_reader.outputs.token'));
  assert.equal(execute.steps[checkout].with['persist-credentials'], 'false');
  assert.ok(revokeBlock.includes("method: 'DELETE'"));
  assert.ok(revokeBlock.includes('api.github.com/installation/token'));
  const revokeStart = executeSource.indexOf('      - name: Revoke the private-source read token before running private code');
  const revokeEnd = executeSource.indexOf('      - name:', revokeStart + 1);
  const revokeYaml = executeSource.slice(revokeStart, revokeEnd < 0 ? undefined : revokeEnd);
  assert.ok(revokeYaml.includes("if: always() && steps.source_reader.outputs.token != ''"), 'revoke the scoped token after checkout or verification failure before private code can start');
});

test('private output stays runner-local and cleanup runs even after a failed check', () => {
  const install = execute.steps.find(step => step.name === 'Install private lockfile dependencies without lifecycle scripts');
  const runPrivate = execute.steps.find(step => step.name === 'Execute the six required checks, build, migrations and security scans with private logs');
  const cleanup = execute.steps.find(step => step.name === 'Remove private source and ephemeral test state');
  const executeBlock = jobBlock('execute');
  const cleanupStart = executeBlock.indexOf('      - name: Remove private source and ephemeral test state');
  const cleanupEnd = executeBlock.indexOf('      - name:', cleanupStart + 10);
  const cleanupText = executeBlock.slice(cleanupStart, cleanupEnd < 0 ? undefined : cleanupEnd);
  assert.ok(String(install.run).includes('>>"$install_log" 2>&1'));
  assert.ok(String(runPrivate.run).includes('node scripts/private-ci-execute.mjs >/tmp/wolf-ci-executor.log 2>&1'));
  assert.ok(cleanupText.includes('if: always()'));
  assert.ok(String(cleanup.run).includes('$GITHUB_WORKSPACE/wolf-private'));
  assert.ok(String(cleanup.run).includes('/tmp/wolf-ci-install.log'));
  assert.ok(String(cleanup.run).includes('/tmp/wolf-ci-executor.log'));
  assert.ok(String(cleanup.run).includes('$HOME/.npm'));
  assert.ok(String(cleanup.run).includes('$HOME/.cache/pip'));
  assert.doesNotMatch(cleanupText, /secrets\.|WOLF_CI_SOURCE_READ_TOKEN/);
});

test('target verification and aggregate status publication run outside the private-source job', () => {
  assert.ok(target && publisher);
  assert.ok(jobBlock('target_verification').includes('needs: mission_admission'));
  assert.ok(jobBlock('target_verification').includes('private-ci-resolve-target-cli.mjs gate'));
  assert.ok(jobBlock('target_verification').includes('Remove metadata-only target response'));
  assert.ok(jobBlock('execute').includes('needs: [mission_admission, target_verification]'));
  assert.ok(jobBlock('publish_status').includes('needs: [mission_admission, target_verification, execute]'));
  assert.ok(jobBlock('publish_status').includes('needs.execute.result'));
  assert.ok(jobBlock('publish_status').includes('private-ci-publish-job-status.mjs'));
  const runtimeCommands = execute.steps.map(step => String(step.run ?? '')).join('\n');
  assert.doesNotMatch(runtimeCommands, /node scripts\/private-ci-publish-job-status\.mjs|node scripts\/private-ci-publish-receipt\.mjs|actions\/upload-artifact/);
  assert.doesNotMatch(jobBlock('publish_status'), /WOLF_CI_PRIVATE_ROOT|private-ci-publish-receipt\.mjs|upload-artifact/);
});

test('the execute job neither persists retirement state nor writes it to a branch', () => {
  const runtimeCommands = execute.steps.map(step => String(step.run ?? '')).join('\n');
  assert.doesNotMatch(runtimeCommands, /private-ci-retirement-persist\.mjs|retirement-ledger\.jsonl|retirement-head\.json/);
  const offenders = execute.steps.filter(step => {
    const body = String(step.run ?? '');
    return body.includes('contents/.wolf-ci') || body.includes('retirement-ledger.jsonl');
  });
  assert.deepEqual(offenders.map(step => step.name), []);
});

test('the bridge exposes no private receipt or source artifact publication step', () => {
  const block = jobBlock('execute') + jobBlock('publish_status');
  assert.doesNotMatch(block, /Publish the SHA-bound receipt|Publish the sanitized public receipt|Publish the receipt to a dedicated private branch/);
  assert.doesNotMatch(block, /actions\/upload-artifact|private-ci-publish-receipt\.mjs/);
  assert.ok(statusPublisherSource.includes('No private source, diff, logs, credential, or artifact is attached'));
  assert.ok(statusPublisherSource.includes('not private-worker or mission acceptance'));
});

test('the retired-ledger persistence helper validates the old anchor before writing new bytes', () => {
  const source = fs.readFileSync('scripts/private-ci-retirement-persist.mjs', 'utf8');
  assert.ok(source.includes('verifyLedger(ledgerText)'));
  assert.ok(source.includes('compareToAnchor(verification, previousAnchor)'));
  assert.ok(source.includes('buildHeadAnchor(finalVerification'));
  assert.ok(source.includes('RETIREMENT_LEDGER_ANCHOR_PAIR_INCOMPLETE'));
  assert.ok(source.includes('LEDGER_SHORTER_THAN_ANCHOR'));
  assert.ok(source.indexOf('/contents/${RETIREMENT_LEDGER_PATH}') < source.indexOf('/contents/${RETIREMENT_ANCHOR_PATH}'));
});

test('the exact target is held in the metadata job and removed instead of crossing jobs', () => {
  const targetBlock = jobBlock('target_verification');
  const executeBlock = jobBlock('execute');
  assert.ok(targetBlock.includes('WOLF_CI_TARGET_OUTPUT: /tmp/wolf-ci-target.json'));
  assert.ok(targetBlock.includes('rm -f -- /tmp/wolf-ci-target.json'));
  assert.doesNotMatch(executeBlock, /WOLF_CI_TARGET_OUTPUT|wolf-ci-target\.json/);
  assert.doesNotMatch(text, /actions\/upload-artifact/);
});

test('the target resolver retains its gate verdict while public receipts omit its selectors', () => {
  const bridge = fs.readFileSync('scripts/private-ci-bridge.mjs', 'utf8');
  const resolver = fs.readFileSync('scripts/private-ci-resolve-target-cli.mjs', 'utf8');
  assert.ok(resolver.includes('acceptanceValid'));
  assert.ok(resolver.includes('buildPublicTargetAggregate'));
  assert.ok(bridge.includes('buildPublicBridgeReceipt'));
  assert.doesNotMatch(bridge, /acceptanceTarget:/,
    'the bridge receipt must not copy private target-resolution structures into public output');
  assert.ok(statusPublisherSource.includes('not private-worker or mission acceptance'));
});
