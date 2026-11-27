#!/usr/bin/env node
/**
 * Wolf Engineering Research Lab — repository instrumentation.
 *
 * Reproduces every repository-derived number quoted in research/ from raw git
 * history, so that no baseline claim is an unverifiable hand-typed figure.
 *
 * Design constraints:
 *   - read-only: never mutates the repository, index, or worktree
 *   - dependency-free: Node built-ins only (node:child_process, node:fs, ...)
 *   - deterministic: same repo state => byte-identical output
 *   - fail-closed: missing git, non-repo, or malformed input => nonzero exit
 *
 * Usage:
 *   node scripts/wolf-research-instrument.mjs [--repo PATH] [--json] [--pretty]
 *   node scripts/wolf-research-instrument.mjs --help
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = `wolf-research-instrument — reproducible Wolf repository baseline

Options:
  --repo PATH   Repository to analyse (default: current directory)
  --json        Emit only JSON (default)
  --pretty      Emit indented JSON (default)
  --markdown    Emit a Markdown summary table instead of JSON
  --help        Show this help

Exit codes: 0 ok, 1 usage error, 2 git/environment failure.
`;

class InstrumentError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const opts = { repo: process.cwd(), format: 'pretty', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--json') opts.format = 'json';
    else if (a === '--pretty') opts.format = 'pretty';
    else if (a === '--markdown') opts.format = 'markdown';
    else if (a === '--repo') {
      const v = argv[++i];
      if (v === undefined) throw new InstrumentError('--repo requires a path', 1);
      opts.repo = v;
    } else throw new InstrumentError(`unknown argument: ${a}`, 1);
  }
  return opts;
}

function git(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim().split('\n').slice(0, 4).join(' | ');
    const wrapped = new InstrumentError(`git ${args[0]} failed: ${stderr || err.message}`);
    // Preserve stdout/stderr: `git merge-tree` reports conflicts on stdout with rc=1.
    wrapped.stdout = (err.stdout || '').toString();
    wrapped.stderr = (err.stderr || '').toString();
    wrapped.status = err.status;
    throw wrapped;
  }
}

/** Conventional-commit type from a subject line. Non-conforming => 'other'. */
export function commitType(subject) {
  const m = /^([a-zA-Z]+)(?:\([^)]*\))?!?:\s/.exec(subject);
  return m ? m[1].toLowerCase() : 'other';
}

/** Conventional-commit scope from a subject line, or null. */
export function commitScope(subject) {
  const m = /^[a-zA-Z]+\(([^)]*)\)!?:\s/.exec(subject);
  return m ? m[1].toLowerCase() : null;
}

function tally(items) {
  const out = {};
  for (const k of items) out[k] = (out[k] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function remoteBranches(repo) {
  return git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'])
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.endsWith('/HEAD'))
    .sort();
}

/** Analyse a repository. Pure with respect to the filesystem outside git reads. */
export function analyse(repo) {
  if (!existsSync(resolve(repo, '.git')) && git(repo, ['rev-parse', '--git-dir']).trim() === '') {
    throw new InstrumentError(`not a git repository: ${repo}`);
  }

  const head = git(repo, ['rev-parse', 'HEAD']).trim();

  // --- commits: one row per unique commit reachable from any ref -------------
  const raw = git(repo, [
    'log', '--all', '--no-merges',
    '--format=%H%x1f%an%x1f%ad%x1f%s', '--date=short',
  ]);
  const seen = new Set();
  const commits = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [sha, author, date, subject] = line.split('\x1f');
    if (seen.has(sha)) continue;
    seen.add(sha);
    commits.push({ sha, author, date, subject });
  }

  const types = tally(commits.map((c) => commitType(c.subject)));
  const scopes = tally(
    commits.map((c) => commitScope(c.subject)).filter((s) => s !== null),
  );
  const authors = tally(commits.map((c) => c.author));
  const days = tally(commits.map((c) => c.date));
  const sortedDays = Object.keys(days).sort();
  const total = commits.length;

  const share = (n) => (total === 0 ? 0 : Number((n / total).toFixed(4)));

  // --- churn: file touch counts across all commits ---------------------------
  const nameRaw = git(repo, ['log', '--all', '--no-merges', '--name-only', '--format=']);
  const touch = {};
  for (const f of nameRaw.split('\n')) {
    if (!f) continue;
    touch[f] = (touch[f] || 0) + 1;
  }
  const topChurn = Object.entries(touch)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 15)
    .map(([path, touches]) => ({ path, touches }));

  // --- directory composition of file touch events ----------------------------
  const dirTouch = {};
  for (const [f, n] of Object.entries(touch)) {
    const dir = f.includes('/') ? f.split('/')[0] : '(root)';
    dirTouch[dir] = (dirTouch[dir] || 0) + n;
  }

  // --- branch divergence -----------------------------------------------------
  const branches = remoteBranches(repo);
  const mainRef = branches.includes('origin/main') ? 'origin/main' : null;
  const branchRows = [];
  for (const b of branches) {
    const commitsAhead = Number(git(repo, ['rev-list', '--count', b]).trim());
    let mergeBase = null;
    let aheadOfMain = null;
    let filesChanged = null;
    if (mainRef && b !== mainRef) {
      mergeBase = git(repo, ['merge-base', mainRef, b]).trim();
      aheadOfMain = Number(git(repo, ['rev-list', '--count', `${mergeBase}..${b}`]).trim());
      filesChanged = git(repo, ['diff', '--name-only', `${mergeBase}..${b}`])
        .split('\n').filter(Boolean).length;
    }
    branchRows.push({ branch: b, commitsReachable: commitsAhead, mergeBase, aheadOfMain, filesChanged });
  }

  // --- integration debt: pairwise merge conflicts (read-only merge-tree) -----
  // `git merge-tree --write-tree` exits 0 with no conflicts, 1 with conflicts,
  // and >1 on real errors. Conflict detail is printed on stdout in both the
  // normal and error paths, so parse stdout and distinguish rc=1 from rc>=2.
  const conflicts = [];
  const longLived = branchRows
    .filter((r) => (r.aheadOfMain ?? 0) >= 50)
    .map((r) => r.branch);
  for (let i = 0; i < longLived.length; i += 1) {
    for (let j = i + 1; j < longLived.length; j += 1) {
      const [a, b] = [longLived[i], longLived[j]];
      let rc = 0;
      let out = '';
      try {
        out = git(repo, ['merge-tree', '--write-tree', a, b]);
      } catch (err) {
        rc = typeof err.status === 'number' ? err.status : 2;
        out = `${err.stdout || ''}`;
      }
      if (rc >= 2) {
        throw new InstrumentError(`merge-tree failed hard for ${a} vs ${b} (rc=${rc})`);
      }
      const conflictedPaths = [...out.matchAll(/CONFLICT \([^)]+\): Merge conflict in (.+)/g)]
        .map((m) => m[1].trim())
        .sort();
      conflicts.push({ a, b, conflicts: conflictedPaths.length, conflictedPaths });
    }
  }

  return {
    schemaVersion: 1,
    tool: 'wolf-research-instrument',
    repository: repo,
    head,
    measurement: {
      commitsUnique: total,
      dateRange: sortedDays.length
        ? { first: sortedDays[0], last: sortedDays[sortedDays.length - 1], activeDays: sortedDays.length }
        : null,
      commitTypes: types,
      commitScopes: scopes,
      authors,
      commitsByDay: days,
      fileTouchEvents: Object.values(touch).reduce((a, b) => a + b, 0),
      uniqueFilesTouched: Object.keys(touch).length,
      topChurn,
      touchesByTopLevelDirectory: Object.fromEntries(
        Object.entries(dirTouch).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      ),
      shares: {
        fix: share(types.fix || 0),
        feat: share(types.feat || 0),
        docs: share(types.docs || 0),
        chore: share(types.chore || 0),
        checkpoint: share(types.checkpoint || 0),
        test: share(types.test || 0),
      },
      branches: branchRows,
      mergeConflicts: conflicts,
    },
  };
}

function renderMarkdown(r) {
  const m = r.measurement;
  const lines = [];
  lines.push(`# Repository baseline — \`${r.repository}\``);
  lines.push('');
  lines.push(`- HEAD: \`${r.head}\``);
  lines.push(`- Unique commits (all refs, no merges): **${m.commitsUnique}**`);
  if (m.dateRange) {
    lines.push(`- Active range: **${m.dateRange.first} → ${m.dateRange.last}** (${m.dateRange.activeDays} distinct days)`);
  }
  lines.push(`- File touch events: **${m.fileTouchEvents}** across **${m.uniqueFilesTouched}** unique files`);
  lines.push('');
  lines.push('## Commit types');
  lines.push('');
  lines.push('| type | count | share |');
  lines.push('|---|---:|---:|');
  for (const [k, v] of Object.entries(m.commitTypes)) {
    lines.push(`| ${k} | ${v} | ${(v / m.commitsUnique * 100).toFixed(1)}% |`);
  }
  lines.push('');
  lines.push('## Highest-churn files');
  lines.push('');
  lines.push('| touches | path |');
  lines.push('|---:|---|');
  for (const t of m.topChurn) lines.push(`| ${t.touches} | \`${t.path}\` |`);
  lines.push('');
  lines.push('## Branch divergence from merge-base with main');
  lines.push('');
  lines.push('| branch | ahead of main | files changed |');
  lines.push('|---|---:|---:|');
  for (const b of m.branches) {
    if (b.aheadOfMain === null) continue;
    lines.push(`| \`${b.branch}\` | ${b.aheadOfMain} | ${b.filesChanged} |`);
  }
  lines.push('');
  lines.push('## Pairwise merge conflicts (long-lived branches, ≥50 commits ahead)');
  lines.push('');
  lines.push('| pair | conflicts |');
  lines.push('|---|---:|');
  for (const c of m.mergeConflicts) {
    lines.push(`| \`${c.a.replace('origin/','')}\` ↔ \`${c.b.replace('origin/','')}\` | ${c.conflicts} |`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    process.exit(err.exitCode ?? 1);
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const repo = resolve(opts.repo);
  if (!existsSync(repo)) {
    process.stderr.write(`repository path does not exist: ${repo}\n`);
    process.exit(2);
  }

  let result;
  try {
    result = analyse(repo);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(err.exitCode ?? 2);
  }

  if (opts.format === 'markdown') process.stdout.write(renderMarkdown(result));
  else {
    process.stdout.write(`${JSON.stringify(result, null, opts.format === 'json' ? 0 : 2)}\n`);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ''))) {
  await main();
}
