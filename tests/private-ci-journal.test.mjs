import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claimNext,
  cancelRequest,
  enqueueRequest,
  readJournal,
  requestKey,
  settleRequest,
  summarizeJournal,
  writeJournal,
} from '../scripts/private-ci-journal.mjs';

const repository = 'donraposo1-source/project-wolf';
const sha = 'b'.repeat(40);
const otherSha = 'c'.repeat(40);

function freshJournal() {
  return readJournal(path.join(os.tmpdir(), 'wolf-ci-journal-does-not-exist.json'));
}

test('a repeated trigger for the same commit collapses onto one request', () => {
  const journal = freshJournal();
  const first = enqueueRequest(journal, {repository, sha});
  assert.equal(first.state, 'ENQUEUED');
  const second = enqueueRequest(journal, {repository, sha, reason: 'repository_dispatch'});
  assert.equal(second.state, 'DUPLICATE');
  assert.equal(Object.keys(journal.requests).length, 1);
  assert.equal(journal.requests[first.key].observations, 2);
});

test('a different commit is a different request and both are retained', () => {
  const journal = freshJournal();
  enqueueRequest(journal, {repository, sha});
  enqueueRequest(journal, {repository, sha: otherSha});
  assert.equal(Object.keys(journal.requests).length, 2);
  assert.notEqual(requestKey({repository, sha}), requestKey({repository, sha: otherSha}));
  assert.equal(summarizeJournal(journal).counts.pending, 2);
});

test('the oldest pending request is claimed first and a live lease is never stolen', () => {
  const journal = freshJournal();
  enqueueRequest(journal, {repository, sha, now: '2026-11-24T00:00:00.000Z'});
  enqueueRequest(journal, {repository, sha: otherSha, now: '2026-11-24T00:00:01.000Z'});
  const claimed = claimNext(journal, {owner: 'runner-a', now: Date.parse('2026-11-24T00:01:00.000Z')});
  assert.equal(claimed.state, 'CLAIMED');
  assert.equal(claimed.request.sha, sha);
  assert.equal(claimed.request.attempts, 1);
  const second = claimNext(journal, {owner: 'runner-b', now: Date.parse('2026-11-24T00:02:00.000Z')});
  assert.equal(second.request.sha, otherSha, 'a live lease must not be stolen');
  const idle = claimNext(journal, {owner: 'runner-c', now: Date.parse('2026-11-24T00:03:00.000Z')});
  assert.equal(idle.state, 'IDLE');
});

test('an expired lease is recovered instead of stalling the queue', () => {
  const journal = freshJournal();
  enqueueRequest(journal, {repository, sha, now: '2026-11-24T00:00:00.000Z'});
  claimNext(journal, {owner: 'runner-a', leaseMs: 60000, now: Date.parse('2026-11-24T00:01:00.000Z')});
  const recovered = claimNext(journal, {owner: 'runner-b', leaseMs: 60000, now: Date.parse('2026-11-24T00:05:00.000Z')});
  assert.equal(recovered.state, 'RECOVERED');
  assert.equal(recovered.recoveredFrom, 'runner-a');
  assert.equal(recovered.request.attempts, 2);
});

test('a cancelled request never starts and a completed one is never re-armed', () => {
  const journal = freshJournal();
  const queued = enqueueRequest(journal, {repository, sha});
  assert.equal(cancelRequest(journal, {repository, sha}).state, 'CANCELLED');
  assert.equal(claimNext(journal, {owner: 'runner-a'}).state, 'IDLE');
  assert.equal(enqueueRequest(journal, {repository, sha}).state, 'DUPLICATE');
  assert.equal(journal.requests[queued.key].state, 'cancelled');

  enqueueRequest(journal, {repository, sha: otherSha});
  const claimed = claimNext(journal, {owner: 'runner-a'});
  settleRequest(journal, {key: claimed.key, state: 'completed'});
  assert.equal(cancelRequest(journal, {repository, sha: otherSha}).state, 'DENIED');
  assert.equal(claimNext(journal, {owner: 'runner-b'}).state, 'IDLE');
});

test('the journal round-trips through disk and survives corruption', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-ci-journal-'));
  const file = path.join(dir, 'journal.json');
  const journal = readJournal(file);
  enqueueRequest(journal, {repository, sha});
  writeJournal(file, journal);
  const reloaded = readJournal(file);
  assert.equal(Object.keys(reloaded.requests).length, 1);
  assert.equal(summarizeJournal(reloaded).counts.pending, 1);
  fs.writeFileSync(file, '{not json');
  assert.equal(Object.keys(readJournal(file).requests).length, 0, 'a corrupt journal must fail closed to empty');
  fs.rmSync(dir, {recursive: true, force: true});
});

test('malformed SHAs are rejected', () => {
  const journal = freshJournal();
  assert.throws(() => enqueueRequest(journal, {repository, sha: 'xyz'}), /JOURNAL_SHA_MALFORMED/);
  assert.throws(() => claimNext(journal, {owner: 'x'}) && settleRequest(journal, {key: 'x', state: 'cancelled'}), /JOURNAL_SETTLE_STATE_INVALID/);
});

test('the CLI enqueues, claims, settles and cancels through the journal file', async () => {
  const {runJournalCli} = await import('../scripts/private-ci-journal-cli.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-ci-cli-'));
  const env = {WOLF_CI_JOURNAL: path.join(dir, 'journal.json'), WOLF_CI_REPOSITORY: repository, WOLF_CI_SHA: sha, WOLF_CI_INBOX: path.join(dir, 'inbox'), GITHUB_RUN_ID: '99', GITHUB_EVENT_NAME: 'push'};
  fs.mkdirSync(env.WOLF_CI_INBOX, {recursive: true});

  const enqueued = runJournalCli(['enqueue'], env);
  assert.equal(enqueued.exitCode, 0);
  assert.equal(enqueued.output.state, 'ENQUEUED');

  const claimed = runJournalCli(['claim'], env);
  assert.equal(claimed.output.state, 'CLAIMED');
  assert.equal(claimed.output.sha, sha);

  assert.equal(runJournalCli(['claim'], env).output.state, 'IDLE', 'a live lease must not be double-claimed');

  const settled = runJournalCli(['settle', '--state', 'completed'], env);
  assert.equal(settled.exitCode, 0);
  assert.deepEqual(settled.output.settled, ['COMPLETED']);

  const status = runJournalCli(['status'], env);
  assert.equal(status.output.counts.completed, 1);

  // A caller-supplied SHA overrides the workflow pin, but never a malformed one.
  fs.writeFileSync(path.join(env.WOLF_CI_INBOX, 'request.sha'), otherSha + '\n');
  assert.equal(runJournalCli(['enqueue'], env).output.sha, otherSha);
  fs.writeFileSync(path.join(env.WOLF_CI_INBOX, 'request.sha'), 'not-a-sha\n');
  const rejected = runJournalCli(['enqueue'], env);
  assert.notEqual(rejected.exitCode, 0);
  fs.rmSync(dir, {recursive: true, force: true});
});

test('the CLI refuses to run without a journal path', async () => {
  const {runJournalCli} = await import('../scripts/private-ci-journal-cli.mjs');
  const result = runJournalCli(['status'], {});
  assert.equal(result.exitCode, 2);
  assert.equal(result.output.reason, 'JOURNAL_PATH_REQUIRED');
});
