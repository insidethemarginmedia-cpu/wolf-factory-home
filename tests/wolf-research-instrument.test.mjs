/**
 * Verification for the Wolf research instrument.
 *
 * These tests exist so that every number quoted in research/ can be traced to
 * code that is itself independently checked. Two classes:
 *
 *   1. Pure-function tests (no git) — commit parsing and classification.
 *   2. Integration tests against a synthetic repository built in a temp dir —
 *      proves the instrument reads real git history correctly, including the
 *      merge-conflict path that previously produced a false negative.
 *
 * Run: node --test tests/wolf-research-instrument.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyse, commitType, commitScope } from '../scripts/wolf-research-instrument.mjs';

// --------------------------------------------------------------------------
// 1. Pure functions
// --------------------------------------------------------------------------

test('commitType parses conventional commits', () => {
  assert.equal(commitType('feat(ci): add gate'), 'feat');
  assert.equal(commitType('fix: repair pin'), 'fix');
  assert.equal(commitType('chore(ci): tidy'), 'chore');
  assert.equal(commitType('docs: update backlog'), 'docs');
  assert.equal(commitType('feat!: drop node 18'), 'feat');
});

test('commitType classifies non-conforming subjects as other', () => {
  assert.equal(commitType('Initial commit'), 'other');
  assert.equal(commitType('Record denied Compute coordination write'), 'other');
  assert.equal(commitType(''), 'other');
});

test('commitScope extracts scope or null', () => {
  assert.equal(commitScope('feat(ci): x'), 'ci');
  assert.equal(commitScope('fix(runtime): x'), 'runtime');
  assert.equal(commitScope('fix: x'), null);
  assert.equal(commitScope('no scope here'), null);
});

// --------------------------------------------------------------------------
// 2. Synthetic repository fixtures
// --------------------------------------------------------------------------

function sh(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'wolf-instrument-'));
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.email', 'test@example.com']);
  sh(dir, ['config', 'user.name', 'Test']);
  return dir;
}

function commit(dir, msg, file, content) {
  if (file) {
    mkdirSync(join(dir, join(...file.split('/').slice(0, -1))), { recursive: true });
    writeFileSync(join(dir, file), content);
    sh(dir, ['add', '-A']);
  }
  sh(dir, ['commit', '-q', '-m', msg]);
  return sh(dir, ['rev-parse', 'HEAD']).trim();
}

test('analyse counts unique commits and classifies types', (t) => {
  const dir = initRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  commit(dir, 'Initial commit', 'a.txt', '1');
  commit(dir, 'feat(core): add thing', 'b.txt', '2');
  commit(dir, 'fix(core): repair thing', 'b.txt', '3');
  commit(dir, 'docs: explain thing', 'c.md', '4');

  const r = analyse(dir);
  assert.equal(r.measurement.commitsUnique, 4);
  assert.equal(r.measurement.commitTypes.feat, 1);
  assert.equal(r.measurement.commitTypes.fix, 1);
  assert.equal(r.measurement.commitTypes.docs, 1);
  assert.equal(r.measurement.commitTypes.other, 1); // Initial commit
  assert.equal(r.measurement.commitScopes.core, 2);
  assert.equal(r.measurement.uniqueFilesTouched, 3); // a.txt b.txt c.md
});

test('analyse reports branch divergence from merge-base with main', (t) => {
  const dir = initRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  commit(dir, 'Initial commit', 'a.txt', '1');
  sh(dir, ['checkout', '-q', '-b', 'feature']);
  commit(dir, 'feat: one', 'f1.txt', 'x');
  commit(dir, 'feat: two', 'f2.txt', 'y');
  sh(dir, ['checkout', '-q', 'main']);
  commit(dir, 'chore: main moves', 'm.txt', 'z');
  sh(dir, ['remote', 'add', 'origin', dir]);
  sh(dir, ['push', '-q', 'origin', 'main', 'feature']);

  const r = analyse(dir);
  const feature = r.measurement.branches.find((b) => b.branch === 'origin/feature');
  assert.ok(feature, 'origin/feature must be observed');
  assert.equal(feature.aheadOfMain, 2);
  assert.equal(feature.filesChanged, 2); // f1.txt f2.txt
});

test('analyse detects real merge conflicts between diverged branches', (t) => {
  const dir = initRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Shared base with a file both sides will edit differently.
  commit(dir, 'Initial commit', 'shared.txt', 'base\n');
  sh(dir, ['branch', '-q', 'side']);
  sh(dir, ['branch', '-q', 'other']);

  // main: 2 more commits so it is >=50? No — threshold is 50 ahead of main,
  // so craft branches that are far enough ahead to be classified long-lived.
  sh(dir, ['checkout', '-q', 'side']);
  for (let i = 0; i < 51; i += 1) commit(dir, `feat(side): ${i}`, `s${i}.txt`, `${i}`);
  commit(dir, 'feat(side): conflict edit', 'shared.txt', 'side-version\n');

  sh(dir, ['checkout', '-q', 'other']);
  for (let i = 0; i < 51; i += 1) commit(dir, `feat(other): ${i}`, `o${i}.txt`, `${i}`);
  commit(dir, 'feat(other): conflict edit', 'shared.txt', 'other-version\n');

  sh(dir, ['checkout', '-q', 'main']);
  sh(dir, ['remote', 'add', 'origin', dir]);
  sh(dir, ['push', '-q', 'origin', 'main', 'side', 'other']);

  const r = analyse(dir);
  const pair = r.measurement.mergeConflicts.find(
    (c) => [c.a, c.b].some((x) => x.endsWith('/side')) && [c.a, c.b].some((x) => x.endsWith('/other')),
  );
  assert.ok(pair, 'pair side<->other must be measured');
  assert.equal(pair.conflicts, 1, 'exactly one conflicted path expected');
  assert.deepEqual(pair.conflictedPaths, ['shared.txt']);
});

test('analyse reports zero conflicts for branches that merge cleanly', (t) => {
  const dir = initRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  commit(dir, 'Initial commit', 'a.txt', 'base\n');
  sh(dir, ['branch', '-q', 'clean-a']);
  sh(dir, ['branch', '-q', 'clean-b']);

  sh(dir, ['checkout', '-q', 'clean-a']);
  for (let i = 0; i < 51; i += 1) commit(dir, `feat(a): ${i}`, `a${i}.txt`, `${i}`);
  commit(dir, 'feat(a): edit', 'only-a.txt', 'A\n');

  sh(dir, ['checkout', '-q', 'clean-b']);
  for (let i = 0; i < 51; i += 1) commit(dir, `feat(b): ${i}`, `b${i}.txt`, `${i}`);
  commit(dir, 'feat(b): edit', 'only-b.txt', 'B\n');

  sh(dir, ['checkout', '-q', 'main']);
  sh(dir, ['remote', 'add', 'origin', dir]);
  sh(dir, ['push', '-q', 'origin', 'main', 'clean-a', 'clean-b']);

  const r = analyse(dir);
  const pair = r.measurement.mergeConflicts.find(
    (c) => [c.a, c.b].some((x) => x.endsWith('/clean-a')) && [c.a, c.b].some((x) => x.endsWith('/clean-b')),
  );
  assert.ok(pair, 'pair clean-a<->clean-b must be measured');
  assert.equal(pair.conflicts, 0, 'disjoint edits must not be reported as conflicts');
});

test('analyse fails closed on a non-repository path', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wolf-not-a-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => analyse(dir), /not a git repository|git rev-parse failed/);
});
