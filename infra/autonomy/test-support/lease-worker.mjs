// ============================================================================
// TEST SUPPORT ONLY -- real subprocess entry point for concurrency tests.
//
// Runs one action in a *separate OS process* against the shared SQLite lease
// database and the shared P1 memory database, then prints a single JSON line on
// stdout. `node --test` drives this via child_process, so the concurrency
// proven by the gate tests is genuine inter-process contention on real files,
// not two async tasks in one event loop.
// ============================================================================

import { createReferenceLeaseEngine } from './reference-lease-engine.mjs';
import { createFactoryLeaseAdapter } from '../p2-lease-interface.mjs';
import { createP2Gate } from '../p2-gate.mjs';

function out(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function main() {
  const [, , action, argv] = process.argv;
  const args = JSON.parse(argv ?? '{}');
  const {
    leasePath,
    memoryPath,
    missionId,
    namespace = 'core',
    ownerId = 'worker',
    key,
    ttlMs,
    holdMs = 0,
  } = args;

  const engine = createReferenceLeaseEngine({ path: leasePath });
  const adapter = createFactoryLeaseAdapter({
    module: engine,
    sourceIdentity: { verified: false, state: 'REFERENCE_TEST_ENGINE', sha256: null, sourceCommit: null },
  });

  try {
    switch (action) {
      case 'claim': {
        const claim = engine.claimMission({ missionId, namespace, ownerId, ttlMs });
        out({ ok: true, action, claim });
        break;
      }

      case 'read': {
        // Take the lease, then read through the gate, honouring a hold window so
        // another process can race release/expiry against the read.
        const claim = engine.claimMission({ missionId, namespace, ownerId, ttlMs });
        const gate = createP2Gate({
          adapter,
          memoryPath,
          allowUnverifiedLease: true,
          afterReadHook: holdMs > 0 ? () => {
            const deadline = Date.now() + holdMs;
            // Busy-wait: this keeps the read genuinely in flight.
            while (Date.now() < deadline) { /* spin */ }
          } : null,
        });
        try {
          const value = gate.read(claim, key);
          gate.close();
          out({ ok: true, action, claim, value });
        } catch (error) {
          out({ ok: false, action, claim, code: error.code ?? 'UNKNOWN', message: error.message });
        }
        break;
      }

      case 'release': {
        const claim = args.claim;
        if (args.delayMs > 0) {
          const deadline = Date.now() + args.delayMs;
          while (Date.now() < deadline) { /* spin: keep this a real concurrent act */ }
        }
        engine.releaseMissionClaim(claim);
        out({ ok: true, action });
        break;
      }

      case 'assert': {
        // Verify a previously issued claim is still authoritative in THIS process.
        const result = engine.assertMissionClaim(args.claim);
        out({ ok: true, action, result });
        break;
      }

      case 'inspect': {
        const row = engine._db
          .prepare('SELECT * FROM mission_lease WHERE namespace = ? AND mission_id = ?')
          .get(namespace, missionId);
        out({ ok: true, action, row: row ?? null });
        break;
      }

      case 'release-by-fence': {
        // Attempt to release using a claim snapshot the caller supplies; used to
        // prove a stale worker cannot release the current lease.
        const claim = args.claim;
        engine.releaseMissionClaim(claim);
        out({ ok: true, action });
        break;
      }

      default:
        out({ ok: false, code: 'UNKNOWN_ACTION', action });
        process.exitCode = 2;
    }
  } catch (error) {
    out({ ok: false, code: error.code ?? 'ERROR', message: error.message, action });
    process.exitCode = 0;
  } finally {
    engine.close();
  }
}

main().catch((error) => {
  out({ ok: false, code: 'WORKER_CRASH', message: error.message });
  process.exitCode = 1;
});
