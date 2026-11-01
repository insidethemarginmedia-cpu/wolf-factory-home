/**
 * Durable memory checks against the Ruflo memory CLI.
 *
 * IMPORTANT SCOPE NOTE (see docs/ruflo-integration/TEST-RESULTS.md):
 *  - These tests exercise the `ruflo memory` CLI. In this sandbox the CLI runs
 *    on the sql.js (WASM) fallback because better-sqlite3 native bindings are
 *    not loaded; the CLI itself prints "persistence is not guaranteed".
 *  - No test here uses the RVF file format directly. RVF durability is NOT VERIFIED.
 *  - "Executor replacement" is simulated by a second process on the same host.
 *    That is not two distinct execution environments, so cross-executor
 *    recovery is NOT VERIFIED.
 *
 * Every assertion is strict. A failing assertion is a finding, not a skip.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const RUFLO_CLI = process.env.RUFLO_CLI
  ?? new URL('../node_modules/@claude-flow/cli/bin/cli.js', import.meta.url).pathname;
const EVIDENCE = new URL('../evidence/', import.meta.url);

/** Run the CLI; never throws. Returns { code, stdout, stderr, output }. */
function cli(args, env, timeout = 60000) {
  // Autostart of the Ruflo background daemon is disabled for every Wolf invocation.
  // cwd is the test's own temp root, so Ruflo's per-workspace state never lands in the repo.
  const e = { ...env, RUFLO_DAEMON_AUTOSTART: '0' };
  return new Promise((resolve) => {
    execFile('node', [RUFLO_CLI, 'memory', ...args], { env: e, cwd: root, timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout, stderr, output: stdout + stderr });
      });
  });
}

const stored = (r) => r.code === 0 && /Data stored|Property\s+│?\s*\|?\s*Value/.test(r.stdout) && /Key\s/.test(r.stdout);

let root;

describe('Ruflo memory durability (CLI, sql.js fallback)', { concurrency: false }, () => {
  let dbA;
  let envA;
  const backend = {};

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'wolf-mem-'));
    dbA = join(root, 'a', 'memory.db');
    await mkdir(join(root, 'a'), { recursive: true });
    envA = { ...process.env, CLAUDE_FLOW_DB_PATH: dbA };
    const init = await cli(['init', '--force'], envA);
    assert.strictEqual(init.code, 0, init.output);
  });

  after(async () => { await rm(root, { recursive: true, force: true }); });

  test('backend disclosure: which storage path is active', async () => {
    const r = await cli(['store', '-k', 'probe/1', '-v', 'probe', '-n', 'probe'], envA);
    backend.sqlJsFallbackWarning = /sql\.js/.test(r.output);
    backend.nativeBridgeActive = !backend.sqlJsFallbackWarning;
    backend.persistenceWarning = /persistence is not guaranteed/.test(r.output);
    backend.invalidPragmaSeen = /Invalid PRAGMA command/.test(r.output);
    assert.ok(stored(r), r.output);
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(new URL('memory-backend.json', EVIDENCE), JSON.stringify(backend, null, 2) + '\n');
  });

  test('1. durable write then read (same process boundary)', async () => {
    const w = await cli(['store', '-k', 'k1', '-v', 'value-one', '-n', 'ns1'], envA);
    assert.ok(stored(w), w.output);
    const r = await cli(['retrieve', '-k', 'k1', '-n', 'ns1', '--value-only'], envA);
    assert.strictEqual(r.stdout.trim(), 'value-one');
  });

  test('2. restart recovery: value survives after all prior processes exited', async () => {
    // Each cli() call is a fresh process; the earlier writer has exited.
    const r = await cli(['retrieve', '-k', 'k1', '-n', 'ns1', '--value-only'], envA);
    assert.strictEqual(r.stdout.trim(), 'value-one');
  });

  test('3. independent-file recovery: export from store A, import into store B (same host)', async () => {
    const exp = join(root, 'export-a.json');
    const e = await cli(['export', '-o', exp, '-f', 'json'], envA);
    assert.strictEqual(e.code, 0, e.output);
    const dbB = join(root, 'b', 'memory.db');
    await mkdir(join(root, 'b'), { recursive: true });
    const envB = { ...process.env, CLAUDE_FLOW_DB_PATH: dbB };
    assert.strictEqual((await cli(['init', '--force'], envB)).code, 0);
    const i = await cli(['import', '-i', exp], envB);
    assert.strictEqual(i.code, 0, i.output);
    const r = await cli(['retrieve', '-k', 'k1', '-n', 'ns1', '--value-only'], envB);
    assert.strictEqual(r.stdout.trim(), 'value-one');
  });

  test('4. interrupted write: a truncated store file is refused, not silently read', async () => {
    const dbC = join(root, 'c', 'memory.db');
    await mkdir(join(root, 'c'), { recursive: true });
    const envC = { ...process.env, CLAUDE_FLOW_DB_PATH: dbC };
    assert.strictEqual((await cli(['init', '--force'], envC)).code, 0);
    assert.strictEqual((await cli(['store', '-k', 'x', '-v', 'y', '-n', 'n'], envC)).code, 0);
    const bytes = await readFile(dbC);
    await writeFile(dbC, bytes.subarray(0, Math.floor(bytes.length / 2)));
    const r = await cli(['retrieve', '-k', 'x', '-n', 'n', '--value-only'], envC);
    assert.notStrictEqual(r.code, 0, 'truncated database must not return a value');
    assert.doesNotMatch(r.stdout, /^y$/m);
  });

  test('5. concurrent writers (3 processes x 5 writes): no lost writes', async () => {
    const dbD = join(root, 'd', 'memory.db');
    await mkdir(join(root, 'd'), { recursive: true });
    const envD = { ...process.env, CLAUDE_FLOW_DB_PATH: dbD };
    assert.strictEqual((await cli(['init', '--force'], envD)).code, 0);
    const jobs = [];
    for (let w = 0; w < 3; w++) {
      jobs.push((async () => {
        const results = [];
        for (let i = 0; i < 5; i++) {
          results.push(await cli(['store', '-k', `w${w}/k${i}`, '-v', `w${w}-${i}`, '-n', 'conc'], envD));
        }
        return results;
      })());
    }
    const all = (await Promise.all(jobs)).flat();
    const reported_ok = all.filter(stored).length;
    const list = await cli(['list', '-n', 'conc', '-l', '100', '--format', 'json'], envD);
    let persisted = 0;
    try { persisted = JSON.parse(list.stdout).length; } catch { persisted = -1; }
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(new URL('concurrency-result.json', EVIDENCE), JSON.stringify({
      attempted: 15, reportedSuccess: reported_ok, persisted,
    }, null, 2) + '\n');
    assert.strictEqual(persisted, 15, `expected 15 persisted, got ${persisted}; CLI reported ${reported_ok} successes`);
  });

  test('6. idempotent upsert: second write replaces, does not duplicate', async () => {
    assert.ok(stored(await cli(['store', '-k', 'idem', '-v', 'first', '-n', 'idem'], envA)));
    assert.ok(stored(await cli(['store', '-k', 'idem', '-v', 'second', '-n', 'idem', '--upsert'], envA)));
    const r = await cli(['retrieve', '-k', 'idem', '-n', 'idem', '--value-only'], envA);
    assert.strictEqual(r.stdout.trim(), 'second');
    const l = await cli(['list', '-n', 'idem', '--format', 'json'], envA);
    assert.strictEqual(JSON.parse(l.stdout).length, 1);
  });

  test('7. mission namespace isolation: same key in two namespaces stays separate', async () => {
    assert.ok(stored(await cli(['store', '-k', 'same', '-v', 'alpha', '-n', 'mission-alpha'], envA)));
    assert.ok(stored(await cli(['store', '-k', 'same', '-v', 'beta', '-n', 'mission-beta'], envA)));
    const a = await cli(['retrieve', '-k', 'same', '-n', 'mission-alpha', '--value-only'], envA);
    const b = await cli(['retrieve', '-k', 'same', '-n', 'mission-beta', '--value-only'], envA);
    assert.strictEqual(a.stdout.trim(), 'alpha');
    assert.strictEqual(b.stdout.trim(), 'beta');
  });

  test('8. corruption detection: garbage file is reported as an error', async () => {
    const dbE = join(root, 'e', 'memory.db');
    await mkdir(join(root, 'e'), { recursive: true });
    await writeFile(dbE, 'not a database at all');
    const r = await cli(['retrieve', '-k', 'x', '-n', 'n', '--value-only'], { ...process.env, CLAUDE_FLOW_DB_PATH: dbE });
    assert.notStrictEqual(r.code, 0);
    assert.match(r.output, /not a database|Failed|error/i);
  });

  test('9. snapshot/backup: export count matches store, import restores all entries', async () => {
    const dbF = join(root, 'f', 'memory.db');
    await mkdir(join(root, 'f'), { recursive: true });
    const envF = { ...process.env, CLAUDE_FLOW_DB_PATH: dbF };
    assert.strictEqual((await cli(['init', '--force'], envF)).code, 0);
    for (let i = 0; i < 5; i++) assert.ok(stored(await cli(['store', '-k', `s${i}`, '-v', `v${i}`, '-n', 'snap'], envF)));
    const snap = join(root, 'snap.json');
    assert.strictEqual((await cli(['export', '-o', snap, '-f', 'json'], envF)).code, 0);
    const data = JSON.parse(await readFile(snap, 'utf8'));
    assert.strictEqual(data.count, 5);
    const dbG = join(root, 'g', 'memory.db');
    await mkdir(join(root, 'g'), { recursive: true });
    const envG = { ...process.env, CLAUDE_FLOW_DB_PATH: dbG };
    assert.strictEqual((await cli(['init', '--force'], envG)).code, 0);
    assert.strictEqual((await cli(['import', '-i', snap], envG)).code, 0);
    const l = await cli(['list', '-n', 'snap', '-l', '50', '--format', 'json'], envG);
    assert.strictEqual(JSON.parse(l.stdout).length, 5);
  });

  test('10. schema compatibility: legacy-style write and read round-trip', async () => {
    // Provenance is written by the store path but is not returned by `retrieve`.
    // This test checks only the value round-trip; provenance exposure is a separate gap.
    assert.ok(stored(await cli(['store', '-k', 'p1', '-v', 'prov', '-n', 'schema', '--provenance', 'agent_output'], envA)));
    const r = await cli(['retrieve', '-k', 'p1', '-n', 'schema', '--value-only'], envA);
    assert.strictEqual(r.stdout.trim(), 'prov');
  });

  test('11. append-only (immutable) writes: require native writer, fail closed on fallback', async () => {
    const r = await cli(['store', '-k', 'ao', '-v', 'once', '-n', 'ao', '--append-only'], envA);
    // Expected on the sql.js fallback: refuse, do not silently downgrade.
    assert.notStrictEqual(r.code, 0, 'append-only must not silently succeed on fallback');
    assert.match(r.output, /native writer/);
  });
});
