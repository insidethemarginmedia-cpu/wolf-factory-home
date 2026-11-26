// Read-only second line of defence for the privileged reusable workflow.
//
// It verifies the exact mission, sender-issued delivery identity, approved
// executor pin and caller run id against the durable anchored admission ledger.
// A reusable-workflow call without that persisted admission is refused before any
// private target credential is selected.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

import {verifyStoredMissionAdmission} from './private-ci-listener-store.mjs';

export const LISTENER_GATE_EXIT = Object.freeze({VERIFIED: 0, BLOCKED: 78});

export async function verifyMissionAdmissionCli({env = process.env, fetchImpl = globalThis.fetch, stdout = text => process.stdout.write(text)} = {}) {
  const result = await verifyStoredMissionAdmission({
    token: env.GITHUB_TOKEN,
    repository: env.GITHUB_REPOSITORY,
    targetRepository: env.WOLF_CI_MISSION_TARGET_REPOSITORY,
    missionId: env.WOLF_CI_MISSION_ID,
    targetSha: env.WOLF_CI_MISSION_TARGET_SHA,
    deliveryId: env.WOLF_CI_MISSION_DELIVERY_ID,
    executorSha: env.WOLF_CI_MISSION_EXECUTOR_SHA,
    runId: env.GITHUB_RUN_ID,
    fetchImpl,
  });
  const outFile = env.WOLF_CI_MISSION_ADMISSION_FILE;
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), {recursive: true, mode: 0o700});
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n', {mode: 0o600});
  }
  stdout(JSON.stringify(result) + '\n');
  return result.state === 'VERIFIED' ? LISTENER_GATE_EXIT.VERIFIED : LISTENER_GATE_EXIT.BLOCKED;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await verifyMissionAdmissionCli();
  } catch {
    process.stdout.write(JSON.stringify({state: 'BLOCKED', reason: 'ADMISSION_VERIFICATION_FAILED', admitted: false, credentialsPrinted: false}) + '\n');
    process.exitCode = LISTENER_GATE_EXIT.BLOCKED;
  }
}
