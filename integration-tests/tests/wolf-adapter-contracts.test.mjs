/**
 * Wolf adapter contract tests. Each test is a fault-injection case with an
 * exact expected error code. Storage is a real file in a temp directory and
 * "restart" means constructing a new WolfMissionStore on the same path.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  WolfMissionStore, WolfContractError, acquireLease, idempotent,
  recordVerification, authorizePublication, admitEconomic,
  recordExternalEffect, reconcileExternalEffect,
} from '../adapter/wolf-adapter.mjs';

async function expectCode(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof WolfContractError, `expected WolfContractError, got ${e}`);
    assert.strictEqual(e.code, code);
    return true;
  });
}

describe('Wolf adapter contracts', { concurrency: false }, () => {
  let dir;
  let path;
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'wolf-adapter-')); path = join(dir, 'state.json'); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  test('lease: second owner is refused while lease is live', async () => {
    const s = new WolfMissionStore(path);
    await acquireLease(s, { missionId: 'M1', owner: 'worker-a', nowMs: 1000 });
    await expectCode(acquireLease(s, { missionId: 'M1', owner: 'worker-b', nowMs: 2000 }), 'LEASE_HELD');
  });

  test('lease: expired lease can be taken over and fence strictly increases', async () => {
    const s = new WolfMissionStore(path);
    const a = await acquireLease(s, { missionId: 'M2', owner: 'a', nowMs: 0, ttlMs: 10 });
    const b = await acquireLease(s, { missionId: 'M2', owner: 'b', nowMs: 1000, ttlMs: 10 });
    assert.ok(b.fence > a.fence, `fence ${a.fence} -> ${b.fence}`);
  });

  test('fencing: stale fence is rejected after takeover (restart in between)', async () => {
    const s1 = new WolfMissionStore(path);
    const old = await acquireLease(s1, { missionId: 'M3', owner: 'a', nowMs: 0, ttlMs: 10 });
    const s2 = new WolfMissionStore(path); // simulated restart / executor replacement
    const cur = await acquireLease(s2, { missionId: 'M3', owner: 'b', nowMs: 1000, ttlMs: 10 });
    await expectCode(idempotent(s2, { missionId: 'M3', fence: old.fence, key: 'k', operation: async () => 'x' }), 'STALE_FENCE');
    const ok = await idempotent(s2, { missionId: 'M3', fence: cur.fence, key: 'k', operation: async () => 'x' });
    assert.strictEqual(ok.replayed, false);
  });

  test('idempotency: duplicate key runs the operation once, replays stored result after restart', async () => {
    const s1 = new WolfMissionStore(path);
    const lease = await acquireLease(s1, { missionId: 'M4', owner: 'a' });
    let calls = 0;
    const op = async () => { calls++; return { commit: 'abc' }; };
    const first = await idempotent(s1, { missionId: 'M4', fence: lease.fence, key: 'push-1', operation: op });
    const s2 = new WolfMissionStore(path);
    const second = await idempotent(s2, { missionId: 'M4', fence: lease.fence, key: 'push-1', operation: op });
    assert.strictEqual(calls, 1);
    assert.strictEqual(second.replayed, true);
    assert.deepStrictEqual(second.result, first.result);
  });

  test('idempotency: failed operation is not recorded, so a retry may run', async () => {
    const s = new WolfMissionStore(path);
    const lease = await acquireLease(s, { missionId: 'M5', owner: 'a' });
    await assert.rejects(idempotent(s, { missionId: 'M5', fence: lease.fence, key: 'f', operation: async () => { throw new Error('boom'); } }), /boom/);
    const r = await idempotent(s, { missionId: 'M5', fence: lease.fence, key: 'f', operation: async () => 'ok' });
    assert.strictEqual(r.replayed, false);
  });

  test('verification: executor cannot verify its own work', async () => {
    const s = new WolfMissionStore(path);
    const lease = await acquireLease(s, { missionId: 'M6', owner: 'a' });
    await expectCode(recordVerification(s, { missionId: 'M6', fence: lease.fence, executorId: 'cezar', verifierId: 'cezar', commitSha: 'c1', verdict: 'PASS' }), 'VERIFIER_NOT_INDEPENDENT');
  });

  test('publication: refused without an independent PASS, allowed with one', async () => {
    const s = new WolfMissionStore(path);
    const lease = await acquireLease(s, { missionId: 'M7', owner: 'a' });
    await expectCode(authorizePublication(s, { missionId: 'M7', fence: lease.fence, commitSha: 'c2' }), 'NO_INDEPENDENT_PASS');
    await recordVerification(s, { missionId: 'M7', fence: lease.fence, executorId: 'cezar', verifierId: 'groq', commitSha: 'c2', verdict: 'PASS' });
    const r = await authorizePublication(s, { missionId: 'M7', fence: lease.fence, commitSha: 'c2' });
    assert.strictEqual(r.authorized, true);
  });

  test('publication: blocked by an unreconciled UNKNOWN external effect', async () => {
    const s = new WolfMissionStore(path);
    const lease = await acquireLease(s, { missionId: 'M8', owner: 'a' });
    await recordVerification(s, { missionId: 'M8', fence: lease.fence, executorId: 'cezar', verifierId: 'groq', commitSha: 'c3', verdict: 'PASS' });
    await recordExternalEffect(s, { effectId: 'E8', missionId: 'M8', fence: lease.fence });
    await expectCode(authorizePublication(s, { missionId: 'M8', fence: lease.fence, commitSha: 'c3' }), 'UNRECONCILED_EFFECT');
  });

  test('unknown effect: stays UNKNOWN without evidence; reconciled only by a matching receipt', async () => {
    const s = new WolfMissionStore(path);
    const e0 = await reconcileExternalEffect(s, { effectId: 'E8', evidence: null });
    assert.strictEqual(e0.status, 'UNKNOWN');
    const e1 = await reconcileExternalEffect(s, { effectId: 'E8', evidence: { kind: 'RECEIPT', effectId: 'OTHER' } });
    assert.strictEqual(e1.status, 'UNKNOWN', 'receipt for a different effect must not reconcile');
    const e2 = await reconcileExternalEffect(s, { effectId: 'E8', evidence: { kind: 'RECEIPT', effectId: 'E8', id: 'rcpt-1' } });
    assert.strictEqual(e2.status, 'CONFIRMED');
  });

  test('economic admission: zero-cost policy', () => {
    assert.deepStrictEqual(admitEconomic({ costUsd: 0 }), { admitted: true, reason: 'ZERO_COST' });
    assert.strictEqual(admitEconomic({ costUsd: undefined }).reason, 'COST_UNKNOWN=DENY');
    assert.strictEqual(admitEconomic({ costUsd: NaN }).reason, 'COST_UNKNOWN=DENY');
    assert.strictEqual(admitEconomic({ costUsd: 0.01 }).reason, 'EUR_SPEND=0');
    assert.strictEqual(admitEconomic({ costUsd: 0, paidFallback: true }).reason, 'PAID_FALLBACK=DENY');
    assert.strictEqual(admitEconomic({ costUsd: 0, trialCredit: true }).reason, 'TRIAL_CREDIT=DENY');
  });

  test('interrupted write: a leftover temp file never replaces the committed state', async () => {
    const s = new WolfMissionStore(path);
    const before = await readFile(path, 'utf8');
    await writeFile(`${path}.tmp-crashed-999`, '{ "version": 1, "missions": { TRUNC');
    const after = await readFile(path, 'utf8');
    assert.strictEqual(after, before);
    const doc = await new WolfMissionStore(path).load();
    assert.ok(doc.missions.M8);
    const files = await readdir(dir);
    assert.ok(files.includes('state.json'));
  });

  test('corruption detection: truncated committed file is refused, not reset', async () => {
    const cpath = join(dir, 'corrupt.json');
    await writeFile(cpath, '{ "version": 1, "missions": {');
    await expectCode(new WolfMissionStore(cpath).load(), 'STORE_CORRUPT');
  });

  test('schema compatibility: unknown version is refused', async () => {
    const vpath = join(dir, 'v2.json');
    await writeFile(vpath, JSON.stringify({ version: 2, missions: {} }));
    await expectCode(new WolfMissionStore(vpath).load(), 'SCHEMA_VERSION_UNSUPPORTED');
  });

  test('concurrency: 3 OS processes x 5 locked writes -> 15 durable entries, no lost updates', async () => {
    const cpath = join(dir, 'concurrent.json');
    const writer = fileURLToPath(new URL('./fixtures/adapter-writer.mjs', import.meta.url));
    const runs = ['p0', 'p1', 'p2'].map((prefix) => new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [writer, cpath, prefix, '5'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      c.stderr.on('data', (d) => { err += d; });
      c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${prefix} exit ${code}: ${err}`))));
    }));
    await Promise.all(runs);
    const doc = await new WolfMissionStore(cpath).load();
    assert.strictEqual(Object.keys(doc.idempotent).length, 15);
  });

  test('authority: adapter has no scheduler, timer or loop', () => {
    const src = readFileSync(new URL('../adapter/wolf-adapter.mjs', import.meta.url), 'utf8');
    for (const banned of ['setInterval', 'node:timers', 'cron', 'child_process', 'fetch(', 'node:http', 'node:net']) {
      assert.ok(!src.includes(banned), `forbidden token in adapter: ${banned}`);
    }
    // The only permitted timer is the bounded lock-acquisition backoff.
    assert.strictEqual(src.split('setTimeout').length - 1, 1, 'setTimeout allowed only in lock backoff');
  });
});
