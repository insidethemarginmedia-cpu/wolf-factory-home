// P1 memory reader — real SQLite, strictly read-only, fail-closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as fs from 'node:fs';
import { openMissionMemory } from '../infra/autonomy/p1-memory-reader.mjs';
import {
  createMissionMemoryDatabase,
  seedMemory,
  corruptDatabaseFile,
} from '../infra/autonomy/p1-memory-fixture.mjs';
import { makeWorkspace, seedTwoMissions, MISSION_A, MISSION_B } from '../infra/autonomy/test-support/fixtures.mjs';

const SCOPE_A = { missionId: MISSION_A, namespace: 'core' };

test('real SQLite reader returns committed values for the claimed mission', () => {
  const ws = makeWorkspace();
  try {
    seedTwoMissions(ws);
    const reader = openMissionMemory({ path: ws.memoryPath });
    const row = reader.get(SCOPE_A, 'plan');
    assert.equal(row.value, 'A-plan');
    assert.equal(row.missionId, MISSION_A);
    assert.equal(row.namespace, 'core');
    assert.match(row.valueSha256, /^[a-f0-9]{64}$/);
    assert.equal(row.valueSha256, row.valueSha256.toLowerCase());
    reader.close();
  } finally {
    ws.cleanup();
  }
});

test('mission namespace isolation: mission A can never read mission B memory', () => {
  const ws = makeWorkspace();
  try {
    seedTwoMissions(ws);
    const reader = openMissionMemory({ path: ws.memoryPath });

    // Same key, same namespace, different mission -> not visible.
    assert.equal(reader.get(SCOPE_A, 'plan').value, 'A-plan');
    assert.equal(reader.get({ missionId: MISSION_B, namespace: 'core' }, 'plan').value, 'B-SECRET-PLAN');

    const listA = reader.list(SCOPE_A);
    assert.deepEqual(listA.map((r) => r.key).sort(), ['budget', 'note/1', 'plan']);
    assert.ok(listA.every((r) => r.missionId === MISSION_A));
    assert.ok(!JSON.stringify(listA).includes('B-SECRET-PLAN'));

    // Namespace isolation within one mission.
    assert.deepEqual(reader.list({ missionId: MISSION_A, namespace: 'handoff' }).map((r) => r.key), ['cursor']);
    assert.equal(reader.get(SCOPE_A, 'cursor'), null);
    reader.close();
  } finally {
    ws.cleanup();
  }
});

test('reader is strictly read-only and refuses to write', () => {
  const ws = makeWorkspace();
  try {
    seedTwoMissions(ws);
    const reader = openMissionMemory({ path: ws.memoryPath });
    const proof = reader.proveReadOnly();
    assert.equal(proof.readOnly, true);
    assert.ok(['BEGIN_DENIED', 'WRITE_DENIED'].includes(proof.method), `unexpected proof: ${proof.method}`);
    reader.close();

    // The data is untouched after the probe.
    const again = openMissionMemory({ path: ws.memoryPath });
    assert.equal(again.stats().rows, 6);
    again.close();
  } finally {
    ws.cleanup();
  }
});

test('corrupted database fails closed instead of returning empty data', () => {
  const ws = makeWorkspace();
  try {
    const db = createMissionMemoryDatabase(ws.memoryPath);
    seedMemory(db, { missionId: MISSION_A, namespace: 'core', entries: { plan: 'A-plan' } });
    db.close();
    corruptDatabaseFile(ws.memoryPath, fs);

    let code = null;
    try {
      const reader = openMissionMemory({ path: ws.memoryPath });
      reader.get(SCOPE_A, 'plan');
    } catch (error) {
      code = error.code;
      assert.equal(error.dataReleased, false);
    }
    assert.equal(code, 'P2_MEMORY_CORRUPT');
  } finally {
    ws.cleanup();
  }
});

test('truncated database fails closed', () => {
  const ws = makeWorkspace();
  try {
    const db = createMissionMemoryDatabase(ws.memoryPath);
    seedMemory(db, { missionId: MISSION_A, namespace: 'core', entries: { plan: 'A-plan' } });
    db.close();
    fs.writeFileSync(ws.memoryPath, Buffer.alloc(100, 0));

    assert.throws(
      () => {
        const reader = openMissionMemory({ path: ws.memoryPath });
        reader.get(SCOPE_A, 'plan');
      },
      (error) => ['P2_MEMORY_CORRUPT', 'P2_MEMORY_UNAVAILABLE', 'P2_MEMORY_SCHEMA_DENIED'].includes(error.code),
    );
  } finally {
    ws.cleanup();
  }
});

test('absent database fails closed as unavailable, never as empty', () => {
  const ws = makeWorkspace();
  try {
    assert.throws(
      () => openMissionMemory({ path: join(ws.dir, 'does-not-exist.db') }),
      (error) => error.code === 'P2_MEMORY_UNAVAILABLE' && error.dataReleased === false,
    );
  } finally {
    ws.cleanup();
  }
});

test('schema drift is denied rather than tolerated', () => {
  const ws = makeWorkspace();
  try {
    // A database that parses but lacks the required column contract.
    const { DatabaseSync } = require_node_sqlite();
    const db = new DatabaseSync(ws.memoryPath);
    db.exec('CREATE TABLE mission_memory (mission_id TEXT, namespace TEXT, key TEXT, value TEXT)');
    db.prepare('INSERT INTO mission_memory VALUES (?,?,?,?)').run(MISSION_A, 'core', 'plan', 'A-plan');
    db.close();

    // Denied at open (eager integrity probe), not silently tolerated.
    assert.throws(
      () => openMissionMemory({ path: ws.memoryPath }),
      (error) => error.code === 'P2_MEMORY_SCHEMA_DENIED' && error.dataReleased === false,
    );
  } finally {
    ws.cleanup();
  }
});

test('wildcard and empty namespaces are refused', () => {
  const ws = makeWorkspace();
  try {
    seedTwoMissions(ws);
    const reader = openMissionMemory({ path: ws.memoryPath });
    for (const namespace of ['*', '%', '', '   ']) {
      assert.throws(() => reader.list({ missionId: MISSION_A, namespace }), (e) => e.code === 'P2_NAMESPACE_DENIED');
    }
    assert.throws(() => reader.list({ namespace: 'core' }), (e) => e.code === 'P2_NAMESPACE_DENIED');
    assert.throws(() => reader.list({ missionId: '   ', namespace: 'core' }), (e) => e.code === 'P2_NAMESPACE_DENIED');
    reader.close();
  } finally {
    ws.cleanup();
  }
});

test('closed reader refuses further reads', () => {
  const ws = makeWorkspace();
  try {
    seedTwoMissions(ws);
    const reader = openMissionMemory({ path: ws.memoryPath });
    reader.close();
    assert.throws(() => reader.get(SCOPE_A, 'plan'), (e) => e.code === 'P2_MEMORY_UNAVAILABLE');
    reader.close(); // idempotent
  } finally {
    ws.cleanup();
  }
});

test('a plain text file is not accepted as a memory database', () => {
  const ws = makeWorkspace();
  try {
    writeFileSync(ws.memoryPath, 'this is definitely not a sqlite database\n'.repeat(20));
    assert.throws(
      () => openMissionMemory({ path: ws.memoryPath }),
      (e) => ['P2_MEMORY_CORRUPT', 'P2_MEMORY_UNAVAILABLE'].includes(e.code),
    );
  } finally {
    ws.cleanup();
  }
});

// node:sqlite is ESM-only for import; wrap the dynamic require for the one test
// that needs to create a deliberately malformed schema.
function require_node_sqlite() {
  return { DatabaseSync: nodeSqliteDatabaseSync };
}
import { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
const nodeSqliteDatabaseSync = NodeDatabaseSync;
