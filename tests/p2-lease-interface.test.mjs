// Lease module provenance: digest pinning, shape validation, fail-closed wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  verifyLeaseModuleSource,
  verifyLeaseModuleShape,
  createFactoryLeaseAdapter,
  classifyLeaseFailure,
  sha256OfFile,
  CANONICAL_LEASE_SOURCE,
  CANONICAL_LEASE_PIN,
} from '../infra/autonomy/p2-lease-interface.mjs';
import { createP2Gate } from '../infra/autonomy/p2-gate.mjs';
import { makeWorkspace, seedTwoMissions, leaseEngine, referenceAdapter } from '../infra/autonomy/test-support/fixtures.mjs';

test('canonical lease pin is currently unretrieved and therefore unusable', () => {
  // Honesty guard: if a future session pins a digest, this test must be updated
  // deliberately rather than silently. Until then the pin proves nothing.
  assert.equal(CANONICAL_LEASE_PIN.sha256, null);
  assert.equal(CANONICAL_LEASE_PIN.retrievalMethod, 'UNRETRIEVED');
  assert.equal(CANONICAL_LEASE_SOURCE.path, 'infra/autonomy/mission-lease.mjs');
  assert.deepEqual([...CANONICAL_LEASE_SOURCE.requiredExports], [
    'claimMission',
    'assertMissionClaim',
    'releaseMissionClaim',
    'withMissionClaimWriteAuthority',
  ]);
});

test('source verification reports the true digest and never invents a match', () => {
  const ws = makeWorkspace();
  try {
    const file = join(ws.dir, 'lease.mjs');
    writeFileSync(file, 'export const claimMission = () => {};\n');
    const actual = sha256OfFile(file);

    const good = verifyLeaseModuleSource({ filePath: file, expectedSha256: actual });
    assert.equal(good.verified, true);
    assert.equal(good.state, 'LEASE_SOURCE_VERIFIED');

    const bad = verifyLeaseModuleSource({ filePath: file, expectedSha256: 'a'.repeat(64) });
    assert.equal(bad.verified, false);
    assert.equal(bad.state, 'LEASE_SOURCE_DIGEST_MISMATCH');

    const unpinned = verifyLeaseModuleSource({ filePath: file });
    assert.equal(unpinned.verified, false);
    assert.equal(unpinned.state, 'LEASE_SOURCE_UNPINNED');
    assert.equal(unpinned.sha256, actual); // digest reported so it can be pinned

    assert.equal(verifyLeaseModuleSource({}).state, 'LEASE_SOURCE_NOT_PROVIDED');
    assert.equal(verifyLeaseModuleSource({ filePath: join(ws.dir, 'nope.mjs'), expectedSha256: 'a'.repeat(64) }).state, 'LEASE_SOURCE_UNREADABLE');
  } finally {
    ws.cleanup();
  }
});

test('digest verification survives a byte-level tamper', () => {
  const ws = makeWorkspace();
  try {
    const file = join(ws.dir, 'lease.mjs');
    writeFileSync(file, 'export function claimMission(){return 1}\n'.repeat(4));
    const pinned = sha256OfFile(file);
    copyFileSync(file, join(ws.dir, 'orig.mjs'));
    writeFileSync(file, `${'export function claimMission(){return 1}\n'.repeat(4)}// injected\n`);
    const result = verifyLeaseModuleSource({ filePath: file, expectedSha256: pinned });
    assert.equal(result.verified, false);
    assert.equal(result.state, 'LEASE_SOURCE_DIGEST_MISMATCH');
  } finally {
    ws.cleanup();
  }
});

test('module shape must expose all four canonical exports as functions', () => {
  const full = {
    claimMission() {}, assertMissionClaim() {}, releaseMissionClaim() {}, withMissionClaimWriteAuthority() {},
  };
  assert.equal(verifyLeaseModuleShape(full), true);

  for (const missing of CANONICAL_LEASE_SOURCE.requiredExports) {
    const partial = { ...full };
    delete partial[missing];
    assert.throws(() => verifyLeaseModuleShape(partial), (e) => e.code === 'P2_LEASE_MODULE_UNVERIFIED');
  }

  const notCallable = { ...full, claimMission: 'not a function' };
  assert.throws(() => verifyLeaseModuleShape(notCallable), (e) => e.code === 'P2_LEASE_MODULE_UNVERIFIED');
  assert.throws(() => verifyLeaseModuleShape({}), (e) => e.code === 'P2_LEASE_MODULE_UNVERIFIED');
});

test('gate refuses an unverified lease module unless explicitly overridden', () => {
  const ws = makeWorkspace();
  try {
    seedTwoMissions(ws);
    const engine = leaseEngine(ws);
    const adapter = referenceAdapter(engine);

    // Default: refuse. This is what keeps a rehearsal out of production.
    assert.throws(
      () => createP2Gate({ adapter, memoryPath: ws.memoryPath }),
      (e) => e.code === 'P2_LEASE_MODULE_UNVERIFIED',
    );

    // Even an attestation-shaped object with verified:false is refused.
    const pseudo = createFactoryLeaseAdapter({
      module: engine,
      sourceIdentity: { verified: false, state: 'CANONICAL_NOT_REACHABLE' },
    });
    assert.throws(
      () => createP2Gate({ adapter: pseudo, memoryPath: ws.memoryPath }),
      (e) => e.code === 'P2_LEASE_MODULE_UNVERIFIED',
    );

    // Explicit opt-in is recorded, so the receipt cannot be mistaken for real.
    const gate = createP2Gate({ adapter, memoryPath: ws.memoryPath, allowUnverifiedLease: true });
    assert.equal(gate.identity.allowUnverifiedLease, true);
    assert.equal(gate.identity.lease.verified, false);
    assert.equal(gate.identity.lease.mode, 'UNVERIFIED_INTERFACE_ONLY');
    gate.close();
    engine.close();
  } finally {
    ws.cleanup();
  }
});

test('a verified adapter is required for the normal path and is recorded as such', () => {
  const ws = makeWorkspace();
  try {
    seedTwoMissions(ws);
    const engine = leaseEngine(ws);
    const adapter = createFactoryLeaseAdapter({
      module: engine,
      sourceIdentity: { verified: true, state: 'LEASE_SOURCE_VERIFIED', sha256: 'b'.repeat(64), sourceCommit: 'c'.repeat(40) },
    });
    const gate = createP2Gate({ adapter, memoryPath: ws.memoryPath });
    const claim = engine.claimMission({ missionId: 'MISSION_A_DEMO', namespace: 'core', ownerId: 'w1' });
    assert.equal(gate.read(claim, 'plan').value, 'A-plan');
    const receipt = gate.receipts().at(-1);
    assert.equal(receipt.leaseMode, 'CANONICAL_VERIFIED');
    assert.equal(receipt.leaseVerified, true);
    assert.equal(receipt.leaseSha256, 'b'.repeat(64));
    assert.equal(receipt.leaseSourceCommit, 'c'.repeat(40));
    gate.close();
    engine.close();
  } finally {
    ws.cleanup();
  }
});

test('lease failures are classified and unrecognised failures fail closed', () => {
  const mk = (code, message) => Object.assign(new Error(message), { code });
  assert.equal(classifyLeaseFailure(mk('X', 'lease expired at t')), 'P2_LEASE_EXPIRED');
  assert.equal(classifyLeaseFailure(mk('X', 'claim was released')), 'P2_LEASE_RELEASED');
  assert.equal(classifyLeaseFailure(mk('X', 'stale fencing token')), 'P2_FENCE_STALE');
  assert.equal(classifyLeaseFailure(mk('X', 'mission mismatch')), 'P2_LEASE_MISSION_MISMATCH');
  assert.equal(classifyLeaseFailure(mk('X', 'claim not held')), 'P2_LEASE_NOT_HELD');
  // Anything unrecognised must not become "permitted".
  assert.equal(classifyLeaseFailure(mk('X', 'something totally unexpected')), 'P2_LEASE_CLAIM_INVALID');
  assert.equal(classifyLeaseFailure(new Error('no code at all')), 'P2_LEASE_CLAIM_INVALID');
});

test('an async write-authority scope is rejected rather than awaited', () => {
  const ws = makeWorkspace();
  try {
    seedTwoMissions(ws);
    const asyncModule = {
      claimMission: () => ({ claimId: 'c', missionId: 'M', namespace: 'core', fencingToken: 1 }),
      assertMissionClaim: () => ({ valid: true }),
      releaseMissionClaim: () => ({ released: true }),
      withMissionClaimWriteAuthority: async (claim, fn) => fn({ claim }),
    };
    const adapter = createFactoryLeaseAdapter({
      module: asyncModule,
      sourceIdentity: { verified: true, sha256: 'd'.repeat(64) },
    });
    const gate = createP2Gate({ adapter, memoryPath: ws.memoryPath });
    assert.throws(
      () => gate.read(asyncModule.claimMission(), 'plan'),
      (e) => e.code === 'P2_GATE_CONFIGURATION_DENIED',
    );
    gate.close();
  } finally {
    ws.cleanup();
  }
});

test('a write-authority scope that never runs the callback is denied', () => {
  const ws = makeWorkspace();
  try {
    seedTwoMissions(ws);
    const module = {
      claimMission: () => ({ claimId: 'c', missionId: 'M', namespace: 'core', fencingToken: 1 }),
      assertMissionClaim: () => ({ valid: true }),
      releaseMissionClaim: () => ({ released: true }),
      withMissionClaimWriteAuthority: () => undefined, // silently skips
    };
    const adapter = createFactoryLeaseAdapter({ module, sourceIdentity: { verified: true, sha256: 'e'.repeat(64) } });
    const gate = createP2Gate({ adapter, memoryPath: ws.memoryPath });
    assert.throws(() => gate.read(module.claimMission(), 'plan'), (e) => e.code === 'P2_GATE_NOT_IN_CLAIM_SCOPE');
    gate.close();
  } finally {
    ws.cleanup();
  }
});
