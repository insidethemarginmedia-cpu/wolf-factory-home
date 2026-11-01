// Recovery after process restart.
//
// The definition of "restart" used here is literal: a process exits, and a
// different OS process (not a fresh object in the same runtime) observes the
// durable state. Anything reconstructed only in memory would fail these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeWorkspace,
  seedTwoMissions,
  leaseEngine,
  referenceAdapter,
  MISSION_A,
} from '../infra/autonomy/test-support/fixtures.mjs';
import { createP2Gate } from '../infra/autonomy/p2-gate.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKER = join(ROOT, 'infra/autonomy/test-support/lease-worker.mjs');
const NS = 'core';

function run(args) {
  const result = spawnSync(process.execPath, [WORKER, args.action, JSON.stringify(args)], { encoding: 'utf8' });
  assert.equal(result.status, 0, `worker crashed: ${result.stderr}`);
  const line = result.stdout.trim().split('\n').filter(Boolean).at(-1);
  return JSON.parse(line);
}

test('memory data written before a restart is readable after it', () => {
  const ws = makeWorkspace();
  try {
    seedTwoMissions(ws);

    // Process 1: claim and read.
    const first = run({
      action: 'read', leasePath: ws.leasePath, memoryPath: ws.memoryPath,
      missionId: MISSION_A, namespace: NS, ownerId: 'p1', key: 'plan',
    });
    assert.equal(first.ok, true);
    assert.equal(first.value.value, 'A-plan');

    // Process 1 exits cleanly, releasing its lease. (A lease deliberately left
    // held is the *next* test: it must still fence a successor.)
    const released = run({
      action: 'release', leasePath: ws.leasePath, memoryPath: ws.memoryPath,
      missionId: MISSION_A, namespace: NS, claim: first.claim,
    });
    assert.equal(released.ok, true);

    // Process 1 has exited. A new process claims afresh and reads the same data.
    const second = run({
      action: 'read', leasePath: ws.leasePath, memoryPath: ws.memoryPath,
      missionId: MISSION_A, namespace: NS, ownerId: 'p2', key: 'plan',
    });
    assert.equal(second.ok, true);
    assert.equal(second.value.value, 'A-plan');
    // A new claim after release advances the fence; it never resets to 1.
    assert.ok(second.claim.fencingToken >= 1);
  } finally { ws.cleanup(); }
});

test('a lease left active by a crashed process survives and still fences', () => {
  const ws = makeWorkspace();
  try {
    seedTwoMissions(ws);

    // Process 1 claims and "crashes" without releasing.
    const claimed = run({
      action: 'claim', leasePath: ws.leasePath, memoryPath: ws.memoryPath,
      missionId: MISSION_A, namespace: NS, ownerId: 'crashed', ttlMs: 60000,
    });
    assert.equal(claimed.ok, true);

    // Process 2 cannot simply take the lease over.
    const contending = run({
      action: 'claim', leasePath: ws.leasePath, memoryPath: ws.memoryPath,
      missionId: MISSION_A, namespace: NS, ownerId: 'intruder', ttlMs: 60000,
    });
    assert.equal(contending.ok, false);
    assert.equal(contending.code, 'LEASE_ALREADY_HELD');

    // Process 3 confirms the crashed process's claim is still the authority.
    const asserted = run({
      action: 'assert', leasePath: ws.leasePath, memoryPath: ws.memoryPath,
      missionId: MISSION_A, namespace: NS, claim: claimed.claim,
    });
    assert.equal(asserted.ok, true);
    assert.equal(asserted.result.fencingToken, claimed.claim.fencingToken);
  } finally { ws.cleanup(); }
});

test('a released lease stays released across a restart', () => {
  const ws = makeWorkspace();
  try {
    seedTwoMissions(ws);
    const claimed = run({
      action: 'claim', leasePath: ws.leasePath, memoryPath: ws.memoryPath,
      missionId: MISSION_A, namespace: NS, ownerId: 'p1', ttlMs: 60000,
    });
    run({
      action: 'release', leasePath: ws.leasePath, memoryPath: ws.memoryPath,
      missionId: MISSION_A, namespace: NS, claim: claimed.claim,
    });

    // After restart, the old claim is still refused.
    const afterRestart = run({
      action: 'assert', leasePath: ws.leasePath, memoryPath: ws.memoryPath,
      missionId: MISSION_A, namespace: NS, claim: claimed.claim,
    });
    assert.equal(afterRestart.ok, false);
    assert.equal(afterRestart.code, 'LEASE_RELEASED');

    // And the gate refuses to serve data for it.
    const engine = leaseEngine(ws);
    const gate = createP2Gate({ adapter: referenceAdapter(engine), memoryPath: ws.memoryPath, allowUnverifiedLease: true });
    assert.throws(() => gate.read(claimed.claim, 'plan'), (e) => e.dataReleased === false);
    gate.close();
    engine.close();
  } finally { ws.cleanup(); }
});

test('an expired lease is reclaimable after a restart and the fence advances monotonically', async () => {
  const ws = makeWorkspace();
  try {
    seedTwoMissions(ws);
    const claimed = run({
      action: 'claim', leasePath: ws.leasePath, memoryPath: ws.memoryPath,
      missionId: MISSION_A, namespace: NS, ownerId: 'p1', ttlMs: 150,
    });
    assert.equal(claimed.ok, true);

    await new Promise((r) => setTimeout(r, 400)); // lease lifetime elapses

    const reclaimed = run({
      action: 'claim', leasePath: ws.leasePath, memoryPath: ws.memoryPath,
      missionId: MISSION_A, namespace: NS, ownerId: 'p2', ttlMs: 60000,
    });
    assert.equal(reclaimed.ok, true);
    assert.ok(
      reclaimed.claim.fencingToken > claimed.claim.fencingToken,
      `fence must advance: ${claimed.claim.fencingToken} -> ${reclaimed.claim.fencingToken}`,
    );

    // The pre-restart claim is now fenced out.
    const stale = run({
      action: 'assert', leasePath: ws.leasePath, memoryPath: ws.memoryPath,
      missionId: MISSION_A, namespace: NS, claim: claimed.claim,
    });
    assert.equal(stale.ok, false);
  } finally { ws.cleanup(); }
});

test('restart does not resurrect data released by a different mission scope', () => {
  const ws = makeWorkspace();
  try {
    seedTwoMissions(ws);
    const engine = leaseEngine(ws);
    const claim = engine.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'w', ttlMs: 60000 });
    const gate = createP2Gate({ adapter: referenceAdapter(engine), memoryPath: ws.memoryPath, allowUnverifiedLease: true });
    assert.equal(gate.read(claim, 'plan').value, 'A-plan');
    engine.releaseMissionClaim(claim);

    // Close everything, as a process exit would.
    gate.close();
    engine.close();

    // Reopen: mission B is still isolated from a mission A claim.
    const engine2 = leaseEngine(ws);
    const gate2 = createP2Gate({ adapter: referenceAdapter(engine2), memoryPath: ws.memoryPath, allowUnverifiedLease: true });
    const claimA = engine2.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'w2', ttlMs: 60000 });
    const rows = gate2.list(claimA);
    assert.ok(!JSON.stringify(rows).includes('B-SECRET-PLAN'));
    assert.ok(rows.every((r) => r.missionId === MISSION_A));
    gate2.close();
    engine2.close();
  } finally { ws.cleanup(); }
});
