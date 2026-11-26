// Command surface for the mission listener.
//
//   admit --event <file>   decide whether one repository_dispatch event becomes a
//                          privileged execution, and durably reserve accepted work
//
// The event arrives as a file so attacker-controlled content is never interpreted
// by a shell. A workflow may require the durable store; when it does, an API or
// integrity failure is a refusal and never an in-memory-only admission.
import fs from 'node:fs';

import {admissionRecord, LISTENER_STATES} from './private-ci-listener.mjs';
import {admitMissionDurably} from './private-ci-listener-store.mjs';

export const LISTENER_EXIT = Object.freeze({DECIDED: 0, USAGE: 2, UNDECIDABLE: 3, BLOCKED: 78});

const list = value => (typeof value === 'string' && value.trim() ? value.split(',').map(item => item.trim()).filter(Boolean) : []);
const enabled = value => ['true', '1', 'yes'].includes(String(value ?? '').trim().toLowerCase());

/**
 * Reconstructs the listener event from a GitHub `repository_dispatch` event.
 * The sender comes from GitHub's authenticated envelope, never the payload.
 */
export function eventFromGitHubEvent(githubEvent, {pinnedExecutorSha = null} = {}) {
  const clientPayload = githubEvent?.client_payload ?? {};
  return {
    eventType: 'wolf-private-ci',
    sender: githubEvent?.sender?.login ?? null,
    // The listener pin is trusted workflow policy. A payload may repeat it, but
    // cannot provide the pin when absent or widen the approved set.
    executorSha: clientPayload.executorSha ?? pinnedExecutorSha,
    deliveryId: githubEvent?.deliveryId ?? null,
    mission: clientPayload,
  };
}

/**
 * repository_dispatch does not expose X-GitHub-Delivery to workflow code. The
 * run id is GitHub-assigned and caller-independent; the durable mission key
 * provides a second replay barrier across different run ids.
 */
export function deliveryIdentity(githubEvent, {runId = null} = {}) {
  const explicit = githubEvent?.deliveryId ?? null;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  if (runId !== null && runId !== undefined && String(runId).trim()) return 'run-' + String(runId).trim();
  return null;
}

export async function runListenerCli(argv = [], {
  env = process.env,
  now = Date.now(),
  readFile = file => fs.readFileSync(file, 'utf8'),
  stdout = text => process.stdout.write(text),
  fetchImpl = globalThis.fetch,
} = {}) {
  const command = argv[0];
  const flag = name => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  if (command !== 'admit') {
    stdout(JSON.stringify({state: LISTENER_STATES.REFUSED, admitted: false, reason: 'LISTENER_COMMAND_REQUIRED'}) + '\n');
    return LISTENER_EXIT.USAGE;
  }

  const eventFile = flag('--event') ?? env.WOLF_LISTENER_POLICY_FILE;
  let githubEvent = null;
  try {
    githubEvent = JSON.parse(readFile(eventFile));
  } catch {
    stdout(JSON.stringify({state: LISTENER_STATES.REFUSED, admitted: false, reason: 'LISTENER_EVENT_UNREADABLE', credentialsRequired: false}) + '\n');
    return LISTENER_EXIT.UNDECIDABLE;
  }

  const pinnedExecutorSha = env.WOLF_LISTENER_EXECUTOR_SHA ?? null;
  const event = eventFromGitHubEvent(githubEvent, {pinnedExecutorSha});
  event.deliveryId = deliveryIdentity(githubEvent, {runId: env.GITHUB_RUN_ID ?? null});
  const configuredExecutorShas = list(env.WOLF_LISTENER_APPROVED_EXECUTOR_SHAS);
  const policy = {
    now,
    authorizedSenders: list(env.WOLF_LISTENER_AUTHORIZED_SENDERS),
    // Even if a stale configuration lists several historical pins, only the one
    // workflow actually checks out is admissible in this run.
    approvedExecutorShas: pinnedExecutorSha && configuredExecutorShas.includes(pinnedExecutorSha) ? [pinnedExecutorSha] : [],
    repositoryAllowlist: list(env.WOLF_LISTENER_REPOSITORY_ALLOWLIST),
  };

  let admission;
  let persistence;
  let exitCode = LISTENER_EXIT.DECIDED;
  if (!enabled(env.WOLF_LISTENER_STORE_REQUIRED)) {
    admission = {
      state: LISTENER_STATES.REFUSED,
      admitted: false,
      reason: 'LISTENER_DURABLE_STORE_REQUIRED',
      detail: {storeReason: 'DURABLE_STORE_NOT_ENABLED'},
      executorSha: null,
      mission: null,
      credentialsRequired: false,
    };
    persistence = {state: 'BLOCKED', reason: 'DURABLE_STORE_NOT_ENABLED', credentialsPrinted: false};
    exitCode = LISTENER_EXIT.BLOCKED;
  } else {
    try {
      const stored = await admitMissionDurably({
        event,
        policy,
        token: env.GITHUB_TOKEN,
        repository: env.GITHUB_REPOSITORY,
        // The trusted executor pin, not the repository_dispatch event's default
        // branch SHA, seeds a first-time admission branch.
        executorCommit: pinnedExecutorSha,
        runId: env.GITHUB_RUN_ID,
        now,
        fetchImpl,
      });
      admission = stored.admission;
      persistence = stored.persistence;
      exitCode = stored.exitCode === 78 ? LISTENER_EXIT.BLOCKED : LISTENER_EXIT.DECIDED;
    } catch {
      admission = {
        state: LISTENER_STATES.REFUSED,
        admitted: false,
        reason: 'LISTENER_DURABLE_STORE_BLOCKED',
        detail: {storeReason: 'UNEXPECTED_STORE_ERROR'},
        executorSha: null,
        mission: null,
        credentialsRequired: false,
      };
      persistence = {state: 'BLOCKED', reason: 'UNEXPECTED_STORE_ERROR', credentialsPrinted: false};
      exitCode = LISTENER_EXIT.BLOCKED;
    }
  }

  // The workflow consumes the first JSON line. `admitted` is true only after the
  // remote ledger+anchor write succeeded when durable storage is required.
  stdout(JSON.stringify({...admission, persistence}) + '\n');
  stdout(JSON.stringify({
    admissionRecord: admissionRecord(admission, {now, runId: env.GITHUB_RUN_ID ?? null}),
    persistence,
  }) + '\n');
  return exitCode;
}

const invokedDirectly = process.argv[1] && new URL('file://' + process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  try {
    process.exitCode = await runListenerCli(process.argv.slice(2));
  } catch {
    process.stdout.write(JSON.stringify({state: 'REFUSED', admitted: false, reason: 'LISTENER_DECISION_UNAVAILABLE', credentialsRequired: false}) + '\n');
    process.exitCode = LISTENER_EXIT.UNDECIDABLE;
  }
}
