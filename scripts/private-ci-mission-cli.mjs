// Pre-execution mission admission CLI. An accepted mission is validated against
// the authenticated GitHub actor and reserved in the Home repository's
// create-only Git-ref ledger before the workflow may read or execute target code.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateMission, missionRecord, MISSION_STATES} from './private-ci-mission.mjs';
import {reserveGithubMission} from './private-ci-mission-store.mjs';

export const MISSION_EXIT = Object.freeze({ACCEPTED: 0, REJECTED: 2, DUPLICATE: 3, BLOCKED: 78, RATE_LIMITED: 79});
export const ALLOWED_REPOSITORIES = Object.freeze(['donraposo1-source/project-wolf']);

function allowedActors(value) {
  return [...new Set(String(value ?? '').split(',').map(actor => actor.trim()).filter(Boolean))];
}

function writeAppend(file, line) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.appendFileSync(file, line + '\n', {mode: 0o600});
}

function parsePayload({env, event, actor, now}) {
  if (event === 'repository_dispatch') {
    try { return JSON.parse(String(env.CLIENT_PAYLOAD ?? 'null')); } catch { return null; }
  }
  if (event === 'workflow_dispatch') {
    const sha = String(env.WOLF_CI_REQUESTED_SHA ?? env.INPUT_SHA ?? '').trim().toLowerCase();
    const requestedPr = String(env.WOLF_CI_REQUESTED_PR ?? env.INPUT_PR ?? '').trim();
    const pr = requestedPr || String(env.WOLF_CI_TARGET_PR ?? '').trim();
    if (!sha) return null;
    const missionId = String(env.WOLF_CI_REQUESTED_MISSION_ID ?? env.INPUT_MISSION_ID ?? '').trim() || `manual:${sha}`;
    return {
      schemaVersion: 1,
      missionId,
      repository: env.WOLF_CI_TARGET_REPOSITORY ?? ALLOWED_REPOSITORIES[0],
      sha,
      pr,
      issuedAt: new Date(now).toISOString(),
      requestedBy: actor,
    };
  }
  return null;
}

function appendOutputs({writeOutput, writeEnv, accepted, decision, reservation}) {
  writeOutput(`accepted=${accepted ? 'true' : 'false'}`);
  if (!accepted) return;
  writeOutput(`sha=${decision.mission.sha}`);
  writeOutput(`mission_id=${decision.mission.missionId}`);
  writeOutput(`mission_key=${reservation.keyHash}`);
  writeOutput(`pull_request=${decision.mission.pr ?? ''}`);
  writeEnv(`WOLF_CI_SHA=${decision.mission.sha}`);
  writeEnv(`WOLF_CI_MISSION_ID=${decision.mission.missionId}`);
  writeEnv(`WOLF_CI_MISSION_RESERVATION=${reservation.keyHash}`);
}

export async function missionCli(argv = [], {
  env = process.env,
  now = Date.now(),
  readFile = file => fs.readFileSync(file, 'utf8'),
  writeFile = (file, data) => fs.writeFileSync(file, data, {mode: 0o600}),
  stdout = text => process.stdout.write(text),
  writeOutput = line => writeAppend(env.GITHUB_OUTPUT, line),
  writeEnv = line => writeAppend(env.GITHUB_ENV, line),
  reserve = input => reserveGithubMission({
    ...input,
    token: env.GITHUB_TOKEN,
    journalRepository: env.GITHUB_REPOSITORY,
    allowedActors: allowedActors(env.WOLF_CI_MISSION_ALLOWED_ACTORS),
  }),
} = {}) {
  const flag = name => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const outFile = flag('--out') ?? env.WOLF_CI_MISSION_FILE;
  const event = env.GITHUB_EVENT_NAME ?? '';
  const actor = env.GITHUB_ACTOR ?? '';
  const actors = allowedActors(env.WOLF_CI_MISSION_ALLOWED_ACTORS);
  const expectedPr = env.WOLF_CI_TARGET_PR ?? null;
  const payload = parsePayload({env, event, actor, now});

  let decision = validateMission(payload, {
    now,
    allowlist: ALLOWED_REPOSITORIES,
    actor,
    allowedActors: actors,
    expectedPr,
  });

  let reservation = null;
  if (decision.accepted) {
    reservation = null;
    try {
      reservation = await reserve({mission: decision.mission, actor, now});
    } catch {
      reservation = {state: 'BLOCKED', reason: 'MISSION_STORE_FAILED', durable: false};
    }
    if (reservation?.state === 'DUPLICATE') {
      decision = {state: MISSION_STATES.DUPLICATE, accepted: false, reason: reservation.reason ?? 'MISSION_ALREADY_RESERVED', keyHash: reservation.keyHash, mission: decision.mission};
    } else if (reservation?.state === 'RATE_LIMITED') {
      decision = {state: MISSION_STATES.RATE_LIMITED, accepted: false, reason: reservation.reason ?? 'MISSION_SENDER_HOURLY_LIMIT', keyHash: reservation.keyHash, mission: decision.mission};
    } else if (reservation?.state !== 'RESERVED' || reservation.durable !== true) {
      decision = {state: MISSION_STATES.BLOCKED, accepted: false, reason: reservation?.reason ?? 'MISSION_DURABLE_RESERVATION_REQUIRED', keyHash: reservation?.keyHash ?? null, durable: reservation?.durable === true, mission: decision.mission};
    } else {
      decision = {...decision, durableReservation: {keyHash: reservation.keyHash, rateSlot: reservation.rateSlot}};
    }
  }

  const record = decision.accepted
    ? {...missionRecord(decision, {now, runId: env.GITHUB_RUN_ID ?? null, event}), durableReservation: decision.durableReservation, privateSourceIncluded: false}
    : {
        schemaVersion: 1,
        state: decision.state ?? MISSION_STATES.REJECTED,
        reason: decision.reason ?? 'MISSION_INVALID',
        detail: decision.detail ?? null,
        keyHash: decision.keyHash ?? null,
        mission: decision.mission ?? null,
        recordedAt: new Date(now).toISOString(),
        runId: env.GITHUB_RUN_ID ?? null,
        event,
        durable: decision.durable === true || decision.state === MISSION_STATES.DUPLICATE || decision.state === MISSION_STATES.RATE_LIMITED,
        credentialsPrinted: false,
        privateSourceIncluded: false,
      };

  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), {recursive: true});
    writeFile(outFile, JSON.stringify(record, null, 2) + '\n');
  }

  appendOutputs({writeOutput, writeEnv, accepted: decision.accepted === true, decision, reservation});
  stdout(JSON.stringify({
    state: record.state,
    reason: record.reason ?? null,
    keyHash: record.durableReservation?.keyHash ?? record.keyHash ?? null,
    sha: record.mission?.sha ?? null,
    repository: record.mission?.repository ?? null,
    pullRequestNumber: record.mission?.pr ?? null,
    durable: record.durableReservation ? true : record.durable === true,
    credentialsPrinted: false,
    privateSourceIncluded: false,
  }) + '\n');

  if (record.state === MISSION_STATES.ACCEPTED) return MISSION_EXIT.ACCEPTED;
  if (record.state === MISSION_STATES.DUPLICATE) return MISSION_EXIT.DUPLICATE;
  if (record.state === MISSION_STATES.RATE_LIMITED) return MISSION_EXIT.RATE_LIMITED;
  if (record.state === MISSION_STATES.BLOCKED) return MISSION_EXIT.BLOCKED;
  return MISSION_EXIT.REJECTED;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await missionCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(JSON.stringify({state: 'BLOCKED', reason: error?.message ?? 'MISSION_CLI_FAILED'}) + '\n');
    process.exitCode = MISSION_EXIT.BLOCKED;
  }
}
