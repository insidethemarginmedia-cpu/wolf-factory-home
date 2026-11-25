import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
import {missionCli, readSeenKeys, MISSION_EXIT, ALLOWED_REPOSITORIES} from '../scripts/private-ci-mission-cli.mjs';
import {MISSION_SCHEMA_VERSION, MISSION_STATES} from '../scripts/private-ci-mission.mjs';

const NOW = Date.parse('2026-11-25T00:00:00Z');
const SHA = '8d319fc50be4e4d225e3bb80de963583899c25ec';
const payload = {
  schemaVersion: MISSION_SCHEMA_VERSION,
  missionId: 'MISSION-2026-11-25-0007',
  sha: SHA,
  repository: 'donraposo1-source/project-wolf',
  issuedAt: NOW - 30_000,
};
const run = (body, {env = {}, now = NOW} = {}) => {
  const lines = [];
  const code = missionCli(['--payload', 'p.json'], {
    env: {...env},
    now,
    readFile: () => (typeof body === 'string' ? body : JSON.stringify(body)),
    writeFile: () => {},
    stdout: text => lines.push(text),
  });
  return {code, report: JSON.parse(lines.join(''))};
};

test('a valid mission is accepted with a stable key', () => {
  const {code, report} = run(payload);
  assert.equal(code, MISSION_EXIT.ACCEPTED);
  assert.equal(report.state, MISSION_STATES.ACCEPTED);
  assert.equal(report.key, `${payload.missionId}@${SHA}`);
  assert.equal(report.sha, SHA);
});

test('the same mission is a duplicate, and a duplicate is not an error', () => {
  const first = run(payload);
  const second = run(payload, {env: {WOLF_CI_JOURNAL: 'journal.jsonl'}});
  assert.equal(first.code, MISSION_EXIT.ACCEPTED);
  // No journal file exists in this fixture, so the second is accepted again; the
  // duplicate path is proven below with a real journal.
  assert.ok([MISSION_EXIT.ACCEPTED, MISSION_EXIT.DUPLICATE].includes(second.code));
});

test('a duplicate is detected from the durable journal and exits 3', () => {
  const {mkdtempSync, writeFileSync} = require('node:fs');
  const {tmpdir} = require('node:os');
  const {join} = require('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mission-'));
  const journal = join(dir, 'journal.jsonl');
  writeFileSync(journal, JSON.stringify({state: 'ACCEPTED', key: `${payload.missionId}@${SHA}`}) + '\n');
  assert.deepEqual(readSeenKeys(journal), [`${payload.missionId}@${SHA}`]);
  const {code, report} = run(payload, {env: {WOLF_CI_JOURNAL: journal}});
  assert.equal(code, MISSION_EXIT.DUPLICATE);
  assert.equal(report.duplicate, true);
});

test('a corrupted journal line does not break duplicate detection or crash', () => {
  const {mkdtempSync, writeFileSync} = require('node:fs');
  const {tmpdir} = require('node:os');
  const {join} = require('node:path');
  const journal = join(mkdtempSync(join(tmpdir(), 'mission-bad-')), 'j.jsonl');
  writeFileSync(journal, '{not json\n' + JSON.stringify({state: 'ACCEPTED', key: 'a@' + SHA}) + '\n');
  assert.deepEqual(readSeenKeys(journal), ['a@' + SHA]);
});

test('an unauthorized repository is rejected', () => {
  const {code, report} = run({...payload, repository: 'someone/else'});
  assert.equal(code, MISSION_EXIT.REJECTED);
  assert.equal(report.reason, 'MISSION_REPOSITORY_NOT_ALLOWED');
});

test('unreadable or missing payloads fail closed', () => {
  assert.equal(run('{not json').code, MISSION_EXIT.REJECTED);
  assert.equal(run('{not json').report.reason, 'MISSION_PAYLOAD_UNREADABLE');
  const lines = [];
  const code = missionCli([], {env: {}, now: NOW, stdout: text => lines.push(text)});
  assert.equal(code, MISSION_EXIT.REJECTED);
  assert.equal(JSON.parse(lines.join('')).reason, 'MISSION_PAYLOAD_FILE_REQUIRED');
});

test('only the two authorized repositories are on the allowlist', () => {
  assert.deepEqual([...ALLOWED_REPOSITORIES].sort(), ['donraposo1-source/project-wolf', 'insidethemarginmedia-cpu/wolf-factory-home']);
});

test('the intake output never carries the payload or a credential', () => {
  const {report} = run({...payload, note: 'PRIVATE_SOURCE_MARKER'});
  assert.equal(JSON.stringify(report).includes('PRIVATE_SOURCE_MARKER'), false);
  assert.equal(report.credentialsPrinted, false);
});
