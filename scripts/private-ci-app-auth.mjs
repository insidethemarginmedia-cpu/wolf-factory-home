// GitHub App installation authentication for the Wolf private CI bridge.
//
// Replaces the recurring personal-access-token dependency with a short-lived,
// repository-scoped installation token minted on every run. Three distinct
// roles are kept apart so no single credential can read source AND publish
// status AND dispatch:
//
//   reader      contents:read     -> clone the private commit at its SHA
//   publisher   checks:write      -> publish the authenticated receipt check
//   dispatcher  actions:write     -> dispatch the private workflow
//
// Everything here is pure except `mintInstallationToken`, which is injected
// with a fetch implementation and an RS256 signer so it is testable without any
// credential. No key material is ever logged, returned or written to disk.
import {createPrivateKey, createSign, randomUUID} from 'node:crypto';
import {isRetiredDurably} from './private-ci-retirement-ledger.mjs';

export const APP_ROLES = Object.freeze(['reader', 'publisher', 'dispatcher']);

// The minimum each role needs. Anything wider is refused before a token is
// requested, so a misconfigured secret cannot silently escalate.
export const ROLE_PERMISSIONS = Object.freeze({
  reader: Object.freeze({contents: 'read', metadata: 'read'}),
  publisher: Object.freeze({checks: 'write', metadata: 'read'}),
  dispatcher: Object.freeze({actions: 'write', metadata: 'read'}),
});

export const APP_SECRET_NAMES = Object.freeze({
  appId: 'WOLF_FACTORY_APP_ID',
  privateKey: 'WOLF_FACTORY_APP_PRIVATE_KEY',
  reader: 'WOLF_FACTORY_READER_INSTALLATION_ID',
  publisher: 'WOLF_FACTORY_PUBLISHER_INSTALLATION_ID',
  dispatcher: 'WOLF_FACTORY_DISPATCHER_INSTALLATION_ID',
  // Present-only secrets from earlier infrastructure; kept for reporting.
  legacy: 'WOLF_FACTORY_APP_INSTALLATION_ID',
});

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function report(value) {
  // Presence only. The value itself never leaves this function.
  return value === undefined || value === null || String(value).trim() === '' ? 'absent' : 'present';
}

export function normalizeRole(role) {
  const value = String(role ?? '').trim().toLowerCase();
  if (!APP_ROLES.includes(value)) throw Error('APP_ROLE_DENIED');
  return value;
}

// A GitHub App private key is PEM. Accept RSA and PKCS#8 forms; reject anything
// that is not a structural private key rather than passing it to the signer.
export function loadPrivateKey(pem) {
  if (typeof pem !== 'string' || pem.trim() === '') throw Error('APP_PRIVATE_KEY_REQUIRED');
  // Secrets pasted into a web form commonly arrive with literal \n sequences,
  // sometimes mixed with real newlines. A PEM has no legitimate backslash-n, so
  // normalizing unconditionally is safe and idempotent.
  const normalized = pem.includes('\\n') ? pem.replaceAll('\\n', '\n') : pem;
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(normalized)) throw Error('APP_PRIVATE_KEY_MALFORMED');
  try {
    const key = createPrivateKey({key: normalized, format: 'pem'});
    if (key.asymmetricKeyType !== 'rsa') throw Error('APP_PRIVATE_KEY_NOT_RSA');
    return key;
  } catch (error) {
    if (error?.message === 'APP_PRIVATE_KEY_NOT_RSA') throw error;
    throw Error('APP_PRIVATE_KEY_INVALID');
  }
}

export function buildAppJwt({appId, privateKey, now = Date.now(), ttlSeconds = 540}) {
  const normalizedAppId = String(appId ?? '').trim();
  if (!/^\d+$/.test(normalizedAppId)) throw Error('APP_ID_MALFORMED');
  const key = typeof privateKey === 'string' ? loadPrivateKey(privateKey) : privateKey;
  if (!key || key.type !== 'private') throw Error('APP_PRIVATE_KEY_REQUIRED');
  // iat is backdated 60s to tolerate clock skew; exp stays under GitHub's
  // 10-minute ceiling.
  const issuedAt = Math.floor(now / 1000) - 60;
  const expiresAt = Math.floor(now / 1000) + Math.min(Math.max(ttlSeconds, 60), 600);
  const header = {alg: 'RS256', typ: 'JWT'};
  const payload = {iat: issuedAt, exp: expiresAt, iss: normalizedAppId};
  const encode = part => Buffer.from(JSON.stringify(part)).toString('base64url');
  const unsigned = `${encode(header)}.${encode(payload)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(key).toString('base64url');
  const token = `${unsigned}.${signature}`;
  if (!BASE64URL.test(signature)) throw Error('APP_JWT_SIGNATURE_INVALID');
  return {token, issuedAt, expiresAt, jti: randomUUID()};
}

export function assertLeastPrivilege(role, permissions) {
  const allowed = ROLE_PERMISSIONS[normalizeRole(role)];
  const requested = permissions ?? allowed;
  for (const [name, level] of Object.entries(requested)) {
    const permitted = allowed[name];
    if (!permitted) throw Error(`APP_PERMISSION_NOT_ALLOWED:${name}`);
    if (permitted === 'read' && level !== 'read') throw Error(`APP_PERMISSION_TOO_BROAD:${name}`);
    if (!['read', 'write', 'admin'].includes(level)) throw Error(`APP_PERMISSION_INVALID:${name}`);
  }
  return {...requested};
}

// Mints one installation token for one role. `fetchImpl` and `now` are injected
// so this can be exercised end-to-end without GitHub or a real key.
export async function mintInstallationToken({
  role,
  appId,
  privateKey,
  installationId,
  repository,
  permissions,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  ttlSeconds = 540,
  apiBase = 'https://api.github.com',
  signer = buildAppJwt,
} = {}) {
  const normalizedRole = normalizeRole(role);
  const requestPermissions = assertLeastPrivilege(normalizedRole, permissions);
  const normalizedInstallationId = String(installationId ?? '').trim();
  if (!/^\d+$/.test(normalizedInstallationId)) return {state: 'BLOCKED', role: normalizedRole, reason: 'APP_INSTALLATION_ID_REQUIRED'};
  // Repository scoping is mandatory: a token that can reach other repositories
  // is a privilege escalation, not a convenience.
  if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    return {state: 'DENIED', role: normalizedRole, reason: 'APP_REPOSITORY_SCOPE_REQUIRED'};
  }

  let jwt;
  try {
    jwt = signer({appId, privateKey, now, ttlSeconds});
  } catch (error) {
    return {state: 'BLOCKED', role: normalizedRole, reason: error?.message ?? 'APP_JWT_FAILED'};
  }

  let response;
  try {
    response = await fetchImpl(`${apiBase}/app/installations/${normalizedInstallationId}/access_tokens`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + jwt.token,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'WolfPrivateCiAppAuth',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({repositories: [repository.split('/')[1]], permissions: requestPermissions}),
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return {state: 'FAILED', role: normalizedRole, reason: 'APP_NETWORK_FAILED'};
  }

  if (!response.ok) {
    const status = Number.isInteger(response.status) ? response.status : 0;
    // GitHub's own message is the difference between a diagnosis and a guess. It
    // is a sentence about permissions, never a credential, and it is truncated
    // and redacted before it can reach a log or an artefact.
    let apiMessage = null;
    try {
      const body = await response.json();
      if (typeof body?.message === 'string') {
        apiMessage = body.message
          .replace(/gh[pousr]_[A-Za-z0-9_]{16,}/g, '[REDACTED]')
          .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
          .slice(0, 300);
      }
    } catch {
      try { await response.body?.cancel(); } catch {}
    }
    return {
      state: status === 403 || status === 404 ? 'BLOCKED' : 'FAILED',
      role: normalizedRole,
      reason: status === 401 ? 'APP_JWT_REJECTED' : status === 403 ? 'APP_INSTALLATION_FORBIDDEN' : status === 404 ? 'APP_INSTALLATION_NOT_FOUND' : 'APP_TOKEN_REQUEST_FAILED',
      httpStatus: status,
      apiMessage,
      requestedPermissions: requestPermissions,
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return {state: 'FAILED', role: normalizedRole, reason: 'APP_RESPONSE_INVALID'};
  }
  if (typeof payload?.token !== 'string' || !payload.token) {
    return {state: 'FAILED', role: normalizedRole, reason: 'APP_TOKEN_MISSING'};
  }
  const expiresAt = typeof payload.expires_at === 'string' ? payload.expires_at : null;
  const granted = payload.permissions && typeof payload.permissions === 'object'
    ? Object.fromEntries(Object.entries(payload.permissions).sort().map(([key, value]) => [key, String(value)]))
    : null;
  // The response is the authority on what was actually granted.
  for (const [name, level] of Object.entries(requestPermissions)) {
    if (granted && granted[name] !== level) {
      return {state: 'DENIED', role: normalizedRole, reason: `APP_GRANT_DIFFERS:${name}`, granted};
    }
  }
  return {
    state: 'MINTED',
    role: normalizedRole,
    token: payload.token,
    expiresAt,
    permissions: granted,
    repositoryScoped: Array.isArray(payload.repositories) && payload.repositories.length === 1
      ? payload.repositories[0].full_name === repository
      : false,
    // Explicitly absent from the result: the private key and the JWT.
  };
}

// Presence-only inventory, so the workflow can decide between App auth and the
// PAT fallback without ever printing a secret.
export function inventoryAppSecrets(env = process.env) {
  const present = name => report(env[name]);
  return {
    state: 'INVENTORIED',
    appId: present(APP_SECRET_NAMES.appId),
    privateKey: present(APP_SECRET_NAMES.privateKey),
    installations: {
      reader: present(APP_SECRET_NAMES.reader),
      publisher: present(APP_SECRET_NAMES.publisher),
      dispatcher: present(APP_SECRET_NAMES.dispatcher),
      legacy: present(APP_SECRET_NAMES.legacy),
    },
    fallback: {
      pat: present('WOLF_FACTORY_REPO_TOKEN'),
      statusPat: present('WOLF_FACTORY_STATUS_TOKEN'),
      deployKey: present('WOLF_FACTORY_DEPLOY_KEY'),
    },
    // App auth wins only when every role can be minted independently.
    appAuthComplete: [present(APP_SECRET_NAMES.appId), present(APP_SECRET_NAMES.privateKey), present(APP_SECRET_NAMES.reader), present(APP_SECRET_NAMES.publisher)]
      .every(value => value === 'present'),
    secretsReadable: false,
    credentialsPrinted: false,
  };
}

// Renewal is a re-mint, driven by the expiry of the token in hand. A token with
// less than this margin left is replaced before it is used.
export const RENEWAL_MARGIN_MS = 5 * 60 * 1000;

export function needsRenewal(expiresAt, now = Date.now()) {
  if (!expiresAt) return true;
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return true;
  return expires - now <= RENEWAL_MARGIN_MS;
}

// Chooses the credential for a role at run time. App first, PAT fallback second,
// and never a silent degradation: the caller gets the decision it made.
export function selectCredential(role, {env = process.env, ledgerText = null} = {}) {
  const normalizedRole = normalizeRole(role);
  const inventory = inventoryAppSecrets(env);
  const installationSecret = APP_SECRET_NAMES[normalizedRole];
  if (inventory.appId === 'present' && inventory.privateKey === 'present' && report(env[installationSecret]) === 'present') {
    return {role: normalizedRole, source: 'github-app', installationIdSecret: installationSecret, fallback: false};
  }
  const patByRole = {
    reader: env.WOLF_FACTORY_REPO_TOKEN,
    publisher: env.WOLF_FACTORY_STATUS_TOKEN,
    dispatcher: env.WOLF_FACTORY_REPO_TOKEN,
  };
  // Retirement is enforced here, at the single place a credential is chosen.
  //
  // It consults two independent sources, and either one is sufficient:
  //
  //   1. the run's own flag (`WOLF_CI_RETIRE_PAT`), set by the retirement step
  //      once this run decides RETIRE_FALLBACK, and
  //   2. the durable ledger on the retirement branch, which records decisions
  //      made by *earlier* runs.
  //
  // The ledger is what makes the retirement a property of the repository rather
  // than of one workflow run. Without it, any fresh run — a retry, a manual
  // dispatch, a different workflow — would silently regain the fallback, and
  // "retired" would mean only "retired during that run". A per-run flag is
  // evidence; the ledger is enforcement.
  const retirement = isRetiredDurably({
    env,
    ledgerText: ledgerText ?? env.WOLF_CI_RETIREMENT_LEDGER_TEXT ?? null,
  });
  if (retirement.retired && report(patByRole[normalizedRole]) === 'present') {
    return {
      role: normalizedRole,
      source: 'none',
      fallback: false,
      reason: 'PAT_FALLBACK_RETIRED',
      retired: true,
      // Which evidence closed the fallback: this run, an earlier run, or both.
      retirementSource: retirement.source,
      retirementSince: retirement.since,
      // The credential exists but is deliberately unusable.
      withheldCredential: patByRole[normalizedRole] ? 'pat' : null,
    };
  }
  if (report(patByRole[normalizedRole]) === 'present') {
    return {role: normalizedRole, source: 'pat-fallback', fallback: true, reason: 'APP_AUTH_INCOMPLETE'};
  }
  return {role: normalizedRole, source: 'none', fallback: false, reason: 'NO_CREDENTIAL_FOR_ROLE'};
}

// The environment flag that makes retirement operational rather than advisory.
export const RETIREMENT_ENV = 'WOLF_CI_RETIRE_PAT';

export function isFallbackRetired(env = process.env) {
  const value = String(env[RETIREMENT_ENV] ?? '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'retired';
}

// ---------------------------------------------------------------------------
// Auth state: renewal, expiry recovery and revocation handling.
//
// A token in hand is not the same as a usable token. Every consumer asks this
// state machine first, and the state names exactly why a token must be replaced,
// so a revocation cannot be mistaken for a transient failure and retried forever.
// ---------------------------------------------------------------------------

export const AUTH_STATES = Object.freeze({
  FRESH: 'FRESH',
  RENEW: 'RENEW',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED',
  FALLBACK: 'FALLBACK',
  NONE: 'NONE',
});

export function describeAuthState({state, expiresAt, now = Date.now(), unauthorized = false} = {}) {
  if (unauthorized) return {state: AUTH_STATES.REVOKED, reason: 'TOKEN_REVOKED_OR_REJECTED', mustRemint: true};
  if (state && state !== 'MINTED' && state !== 'FALLBACK') {
    return {state: AUTH_STATES.NONE, reason: state, mustRemint: true};
  }
  if (state === 'FALLBACK') return {state: AUTH_STATES.FALLBACK, reason: 'APP_AUTH_INCOMPLETE', mustRemint: true};
  if (!expiresAt) return {state: AUTH_STATES.EXPIRED, reason: 'APP_TOKEN_EXPIRY_UNKNOWN', mustRemint: true};
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return {state: AUTH_STATES.EXPIRED, reason: 'APP_TOKEN_EXPIRY_INVALID', mustRemint: true};
  if (expires <= now) return {state: AUTH_STATES.EXPIRED, reason: 'APP_TOKEN_EXPIRED', mustRemint: true, expiredForMs: now - expires};
  if (expires - now <= RENEWAL_MARGIN_MS) return {state: AUTH_STATES.RENEW, reason: 'APP_TOKEN_NEAR_EXPIRY', mustRemint: true, expiresInMs: expires - now};
  return {state: AUTH_STATES.FRESH, reason: null, mustRemint: false, expiresInMs: expires - now};
}

/**
 * Mints a token, then re-mints only when the state says it must.
 *
 * `renew` is separate from `mint` so this can be tested without a network: the
 * recovery ladder is the interesting part, not the HTTP call.
 */
export async function ensureToken({role, mint, renew = mint, now = Date.now(), maxAttempts = 2} = {}) {
  if (typeof mint !== 'function') throw Error('APP_MINT_REQUIRED');
  const attempts = [];
  let result = await mint({role, now, attempt: 0});
  attempts.push({attempt: 0, state: result?.state ?? 'UNKNOWN', expiresAt: result?.expiresAt ?? null});
  if (result?.state === 'MINTED') {
    let auth = describeAuthState({state: 'MINTED', expiresAt: result.expiresAt, now});
    if (!auth.mustRemint) return {role, result, auth, attempts, recovered: false};
    // A token minted already expired (or nearly so) is a defect, not a race:
    // try exactly once more, then report it rather than looping.
    if (maxAttempts <= 1) return {role, result, auth, attempts, recovered: false};
    const second = await renew({role, now, attempt: 1});
    attempts.push({attempt: 1, state: second?.state ?? 'UNKNOWN', expiresAt: second?.expiresAt ?? null});
    auth = describeAuthState({state: second?.state === 'MINTED' ? 'MINTED' : second?.state, expiresAt: second?.expiresAt, now});
    // A token that is still not fresh after a re-mint is reported expired, never
    // reported as recovered.
    if (auth.state === AUTH_STATES.RENEW) auth = {...auth, state: AUTH_STATES.EXPIRED, reason: 'APP_RENEWAL_DID_NOT_REFRESH'};
    return {role, result: second, auth, attempts, recovered: second?.state === 'MINTED' && auth.state === AUTH_STATES.FRESH};
  }
  return {role, result, auth: describeAuthState({state: result?.state, expiresAt: result?.expiresAt, now}), attempts, recovered: false};
}

/**
 * Classifies a rejected API call. 401 means the installation token was revoked
 * or expired early; the caller must re-mint, not retry the same credential.
 */
export function classifyRejection(httpStatus) {
  const status = Number(httpStatus) || 0;
  if (status === 401) return {state: AUTH_STATES.REVOKED, retryable: false, mustRemint: true, reason: 'TOKEN_REVOKED_OR_REJECTED'};
  if (status === 403) return {state: AUTH_STATES.NONE, retryable: false, mustRemint: false, reason: 'PERMISSION_OR_RATE_LIMIT'};
  if (status === 404) return {state: AUTH_STATES.NONE, retryable: false, mustRemint: false, reason: 'NOT_FOUND_OR_NO_ACCESS'};
  if (status >= 500) return {state: AUTH_STATES.NONE, retryable: true, mustRemint: false, reason: 'UPSTREAM_ERROR'};
  return {state: AUTH_STATES.NONE, retryable: false, mustRemint: false, reason: 'CLIENT_ERROR'};
}

/**
 * Runs `call` with a token and heals a revoked credential exactly once.
 * Bounded on purpose: a revoked installation that cannot re-mint must surface an
 * honest failure rather than an unbounded retry loop.
 */
export async function withAuthRecovery({ensure, call, maxRecoveries = 1} = {}) {
  if (typeof call !== 'function') throw Error('APP_CALL_REQUIRED');
  let issued = await ensure();
  let token = issued?.result?.token;
  if (!token) return {state: issued?.auth?.state ?? AUTH_STATES.NONE, reason: issued?.auth?.reason ?? 'NO_TOKEN', recovered: false, result: null};
  for (let recovery = 0; ; recovery += 1) {
    const outcome = await call(token);
    const status = outcome?.httpStatus ?? outcome?.status ?? 0;
    if (status !== 401) return {state: outcome?.state ?? 'OK', recovered: recovery > 0, result: outcome, httpStatus: status};
    const classified = classifyRejection(status);
    if (!classified.mustRemint || recovery >= maxRecoveries) {
      return {state: AUTH_STATES.REVOKED, reason: classified.reason, recovered: false, result: outcome, httpStatus: status};
    }
    issued = await ensure({force: true, reason: 'TOKEN_REVOKED_OR_REJECTED'});
    const renewed = issued?.result?.token;
    if (!renewed || renewed === token) {
      return {state: AUTH_STATES.REVOKED, reason: 'REVOKED_AND_NOT_REISSUABLE', recovered: false, result: outcome, httpStatus: status};
    }
    token = renewed;
  }
}

// ---------------------------------------------------------------------------
// Installation resolution by repository coverage.
//
// An installation ID is a pointer, not a credential: it grants nothing by itself.
// What bounds a token is the permission set requested at mint time, which is fixed
// per role and checked before any request. That is why resolving the *pointer* by
// coverage is safe, while resolving the *permission* would not be.
//
// This exists because a role's configured ID can name an installation that cannot
// see the repository - for example the other personal account's installation when
// both accounts are personal and each holds one repository. The mint fails with a
// reachability error (422), not a permission error (403), and the distinction is
// exactly what makes self-repair correct here.
// ---------------------------------------------------------------------------

const REACHABILITY_REASONS = new Set(['APP_TOKEN_REQUEST_FAILED']);

const indicatesWrongInstallation = result =>
  result?.state !== 'MINTED'
  && (REACHABILITY_REASONS.has(result?.reason) || result?.httpStatus === 422);

/**
 * Resolves the installation that actually covers `repository`, preferring the
 * role's own configured ID and falling back to another role's ID only when that
 * ID provably covers the repository and the App is the same.
 *
 * Returns `{installationId, resolvedFrom, attempted}`. `resolvedFrom` is the role
 * whose ID was used, so a repaired configuration is never invisible.
 */
export async function resolveInstallationForRepository({
  role,
  installationIds = {},
  probe,
  now = Date.now(),
} = {}) {
  const order = [role, ...Object.keys(installationIds).filter(key => key !== role)];
  const attempted = [];
  for (const candidateRole of order) {
    const installationId = installationIds[candidateRole];
    if (typeof installationId !== 'string' || !installationId.trim()) continue;
    const result = await probe({installationId, now});
    // The message and status are carried on every attempt: three failures with no
    // cause is what made the live diagnosis expensive in the first place.
    attempted.push({
      source: candidateRole,
      ok: result?.state === 'MINTED',
      reason: result?.reason ?? null,
      httpStatus: result?.httpStatus ?? null,
      apiMessage: result?.apiMessage ?? null,
    });
    if (result?.state === 'MINTED') {
      return {
        installationId,
        resolvedFrom: candidateRole,
        // True when the role's own ID was unusable and another was chosen.
        repaired: candidateRole !== role,
        attempted,
        result,
      };
    }
  }
  return {installationId: null, resolvedFrom: null, repaired: false, attempted, result: null};
}

export { indicatesWrongInstallation };

// ---------------------------------------------------------------------------
// Fallback retirement gate.
//
// The PAT fallback is not deleted on a hunch: it is retired only when the run can
// prove the App took over. The gate is deliberately one-way and fail-closed - an
// absent or unreadable acceptance report keeps the fallback in place, because
// removing a working credential on ambiguous evidence is how an outage starts.
// ---------------------------------------------------------------------------

export const RETIREMENT_STATES = Object.freeze({
  KEEP_FALLBACK: 'KEEP_FALLBACK',
  RETIRE_FALLBACK: 'RETIRE_FALLBACK',
});

/**
 * Decides whether the PAT fallback may be retired for this run.
 *
 * Requirements, all of which must hold:
 *   - the acceptance report says ACCEPTED with every check PASS;
 *   - authentication mode is github-app, not pat-fallback;
 *   - every role minted from the App, and none fell back.
 */
export function decideFallbackRetirement({acceptance, authentication, renewal} = {}) {
  const reasons = [];
  if (!acceptance || typeof acceptance !== 'object') reasons.push('ACCEPTANCE_REPORT_ABSENT');
  else {
    if (acceptance.accepted !== true) reasons.push('ACCEPTANCE_NOT_ACCEPTED');
    if (acceptance.state !== 'ACCEPTED') reasons.push('ACCEPTANCE_STATE_' + String(acceptance.state));
    const blocked = (acceptance.checks ?? []).filter(check => check.state !== 'PASS');
    if (blocked.length) reasons.push('CHECKS_NOT_ALL_PASS:' + blocked.map(check => check.check).join(','));
  }
  if (!authentication || authentication.mode !== 'github-app') reasons.push('AUTH_MODE_NOT_GITHUB_APP');
  // Accept both shapes: the raw report uses `renewal`, the receipt reader
  // normalises it to `roles`. A decision that only understood one of them would
  // report RENEWAL_REPORT_ABSENT on a perfectly good run.
  const roles = renewal?.renewal ?? renewal?.roles ?? [];
  if (!roles.length) reasons.push('RENEWAL_REPORT_ABSENT');
  else if (roles.some(entry => entry.source !== 'github-app')) reasons.push('RENEWAL_USED_FALLBACK');
  if (renewal && renewal.state !== 'VERIFIED') reasons.push('RENEWAL_STATE_' + String(renewal.state));

  const retire = reasons.length === 0;
  return {
    state: retire ? RETIREMENT_STATES.RETIRE_FALLBACK : RETIREMENT_STATES.KEEP_FALLBACK,
    retire,
    reasons,
    // Stated explicitly so nobody reads "keep" as "not evaluated".
    evaluated: true,
    credentialsPrinted: false,
  };
}

/**
 * Reports whether a role is permitted to fall back, given the decision.
 * Once retired, a role with no App token fails instead of silently using a PAT.
 */
export function fallbackAllowed(decision) {
  return decision?.retire === true ? false : true;
}
