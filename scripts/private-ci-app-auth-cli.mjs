// Command surface for GitHub App authentication in the bridge workflow.
//
//   inventory   presence of each secret, never its value
//   mint        mint one role's installation token; writes it to GITHUB_ENV
//   verify      re-mint and confirm renewal works from a cold start
//
// The token is written to a root-only file whose contents the workflow appends
// to GITHUB_ENV, so it is never echoed to the log and never appears in argv.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  APP_SECRET_NAMES,
  ROLE_PERMISSIONS,
  inventoryAppSecrets,
  mintInstallationToken,
  needsRenewal,
  normalizeRole,
  selectCredential,
} from './private-ci-app-auth.mjs';

export const APP_AUTH_EXIT = Object.freeze({OK: 0, DEFECT: 1, USAGE: 2, BLOCKED: 78, DENIED: 79});

// Environment variable each role's token is exported as. Keeping these separate
// is what stops one credential from standing in for another.
export const ROLE_ENV = Object.freeze({
  reader: 'WOLF_CI_APP_READER_TOKEN',
  publisher: 'WOLF_CI_APP_PUBLISHER_TOKEN',
  dispatcher: 'WOLF_CI_APP_DISPATCHER_TOKEN',
});

export function maskValue(value) {
  // `::add-mask::` makes the runner redact the value everywhere it appears,
  // including in any accidental echo downstream.
  return `::add-mask::${value}`;
}

export async function mintRoleToken({role, env = process.env, fetchImpl = globalThis.fetch, now = Date.now()} = {}) {
  const normalizedRole = normalizeRole(role);
  const selection = selectCredential(normalizedRole, {env});
  if (selection.source !== 'github-app') {
    return {state: selection.source === 'none' ? 'BLOCKED' : 'FALLBACK', role: normalizedRole, selection};
  }
  const installationId = env[selection.installationIdSecret];
  const result = await mintInstallationToken({
    role: normalizedRole,
    appId: env[APP_SECRET_NAMES.appId],
    privateKey: env[APP_SECRET_NAMES.privateKey],
    installationId,
    repository: env.WOLF_CI_REPOSITORY,
    permissions: ROLE_PERMISSIONS[normalizedRole],
    fetchImpl,
    now,
  });
  if (result.state !== 'MINTED') return {...result, selection};
  return {
    state: 'MINTED',
    role: normalizedRole,
    selection,
    // Reported metadata only. The token itself is returned separately so a
    // caller cannot accidentally serialize it with the summary.
    expiresAt: result.expiresAt,
    permissions: result.permissions,
    repositoryScoped: result.repositoryScoped,
    needsRenewal: needsRenewal(result.expiresAt, now),
    token: result.token,
  };
}

// Writes `NAME=value` to a mode-0600 file. The workflow reads it with `cat`
// redirected into GITHUB_ENV; the value never reaches stdout.
export function writeTokenFile(file, name, token) {
  if (!file) throw Error('TOKEN_FILE_REQUIRED');
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  fs.writeFileSync(file, `${name}=${token}\n`, {mode: 0o600});
  return file;
}

export async function runAppAuthCli(argv, {env = process.env, fetchImpl = globalThis.fetch, now = Date.now(), stdout = text => process.stdout.write(text)} = {}) {
  const command = argv[0];
  const summary = result => {
    const {token, ...rest} = result;
    return rest;
  };

  if (command === 'inventory') {
    const inventory = inventoryAppSecrets(env);
    stdout(JSON.stringify(inventory) + '\n');
    return APP_AUTH_EXIT.OK;
  }

  if (command === 'mint') {
    const role = argv[1];
    if (!role) return APP_AUTH_EXIT.USAGE;
    let result;
    try {
      result = await mintRoleToken({role, env, fetchImpl, now});
    } catch (error) {
      stdout(JSON.stringify({state: 'DENIED', role: String(role), reason: error?.message ?? 'APP_MINT_FAILED'}) + '\n');
      return APP_AUTH_EXIT.DENIED;
    }
    if (result.state === 'MINTED') {
      // Mask first, then persist. Order matters: nothing is written before the
      // runner is told to redact it.
      stdout(maskValue(result.token) + '\n');
      const file = writeTokenFile(env.WOLF_CI_TOKEN_FILE, ROLE_ENV[result.role], result.token);
      stdout(JSON.stringify({...summary(result), tokenFile: file}) + '\n');
      return APP_AUTH_EXIT.OK;
    }
    if (result.state === 'FALLBACK') {
      stdout(JSON.stringify({state: 'FALLBACK', role: result.role, selection: result.selection}) + '\n');
      return APP_AUTH_EXIT.OK;
    }
    stdout(JSON.stringify(summary(result)) + '\n');
    return result.state === 'BLOCKED' ? APP_AUTH_EXIT.BLOCKED : APP_AUTH_EXIT.DEFECT;
  }

  if (command === 'verify') {
    // Restart recovery: mint twice in a row and prove the second token is fresh
    // and valid, exactly as a restarted runner would.
    const results = [];
    for (const role of ['reader', 'publisher']) {
      const first = await mintRoleToken({role, env, fetchImpl, now});
      const second = await mintRoleToken({role, env, fetchImpl, now: now + 60 * 60 * 1000});
      results.push({
        role,
        first: summary(first),
        second: summary(second),
        renews: first.state === 'MINTED' && second.state === 'MINTED' && first.expiresAt !== second.expiresAt,
      });
    }
    const ok = results.every(entry => entry.state === 'MINTED' || entry.renews || entry.first.state === 'FALLBACK');
    stdout(JSON.stringify({state: ok ? 'VERIFIED' : 'FAILED', renewal: results, credentialsPrinted: false}) + '\n');
    return ok ? APP_AUTH_EXIT.OK : APP_AUTH_EXIT.DEFECT;
  }

  stdout(JSON.stringify({state: 'FAILED', reason: 'APP_AUTH_COMMAND_REQUIRED'}) + '\n');
  return APP_AUTH_EXIT.USAGE;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runAppAuthCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(JSON.stringify({state: 'FAILED', reason: error?.message ?? 'APP_AUTH_CLI_FAILED'}) + '\n');
    process.exitCode = APP_AUTH_EXIT.DEFECT;
  }
}
