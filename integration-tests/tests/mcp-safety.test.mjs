/**
 * MCP safety tests for the Ruflo CLI MCP server (stdio mode).
 *
 * Each test spawns a fresh server process with autostart-related daemon
 * behaviour explicitly disabled by environment, and checks observable
 * facts only (process tree, /proc fd table, stdout/stderr, exit codes).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { readdirSync, readlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const RUFLO_CLI = process.env.RUFLO_CLI
  ?? new URL('../node_modules/@claude-flow/cli/bin/cli.js', import.meta.url).pathname;
const SENTINEL_SECRET = 'wolf-sentinel-secret-7f3a9c';
const EXPECTED_TOOLS = ['agent_list', 'agent_spawn', 'agent_status', 'memory_store', 'memory_retrieve'];
// Wolf-proposed minimal MCP surface. Source of truth for 5b-5d; edit deliberately.
const ALLOWLIST_PATH = new URL('../adapter/wolf-mcp-allowlist.json', import.meta.url).pathname;
const PROXY_PATH = new URL('../adapter/mcp-allowlist-proxy.mjs', import.meta.url).pathname;
const WOLF_ALLOWLIST = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')).tools;

/** Start a stdio MCP server. Resolves once it has answered initialize. */
async function startServer({ cwd, env = {}, proxy = false } = {}) {
  const args = proxy ? [PROXY_PATH, RUFLO_CLI, ALLOWLIST_PATH] : [RUFLO_CLI, 'mcp', 'start'];
  const proc = spawn('node', args, {
    cwd,
    env: { ...process.env, CLAUDE_FLOW_DB_PATH: join(cwd, 'memory.db'), RUFLO_DAEMON_AUTOSTART: '0', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stderrBuf = '';
  proc.stdoutBuf = '';
  proc.stderr.on('data', (d) => { proc.stderrBuf += d; });
  proc.pending = new Map();
  let buf = '';
  proc.stdout.on('data', (d) => {
    proc.stdoutBuf += d;
    buf += d;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const waiter = proc.pending.get(msg.id);
        if (waiter) { proc.pending.delete(msg.id); waiter(msg); }
      } catch { /* non-JSON line: recorded in stdoutBuf */ }
    }
  });
  proc.exited = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })));
  proc.nextId = 1;
  await request(proc, 'initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'wolf-test', version: '1.0' },
  });
  return proc;
}

function request(proc, method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const id = proc.nextId++;
    const timer = setTimeout(() => {
      proc.pending.delete(id);
      reject(new Error(`MCP ${method} timed out`));
    }, timeoutMs);
    proc.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function stop(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return proc.exited;
  proc.stdin.end();
  const timer = setTimeout(() => proc.kill('SIGKILL'), 5000);
  const res = await proc.exited;
  clearTimeout(timer);
  return res;
}

function childPids(pid) {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n').filter(Boolean).map(Number);
  } catch { return []; } // pgrep exits 1 when there are no children
}

/** Socket inodes held by a process, from /proc/<pid>/fd. */
function socketFds(pid) {
  const out = [];
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        if (target.startsWith('socket:')) out.push(target);
      } catch { /* fd closed meanwhile */ }
    }
  } catch { /* process gone */ }
  return out;
}


/** Detached `ruflo daemon start` processes bound to a workspace (survive parent exit). */
function daemonsFor(workspace) {
  try {
    return execFileSync('pgrep', ['-f', `daemon start.*${workspace}`], { encoding: 'utf8' })
      .split('\n').filter(Boolean).map(Number);
  } catch { return []; }
}

function runCli(args, env, cwd) {
  return new Promise((resolve) => {
    execFile('node', [RUFLO_CLI, ...args], { cwd, env, timeout: 60000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }));
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const toolText = (msg) => msg.result?.content?.[0]?.text ?? '';

describe('MCP safety (Ruflo stdio server)', { concurrency: false }, () => {
  let dir;
  test('setup scratch directory', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wolf-mcp-'));
    assert.ok(existsSync(RUFLO_CLI), `Ruflo CLI missing at ${RUFLO_CLI}`);
  });

  test('1. startup answers initialize and shutdown on stdin close exits 0', async () => {
    const proc = await startServer({ cwd: dir });
    const init = await request(proc, 'tools/list');
    assert.ok(init.result.tools.length > 0);
    const { code, signal } = await stop(proc);
    assert.strictEqual(code, 0, `exit code ${code}, signal ${signal}`);
  });

  test('2. SIGTERM terminates the server (controlled termination)', async () => {
    const proc = await startServer({ cwd: dir });
    proc.kill('SIGTERM');
    const { code, signal } = await proc.exited;
    assert.ok(code === 0 || signal === 'SIGTERM', `code=${code} signal=${signal}`);
  });

  test('3. no child processes are spawned by the server', async () => {
    const proc = await startServer({ cwd: dir });
    await request(proc, 'tools/list');
    assert.deepStrictEqual(childPids(proc.pid), []);
    await stop(proc);
  });

  test('4. no listening TCP sockets in stdio mode', async () => {
    const proc = await startServer({ cwd: dir });
    await request(proc, 'tools/list');
    const sockets = socketFds(proc.pid);
    // stdio transport must not hold listening sockets. Map socket inodes to LISTEN state.
    const listening = [];
    const tcp = execFileSync('cat', ['/proc/net/tcp', '/proc/net/tcp6'], { encoding: 'utf8' });
    const inodes = new Set(sockets.map((s) => s.replace(/^socket:\[(\d+)\]$/, '$1')));
    for (const line of tcp.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length > 9 && cols[3] === '0A' && inodes.has(cols[9])) listening.push(line);
    }
    assert.deepStrictEqual(listening, []);
    await stop(proc);
  });

  test('5a. default start advertises the full upstream catalogue (documented, not Wolf-restricted)', async () => {
    const proc = await startServer({ cwd: dir });
    const res = await request(proc, 'tools/list');
    const names = res.result.tools.map((t) => t.name);
    writeToolSurface(names);
    await stop(proc);
    for (const t of EXPECTED_TOOLS) assert.ok(names.includes(t), `missing ${t}`);
  });

  test('5b. Wolf allowlist (CLAUDE_FLOW_MCP_TOOLS) restricts the advertised surface exactly', async () => {
    const proc = await startServer({ cwd: dir, env: { CLAUDE_FLOW_MCP_TOOLS: WOLF_ALLOWLIST.join(',') } });
    const res = await request(proc, 'tools/list');
    const names = res.result.tools.map((t) => t.name).sort();
    await stop(proc);
    assert.deepStrictEqual(names, [...WOLF_ALLOWLIST].sort());
  });

  test('5c. default start must not expose tools beyond the Wolf allowlist', async () => {
    const proc = await startServer({ cwd: dir });
    const res = await request(proc, 'tools/list');
    await stop(proc);
    const extra = res.result.tools.map((t) => t.name).filter((n) => !WOLF_ALLOWLIST.includes(n));
    assert.deepStrictEqual(extra, [], `${extra.length} tools outside the Wolf allowlist are advertised by default`);
  });

  test('5d. allowlist is enforced at call time: non-allowlisted registered tool is refused', async () => {
    const proc = await startServer({ cwd: dir, env: { CLAUDE_FLOW_MCP_TOOLS: WOLF_ALLOWLIST.join(',') } });
    const res = await request(proc, 'tools/call', { name: 'system_info', arguments: {} });
    await stop(proc);
    const refused = res.error !== undefined || res.result?.isError === true;
    assert.ok(refused, `system_info executed although it is not allowlisted: ${JSON.stringify(res).slice(0, 200)}`);
  });

  test('5e. Wolf allowlist proxy: tools/list advertises exactly the allowlist', async () => {
    const proc = await startServer({ cwd: dir, proxy: true });
    const res = await request(proc, 'tools/list');
    await stop(proc);
    assert.deepStrictEqual(res.result.tools.map((t) => t.name).sort(), [...WOLF_ALLOWLIST].sort());
  });

  test('5f. Wolf allowlist proxy: non-allowlisted tool is refused and not executed', async () => {
    const proc = await startServer({ cwd: dir, proxy: true });
    const res = await request(proc, 'tools/call', { name: 'system_info', arguments: {} });
    const ok = await request(proc, 'tools/call', { name: 'agent_list', arguments: {} });
    await stop(proc);
    assert.strictEqual(res.result?.isError, true);
    assert.match(toolText(res), /not in the Wolf MCP allowlist/);
    assert.ok(!toolText(res).includes('"nodeVersion"'), 'system_info output leaked');
    assert.notStrictEqual(ok.result?.isError, true, 'allowlisted tool must still work through the proxy');
  });

  test('5g. Wolf allowlist proxy: startup, shutdown and invalid-argument rejection still work', async () => {
    const proc = await startServer({ cwd: dir, proxy: true });
    const res = await request(proc, 'tools/call', { name: 'memory_store', arguments: {} });
    assert.strictEqual(res.result?.isError, true, JSON.stringify(res).slice(0, 200));
    const { code } = await stop(proc);
    assert.strictEqual(code, 0);
  });

  test('6. invalid tool name is rejected', async () => {
    const proc = await startServer({ cwd: dir });
    const res = await request(proc, 'tools/call', { name: 'no_such_tool', arguments: {} });
    const rejected = res.error !== undefined || res.result?.isError === true;
    assert.ok(rejected, JSON.stringify(res));
    await stop(proc);
  });

  test('7. invalid arguments are rejected by schema validation', async () => {
    const proc = await startServer({ cwd: dir });
    const res = await request(proc, 'tools/call', { name: 'agent_spawn', arguments: {} });
    assert.strictEqual(res.result?.isError, true, JSON.stringify(res));
    assert.match(toolText(res), /agentType is required/);
    await stop(proc);
  });

  test('8. secrets in the environment never appear in stderr/stdout', async () => {
    const proc = await startServer({ cwd: dir, env: { ANTHROPIC_API_KEY: SENTINEL_SECRET, OPENROUTER_API_KEY: SENTINEL_SECRET } });
    await request(proc, 'tools/list');
    await request(proc, 'tools/call', { name: 'agent_list', arguments: {} });
    await request(proc, 'tools/call', { name: 'agent_spawn', arguments: {} });
    await stop(proc);
    assert.ok(!proc.stderrBuf.includes(SENTINEL_SECRET), 'secret leaked to stderr');
    assert.ok(!proc.stdoutBuf.includes(SENTINEL_SECRET), 'secret leaked to stdout');
  });

  test('9. repeated startup/shutdown cycles are stable and leave no children', async () => {
    for (let i = 0; i < 3; i++) {
      const proc = await startServer({ cwd: dir });
      const res = await request(proc, 'tools/list');
      assert.ok(res.result.tools.length > 0);
      assert.deepStrictEqual(childPids(proc.pid), []);
      const { code } = await stop(proc);
      assert.strictEqual(code, 0, `cycle ${i} exit ${code}`);
    }
  });

  test('10. no autonomous mission admission: fresh server creates no agents and no memory db', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'wolf-mcp-fresh-'));
    const proc = await startServer({ cwd: fresh });
    const list = await request(proc, 'tools/call', { name: 'agent_list', arguments: {} });
    await stop(proc);
    const text = toolText(list);
    assert.doesNotMatch(text, /"agentId"/, 'agent registered without an explicit call');
    // Read-only tool call must not write a database into the working directory.
    const entries = await readdir(fresh);
    assert.ok(!entries.includes('memory.db'), 'memory.db created without an explicit write');
    await rm(fresh, { recursive: true, force: true });
  });

  // Ruflo starts a detached `daemon start` after any command when the working
  // directory is a "Ruflo project" (e.g. has .swarm/memory.db, which the default
  // DB location creates). Both tests use the DEFAULT DB location on purpose.
  test('11. autostart disabled: default-location workspace gets no detached daemon', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'wolf-daemon-off-'));
    try {
      const env = { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' };
      delete env.CLAUDE_FLOW_DB_PATH;
      await runCli(['memory', 'init', '--force'], env, ws);
      await runCli(['memory', 'store', '-k', 'a', '-v', 'b', '-n', 'n'], env, ws);
      await delay(4000);
      assert.deepStrictEqual(daemonsFor(ws), []);
    } finally { await rm(ws, { recursive: true, force: true }); }
  });

  test('12. default configuration (autostart unset): daemon must not start (upstream default is ON)', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'wolf-daemon-default-'));
    const env = { ...process.env };
    delete env.RUFLO_DAEMON_AUTOSTART;
    delete env.CLAUDE_FLOW_DB_PATH;
    try {
      await runCli(['memory', 'init', '--force'], env, ws);
      await runCli(['memory', 'store', '-k', 'a', '-v', 'b', '-n', 'n'], env, ws);
      await delay(4000);
      const found = daemonsFor(ws);
      assert.deepStrictEqual(found, [], `detached daemon started by default: pids ${found.join(',')}`);
    } finally {
      for (const pid of daemonsFor(ws)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
      await delay(300);
      await rm(ws, { recursive: true, force: true });
    }
  });

  test('cleanup', async () => {
    await rm(dir, { recursive: true, force: true });
  });
});

import { writeFileSync, mkdirSync } from 'node:fs';
function writeToolSurface(names) {
  const dir = new URL('../evidence/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL('mcp-tool-surface.json', dir), JSON.stringify({ count: names.length, tools: names.sort() }, null, 2) + '\n');
}
