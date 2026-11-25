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
  AUTH_STATES,
  describeAuthState,
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
    // Proves the App path end to end: mint, then re-mint from a cold start the
    // way a restarted runner would, and require the second token to be fresh.
    //
    // Falling back is NOT verification. The previous version treated a fallback
    // as success and reported VERIFIED while the PAT was doing the work, which
    // is exactly the false green this command exists to prevent.
    const results = [];
    // The restart is modelled as a mint one second later, not an hour later.
    //
    // Simulating an hour was a real defect: GitHub issues `expires_at` from the
    // *real* clock (now + 1h), while the check evaluated the second token against
    // the simulated clock (now + 1h). The two landed exactly on the expiry, so a
    // live run reported the token EXPIRED and the check could never pass outside a
    // fixture. Advancing one second keeps the simulation honest: the token is
    // re-issued, and it is judged against the clock it was actually issued on.
    const restartAt = now + 1000;
    for (const role of ['reader', 'publisher', 'dispatcher']) {
      const first = await mintRoleToken({role, env, fetchImpl, now});
      const second = await mintRoleToken({role, env, fetchImpl, now: restartAt});
      const firstAuth = first.state === 'MINTED' ? describeAuthState({state: 'MINTED', expiresAt: first.expiresAt, now}) : describeAuthState({state: first.state});
      const secondAuth = second.state === 'MINTED' ? describeAuthState({state: 'MINTED', expiresAt: second.expiresAt, now: restartAt}) : describeAuthState({state: second.state});
      results.push({
        role,
        source: first.selection?.source ?? null,
        first: {...summary(first), authState: firstAuth.state},
        second: {...summary(second), authState: secondAuth.state},
        // Proof of a second, independent token.
        //
        // `expires_at` is truncated to the second by GitHub, so two mints inside
        // one second legitimately produce the same expiry even though the tokens
        // differ. Comparing expiries therefore failed on a fast runner while
        // succeeding in unit tests that used distinct clocks - a check that could
        // only ever pass by accident. Compare the tokens structurally instead.
        renews: first.state === 'MINTED' && second.state === 'MINTED'
          && (first.expiresAt !== second.expiresAt || first.token !== second.token),
        distinctExpiry: first.state === 'MINTED' && second.state === 'MINTED' && first.expiresAt !== second.expiresAt,
        restartRecovered: secondAuth.state === 'FRESH',
      });
    }
    const allAppBacked = results.every(entry => entry.source === 'github-app');
    const allVerified = results.every(entry => entry.renews && entry.restartRecovered);
    const state = allAppBacked && allVerified ? 'VERIFIED' : allAppBacked ? 'FAILED' : 'NOT_APPLICABLE';
    stdout(JSON.stringify({
      state,
      reason: state === 'VERIFIED' ? null : allAppBacked ? 'APP_RENEWAL_FAILED' : 'APP_AUTH_INCOMPLETE',
      renewal: results,
      credentialsPrinted: false,
    }) + '\n');
    if (state === 'VERIFIED') return APP_AUTH_EXIT.OK;
    return state === 'NOT_APPLICABLE' ? APP_AUTH_EXIT.BLOCKED : APP_AUTH_EXIT.DEFECT;
  }

  if (command === 'state') {
    // Reports the live auth state for one role without printing the token, so a
    // run can prove renewal and expiry handling from its own logs.
    const role = argv[1];
    if (!role) return APP_AUTH_EXIT.USAGE;
    const result = await mintRoleToken({role, env, fetchImpl, now});
    const auth = result.state === 'MINTED'
      ? describeAuthState({state: 'MINTED', expiresAt: result.expiresAt, now})
      : describeAuthState({state: result.state});
    stdout(JSON.stringify({role: normalizeRole(role), state: auth.state, reason: auth.reason, mustRemint: auth.mustRemint, expiresInMs: auth.expiresInMs ?? null, credentialsPrinted: false}) + '\n');
    return auth.state === AUTH_STATES.FRESH ? APP_AUTH_EXIT.OK : APP_AUTH_EXIT.BLOCKED;
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
