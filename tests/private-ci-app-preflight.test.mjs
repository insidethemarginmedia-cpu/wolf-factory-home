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

test('map-installations turns a real response into the secrets to store', () => {
  const out = collect();
  const payload = {installations: [
    {id: 176017917, account: {login: 'donraposo1-source', type: 'User'}, repository_selection: 'selected', repositories: [{name: 'project-wolf'}]},
    {id: 176144552, account: {login: 'insidethemarginmedia-cpu', type: 'User'}, repository_selection: 'selected', repositories: [{name: 'wolf-factory-home'}]},
  ]};
  const code = runPreflightCli(['map-installations', '--file', 'x'], {readFile: () => JSON.stringify(payload), stdout: out.stdout});
  assert.equal(code, PREFLIGHT_EXIT.OK);
  const mapped = JSON.parse(out.lines.join(''));
  assert.equal(mapped.state, 'MAPPED');
  assert.equal(mapped.secrets.WOLF_FACTORY_PUBLISHER_INSTALLATION_ID.value, '176017917');
  assert.equal(mapped.credentialsPrinted, false);
});

test('an over-scoped or unauthorized installation is a blocking preflight failure', () => {
  const over = collect();
  const overCode = runPreflightCli(['map-installations', '--file', 'x'], {
    readFile: () => JSON.stringify({installations: [{id: 1, account: {login: 'donraposo1-source', type: 'User'}, repository_selection: 'all'}]}),
    stdout: over.stdout,
  });
  assert.equal(overCode, PREFLIGHT_EXIT.EXCESS);
  assert.equal(JSON.parse(over.lines.join('')).state, 'OVER_SCOPED');
});

test('an incomplete mapping is 78, distinct from a defect', () => {
  const out = collect();
  const code = runPreflightCli(['map-installations', '--file', 'x'], {readFile: () => JSON.stringify({installations: []}), stdout: out.stdout});
  assert.equal(code, PREFLIGHT_EXIT.INCOMPLETE);
  assert.equal(JSON.parse(out.lines.join('')).state, 'INCOMPLETE');
});
