// Local fixture CLI for the restartable execution journal.
//
// This surface is not invoked by a production workflow and never dispatches a
// real worker. Every mutation is serialized through transactJournal; callback
// acceptance is available only through the library with explicitly trusted public
// keys. The actual Factory remains on its existing admission path.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  beginDispatch,
  cancelRequest,
  claimNext,
  enqueueRequest,
  heartbeat,
  JOURNAL_POLICY,
  readJournal,
  reconcileJournal,
  recoverExpiredLeases,
  requestKey,
  settleRequest,
  summarizeJournal,
  transactJournal,
} from './private-ci-journal.mjs';

const EXIT = Object.freeze({OK: 0, DEFECT: 1, USAGE: 2, BLOCKED: 78, DENIED: 79});

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] ?? null;
}

function numberArg(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function currentTime(env) {
  if (!env.WOLF_CI_TEST_NOW) return Date.now();
  const numeric = Number(env.WOLF_CI_TEST_NOW);
  return Number.isFinite(numeric) ? numeric : Date.parse(env.WOLF_CI_TEST_NOW);
}

function ownerFor(env) {
  return env.WOLF_CI_LEASE_OWNER
    ?? `gha-${env.GITHUB_RUN_ID ?? 'manual'}-${env.GITHUB_RUN_ATTEMPT ?? '1'}`;
}

function safeOutput(result) {
  if (!result || typeof result !== 'object') return {state: 'FAILED', reason: 'JOURNAL_RESULT_INVALID'};
  const output = {state: result.state ?? 'UNKNOWN'};
  for (const key of ['reason', 'key', 'fence', 'idempotencyKey', 'targetDigest', 'executorSha', 'leaseExpiresAt', 'deadlineAt', 'heartbeatAt', 'requestState', 'receiptHash', 'terminal', 'recovered', 'issues', 'activeCount', 'pendingCount', 'terminalCount', 'receiptCount', 'receiptHead', 'liveAcceptance']) {
    if (result[key] !== undefined) output[key] = result[key];
  }
  return output;
}

function resultExit(state) {
  if (['ENQUEUED', 'DUPLICATE', 'CLAIMED', 'RENEWED', 'DISPATCH_MARKED', 'CANCELLED', 'CANCEL_REQUESTED', 'RECOVERED', 'NOOP', 'SAFE_TO_RETRY', 'TERMINAL_RECONCILED', 'CONSISTENT', 'ACTIVE', 'IDLE', 'BUSY'].includes(state)) return EXIT.OK;
  if (['RECONCILIATION_REQUIRED', 'BLOCKED'].includes(state)) return EXIT.BLOCKED;
  if (['DENIED', 'CONFLICT'].includes(state)) return EXIT.DENIED;
  return EXIT.DEFECT;
}

export function runJournalCli(argv, env = process.env) {
  const command = argv[0];
  const journalPath = env.WOLF_CI_JOURNAL;
  if (!journalPath) return {exitCode: EXIT.USAGE, output: {state: 'FAILED', reason: 'JOURNAL_PATH_REQUIRED'}};
  const repository = env.WOLF_CI_REPOSITORY;
  const owner = ownerFor(env);
  const now = currentTime(env);
  const executeMutation = mutator => {
    try {
      const result = transactJournal(journalPath, mutator);
      const output = safeOutput(result);
      return {exitCode: resultExit(result?.state), output};
    } catch (error) {
      const reason = ['JOURNAL_LOCKED', 'JOURNAL_INTEGRITY_FAILED', 'JOURNAL_CORRUPT', 'JOURNAL_RECEIPT_CHAIN_INVALID'].includes(error?.message)
        ? error.message : 'JOURNAL_MUTATION_FAILED';
      return {exitCode: reason === 'JOURNAL_LOCKED' ? EXIT.BLOCKED : EXIT.DENIED, output: {state: 'BLOCKED', reason}};
    }
  };

  if (command === 'enqueue') {
    const inbox = env.WOLF_CI_INBOX;
    const requestFile = inbox ? path.join(inbox, 'request.sha') : null;
    let explicit = '';
    try { explicit = requestFile && fs.existsSync(requestFile) ? fs.readFileSync(requestFile, 'utf8').trim() : ''; } catch {
      return {exitCode: EXIT.DENIED, output: {state: 'DENIED', reason: 'REQUEST_SHA_UNREADABLE'}};
    }
    const sha = explicit || env.WOLF_CI_SHA;
    const timeoutMs = numberArg(env.WOLF_CI_TIMEOUT_MS);
    return executeMutation(journal => {
      const result = enqueueRequest(journal, {
        repository,
        sha,
        executorSha: env.WOLF_CI_EXECUTOR_SHA,
        timeoutMs,
        reason: env.GITHUB_EVENT_NAME ?? 'manual',
        runId: env.GITHUB_RUN_ID ?? null,
        now,
      });
      if (result.state === 'CONFLICT') return result;
      return {
        state: result.state,
        key: result.key,
        targetDigest: result.request?.targetDigest ?? null,
        idempotencyKey: result.request?.idempotencyKey ?? null,
      };
    });
  }

  if (command === 'claim') {
    const leaseMs = numberArg(env.WOLF_CI_LEASE_MS, 60_000);
    const approvedExecutorShas = String(env.WOLF_CI_APPROVED_EXECUTOR_SHAS ?? '')
      .split(',').map(value => value.trim()).filter(Boolean);
    return executeMutation(journal => claimNext(journal, {owner, leaseMs, now, approvedExecutorShas}));
  }

  if (command === 'begin') {
    const key = argValue(argv, '--key');
    const fence = numberArg(argValue(argv, '--fence'));
    if (!key || fence === null) return {exitCode: EXIT.USAGE, output: {state: 'FAILED', reason: 'LEASE_KEY_AND_FENCE_REQUIRED'}};
    return executeMutation(journal => beginDispatch(journal, {key, owner, fence, now}));
  }

  if (command === 'heartbeat') {
    const key = argValue(argv, '--key');
    const fence = numberArg(argValue(argv, '--fence'));
    const leaseMs = numberArg(argValue(argv, '--lease-ms'), JOURNAL_POLICY.leaseMs);
    if (!key || fence === null) return {exitCode: EXIT.USAGE, output: {state: 'FAILED', reason: 'LEASE_KEY_AND_FENCE_REQUIRED'}};
    return executeMutation(journal => heartbeat(journal, {key, owner, fence, leaseMs, now}));
  }

  if (command === 'cancel') {
    const sha = argValue(argv, '--sha') ?? env.WOLF_CI_SHA;
    if (!sha) return {exitCode: EXIT.USAGE, output: {state: 'FAILED', reason: 'MISSION_SHA_REQUIRED'}};
    return executeMutation(journal => cancelRequest(journal, {
      repository,
      sha,
      reason: argValue(argv, '--reason') ?? 'CANCELLED_BY_OPERATOR',
      now,
    }));
  }

  if (command === 'recover') {
    return executeMutation(journal => {
      const result = recoverExpiredLeases(journal, {now});
      return {state: result.state, recovered: result.recovered.length};
    });
  }

  if (command === 'settle') {
    const key = argValue(argv, '--key');
    const fence = numberArg(argValue(argv, '--fence'));
    const state = argValue(argv, '--state');
    if (!key || fence === null || !state) return {exitCode: EXIT.USAGE, output: {state: 'FAILED', reason: 'LEASE_KEY_FENCE_AND_STATE_REQUIRED'}};
    return executeMutation(journal => settleRequest(journal, {key, owner, fence, state, reason: argValue(argv, '--reason') ?? undefined, now}));
  }

  if (command === 'reconcile') {
    return executeMutation(journal => {
      recoverExpiredLeases(journal, {now});
      return reconcileJournal(journal, {now});
    });
  }

  if (command === 'status') {
    try {
      return {exitCode: EXIT.OK, output: summarizeJournal(readJournal(journalPath))};
    } catch (error) {
      const reason = ['JOURNAL_INTEGRITY_FAILED', 'JOURNAL_CORRUPT', 'JOURNAL_RECEIPT_CHAIN_INVALID'].includes(error?.message)
        ? error.message : 'JOURNAL_UNREADABLE';
      return {exitCode: EXIT.DENIED, output: {state: 'BLOCKED', reason, credentialsPrinted: false, privateSourcePublished: false}};
    }
  }

  if (command === 'key') {
    try {
      return {exitCode: EXIT.OK, output: {state: 'BOUND', key: requestKey({repository, sha: env.WOLF_CI_SHA})}};
    } catch {
      return {exitCode: EXIT.DENIED, output: {state: 'DENIED', reason: 'MISSION_BINDING_INVALID'}};
    }
  }

  return {exitCode: EXIT.USAGE, output: {state: 'FAILED', reason: 'JOURNAL_COMMAND_REQUIRED'}};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const {exitCode, output} = runJournalCli(process.argv.slice(2));
    process.stdout.write(JSON.stringify(output) + '\n');
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(JSON.stringify({state: 'FAILED', reason: error?.message ?? 'JOURNAL_CLI_FAILED'}) + '\n');
    process.exitCode = EXIT.DEFECT;
  }
}
