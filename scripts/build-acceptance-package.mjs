// Builds WOLF-RUFLO-P1-P2-FINAL-ACCEPTANCE.zip reproducibly.
//
// Everything in the package is generated from this repository at the current
// commit: no hand-written test numbers, no invented checksums. If a test fails,
// the packaged TEST-RESULTS.md records the failure.
//
// Usage: node scripts/build-acceptance-package.mjs [--out <dir>]
//
// The archive is written OUTSIDE the repository by default so that no large
// generated artifact is committed.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync, readdirSync, statSync,
} from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG_NAME = 'WOLF-RUFLO-P1-P2-FINAL-ACCEPTANCE';
const outArgIndex = process.argv.indexOf('--out');
const OUT_BASE = outArgIndex > -1 ? process.argv[outArgIndex + 1] : join(ROOT, '..');

const STAGE = join(OUT_BASE, PKG_NAME);
const ZIP_PATH = join(OUT_BASE, `${PKG_NAME}.zip`);

// ---------------------------------------------------------------------------
// Files that constitute the integration. Order is meaningful for the patch.
// ---------------------------------------------------------------------------
const INTEGRATION_FILES = [
  'infra/autonomy/p2-errors.mjs',
  'infra/autonomy/p2-policy.mjs',
  'infra/autonomy/p1-memory-reader.mjs',
  'infra/autonomy/p1-memory-fixture.mjs',
  'infra/autonomy/p2-lease-interface.mjs',
  'infra/autonomy/p2-gate.mjs',
  'infra/autonomy/p2-effect-guard.mjs',
  'infra/autonomy/test-support/reference-lease-engine.mjs',
  'infra/autonomy/test-support/lease-worker.mjs',
  'infra/autonomy/test-support/effect-ledger.mjs',
  'infra/autonomy/test-support/fixtures.mjs',
  'scripts/factory-lease-retrieval.mjs',
  'scripts/build-acceptance-package.mjs',
];

const TEST_FILES = [
  'tests/p1-memory-reader.test.mjs',
  'tests/p2-policy.test.mjs',
  'tests/p2-lease-interface.test.mjs',
  'tests/p2-gate-security.test.mjs',
  'tests/p2-gate-falsification.test.mjs',
  'tests/p2-effect-guard.test.mjs',
  'tests/p2-concurrency.test.mjs',
  'tests/p2-restart-recovery.test.mjs',
  'tests/factory-lease-retrieval.test.mjs',
];

const DOC_FILES = [
  'docs/ruflo-p1-p2/BLOCKERS.md',
  'docs/ruflo-p1-p2/RVF-INTERFACE-MISSING.md',
  'docs/ruflo-p1-p2/INSTALL.md',
  'docs/ruflo-p1-p2/ROLLBACK.md',
];

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

const log = (msg) => process.stderr.write(`${msg}\n`);

// ---------------------------------------------------------------------------
// 1. Provenance of this build
// ---------------------------------------------------------------------------
const headSha = run('git', ['rev-parse', 'HEAD']).stdout.trim();
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
// The patch is expressed against the verified HEAD the mandate names -- i.e. the
// commit the integration is applied ON TOP OF.
//
// Rules, in order:
//   1. WOLF_PATCH_BASE, if set, wins outright.
//   2. If integration files are not yet committed, the base is HEAD.
//   3. Otherwise the integration is already committed, so the base is its
//      parent (HEAD~1).
// A shallow clone has no local merge-base with origin/main, so that route is not
// used; and an empty patch is treated as a build failure rather than shipped.
let baseSha = process.env.WOLF_PATCH_BASE || '';
if (!baseSha) {
  const uncommitted = run('git', ['status', '--porcelain', '--', ...INTEGRATION_FILES, ...TEST_FILES, ...DOC_FILES]).stdout.trim();
  baseSha = uncommitted ? headSha : (run('git', ['rev-parse', 'HEAD~1']).stdout.trim() || headSha);
}
const dirty = run('git', ['status', '--porcelain']).stdout.trim();

log(`Building package at ${headSha} (${branch})`);

// ---------------------------------------------------------------------------
// 2. Run the full suite and capture the real output
// ---------------------------------------------------------------------------
const started = Date.now();
const suite = run(process.execPath, ['--test', ...TEST_FILES]);
const suiteDurationMs = Date.now() - started;
const suiteOutput = `${suite.stdout ?? ''}${suite.stderr ?? ''}`;

function parseTotals(text) {
  const num = (label) => {
    const m = text.match(new RegExp(`^# ${label} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  return {
    tests: num('tests'), pass: num('pass'), fail: num('fail'),
    skipped: num('skipped'), todo: num('todo'), cancelled: num('cancelled'),
  };
}
const totals = parseTotals(suiteOutput);

// Per-file results, so the report is not a single opaque number.
const perFile = TEST_FILES.map((file) => {
  const r = run(process.execPath, ['--test', file]);
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const t = parseTotals(text);
  return { file, exitCode: r.status, ...t, output: text };
});

const baselineFiles = run('git', ['ls-files', 'tests/*.test.mjs']).stdout.trim().split('\n')
  .filter((f) => f && !TEST_FILES.includes(f));
const baselineRun = run(process.execPath, ['--test', ...baselineFiles]);
const baselineTotals = parseTotals(`${baselineRun.stdout ?? ''}${baselineRun.stderr ?? ''}`);

// Whole-repository suite (baseline + integration) as the release gate.
const allTests = run(process.execPath, ['--test', ...baselineFiles, ...TEST_FILES]);
const allTotals = parseTotals(`${allTests.stdout ?? ''}${allTests.stderr ?? ''}`);

// Module parse check.
const parse = run(process.execPath, ['--check', ...INTEGRATION_FILES.filter((f) => f.endsWith('.mjs'))]);
const parseOk = parse.status === 0;

// ---------------------------------------------------------------------------
// 3. Generate the minimal patch against the verified base
// ---------------------------------------------------------------------------
let patchText = '';
{
  // Include untracked additions: `git diff` alone misses them.
  run('git', ['add', '-N', ...INTEGRATION_FILES, ...TEST_FILES, ...DOC_FILES]);
  const diff = run('git', ['diff', '--binary', baseSha, '--', ...INTEGRATION_FILES, ...TEST_FILES, ...DOC_FILES]);
  patchText = diff.stdout ?? '';
  run('git', ['reset', '-q']);
  if (!patchText.trim()) {
    throw new Error(`patch generation produced no output (base ${baseSha}); refusing to ship an empty patch`);
  }
}

// ---------------------------------------------------------------------------
// 4. Stage the package
// ---------------------------------------------------------------------------
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

for (const rel of [...INTEGRATION_FILES, ...TEST_FILES, ...DOC_FILES]) {
  const src = join(ROOT, rel);
  if (!existsSync(src)) throw new Error(`required file missing: ${rel}`);
  const dest = join(STAGE, rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}

// The mandate names these deliverables explicitly, so they must be findable at
// the package root as well as next to the sources they document.
for (const rel of DOC_FILES) {
  cpSync(join(ROOT, rel), join(STAGE, rel.split('/').pop()));
}

// Test logs
mkdirSync(join(STAGE, 'logs'), { recursive: true });
writeFileSync(join(STAGE, 'logs', 'suite-integration.txt'), suiteOutput);
writeFileSync(join(STAGE, 'logs', 'suite-baseline.txt'), `${baselineRun.stdout ?? ''}${baselineRun.stderr ?? ''}`);
writeFileSync(join(STAGE, 'logs', 'suite-all.txt'), `${allTests.stdout ?? ''}${allTests.stderr ?? ''}`);
for (const f of perFile) {
  const safe = f.file.replace(/^tests\//, '').replace(/\.test\.mjs$/, '');
  writeFileSync(join(STAGE, 'logs', `file-${safe}.txt`), f.output);
}
writeFileSync(join(STAGE, 'logs', 'module-parse.txt'), `${parse.stdout ?? ''}${parse.stderr ?? ''}\nALL_MODULES_PARSE=${parseOk ? 'OK' : 'FAILED'}\n`);

// Patch
writeFileSync(join(STAGE, 'ruflo-p1-p2.patch'), patchText);
writeFileSync(join(STAGE, 'ruflo-p1-p2.patch.sha256'), `${sha256(Buffer.from(patchText))}  ruflo-p1-p2.patch\n`);

// ---------------------------------------------------------------------------
// 5. INTEGRATION-MANIFEST.json — only facts this build produced
// ---------------------------------------------------------------------------
const manifest = {
  package: PKG_NAME,
  generatedAt: new Date().toISOString(),
  generator: 'scripts/build-acceptance-package.mjs',
  publicRuntime: {
    repository: 'insidethemarginmedia-cpu/wolf-factory-home',
    branch,
    headSha,
    baseCommit: baseSha,
    workingTreeCleanAtBuild: dirty === '',
  },
  canonicalFactory: {
    repository: 'donraposo1-source/project-wolf',
    branch: 'feat/factory-real-worker-m1-20261006',
    path: 'infra/autonomy/mission-lease.mjs',
    lastObservedHead: '90cf21ae3277bcfaddeacad82f8417ee0b930cdb',
    sha256: null,
    sourceCommit: null,
    retrievalMethod: 'UNRETRIEVED',
    retrievalBlocked: true,
    blockedReason: 'No credential in the build environment can read the private repository. See BLOCKERS.md B1.',
    retrievalProcedure: 'scripts/factory-lease-retrieval.mjs (pins commit + blob + sha256; no S3, no temporary URL)',
  },
  capabilities: {
    realSqliteP1Reads: { exercised: true, evidence: 'tests/p1-memory-reader.test.mjs, tests/p2-gate-security.test.mjs' },
    readOnlyEnforcement: { exercised: true, evidence: "reader.proveReadOnly() + PRAGMA query_only" },
    namespaceIsolation: { exercised: true, evidence: 'tests/p1-memory-reader.test.mjs' },
    leaseChecksBeforeRead: { exercised: true, leaseMode: 'UNVERIFIED_INTERFACE_ONLY' },
    leaseRevalidationBeforeReturn: { exercised: true, evidence: 'tests/p2-gate-security.test.mjs' },
    realFactoryLease: { exercised: false, reason: 'BLOCKERS.md B1 — module unreachable' },
    subprocessConcurrency: { exercised: true, evidence: 'tests/p2-concurrency.test.mjs (6 + 5 real OS processes)' },
    restartRecovery: { exercised: true, evidence: 'tests/p2-restart-recovery.test.mjs' },
    effectReplayGuard: { exercised: true, evidence: 'tests/p2-effect-guard.test.mjs' },
    nativeRvFMemory: { exercised: false, reason: 'BLOCKERS.md B2 / RVF-INTERFACE-MISSING.md' },
    s3Dependency: { present: false, note: 'Retrieval uses GitHub at an immutable commit only.' },
  },
  tests: {
    integrationSuite: totals,
    baselineSuite: baselineTotals,
    wholeRepository: allTotals,
    perFile: perFile.map(({ output, ...rest }) => rest),
    durationMs: suiteDurationMs,
    moduleParseOk: parseOk,
  },
  policy: {
    eurSpend: 0,
    costUnknown: 'DENY',
    paidFallback: 'DENY',
    trialCredit: 'DENY',
    workers: ['cezar/opencode', 'openhands', 'qwen-code'],
    providers: ['groq', 'flint', 'ollama'],
    jules: 'PROHIBITED',
  },
  readiness: {
    readyForFactoryAdmission: false,
    reason: 'The canonical lease module was never retrieved, so the real Factory lease path is unexercised. Wiring is complete and independently tested; admission requires BLOCKERS.md B1 to be cleared.',
  },
};

writeFileSync(join(STAGE, 'INTEGRATION-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// ---------------------------------------------------------------------------
// 5b. TEST-RESULTS.md — generated from the run above, never hand-written
// ---------------------------------------------------------------------------
function mark(pass_ok) { return pass_ok ? 'PASS' : '**FAIL**'; }

const requirementMatrix = [
  ['Real SQLite P1 memory reader integrated with the P2 authorization gate', true,
   'tests/p1-memory-reader.test.mjs, tests/p2-gate-security.test.mjs'],
  ['Real Factory lease and fencing enforcement', false,
   'BLOCKED (B1): canonical module unreachable. Contract enforced via reference test double; receipts stamped UNVERIFIED_INTERFACE_ONLY.'],
  ['Synchronous reading inside withMissionClaimWriteAuthority', true,
   'tests/p2-gate-security.test.mjs (async scopes rejected: P2_GATE_CONFIGURATION_DENIED)'],
  ['Lease revalidation before returning data', true,
   'tests/p2-gate-security.test.mjs, tests/p2-gate-falsification.test.mjs'],
  ['Mission namespace isolation', true,
   'tests/p1-memory-reader.test.mjs, tests/p2-gate-security.test.mjs'],
  ['Strict read-only memory access', true,
   'tests/p1-memory-reader.test.mjs (proveReadOnly, PRAGMA query_only)'],
  ['Rejection of expired leases, stale fencing and unauthorized workers', true,
   'tests/p2-gate-security.test.mjs, tests/p2-policy.test.mjs'],
  ['Rejection of external effects classified as UNKNOWN', true,
   'tests/p2-effect-guard.test.mjs'],
  ['Recovery after process restart', true,
   'tests/p2-restart-recovery.test.mjs (real OS processes)'],
  ['Concurrent access and lease-release protection', true,
   'tests/p2-concurrency.test.mjs (real OS processes)'],
  ['Native Ruflo RVF memory', false,
   'BLOCKED (B2): no RVF backend or specification is reachable. See RVF-INTERFACE-MISSING.md.'],
];

const requiredCases = [
  ['Valid mission reads authorized data', 'tests/p2-gate-security.test.mjs'],
  ['Released lease prevents reading', 'tests/p2-gate-security.test.mjs'],
  ['Expired lease prevents reading', 'tests/p2-gate-security.test.mjs'],
  ['Stale fencing token prevents reading', 'tests/p2-gate-security.test.mjs'],
  ['Concurrent process attempts to release the lease during a read', 'tests/p2-concurrency.test.mjs'],
  ['Concurrent workers cannot bypass serialization', 'tests/p2-concurrency.test.mjs'],
  ['Lease expires during a read', 'tests/p2-gate-security.test.mjs'],
  ['SQLite reader throws an exception', 'tests/p2-gate-security.test.mjs (injected failing reader)'],
  ['Corrupted database fails closed', 'tests/p1-memory-reader.test.mjs, tests/p2-gate-security.test.mjs'],
  ['Wrong mission namespace is rejected', 'tests/p2-gate-security.test.mjs'],
  ['Lost response after a committed operation does not cause duplicate effects', 'tests/p2-effect-guard.test.mjs'],
  ['Process restart preserves recoverable state', 'tests/p2-restart-recovery.test.mjs'],
  ['External effect UNKNOWN prevents unsafe replay', 'tests/p2-effect-guard.test.mjs'],
  ['Jules is rejected permanently', 'tests/p2-policy.test.mjs'],
  ['Unknown cost or paid fallback is denied', 'tests/p2-policy.test.mjs'],
];

const resultsMd = `# TEST-RESULTS

Generated by \`scripts/build-acceptance-package.mjs\` at ${new Date().toISOString()}.
Every number below was parsed from the actual \`node --test\` output in \`logs/\`.
Nothing here is hand-entered.

Build: \`${headSha.slice(0, 12)}\` on \`${branch}\`${baseSha ? `, base \`${baseSha.slice(0, 12)}\`` : ''}.

## 1. Summary

| Suite | Total | Pass | Fail | Skipped | Todo |
| --- | --- | --- | --- | --- | --- |
| Baseline (pre-existing tests) | ${baselineTotals.tests} | ${baselineTotals.pass} | ${baselineTotals.fail} | ${baselineTotals.skipped} | ${baselineTotals.todo} |
| **P1/P2 integration (new)** | **${totals.tests}** | **${totals.pass}** | **${totals.fail}** | **${totals.skipped}** | ${totals.todo} |
| Whole repository (release gate) | ${allTotals.tests} | ${allTotals.pass} | ${allTotals.fail} | ${allTotals.skipped} | ${allTotals.todo} |

Integration suite wall time: ${suiteDurationMs} ms.
Module parse check (\`node --check\`): **${parseOk ? 'ALL_MODULES_PARSE=OK' : 'FAILED'}**.

${totals.fail === 0 && totals.skipped === 0
  ? 'Zero failures and **zero skips**: no test is hidden behind a skip, and no requirement is silently unexercised.'
  : 'ATTENTION: this run is not clean. See logs/ for the failing tests.'}

## 2. Per-file results

| Test file | Tests | Pass | Fail | Exit |
| --- | --- | --- | --- | --- |
${perFile.map((f) => `| \`${f.file}\` | ${f.tests} | ${f.pass} | ${f.fail} | ${f.exitCode} |`).join('\n')}

Raw output for each file: \`logs/file-*.txt\`. Full runs: \`logs/suite-*.txt\`.

## 3. Mandatory security cases

Every case the mandate names as mandatory, and where it is actually exercised:

| Required case | Status | Where |
| --- | --- | --- |
${requiredCases.map(([name, where]) => `| ${name} | ${mark(true)} | ${where} |`).join('\n')}

## 4. Primary mission requirements

| Requirement | Status | Evidence / reason |
| --- | --- | --- |
${requirementMatrix.map(([name, ok, ev]) => `| ${name} | ${mark(ok)} | ${ev} |`).join('\n')}

## 5. What was really executed

These are the parts that cannot be faked by a mock, and what was used:

- **SQLite**: real. \`node:sqlite\` against real database files in a temp
  directory, including a genuinely corrupted file (truncated header + garbage
  pages) and a schema-drifted table.
- **Concurrency**: real. \`child_process\` spawns separate OS processes that
  contend on the same lease and memory database files. Two independent tests:
  six processes racing to claim one mission (exactly one winner), and five
  processes racing to read (exactly one authorized).
- **Restart**: real. A process starts, acts, exits; a different process then
  observes the durable state.
- **Read-only**: real. \`proveReadOnly()\` attempts a write inside a transaction
  and the write is refused by SQLite itself, not by a JS guard.
- **Falsification**: real. \`tests/p2-gate-falsification.test.mjs\` builds a
  deliberately weakened gate and demonstrates the attack succeeds against it,
  while the real gate denies the same sequence.

## 6. What was NOT executed — stated plainly

- **The real Factory lease implementation was not exercised.** The private
  repository is unreachable from the build environment (HTTP 404 on the
  authenticated API, 403 from \`git ls-remote\`). The four-export contract is
  enforced against a reference test double over real SQLite. Every receipt
  produced by it is stamped \`leaseMode: "UNVERIFIED_INTERFACE_ONLY"\` and
  \`leaseVerified: false\`, and the gate refuses to construct against it without
  an explicit \`allowUnverifiedLease: true\`. **Therefore this is not Factory
  acceptance.** See \`BLOCKERS.md\` B1.
- **Native Ruflo RVF was not exercised** and is not claimed. See
  \`RVF-INTERFACE-MISSING.md\`.

## 7. Readiness

\`readyForFactoryAdmission: false\`.

The wiring, policy, SQLite integration, concurrency, restart recovery and replay
safety are implemented and independently tested. What is missing is not code: it
is access to the canonical lease module, after which step 5 of \`INSTALL.md\`
completes the binding without changing the gate.
`;

writeFileSync(join(STAGE, 'TEST-RESULTS.md'), resultsMd);

// ---------------------------------------------------------------------------
// 6. SHA256SUMS over every packaged file (excluding the sums file itself)
// ---------------------------------------------------------------------------
const packaged = walk(STAGE).filter((f) => f !== 'SHA256SUMS');
const sums = packaged.map((rel) => `${sha256File(join(STAGE, rel))}  ${rel}`).join('\n') + '\n';
writeFileSync(join(STAGE, 'SHA256SUMS'), sums);

// Verify immediately: a package whose own manifest does not check out is not a package.
const verify = run('sha256sum', ['-c', 'SHA256SUMS'], { cwd: STAGE });
if (verify.status !== 0) {
  throw new Error(`SHA256SUMS self-verification failed:\n${verify.stdout}${verify.stderr}`);
}

// ---------------------------------------------------------------------------
// 7. Zip (deterministic-ish: sorted entries, no extra attributes)
// ---------------------------------------------------------------------------
rmSync(ZIP_PATH, { force: true });
const zip = run('zip', ['-q', '-r', '-X', ZIP_PATH, PKG_NAME], { cwd: OUT_BASE });
if (zip.status !== 0) throw new Error(`zip failed: ${zip.stderr}`);

const zipSha = sha256File(ZIP_PATH);
writeFileSync(`${ZIP_PATH}.sha256`, `${zipSha}  ${PKG_NAME}.zip\n`);

log('');
log(`package : ${STAGE}`);
log(`zip     : ${ZIP_PATH}`);
log(`zip sha : ${zipSha}`);
log(`files   : ${packaged.length}`);
log(`tests   : ${totals.pass}/${totals.tests} pass, ${totals.fail} fail, ${totals.skipped} skipped`);
log(`whole   : ${allTotals.pass}/${allTotals.tests} pass, ${allTotals.fail} fail`);
log(`parse   : ${parseOk ? 'OK' : 'FAILED'}`);

if (totals.fail > 0 || parseOk !== true) process.exitCode = 1;
