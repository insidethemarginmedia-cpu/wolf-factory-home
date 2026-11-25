import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {reserveGithubMission} from '../scripts/private-ci-mission-store.mjs';
import {MISSION_REQUIRED_CHECKS} from '../scripts/private-ci-mission.mjs';

const HOME = 'insidethemarginmedia-cpu/wolf-factory-home';
const TARGET = 'donraposo1-source/project-wolf';
const TOKEN = 'synthetic-home-github-token';
const ACTOR = 'wolf-factory-automation[bot]';
const NOW = Date.parse('2026-11-25T12:30:00Z');
const mission = {missionId: 'MISSION-STORE-TEST-0001', repository: TARGET, sha: 'a'.repeat(40), pr: 743, checks: [...MISSION_REQUIRED_CHECKS], issuedAt: NOW - 1000};
const sha = value => createHash('sha256').update(String(value)).digest('hex');
const reservationName = mission => `refs/heads/wolf-ci-missions/reservations/${sha(`${mission.repository}@${mission.missionId}@${mission.sha}`)}`;
const actorHash = sha(ACTOR.toLowerCase());
const bucket = String(Math.floor(NOW / 3_600_000));
const ratePrefix = `refs/heads/wolf-ci-missions/rate/${actorHash}/${bucket}`;

function mockGitHub({initialRefs = new Map()} = {}) {
  const refs = new Map(initialRefs);
  const calls = [];
  let objectNumber = 1;
  const nextSha = () => String(objectNumber++).padStart(40, '0');
  const fetchImpl = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const suffix = url.split('/git/ref/')[1];
    if (method === 'GET' && suffix !== undefined) {
      const ref = `refs/${decodeURIComponent(suffix)}`;
      calls.push({method, kind: 'get-ref', ref});
      return refs.has(ref)
        ? {ok: true, status: 200, json: async () => ({object: {sha: refs.get(ref)}})}
        : {ok: false, status: 404, json: async () => ({})};
    }
    if (method === 'POST' && url.endsWith('/git/blobs')) {
      calls.push({method, kind: 'blob'});
      return {ok: true, status: 201, json: async () => ({sha: nextSha()})};
    }
    if (method === 'POST' && url.endsWith('/git/trees')) {
      calls.push({method, kind: 'tree'});
      return {ok: true, status: 201, json: async () => ({sha: nextSha()})};
    }
    if (method === 'POST' && url.endsWith('/git/commits')) {
      calls.push({method, kind: 'commit'});
      return {ok: true, status: 201, json: async () => ({sha: nextSha()})};
    }
    if (method === 'POST' && url.endsWith('/git/refs')) {
      const body = JSON.parse(options.body);
      calls.push({method, kind: 'create-ref', ref: body.ref});
      if (refs.has(body.ref)) return {ok: false, status: 422, json: async () => ({})};
      refs.set(body.ref, body.sha);
      return {ok: true, status: 201, json: async () => ({ref: body.ref, object: {sha: body.sha}})};
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return {refs, calls, fetchImpl};
}

test('mission admission creates a durable unique reservation and rate slot in GitHub refs', async () => {
  const mock = mockGitHub();
  const result = await reserveGithubMission({token: TOKEN, journalRepository: HOME, mission, actor: ACTOR, allowedActors: [ACTOR], now: NOW, fetchImpl: mock.fetchImpl});
  assert.equal(result.state, 'RESERVED');
  assert.equal(result.durable, true);
  assert.equal(mock.refs.has(reservationName(mission)), true);
  assert.equal(mock.refs.has(`${ratePrefix}/00`), true);
  assert.equal(mock.calls.filter(call => call.kind === 'create-ref').length, 2);
});

test('a replay sees the existing reservation and cannot consume or create another slot', async () => {
  const initialRefs = new Map([[reservationName(mission), 'b'.repeat(40)]]);
  const mock = mockGitHub({initialRefs});
  const result = await reserveGithubMission({token: TOKEN, journalRepository: HOME, mission, actor: ACTOR, allowedActors: [ACTOR], now: NOW, fetchImpl: mock.fetchImpl});
  assert.equal(result.state, 'DUPLICATE');
  assert.equal(mock.calls.filter(call => call.kind === 'create-ref').length, 0);
  assert.equal([...mock.refs.keys()].filter(ref => ref.startsWith(ratePrefix)).length, 0);
});

test('the twelfth fixed-UTC-hour slot blocks further missions for the same actor', async () => {
  const initialRefs = new Map(Array.from({length: 12}, (_, slot) => [`${ratePrefix}/${String(slot).padStart(2, '0')}`, 'b'.repeat(40)]));
  const mock = mockGitHub({initialRefs});
  const result = await reserveGithubMission({token: TOKEN, journalRepository: HOME, mission, actor: ACTOR, allowedActors: [ACTOR], now: NOW, fetchImpl: mock.fetchImpl});
  assert.equal(result.state, 'RATE_LIMITED');
  assert.equal(result.durable, true, 'the rejected mission key is still durably consumed');
  assert.equal(mock.refs.has(reservationName(mission)), true);
  assert.equal([...mock.refs.keys()].filter(ref => ref.startsWith(ratePrefix)).length, 12);
});

test('unknown repositories and absent tokens fail closed before GitHub mutation', async () => {
  const mock = mockGitHub();
  assert.equal((await reserveGithubMission({token: TOKEN, journalRepository: 'other/repo', mission, actor: ACTOR, allowedActors: [ACTOR], now: NOW, fetchImpl: mock.fetchImpl})).reason, 'MISSION_STORE_REPOSITORY_DENIED');
  assert.equal((await reserveGithubMission({token: '', journalRepository: HOME, mission, actor: ACTOR, allowedActors: [ACTOR], now: NOW, fetchImpl: mock.fetchImpl})).reason, 'MISSION_STORE_TOKEN_REQUIRED');
  assert.equal(mock.calls.length, 0);
});

test('store independently enforces actor, target and fixed-check admission before network access', async () => {
  const mock = mockGitHub();
  const deniedActor = await reserveGithubMission({token: TOKEN, journalRepository: HOME, mission, actor: 'other[bot]', allowedActors: [ACTOR], now: NOW, fetchImpl: mock.fetchImpl});
  assert.equal(deniedActor.reason, 'MISSION_STORE_ACTOR_NOT_ALLOWED');
  const deniedTarget = await reserveGithubMission({token: TOKEN, journalRepository: HOME, mission: {...mission, repository: 'someone/else'}, actor: ACTOR, allowedActors: [ACTOR], now: NOW, fetchImpl: mock.fetchImpl});
  assert.equal(deniedTarget.reason, 'MISSION_STORE_TARGET_DENIED');
  const deniedChecks = await reserveGithubMission({token: TOKEN, journalRepository: HOME, mission: {...mission, checks: ['unit']}, actor: ACTOR, allowedActors: [ACTOR], now: NOW, fetchImpl: mock.fetchImpl});
  assert.equal(deniedChecks.reason, 'MISSION_STORE_CHECKS_INVALID');
  assert.equal(mock.calls.length, 0);
});

test('parallel duplicate deliveries create at most one permanent reservation', async () => {
  const mock = mockGitHub();
  const results = await Promise.all([
    reserveGithubMission({token: TOKEN, journalRepository: HOME, mission, actor: ACTOR, allowedActors: [ACTOR], now: NOW, fetchImpl: mock.fetchImpl}),
    reserveGithubMission({token: TOKEN, journalRepository: HOME, mission, actor: ACTOR, allowedActors: [ACTOR], now: NOW, fetchImpl: mock.fetchImpl}),
  ]);
  assert.equal(results.filter(result => result.state === 'RESERVED').length, 1);
  assert.equal(results.filter(result => result.state === 'DUPLICATE').length, 1);
  assert.equal([...mock.refs.keys()].filter(ref => ref === reservationName(mission)).length, 1);
  assert.equal([...mock.refs.keys()].filter(ref => ref.startsWith(ratePrefix)).length, 1, 'a duplicate delivery does not consume a second sender slot');
});

test('a rate-ledger failure after reservation blocks execution and preserves durable deduplication', async () => {
  const mock = mockGitHub();
  const fetchImpl = async (url, options = {}) => {
    const encodedRef = url.split('/git/ref/')[1];
    if (encodedRef && decodeURIComponent(encodedRef).includes('/rate/')) {
      return {ok: false, status: 500, json: async () => ({})};
    }
    return mock.fetchImpl(url, options);
  };
  const result = await reserveGithubMission({token: TOKEN, journalRepository: HOME, mission, actor: ACTOR, allowedActors: [ACTOR], now: NOW, fetchImpl});
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.reason, 'MISSION_STORE_REF_READ_FAILED');
  assert.equal(result.durable, true);
  assert.equal(mock.refs.has(reservationName(mission)), true);
});
