/*
 * Wolf Omega P0 -- durable recovery adversarial regressions.
 * The ledger is an in-memory atomic CAS stand-in for the EXISTING KCT/DBOS ledger.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  admitRecovery, classifyExternalWindow, consumeNextReady,
  reconcileUnknownEffect, recordPublication,
} from '../scripts/omega-p0/recovery.mjs';
import {
  createAuthorityFixture, validRecoveryRequest, seal, OWNER,
} from './fixtures/omega-p0-authority.mjs';

const fixture = mutate => createAuthorityFixture({mutate});
const requestFor = f => validRecoveryRequest(f);

test('a fully valid recovery is admitted once with a bound admission digest', async () => {
  const f = fixture();
  const result = await admitRecovery(requestFor(f), f.ports, f.policyConfig);
  assert.equal(result.state, 'ADMITTED');
  assert.equal(result.fencingGeneration, f.currentFence);
  assert.match(result.admissionDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.automaticRetry, false);
  assert.equal(result.newExternalEffect, false);
});

test('duplicate workflow delivery is denied by the idempotency ledger', async () => {
  const f = fixture();
  assert.equal((await admitRecovery(requestFor(f), f.ports, f.policyConfig)).state, 'ADMITTED');
  const second = await admitRecovery(requestFor(f), f.ports, f.policyConfig);
  assert.equal(second.state, 'DENIED');
  assert.equal(second.reason, 'DUPLICATE_WORKFLOW_DELIVERY');
});

test('two concurrent recovery workers: exactly one atomic lease claim wins', async () => {
  const f = fixture();
  const first = await admitRecovery({...requestFor(f), workerId: 'worker-A'}, f.ports, f.policyConfig);
  assert.equal(first.state, 'ADMITTED');
  f.state.delivery.clear(); // a second, independently delivered workflow message
  const second = await admitRecovery({...requestFor(f), workerId: 'worker-B'}, f.ports, f.policyConfig);
  assert.equal(second.state, 'DENIED');
  assert.equal(second.reason, 'CONCURRENT_RECOVERY_DENIED');
  assert.equal(f.state.recoveryLease.workerId, 'worker-A');
});

test('stale lease, fencing mismatch, forged KCT and unverifiable owner fail closed', async () => {
  const cases = [
    [state => { state.lease = {...state.lease, expiresAt: state.now - 1}; }, 'STALE_LEASE_DENIED'],
    [state => { state.lease = {...state.lease, holder: 'other'}; }, 'STALE_LEASE_DENIED'],
    [state => { state.currentFence = 8; }, 'STALE_FENCING_GENERATION'],
    [state => { state.kctClaim = {...state.kctClaim, owner: 'forged'}; }, 'KCT_CLAIM_UNVERIFIED'],
    [state => { state.ownerIdentity = null; }, 'RUNNER_OWNER_UNVERIFIABLE'],
    [state => { state.runner = {...state.runner, destinationOwner: 'other'}; }, 'RUNNER_RECOVERY_DESTINATION_MISMATCH'],
    [state => { state.runner = {...state.runner, originalProcessTerminated: false}; }, 'RUNNER_RECOVERY_DESTINATION_MISMATCH'],
  ];
  for (const [mutate, reason] of cases) {
    const f = fixture(mutate);
    const result = await admitRecovery(requestFor(f), f.ports, f.policyConfig);
    assert.equal(result.state, 'DENIED', reason);
    assert.equal(result.reason, reason);
  }
  const wrongFence = fixture();
  const mismatch = await admitRecovery({...requestFor(wrongFence), fencingGeneration: wrongFence.currentFence - 1}, wrongFence.ports, wrongFence.policyConfig);
  assert.equal(mismatch.reason, 'STALE_FENCING_GENERATION');
});

test('terminal mission recreation and corrupt checkpoints are denied', async () => {
  for (const [mutate, reason] of [
    [state => { state.mission = seal({...state.mission, terminal: true}); }, 'TERMINAL_MISSION_RECREATION_DENIED'],
    [state => { state.checkpoint = {...state.checkpoint, replayed: true}; }, 'CHECKPOINT_REVALIDATION_FAILED'],
    [state => { state.checkpoint = null; }, 'CHECKPOINT_REVALIDATION_FAILED'],
  ]) {
    const f = fixture(mutate);
    const result = await admitRecovery(requestFor(f), f.ports, f.policyConfig);
    assert.equal(result.reason, reason);
  }
});

test('missing external receipt and UNKNOWN effects never become completion or replay', async () => {
  const noReceipt = fixture(state => { state.receipt = null; });
  const missing = await admitRecovery(requestFor(noReceipt), noReceipt.ports, noReceipt.policyConfig);
  assert.equal(missing.reason, 'EXTERNAL_RECEIPT_MISSING');

  const unknown = fixture(state => { state.externalEffect = {state: 'UNKNOWN'}; });
  const result = await admitRecovery(requestFor(unknown), unknown.ports, unknown.policyConfig);
  assert.equal(result.state, 'RECONCILE_ONLY');
  assert.equal(result.reason, 'UNKNOWN_EXTERNAL_EFFECT_RECONCILE_ONLY');
  assert.equal(result.automaticRetry, false);
  assert.equal(result.replay, false);
  assert.equal(result.newExternalEffect, false);
  const reconcile = await reconcileUnknownEffect({
    executionKey: unknown.ids.executionKey, idempotencyKey: unknown.ids.idempotencyKey,
    missionId: unknown.ids.missionId,
  }, unknown.ports);
  assert.equal(reconcile.state, 'RECONCILE_ONLY');
  assert.equal(reconcile.terminalDispositionAuthorized, false);
  assert.equal(reconcile.leaseReleased, false);
  assert.equal(reconcile.journalMutated, false);
  assert.equal(reconcile.replay, false);
});

test('NEXT_READY is drained exactly once', async () => {
  const f = fixture();
  const args = {missionId: f.ids.missionId, owner: OWNER, token: 'next-ready-token'};
  const first = await consumeNextReady(args, f.ports);
  assert.equal(first.state, 'CONSUMED');
  assert.equal(first.newExternalEffect, false);
  const second = await consumeNextReady(args, f.ports);
  assert.equal(second.state, 'DENIED');
  assert.equal(second.reason, 'NEXT_READY_NOT_AVAILABLE');
});

test('duplicate publication and stale publication fences are denied', async () => {
  const f = fixture();
  const args = {
    missionId: f.ids.missionId, checkpointId: f.ids.checkpointId,
    commitSha: 'a'.repeat(40), fencingGeneration: f.currentFence,
  };
  assert.equal((await recordPublication(args, f.ports)).state, 'PUBLISHED');
  const duplicate = await recordPublication(args, f.ports);
  assert.equal(duplicate.reason, 'DUPLICATE_PUBLICATION_DENIED');
  const g = fixture();
  const stale = await recordPublication({...args, fencingGeneration: g.currentFence - 1}, g.ports);
  assert.equal(stale.reason, 'STALE_FENCING_GENERATION');
});

test('crash windows are classified deterministically and never authorize retry', () => {
  const cases = [
    [{}, 'NO_DURABLE_INTENT'],
    [{intentPersisted: true}, 'NO_EXTERNAL_EFFECT'],
    [{intentPersisted: true, requestSent: true}, 'EFFECT_UNKNOWN'],
    [{intentPersisted: true, requestSent: true, responseReceived: false}, 'EFFECT_UNKNOWN'],
    [{intentPersisted: true, requestSent: true, responseReceived: true, receiptPersisted: false}, 'EFFECT_UNKNOWN'],
    [{intentPersisted: true, requestSent: true, responseReceived: true, receiptPersisted: true, effectState: 'UNKNOWN'}, 'EFFECT_UNKNOWN'],
    [{intentPersisted: true, requestSent: true, responseReceived: true, receiptPersisted: true, effectState: 'VERIFIED'}, 'EFFECT_VERIFIED'],
  ];
  for (const [window, state] of cases) {
    const result = classifyExternalWindow(window);
    assert.equal(result.state, state, JSON.stringify(window));
    assert.equal(result.automaticRetry, false);
    assert.equal(result.replay, false);
    if (state === 'EFFECT_UNKNOWN') {
      assert.equal(result.action, 'RECONCILE_ONLY');
      assert.equal(result.disposition, 'RECONCILE_ONLY');
    }
  }
});
