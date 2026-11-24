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
    try { await response.body?.cancel(); } catch {}
    return {
      state: status === 403 || status === 404 ? 'BLOCKED' : 'FAILED',
      role: normalizedRole,
      reason: status === 401 ? 'APP_JWT_REJECTED' : status === 403 ? 'APP_INSTALLATION_FORBIDDEN' : status === 404 ? 'APP_INSTALLATION_NOT_FOUND' : 'APP_TOKEN_REQUEST_FAILED',
      httpStatus: status,
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
export function selectCredential(role, {env = process.env} = {}) {
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
  if (report(patByRole[normalizedRole]) === 'present') {
    return {role: normalizedRole, source: 'pat-fallback', fallback: true, reason: 'APP_AUTH_INCOMPLETE'};
  }
  return {role: normalizedRole, source: 'none', fallback: false, reason: 'NO_CREDENTIAL_FOR_ROLE'};
}
