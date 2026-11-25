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
  resolveInstallationForRepository,
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
  const repository = env.WOLF_CI_REPOSITORY;
  const permissions = ROLE_PERMISSIONS[normalizedRole];
  const appId = env[APP_SECRET_NAMES.appId];
  const privateKey = env[APP_SECRET_NAMES.privateKey];

  // Resolve the installation that actually covers the repository, then mint with
  // this role's fixed permission set.
  //
  // The pointer may be corrected; the permission set never is. That distinction is
  // what keeps this from becoming privilege escalation: an installation ID grants
  // nothing on its own, whereas a widened permission would.
  const resolution = await resolveInstallationForRepository({
    role: normalizedRole,
    installationIds: {
      reader: env[APP_SECRET_NAMES.reader],
      publisher: env[APP_SECRET_NAMES.publisher],
      dispatcher: env[APP_SECRET_NAMES.dispatcher],
    },
    now,
    probe: ({installationId, now: probeNow}) => mintInstallationToken({
      role: normalizedRole, appId, privateKey, installationId, repository, permissions, fetchImpl, now: probeNow,
    }),
  });

  if (!resolution.installationId) {
    const last = resolution.result ?? {};
    return {
      state: last.state === 'BLOCKED' ? 'BLOCKED' : 'FAILED',
      role: normalizedRole,
      selection,
      reason: last.reason ?? 'NO_INSTALLATION_COVERS_REPOSITORY',
      // The most informative attempt wins: a 422 with a message explains far more
      // than a bare null on the aggregate result.
      httpStatus: last.httpStatus ?? resolution.attempted.find(entry => entry.httpStatus)?.httpStatus ?? null,
      apiMessage: last.apiMessage ?? resolution.attempted.find(entry => entry.apiMessage)?.apiMessage ?? null,
      attemptedInstallations: resolution.attempted,
      // Says plainly which IDs were tried and which failed, without values.
      installationResolution: 'UNRESOLVED',
    };
  }

  const installationId = resolution.installationId;
  const result = await mintInstallationToken({
    role: normalizedRole,
    appId,
    privateKey,
    installationId,
    repository,
    permissions,
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
    // Which role's installation pointer was used, and whether it was repaired.
    installationSource: resolution.resolvedFrom,
    installationRepaired: resolution.repaired,
    installationResolution: resolution.repaired ? 'REPAIRED_BY_COVERAGE' : 'CONFIGURED',
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
  // Reads `--flag value` from argv. Numbers and paths only; no credential is ever
  // passed on the command line, because argv is visible in process listings.
  const flag = name => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
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
        // The mint's own reason, so a BLOCKED role names its cause instead of
        // only showing NONE.
        firstReason: first.state === 'MINTED' ? null : (first.reason ?? first.state ?? null),
        firstMessage: first.state === 'MINTED' ? null : (first.apiMessage ?? null),
        secondReason: second.state === 'MINTED' ? null : (second.reason ?? second.state ?? null),
        requestedPermissions: ROLE_PERMISSIONS[normalizeRole(role)],
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

  if (command === 'retirement') {
    // Computes the retirement decision from this run's artefacts and, only when it
    // is RETIRE_FALLBACK, exports the enforcement flag for every later step.
    //
    // Nothing is retired on partial evidence: an absent artefact yields
    // KEEP_FALLBACK, and KEEP_FALLBACK writes nothing, so a working credential is
    // never withdrawn by omission.
    const {decideFallbackRetirement} = await import('./private-ci-app-auth.mjs');
    const load = path => {
      if (!path) return null;
      try {
        return JSON.parse(fs.readFileSync(path, 'utf8'));
      } catch {
        return null;
      }
    };
    const renewal = load(env.WOLF_CI_AUTH_RECOVERY_FILE);
    const acceptance = load(env.WOLF_CI_ACCEPTANCE_FILE);
    const decision = decideFallbackRetirement({
      acceptance: acceptance ? {state: acceptance.state, accepted: acceptance.accepted, checks: acceptance.checks ?? []} : null,
      authentication: renewal?.state === 'VERIFIED' ? {mode: 'github-app'} : {mode: 'pat-fallback'},
      renewal,
    });
    const outFile = env.WOLF_CI_RETIREMENT_FILE;
    if (outFile) {
      fs.mkdirSync(path.dirname(outFile), {recursive: true});
      fs.writeFileSync(outFile, JSON.stringify(decision, null, 2), {mode: 0o600});
    }
    stdout(JSON.stringify(decision) + '\n');
    if (decision.retire && env.GITHUB_ENV) {
      fs.appendFileSync(env.GITHUB_ENV, `${'WOLF_CI_RETIRE_PAT'}=true\n`);
      stdout('FETCH_RETIREMENT_ENFORCED=' + 'true' + '\n');
    }
    return APP_AUTH_EXIT.OK;
  }

  if (command === 'retirement-record') {
    // Appends this run's retirement decision to the durable ledger file.
    //
    // Only a RETIRE_FALLBACK decision is appended. A KEEP decision writes nothing:
    // the ledger is an append-only record of the point at which the fallback was
    // withdrawn, and adding "still keeping it" lines would bury that point. The
    // file is created parentally so the workflow can commit it to the ledger
    // branch, and never contains a credential.
    const {retirementRecord} = await import('./private-ci-retirement-ledger.mjs');
    const source = flag('--from') ?? env.WOLF_CI_RETIREMENT_FILE;
    let decision = null;
    if (source) {
      try {
        decision = JSON.parse(fs.readFileSync(source, 'utf8'));
      } catch {
        decision = null;
      }
    }
    if (!decision) {
      stdout(JSON.stringify({state: 'ACTIVE', appended: false, reason: 'NO_RETIREMENT_DECISION'}) + '\n');
      return APP_AUTH_EXIT.OK;
    }
    if (decision.retire !== true) {
      // Deliberately silent on the ledger. Recorded here so the run's log shows
      // the ledger was consulted and intentionally left alone.
      stdout(JSON.stringify({state: 'ACTIVE', appended: false, reason: 'DECISION_KEEPS_FALLBACK'}) + '\n');
      return APP_AUTH_EXIT.OK;
    }
    const target = flag('--out') ?? env.WOLF_CI_RETIREMENT_LEDGER_FILE;
    if (!target) {
      stdout(JSON.stringify({state: 'ERROR', appended: false, reason: 'LEDGER_FILE_REQUIRED'}) + '\n');
      return APP_AUTH_EXIT.USAGE;
    }
    const record = retirementRecord(decision, {
      commit: env.WOLF_CI_COMMIT ?? env.GITHUB_SHA ?? null,
      runId: env.GITHUB_RUN_ID ?? null,
      source: 'retirement-record',
    });
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    const separator = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.appendFileSync(target, separator + JSON.stringify(record) + '\n', {mode: 0o600});
    stdout(JSON.stringify({state: 'RETIRED', appended: true, ledger: target, credentialsPrinted: false}) + '\n');
    return APP_AUTH_EXIT.OK;
  }

  if (command === 'retirement-check') {
    // Answers the only question the credential selector asks, from the ledger
    // alone. Used to prove, in a run that has no per-run flag, that retirement
    // still holds.
    const {readLedgerVerdict} = await import('./private-ci-retirement-ledger.mjs');
    const file = flag('--ledger') ?? env.WOLF_CI_RETIREMENT_LEDGER_FILE;
    let text = null;
    if (file) {
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        text = null;
      }
    }
    stdout(JSON.stringify(readLedgerVerdict(text)) + '\n');
    return APP_AUTH_EXIT.OK;
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
