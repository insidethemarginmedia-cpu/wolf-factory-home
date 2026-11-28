import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {generateKeyPairSync, randomUUID, sign} from 'node:crypto';
import {
  JOURNAL_SCHEMA,
  CALLBACK_SCHEMA,
  acceptWorkerCallback,
  beginDispatch,
  cancelRequest,
  canonicalCallbackBytes,
  claimNext,
  enqueueRequest,
  heartbeat,
  readJournal,
  reconcileJournal,
  recoverExpiredLeases,
  requestIdempotencyKey,
  requestKey,
  settleRequest,
  summarizeJournal,
  transactJournal,
  verifyReceiptChain,
  writeJournal,
} from '../scripts/private-ci-journal.mjs';

const repository = 'donraposo1-source/project-wolf';
const sha = 'b'.repeat(40);
const otherSha = 'c'.repeat(40);
const executorSha = 'd'.repeat(40);
const otherExecutorSha = 'e'.repeat(40);
const start = Date.parse('2026-11-24T00:00:00.000Z');
const approvedExecutorShas = [executorSha];
const keyPair = generateKeyPairSync('ed25519');
const trustedWorkerKeys = {
  'synthetic-worker-v1': keyPair.publicKey.export({type: 'spki', format: 'pem'}),
};

function freshJournal() {
  return readJournal(path.join(os.tmpdir(), `wolf-ci-journal-empty-${process.pid}-${randomUUID()}.json`));
}

function queue(journal, {
  targetSha = sha,
  executionSha = executorSha,
  now = start,
  timeoutMs = 10 * 60_000,
  repositoryName = repository,
} = {}) {
  return enqueueRequest(journal, {
    repository: repositoryName,
    sha: targetSha,
    executorSha: executionSha,
    timeoutMs,
    now,
  });
}

function claim(journal, {owner = 'runner-a', now = start, leaseMs = 60_000, approved = approvedExecutorShas} = {}) {
  return claimNext(journal, {owner, now, leaseMs, approvedExecutorShas: approved});
}

function signedCallback(request, {
  callbackId = `callback-${randomUUID()}`,
  outcome = 'COMPLETED',
  fence = request.fence,
  occurredAt = new Date(start + 10_000).toISOString(),
  targetDigest = request.targetDigest,
  callbackExecutorSha = request.executorSha,
  callbackKey = 'synthetic-worker-v1',
  resultDigest = 'f'.repeat(64),
  signingKey = keyPair.privateKey,
} = {}) {
  const callback = {
    schema: CALLBACK_SCHEMA,
    callbackId,
    requestKey: request.key,
    idempotencyKey: request.idempotencyKey,
    targetDigest,
    executorSha: callbackExecutorSha,
    fence,
    outcome,
    resultDigest,
    occurredAt,
    workerKeyId: callbackKey,
    signature: '',
  };
  callback.signature = sign(null, canonicalCallbackBytes(callback), signingKey).toString('base64url');
  return callback;
}

function tempJournal() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-ci-journal-'));
  return {directory, file: path.join(directory, 'journal.json')};
}

test('repeated exact target deliveries collapse to one stable idempotency key', () => {
  const journal = freshJournal();
  const first = queue(journal);
  assert.equal(first.state, 'ENQUEUED');
  const second = queue(journal, {now: start + 1});
  assert.equal(second.state, 'DUPLICATE');
  assert.equal(Object.keys(journal.requests).length, 1);
  assert.equal(journal.requests[first.key].observations, 2);
  assert.equal(journal.requests[first.key].idempotencyKey, requestIdempotencyKey({repository, sha}));
  assert.equal(journal.requests[first.key].idempotencyKey, second.request.idempotencyKey);
});

test('a duplicate target cannot silently change the verified executor identity', () => {
  const journal = freshJournal();
  queue(journal);
  const conflict = queue(journal, {executionSha: otherExecutorSha});
  assert.equal(conflict.state, 'CONFLICT');
  assert.equal(conflict.reason, 'DUPLICATE_BINDING_MISMATCH');
  assert.equal(journal.requests[requestKey({repository, sha})].executorSha, executorSha);
});

test('only an explicitly approved exact executor SHA can acquire a lease', () => {
  const journal = freshJournal();
  const queued = queue(journal);
  assert.equal(claim(journal, {approved: [otherExecutorSha]}).reason, 'EXECUTOR_SHA_NOT_APPROVED');
  assert.equal(journal.requests[queued.key].state, 'pending');
  const accepted = claim(journal);
  assert.equal(accepted.state, 'CLAIMED');
  assert.equal(accepted.executorSha, executorSha);
  assert.equal(accepted.fence, 1);
  assert.equal(accepted.idempotencyKey, journal.requests[queued.key].idempotencyKey);
  assert.throws(() => enqueueRequest(freshJournal(), {repository, sha, executorSha, timeoutMs: undefined}), /JOURNAL_TIMEOUT_REQUIRED/);
});

test('the oldest request is leased once; a second resident cannot steal or overbook it', () => {
  const journal = freshJournal();
  const first = queue(journal, {now: start});
  const second = queue(journal, {targetSha: otherSha, now: start + 1});
  const claimed = claim(journal, {owner: 'runner-a', now: start});
  assert.equal(claimed.key, first.key);
  assert.equal(claim(journal, {owner: 'runner-b', now: start + 1}).state, 'BUSY');
  const settled = settleRequest(journal, {key: first.key, owner: 'runner-a', fence: claimed.fence, state: 'failed', reason: 'SYNTHETIC_PRE_DISPATCH_FAILURE', now: start + 2});
  assert.equal(settled.state, 'FAILED');
  const next = claim(journal, {owner: 'runner-b', now: start + 3});
  assert.equal(next.state, 'CLAIMED');
  assert.equal(next.key, second.key);
  assert.equal(claim(journal, {owner: 'runner-c', now: start + 4}).state, 'BUSY');
});

test('heartbeat extends only the live owner and exact fencing token, bounded by deadline', () => {
  const journal = freshJournal();
  const queued = queue(journal);
  const lease = claim(journal, {now: start, leaseMs: 30_000});
  const renewed = heartbeat(journal, {key: queued.key, owner: 'runner-a', fence: lease.fence, leaseMs: 60_000, now: start + 10_000});
  assert.equal(renewed.state, 'RENEWED');
  assert.equal(Date.parse(renewed.leaseExpiresAt), start + 70_000);
  assert.equal(heartbeat(journal, {key: queued.key, owner: 'runner-b', fence: lease.fence, now: start + 11_000}).reason, 'LEASE_OWNER_MISMATCH');
  assert.equal(heartbeat(journal, {key: queued.key, owner: 'runner-a', fence: lease.fence + 1, now: start + 11_000}).reason, 'STALE_FENCE');
  assert.equal(journal.requests[queued.key].leaseExpiresAt, renewed.leaseExpiresAt);
});

test('dispatch intent is idempotent and cannot be started by a stale lease', () => {
  const journal = freshJournal();
  const queued = queue(journal);
  const lease = claim(journal, {now: start});
  const first = beginDispatch(journal, {key: queued.key, owner: 'runner-a', fence: lease.fence, now: start + 1_000});
  assert.equal(first.state, 'DISPATCH_MARKED');
  assert.equal(first.idempotencyKey, queued.request.idempotencyKey);
  const repeated = beginDispatch(journal, {key: queued.key, owner: 'runner-a', fence: lease.fence, now: start + 2_000});
  assert.equal(repeated.state, 'DUPLICATE');
  assert.equal(journal.requests[queued.key].dispatchAttempts, 1);
  assert.equal(beginDispatch(journal, {key: queued.key, owner: 'runner-old', fence: lease.fence, now: start + 3_000}).reason, 'LEASE_OWNER_MISMATCH');
});

test('a controlled synthetic worker deduplicates repeated dispatch by the stable idempotency key', () => {
  const journal = freshJournal();
  const queued = queue(journal);
  const lease = claim(journal, {owner: 'runner-a', now: start});
  const worker = {effects: 0, idempotency: new Map()};
  const submit = idempotencyKey => {
    const previous = worker.idempotency.get(idempotencyKey);
    if (previous) return {state: 'DEDUPLICATED', effectId: previous};
    worker.effects += 1;
    const effectId = `synthetic-effect-${worker.effects}`;
    worker.idempotency.set(idempotencyKey, effectId);
    return {state: 'EXECUTED', effectId};
  };
  const marked = beginDispatch(journal, {key: queued.key, owner: 'runner-a', fence: lease.fence, now: start + 1});
  assert.equal(marked.state, 'DISPATCH_MARKED');
  const first = submit(marked.idempotencyKey);
  const duplicateDelivery = submit(marked.idempotencyKey);
  assert.equal(first.state, 'EXECUTED');
  assert.equal(duplicateDelivery.state, 'DEDUPLICATED');
  assert.equal(first.effectId, duplicateDelivery.effectId);
  assert.equal(worker.effects, 1, 'the fake worker applies the external effect only once');
});

test('expired pre-dispatch leases are safely recovered with a larger fence and no duplicate effect', () => {
  const journal = freshJournal();
  const queued = queue(journal);
  const first = claim(journal, {owner: 'runner-a', now: start, leaseMs: 30_000});
  const recovery = recoverExpiredLeases(journal, {now: start + 31_000});
  assert.equal(recovery.state, 'RECOVERED');
  assert.equal(journal.requests[queued.key].state, 'pending');
  assert.equal(journal.requests[queued.key].fence, 1);
  const second = claim(journal, {owner: 'runner-b', now: start + 32_000});
  assert.equal(second.fence, 2);
  assert.equal(second.idempotencyKey, first.idempotencyKey);
  assert.equal(beginDispatch(journal, {key: queued.key, owner: 'runner-a', fence: first.fence, now: start + 33_000}).reason, 'LEASE_OWNER_MISMATCH');
  assert.equal(beginDispatch(journal, {key: queued.key, owner: 'runner-b', fence: second.fence, now: start + 33_000}).state, 'DISPATCH_MARKED');
});

test('an expired dispatched lease enters reconciliation and survives restart until its authentic callback arrives', () => {
  const {directory, file} = tempJournal();
  try {
    const journal = readJournal(file);
    const queued = queue(journal);
    const other = queue(journal, {targetSha: otherSha, now: start + 1});
    writeJournal(file, journal);

    const moduleUrl = new URL('../scripts/private-ci-journal.mjs', import.meta.url).href;
    const crashWorker = `
      import fs from 'node:fs';
      import {transactJournal, claimNext, beginDispatch} from ${JSON.stringify(moduleUrl)};
      const file = process.env.SYNTHETIC_JOURNAL;
      const now = Number(process.env.SYNTHETIC_NOW);
      const lease = transactJournal(file, state => claimNext(state, {
        owner: 'runner-a', leaseMs: 30000, now,
        approvedExecutorShas: [process.env.SYNTHETIC_EXECUTOR],
      }));
      if (lease.state !== 'CLAIMED') throw new Error('synthetic lease was not acquired');
      const dispatch = transactJournal(file, state => beginDispatch(state, {
        key: lease.key, owner: 'runner-a', fence: lease.fence, now: now + 1000,
      }));
      if (dispatch.state !== 'DISPATCH_MARKED') throw new Error('synthetic dispatch was not marked');
      fs.writeFileSync(process.env.SYNTHETIC_EFFECT, JSON.stringify({
        idempotencyKey: dispatch.idempotencyKey,
        effectId: 'synthetic-effect-1',
      }), {mode: 0o600});
      process.exit(73); // abrupt worker loss after the effect, before its callback
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', crashWorker], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SYNTHETIC_JOURNAL: file,
        SYNTHETIC_EFFECT: path.join(directory, 'effect.json'),
        SYNTHETIC_NOW: String(start),
        SYNTHETIC_EXECUTOR: executorSha,
      },
    });
    assert.equal(child.error, undefined, child.stderr || 'synthetic worker process failed to start');
    assert.equal(child.status, 73, child.stderr);

    const externalEffect = JSON.parse(fs.readFileSync(path.join(directory, 'effect.json'), 'utf8'));
    assert.equal(externalEffect.idempotencyKey, queued.request.idempotencyKey);
    const restarted = readJournal(file);
    assert.equal(restarted.requests[queued.key].effectState, 'STARTED');
    const recovery = recoverExpiredLeases(restarted, {now: start + 31_000});
    assert.equal(recovery.state, 'RECONCILIATION_REQUIRED');
    assert.equal(restarted.requests[queued.key].state, 'reconciling');
    assert.equal(claim(restarted, {owner: 'runner-b', now: start + 32_000}).state, 'RECONCILIATION_REQUIRED');
    writeJournal(file, restarted);

    const afterRestart = readJournal(file);
    const callback = signedCallback(afterRestart.requests[queued.key], {occurredAt: new Date(start + 10_000).toISOString()});
    const result = acceptWorkerCallback(afterRestart, {callback, trustedWorkerKeys, now: start + 40_000});
    assert.equal(result.state, 'TERMINAL_RECONCILED');
    assert.equal(afterRestart.requests[queued.key].state, 'completed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'effect.json'), 'utf8')).effectId, 'synthetic-effect-1', 'recovery consumed the delayed receipt without executing a duplicate effect');
    assert.equal(afterRestart.requests[other.key].state, 'pending');
    assert.equal(reconcileJournal(afterRestart, {now: start + 41_000}).state, 'CONSISTENT');
    assert.equal(verifyReceiptChain(afterRestart).state, 'INTACT');
    writeJournal(file, afterRestart);

    const finalRestart = readJournal(file);
    assert.equal(finalRestart.requests[queued.key].state, 'completed');
    assert.equal(reconcileJournal(finalRestart).terminalCount, 1);
    assert.equal(summarizeJournal(finalRestart).liveAcceptance, false);
    const serializedSummary = JSON.stringify(summarizeJournal(finalRestart));
    assert.doesNotMatch(serializedSummary, new RegExp(sha));
    assert.doesNotMatch(serializedSummary, /donraposo1-source\/project-wolf/);
    assert.equal(directory.length > 0, true);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('authentic callback replay is idempotent; conflicting callback identity is denied', () => {
  const journal = freshJournal();
  const queued = queue(journal);
  const lease = claim(journal, {now: start});
  beginDispatch(journal, {key: queued.key, owner: 'runner-a', fence: lease.fence, now: start + 1});
  const callback = signedCallback(journal.requests[queued.key]);
  assert.equal(acceptWorkerCallback(journal, {callback, trustedWorkerKeys, now: start + 20_000}).state, 'TERMINAL_RECONCILED');
  const receiptCount = journal.receipts.length;
  assert.equal(acceptWorkerCallback(journal, {callback, trustedWorkerKeys, now: start + 21_000}).state, 'DUPLICATE');
  assert.equal(journal.receipts.length, receiptCount);

  const rotatedWorker = generateKeyPairSync('ed25519');
  const sameIdDifferentKey = signedCallback(journal.requests[queued.key], {
    callbackId: callback.callbackId,
    signingKey: rotatedWorker.privateKey,
  });
  const rotatedTrust = {
    'synthetic-worker-v1': rotatedWorker.publicKey.export({type: 'spki', format: 'pem'}),
  };
  assert.equal(acceptWorkerCallback(journal, {callback: sameIdDifferentKey, trustedWorkerKeys: rotatedTrust, now: start + 21_500}).reason, 'CALLBACK_ID_CONFLICT');

  const conflict = signedCallback(journal.requests[queued.key], {
    callbackId: callback.callbackId,
    outcome: 'FAILED',
    resultDigest: 'a'.repeat(64),
  });
  assert.equal(acceptWorkerCallback(journal, {callback: conflict, trustedWorkerKeys, now: start + 22_000}).reason, 'CALLBACK_ID_CONFLICT');
});

test('callback signatures, target commitment, and executor identity are independently enforced', () => {
  const journal = freshJournal();
  const queued = queue(journal);
  const lease = claim(journal, {now: start});
  beginDispatch(journal, {key: queued.key, owner: 'runner-a', fence: lease.fence, now: start + 1});

  const unsigned = signedCallback(journal.requests[queued.key]);
  unsigned.signature = 'A'.repeat(86);
  assert.equal(acceptWorkerCallback(journal, {callback: unsigned, trustedWorkerKeys, now: start + 20_000}).reason, 'CALLBACK_SIGNATURE_INVALID');

  const untrusted = signedCallback(journal.requests[queued.key], {callbackKey: 'untrusted-worker'});
  assert.equal(acceptWorkerCallback(journal, {callback: untrusted, trustedWorkerKeys, now: start + 20_000}).reason, 'CALLBACK_WORKER_KEY_UNTRUSTED');

  const privateKeyMaterial = signedCallback(journal.requests[queued.key], {callbackKey: 'private-key-material'});
  const withPrivateKey = {
    ...trustedWorkerKeys,
    'private-key-material': keyPair.privateKey.export({type: 'pkcs8', format: 'pem'}),
  };
  assert.equal(acceptWorkerCallback(journal, {callback: privateKeyMaterial, trustedWorkerKeys: withPrivateKey, now: start + 20_000}).reason, 'CALLBACK_WORKER_KEY_INVALID');

  const unknownField = signedCallback(journal.requests[queued.key]);
  unknownField.unreviewedData = 'must-not-be-in-the-envelope';
  assert.equal(acceptWorkerCallback(journal, {callback: unknownField, trustedWorkerKeys, now: start + 20_000}).reason, 'CALLBACK_SHAPE_INVALID');

  const wrongTarget = signedCallback(journal.requests[queued.key], {targetDigest: 'a'.repeat(64)});
  assert.equal(acceptWorkerCallback(journal, {callback: wrongTarget, trustedWorkerKeys, now: start + 20_000}).reason, 'CALLBACK_TARGET_MISMATCH');

  const wrongExecutor = signedCallback(journal.requests[queued.key], {callbackExecutorSha: otherExecutorSha});
  assert.equal(acceptWorkerCallback(journal, {callback: wrongExecutor, trustedWorkerKeys, now: start + 20_000}).reason, 'CALLBACK_EXECUTOR_MISMATCH');
});

test('a verified NO_EFFECT callback permits one fenced retry with the same idempotency key', () => {
  const journal = freshJournal();
  const queued = queue(journal);
  const first = claim(journal, {owner: 'runner-a', now: start});
  beginDispatch(journal, {key: queued.key, owner: 'runner-a', fence: first.fence, now: start + 1});
  const noEffect = signedCallback(journal.requests[queued.key], {outcome: 'NO_EFFECT', callbackId: 'callback-no-effect-01'});
  const safeRetry = acceptWorkerCallback(journal, {callback: noEffect, trustedWorkerKeys, now: start + 20_000});
  assert.equal(safeRetry.state, 'SAFE_TO_RETRY');
  assert.equal(journal.requests[queued.key].state, 'pending');
  assert.equal(acceptWorkerCallback(journal, {callback: noEffect, trustedWorkerKeys, now: start + 21_000}).state, 'DUPLICATE');

  const second = claim(journal, {owner: 'runner-b', now: start + 22_000});
  assert.equal(second.fence, first.fence + 1);
  assert.equal(second.idempotencyKey, first.idempotencyKey);
  const stale = signedCallback(journal.requests[queued.key], {fence: first.fence, callbackId: 'callback-stale-fence-01'});
  assert.equal(acceptWorkerCallback(journal, {callback: stale, trustedWorkerKeys, now: start + 23_000}).reason, 'CALLBACK_STALE_FENCE');

  beginDispatch(journal, {key: queued.key, owner: 'runner-b', fence: second.fence, now: start + 24_000});
  const completed = signedCallback(journal.requests[queued.key], {fence: second.fence, callbackId: 'callback-completed-02', occurredAt: new Date(start + 30_000).toISOString()});
  assert.equal(acceptWorkerCallback(journal, {callback: completed, trustedWorkerKeys, now: start + 31_000}).state, 'TERMINAL_RECONCILED');
  assert.equal(journal.requests[queued.key].state, 'completed');
  assert.equal(reconcileJournal(journal).state, 'CONSISTENT');
});

test('cancellation is cooperative after dispatch and terminal only after a verified worker outcome', () => {
  const journal = freshJournal();
  const queued = queue(journal);
  const lease = claim(journal, {now: start, leaseMs: 30_000});
  beginDispatch(journal, {key: queued.key, owner: 'runner-a', fence: lease.fence, now: start + 1});
  assert.equal(cancelRequest(journal, {key: queued.key, now: start + 2}).state, 'CANCEL_REQUESTED');
  assert.equal(heartbeat(journal, {key: queued.key, owner: 'runner-a', fence: lease.fence, now: start + 3}).state, 'CANCEL_REQUESTED');
  assert.equal(claim(journal, {owner: 'runner-b', now: start + 4}).state, 'BUSY');

  recoverExpiredLeases(journal, {now: start + 31_000});
  assert.equal(journal.requests[queued.key].state, 'reconciling');
  const callback = signedCallback(journal.requests[queued.key], {outcome: 'CANCELLED', callbackId: 'callback-cancelled-01', occurredAt: new Date(start + 10_000).toISOString()});
  assert.equal(acceptWorkerCallback(journal, {callback, trustedWorkerKeys, now: start + 32_000}).state, 'TERMINAL_RECONCILED');
  assert.equal(journal.requests[queued.key].state, 'cancelled');
  assert.equal(reconcileJournal(journal).state, 'CONSISTENT');
});

test('deadline before dispatch becomes terminal; deadline after dispatch requires reconciliation', () => {
  const pending = freshJournal();
  const expired = queue(pending, {timeoutMs: 1_000});
  const beforeStart = recoverExpiredLeases(pending, {now: start + 1_001});
  assert.equal(beforeStart.state, 'RECOVERED');
  assert.equal(pending.requests[expired.key].state, 'timed_out');
  assert.equal(reconcileJournal(pending).state, 'CONSISTENT');

  const active = freshJournal();
  const queued = queue(active, {timeoutMs: 5_000});
  const lease = claim(active, {now: start, leaseMs: 30_000});
  beginDispatch(active, {key: queued.key, owner: 'runner-a', fence: lease.fence, now: start + 1_000});
  recoverExpiredLeases(active, {now: start + 5_001});
  assert.equal(active.requests[queued.key].state, 'reconciling');
  assert.equal(claim(active, {owner: 'runner-b', now: start + 5_002}).state, 'RECONCILIATION_REQUIRED');
  const lateButAuthentic = signedCallback(active.requests[queued.key], {occurredAt: new Date(start + 4_000).toISOString(), callbackId: 'callback-late-complete-01'});
  assert.equal(acceptWorkerCallback(active, {callback: lateButAuthentic, trustedWorkerKeys, now: start + 10_000}).state, 'TERMINAL_RECONCILED');
  assert.equal(active.requests[queued.key].state, 'completed');
});

test('local settlement cannot forge completion or hide an uncertain external effect', () => {
  const journal = freshJournal();
  const queued = queue(journal);
  const lease = claim(journal, {now: start});
  assert.equal(settleRequest(journal, {key: queued.key, owner: 'runner-a', fence: lease.fence, state: 'completed', now: start + 1}).reason, 'VERIFIED_CALLBACK_REQUIRED');
  beginDispatch(journal, {key: queued.key, owner: 'runner-a', fence: lease.fence, now: start + 2});
  assert.equal(settleRequest(journal, {key: queued.key, owner: 'runner-a', fence: lease.fence, state: 'failed', now: start + 3}).reason, 'RECONCILIATION_REQUIRED');
  assert.equal(journal.requests[queued.key].state, 'leased');
});

test('pending cancellation is terminal and never silently re-arms on duplicate delivery', () => {
  const journal = freshJournal();
  const queued = queue(journal);
  assert.equal(cancelRequest(journal, {key: queued.key, now: start + 1}).state, 'CANCELLED');
  assert.equal(queue(journal, {now: start + 2}).state, 'DUPLICATE');
  assert.equal(journal.requests[queued.key].state, 'cancelled');
  assert.equal(claim(journal, {now: start + 3}).state, 'IDLE');
  assert.equal(reconcileJournal(journal).state, 'CONSISTENT');
});

test('terminal receipts form a tamper-evident chain and public summaries omit raw target identity', () => {
  const journal = freshJournal();
  const queued = queue(journal);
  cancelRequest(journal, {key: queued.key, now: start + 1});
  assert.equal(cancelRequest(journal, {key: queued.key, now: start + 2}).state, 'DUPLICATE');
  assert.equal(verifyReceiptChain(journal).state, 'INTACT');
  const summary = summarizeJournal(journal);
  assert.equal(summary.receiptCount, 3);
  assert.equal(summary.credentialsPrinted, false);
  assert.equal(summary.privateSourcePublished, false);
  assert.equal(summary.liveAcceptance, false);
  const safe = JSON.stringify(summary);
  assert.doesNotMatch(safe, new RegExp(sha));
  assert.doesNotMatch(safe, /donraposo1-source\/project-wolf/);

  journal.receipts[0].resultDigest = 'a'.repeat(64);
  assert.equal(verifyReceiptChain(journal).state, 'TAMPERED');
  assert.equal(reconcileJournal(journal).state, 'BLOCKED');
});

test('journal snapshots survive restart and corrupted or truncated state fails closed', () => {
  const {directory, file} = tempJournal();
  try {
    const journal = readJournal(file);
    const queued = queue(journal);
    writeJournal(file, journal);
    const reloaded = readJournal(file);
    assert.equal(reloaded.schema, JOURNAL_SCHEMA);
    assert.equal(Object.keys(reloaded.requests).length, 1);
    assert.equal(reloaded.requests[queued.key].state, 'pending');

    const altered = JSON.parse(fs.readFileSync(file, 'utf8'));
    altered.requests[queued.key].state = 'completed';
    fs.writeFileSync(file, JSON.stringify(altered));
    assert.throws(() => readJournal(file), /JOURNAL_INTEGRITY_FAILED/);
    fs.writeFileSync(file, '{not json');
    assert.throws(() => readJournal(file), /JOURNAL_CORRUPT/);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('legacy leased and terminal records migrate to reconciliation instead of empty or replayable state', () => {
  const {directory, file} = tempJournal();
  try {
    const oldKey = requestKey({repository, sha});
    fs.writeFileSync(file, JSON.stringify({
      schema: 'wolf.private-ci.journal/v1',
      order: [oldKey],
      requests: {
        [oldKey]: {
          key: oldKey, repository, sha, state: 'leased', attempts: 1,
          createdAt: new Date(start).toISOString(), leaseOwner: 'old-runner',
          leaseExpiresAt: new Date(start + 30_000).toISOString(),
          reason: 'access-token=must-not-be-published',
          privateToken: 'synthetic-secret-marker',
        },
      },
    }));
    const migrated = readJournal(file);
    assert.equal(migrated.schema, JOURNAL_SCHEMA);
    assert.equal(migrated.requests[oldKey].state, 'reconciling');
    assert.equal(migrated.requests[oldKey].reconciliation.reason, 'LEGACY_STATE_HAS_NO_FENCED_RECEIPT');
    assert.equal(migrated.requests[oldKey].reason, 'LEGACY_REASON_UNAVAILABLE');
    assert.equal(Object.hasOwn(migrated.requests[oldKey], 'privateToken'), false);
    assert.equal(migrated.requests[oldKey].executorSha, null);
    assert.equal(migrated.requests[oldKey].deadlineAt, null);
    assert.equal(claim(migrated, {now: start + 31_000}).state, 'RECONCILIATION_REQUIRED');
    writeJournal(file, migrated);
    assert.equal(readJournal(file).requests[oldKey].state, 'reconciling');
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('transactJournal serializes writers and reclaims only a provably dead stale lock', () => {
  const {directory, file} = tempJournal();
  try {
    const journal = readJournal(file);
    queue(journal);
    writeJournal(file, journal);
    fs.writeFileSync(`${file}.lock`, JSON.stringify({pid: process.pid, ownerToken: 'held', acquiredAt: new Date().toISOString()}));
    assert.throws(() => transactJournal(file, state => state), /JOURNAL_LOCKED/);
    fs.unlinkSync(`${file}.lock`);

    fs.writeFileSync(`${file}.lock`, JSON.stringify({pid: 2_147_483_647, ownerToken: 'dead', acquiredAt: new Date(start - 60_000).toISOString()}));
    const result = transactJournal(file, state => ({state: state.schema}));
    assert.equal(result.state, JOURNAL_SCHEMA);
    assert.equal(readJournal(file).schema, JOURNAL_SCHEMA);
    assert.equal(fs.existsSync(`${file}.lock`), false);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('the CLI enqueues, claims, heartbeats, marks dispatch, recovers and reports sanitized state', async () => {
  const {runJournalCli} = await import('../scripts/private-ci-journal-cli.mjs');
  const {directory, file} = tempJournal();
  try {
    const env = {
      WOLF_CI_JOURNAL: file,
      WOLF_CI_REPOSITORY: repository,
      WOLF_CI_SHA: sha,
      WOLF_CI_EXECUTOR_SHA: executorSha,
      WOLF_CI_APPROVED_EXECUTOR_SHAS: executorSha,
      WOLF_CI_TIMEOUT_MS: '120000',
      WOLF_CI_LEASE_MS: '30000',
      WOLF_CI_LEASE_OWNER: 'test-runner-99',
      WOLF_CI_TEST_NOW: String(start),
      GITHUB_RUN_ID: '99',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_EVENT_NAME: 'push',
    };
    const enqueued = runJournalCli(['enqueue'], env);
    assert.equal(enqueued.exitCode, 0);
    assert.equal(enqueued.output.state, 'ENQUEUED');
    assert.equal(enqueued.output.targetDigest.length, 64);
    assert.equal(Object.hasOwn(enqueued.output, 'sha'), false);

    const claimed = runJournalCli(['claim'], env);
    assert.equal(claimed.output.state, 'CLAIMED');
    assert.equal(claimed.output.executorSha, executorSha);
    assert.equal(claimed.output.fence, 1);
    const heartbeatResult = runJournalCli(['heartbeat', '--key', claimed.output.key, '--fence', '1', '--lease-ms', '60000'], {...env, WOLF_CI_TEST_NOW: String(start + 10_000)});
    assert.equal(heartbeatResult.output.state, 'RENEWED');
    const begin = runJournalCli(['begin', '--key', claimed.output.key, '--fence', '1'], {...env, WOLF_CI_TEST_NOW: String(start + 11_000)});
    assert.equal(begin.output.state, 'DISPATCH_MARKED');
    const repeat = runJournalCli(['begin', '--key', claimed.output.key, '--fence', '1'], {...env, WOLF_CI_TEST_NOW: String(start + 12_000)});
    assert.equal(repeat.output.state, 'DUPLICATE');

    const recovered = runJournalCli(['recover'], {...env, WOLF_CI_TEST_NOW: String(start + 71_000)});
    assert.equal(recovered.output.state, 'RECONCILIATION_REQUIRED');
    const reconciliation = runJournalCli(['reconcile'], {...env, WOLF_CI_TEST_NOW: String(start + 72_000)});
    assert.equal(reconciliation.output.state, 'RECONCILIATION_REQUIRED');
    assert.equal(reconciliation.output.issues[0].reason, 'LEASE_EXPIRED_OUTCOME_UNKNOWN');
    assert.equal(reconciliation.output.receiptCount, 4);
    assert.equal(reconciliation.output.liveAcceptance, false);
    const status = runJournalCli(['status'], env);
    assert.equal(status.output.counts.reconciling, 1);
    assert.equal(status.output.liveAcceptance, false);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('the CLI refuses a missing journal, malformed executor identity, and unsafe completion', async () => {
  const {runJournalCli} = await import('../scripts/private-ci-journal-cli.mjs');
  assert.equal(runJournalCli(['status'], {}).output.reason, 'JOURNAL_PATH_REQUIRED');
  const {directory, file} = tempJournal();
  try {
    const baseEnv = {
      WOLF_CI_JOURNAL: file,
      WOLF_CI_REPOSITORY: repository,
      WOLF_CI_SHA: sha,
      WOLF_CI_TIMEOUT_MS: '120000',
      WOLF_CI_EXECUTOR_SHA: 'not-a-sha',
      WOLF_CI_LEASE_OWNER: 'test-runner',
      WOLF_CI_APPROVED_EXECUTOR_SHAS: executorSha,
      WOLF_CI_TEST_NOW: String(start),
    };
    assert.equal(runJournalCli(['enqueue'], baseEnv).exitCode, 79);
    const env = {...baseEnv, WOLF_CI_EXECUTOR_SHA: executorSha};
    const queued = runJournalCli(['enqueue'], env);
    const claimed = runJournalCli(['claim'], env);
    const completed = runJournalCli(['settle', '--key', claimed.output.key, '--fence', '1', '--state', 'completed'], env);
    assert.equal(completed.exitCode, 79);
    assert.equal(completed.output.reason, 'VERIFIED_CALLBACK_REQUIRED');
    assert.equal(runJournalCli(['status'], env).output.counts.leased, 1);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
