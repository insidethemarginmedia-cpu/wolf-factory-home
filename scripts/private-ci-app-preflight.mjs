// Read-only diagnostic helpers for a future, explicitly owner-approved review of
// an existing GitHub App installation. The former `plan` and `map-installations`
// setup flows are withdrawn: they must not create duplicate infrastructure or
// ask anyone to add credentials while the bridge is blocked.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {readConversion} from './private-ci-app-manifest.mjs';

export const PREFLIGHT_EXIT = Object.freeze({OK: 0, DEFECT: 1, USAGE: 2, EXCESS: 79, INCOMPLETE: 78, BLOCKED: 78});
export const REQUIRED_SECRETS = Object.freeze([]);

export function founderPlan() {
  return {
    state: 'BLOCKED',
    reason: 'APP_SETUP_NOT_AUTHORIZED',
    title: 'Former GitHub App setup proposal withdrawn',
    authorizedActions: [],
    steps: [],
    secrets: [],
    credentialsPrinted: false,
    dispatchAuthorized: false,
  };
}

export function runPreflightCli(argv = [], {
  readFile = path => fs.readFileSync(path, 'utf8'),
  stdout = text => process.stdout.write(text),
} = {}) {
  const command = argv[0];
  const flag = name => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  if (command === 'plan' || command === 'map-installations') {
    // Return a machine-readable refusal without reading installation data or
    // revealing IDs/secret names. Do not turn an old setup wizard into an action.
    stdout(JSON.stringify({...founderPlan(), command}) + '\n');
    return PREFLIGHT_EXIT.BLOCKED;
  }

  if (command === 'audit-conversion') {
    const file = flag('--file');
    if (!file) return PREFLIGHT_EXIT.USAGE;
    let payload;
    try {
      payload = JSON.parse(readFile(file));
    } catch {
      stdout(JSON.stringify({state: 'UNREADABLE', reason: 'CONVERSION_FILE_INVALID', credentialsPrinted: false}) + '\n');
      return PREFLIGHT_EXIT.DEFECT;
    }
    const {summary} = readConversion(payload);
    stdout(JSON.stringify(summary, null, 2) + '\n');
    if (summary.audit === 'EXCESS') return PREFLIGHT_EXIT.EXCESS;
    if (summary.audit === 'INSUFFICIENT') return PREFLIGHT_EXIT.DEFECT;
    return PREFLIGHT_EXIT.OK;
  }

  stdout(JSON.stringify({state: 'BLOCKED', reason: 'APP_SETUP_NOT_AUTHORIZED', authorizedActions: [], credentialsPrinted: false}) + '\n');
  return PREFLIGHT_EXIT.BLOCKED;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runPreflightCli(process.argv.slice(2));
  } catch {
    process.stderr.write(JSON.stringify({state: 'FAILED', reason: 'PREFLIGHT_FAILED', credentialsPrinted: false}) + '\n');
    process.exitCode = PREFLIGHT_EXIT.DEFECT;
  }
}
