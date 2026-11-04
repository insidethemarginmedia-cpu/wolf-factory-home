// P0-B/P0-D static contract for the genuine two-job DBOS/KCT recovery (runner-loss-prepare →
// runner-loss-recover). Read-only workflow analysis: no dispatch, credentials or external effects.
// Live two-job acceptance remains NOT VERIFIED until an authorized workflow_dispatch run executes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../.github/workflows/private-controller-preflight.yml', import.meta.url), 'utf8');
function job(name) { return source.split('\n  ' + name + ':\n')[1]?.split(/\n  [a-z][a-z-]+:\n/)[0]; }
const prepare = job('runner-loss-prepare');
const recover = job('runner-loss-recover');
const integrated = job('integrated-factory');
const order = (text, ...needles) => {
  let last = -1;
  for (const needle of needles) {
    const at = text.indexOf(needle);
    assert.ok(at >= 0, 'missing: ' + needle);
    assert.ok(at > last, 'out of order: ' + needle);
    last = at;
  }
};

test('Job A and Job B are distinct GitHub Actions jobs and B only runs when A succeeded', () => {
  assert.ok(prepare && recover && integrated, 'both recovery jobs must exist');
  assert.match(recover, /needs:\n(\s*- (?:security-tests|runner-loss-prepare|factory-source-admission|integrated-factory)\n)+/);
  assert.ok(recover.includes("needs.runner-loss-prepare.result == 'success'"), 'a crash before the checkpoint must leave Job B skipped, never guessing');
  assert.match(recover, /github\.event_name == 'workflow_dispatch'/);
  assert.ok(recover.includes("github.ref == 'refs/heads/feat/public-runtime-probe-20261022'") && recover.includes("github.ref == 'refs/heads/fix/omega-acceptance-ready-20261028'"));
  assert.match(recover, /github\.actor == 'insidethemarginmedia-cpu'/);
  assert.match(recover, /runs-on: ubuntu-latest/);
  assert.match(prepare, /runs-on: ubuntu-latest/);
});

test('the sealed checkpoint travels through durable Git at an immutable snapshot commit, never through runner-local artifacts', () => {
  assert.equal(/upload-artifact|download-artifact/.test(source), false, 'job-to-job state must not ride ephemeral artifacts');
  assert.match(prepare, /snapshot_sha: \$\{\{ steps\.publish\.outputs\.snapshot_sha \}\}/);
  assert.ok(prepare.includes('FEATURE_CHECKPOINT_PUBLICATION_BEGIN'), 'Job A must seal through the tested publication gate');
  assert.match(recover, /SNAPSHOT_SHA: \$\{\{[^}]*needs\.runner-loss-prepare\.outputs\.snapshot_sha[^}]*\}\}/);
  assert.ok(recover.includes('RUNNER_STATE_RESTORE_GATE_BEGIN'), 'Job B must restore through the tested sealed-envelope gate');
  order(recover,
    'RECOVERY_ROOT_NOT_FRESH',
    'RUNNER_STATE_RESTORE_GATE_BEGIN',
    'raw.githubusercontent.com/insidethemarginmedia-cpu/wolf-factory-home/',
    'restoreSealedRunnerState(process.env',
    'node scripts/wolf-dbos-runner-state.mjs restore');
  assert.ok(recover.includes("ref: ${{ needs.factory-source-admission.outputs.source_sha }}"), 'Job B checks out the same immutable private source');
  assert.ok(recover.includes('WOLF_FACTORY_EXPECTED_SHA: ${{ needs.factory-source-admission.outputs.source_sha }}'), 'the restore gate identity check is wired to the admitted source SHA');
});

test('Job B re-fences from the recovered KCT admission and its guard rejects stale tokens and expired leases', () => {
  assert.match(recover, /runner-loss-admission\.json'\)\,'utf8'\)\)\.fencingToken\+1|runner-loss-admission\.json.{0,40}fencingToken\+1/s);
  order(recover, 'STALE_LEASE_FENCE_REJECTED', 'KCT_LEASE_EXPIRED');
  for (const reason of ['STALE_LEASE_FENCE_REJECTED', 'KCT_LEASE_EXPIRED', 'KCT_AUTHORITY_INACCESSIBLE', 'LEASE_MISSION_IDENTITY_MISMATCH', 'PUBLICATION_LEASE_BUSY', 'MULTIPLE_PUBLICATION_REFS_DENIED']) {
    assert.ok(recover.includes(reason), 'the Job B guard must enforce ' + reason);
  }
  const hooks = [...source.matchAll(/^\s*const hook=(.+);$/gm)];
  assert.equal(hooks.length, 2, 'exactly the two operational jobs install the guard');
  assert.ok(integrated.includes('const hook='), 'first guard copy lives in integrated-factory');
  assert.ok(recover.includes('const hook='), 'second guard copy lives in runner-loss-recover');
});

test('Job B proves one Mission C execution, independent boot identity, then rejects a duplicate wakeup with zero new effects', () => {
  order(recover,
    'WOLF_RESIDENT_MODE=dbos-engineering node infra/autonomy/resident-entrypoint.mjs > "$RUNNER_TEMP/wolf-c.log"',
    'recovery.source.bootId===recovery.recovery.bootId',
    'RUNNER_LOSS_MISSION_C_NOT_VERIFIED',
    'wolf-first-c-proof.json',
    'wolf-duplicate.log',
    'DUPLICATE_WAKEUP_RECONCILIATION_FAILED',
    'WOLF_DUPLICATE_WAKEUP=VERIFIED_NO_NEW_EFFECTS');
  assert.ok(recover.includes('admission.admissionCount!==1'), 'exactly one fenced admission may exist');
  assert.ok(recover.includes('fence.newFence!==fence.oldFence+1') && recover.includes('fence.staleFenceRejected'), 'the recovery fence must advance by one and stale fences must have been rejected');
  const duplicate = recover.slice(recover.indexOf('wolf-duplicate.log'));
  assert.ok(duplicate.includes('test "$(git rev-parse HEAD)" = "$first_head"'), 'a duplicate wakeup must not create a new commit');
  assert.ok(duplicate.includes('test "$remote_head" = "$first_head"'), 'a duplicate wakeup must not move the remote branch');
});

test('both jobs destroy their disposable database and runtime state and verify the destruction', () => {
  order(prepare, 'node scripts/wolf-dbos-runner-state.mjs export', 'WOLF_OUTSIDE_RUNNER_CHECKPOINT', 'Destroy the disposable database and ephemeral controller state', 'EPHEMERAL_STATE_REMAINS');
  assert.ok(prepare.includes('docker stop "$PG_CONTAINER_ID"'), 'Job A must stop its disposable database');
  assert.ok(recover.includes('docker stop "$PG_CONTAINER_ID"'), 'Job B must stop its disposable database');
  assert.ok(integrated.includes('A_STATE_SURVIVED') && recover.includes('B_STATE_SURVIVED'), 'cross-job destruction must be verified on both sides');
  assert.match(recover, /- name: Remove ephemeral SSH publication files\n\s*if: always\(\)/);
});

test('concurrent runs serialize under one non-cancelling concurrency group', () => {
  assert.match(source, /concurrency:\n\s*group: private-controller-preflight\n\s*cancel-in-progress: false/);
});

test('recovery missions use fresh per-run synthetic identities and can never address the protected original run', () => {
  assert.ok(prepare.includes("taskId:'OMEGA_C_'+run"), 'Mission C identity is derived from the fresh run id');
  assert.ok(prepare.includes("workflowID:'wolf-runner-loss-'+run"));
  // The protected identity is read from the sealed intent at runtime; this file must never embed it
  // (tests/omega-b-preservation.test.mjs enforces that carrier restriction repository-wide).
  const intent = JSON.parse(fs.readFileSync(new URL('../docs/checkpoints/runner-loss/41040712384-b-intent.json', import.meta.url), 'utf8'));
  assert.equal(source.includes(intent.runId), false, 'the workflow must never hardcode the protected run');
  assert.equal(source.includes(intent.missionId), false, 'the workflow must never hardcode the protected mission');
  assert.equal(source.includes(intent.executionKey), false, 'the workflow must never hardcode the protected execution identity');
  assert.ok(recover.includes("process.env.WOLF_CROSS_JOB_TEST==='1'&&process.env.GITHUB_JOB==='runner-loss-recover'?1:0"), 'the recovering job leases its own mission identity, never Mission A');
});

test('both recovery jobs keep the zero-cost economic contract in their environment', () => {
  for (const [name, text] of [['runner-loss-prepare', prepare], ['runner-loss-recover', recover]]) {
    assert.match(text, /EUR_SPEND: '0'/, name);
    for (const gate of ['COST_UNKNOWN: DENY', 'PAID_FALLBACK: DENY', 'TRIAL_CREDIT: DENY']) assert.ok(text.includes(gate), name + ' must keep ' + gate);
  }
});
