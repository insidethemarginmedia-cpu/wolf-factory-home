import assert from 'node:assert/strict';
import test from 'node:test';
import {runPreflightCli, PREFLIGHT_EXIT, REQUIRED_SECRETS, founderPlan} from '../scripts/private-ci-app-preflight.mjs';

const collect = () => {
  const lines = [];
  return {lines, stdout: text => lines.push(text)};
};

test('every Founder step names a real link or a real secret, so nothing needs interpretation', () => {
  const plan = founderPlan({owner: 'insidethemarginmedia-cpu'});
  assert.equal(plan.steps.length, 5);
  assert.match(plan.steps[0].link, /^https:\/\/github\.com\/organizations\/insidethemarginmedia-cpu\/settings\/apps\/new$/);
  assert.deepEqual(plan.steps[1].repositories, ['project-wolf', 'wolf-factory-home']);
  assert.deepEqual(plan.steps[3].secrets, [...REQUIRED_SECRETS]);
  assert.equal(plan.credentialsPrinted, false);
});

test('the plan explains why the click cannot be replaced by an API call', () => {
  const plan = founderPlan();
  assert.match(plan.why, /exactly once/);
  assert.match(plan.why, /No API/);
});

test('an over-privileged conversion exits 79 and is not silently accepted', () => {
  const out = collect();
  const code = runPreflightCli(['audit-conversion', '--file', 'x'], {
    readFile: () => JSON.stringify({id: 1, pem: 'k', permissions: {contents: 'write', checks: 'write', actions: 'write', metadata: 'read'}}),
    stdout: out.stdout,
  });
  assert.equal(code, PREFLIGHT_EXIT.EXCESS);
  const report = JSON.parse(out.lines.join(''));
  assert.equal(report.audit, 'EXCESS');
  assert.equal(report.credentialsPrinted, false);
});

test('a conversion that does not carry a key is reported, not assumed', () => {
  const out = collect();
  runPreflightCli(['audit-conversion', '--file', 'x'], {
    readFile: () => JSON.stringify({id: 1, permissions: {contents: 'read', metadata: 'read', checks: 'write', actions: 'write'}}),
    stdout: out.stdout,
  });
  const report = JSON.parse(out.lines.join(''));
  assert.equal(report.hasPrivateKey, false);
  assert.equal(report.audit, 'WITHIN_MINIMUM');
});

test('an unreadable conversion fails closed instead of planning a partial install', () => {
  const out = collect();
  const code = runPreflightCli(['audit-conversion', '--file', 'x'], {readFile: () => '{not json', stdout: out.stdout});
  assert.equal(code, PREFLIGHT_EXIT.DEFECT);
  assert.equal(JSON.parse(out.lines.join('')).reason, 'CONVERSION_FILE_INVALID');
});

test('the preflight output never contains a key, even when the input has one', () => {
  const out = collect();
  runPreflightCli(['audit-conversion', '--file', 'x'], {
    readFile: () => JSON.stringify({id: 7, pem: '-----BEGIN RSA PRIVATE KEY-----\nLEAKME\n-----END RSA PRIVATE KEY-----', permissions: {contents: 'read', metadata: 'read', checks: 'write', actions: 'write'}}),
    stdout: out.stdout,
  });
  assert.equal(out.lines.join('').includes('LEAKME'), false);
});
