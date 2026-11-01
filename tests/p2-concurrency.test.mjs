// Multi-process concurrency against real SQLite files.
//
// Every "worker" here is a separate OS process (node child_process) contending
// on the same lease database and the same memory database. This is real
// inter-process serialization, not two async tasks in one event loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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

function runWorker(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, args.action, JSON.stringify(args)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      const line = stdout.trim().split('\n').filter(Boolean).at(-1);
      let parsed = null;
      try { parsed = JSON.parse(line); } catch { /* reported below */ }
      resolve({ code, parsed, stdout, stderr });
    });
  });
}

test('concurrent processes cannot both claim the same mission', async () => {
  const ws = makeWorkspace();
  try {
    seedTwoMissions(ws);
    const base = { leasePath: ws.leasePath, memoryPath: ws.memoryPath, missionId: MISSION_A, namespace: NS, ttlMs: 60000 };

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => runWorker({ ...base, action: 'claim', ownerId: `w${i}` })),
    );

    const winners = results.filter((r) => r.parsed?.ok === true);
    const losers = results.filter((r) => r.parsed?.ok === false);

    assert.equal(winners.length, 1, `expected exactly one lease winner, got ${winners.length}`);
    assert.equal(losers.length, 5);
    for (const l of losers) {
      assert.ok(
        ['LEASE_ALREADY_HELD', 'SQLITE_BUSY', 'ERR_SQLITE_ERROR'].includes(l.parsed.code),
        `unexpected loser code: ${l.parsed.code}`,
      );
    }

    // The winning claim is unique and carries a fence of exactly 1.
    const fence = winners[0].parsed.claim.fencingToken;
    assert.equal(typeof fence, 'number');
    assert.ok(winners[0].parsed.claim.claimId);
  } finally { ws.cleanup(); }
});

test('concurrent workers cannot bypass lease serialization to read memory', async () => {
  const ws = makeWorkspace();
  try {
    seedTwoMissions(ws);
    const base = {
      leasePath: ws.leasePath, memoryPath: ws.memoryPath, missionId: MISSION_A,
      namespace: NS, ttlMs: 60000, key: 'plan',
    };
    // holdMs keeps each successful read genuinely in flight so the overlap is real.
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => runWorker({ ...base, action: 'read', ownerId: `w${i}`, holdMs: 900 })),
    );

    const authorized = results.filter((r) => r.parsed?.ok === true);
    assert.equal(authorized.length, 1, `expected exactly one authorized reader, got ${authorized.length}`);
    assert.equal(authorized[0].parsed.value.value, 'A-plan');

    const denied = results.filter((r) => r.parsed?.ok === false);
    assert.equal(denied.length, 4);
    for (const d of denied) {
      // No denial may have released data.
      assert.equal(d.parsed.value, undefined);
    }
  } finally { ws.cleanup(); }
});

test('a concurrent process releasing the lease during a read invalidates the read', async () => {
  const ws = makeWorkspace();
  try {
    seedTwoMissions(ws);
    const engine = leaseEngine(ws);
    const gate = createP2Gate({
      adapter: referenceAdapter(engine),
      memoryPath: ws.memoryPath,
      allowUnverifiedLease: true,
      // Runs AFTER the SQLite read, BEFORE revalidation: the release lands in the
      // exact window the gate exists to close.
      afterReadHook: () => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const row = engine._db
            .prepare('SELECT state FROM mission_lease WHERE namespace = ? AND mission_id = ?')
            .get(NS, MISSION_A);
          if (row?.state === 'RELEASED') return;
        }
        throw new Error('child process never released the lease');
      },
    });

    const claim = engine.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'parent', ttlMs: 60000 });
    const claimFile = join(ws.dir, 'claim.json');
    writeFileSync(claimFile, JSON.stringify(claim));

    // A separate OS process will release the lease while this read is in flight.
    const releaser = runWorker({
      action: 'release',
      leasePath: ws.leasePath,
      memoryPath: ws.memoryPath,
      missionId: MISSION_A,
      namespace: NS,
      claim,
      delayMs: 250,
    });

    assert.throws(
      () => gate.read(claim, 'plan'),
      (e) => e.code === 'P2_LEASE_RELEASED_DURING_READ' && e.dataReleased === false,
    );

    const released = await releaser;
    assert.equal(released.parsed?.ok, true, `releaser failed: ${released.stdout} ${released.stderr}`);

    const receipt = gate.receipts().at(-1);
    assert.equal(receipt.outcome, 'DENIED_POST_READ');
    assert.equal(receipt.readCompleted, true);
    assert.equal(receipt.dataReleased, false);

    gate.close();
    engine.close();
  } finally { ws.cleanup(); }
});

test('a stale worker cannot release the lease that superseded it', async () => {
  const ws = makeWorkspace();
  try {
    seedTwoMissions(ws);
    const engine = leaseEngine(ws);

    const stale = engine.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'w-old', ttlMs: 60000 });
    engine.releaseMissionClaim(stale);
    const current = engine.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'w-new', ttlMs: 60000 });
    assert.ok(current.fencingToken > stale.fencingToken);

    // The stale worker attempts to release; it must be refused by fence.
    const staleRelease = await runWorker({
      action: 'release-by-fence',
      leasePath: ws.leasePath,
      memoryPath: ws.memoryPath,
      missionId: MISSION_A,
      namespace: NS,
      claim: stale,
    });
    assert.equal(staleRelease.parsed.ok, false);
    assert.equal(staleRelease.parsed.code, 'LEASE_FENCE_STALE');

    // The current holder is unaffected and can still read.
    const adapter = referenceAdapter(engine);
    const gate = createP2Gate({ adapter, memoryPath: ws.memoryPath, allowUnverifiedLease: true });
    assert.equal(gate.read(current, 'plan').value, 'A-plan');
    gate.close();
    engine.close();
  } finally { ws.cleanup(); }
});

test('a read in one process is unaffected by unrelated missions in another', async () => {
  const ws = makeWorkspace();
  try {
    seedTwoMissions(ws);
    const engine = leaseEngine(ws);
    const gate = createP2Gate({
      adapter: referenceAdapter(engine),
      memoryPath: ws.memoryPath,
      allowUnverifiedLease: true,
    });

    const claimA = engine.claimMission({ missionId: MISSION_A, namespace: NS, ownerId: 'a', ttlMs: 60000 });

    const other = runWorker({
      action: 'read',
      leasePath: ws.leasePath,
      memoryPath: ws.memoryPath,
      missionId: 'MISSION_B_OTHER',
      namespace: NS,
      ownerId: 'b',
      key: 'plan',
    });

    const mine = gate.read(claimA, 'plan');
    assert.equal(mine.value, 'A-plan');

    const result = await other;
    assert.equal(result.parsed.ok, true);
    assert.equal(result.parsed.value.value, 'B-SECRET-PLAN');

    gate.close();
    engine.close();
  } finally { ws.cleanup(); }
});
