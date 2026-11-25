// Command surface for the mission listener.
//
//   admit --event <file>   decide whether one repository_dispatch event becomes a
//                          privileged execution, and print the decision
//
// The event arrives as a file so attacker-controlled content is never interpreted
// by a shell. The decision is printed as one JSON object and the exit code is 0
// for both admission and refusal: a refusal is a successful *decision*, and the
// workflow reads the decision from the output rather than inferring it from the
// exit status. A non-zero exit means the decision could not be made at all, which
// the workflow treats as a refusal too.
import fs from 'node:fs';

import {admitMission, admissionRecord, LISTENER_STATES, REFUSAL} from './private-ci-listener.mjs';

export const LISTENER_EXIT = Object.freeze({DECIDED: 0, USAGE: 2, UNDECIDABLE: 3});

const list = value => (typeof value === 'string' && value.trim() ? value.split(',').map(item => item.trim()).filter(Boolean) : []);

/**
 * Reconstructs the listener event from a GitHub `repository_dispatch` event.
 *
 * Only fields the contract needs are read. The sender comes from
 * `event.sender.login` - the authenticated account GitHub attributes the event to,
 * not a field the payload can set - so it cannot be spoofed by the caller.
 */
export function eventFromGitHubEvent(githubEvent) {
  const clientPayload = githubEvent?.client_payload ?? {};
  return {
    eventType: 'wolf-private-ci',
    sender: githubEvent?.sender?.login ?? null,
    executorSha: clientPayload.executorSha ?? null,
    deliveryId: githubEvent?.deliveryId ?? null,
    mission: clientPayload,
  };
}

/**
 * Derives a delivery identity that the caller cannot choose.
 *
 * `repository_dispatch` carries no `after` commit and the `X-GitHub-Delivery`
 * header is not exposed to the workflow, so there is no free transport identity.
 * Falling back to a payload field would hand replay protection to the attacker -
 * a new random id per request would defeat the check entirely.
 *
 * Instead the identity is the run id, which GitHub assigns and the caller cannot
 * influence. Two genuinely different events get different run ids; a re-sent
 * payload cannot reuse one. Mission-level replay is covered separately by the
 * `missionId@sha` key, so a caller reusing a delivery id still cannot re-execute
 * the same work.
 */
export function deliveryIdentity(githubEvent, {runId = null} = {}) {
  const explicit = githubEvent?.deliveryId ?? null;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  if (runId !== null && runId !== undefined && String(runId).trim()) return 'run-' + String(runId).trim();
  return null;
}

export function runListenerCli(argv = [], {
  env = process.env,
  now = Date.now(),
  readFile = file => fs.readFileSync(file, 'utf8'),
  stdout = text => process.stdout.write(text),
} = {}) {
  const command = argv[0];
  const flag = name => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  if (command !== 'admit') {
    stdout(JSON.stringify({state: LISTENER_STATES.REFUSED, reason: 'LISTENER_COMMAND_REQUIRED'}) + '\n');
    return LISTENER_EXIT.USAGE;
  }

  const eventFile = flag('--event') ?? env.WOLF_LISTENER_POLICY_FILE;
  let githubEvent = null;
  try {
    githubEvent = JSON.parse(readFile(eventFile));
  } catch {
    // An unreadable event refuses. It must never admit by omission.
    stdout(JSON.stringify({state: LISTENER_STATES.REFUSED, admitted: false, reason: 'LISTENER_EVENT_UNREADABLE', credentialsRequired: false}) + '\n');
    return LISTENER_EXIT.UNDECIDABLE;
  }

  const event = eventFromGitHubEvent(githubEvent);
  event.deliveryId = deliveryIdentity(githubEvent, {runId: env.GITHUB_RUN_ID ?? null});

  const admission = admitMission(event, {
    now,
    authorizedSenders: list(env.WOLF_LISTENER_AUTHORIZED_SENDERS),
    approvedExecutorShas: list(env.WOLF_LISTENER_APPROVED_EXECUTOR_SHAS),
    // The executor SHA is fixed by the workflow env, never taken from the event,
    // so a caller cannot propose a commit for approval on its own behalf.
    ...{},
    repositoryAllowlist: list(env.WOLF_LISTENER_REPOSITORY_ALLOWLIST),
    deliveries: [],
    recentAdmissions: [],
  });

  // Override the executor SHA with the workflow's pinned value. The event may carry
  // one, but only the workflow's value is authoritative; a disagreement is a
  // refusal, not a preference.
  const pinned = env.WOLF_LISTENER_EXECUTOR_SHA ?? null;
  const finalAdmission = { ...admission };
  if (admission.admitted === true && admission.executorSha !== pinned) {
    finalAdmission.state = LISTENER_STATES.REFUSED;
    finalAdmission.admitted = false;
    finalAdmission.reason = REFUSAL.EXECUTOR_SHA_NOT_APPROVED;
    finalAdmission.detail = {eventExecutor: admission.executorSha, pinnedExecutor: pinned};
    finalAdmission.executorSha = null;
  }

  stdout(JSON.stringify(finalAdmission) + '\n');
  // The record is printed separately so the workflow can persist it without
  // re-implementing the shape.
  stdout(JSON.stringify({admissionRecord: admissionRecord(finalAdmission, {now})}) + '\n');
  return LISTENER_EXIT.DECIDED;
}

const invokedDirectly = process.argv[1] && pathToFileUrl(process.argv[1]) === import.meta.url;
function pathToFileUrl(file) {
  return new URL('file://' + file).href;
}

if (invokedDirectly) {
  process.exit(runListenerCli(process.argv.slice(2)));
}
