#!/usr/bin/env node
/**
 * Wolf Loop — the minimum viable autonomous engineering loop.
 *
 *   UNDERSTAND -> PLAN -> IMPLEMENT -> EXECUTE -> OBSERVE -> CORRECT
 *              -> VERIFY -> INTEGRATE -> CONTINUE
 *
 * This is deliberately NOT an orchestration framework. It is one file that
 * does four things, because the repository evidence shows those four things
 * are what was missing:
 *
 *   1. ONE ordered, dependency-aware queue (not 4 competing docs).
 *   2. ONE verification command per task (not 504 tests of CI plumbing).
 *   3. ONE durable receipt per attempt (pass or fail, both preserved).
 *   4. ONE rule: a task is done only when its own verification exits 0.
 *
 * Evidence that motivated this (research/evidence/factory-home-baseline-*.json):
 *   - 402 unique commits, 76.4% in non-product classes; feat = 8.2%.
 *   - 46 of 52 test files test CI plumbing; 0 test product domains.
 *   - 4 open PRs, 0 merged; 48 of 91 long-lived branch pairs conflict.
 *   - main carries 3 files while a single branch carries 193.
 *
 * Design constraints (standing):
 *   EUR_SPEND=0. COST_UNKNOWN=DENY. PAID_FALLBACK=DENY.
 *   Never mutates git history, never pushes, never merges, never reads secrets.
 *   Verification commands are executed with the same shell the operator would
 *   use; only commands declared in the queue file are run.
 *
 * Usage:
 *   node scripts/wolf-loop.mjs status
 *   node scripts/wolf-loop.mjs next
 *   node scripts/wolf-loop.mjs run [--task ID] [--dry-run]
 *   node scripts/wolf-loop.mjs verify --task ID     # run verify only
 *   node scripts/wolf-loop.mjs history
 *   node scripts/wolf-loop.mjs --help
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QUEUE_PATH = resolve(ROOT, 'queue/wolf-queue.json');
const RECEIPT_DIR = resolve(ROOT, 'queue/receipts');
const HISTORY_PATH = resolve(RECEIPT_DIR, 'history.jsonl');

const USAGE = `wolf-loop — minimum viable autonomous engineering loop

Commands:
  status              Show queue state and the next unblocked task
  next                Print the single next task as JSON
  run [--task ID]     Execute the next (or named) task and record a receipt
  verify --task ID    Run only the task's verification command
  history             Print the receipt history
  help                Show this help

Exit codes: 0 ok, 1 usage error, 2 environment/queue error,
            3 verification failed (task NOT completed).
`;

class LoopError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

// --------------------------------------------------------------------------
// Queue model
// --------------------------------------------------------------------------

/**
 * Validate a queue document. Fail-closed: any structural problem throws.
 * Returns the parsed queue.
 */
export function loadQueue(path = QUEUE_PATH) {
  if (!existsSync(path)) throw new LoopError(`queue not found: ${path}`);
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new LoopError(`queue is not valid JSON: ${err.message}`);
  }
  if (doc.schemaVersion !== 1) throw new LoopError(`unsupported schemaVersion: ${doc.schemaVersion}`);
  if (!Array.isArray(doc.tasks) || doc.tasks.length === 0) {
    throw new LoopError('queue.tasks must be a non-empty array');
  }

  const ids = new Set();
  for (const t of doc.tasks) {
    for (const key of ['id', 'title', 'verify', 'status']) {
      if (typeof t[key] !== 'string' || t[key].trim() === '') {
        throw new LoopError(`task ${t.id ?? '(missing id)'}: ${key} must be a non-empty string`);
      }
    }
    if (ids.has(t.id)) throw new LoopError(`duplicate task id: ${t.id}`);
    ids.add(t.id);
    if (!['pending', 'done', 'deferred'].includes(t.status)) {
      throw new LoopError(`task ${t.id}: invalid status "${t.status}"`);
    }
    // Ownership: an autonomous run must never select a task only the Founder
    // can complete, or the loop stalls on the first step. 'founder' tasks are
    // reported as interventions, not executed.
    if (t.owner !== undefined && !['agent', 'founder'].includes(t.owner)) {
      throw new LoopError(`task ${t.id}: invalid owner "${t.owner}"`);
    }
    if (t.value !== undefined && !(Number.isInteger(t.value) && t.value >= 1 && t.value <= 5)) {
      throw new LoopError(`task ${t.id}: value must be an integer 1..5 when present`);
    }
    if (t.effortHours !== undefined && !(typeof t.effortHours === 'number' && t.effortHours >= 0)) {
      throw new LoopError(`task ${t.id}: effortHours must be a non-negative number`);
    }
    if (!Array.isArray(t.deps)) throw new LoopError(`task ${t.id}: deps must be an array`);
  }

  // Dependency integrity: referential integrity + acyclicity + no self-deps.
  for (const t of doc.tasks) {
    for (const d of t.deps) {
      if (!ids.has(d)) throw new LoopError(`task ${t.id}: unknown dependency "${d}"`);
      if (d === t.id) throw new LoopError(`task ${t.id}: depends on itself`);
    }
  }
  const cycle = findCycle(doc.tasks);
  if (cycle) throw new LoopError(`dependency cycle: ${cycle.join(' -> ')}`);

  return doc;
}

/** Depth-first cycle detection. Returns the cycle path or null. */
export function findCycle(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map(); // id -> 'visiting' | 'done'
  const stack = [];
  const visit = (id) => {
    const s = state.get(id);
    if (s === 'done') return null;
    if (s === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'visiting');
    stack.push(id);
    for (const d of byId.get(id).deps) {
      const found = visit(d);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };
  for (const t of tasks) {
    const c = visit(t.id);
    if (c) return c;
  }
  return null;
}

/** Tasks whose dependencies are all done (or which have none). */
export function unblocked(queue, { includeDone = false, owner = 'agent' } = {}) {
  const done = new Set(queue.tasks.filter((t) => t.status === 'done').map((t) => t.id));
  return queue.tasks.filter((t) => {
    if (includeDone) return true;
    if (t.status !== 'pending') return false;
    // Default: only agent-owned work is runnable by an autonomous run.
    if ((t.owner ?? 'agent') !== owner) return false;
    return t.deps.every((d) => done.has(d));
  });
}

/**
 * Rank candidate tasks: highest value-per-effort first, then lowest effort,
 * then id — a deterministic tie-break so runs are reproducible.
 * effortHours defaults to 1 when absent (documented assumption, not a measurement).
 */
export function rankTasks(candidates) {
  const effort = (t) => (t.effortHours === undefined ? 1 : t.effortHours);
  const value = (t) => (t.value === undefined ? 1 : t.value);
  return [...candidates].sort((a, b) => {
    const ra = value(a) / effort(a);
    const rb = value(b) / effort(b);
    if (rb !== ra) return rb - ra;
    if (effort(a) !== effort(b)) return effort(a) - effort(b);
    return a.id.localeCompare(b.id);
  });
}

/** The single next task, or null when nothing is runnable. */
export function nextTask(queue) {
  const runnable = rankTasks(unblocked(queue));
  return runnable.length > 0 ? runnable[0] : null;
}

/** Blockers for a task: which deps are not done. */
export function blockersOf(queue, taskId) {
  const byId = new Map(queue.tasks.map((t) => [t.id, t]));
  const task = byId.get(taskId);
  if (!task) throw new LoopError(`unknown task: ${taskId}`);
  return task.deps.filter((d) => byId.get(d).status !== 'done');
}

// --------------------------------------------------------------------------
// Verification + receipts
// --------------------------------------------------------------------------

/**
 * Run a declared verification command. Never uses a shell metacharacter path:
 * the command is executed through `sh -c` exactly as written in the queue,
 * which is the operator's own reviewed text.
 */
export function runVerify(command, { cwd = ROOT, timeoutMs = 600_000 } = {}) {
  const started = Date.now();
  try {
    const stdout = execFileSync('sh', ['-c', command], {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, exitCode: 0, durationMs: Date.now() - started, output: stdout };
  } catch (err) {
    return {
      ok: false,
      exitCode: typeof err.status === 'number' ? err.status : 1,
      durationMs: Date.now() - started,
      output: `${err.stdout || ''}${err.stderr || ''}`.slice(-8000),
      // Node signals its own timeout via code ETIMEDOUT (child sent SIGTERM).
      timedOut: err.code === 'ETIMEDOUT',
    };
  }
}

export function writeReceipt(receipt) {
  mkdirSync(RECEIPT_DIR, { recursive: true });
  const file = resolve(RECEIPT_DIR, `${receipt.taskId}-${receipt.attempt}.json`);
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
  appendFileSync(HISTORY_PATH, `${JSON.stringify(receipt)}\n`);
  return file;
}

export function readHistory() {
  if (!existsSync(HISTORY_PATH)) return [];
  return readFileSync(HISTORY_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function attemptNumber(taskId) {
  return readHistory().filter((r) => r.taskId === taskId).length + 1;
}

// --------------------------------------------------------------------------
// Commands
// --------------------------------------------------------------------------

function gitHead() {
  try {
    return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function cmdStatus(queue) {
  const done = queue.tasks.filter((t) => t.status === 'done').length;
  const deferred = queue.tasks.filter((t) => t.status === 'deferred').length;
  const pending = queue.tasks.filter((t) => t.status === 'pending').length;
  const founderPending = queue.tasks.filter(
    (t) => t.status === 'pending' && (t.owner ?? 'agent') === 'founder',
  );
  const agentPending = queue.tasks.filter(
    (t) => t.status === 'pending' && (t.owner ?? 'agent') === 'agent',
  );
  const nxt = nextTask(queue);
  const out = {
    queue: queue.name ?? 'wolf-queue',
    tasks: { total: queue.tasks.length, done, pending, deferred },
    percentComplete: Number(((done / queue.tasks.length) * 100).toFixed(1)),
    next: nxt
      ? { id: nxt.id, title: nxt.title, value: nxt.value ?? null, effortHours: nxt.effortHours ?? null }
      : null,
    // Founder interventions are surfaced, never silently executed.
    founderInterventions: founderPending.map((t) => ({ id: t.id, title: t.title })),
    agentRunnable: agentPending.length,
    stalledOnFounder: agentPending.length === 0 && founderPending.length > 0,
    head: gitHead(),
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function cmdNext(queue) {
  const nxt = nextTask(queue);
  if (!nxt) {
    process.stdout.write(`${JSON.stringify({ next: null, reason: 'no unblocked pending task' })}\n`);
    return 0;
  }
  process.stdout.write(`${JSON.stringify({ next: nxt, blockers: blockersOf(queue, nxt.id) }, null, 2)}\n`);
  return 0;
}

function cmdVerify(queue, taskId) {
  const byId = new Map(queue.tasks.map((t) => [t.id, t]));
  const task = byId.get(taskId);
  if (!task) throw new LoopError(`unknown task: ${taskId}`);
  const res = runVerify(task.verify);
  process.stdout.write(
    `${JSON.stringify({ taskId, verify: task.verify, ok: res.ok, exitCode: res.exitCode, durationMs: res.durationMs }, null, 2)}\n`,
  );
  if (!res.ok) process.stdout.write(`--- output (tail) ---\n${res.output}\n`);
  return res.ok ? 0 : 3;
}

function cmdRun(queue, { taskId, dryRun }) {
  let target;
  if (taskId) {
    const byId = new Map(queue.tasks.map((t) => [t.id, t]));
    target = byId.get(taskId);
    if (!target) throw new LoopError(`unknown task: ${taskId}`);
    if (target.status !== 'pending') throw new LoopError(`task ${taskId} is ${target.status}`);
    const blocked = blockersOf(queue, taskId);
    if (blocked.length > 0) {
      throw new LoopError(`task ${taskId} is blocked by: ${blocked.join(', ')}`, 3);
    }
  } else {
    target = nextTask(queue);
    if (!target) {
      process.stdout.write(`${JSON.stringify({ ran: false, reason: 'nothing unblocked to run' })}\n`);
      return 0;
    }
  }

  if (dryRun) {
    process.stdout.write(`${JSON.stringify({ dryRun: true, wouldRun: { id: target.id, verify: target.verify } }, null, 2)}\n`);
    return 0;
  }

  process.stderr.write(`[wolf-loop] running ${target.id}: ${target.verify}\n`);
  const res = runVerify(target.verify);

  const receipt = {
    schemaVersion: 1,
    taskId: target.id,
    attempt: attemptNumber(target.id),
    startedAt: new Date(Date.now() - res.durationMs).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: res.durationMs,
    verify: target.verify,
    ok: res.ok,
    exitCode: res.exitCode,
    timedOut: res.timedOut === true,
    head: gitHead(),
    outputTail: res.ok ? '' : res.output.slice(-4000),
  };
  const file = writeReceipt(receipt);

  if (res.ok) {
    target.status = 'done';
    target.completedAt = receipt.finishedAt;
    writeFileSync(QUEUE_PATH, `${JSON.stringify(queue, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({ ran: true, taskId: target.id, ok: true, receipt: file, next: nextTask(queue)?.id ?? null }, null, 2)}\n`,
    );
    return 0;
  }
  process.stdout.write(
    `${JSON.stringify({ ran: true, taskId: target.id, ok: false, receipt: file, note: 'verification failed; task left pending' }, null, 2)}\n`,
  );
  process.stdout.write(`--- output (tail) ---\n${res.output}\n`);
  return 3;
}

function cmdHistory() {
  const rows = readHistory().map((r) => ({
    taskId: r.taskId,
    attempt: r.attempt,
    ok: r.ok,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    finishedAt: r.finishedAt,
  }));
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  return 0;
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

function parse(argv) {
  const opts = { command: null, task: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.command = 'help';
    else if (a === '--task') {
      opts.task = argv[++i];
      if (!opts.task) throw new LoopError('--task requires an id', 1);
    } else if (a === '--dry-run') opts.dryRun = true;
    else if (a.startsWith('--')) throw new LoopError(`unknown option: ${a}`, 1);
    else if (opts.command === null) opts.command = a;
    else throw new LoopError(`unexpected argument: ${a}`, 1);
  }
  if (opts.command === null) opts.command = 'status';
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parse(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    process.exit(err.exitCode ?? 1);
  }

  if (opts.command === 'help') {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (!['status', 'next', 'run', 'verify', 'history'].includes(opts.command)) {
    process.stderr.write(`unknown command: ${opts.command}\n\n${USAGE}`);
    process.exit(1);
  }
  if (opts.command === 'verify' && !opts.task) {
    process.stderr.write(`verify requires --task ID\n\n${USAGE}`);
    process.exit(1);
  }

  let queue;
  try {
    queue = loadQueue();
    if (opts.command === 'history') process.exit(cmdHistory());
    if (opts.command === 'status') process.exit(cmdStatus(queue));
    if (opts.command === 'next') process.exit(cmdNext(queue));
    if (opts.command === 'verify') process.exit(cmdVerify(queue, opts.task));
    if (opts.command === 'run') process.exit(cmdRun(queue, opts));
    process.exit(2);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(err.exitCode ?? 2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
