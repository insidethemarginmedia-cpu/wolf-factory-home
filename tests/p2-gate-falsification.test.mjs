// Falsification: prove the security tests fail when the protection is removed.
//
// A test suite that passes against a broken implementation proves nothing. Each
// test below builds a deliberately weakened variant of the gate and shows the
// attack SUCCEEDS against it, while the real gate in p2-gate-security.test.mjs
// denies the same attack. Do not delete these as "duplicates".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createP2Gate } from '../infra/autonomy/p2-gate.mjs';
import {
  makeWorkspace, seedTwoMissions, leaseEngine, referenceAdapter, MISSION_A,
} from '../infra/autonomy/test-support/fixtures.mjs';

const NS = 'core';

/**
 * The pre-fix shape of the gate: lease checked once before the read, data
 * returned without revalidation. This is the bug the real gate must not have.
 */
function naiveGate({ adapter, memoryPath }) {
  return {
    read(claim, key) {
      adapter.assertClaim(claim); // single check, before the read
      const reader = naiveReaders.openMissionMemory({ path: memoryPath });
      const row = reader.get({ missionId: claim.missionId, namespace: claim.namespace }, key);
      reader.close();
      // ...and straight back to the caller. No scope, no revalidation.
      return row;
    },
  };
}

import * as readerModule from '../infra/autonomy/p1-memory-reader.mjs';
const naiveReaders = readerModule;

test('FALSIFIED: a gate without post-read revalidation releases data after release', () => {
  const ws = makeWorkspace();
  try {
    seedTwoMissions(ws);
    const engine = leaseEngine(ws);
    const adapter = referenceAdapter(engine);
    const weak = naiveGate({ adapter, memoryPath: ws.memoryPath });

    const claim = engine.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'w', ttlMs: 60000 });

    // Simulate revocation landing between the pre-check and the return. In the
    // weak gate the release is invisible because nothing rechecks.
    const originalAssert = adapter.assertClaim;
    let calls = 0;
    const weakAdapter = {
      ...adapter,
      assertClaim: (c) => {
        const verdict = originalAssert(c); // the pre-check passes...
        calls += 1;
        if (calls === 1) engine.releaseMissionClaim(c); // ...and revocation lands immediately after
        return verdict;
      },
    };
    // The weak gate only calls assertClaim once, so the revocation is never seen.
    const weakWithRevoke = naiveGate({ adapter: weakAdapter, memoryPath: ws.memoryPath });
    const leaked = weakWithRevoke.read(claim, 'plan');

    assert.equal(calls, 1, 'the weak gate checks the lease exactly once');
    assert.equal(leaked.value, 'A-plan', 'the weak gate leaks data for a revoked lease');
    // ^ This is the vulnerability. The real gate must not behave this way.
  } finally { ws.cleanup(); }
});

test('PROTECTED: the real gate denies the same revocation sequence', () => {
  const ws = makeWorkspace();
  try {
    seedTwoMissions(ws);
    const engine = leaseEngine(ws);
    const adapter = referenceAdapter(engine);

    const gate = createP2Gate({
      adapter,
      memoryPath: ws.memoryPath,
      allowUnverifiedLease: true,
      afterReadHook: ({ claim }) => { engine.releaseMissionClaim(claim); },
    });

    const claim = engine.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'w', ttlMs: 60000 });
    assert.throws(
      () => gate.read(claim, 'plan'),
      (e) => e.code === 'P2_LEASE_RELEASED_DURING_READ' && e.dataReleased === false,
    );
    gate.close();
    engine.close();
  } finally { ws.cleanup(); }
});

test('FALSIFIED: a gate that trusts caller-supplied mission ids crosses namespaces', () => {
  const ws = makeWorkspace();
  try {
    seedTwoMissions(ws);
    const engine = leaseEngine(ws);
    const claim = engine.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'w', ttlMs: 60000 });

    const { openMissionMemory } = naiveReaders;
    const reader = openMissionMemory({ path: ws.memoryPath });
    // A weaker design would take the mission id from the request. That reads
    // mission B's secret with a mission A claim.
    const stolen = reader.get({ missionId: 'MISSION_B_OTHER', namespace: NS }, 'plan');
    assert.equal(stolen.value, 'B-SECRET-PLAN');
    reader.close();

    // The real gate derives the scope from the claim and cannot be steered.
    const gate = createP2Gate({ adapter: referenceAdapter(engine), memoryPath: ws.memoryPath, allowUnverifiedLease: true });
    const rows = gate.list(claim);
    assert.ok(!JSON.stringify(rows).includes('B-SECRET-PLAN'));
    gate.close();
    engine.close();
  } finally { ws.cleanup(); }
});
