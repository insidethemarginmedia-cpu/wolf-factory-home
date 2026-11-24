// Pre-flight for a real Wolf Factory Automation installation.
//
//   audit-conversion   read a saved manifest-conversion response, refuse an
//                      over-privileged App, and emit the secret names to store
//   plan               print the exact Founder steps and the exact links
//
// Neither command prints a private key, a token or a secret value.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {readConversion, APP_NAME, MANIFEST_ENDPOINTS} from './private-ci-app-manifest.mjs';
import {mapInstallations, INSTALL_MAP_STATES} from './private-ci-app-installations.mjs';

export const PREFLIGHT_EXIT = Object.freeze({OK: 0, DEFECT: 1, USAGE: 2, EXCESS: 79, INCOMPLETE: 78});

export const REQUIRED_SECRETS = Object.freeze([
  'WOLF_FACTORY_APP_ID',
  'WOLF_FACTORY_APP_PRIVATE_KEY',
  'WOLF_FACTORY_READER_INSTALLATION_ID',
  'WOLF_FACTORY_PUBLISHER_INSTALLATION_ID',
  'WOLF_FACTORY_DISPATCHER_INSTALLATION_ID',
]);

export function founderPlan({owner = 'insidethemarginmedia-cpu', repositories = ['project-wolf', 'wolf-factory-home']} = {}) {
  return {
    state: 'FOUNDER_ACTION_REQUIRED',
    title: 'Create ' + APP_NAME,
    why: 'A GitHub App private key is returned exactly once, to the browser session that converts the manifest. No API, token or MCP available here can create an App or mint a key.',
    steps: [
      {
        step: 1,
        action: 'Open the manifest form and submit it',
        link: MANIFEST_ENDPOINTS.organization.replace('{org}', owner),
        note: 'The form carries the full, already-minimal manifest: contents:read, metadata:read, checks:write, actions:write. No webhook.',
      },
      {
        step: 2,
        action: 'Install the App on both accounts, selecting only these repositories',
        repositories,
        note: 'Repository selection must be "Only select repositories". Do not grant "All repositories".',
      },
      {
        step: 3,
        action: 'Copy the three installation IDs, one per account/repository pairing',
        note: 'Each installation ID is visible in the installation URL: /settings/installations/<id>.',
      },
      {
        step: 4,
        action: 'Store these repository secrets, never in a file',
        secrets: [...REQUIRED_SECRETS],
        note: 'Settings > Secrets and variables > Actions > New repository secret.',
      },
      {
        step: 5,
        action: 'Tell the agent the App is installed',
        note: 'The next run mints App tokens automatically and reports authentication.mode = github-app. The PAT fallback stays until that run is green.',
      },
    ],
    credentialsPrinted: false,
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

  if (command === 'plan') {
    stdout(JSON.stringify(founderPlan({owner: flag('--owner')}), null, 2) + '\n');
    return PREFLIGHT_EXIT.OK;
  }

  if (command === 'map-installations') {
    // Takes a saved `GET /user/installations` response (or /app/installations)
    // and produces the exact secrets to store. Reuse across roles is reported so
    // a shared ID is visibly intended rather than suspected as a copy-paste bug.
    const file = flag('--file');
    if (!file) return PREFLIGHT_EXIT.USAGE;
    let payload;
    try {
      payload = JSON.parse(readFile(file));
    } catch {
      stdout(JSON.stringify({state: 'UNREADABLE', reason: 'INSTALLATIONS_FILE_INVALID', credentialsPrinted: false}) + '\n');
      return PREFLIGHT_EXIT.DEFECT;
    }
    const list = Array.isArray(payload) ? payload : payload.installations ?? [];
    const mapped = mapInstallations(list);
    stdout(JSON.stringify(mapped, null, 2) + '\n');
    if (mapped.state === INSTALL_MAP_STATES.MAPPED) return PREFLIGHT_EXIT.OK;
    if (mapped.state === INSTALL_MAP_STATES.OVER_SCOPED || mapped.state === INSTALL_MAP_STATES.UNAUTHORIZED) return PREFLIGHT_EXIT.EXCESS;
    return PREFLIGHT_EXIT.INCOMPLETE;
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

  stdout(JSON.stringify({state: 'FAILED', reason: 'PREFLIGHT_COMMAND_REQUIRED'}) + '\n');
  return PREFLIGHT_EXIT.USAGE;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runPreflightCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(JSON.stringify({state: 'FAILED', reason: error?.message ?? 'PREFLIGHT_FAILED'}) + '\n');
    process.exitCode = PREFLIGHT_EXIT.DEFECT;
  }
}
