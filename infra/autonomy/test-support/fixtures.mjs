// Shared fixtures for the P1/P2 test suite.
// Everything here builds REAL SQLite files in a real temp directory.

import { mkdtempSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMissionMemoryDatabase, seedMemory } from '../p1-memory-fixture.mjs';
import { createReferenceLeaseEngine } from './reference-lease-engine.mjs';
import { createFactoryLeaseAdapter } from '../p2-lease-interface.mjs';

export const MISSION_A = 'MISSION_A_DEMO';
export const MISSION_B = 'MISSION_B_OTHER';

export function makeWorkspace(prefix = 'wolf-p2-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    memoryPath: join(dir, 'p1-memory.db'),
    leasePath: join(dir, 'lease.db'),
    cleanup() {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

/**
 * Build a memory database with two missions in the same namespace, plus a
 * second namespace for mission A, so isolation can be tested in both directions.
 */
export function seedTwoMissions(ws, { fencingToken = 1 } = {}) {
  const db = createMissionMemoryDatabase(ws.memoryPath);
  seedMemory(db, {
    missionId: MISSION_A,
    namespace: 'core',
    entries: { plan: 'A-plan', budget: '0.00-EUR', 'note/1': 'alpha' },
    fencingToken,
  });
  seedMemory(db, {
    missionId: MISSION_A,
    namespace: 'handoff',
    entries: { cursor: 'A-cursor' },
    fencingToken,
  });
  seedMemory(db, {
    missionId: MISSION_B,
    namespace: 'core',
    entries: { plan: 'B-SECRET-PLAN', budget: '999.00-EUR' },
    fencingToken: 7,
  });
  db.close();
}

export function leaseEngine(ws, { clock } = {}) {
  // The engine clock and the gate clock must be the same clock, otherwise lease
  // expiry is evaluated against two different notions of "now".
  return createReferenceLeaseEngine({ path: ws.leasePath, ...(clock ? { clock } : {}) });
}

/** Adapter over the reference engine, explicitly marked unverified. */
export function referenceAdapter(engine) {
  return createFactoryLeaseAdapter({
    module: engine,
    sourceIdentity: {
      verified: false,
      state: 'REFERENCE_TEST_ENGINE',
      sha256: null,
      sourceCommit: null,
    },
  });
}

export const fsImpl = fs;
