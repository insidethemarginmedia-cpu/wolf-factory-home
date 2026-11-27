import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';

const bridge = fs.readFileSync('.github/workflows/private-ci-bridge.yml', 'utf8');

function job(name) {
  const start = bridge.search(new RegExp(`^  ${name}:\\s*$`, 'm'));
  assert.ok(start >= 0, `job ${name} must exist`);
  const tail = bridge.slice(start);
  const next = tail.slice(1).search(/^  [A-Za-z0-9_-]+:\s*$/m);
  return next < 0 ? tail : tail.slice(0, next + 1);
}

function jobCondition(source) {
  const match = source.match(/^    if:\s*(.*)$/m);
  if (!match) return '';
  const marker = match[1].trim();
  if (!['>', '>-', '>+', '|', '|-', '|+'].includes(marker)) return marker;
  const start = match.index + match[0].length;
  const lines = source.slice(start).split('\n');
  const body = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!/^\s{6,}\S/.test(line)) break;
    body.push(line.trim());
  }
  return body.join(' ');
}

test('private CI never falls back to a baked-in target SHA', () => {
  const assignments = [...bridge.matchAll(/^\s*WOLF_CI_SHA:\s*(.+)$/gm)];
  assert.ok(assignments.length > 0, 'workflow target assignments should be explicit and reviewable');
  for (const [, value] of assignments) {
    assert.doesNotMatch(value, /\b[0-9a-f]{40}\b/i, 'a target SHA must come from an admitted input, never a source literal');
  }
  assert.match(bridge, /WOLF_CI_SHA:\s*\$\{\{\s*inputs\.sha\s*\|\|\s*''\s*\}\}/,
    'missing mission target must remain empty and fail closed');
  assert.doesNotMatch(bridge, /github\.event\.client_payload\.sha/,
    'the bridge receives admitted target identity only through the typed reusable-workflow input');
});

test('only a mission-qualified reusable-workflow call may enter private execution', () => {
  for (const name of ['probe', 'inventory']) {
    const condition = jobCondition(job(name));
    assert.doesNotMatch(condition, /github\.event_name == '(?:repository_dispatch|workflow_call)'/,
      `${name} must not mint private credentials on a mission dispatch`);
  }
  const admission = job('mission_admission');
  const admissionCondition = jobCondition(admission);
  assert.match(admissionCondition, /github\.event_name == 'repository_dispatch'/);
  assert.match(admissionCondition, /github\.workflow_ref == 'insidethemarginmedia-cpu\/wolf-factory-home\/\.github\/workflows\/mission-listener\.yml@refs\/heads\/main'/);
  assert.match(admission, /permissions:\n      contents: read/);
  assert.match(admission, /steps\.admission_gate\.outcome == 'success'/);
  assert.doesNotMatch(admission, /secrets\./, 'the admission job must not receive private workflow secrets');
  assert.ok(bridge.indexOf('\n  mission_admission:') < bridge.indexOf('\n  execute:'),
    'the read-only admission job must precede the privileged execution job');

  const execute = job('execute');
  const condition = jobCondition(execute);
  assert.match(condition, /needs\.mission_admission\.outputs\.verified == 'true'/,
    'the privileged job must not start unless the read-only admission job passes');
  for (const name of ['sha', 'missionId', 'deliveryId', 'executorSha']) {
    assert.match(condition, new RegExp(`inputs\\.${name} != ''`), `execute requires nonempty ${name}`);
  }
  assert.doesNotMatch(condition, /github\.event_name == 'workflow_call'/,
    'the reusable workflow inherits its caller event name; it does not receive a synthetic workflow_call event');
  assert.match(condition, /github\.event_name == 'repository_dispatch'/,
    'mission execution must be called from the listener handling the authenticated dispatch');
  assert.match(condition, /github\.workflow_ref == 'insidethemarginmedia-cpu\/wolf-factory-home\/\.github\/workflows\/mission-listener\.yml@refs\/heads\/main'/,
    'an arbitrary workflow_call caller must not access private mission credentials');
  assert.doesNotMatch(condition, /github\.event_name == '(?:workflow_dispatch|push)'/,
    'manual dispatch and engineering pushes must not bypass mission admission');
  assert.match(bridge, /^  workflow_call:\s*$/m);
  assert.match(execute, /Re-verify durable mission admission before private access/);
  assert.match(execute, /ref:\s*\$\{\{\s*inputs\.executorSha\s*\}\}/,
    'reusable mission code must be checked out only from the immutable admitted executor SHA');
  assert.doesNotMatch(execute, /- name: Re-verify durable mission admission before private access\n        if:/,
    'the second gate cannot be optional');
});

test('aggregate status publication always follows successful admission and exact-target verification', () => {
  const execute = job('execute');
  const gate = execute.indexOf('Re-verify durable mission admission before private access');
  const sourceMint = execute.indexOf('Mint the least-privilege read token for private source checkout');
  const sourceCheckout = execute.indexOf('Checkout the private target at the immutable SHA');
  assert.ok(gate >= 0 && sourceMint > gate && sourceCheckout > sourceMint,
    'the second durable admission gate must precede private source credentials and checkout');
  assert.match(execute, /permissions:\n      contents: read/);
  assert.doesNotMatch(execute, /contents: write|checks: write|actions\/upload-artifact|Publish the SHA-bound receipt|Publish the authenticated check|Publish the sanitized public receipt/);

  const publisher = job('publish_status');
  const condition = jobCondition(publisher);
  assert.match(condition, /always\(\)/, 'aggregate failure status remains publishable after failed execution');
  assert.match(condition, /needs\.mission_admission\.outputs\.verified == 'true'/);
  assert.match(condition, /needs\.target_verification\.outputs\.verified == 'true'/);
  assert.match(publisher, /needs: \[mission_admission, target_verification, execute\]/);
  assert.match(publisher, /needs\.execute\.result/);
  assert.match(publisher, /permission-checks: write/);
  assert.match(publisher, /private-ci-publish-job-status\.mjs/);
  assert.doesNotMatch(publisher, /actions\/upload-artifact|private-ci-publish-receipt\.mjs|WOLF_FACTORY_DEPLOY_KEY/);
});

test('push validation is public and does not invoke private mission jobs', () => {
  const validate = job('validate');
  const condition = validate.match(/^    if:\s*(.+)$/m)?.[1] ?? '';
  assert.match(condition, /github\.event_name == 'push'/);
  assert.match(validate, /node --test tests\/\*\.test\.mjs/);
  assert.doesNotMatch(validate, /secrets\.|private-source|WOLF_CI_DEPLOY_KEY|create-github-app-token/);
});

test('the bridge exposes no raw-dispatch or cron path without durable queue/recovery wiring', () => {
  const triggers = bridge.slice(bridge.indexOf('\non:'), bridge.indexOf('\npermissions:'));
  assert.doesNotMatch(triggers, /^  repository_dispatch:\s*$/m,
    'the bridge is invoked by the authenticated listener through workflow_call, never a raw dispatch');
  assert.doesNotMatch(triggers, /^  schedule:\s*$/m,
    'no cron is exposed until a durable queue and recovery path exist');
  assert.doesNotMatch(bridge, /node scripts\/private-ci-journal-cli\.mjs\s+(?:enqueue|claim|settle)/,
    'a runner-local JSON file must not be presented as cross-run queue state');
  assert.doesNotMatch(bridge, /node scripts\/private-ci-mission-cli\.mjs/,
    'the bridge must use the listener admission ledger, not a parallel local mission journal');
});

test('workflow_dispatch has no mission fields and cannot become a private-execution call', () => {
  const triggers = bridge.slice(bridge.indexOf('\non:'), bridge.indexOf('\npermissions:'));
  const dispatch = triggers.slice(triggers.indexOf('  workflow_dispatch:'), triggers.indexOf('  push:'));
  for (const name of ['missionId', 'deliveryId', 'executorSha']) {
    assert.doesNotMatch(dispatch, new RegExp(`^\\s+${name}:`, 'm'));
  }
});

test('the trusted caller passes only named, declared secrets to the reusable workflow', () => {
  const listener = fs.readFileSync('.github/workflows/mission-listener.yml', 'utf8');
  assert.doesNotMatch(listener, /secrets:\s*inherit/);
  const calledSecrets = listener.slice(listener.lastIndexOf('    secrets:'));
  const callSecrets = [
    'WOLF_FACTORY_APP_ID',
    'WOLF_FACTORY_APP_PRIVATE_KEY',
    'WOLF_FACTORY_READER_INSTALLATION_ID',
    'WOLF_FACTORY_PUBLISHER_INSTALLATION_ID',
    'WOLF_FACTORY_DISPATCHER_INSTALLATION_ID',
    'WOLF_FACTORY_DEPLOY_KEY',
    'WOLF_FACTORY_REPO_TOKEN',
  ];
  const call = bridge.slice(bridge.indexOf('  workflow_call:'), bridge.indexOf('  workflow_dispatch:'));
  for (const name of callSecrets) {
    assert.match(calledSecrets, new RegExp(`^      ${name}: \\S+`, 'm'));
    assert.match(call, new RegExp(`^      ${name}:\\n        required: false$`, 'm'));
  }
  assert.ok(listener.includes('executorSha: ${{ needs.admit.outputs.executor_sha }}'));
  assert.ok(listener.includes('deliveryId: ${{ needs.admit.outputs.delivery_id }}'));
});
