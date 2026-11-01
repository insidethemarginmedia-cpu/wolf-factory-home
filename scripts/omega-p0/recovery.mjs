/*
 * Wolf Omega P0 -- durable recovery admission guards.
 *
 * These functions do NOT replace the existing KCT/DBOS recovery. They are pure
 * guards that must be called by the EXISTING recovery workflow before it consumes a
 * durable checkpoint, claims a lease, publishes a result or drains NEXT_READY.
 * All state lives in the EXISTING ledger: the `ports.compareAndSwap*` functions are
 * the existing atomic ledger operations, injected here so the guards own no state.
 */
import {
  POLICY, canonicalDigest, deny, failClosed, isPlainObject, readPort,
} from './policy.mjs';

async function read(ports, name, arg) {
  return readPort(ports, name, arg);
}

function shape(request) {
  if (!isPlainObject(request)) deny('RECOVERY_REQUEST_INVALID');
  for (const field of ['missionId', 'attemptId', 'executionKey', 'idempotencyKey', 'workflowId', 'owner', 'workerId']) {
    if (typeof request[field] !== 'string' || !request[field]) deny('RECOVERY_REQUEST_INVALID', field);
  }
  if (!Number.isSafeInteger(request.fencingGeneration) || request.fencingGeneration < 1) {
    deny('RECOVERY_FENCE_INVALID');
  }
  return true;
}

/** Admit one durable recovery attempt. Fail closed on every unverifiable fact. */
export async function admitRecovery(request, ports, config = {}) {
  const now = typeof config.now === 'function' ? config.now() : Date.now();
  try {
    shape(request);
    const {missionId, executionKey, idempotencyKey} = request;

    // Duplicate workflow delivery: an atomic, idempotency-keyed admission.
    const delivery = await read(ports, 'readDelivery', {idempotencyKey});
    if (delivery && delivery.state !== 'ABSENT') deny('DUPLICATE_WORKFLOW_DELIVERY');
    const claimedDelivery = await read(ports, 'compareAndSwapDelivery', {idempotencyKey, missionId, attemptId: request.attemptId});
    if (!isPlainObject(claimedDelivery) || claimedDelivery.applied !== true) deny('DUPLICATE_WORKFLOW_DELIVERY');

    // An UNKNOWN external effect is reconcile-only and can never be replayed.
    const effect = await read(ports, 'readExternalEffect', {executionKey, idempotencyKey, missionId});
    if (!isPlainObject(effect)) deny('EXTERNAL_EFFECT_DISPOSITION_UNKNOWN');
    if (effect.state === 'UNKNOWN') {
      return Object.freeze({
        state: 'RECONCILE_ONLY', reason: 'UNKNOWN_EXTERNAL_EFFECT_RECONCILE_ONLY',
        automaticRetry: false, replay: false, newExternalEffect: false,
        disposition: POLICY.UNKNOWN_EXTERNAL_EFFECT,
      });
    }

    const mission = await read(ports, 'readMission', {missionId});
    if (!isPlainObject(mission) || mission.missionId !== missionId) deny('MISSION_NOT_FOUND');
    if (mission.terminal === true || ['COMPLETED', 'FINAL', 'CLOSED', 'TERMINAL'].includes(mission.state)) {
      deny('TERMINAL_MISSION_RECREATION_DENIED');
    }
    if (mission.attemptId !== request.attemptId || mission.executionKey !== executionKey ||
        mission.idempotencyKey !== idempotencyKey) deny('MISSION_ATTEMPT_MISMATCH');
    if (await read(ports, 'verifyMission', {record: mission}) !== true) deny('MISSION_AUTHORITY_UNVERIFIED');

    // Durable checkpoint revalidation: exact checkpoint, persisted, unreplayed.
    const checkpoint = await read(ports, 'readCheckpoint', {checkpointId: request.checkpointId});
    if (!isPlainObject(checkpoint) || checkpoint.missionId !== missionId ||
        checkpoint.state !== 'PERSISTED' || checkpoint.replayed !== false) {
      deny('CHECKPOINT_REVALIDATION_FAILED');
    }

    // KCT owner, current fencing generation and lease.
    const claim = await read(ports, 'readKctClaim', {missionId});
    if (!isPlainObject(claim) || claim.active !== true || claim.released === true) deny('KCT_CLAIM_NOT_ACTIVE');
    if (await read(ports, 'verifyKctClaim', {record: claim}) !== true) deny('KCT_CLAIM_UNVERIFIED');
    const currentFence = await read(ports, 'readCurrentFencingGeneration', {missionId});
    if (!Number.isSafeInteger(currentFence) || currentFence < 1 || claim.fencingToken !== currentFence ||
        request.fencingGeneration !== currentFence) deny('STALE_FENCING_GENERATION');
    if (!Number.isFinite(claim.expiresAt) || claim.expiresAt <= now) deny('KCT_LEASE_EXPIRED');
    if (claim.owner !== request.owner) deny('KCT_OWNER_MISMATCH');
    const lease = await read(ports, 'readLease', {missionId});
    if (!isPlainObject(lease) || lease.valid !== true || !Number.isFinite(lease.expiresAt) || lease.expiresAt <= now) {
      deny('STALE_LEASE_DENIED');
    }
    if (lease.holder !== request.owner || lease.generation !== currentFence) deny('STALE_LEASE_DENIED');

    // Runner recovery destination ownership and fail-closed owner identity.
    const ownerIdentity = await read(ports, 'readOwnerIdentity', {owner: request.owner});
    if (!isPlainObject(ownerIdentity) || ownerIdentity.verified !== true || ownerIdentity.owner !== request.owner) {
      deny('RUNNER_OWNER_UNVERIFIABLE');
    }
    const workflow = await read(ports, 'readWorkflowOwnership', {workflowId: request.workflowId, missionId});
    if (!isPlainObject(workflow) || workflow.owner !== request.owner || workflow.missionId !== missionId ||
        workflow.workflowFence !== currentFence) deny('DBOS_WORKFLOW_OWNERSHIP_MISMATCH');
    const runner = await read(ports, 'readRunnerState', {missionId});
    if (!isPlainObject(runner) || runner.destinationOwner !== request.owner ||
        runner.originalProcessTerminated !== true) deny('RUNNER_RECOVERY_DESTINATION_MISMATCH');

    // Missing external receipt is not completion.
    const receipt = await read(ports, 'readExecutionReceipt', {executionKey});
    if (!isPlainObject(receipt) || receipt.verified !== true) deny('EXTERNAL_RECEIPT_MISSING');

    // Two concurrent recovery workers: exactly one atomic lease claim wins.
    const claimLease = await read(ports, 'compareAndSwapRecoveryLease', {
      missionId, workerId: request.workerId, owner: request.owner, fencingGeneration: currentFence,
    });
    if (!isPlainObject(claimLease) || claimLease.applied !== true) deny('CONCURRENT_RECOVERY_DENIED');

    return Object.freeze({
      state: 'ADMITTED', reason: 'DURABLE_RECOVERY_ADMITTED',
      admissionDigest: canonicalDigest({...request, currentFence, now}),
      fencingGeneration: currentFence,
      automaticRetry: false, newExternalEffect: false,
    });
  } catch (error) {
    return failClosed(error);
  }
}

/** Single, atomic NEXT_READY consumption. A second drain is denied. */
export async function consumeNextReady({missionId, owner, token}, ports) {
  try {
    if (typeof missionId !== 'string' || typeof owner !== 'string' || typeof token !== 'string') {
      deny('NEXT_READY_REQUEST_INVALID');
    }
    const current = await read(ports, 'readNextReady', {missionId});
    if (!isPlainObject(current) || current.state !== 'NEXT_READY' || current.owner !== owner) {
      deny('NEXT_READY_NOT_AVAILABLE');
    }
    const result = await read(ports, 'compareAndSwapNextReady', {missionId, owner, token, expectedState: 'NEXT_READY'});
    if (!isPlainObject(result) || result.applied !== true) deny('DUPLICATE_NEXT_READY_CONSUMPTION');
    return Object.freeze({state: 'CONSUMED', reason: 'NEXT_READY_DRAINED_ONCE', newExternalEffect: false});
  } catch (error) {
    return failClosed(error);
  }
}

/** Duplicate publication prevention through the existing atomic ledger. */
export async function recordPublication({missionId, checkpointId, commitSha, fencingGeneration}, ports) {
  try {
    const existing = await read(ports, 'readPublication', {missionId});
    if (existing && existing.state !== 'ABSENT') deny('DUPLICATE_PUBLICATION_DENIED');
    const currentFence = await read(ports, 'readCurrentFencingGeneration', {missionId});
    if (!Number.isSafeInteger(fencingGeneration) || fencingGeneration !== currentFence) {
      deny('STALE_FENCING_GENERATION');
    }
    const result = await read(ports, 'compareAndSwapPublication', {
      missionId, checkpointId, commitSha, fencingGeneration,
    });
    if (!isPlainObject(result) || result.applied !== true) deny('DUPLICATE_PUBLICATION_DENIED');
    return Object.freeze({state: 'PUBLISHED', reason: 'SINGLE_FENCED_PUBLICATION', newExternalEffect: false});
  } catch (error) {
    return failClosed(error);
  }
}

/**
 * Deterministic crash-window classification. A lost response is NEVER classified
 * as an external failure and NEVER authorizes a retry.
 */
export function classifyExternalWindow(window) {
  const w = isPlainObject(window) ? window : {};
  const base = {automaticRetry: false, replay: false, newExternalEffect: false, disposition: POLICY.UNKNOWN_EXTERNAL_EFFECT};
  if (w.intentPersisted !== true) return Object.freeze({...base, state: 'NO_DURABLE_INTENT', reason: 'CRASH_BEFORE_INTENT'});
  if (w.requestSent !== true) return Object.freeze({...base, state: 'NO_EXTERNAL_EFFECT', reason: 'CRASH_BEFORE_EXTERNAL_REQUEST', disposition: 'NONE'});
  if (w.responseReceived !== true || w.receiptPersisted !== true || w.effectState !== 'VERIFIED') {
    return Object.freeze({...base, state: 'EFFECT_UNKNOWN', reason: 'CRASH_AFTER_REQUEST_OR_LOST_RESPONSE', action: 'RECONCILE_ONLY'});
  }
  return Object.freeze({...base, state: 'EFFECT_VERIFIED', reason: 'INDEPENDENT_RECEIPT_PERSISTED', disposition: 'VERIFIED'});
}

/** Read-only reconciliation. Never replays, never releases a lease, never mutates. */
export async function reconcileUnknownEffect({executionKey, idempotencyKey, missionId}, ports) {
  try {
    const effect = await read(ports, 'readExternalEffect', {executionKey, idempotencyKey, missionId});
    return Object.freeze({
      state: effect?.state === 'VERIFIED' ? 'ALREADY_COMPLETED' : 'RECONCILE_ONLY',
      reason: effect?.state === 'VERIFIED' ? 'EFFECT_ALREADY_VERIFIED' : 'UNKNOWN_EXTERNAL_EFFECT_RECONCILE_ONLY',
      observedState: isPlainObject(effect) ? effect.state : 'UNAVAILABLE',
      terminalDispositionAuthorized: false,
      automaticRetry: false, replay: false, newExternalEffect: false,
      leaseReleased: false, journalMutated: false,
    });
  } catch (error) {
    return Object.freeze({state: 'RECONCILE_ONLY', reason: failClosed(error).reason, automaticRetry: false, replay: false});
  }
}
