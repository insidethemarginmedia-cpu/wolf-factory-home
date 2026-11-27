// Former GitHub App manifest/creation flow.
//
// Creating or installing a new App is not authorized: the request is to recover
// existing infrastructure, and the bridge is not activated. Manifest and form
// generation therefore fail closed. The read-only permission audit and conversion
// summary remain available for a future owner-approved review of an existing App;
// they never print private-key material.
import {pathToFileURL} from 'node:url';

export const APP_NAME = 'Wolf Factory Automation (historical proposal)';
export const APP_SETUP_STATUS = 'WITHDRAWN';
// Kept as an empty compatibility export for callers; no setup endpoint is exposed.
export const MANIFEST_ENDPOINTS = Object.freeze({});

export function buildAppManifest() {
  throw Error('APP_SETUP_NOT_AUTHORIZED');
}

export function buildManifestForm() {
  throw Error('APP_SETUP_NOT_AUTHORIZED');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify({
    state: 'BLOCKED',
    reason: 'APP_SETUP_NOT_AUTHORIZED',
    authorizedActions: [],
    credentialsPrinted: false,
    dispatchAuthorized: false,
  }) + '\n');
  process.exitCode = 78;
}

// ---------------------------------------------------------------------------
// Read-only audit for a future, explicitly owner-approved review of an existing
// installation. No network access, secret storage, or setup step occurs here.
// ---------------------------------------------------------------------------

export const PERMISSION_CEILING = Object.freeze({
  contents: 'read',
  metadata: 'read',
  checks: 'write',
  actions: 'write',
  administration: 'none',
  members: 'none',
});

const RANK = Object.freeze({none: 0, read: 1, write: 2});

/**
 * Compares granted permissions with the reviewed ceiling.
 * Returns `{state: 'WITHIN_MINIMUM' | 'EXCESS' | 'INSUFFICIENT', excess, missing}`.
 */
export function auditGrantedPermissions(granted = {}, ceiling = PERMISSION_CEILING) {
  const excess = [];
  const missing = [];
  for (const [name, level] of Object.entries(granted)) {
    const allowed = ceiling[name] ?? 'none';
    if ((RANK[level] ?? 99) > (RANK[allowed] ?? 0)) excess.push({permission: name, granted: level, allowed});
    if (level === 'write' && !['checks', 'actions'].includes(name)) excess.push({permission: name, granted: level, allowed: 'read-or-none'});
  }
  for (const name of ['contents', 'metadata']) {
    if ((RANK[granted[name]] ?? 0) < RANK.read) missing.push({permission: name, needed: 'read'});
  }
  const state = excess.length ? 'EXCESS' : missing.length ? 'INSUFFICIENT' : 'WITHIN_MINIMUM';
  return {state, excess, missing};
}

/**
 * Extracts non-secret facts from an existing conversion response. The PEM is
 * returned separately to the local caller and is never placed in the summary.
 */
export function readConversion(payload = {}) {
  const {pem, id, slug, owner, permissions, events, html_url: htmlUrl} = payload;
  const summary = {
    state: 'CONVERTED',
    appId: id ?? null,
    slug: slug ?? null,
    owner: owner?.login ?? null,
    htmlUrl: htmlUrl ?? null,
    permissions: permissions ?? {},
    events: Array.isArray(events) ? events.length : null,
    hasPrivateKey: typeof pem === 'string' && pem.length > 0,
    credentialsPrinted: false,
  };
  const audit = auditGrantedPermissions(summary.permissions);
  return {summary: {...summary, audit: audit.state, excess: audit.excess, missing: audit.missing}, privateKey: typeof pem === 'string' && pem.length > 0 ? pem : null};
}
