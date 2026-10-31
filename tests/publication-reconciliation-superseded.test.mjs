// Regression: durable publication reconciliation must distinguish a proven,
// superseded external effect from genuine ambiguity.
//
// Defect reproduced before the fix: when the recorded candidate commit really
// landed but the branch advanced past it (the normal case once the next mission
// or checkpoint publishes), recovery reported CONFLICTING_REMOTE_STATE and the
// journal entry stayed UNKNOWN_UNTIL_RECONCILED forever. Every later
// publishCompareAndSwapCommit for that mission then failed with
// UNKNOWN_EXTERNAL_EFFECT_REPLAY_DENIED, so the mission could never progress and
// no terminal classification was recorded.
//
// The fix confirms the effect only when local Git ancestry proves the recorded
// candidate is contained in the observed tip. It never fetches, never replays the
// push and never infers anything from an absent ref.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  CANONICAL_BRANCH,
  CANONICAL_REPOSITORY,
  publishCompareAndSwapCommit,
  recoverPublicationUncertainty,
} from '../scripts/git-publication-preflight.mjs';

function git(args, cwd) {
  const result = spawnSync('git', args, {cwd, encoding: 'utf8'});
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout.trim();
}

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-reconcile-superseded-'));
  const bare = path.join(tmp, 'remote.git');
  const work = path.join(tmp, 'work');
  spawnSync('git', ['init', '--bare', bare]);
  fs.mkdirSync(work);
  git(['init', '-b', CANONICAL_BRANCH], work);
  git(['config', 'user.email', 'wolf-test@example.invalid'], work);
  git(['config', 'user.name', 'Wolf Test'], work);
  fs.writeFileSync(path.join(work, 'fixture.txt'), 'deterministic-fixture\n');
  git(['add', 'fixture.txt'], work);
  git(['commit', '-m', 'fixture'], work);
  git(['remote', 'add', 'origin', bare], work);
  git(['push', 'origin', `HEAD:refs/heads/${CANONICAL_BRANCH}`], work);
  const s0 = git(['rev-parse', 'HEAD'], work);
  return {tmp, bare, work, s0};
}

const ENV = {WOLF_FACTORY_GIT_TRANSPORT: 'ssh-deploy-key'};

function unknownEntry(overrides) {
  return {
    published: false,
    externalEffectState: 'UNKNOWN_UNTIL_RECONCILED',
    repository: CANONICAL_REPOSITORY,
    branch: CANONICAL_BRANCH,
    baseSha: '1111111111111111111111111111111111111111',
    headSha: '2222222222222222222222222222222222222222',
    missionId: 'OMEGA_B_9101',
    checkpointId: 'wolf-cp-superseded',
    leaseFence: 1,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test('a landed candidate superseded by later publications is confirmed, not left UNKNOWN', () => {
  const {tmp, work, s0} = fixture();
  try {
    // The candidate that actually landed (external effect happened).
    fs.writeFileSync(path.join(work, 'candidate.txt'), 'candidate\n');
    git(['add', 'candidate.txt'], work);
    git(['commit', '-m', 'candidate mission commit'], work);
    const candidateSha = git(['rev-parse', 'HEAD'], work);
    git(['push', 'origin', `HEAD:refs/heads/${CANONICAL_BRANCH}`], work);

    // Later, legitimate publications advance the branch past the candidate.
    fs.writeFileSync(path.join(work, 'next.txt'), 'next mission\n');
    git(['add', 'next.txt'], work);
    git(['commit', '-m', 'next mission commit'], work);
    git(['push', 'origin', `HEAD:refs/heads/${CANONICAL_BRANCH}`], work);
    const advancedTip = git(['rev-parse', 'HEAD'], work);
    assert.notEqual(advancedTip, candidateSha);

    const journalPath = path.join(tmp, 'journal.json');
    const entry = unknownEntry({baseSha: s0, headSha: candidateSha});
    fs.writeFileSync(journalPath, JSON.stringify([entry], null, 2) + '\n');

    const result = recoverPublicationUncertainty({
      journalPath,
      cwd: work,
      env: ENV,
      allowLocalRemoteForTesting: true,
    });

    assert.equal(result.unreconciled.length, 0, 'a proven superseded effect must not stay unreconciled');
    assert.equal(result.recovered.length, 1);
    const recovered = result.recovered[0];
    assert.equal(recovered.externalEffectState, 'VERIFIED');
    assert.equal(recovered.published, true);
    assert.equal(recovered.effectDisposition, 'CONFIRMED_SUPERSEDED');
    assert.equal(recovered.supersededBy, advancedTip);
    // Identity and lineage are preserved exactly.
    assert.equal(recovered.headSha, candidateSha);
    assert.equal(recovered.baseSha, s0);
    assert.equal(recovered.missionId, 'OMEGA_B_9101');
    assert.equal(recovered.checkpointId, 'wolf-cp-superseded');
    assert.equal(recovered.leaseFence, 1);
    assert.equal(recovered.reconciledFrom, 'UNKNOWN_UNTIL_RECONCILED');

    const persisted = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].externalEffectState, 'VERIFIED');
    assert.equal(persisted[0].effectDisposition, 'CONFIRMED_SUPERSEDED');
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('confirming the effect unblocks the mission without replaying the external effect', () => {
  const {tmp, bare, work, s0} = fixture();
  try {
    fs.mkdirSync(path.join(work, 'docs', 'factory-acceptance'), {recursive: true});
    fs.writeFileSync(path.join(work, 'docs', 'factory-acceptance', 'omega-9102-b.py'), 'print(1)\n');
    git(['add', '.'], work);
    git(['commit', '-m', 'mission b'], work);
    const candidateSha = git(['rev-parse', 'HEAD'], work);
    git(['push', 'origin', `HEAD:refs/heads/${CANONICAL_BRANCH}`], work);

    fs.writeFileSync(path.join(work, 'after.txt'), 'after\n');
    git(['add', 'after.txt'], work);
    git(['commit', '-m', 'after'], work);
    git(['push', 'origin', `HEAD:refs/heads/${CANONICAL_BRANCH}`], work);
    const tipBefore = git(['rev-parse', `refs/heads/${CANONICAL_BRANCH}`], bare);

    const journalPath = path.join(tmp, 'journal.json');
    const entry = unknownEntry({baseSha: s0, headSha: candidateSha, missionId: 'OMEGA_B_9102', checkpointId: 'wolf-cp-9102'});
    fs.writeFileSync(journalPath, JSON.stringify([entry], null, 2) + '\n');

    // Before reconciliation the mission is correctly blocked from replaying.
    assert.throws(
      () =>
        publishCompareAndSwapCommit({
          cwd: work,
          env: ENV,
          missionId: 'OMEGA_B_9102',
          checkpointId: 'wolf-cp-9102',
          leaseFence: 1,
          leaseState: {activeFence: 1},
          expectedRemoteSha: s0,
          journalPath,
          allowLocalRemoteForTesting: true,
        }),
      /UNKNOWN_EXTERNAL_EFFECT_REPLAY_DENIED/,
    );

    recoverPublicationUncertainty({journalPath, cwd: work, env: ENV, allowLocalRemoteForTesting: true});

    // After reconciliation the same mission is reported as already completed and
    // the remote ref is untouched: no second external effect.
    const replay = publishCompareAndSwapCommit({
      cwd: work,
      env: ENV,
      missionId: 'OMEGA_B_9102',
      checkpointId: 'wolf-cp-9102',
      leaseFence: 1,
      leaseState: {activeFence: 1},
      expectedRemoteSha: s0,
      journalPath,
      allowLocalRemoteForTesting: true,
    });
    assert.equal(replay.alreadyCompleted, true);
    assert.equal(replay.commitSha, candidateSha);
    assert.equal(git(['rev-parse', `refs/heads/${CANONICAL_BRANCH}`], bare), tipBefore);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

test('rewritten history and absent refs still stay UNKNOWN and never claim an effect', () => {
  const {tmp, bare, work, s0} = fixture();
  try {
    // A divergent commit that was never pushed: rewritten/unrelated history.
    fs.writeFileSync(path.join(work, 'divergent.txt'), 'divergent\n');
    git(['add', 'divergent.txt'], work);
    git(['commit', '-m', 'divergent'], work);
    const divergentSha = git(['rev-parse', 'HEAD'], work);
    git(['reset', '--hard', s0], work);

    // Rewrite the remote tip so it cannot contain the divergent commit.
    fs.writeFileSync(path.join(work, 'rewrite.txt'), 'rewrite\n');
    git(['add', 'rewrite.txt'], work);
    git(['commit', '-m', 'rewrite'], work);
    const rewrittenTip = git(['rev-parse', 'HEAD'], work);
    git(['push', '--force', 'origin', `HEAD:refs/heads/${CANONICAL_BRANCH}`], work);
    assert.notEqual(rewrittenTip, divergentSha);

    const journalPath = path.join(tmp, 'journal.json');
    fs.writeFileSync(
      journalPath,
      JSON.stringify([unknownEntry({baseSha: s0, headSha: divergentSha, missionId: 'OMEGA_B_9103'})], null, 2) + '\n',
    );

    const result = recoverPublicationUncertainty({journalPath, cwd: work, env: ENV, allowLocalRemoteForTesting: true});
    assert.equal(result.recovered.length, 0, 'non-ancestry must never be reported as a confirmed effect');
    assert.equal(result.unreconciled.length, 1);
    assert.equal(result.unreconciled[0].reason, 'CONFLICTING_REMOTE_STATE');
    assert.equal(result.unreconciled[0].ancestryProven, false);

    const persisted = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.equal(persisted[0].externalEffectState, 'UNKNOWN_UNTIL_RECONCILED');
    assert.notEqual(persisted[0].published, true);

    // An absent branch ref is not evidence of anything either.
    const emptyBare = path.join(tmp, 'empty.git');
    spawnSync('git', ['init', '--bare', emptyBare]);
    git(['remote', 'set-url', 'origin', emptyBare], work);
    const absent = recoverPublicationUncertainty({journalPath, cwd: work, env: ENV, allowLocalRemoteForTesting: true});
    assert.equal(absent.recovered.length, 0);
    // A non-existent branch makes `ls-remote --exit-code` fail, which is reported
    // as unverifiable. Either way an absent ref is never treated as proof.
    assert.ok(['REMOTE_UNVERIFIABLE', 'REMOTE_REF_NOT_OBSERVED'].includes(absent.unreconciled[0].reason));
    assert.equal(git(['for-each-ref'], emptyBare), '', 'no ref may be created by reconciliation');
    assert.ok(bare);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});
