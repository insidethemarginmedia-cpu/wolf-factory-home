import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync} from 'node:crypto';
import {redactForArtefact, runAcceptanceCli, ACCEPTANCE_EXIT} from '../scripts/private-ci-app-acceptance-cli.mjs';

const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const rsaPem = privateKey.export({type: 'pkcs1', format: 'pem'});
const repo = 'donraposo1-source/project-wolf';
const SHA = 'a'.repeat(40);

test('redaction removes every credential-shaped value, including short ones', () => {
  const dirty = {
    token: 'ghs_abcdefghijklmnopqrstuvwxyz123456',
    pem: rsaPem,
    nested: {authorization: 'Bearer abc', note: 'ghp_abcdefghijklmnopqrstuvwxyz12'},
    jwt: 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxIn0.c2lnbmF0dXJl',
    safe: 'donraposo1-source/project-wolf',
  };
  const clean = redactForArtefact(dirty);
  const serialized = JSON.stringify(clean);
  assert.equal(serialized.includes('ghs_'), false);
  assert.equal(serialized.includes('ghp_'), false);
  assert.equal(serialized.includes('BEGIN RSA PRIVATE KEY'), false);
  assert.equal(serialized.includes('eyJhbGci'), false);
  assert.equal(clean.token, '[REDACTED]', 'token fields are dropped by key, not only by pattern');
  assert.equal(clean.safe, 'donraposo1-source/project-wolf', 'useful metadata survives');
});

test('redaction handles deeply nested structures without hanging', () => {
  let deep = {value: 'end'};
  for (let index = 0; index < 40; index += 1) deep = {next: deep};
  const clean = redactForArtefact(deep);
  assert.ok(JSON.stringify(clean).includes('depth-limited'));
});

test('acceptance with no App secrets is BLOCKED, never accepted', async () => {
  const lines = [];
  const code = await runAcceptanceCli([], {env: {WOLF_CI_REPOSITORY: repo, WOLF_CI_SHA: SHA}, stdout: text => lines.push(text)});
  assert.equal(code, ACCEPTANCE_EXIT.BLOCKED);
  const report = JSON.parse(lines.join(''));
  assert.equal(report.accepted, false);
  assert.equal(report.credentialsPrinted, false);
  assert.ok(report.blocked.length > 0);
});

test('a full live run writes an artefact whose bytes contain no secret', async () => {
  const {mkdtempSync, readFileSync, statSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-'));
  const out = join(dir, 'acceptance.json');

  let counter = 0;
  const fetchImpl = async (url, init = {}) => {
    counter += 1;
    if (url.includes('/access_tokens')) {
      return {ok: true, status: 201, json: async () => ({
        token: 'ghs_live_' + counter + '_' + 'x'.repeat(20),
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        permissions: JSON.parse(init.body).permissions,
        repositories: [{full_name: repo}],
      })};
    }
    if (url.includes('/app/installations')) {
      return {ok: true, status: 200, json: async () => ([
        {id: 176017917, account: {login: 'donraposo1-source', type: 'User'}, repository_selection: 'selected'},
        {id: 176144552, account: {login: 'insidethemarginmedia-cpu', type: 'User'}, repository_selection: 'selected'},
      ])};
    }
    if (url.includes('/commits/')) return {ok: true, status: 200, json: async () => ({sha: SHA, commit: {tree: {sha: 'b'.repeat(40)}}})};
    if (url.includes('/check-runs')) return {ok: true, status: 201, json: async () => ({id: 5, head_sha: SHA, conclusion: 'success'})};
    if (url.includes('/runs?per_page=1')) return {ok: true, status: 200, json: async () => ({total_count: 0})};
    if (url.includes('/dispatches')) return {ok: true, status: 204, json: async () => ({})};
    if (url.includes('/actions/workflows')) return {ok: false, status: 403, json: async () => ({})};
    return {ok: true, status: 200, json: async () => ({})};
  };

  const env = {
    WOLF_FACTORY_APP_ID: '5913418',
    WOLF_FACTORY_APP_PRIVATE_KEY: rsaPem,
    WOLF_FACTORY_READER_INSTALLATION_ID: '176017917',
    WOLF_FACTORY_PUBLISHER_INSTALLATION_ID: '176017917',
    WOLF_FACTORY_DISPATCHER_INSTALLATION_ID: '176017917',
    WOLF_CI_REPOSITORY: repo,
    WOLF_CI_SHA: SHA,
    WOLF_CI_PR: '743',
    WOLF_ACCEPTANCE_WORKFLOW: 'private-ci.yml',
  };
  const lines = [];
  const code = await runAcceptanceCli(['--out', out], {env, fetchImpl, stdout: text => lines.push(text)});
  const artefact = readFileSync(out, 'utf8');
  assert.equal(artefact.includes('ghs_live_'), false, 'the artefact must not contain a token');
  assert.equal(artefact.includes('BEGIN RSA PRIVATE KEY'), false);
  assert.equal(statSync(out).mode & 0o777, 0o600, 'the artefact is readable only by its owner');
  const report = JSON.parse(lines.join(''));
  assert.equal(report.credentialsPrinted, false);
  assert.ok([ACCEPTANCE_EXIT.ACCEPTED, ACCEPTANCE_EXIT.BLOCKED, ACCEPTANCE_EXIT.FAIL].includes(code));
});
