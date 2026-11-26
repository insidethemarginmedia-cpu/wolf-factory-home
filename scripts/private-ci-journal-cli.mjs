// Test/fixture command surface for the runner-local private CI journal.
//
// It exercises enqueue/claim/settle behavior in one filesystem for unit tests;
// it is not called by a production workflow and cannot provide cross-run
// durability, recovery, or fencing on ephemeral GitHub-hosted runners. Production
// mission admission uses private-ci-listener-store.mjs.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  cancelRequest,
  claimNext,
  enqueueRequest,
  readJournal,
  settleRequest,
  summarizeJournal,
  writeJournal,
} from './private-ci-journal.mjs';

const EXIT = Object.freeze({OK: 0, DEFECT: 1, USAGE: 2, DENIED: 79});

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] ?? null;
}

export function runJournalCli(argv, env = process.env) {
  const command = argv[0];
  const journalPath = env.WOLF_CI_JOURNAL;
  if (!journalPath) return {exitCode: EXIT.USAGE, output: {state: 'FAILED', reason: 'JOURNAL_PATH_REQUIRED'}};
  const journal = readJournal(journalPath);
  const repository = env.WOLF_CI_REPOSITORY;
  const owner = `${env.GITHUB_RUN_ID ?? 'manual'}`;

  if (command === 'enqueue') {
    const inbox = env.WOLF_CI_INBOX;
    const requestFile = inbox ? path.join(inbox, 'request.sha') : null;
    const explicit = requestFile && fs.existsSync(requestFile) ? fs.readFileSync(requestFile, 'utf8').trim() : '';
    const sha = explicit || env.WOLF_CI_SHA;
    // A malformed caller-supplied SHA is a hard denial, reported rather than
    // thrown so the workflow step fails with a coded reason.
    let result;
    try {
      result = enqueueRequest(journal, {repository, sha, reason: env.GITHUB_EVENT_NAME ?? 'manual', runId: env.GITHUB_RUN_ID ?? null});
    } catch (error) {
      return {exitCode: EXIT.DENIED, output: {state: 'DENIED', reason: error?.message ?? 'JOURNAL_ENQUEUE_DENIED'}};
    }
    writeJournal(journalPath, journal);
    return {exitCode: EXIT.OK, output: {...summarizeResult(result), sha: result.request.sha}};
  }
  if (command === 'claim') {
    const result = claimNext(journal, {owner});
    writeJournal(journalPath, journal);
    if (result.state === 'IDLE') return {exitCode: EXIT.OK, output: {state: 'IDLE'}};
    return {exitCode: EXIT.OK, output: {state: result.state, key: result.key, sha: result.request.sha, attempts: result.request.attempts, recoveredFrom: result.recoveredFrom ?? null}};
  }
  if (command === 'cancel') {
    const sha = argValue(argv, '--sha') ?? env.WOLF_CI_SHA;
    const result = cancelRequest(journal, {repository, sha, reason: argValue(argv, '--reason') ?? 'CANCELLED_BY_OPERATOR'});
    writeJournal(journalPath, journal);
    return {exitCode: result.state === 'DENIED' ? EXIT.DENIED : EXIT.OK, output: summarizeResult(result)};
  }
  if (command === 'settle') {
    const state = argValue(argv, '--state');
    // Settle every lease this run owns, so a partial execution cannot leave the
    // queue blocked behind its own expired lease.
    const owned = Object.values(journal.requests).filter(request => request.state === 'leased' && request.leaseOwner === owner);
    const settled = owned.map(request => settleRequest(journal, {key: request.key, state}).state);
    writeJournal(journalPath, journal);
    return {exitCode: settled.every(value => value === 'COMPLETED' || value === 'FAILED') ? EXIT.OK : EXIT.DEFECT, output: {state: state?.toUpperCase() ?? null, settled}};
  }
  if (command === 'status') {
    return {exitCode: EXIT.OK, output: summarizeJournal(journal)};
  }
  return {exitCode: EXIT.USAGE, output: {state: 'FAILED', reason: 'JOURNAL_COMMAND_REQUIRED'}};
}

function summarizeResult(result) {
  return {state: result.state, key: result.key ?? null};
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
