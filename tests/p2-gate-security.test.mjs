// P2 authorization gate — security behaviour.
//
// Every test here uses a REAL SQLite memory database and a REAL lease engine
// over its own SQLite file. The lease engine is the reference test double
// (see infra/autonomy/test-support/reference-lease-engine.mjs), NOT the private
// Factory implementation -- that distinction is asserted explicitly at the end
// of this file so the suite cannot be mistaken for production acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createP2Gate, deriveScope } from '../infra/autonomy/p2-gate.mjs';
import {
  makeWorkspace,
  seedTwoMissions,
  leaseEngine,
  referenceAdapter,
  MISSION_A,
  MISSION_B,
} from '../infra/autonomy/test-support/fixtures.mjs';

const NS = 'core';

function setup({ clock, afterReadHook } = {}) {
  const ws = makeWorkspace();
  seedTwoMissions(ws);
  const engine = leaseEngine(ws, { clock });
  const adapter = referenceAdapter(engine);
  const gate = createP2Gate({
    adapter,
    memoryPath: ws.memoryPath,
    allowUnverifiedLease: true,
    ...(clock ? { clock } : {}),
    ...(afterReadHook ? { afterReadHook } : {}),
  });
  return { ws, engine, gate, teardown() { gate.close(); engine.close(); ws.cleanup(); } };
}

test('valid mission reads authorized data through the full P2 path', () => {
  const ctx = setup();
  try {
    const claim = ctx.engine.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'w1' });
    const row = ctx.gate.read(claim, 'plan');
    assert.equal(row.value, 'A-plan');
    assert.equal(row.missionId, MISSION_A);
    const receipt = ctx.gate.receipts().at(-1);
    assert.equal(receipt.outcome, 'AUTHORIZED');
    assert.equal(receipt.dataReleased, true);
    assert.equal(receipt.readCompleted, true);
    assert.equal(receipt.leaseMode, 'UNVERIFIED_INTERFACE_ONLY');
  } finally { ctx.teardown(); }
});

test('released lease prevents reading', () => {
  const ctx = setup();
  try {
    const claim = ctx.engine.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'w1' });
    assert.equal(ctx.gate.read(claim, 'plan').value, 'A-plan');
    ctx.engine.releaseMissionClaim(claim);
    assert.throws(
      () => ctx.gate.read(claim, 'plan'),
      (e) => e.code === 'P2_LEASE_RELEASED' && e.dataReleased === false,
    );
    const receipt = ctx.gate.receipts().at(-1);
    assert.equal(receipt.outcome, 'DENIED_PRE_READ');
    assert.equal(receipt.dataReleased, false);
  } finally { ctx.teardown(); }
});

test('expired lease prevents reading', () => {
  let now = 1_800_000_000_000;
  const ctx = setup({ clock: () => now });
  try {
    const claim = ctx.engine.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'w1', ttlMs: 1000 });
    assert.equal(ctx.gate.read(claim, 'plan').value, 'A-plan');
    now += 5000; // lease lifetime elapses
    assert.throws(
      () => ctx.gate.read(claim, 'plan'),
      (e) => e.code === 'P2_LEASE_EXPIRED' && e.dataReleased === false,
    );
  } finally { ctx.teardown(); }
});

test('stale fencing token prevents reading', () => {
  const ctx = setup();
  try {
    const stale = ctx.engine.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'w1' });
    // A newer claim supersedes it, advancing the fence.
    ctx.engine.releaseMissionClaim(stale);
    const fresh = ctx.engine.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'w2' });
    assert.ok(fresh.fencingToken > stale.fencingToken);

    assert.throws(
      () => ctx.gate.read(stale, 'plan'),
      (e) => ['P2_LEASE_RELEASED', 'P2_FENCE_STALE', 'P2_LEASE_CLAIM_INVALID'].includes(e.code) && e.dataReleased === false,
    );
    // The current holder can still read.
    assert.equal(ctx.gate.read(fresh, 'plan').value, 'A-plan');
  } finally { ctx.teardown(); }
});

test('a forged claim with an inflated fence is rejected', () => {
  const ctx = setup();
  try {
    const claim = ctx.engine.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'w1' });
    const forged = { ...claim, fencingToken: claim.fencingToken + 5 };
    assert.throws(() => ctx.gate.read(forged, 'plan'), (e) => e.dataReleased === false);
    const forgedMission = { ...claim, missionId: MISSION_B };
    assert.throws(() => ctx.gate.read(forgedMission, 'plan'), (e) => e.dataReleased === false);
  } finally { ctx.teardown(); }
});

test('lease released during a read yields no data', () => {
  let ctx;
  ctx = setup({
    afterReadHook: () => {
      // The read has already completed; the lease is revoked before release.
      ctx.engine.releaseMissionClaim(ctx.__claim);
    },
  });
  try {
    const claim = ctx.engine.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'w1' });
    ctx.__claim = claim;
    assert.throws(
      () => ctx.gate.read(claim, 'plan'),
      (e) => e.code === 'P2_LEASE_RELEASED_DURING_READ' && e.dataReleased === false,
    );
    const receipt = ctx.gate.receipts().at(-1);
    assert.equal(receipt.outcome, 'DENIED_POST_READ');
    assert.equal(receipt.readCompleted, true);
    assert.equal(receipt.dataReleased, false);
  } finally { ctx.teardown(); }
});

test('lease expiring during a read yields no data', () => {
  let now = 1_800_000_000_000;
  let ctx;
  ctx = setup({
    clock: () => now,
    afterReadHook: () => { now += 10_000; }, // time passes mid-read
  });
  try {
    const claim = ctx.engine.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'w1', ttlMs: 2000 });
    assert.throws(
      () => ctx.gate.read(claim, 'plan'),
      (e) => e.code === 'P2_LEASE_EXPIRED_DURING_READ' && e.dataReleased === false,
    );
  } finally { ctx.teardown(); }
});

test('wrong mission namespace is rejected', () => {
  const ctx = setup();
  try {
    const claim = ctx.engine.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'w1' });

    // Ask for a namespace the claim does not own.
    assert.throws(
      () => ctx.gate.read(claim, 'plan', { requestedNamespace: 'handoff' }),
      (e) => e.code === 'P2_NAMESPACE_MISMATCH',
    );

    // Deriving a scope for another mission from this claim is refused.
    assert.throws(() => deriveScope({ ...claim, missionId: '' }), (e) => e.code === 'P2_NAMESPACE_DENIED');
    assert.throws(() => deriveScope({ claimId: 'x', namespace: 'core' }), (e) => e.code === 'P2_NAMESPACE_DENIED');

    // The claimed namespace still works.
    assert.equal(ctx.gate.read(claim, 'plan').value, 'A-plan');
  } finally { ctx.teardown(); }
});

test('mission B memory is unreachable with a mission A claim', () => {
  const ctx = setup();
  try {
    const claim = ctx.engine.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'w1' });
    const rows = ctx.gate.list(claim);
    assert.ok(!JSON.stringify(rows).includes('B-SECRET-PLAN'));
    assert.ok(rows.every((r) => r.missionId === MISSION_A));
    // No key of mission B is reachable.
    assert.equal(ctx.gate.read(claim, 'plan').value, 'A-plan');
  } finally { ctx.teardown(); }
});

test('SQLite reader exception denies and releases nothing', () => {
  const ws = makeWorkspace();
  seedTwoMissions(ws);
  const engine = leaseEngine(ws);
  const gate = createP2Gate({
    adapter: referenceAdapter(engine),
    memoryPath: ws.memoryPath,
    allowUnverifiedLease: true,
    readerFactory: () => ({
      get() { const e = new Error('disk I/O error'); e.code = 'P2_MEMORY_READ_FAILED'; throw e; },
      list() { throw new Error('unreachable'); },
      stats() { return { rows: 0 }; },
      close() {},
    }),
  });
  try {
    const claim = engine.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'w1' });
    assert.throws(() => gate.read(claim, 'plan'), (e) => e.code === 'P2_MEMORY_READ_FAILED');
    // No AUTHORIZED receipt may exist for a failed read.
    assert.ok(gate.receipts().every((r) => r.outcome !== 'AUTHORIZED'));
  } finally { gate.close(); engine.close(); ws.cleanup(); }
});

test('corrupted memory database denies through the gate', () => {
  const ws = makeWorkspace();
  seedTwoMissions(ws);
  const fs = require_fs();
  const { corruptDatabaseFile } = require_fixture();
  corruptDatabaseFile(ws.memoryPath, fs);

  const engine = leaseEngine(ws);
  const gate = createP2Gate({
    adapter: referenceAdapter(engine),
    memoryPath: ws.memoryPath,
    allowUnverifiedLease: true,
  });
  try {
    const claim = engine.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'w1' });
    assert.throws(
      () => gate.read(claim, 'plan'),
      (e) => e.code === 'P2_MEMORY_CORRUPT' && e.dataReleased === false,
    );
  } finally { gate.close(); engine.close(); ws.cleanup(); }
});

test('gate denies construction without an adapter or memory path', () => {
  assert.throws(() => createP2Gate({}), (e) => e.code === 'P2_GATE_CONFIGURATION_DENIED');
  assert.throws(() => createP2Gate({ adapter: {}, memoryPath: '/tmp/x' }), (e) => e.code === 'P2_GATE_CONFIGURATION_DENIED');
  assert.throws(
    () => createP2Gate({ adapter: { assertClaim() {}, withWriteAuthority() {}, identity: { verified: true } } }),
    (e) => e.code === 'P2_GATE_CONFIGURATION_DENIED',
  );
});

test('admission policy is enforced from within the gate', () => {
  const ctx = setup();
  try {
    assert.equal(ctx.gate.admit({ worker: 'opencode', provider: 'ollama', cost: { amount: 0, currency: 'EUR' } }).admitted, true);
    assert.throws(() => ctx.gate.admit({ worker: 'jules', provider: 'ollama', cost: { amount: 0, currency: 'EUR' } }), (e) => e.code === 'P2_JULES_PROHIBITED');
    assert.throws(() => ctx.gate.admit({ worker: 'opencode', provider: 'ollama' }), (e) => e.code === 'P2_COST_UNKNOWN_DENIED');
  } finally { ctx.teardown(); }
});

test('receipts are append-only and carry no data payloads', () => {
  const ctx = setup();
  try {
    const claim = ctx.engine.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'w1' });
    ctx.gate.read(claim, 'plan');
    ctx.gate.read(claim, 'budget');
    const receipts = ctx.gate.receipts();
    assert.equal(receipts.length, 2);
    const serialized = JSON.stringify(receipts);
    assert.ok(!serialized.includes('A-plan'));
    assert.ok(!serialized.includes('0.00-EUR'));
    for (const r of receipts) {
      assert.ok(['AUTHORIZED', 'DENIED_PRE_READ', 'DENIED_POST_READ'].includes(r.outcome));
    }
  } finally { ctx.teardown(); }
});

test('PROVENANCE: this suite exercises the reference engine, not the private Factory lease', () => {
  const ctx = setup();
  try {
    const claim = ctx.engine.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'w1' });
    ctx.gate.read(claim, 'plan');
    const receipt = ctx.gate.receipts().at(-1);
    // The receipt must never claim canonical provenance.
    assert.equal(receipt.leaseMode, 'UNVERIFIED_INTERFACE_ONLY');
    assert.equal(receipt.leaseVerified, false);
    assert.equal(receipt.leaseSha256, null);
    assert.equal(ctx.gate.identity.allowUnverifiedLease, true);
  } finally { ctx.teardown(); }
});

// Local helpers to keep the ESM imports at the top tidy.
import * as nodeFs from 'node:fs';
const require_fs = () => nodeFs;
import { corruptDatabaseFile as corruptFixture } from '../infra/autonomy/p1-memory-fixture.mjs';
const require_fixture = () => ({ corruptDatabaseFile: corruptFixture });
