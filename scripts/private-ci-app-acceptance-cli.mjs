// CLI for live App acceptance. Runs inside GitHub Actions, where the secrets are.
//
//   node scripts/private-ci-app-acceptance-cli.mjs --out /tmp/acceptance.json
//
// Exit codes:
//   0  ACCEPTED  — every check passed against the real API
//   1  FAIL      — a defect; the run must go red
//   78 BLOCKED   — a capability is absent; not a pass, and not a repair
//
// Nothing is written to the artefact that could be replayed as a credential.
// Tokens live in local variables and are never serialised.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  ACCEPTANCE_STATES,
  inventoryEnvironment,
  checkInstallationMapping,
  checkIndependentTokens,
  checkExactShaRead,
  checkPrivateCheckPublication,
  checkDispatch,
  checkRenewalWithClock,
  checkExpiryAndDenial,
  summarise,
} from './private-ci-app-acceptance.mjs';

export const ACCEPTANCE_EXIT = Object.freeze({ACCEPTED: 0, FAIL: 1, USAGE: 2, BLOCKED: 78});

/**
 * Redacts anything that looks like a credential from a structure on its way to
 * disk. This is a belt-and-braces measure: the checks are written not to include
 * tokens, and this is the second line of defence if one slips in.
 */
export function redactForArtefact(value, depth = 0) {
  if (depth > 12) return '[depth-limited]';
  if (typeof value === 'string') {
    return value
      .replace(/gh[pousr]_[A-Za-z0-9_]{16,}/g, '[REDACTED_TOKEN]')
      .replace(/ghs_[A-Za-z0-9_]{16,}/g, '[REDACTED_INSTALLATION_TOKEN]')
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
      .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED_JWT]');
  }
  if (Array.isArray(value)) return value.map(item => redactForArtefact(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      // Drop token fields outright rather than trusting the pattern match.
      if (/^(token|privateKey|pem|jwt|authorization)$/i.test(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      out[key] = redactForArtefact(entry, depth + 1);
    }
    return out;
  }
  return value;
}

export async function runAcceptance({env = process.env, fetchImpl = globalThis.fetch, now = Date.now()} = {}) {
  const inventory = inventoryEnvironment(env);
  const repository = env.WOLF_CI_REPOSITORY;
  const sha = env.WOLF_CI_SHA;

  const checks = [];

  // 1. App identity and installation mapping.
  checks.push(await checkInstallationMapping({env, fetchImpl, now}));

  // 2. Three independent tokens.
  const tokens = await checkIndependentTokens({env, fetchImpl, now});
  checks.push(tokens);

  // The remaining checks need a real token. They are re-minted here so the
  // acceptance run does not depend on tokens issued in an earlier step, which
  // also exercises the mint path a second time.
  const mintFor = async role => {
    const {APP_SECRET_NAMES} = await import('./private-ci-app-auth.mjs');
    const {mintRoleToken} = await import('./private-ci-app-auth-cli.mjs');
    if (!env[APP_SECRET_NAMES.appId] || !env[APP_SECRET_NAMES.privateKey]) return null;
    // The same resolver the workflow uses, so a corrected installation pointer is
    // corrected here too and acceptance grades the configuration that ships.
    const result = await mintRoleToken({role, env, fetchImpl, now});
    return result.state === 'MINTED' ? result.token : null;
  };

  const readerToken = await mintFor('reader');
  const publisherToken = await mintFor('publisher');
  const dispatcherToken = await mintFor('dispatcher');

  // 3. Exact-SHA read.
  checks.push(await checkExactShaRead({token: readerToken, repository, sha, fetchImpl}));

  // 4. Private check publication at that SHA.
  checks.push(await checkPrivateCheckPublication({
    token: publisherToken,
    repository,
    sha,
    name: 'wolf-acceptance-' + String(env.WOLF_CI_PR ?? 'head'),
    fetchImpl,
  }));

  // 5. Real dispatch. `settleMs` is short here because the acceptance step runs
  // inside the very workflow being dispatched, which is already busy; the point
  // is the 204 and the run count, not a second execution.
  checks.push(await checkDispatch({
    token: dispatcherToken,
    repository,
    workflow: env.WOLF_ACCEPTANCE_WORKFLOW || null,
    ref: env.WOLF_ACCEPTANCE_REF || 'main',
    sha,
    pr: env.WOLF_CI_PR,
    fetchImpl,
  }));

  // 6. Renewal and restart recovery.
  checks.push(await checkRenewalWithClock({env, fetchImpl, now}));

  // 7. Expiry and permission-denied handling.
  checks.push(await checkExpiryAndDenial({env, fetchImpl, now}));

  const summary = summarise(checks);
  return {
    ...summary,
    generatedAt: new Date(now).toISOString(),
    repository,
    sha,
    inventory,
    checks,
  };
}

export async function runAcceptanceCli(argv = [], {env = process.env, fetchImpl = globalThis.fetch, now = Date.now(), stdout = text => process.stdout.write(text)} = {}) {
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? argv[outIndex + 1] : env.WOLF_ACCEPTANCE_FILE;
  const report = await runAcceptance({env, fetchImpl, now});
  const artefact = redactForArtefact(report);
  if (out) {
    fs.mkdirSync(path.dirname(out), {recursive: true});
    fs.writeFileSync(out, JSON.stringify(artefact, null, 2), {mode: 0o600});
  }
  // The console line is deliberately terse: the artefact carries the detail.
  const blocked = report.checks.filter(check => check.state === ACCEPTANCE_STATES.BLOCKED).map(check => check.check + ':' + check.reason);
  const failed = report.checks.filter(check => check.state === ACCEPTANCE_STATES.FAIL).map(check => check.check + ':' + check.reason);
  stdout(JSON.stringify({state: report.state, accepted: report.accepted, counts: report.counts, blocked, failed, credentialsPrinted: false}) + '\n');
  if (report.accepted) return ACCEPTANCE_EXIT.ACCEPTED;
  return failed.length ? ACCEPTANCE_EXIT.FAIL : ACCEPTANCE_EXIT.BLOCKED;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runAcceptanceCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(JSON.stringify({state: 'FAILED', reason: error?.message ?? 'ACCEPTANCE_CLI_FAILED'}) + '\n');
    process.exitCode = ACCEPTANCE_EXIT.FAIL;
  }
}
