/*
 * Wolf Omega P0 -- shared, dependency-free policy and canonical helpers.
 *
 * INTEGRATION CONTRACT (read before wiring into the existing Factory):
 *   This directory is a *pre-effect boundary library*, not a control plane. It owns
 *   no missions, no ledger, no scheduler, no database, no publication authority and
 *   performs no external effect by itself. Every authority fact is READ through the
 *   injected `ports` object, which must be bound to the EXISTING Factory KCT/DBOS
 *   authority and immutable ledger. Caller-supplied declarations are never proof.
 *   The existing Omega B/C adapters must call the gate immediately before their
 *   existing `POST /api/runs` (or equivalent) request; nothing else is replaced.
 */
import crypto from 'node:crypto';

export const POLICY = Object.freeze({
  EUR_SPEND: '0',
  COST_UNKNOWN: 'DENY',
  PAID_FALLBACK: 'DENY',
  TRIAL_CREDIT: 'DENY',
  JULES: 'FORBIDDEN',
  UNKNOWN_EXTERNAL_EFFECT: 'RECONCILE_ONLY',
});

export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const SHA256_HEX = /^[a-f0-9]{64}$/;
export const MAX_BODY_BYTES = 65536;
export const MAX_RESULT_BYTES = 1048576;

export class Denied extends Error {
  constructor(reason, detail) {
    super(reason);
    this.name = 'Denied';
    this.wolfReason = reason;
    this.wolfDetail = detail === undefined ? null : detail;
  }
}

export function deny(reason, detail) {
  throw new Denied(reason, detail);
}

export function failClosed(error) {
  const reason = error instanceof Denied ? error.wolfReason : 'AUTHORITY_READ_FAILED';
  const detail = error instanceof Denied ? error.wolfDetail : null;
  return Object.freeze({state: 'DENIED', reason, detail, automaticRetryAuthorized: false});
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deterministic, sorted-key JSON. Rejects values that make bindings ambiguous. */
export function canonical(value) {
  const sort = v => {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) deny('CANONICAL_VALUE_INVALID', 'non-finite number');
      return v;
    }
    if (Array.isArray(v)) return v.map(sort);
    if (isPlainObject(v)) {
      const out = {};
      for (const key of Object.keys(v).sort()) {
        if (v[key] === undefined) deny('CANONICAL_VALUE_INVALID', 'undefined field: ' + key);
        out[key] = sort(v[key]);
      }
      return out;
    }
    deny('CANONICAL_VALUE_INVALID', typeof v);
  };
  return JSON.stringify(sort(value));
}

export function sha256(value) {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function canonicalDigest(value) {
  return sha256(canonical(value));
}

export function timingSafeHex(actual, expected) {
  if (typeof actual !== 'string' || !SHA256_HEX.test(actual) ||
      typeof expected !== 'string' || !SHA256_HEX.test(expected)) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

export function isIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

export function assertIdentifier(value, field) {
  if (!isIdentifier(value)) deny('REQUEST_SHAPE_INVALID', field);
  return value;
}

/** Exact-origin URL admission. No credentials, query, fragment or redirect surface. */
export function trustedUrl(value, allowedOrigins, allowedPaths) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) return false;
  if (!allowedOrigins.has(url.origin)) return false;
  if (allowedPaths && !allowedPaths.has(url.pathname)) return false;
  return url.href === url.origin + url.pathname;
}

export function readPort(ports, name, arg) {
  const fn = ports && ports[name];
  if (typeof fn !== 'function') deny('AUTHORITY_PORT_MISSING', name);
  try { return fn(arg); } catch (error) { deny('AUTHORITY_READ_FAILED', name); }
}
