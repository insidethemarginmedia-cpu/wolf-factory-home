// Publishes the App-authentication diagnosis as a neutral check run on the public
// repository.
//
// Why this exists: job logs are not readable from the agent's environment, and a
// failed step never reaches the receipt step. Without this, every live failure
// costs a blind iteration. The payload is state and reasons only - no token, no
// key, no response body - so it is safe to publish next to public source.

const API = 'https://api.github.com';

const redact = text => String(text ?? '')
  .replace(/gh[pousr]_[A-Za-z0-9_]{16,}/g, '[REDACTED_TOKEN]')
  .replace(/ghs_[A-Za-z0-9_]{16,}/g, '[REDACTED_INSTALLATION_TOKEN]')
  // A JWT is three base64url segments. The header alone is enough to identify one,
  // so matching the whole triple would let a truncated token slip through.
  .replace(/eyJ[A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+){0,2}/g, '[REDACTED_JWT]')
  .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');

/** Builds the human-readable summary from the two report artefacts. */
export function buildDiagnosisSummary({renewal = null, acceptance = null} = {}) {
  const lines = [];
  if (!renewal) {
    lines.push('renewal: NO REPORT (the verify step wrote no file)');
  } else {
    lines.push('renewal state: ' + String(renewal.state));
    lines.push('renewal reason: ' + String(renewal.reason ?? '-'));
    for (const entry of renewal.renewal ?? []) {
      lines.push([
        '  ' + entry.role,
        'source=' + (entry.source ?? '-'),
        'renews=' + entry.renews,
        'restart=' + entry.restartRecovered,
        'first=' + (entry.first?.authState ?? '-'),
        'second=' + (entry.second?.authState ?? '-'),
        'reason=' + (entry.firstReason ?? '-'),
      ].join(' '));
      if (entry.firstMessage) lines.push('    api: ' + entry.firstMessage);
      if (entry.requestedPermissions) lines.push('    requested: ' + JSON.stringify(entry.requestedPermissions));
    }
  }

  if (!acceptance) {
    lines.push('acceptance: NO REPORT');
  } else {
    lines.push('acceptance state: ' + String(acceptance.state) + ' accepted=' + acceptance.accepted);
    for (const check of acceptance.checks ?? []) {
      lines.push('  ' + check.check + ' = ' + check.state + (check.reason ? ' (' + check.reason + ')' : '')
        + (check.httpStatus ? ' http=' + check.httpStatus : '')
        + (check.workflow ? ' workflow=' + check.workflow : '')
        + (check.apiMessage ? ' api=' + check.apiMessage : ''));
      if (check.problems?.length) lines.push('    problems: ' + JSON.stringify(check.problems).slice(0, 900));
      if (check.missing?.length) lines.push('    missing: ' + JSON.stringify(check.missing).slice(0, 400));
      if (check.overScoped?.length) lines.push('    overScoped: ' + JSON.stringify(check.overScoped).slice(0, 400));
      if (check.detail) lines.push('    detail: ' + JSON.stringify(check.detail).slice(0, 500));
    }
  }
  return redact(lines.join('\n')).slice(0, 60000);
}

/**
 * Publishes the summary. Never throws: a diagnosis that crashes is not a
 * diagnosis, and this step must not be the reason a run is red.
 */
export async function publishDiagnosis({
  token,
  repository,
  sha,
  summary,
  fetchImpl = globalThis.fetch,
  write = () => {},
} = {}) {
  if (!token) return {state: 'SKIPPED', reason: 'TOKEN_REQUIRED'};
  if (!repository || !sha) return {state: 'SKIPPED', reason: 'REPOSITORY_AND_SHA_REQUIRED'};
  try {
    const response = await fetchImpl(`${API}/repos/${repository}/check-runs`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'wolf-app-diagnosis',
        head_sha: sha,
        status: 'completed',
        conclusion: 'neutral',
        output: {title: 'App authentication diagnosis', summary},
      }),
      signal: AbortSignal.timeout(20000),
    });
    await response.body?.cancel?.();
    write((response.ok ? 'DIAGNOSIS_PUBLISHED' : 'DIAGNOSIS_REJECTED httpStatus=' + response.status) + '\n');
    return {state: response.ok ? 'PUBLISHED' : 'REJECTED', httpStatus: response.status};
  } catch (error) {
    write('DIAGNOSIS_UNAVAILABLE ' + (error?.name ?? 'Error') + '\n');
    return {state: 'UNAVAILABLE', reason: error?.name ?? 'ERROR'};
  }
}

export async function runDiagnosisCli(env = process.env, {fetchImpl = globalThis.fetch, readFile, write = () => {}, probe = false, mintInstallationToken} = {}) {
  const load = file => {
    if (!file) return null;
    try {
      return JSON.parse(readFile(file));
    } catch {
      return null;
    }
  };
  let summary = buildDiagnosisSummary({
    renewal: load(env.AUTH_RECOVERY_FILE),
    acceptance: load(env.ACCEPTANCE_FILE),
  });

  if ((probe || env.WOLF_CI_DIAGNOSIS_PROBE === 'true') && env.WOLF_FACTORY_APP_ID && env.WOLF_FACTORY_APP_PRIVATE_KEY) {
    try {
      const engine = mintInstallationToken ?? (await import('./private-ci-app-auth.mjs')).mintInstallationToken;
      const probed = await probeInstallations({env, fetchImpl, mintInstallationToken: engine});
      const lines = ['', 'installation probe (minimal contents:read only):'];
      for (const entry of probed.results) {
        lines.push('  ' + entry.role + ' idCoversRepository=' + entry.idCoversRepository
          + ' idLength=' + entry.idLength + ' numeric=' + entry.idIsNumeric
          + (entry.reason ? ' reason=' + entry.reason : '')
          + (entry.httpStatus ? ' http=' + entry.httpStatus : ''));
        if (entry.apiMessage) lines.push('    api: ' + entry.apiMessage);
      }
      summary = (summary + lines.join('\n')).slice(0, 60000);
    } catch (error) {
      summary += '\ninstallation probe unavailable: ' + (error?.message ?? 'ERROR');
    }
  }
  write(summary + '\n');
  return publishDiagnosis({token: env.GH_TOKEN, repository: env.PUBLIC_REPOSITORY, sha: env.GITHUB_SHA_VALUE, summary, fetchImpl, write});
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const {readFileSync} = await import('node:fs');
  runDiagnosisCli(process.env, {readFile: readFileSync, write: text => process.stdout.write(text)}).catch(() => {
    // Swallowed on purpose: see publishDiagnosis.
  });
}

// ---------------------------------------------------------------------------
// Differential installation probe.
//
// A mint can fail for two very different reasons:
//   (a) the installation ID does not cover the repository  -> repository error
//   (b) the installation covers it but lacks the permission -> permission error
//
// Guessing between them wastes runs. This isolates the cause by re-minting each
// role with the *minimal* permission set only: if the ID is valid, that succeeds
// regardless of what the role really needs. No token is retained or reported.
// ---------------------------------------------------------------------------

export async function probeInstallations({env = process.env, fetchImpl = globalThis.fetch, now = Date.now(), mintInstallationToken, appSecretNames} = {}) {
  const repository = env.WOLF_CI_REPOSITORY;
  const results = [];
  for (const role of ['reader', 'publisher', 'dispatcher']) {
    const installationId = env[appSecretNames?.[role] ?? ('WOLF_FACTORY_' + role.toUpperCase() + '_INSTALLATION_ID')];
    const minimal = await mintInstallationToken({
      role: 'reader', // the minimal permission set, deliberately role-independent
      appId: env[appSecretNames?.appId ?? 'WOLF_FACTORY_APP_ID'],
      privateKey: env[appSecretNames?.privateKey ?? 'WOLF_FACTORY_APP_PRIVATE_KEY'],
      installationId,
      repository,
      permissions: {contents: 'read', metadata: 'read'},
      fetchImpl,
      now,
    });
    results.push({
      role,
      // Whether this ID can reach this repository at all.
      idCoversRepository: minimal.state === 'MINTED',
      state: minimal.state,
      reason: minimal.state === 'MINTED' ? null : minimal.reason ?? minimal.state,
      httpStatus: minimal.httpStatus ?? null,
      apiMessage: minimal.apiMessage ?? null,
      // Only the shape of the ID, never its value: an ID that differs between
      // roles is the whole question, and the answer is one bit, not the digits.
      idLength: typeof installationId === 'string' ? installationId.trim().length : 0,
      idIsNumeric: /^\d+$/.test(String(installationId ?? '').trim()),
    });
  }
  const ids = results.map(entry => entry.role);
  const covering = results.filter(entry => entry.idCoversRepository).map(entry => entry.role);
  return {results, rolesWithCoveringId: covering, roles: ids};
}
