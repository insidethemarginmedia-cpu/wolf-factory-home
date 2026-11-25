// Mission intake CLI. Runs inside the bridge when a `repository_dispatch` arrives.
//
//   node scripts/private-ci-mission-cli.mjs --payload /tmp/payload.json --out /tmp/mission.json
//
// Exit codes:
//   0  ACCEPTED   — a new mission, bound to an exact SHA
//   3  DUPLICATE  — already recorded; not an error, and not new work
//   2  REJECTED   — malformed, expired or not authorised
//
// The payload is written by the workflow from `github.event.client_payload`, which
// is attacker-controlled when the sender is not trusted. Nothing here trusts it
// beyond the schema.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateMission, missionRecord, dedupe, MISSION_STATES} from './private-ci-mission.mjs';

export const MISSION_EXIT = Object.freeze({ACCEPTED: 0, REJECTED: 2, DUPLICATE: 3});

export const ALLOWED_REPOSITORIES = Object.freeze([
  'donraposo1-source/project-wolf',
  'insidethemarginmedia-cpu/wolf-factory-home',
]);

/** Reads previously recorded mission keys from a JSON-lines journal. */
export function readSeenKeys(journalPath) {
  if (!journalPath || !fs.existsSync(journalPath)) return [];
  try {
    return fs.readFileSync(journalPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(entry => entry && entry.state === MISSION_STATES.ACCEPTED && typeof entry.key === 'string')
      .map(entry => entry.key);
  } catch {
    return [];
  }
}

export function missionCli(argv = [], {
  env = process.env,
  now = Date.now(),
  readFile = file => fs.readFileSync(file, 'utf8'),
  writeFile = (file, data) => fs.writeFileSync(file, data, {mode: 0o600}),
  stdout = text => process.stdout.write(text),
} = {}) {
  const flag = name => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const payloadFile = flag('--payload') ?? env.WOLF_CI_MISSION_PAYLOAD;
  const outFile = flag('--out') ?? env.WOLF_CI_MISSION_FILE;

  if (!payloadFile) {
    stdout(JSON.stringify({state: MISSION_STATES.REJECTED, reason: 'MISSION_PAYLOAD_FILE_REQUIRED'}) + '\n');
    return MISSION_EXIT.REJECTED;
  }

  let payload;
  try {
    payload = JSON.parse(readFile(payloadFile));
  } catch {
    stdout(JSON.stringify({state: MISSION_STATES.REJECTED, reason: 'MISSION_PAYLOAD_UNREADABLE'}) + '\n');
    return MISSION_EXIT.REJECTED;
  }

  const decision = dedupe(
    validateMission(payload, {now, allowlist: ALLOWED_REPOSITORIES}),
    {seenKeys: readSeenKeys(env.WOLF_CI_JOURNAL), now},
  );
  const record = missionRecord(decision, {
    now,
    runId: env.GITHUB_RUN_ID ?? null,
    event: env.GITHUB_EVENT_NAME ?? null,
  });

  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), {recursive: true});
    writeFile(outFile, JSON.stringify(record, null, 2));
  }

  // The console line is the run's own evidence, so it carries the decision and the
  // reason but never the payload, which may be large or hostile.
  stdout(JSON.stringify({
    state: record.state,
    reason: record.reason ?? null,
    key: record.key ?? null,
    sha: record.mission?.sha ?? null,
    repository: record.mission?.repository ?? null,
    duplicate: record.state === MISSION_STATES.DUPLICATE,
    credentialsPrinted: false,
  }) + '\n');

  if (record.state === MISSION_STATES.ACCEPTED) return MISSION_EXIT.ACCEPTED;
  if (record.state === MISSION_STATES.DUPLICATE) return MISSION_EXIT.DUPLICATE;
  return MISSION_EXIT.REJECTED;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = missionCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(JSON.stringify({state: 'FAILED', reason: error?.message ?? 'MISSION_CLI_FAILED'}) + '\n');
    process.exitCode = MISSION_EXIT.REJECTED;
  }
}
