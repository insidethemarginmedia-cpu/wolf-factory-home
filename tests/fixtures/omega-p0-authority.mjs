/*
 * Deterministic in-memory stand-in for the EXISTING Factory KCT/DBOS authority and
 * immutable ledger. Every authority record is authenticated with a fixture MAC so
 * that "forged" records can be distinguished from verified ones in adversarial
 * tests. No network, no inference, no external effects.
 */
import crypto from 'node:crypto';
import {canonical, canonicalDigest} from '../../scripts/omega-p0/policy.mjs';

const SECRET = 'wolf-omega-p0-fixture-existing-authority';
const mac = value => crypto.createHmac('sha256', SECRET).update(canonical(value)).digest('hex');
const hex = value => crypto.createHash('sha256').update(value).digest('hex');

function seal(record) {
  const {_mac, ...body} = record;
  return Object.freeze({...body, _mac: mac(body)});
}
function valid(record) {
  if (!record || typeof record !== 'object') return false;
  const {_mac, ...body} = record;
  return typeof _mac === 'string' && mac(body) === _mac;
}

export const OWNER = 'wolf-owner:omega-p0-fixture';
export const WORKER_ID = 'openhands-worker-1';
export const WORKER_TYPE = 'openhands';

export function validIdentifiers() {
  return {
    missionId: 'OMEGA_P0_FIXTURE_1',
    attemptId: 'attempt-1',
    executionKey: hex('execution-key'),
    idempotencyKey: hex('idempotency-key'),
    workflowId: 'wolf-dbos-fixture-1',
    checkpointId: 'wolf-cp-fixture-1',
    jobId: 'JOB.fix.0',
    workerId: WORKER_ID,
    workerType: WORKER_TYPE,
    workerEndpoint: 'https://openhands.factory.internal.invalid/session',
    provider: 'groq',
    account: 'groq-free-verified',
    model: 'openai/gpt-oss-120b',
    endpoint: 'https://factory.internal.invalid/api/runs',
    method: 'POST',
    path: '/api/runs',
    body: '{"scope":"bounded-offline-fixture"}',
  };
}

export function validRequest(overrides = {}) {
  return {...validIdentifiers(), ...overrides};
}

function economicRecord(ids) {
  const requestDigest = canonicalDigest({
    method: ids.method, endpoint: ids.endpoint, path: ids.path, body: ids.body,
    missionId: ids.missionId, attemptId: ids.attemptId, executionKey: ids.executionKey,
    idempotencyKey: ids.idempotencyKey, workflowId: ids.workflowId, workerId: ids.workerId,
    workerType: ids.workerType, workerEndpoint: ids.workerEndpoint, provider: ids.provider,
    account: ids.account, model: ids.model,
  });
  const body = {
    authorized: true,
    priceKnown: true,
    costUsd: 0,
    paidFallback: false,
    trialCredit: false,
    receiptDigest: hex('groq-free-plan-receipt'),
    binding: {
      missionId: ids.missionId, attemptId: ids.attemptId,
      executionKey: ids.executionKey, idempotencyKey: ids.idempotencyKey,
      provider: ids.provider, account: ids.account, model: ids.model,
      endpoint: ids.endpoint, requestDigest,
    },
  };
  return seal(body);
}

function executionReceipt(ids, currentFence) {
  const result = {status: 'PASS', tests: 184, sourceChanged: true};
  const body = {
    schema: 'WolfAuthenticatedExecutionReceipt/v1',
    state: 'COMPLETED',
    independentVerification: true,
    verified: true,
    verifierId: 'independent-verifier-fixture',
    missionId: ids.missionId, attemptId: ids.attemptId,
    executionKey: ids.executionKey, idempotencyKey: ids.idempotencyKey,
    workflowId: ids.workflowId, workerId: ids.workerId, workerType: ids.workerType,
    jobId: ids.jobId, fencingGeneration: currentFence, checkpointId: ids.checkpointId,
    result,
    resultBytes: Buffer.byteLength(canonical(result), 'utf8'),
    resultDigest: canonicalDigest(result),
    sourceChangeDigest: hex('source-change'),
    testsDigest: hex('test-results'),
    evidenceDigest: hex('independent-evidence'),
  };
  return seal(body);
}

/**
 * Build a fully-valid authority state and the ports that read it. `mutate` may
 * alter any field to build an adversarial case; the supplied `config` mirrors the
 * existing Factory policy allowlists.
 */
export function createAuthorityFixture({mutate, now = 1_800_000_000_000, config} = {}) {
  const ids = validIdentifiers();
  const currentFence = 7;
  const state = {
    now,
    currentFence,
    owner: OWNER,
    mission: seal({
      missionId: ids.missionId, attemptId: ids.attemptId, executionKey: ids.executionKey,
      idempotencyKey: ids.idempotencyKey, state: 'ACTIVE', terminal: false,
    }),
    kctClaim: seal({
      taskId: ids.missionId, owner: OWNER, fencingToken: currentFence,
      expiresAt: now + 60000, active: true, released: false,
    }),
    workflow: seal({
      workflowId: ids.workflowId, missionId: ids.missionId, attemptId: ids.attemptId,
      owner: OWNER, status: 'ACTIVE', workflowFence: currentFence,
    }),
    lease: {holder: OWNER, expiresAt: now + 60000, generation: currentFence, valid: true},
    worker: seal({
      workerId: ids.workerId, workerType: ids.workerType, endpoint: ids.workerEndpoint,
      authorized: true, active: true,
    }),
    endpointRecord: seal({
      endpoint: ids.endpoint, trusted: true, provider: ids.provider,
      account: ids.account, models: [ids.model],
    }),
    economic: economicRecord(ids),
    externalEffect: {state: 'NONE'},
    receipt: executionReceipt(ids, currentFence),
    checkpoint: {
      checkpointId: ids.checkpointId, missionId: ids.missionId,
      state: 'PERSISTED', replayed: false,
    },
    delivery: new Map(),
    recoveryLease: null,
    nextReady: {state: 'NEXT_READY', owner: OWNER, token: 'next-ready-token'},
    publication: null,
    runner: {destinationOwner: OWNER, originalProcessTerminated: true},
    ownerIdentity: {owner: OWNER, verified: true},
  };
  if (typeof mutate === 'function') mutate(state, ids);

  const ports = {
    readMission: ({missionId}) => state.mission && state.mission.missionId === missionId ? state.mission : null,
    verifyMission: ({record}) => valid(record),
    readKctClaim: ({missionId}) => state.kctClaim && state.kctClaim.taskId === missionId ? state.kctClaim : null,
    verifyKctClaim: ({record}) => valid(record),
    readCurrentFencingGeneration: () => state.currentFence,
    readWorkflowOwnership: ({workflowId, missionId}) =>
      state.workflow && state.workflow.workflowId === workflowId && state.workflow.missionId === missionId ? state.workflow : null,
    verifyWorkflowOwnership: ({record}) => valid(record),
    readLease: ({missionId}) => state.mission && state.mission.missionId === missionId ? state.lease : null,
    readWorkerRegistry: ({workerId, workerType}) =>
      state.worker && state.worker.workerId === workerId && state.worker.workerType === workerType ? state.worker : null,
    verifyWorkerIdentity: ({record}) => valid(record),
    readEndpointRegistry: ({endpoint}) =>
      state.endpointRecord && state.endpointRecord.endpoint === endpoint ? state.endpointRecord : {trusted: false},
    readEconomicAuthorization: () => state.economic,
    verifyEconomicReceipt: ({record}) => valid(record),
    readExternalEffect: () => state.externalEffect,
    readExecutionReceipt: ({jobId, executionKey}) => {
      if (jobId !== undefined && state.receipt?.jobId !== jobId) return null;
      if (executionKey !== undefined && state.receipt?.executionKey !== executionKey) return null;
      return state.receipt;
    },
    verifyExecutionReceipt: ({receipt}) => valid(receipt),
    readDurableCheckpoint: ({checkpointId}) =>
      state.checkpoint && state.checkpoint.checkpointId === checkpointId ? state.checkpoint : null,
    readCheckpoint: ({checkpointId}) =>
      state.checkpoint && state.checkpoint.checkpointId === checkpointId ? state.checkpoint : null,
    readOwnerIdentity: ({owner}) =>
      state.ownerIdentity && state.ownerIdentity.owner === owner ? state.ownerIdentity : null,
    readRunnerState: () => state.runner,
    readDelivery: ({idempotencyKey}) => state.delivery.get(idempotencyKey) || {state: 'ABSENT'},
    compareAndSwapDelivery: ({idempotencyKey, missionId}) => {
      if (state.delivery.has(idempotencyKey)) return {applied: false};
      state.delivery.set(idempotencyKey, {state: 'CLAIMED', missionId});
      return {applied: true};
    },
    compareAndSwapRecoveryLease: ({missionId, workerId, owner, fencingGeneration}) => {
      if (state.recoveryLease) return {applied: false, holder: state.recoveryLease.workerId};
      state.recoveryLease = {missionId, workerId, owner, fencingGeneration};
      return {applied: true};
    },
    readNextReady: ({missionId}) => state.mission && state.mission.missionId === missionId ? state.nextReady : null,
    compareAndSwapNextReady: ({missionId, owner, expectedState}) => {
      if (state.nextReady.state !== expectedState || state.nextReady.owner !== owner) return {applied: false};
      state.nextReady = {...state.nextReady, state: 'CONSUMED'};
      return {applied: true};
    },
    readPublication: () => state.publication || {state: 'ABSENT'},
    compareAndSwapPublication: ({missionId, checkpointId, commitSha, fencingGeneration}) => {
      if (state.publication) return {applied: false};
      state.publication = {state: 'PUBLISHED', missionId, checkpointId, commitSha, fencingGeneration};
      return {applied: true};
    },
  };

  const policyConfig = config || {
    now: () => state.now,
  };
  return Object.freeze({state, ids, ports, policyConfig, currentFence});
}

export function validCompletionClaim(fixture) {
  const {ids, currentFence, state} = fixture;
  return {
    missionId: ids.missionId, attemptId: ids.attemptId,
    executionKey: ids.executionKey, idempotencyKey: ids.idempotencyKey,
    workflowId: ids.workflowId, workerId: ids.workerId, workerType: ids.workerType,
    jobId: ids.jobId, fencingGeneration: currentFence, checkpointId: ids.checkpointId,
    receipt: state.receipt,
  };
}

export function validRecoveryRequest(fixture) {
  const {ids, currentFence} = fixture;
  return {
    missionId: ids.missionId, attemptId: ids.attemptId,
    executionKey: ids.executionKey, idempotencyKey: ids.idempotencyKey,
    workflowId: ids.workflowId, owner: OWNER, workerId: 'recovery-worker-1',
    fencingGeneration: currentFence, checkpointId: ids.checkpointId,
  };
}

export {seal, valid, mac, hex};
