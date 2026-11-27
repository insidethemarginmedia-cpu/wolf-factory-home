import assert from 'node:assert/strict';
import test from 'node:test';
import {runPreflightCli, PREFLIGHT_EXIT, REQUIRED_SECRETS, founderPlan} from '../scripts/private-ci-app-preflight.mjs';

const collect = () => {
  const lines = [];
  return {lines, stdout: text => lines.push(text)};
};

test('the former App setup plan is withdrawn and requests no secrets or actions', () => {
  const plan = founderPlan();
  assert.equal(plan.state, 'BLOCKED');
  assert.equal(plan.reason, 'APP_SETUP_NOT_AUTHORIZED');
  assert.deepEqual(plan.authorizedActions, []);
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.secrets, []);
  assert.deepEqual(REQUIRED_SECRETS, []);
  assert.equal(plan.credentialsPrinted, false);
  assert.equal(plan.dispatchAuthorized, false);
});

test('plan and installation mapping commands refuse without reading or disclosing installation data', () => {
  for (const command of ['plan', 'map-installations']) {
    const out = collect();
    let readCalled = false;
    const code = runPreflightCli([command, '--file', 'fixture.json'], {
      readFile: () => { readCalled = true; throw Error('must not read'); },
      stdout: out.stdout,
    });
    const report = JSON.parse(out.lines.join(''));
    assert.equal(code, PREFLIGHT_EXIT.BLOCKED);
    assert.equal(readCalled, false);
    assert.equal(report.state, 'BLOCKED');
    assert.equal(report.reason, 'APP_SETUP_NOT_AUTHORIZED');
    assert.deepEqual(report.authorizedActions, []);
    assert.deepEqual(report.secrets, []);
  }
});

test('an over-privileged conversion exits 79 and is not silently accepted', () => {
  const out = collect();
  const code = runPreflightCli(['audit-conversion', '--file', 'x'], {
    readFile: () => JSON.stringify({id: 1, pem: 'synthetic-test-key', permissions: {contents: 'write', checks: 'write', actions: 'write', metadata: 'read'}}),
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

test('the read-only audit summary never contains a private key, even when input has one', () => {
  const out = collect();
  runPreflightCli(['audit-conversion', '--file', 'x'], {
    readFile: () => JSON.stringify({id: 7, pem: '-----BEGIN RSA PRIVATE KEY-----\nSYNTHETIC_TEST_KEY\n-----END RSA PRIVATE KEY-----', permissions: {contents: 'read', metadata: 'read', checks: 'write', actions: 'write'}}),
    stdout: out.stdout,
  });
  assert.equal(out.lines.join('').includes('SYNTHETIC_TEST_KEY'), false);
});
