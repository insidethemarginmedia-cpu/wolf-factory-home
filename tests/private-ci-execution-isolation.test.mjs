import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = await readFile(path.join(root, '.github/workflows/private-ci-bridge.yml'), 'utf8');
const executor = await readFile(path.join(root, 'scripts/private-ci-execute.mjs'), 'utf8');

function jobBlock(name) {
  const start = workflow.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `missing job ${name}`);
  const next = workflow.slice(start + 1).search(/^  [a-z][a-z0-9_-]*:\n/m);
  return workflow.slice(start, next === -1 ? undefined : start + 1 + next);
}

test('private-source execution has read-only public permissions and no public artifact upload', () => {
  const execute = jobBlock('execute');
  assert.match(execute, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(execute, /contents: write|checks: write|actions\/upload-artifact/);
  assert.match(execute, /persist-credentials: false/);
  assert.match(execute, /ref: \$\{\{ inputs\.sha \}\}/);
  assert.match(execute, /skip-token-revoke: true/);
  assert.match(execute, /method: 'DELETE'/);
  assert.match(execute, /api\.github\.com\/installation\/token/);
  assert.match(execute, /PRIVATE_SOURCE_READ_TOKEN_REVOKED_BEFORE_UNTRUSTED_CODE=YES/);
  assert.ok(execute.indexOf('Revoke the private-source read token before running private code') < execute.indexOf('Install private lockfile dependencies'));
  assert.ok(execute.indexOf('Revoke the private-source read token before running private code') < execute.indexOf('Execute the six required checks'));
  assert.match(execute, />>"\$install_log" 2>&1/);
  assert.match(execute, /node scripts\/private-ci-execute\.mjs >\/tmp\/wolf-ci-executor\.log 2>&1/);
});

test('no secret-bearing or receipt-publication steps run after private code executes', () => {
  const execute = jobBlock('execute');
  const marker = '      - name: Execute the six required checks, build, migrations and security scans with private logs';
  const offset = execute.indexOf(marker);
  assert.notEqual(offset, -1, 'missing private execution step');
  const afterExecution = execute.slice(offset);
  assert.doesNotMatch(afterExecution, /secrets\.|GITHUB_TOKEN|WOLF_FACTORY_(?:APP|REPO|DEPLOY|STATUS)|WOLF_CI_APP_(?:READER|PUBLISHER|DISPATCHER)_TOKEN/);
  assert.doesNotMatch(afterExecution, /upload-artifact|publish-private-status|publish-receipt|workflow.*dispatch/i);
  assert.match(afterExecution, /shell: sh/);
  assert.match(afterExecution, /\/usr\/bin\/rm -rf -- "\$GITHUB_WORKSPACE\/wolf-private"/);
  assert.match(afterExecution, /\/usr\/bin\/rm -f -- \/tmp\/wolf-ci-install\.log \/tmp\/wolf-ci-executor\.log/);
});

test('private executor passes the deny-by-default spend and provider policy to checks', () => {
  for (const rule of [
    "EUR_SPEND: '0'",
    "COST_UNKNOWN: 'DENY'",
    "PAID_FALLBACK: 'DENY'",
    "UNVERIFIED_BILLING: 'DENY'",
    "UNVERIFIED_PROVIDER: 'DENY'",
    "TRIAL_CREDIT: 'DENY'",
  ]) assert.ok(executor.includes(rule), `missing executor policy: ${rule}`);
});

test('all mission jobs fail closed until runner isolation, billing, and provider approval are verified', () => {
  for (const name of ['mission_admission', 'target_verification', 'execute', 'publish_status']) {
    const block = jobBlock(name);
    assert.match(block, /vars\.WOLF_CI_ZERO_COST_RUNNER_AUTHORIZED == 'true'/);
    assert.match(block, /vars\.WOLF_CI_BILLING_VERIFIED == 'true'/);
    assert.match(block, /vars\.WOLF_CI_PROVIDER_VERIFIED == 'true'/);
    assert.match(block, /vars\.WOLF_CI_PRIVATE_RUNNER_ISOLATION_VERIFIED == 'true'/);
  }
  const execute = jobBlock('execute');
  assert.match(execute, /EUR_SPEND: '0'/);
  assert.match(execute, /COST_UNKNOWN: DENY/);
  assert.match(execute, /PAID_FALLBACK: DENY/);
  assert.match(execute, /UNVERIFIED_BILLING: DENY/);
  assert.match(execute, /UNVERIFIED_PROVIDER: DENY/);
  assert.match(execute, /TRIAL_CREDIT: DENY/);
});

test('private target resolution and private status publication run in isolated jobs', () => {
  const target = jobBlock('target_verification');
  assert.match(target, /permission-contents: read/);
  assert.match(target, /permission-pull-requests: read/);
  assert.match(target, /outputs:\n\s+verified:/);
  assert.doesNotMatch(target, /WOLF_CI_PRIVATE_ROOT|actions\/checkout@[\s\S]*?repository: donraposo1-source\/project-wolf/);

  const publish = jobBlock('publish_status');
  assert.match(publish, /needs\.execute\.result/);
  assert.match(publish, /permission-checks: write/);
  assert.match(publish, /repositories: project-wolf/);
  assert.match(publish, /WOLF_CI_REPOSITORY: donraposo1-source\/project-wolf/);
  assert.doesNotMatch(publish, /WOLF_CI_PRIVATE_ROOT|actions\/upload-artifact|WOLF_FACTORY_DEPLOY_KEY/);
  assert.match(publish, /private-ci-publish-job-status\.mjs/);
});
