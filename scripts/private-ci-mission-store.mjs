import {createHash} from 'node:crypto';
import {MISSION_REQUIRED_CHECKS} from './private-ci-mission.mjs';

const API = 'https://api.github.com';
const HOME_REPOSITORIES = new Set(['insidethemarginmedia-cpu/wolf-factory-home']);
const TARGET_REPOSITORIES = new Set(['donraposo1-source/project-wolf']);
const MISSION_LIMIT = 12;
const HTTP_TIMEOUT_MS = 15000;

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function apiUrl(repository, suffix) {
  return `${API}/repos/${repository}/${suffix}`;
}

async function request(url, {token, method = 'GET', body, fetchImpl = globalThis.fetch} = {}) {
  if (typeof token !== 'string' || !token.trim()) throw Error('MISSION_STORE_TOKEN_REQUIRED');
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'WolfPrivateCiMissionLedger',
        'x-github-api-version': '2022-11-28',
      },
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    throw Error('MISSION_STORE_NETWORK_FAILED');
  }
  let payload = null;
  if (response.status !== 204) {
    try { payload = await response.json(); } catch { payload = null; }
  }
  return {ok: response.ok === true || response.status === 201, status: response.status, payload};
}

async function readRef({repository, token, ref, fetchImpl}) {
  const apiRef = ref.replace(/^refs\//, '');
  const result = await request(apiUrl(repository, `git/ref/${encodeURIComponent(apiRef)}`), {token, fetchImpl});
  if (result.status === 404) return null;
  if (!result.ok) throw Error(result.status === 403 ? 'MISSION_STORE_PERMISSION_DENIED' : 'MISSION_STORE_REF_READ_FAILED');
  const sha = result.payload?.object?.sha;
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/i.test(sha)) throw Error('MISSION_STORE_REF_RESPONSE_INVALID');
  return sha.toLowerCase();
}

async function createRef({repository, token, ref, sha, fetchImpl}) {
  const result = await request(apiUrl(repository, 'git/refs'), {
    token,
    method: 'POST',
    body: {ref, sha},
    fetchImpl,
  });
  if (result.ok) return 'CREATED';
  if (result.status === 422 || result.status === 409) {
    return await readRef({repository, token, ref, fetchImpl}) ? 'EXISTS' : 'CONFLICT_UNRESOLVED';
  }
  if (result.status === 403 || result.status === 404) throw Error('MISSION_STORE_PERMISSION_DENIED');
  throw Error('MISSION_STORE_REF_CREATE_FAILED');
}

async function createReservationCommit({repository, token, record, fetchImpl}) {
  const blob = await request(apiUrl(repository, 'git/blobs'), {
    token,
    method: 'POST',
    body: {content: JSON.stringify(record) + '\n', encoding: 'utf-8'},
    fetchImpl,
  });
  if (!blob.ok || !/^[a-f0-9]{40}$/i.test(String(blob.payload?.sha ?? ''))) throw Error(blob.status === 403 ? 'MISSION_STORE_PERMISSION_DENIED' : 'MISSION_STORE_BLOB_CREATE_FAILED');

  const tree = await request(apiUrl(repository, 'git/trees'), {
    token,
    method: 'POST',
    body: {tree: [{path: 'mission.json', mode: '100644', type: 'blob', sha: blob.payload.sha}]},
    fetchImpl,
  });
  if (!tree.ok || !/^[a-f0-9]{40}$/i.test(String(tree.payload?.sha ?? ''))) throw Error(tree.status === 403 ? 'MISSION_STORE_PERMISSION_DENIED' : 'MISSION_STORE_TREE_CREATE_FAILED');

  const commit = await request(apiUrl(repository, 'git/commits'), {
    token,
    method: 'POST',
    body: {message: `wolf-ci mission reservation ${record.keyHash}`, tree: tree.payload.sha, parents: []},
    fetchImpl,
  });
  if (!commit.ok || !/^[a-f0-9]{40}$/i.test(String(commit.payload?.sha ?? ''))) throw Error(commit.status === 403 ? 'MISSION_STORE_PERMISSION_DENIED' : 'MISSION_STORE_COMMIT_CREATE_FAILED');
  return commit.payload.sha.toLowerCase();
}

async function reserveRateSlot({repository, token, actorHash, bucket, commitSha, fetchImpl}) {
  const prefix = `refs/heads/wolf-ci-missions/rate/${actorHash}/${bucket}`;
  for (let slot = 0; slot < MISSION_LIMIT; slot += 1) {
    const ref = `${prefix}/${String(slot).padStart(2, '0')}`;
    if (await readRef({repository, token, ref, fetchImpl})) continue;
    const state = await createRef({repository, token, ref, sha: commitSha, fetchImpl});
    if (state === 'CREATED') return {state: 'RESERVED', ref, slot};
    if (state === 'EXISTS') continue;
    throw Error('MISSION_STORE_RATE_SLOT_CONFLICT');
  }
  return {state: 'RATE_LIMITED', ref: null, slot: null};
}

/**
 * Durable, create-only GitHub-ref admission. Each mission gets an atomic unique
 * reservation ref; a separate set of 12 per-actor/per-UTC-hour refs enforces the
 * declared sender rate cap even when requests arrive concurrently. No checkout
 * runner-local file is treated as replay protection.
 */
export async function reserveGithubMission({token, journalRepository, mission, actor, allowedActors = [], now = Date.now(), fetchImpl = globalThis.fetch} = {}) {
  if (!HOME_REPOSITORIES.has(journalRepository)) return {state: 'BLOCKED', reason: 'MISSION_STORE_REPOSITORY_DENIED'};
  if (!mission || typeof mission.missionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(mission.missionId) || !/^[a-f0-9]{40}$/.test(String(mission.sha ?? ''))) {
    return {state: 'BLOCKED', reason: 'MISSION_STORE_MISSION_INVALID'};
  }
  if (!TARGET_REPOSITORIES.has(mission.repository)) return {state: 'BLOCKED', reason: 'MISSION_STORE_TARGET_DENIED'};
  if (!Array.isArray(mission.checks) || mission.checks.length !== MISSION_REQUIRED_CHECKS.length || new Set(mission.checks).size !== MISSION_REQUIRED_CHECKS.length || MISSION_REQUIRED_CHECKS.some(name => !mission.checks.includes(name))) {
    return {state: 'BLOCKED', reason: 'MISSION_STORE_CHECKS_INVALID'};
  }
  if (typeof actor !== 'string' || !/^[A-Za-z0-9-]{1,39}(?:\[bot\])?$/.test(actor)) return {state: 'BLOCKED', reason: 'MISSION_STORE_ACTOR_REQUIRED'};
  if (!Array.isArray(allowedActors) || !allowedActors.length) return {state: 'BLOCKED', reason: 'MISSION_STORE_ACTOR_ALLOWLIST_REQUIRED'};
  if (!allowedActors.includes(actor)) return {state: 'BLOCKED', reason: 'MISSION_STORE_ACTOR_NOT_ALLOWED'};
  if (typeof token !== 'string' || !token.trim()) return {state: 'BLOCKED', reason: 'MISSION_STORE_TOKEN_REQUIRED'};
  const keyHash = hash(`${mission.repository}@${mission.missionId}@${mission.sha}`);
  const actorHash = hash(actor.toLowerCase());
  const reservationRef = `refs/heads/wolf-ci-missions/reservations/${keyHash}`;
  let reservationCreated = false;
  try {
    if (await readRef({repository: journalRepository, token, ref: reservationRef, fetchImpl})) {
      return {state: 'DUPLICATE', reason: 'MISSION_ALREADY_RESERVED', keyHash, durable: true, credentialsPrinted: false};
    }
    const safeRecord = {
      schema: 'wolf.private-ci.mission-reservation/v1',
      keyHash,
      mission: {
        missionId: mission.missionId,
        repository: mission.repository,
        sha: mission.sha,
        pr: mission.pr ?? null,
        checks: mission.checks,
        issuedAt: mission.issuedAt,
      },
      actor,
      reservedAt: new Date(now).toISOString(),
      privateSourceIncluded: false,
      credentialsPrinted: false,
    };
    safeRecord.keyHash = keyHash;
    const commitSha = await createReservationCommit({repository: journalRepository, token, record: safeRecord, fetchImpl});
    const reservation = await createRef({repository: journalRepository, token, ref: reservationRef, sha: commitSha, fetchImpl});
    if (reservation === 'EXISTS') return {state: 'DUPLICATE', reason: 'MISSION_ALREADY_RESERVED', keyHash, durable: true, credentialsPrinted: false};
    if (reservation !== 'CREATED') return {state: 'BLOCKED', reason: 'MISSION_STORE_RESERVATION_CONFLICT', keyHash, durable: false, credentialsPrinted: false};
    reservationCreated = true;

    // Claim the unique mission reservation before a sender rate slot. This makes
    // concurrent replays consume at most one slot: only the winner of the
    // create-only reservation can mutate the per-hour bucket. If the rate cap is
    // already full, the durable key remains rejected and an intentional retry
    // must use a new mission id; no target code can run from this record.
    const rate = await reserveRateSlot({
      repository: journalRepository,
      token,
      actorHash,
      bucket: String(Math.floor(now / 3_600_000)),
      commitSha,
      fetchImpl,
    });
    if (rate.state !== 'RESERVED') return {state: 'RATE_LIMITED', reason: 'MISSION_SENDER_HOURLY_LIMIT', keyHash, durable: true, credentialsPrinted: false};
    return {state: 'RESERVED', reason: null, keyHash, rateSlot: rate.slot, durable: true, credentialsPrinted: false};
  } catch (error) {
    const reason = /^MISSION_STORE_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'MISSION_STORE_FAILED';
    return {state: 'BLOCKED', reason, keyHash, durable: reservationCreated, credentialsPrinted: false};
  }
}
