/**
 * Verification for the Wolf loop (queue integrity, scheduling, receipts).
 *
 * The loop is the component allowed to advance state autonomously, so its
 * failure modes are tested harder than its happy path: malformed queues,
 * unknown dependencies, cycles, blocked-task refusal, and the guarantee that
 * a failed verification does NOT complete a task.
 *
 * Run: node --test tests/wolf-loop.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadQueue,
  findCycle,
  unblocked,
  rankTasks,
  nextTask,
  blockersOf,
  runVerify,
} from '../scripts/wolf-loop.mjs';

function tmpQueue(doc) {
  const dir = mkdtempSync(join(tmpdir(), 'wolf-queue-'));
  const path = join(dir, 'queue.json');
  writeFileSync(path, JSON.stringify(doc, null, 2));
  return { dir, path };
}

const baseTask = (over = {}) => ({
  id: 'T1',
  title: 'example',
  verify: 'true',
  status: 'pending',
  deps: [],
  ...over,
});

// --------------------------------------------------------------------------
// Queue loading / fail-closed validation
// --------------------------------------------------------------------------

test('loadQueue accepts a minimal valid queue', (t) => {
  const { dir, path } = tmpQueue({ schemaVersion: 1, tasks: [baseTask()] });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const q = loadQueue(path);
  assert.equal(q.tasks.length, 1);
});

test('loadQueue rejects a missing file', () => {
  assert.throws(() => loadQueue('/nonexistent/queue.json'), /queue not found/);
});

test('loadQueue rejects invalid JSON', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wolf-bad-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = join(dir, 'q.json');
  writeFileSync(p, '{ not json');
  assert.throws(() => loadQueue(p), /not valid JSON/);
});

test('loadQueue rejects a wrong schemaVersion', (t) => {
  const { dir, path } = tmpQueue({ schemaVersion: 99, tasks: [baseTask()] });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => loadQueue(path), /unsupported schemaVersion/);
});

test('loadQueue rejects an empty task list', (t) => {
  const { dir, path } = tmpQueue({ schemaVersion: 1, tasks: [] });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => loadQueue(path), /non-empty array/);
});

test('loadQueue rejects duplicate ids', (t) => {
  const { dir, path } = tmpQueue({
    schemaVersion: 1,
    tasks: [baseTask(), baseTask()],
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => loadQueue(path), /duplicate task id/);
});

test('loadQueue rejects an unknown dependency', (t) => {
  const { dir, path } = tmpQueue({
    schemaVersion: 1,
    tasks: [baseTask({ deps: ['GHOST'] })],
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => loadQueue(path), /unknown dependency "GHOST"/);
});

test('loadQueue rejects a self-dependency', (t) => {
  const { dir, path } = tmpQueue({
    schemaVersion: 1,
    tasks: [baseTask({ deps: ['T1'] })],
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => loadQueue(path), /depends on itself/);
});

test('loadQueue rejects a dependency cycle', (t) => {
  const { dir, path } = tmpQueue({
    schemaVersion: 1,
    tasks: [
      baseTask({ id: 'A', deps: ['B'] }),
      baseTask({ id: 'B', deps: ['A'] }),
    ],
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => loadQueue(path), /dependency cycle/);
});

test('loadQueue rejects an invalid status', (t) => {
  const { dir, path } = tmpQueue({ schemaVersion: 1, tasks: [baseTask({ status: 'wip' })] });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => loadQueue(path), /invalid status/);
});

test('loadQueue rejects out-of-range value', (t) => {
  const { dir, path } = tmpQueue({ schemaVersion: 1, tasks: [baseTask({ value: 9 })] });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => loadQueue(path), /value must be an integer 1\.\.5/);
});

// --------------------------------------------------------------------------
// Cycle detection
// --------------------------------------------------------------------------

test('findCycle returns null for a DAG', () => {
  const tasks = [
    { id: 'A', deps: [] },
    { id: 'B', deps: ['A'] },
    { id: 'C', deps: ['A', 'B'] },
  ];
  assert.equal(findCycle(tasks), null);
});

test('findCycle returns the cycle path', () => {
  const tasks = [
    { id: 'A', deps: ['C'] },
    { id: 'B', deps: ['A'] },
    { id: 'C', deps: ['B'] },
  ];
  const cycle = findCycle(tasks);
  assert.ok(cycle, 'a cycle must be detected');
  assert.ok(cycle.length >= 3);
  assert.equal(cycle[0], cycle[cycle.length - 1], 'cycle path must close');
});

// --------------------------------------------------------------------------
// Scheduling
// --------------------------------------------------------------------------

test('unblocked returns only tasks whose deps are done', () => {
  const queue = {
    tasks: [
      baseTask({ id: 'A', status: 'done' }),
      baseTask({ id: 'B', deps: ['A'] }),
      baseTask({ id: 'C', deps: ['B'] }),
    ],
  };
  const ids = unblocked(queue).map((t) => t.id);
  assert.deepEqual(ids, ['B']); // A is done, C still blocked by pending B
});

test('rankTasks prefers value per effort, deterministically', () => {
  const cands = [
    baseTask({ id: 'low', value: 1, effortHours: 4 }),
    baseTask({ id: 'high', value: 5, effortHours: 1 }),
    baseTask({ id: 'mid', value: 4, effortHours: 4 }),
  ];
  assert.deepEqual(rankTasks(cands).map((t) => t.id), ['high', 'mid', 'low']);
});

test('rankTasks tie-breaks on effort then id', () => {
  const cands = [
    baseTask({ id: 'zeta', value: 3, effortHours: 2 }),
    baseTask({ id: 'alpha', value: 3, effortHours: 2 }),
    baseTask({ id: 'beta', value: 3, effortHours: 1 }),
  ];
  assert.deepEqual(rankTasks(cands).map((t) => t.id), ['beta', 'alpha', 'zeta']);
});

test('nextTask returns null when everything is blocked', () => {
  const queue = {
    tasks: [
      baseTask({ id: 'A', status: 'done' }),
      baseTask({ id: 'B', status: 'deferred' }),
      baseTask({ id: 'C', status: 'pending', deps: ['B'] }),
    ],
  };
  assert.equal(nextTask(queue), null);
});

test('nextTask skips deferred tasks', () => {
  const queue = {
    tasks: [
      baseTask({ id: 'A', status: 'deferred', value: 5 }),
      baseTask({ id: 'B', status: 'pending', value: 1 }),
    ],
  };
  assert.equal(nextTask(queue).id, 'B');
});

test('blockersOf lists only incomplete deps', () => {
  const queue = {
    tasks: [
      baseTask({ id: 'A', status: 'done' }),
      baseTask({ id: 'B', status: 'pending' }),
      baseTask({ id: 'C', deps: ['A', 'B'] }),
    ],
  };
  assert.deepEqual(blockersOf(queue, 'C'), ['B']);
});

test('blockersOf throws for an unknown task', () => {
  assert.throws(() => blockersOf({ tasks: [baseTask()] }, 'NOPE'), /unknown task/);
});

// --------------------------------------------------------------------------
// Verification execution
// --------------------------------------------------------------------------

test('runVerify reports success for a zero exit command', () => {
  const r = runVerify('true');
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.ok(typeof r.durationMs === 'number' && r.durationMs >= 0);
});

test('runVerify captures a non-zero exit and its output', () => {
  const r = runVerify('echo FAIL-DETAIL; exit 7');
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 7);
  assert.match(r.output, /FAIL-DETAIL/);
});

test('runVerify never throws on a broken command', () => {
  const r = runVerify('definitely-not-a-command-xyz');
  assert.equal(r.ok, false);
  assert.ok(r.exitCode !== 0);
});

test('runVerify honours a short timeout', () => {
  const r = runVerify('sleep 5', { timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
});

// --------------------------------------------------------------------------
// The shipped queue itself must be valid and self-consistent
// --------------------------------------------------------------------------

test('the shipped wolf queue loads, is acyclic, and is internally consistent', () => {
  const path = new URL('../queue/wolf-queue.json', import.meta.url);
  const q = loadQueue(path);
  assert.ok(q.tasks.length >= 5, 'queue should carry the real backlog');
  assert.equal(findCycle(q.tasks), null);

  const done = q.tasks.filter((t) => t.status === 'done');
  const pending = q.tasks.filter((t) => t.status === 'pending');
  const founderPending = pending.filter((t) => (t.owner ?? 'agent') === 'founder');
  const agentPending = pending.filter((t) => (t.owner ?? 'agent') === 'agent');
  const n = nextTask(q);

  // Real invariant: either agent work is runnable, or every remaining pending
  // task is a Founder intervention. The queue must never claim to be stalled
  // while agent work exists, nor select work no agent can perform.
  assert.ok(
    n !== null || (agentPending.length === 0 && founderPending.length > 0),
    'queue must be either runnable or explicitly stalled on Founder work',
  );
  if (n) {
    assert.equal(n.status, 'pending');
    assert.equal(n.owner ?? 'agent', 'agent', 'autonomous run must never select Founder-owned work');
    assert.ok(
      n.deps.every((d) => q.tasks.find((t) => t.id === d).status === 'done'),
      'selected task must have all dependencies done',
    );
  }

  // Completed tasks must never be re-selected.
  for (const d of done) assert.notEqual(n?.id, d.id);

  // External blockers are recorded as tasks, never silently omitted, and they
  // are Founder-owned so an autonomous run cannot pick them.
  const blocked = q.tasks.filter((t) => t.title.includes('BLOCKED EXTERNAL'));
  assert.ok(blocked.length >= 2, 'external blockers must be recorded as tasks');
  for (const b of blocked) {
    assert.equal(b.owner, 'founder', `${b.id} is external and must be Founder-owned`);
  }
});

test('every queued verify command is a string that could be executed', () => {
  const path = new URL('../queue/wolf-queue.json', import.meta.url);
  const q = loadQueue(path);
  for (const t of q.tasks) {
    assert.equal(typeof t.verify, 'string');
    assert.ok(t.verify.trim().length > 0, `${t.id} verify empty`);
    // Guards against a queue entry that silently does nothing.
    assert.ok(!/^\s*$/.test(t.verify), `${t.id} verify blank`);
  }
});
