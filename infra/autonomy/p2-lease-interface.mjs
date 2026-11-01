// P2 <-> Factory lease interface.
//
// THE CANONICAL IMPLEMENTATION LIVES IN THE PRIVATE FACTORY:
//   repository  donraposo1-source/project-wolf
//   branch      feat/factory-real-worker-m1-20261006
//   path        infra/autonomy/mission-lease.mjs
//   exports     claimMission, assertMissionClaim, releaseMissionClaim,
//               withMissionClaimWriteAuthority
//
// This module does not reimplement it and cannot substitute for it. It does
// three things only:
//   1. Verifies that the module it is handed really is the canonical file, by
//      SHA-256 of the bytes, before any of it is trusted.
//   2. Validates that the four required exports exist and are callable.
//   3. Normalises the Factory's return/throw conventions into one P2Denied
//      vocabulary, so the gate has a single fail-closed contract.
//
// If the canonical module is absent or unverifiable, every entry point here
// DENIES. There is no fallback, no default lease engine and no mock path in
// production code. A refusal to run is the correct outcome.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { P2_CODES, P2Denied, deny } from './p2-errors.mjs';

export const CANONICAL_LEASE_SOURCE = Object.freeze({
  repository: 'donraposo1-source/project-wolf',
  branch: 'feat/factory-real-worker-m1-20261006',
  path: 'infra/autonomy/mission-lease.mjs',
  lastObservedHead: '90cf21ae3277bcfaddeacad82f8417ee0b930cdb',
  requiredExports: Object.freeze([
    'claimMission',
    'assertMissionClaim',
    'releaseMissionClaim',
    'withMissionClaimWriteAuthority',
  ]),
});

/**
 * Pinned identity of the canonical file. This MUST be populated from a real
 * retrieval before any acceptance run; an empty pin means "unverified" and the
 * adapter refuses to operate in verified mode.
 */
export const CANONICAL_LEASE_PIN = Object.freeze({
  // Deliberately null: no retrieval of the private file has ever succeeded in
  // this environment, so recording a digest here would be a fabrication.
  sha256: null,
  sourceCommit: null,
  retrievalMethod: 'UNRETRIEVED',
});

export function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function sha256OfBytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Verify a candidate lease module against a pinned digest.
 *
 * Returns a receipt describing exactly what was proven. Never throws for a
 * mismatch: the caller decides, but the only safe decision is to stop.
 */
export function verifyLeaseModuleSource({ filePath, expectedSha256, expectedCommit = null } = {}) {
  if (typeof filePath !== 'string' || !filePath) {
    return { verified: false, state: 'LEASE_SOURCE_NOT_PROVIDED', sha256: null };
  }
  let actual;
  try {
    actual = sha256OfFile(filePath);
  } catch {
    return { verified: false, state: 'LEASE_SOURCE_UNREADABLE', sha256: null };
  }
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    return {
      verified: false,
      state: 'LEASE_SOURCE_UNPINNED',
      sha256: actual,
      // The digest is reported so an operator can pin it deliberately.
      note: 'no pinned sha256 supplied; refusing to trust an unpinned lease module',
    };
  }
  const verified = actual === expectedSha256;
  return {
    verified,
    state: verified ? 'LEASE_SOURCE_VERIFIED' : 'LEASE_SOURCE_DIGEST_MISMATCH',
    sha256: actual,
    expectedSha256,
    sourceCommit: expectedCommit,
  };
}

/** Validate the four required exports exist and are functions. */
export function verifyLeaseModuleShape(module) {
  const missing = [];
  const notCallable = [];
  for (const name of CANONICAL_LEASE_SOURCE.requiredExports) {
    if (!(name in (module ?? {}))) missing.push(name);
    else if (typeof module[name] !== 'function') notCallable.push(name);
  }
  if (missing.length || notCallable.length) {
    deny(P2_CODES.LEASE_MODULE_UNVERIFIED, `lease module shape invalid: missing=[${missing}] notCallable=[${notCallable}]`);
  }
  return true;
}

// Failure classification from a thrown lease error. The Factory's exact error
// strings are not observable from here, so classification is by keyword and any
// UNRECOGNISED failure is treated as the most restrictive outcome.
const FAILURE_KEYWORDS = [
  { pattern: /expir/i, code: P2_CODES.LEASE_EXPIRED },
  { pattern: /releas/i, code: P2_CODES.LEASE_RELEASED },
  { pattern: /fenc|stale|generation/i, code: P2_CODES.FENCE_STALE },
  { pattern: /mission|mismatch|scope/i, code: P2_CODES.LEASE_MISSION_MISMATCH },
  { pattern: /not\s*held|no\s*claim|unknown\s*claim/i, code: P2_CODES.LEASE_NOT_HELD },
];

export function classifyLeaseFailure(error) {
  if (error instanceof P2Denied) return error.code;
  const text = `${error?.code ?? ''} ${error?.message ?? ''}`;
  for (const { pattern, code } of FAILURE_KEYWORDS) {
    if (pattern.test(text)) return code;
  }
  // Unrecognised: fail closed to the narrowest denial.
  return P2_CODES.LEASE_CLAIM_INVALID;
}

/**
 * Wrap a verified canonical module in the P2 contract.
 *
 * `mode` is recorded in every receipt so no consumer can mistake an interface
 * rehearsal for production acceptance.
 */
export function createFactoryLeaseAdapter({ module, sourceIdentity, clock = () => Date.now() } = {}) {
  verifyLeaseModuleShape(module);

  const identity = Object.freeze({
    verified: sourceIdentity?.verified === true,
    state: sourceIdentity?.state ?? 'LEASE_SOURCE_UNPINNED',
    sha256: sourceIdentity?.sha256 ?? null,
    sourceCommit: sourceIdentity?.sourceCommit ?? null,
    repository: CANONICAL_LEASE_SOURCE.repository,
    path: CANONICAL_LEASE_SOURCE.path,
    // Production code must never run an unverified lease module. The gate
    // enforces this by default; tests opt out explicitly and say so.
    mode: sourceIdentity?.verified === true ? 'CANONICAL_VERIFIED' : 'UNVERIFIED_INTERFACE_ONLY',
  });

  function assertClaim(claim) {
    if (!claim || typeof claim !== 'object') {
      deny(P2_CODES.LEASE_CLAIM_INVALID, 'claim object is required');
    }
    let result;
    try {
      result = module.assertMissionClaim(claim);
    } catch (error) {
      deny(classifyLeaseFailure(error), 'factory assertMissionClaim rejected the claim');
    }
    // Support both `throws-on-invalid` and `returns-false-on-invalid` designs.
    if (result === false || result === null) {
      deny(P2_CODES.LEASE_CLAIM_INVALID, 'factory assertMissionClaim returned a falsy verdict');
    }
    if (result && typeof result === 'object') {
      if (result.valid === false || result.released === true || result.expired === true) {
        deny(
          result.released === true
            ? P2_CODES.LEASE_RELEASED
            : result.expired === true
              ? P2_CODES.LEASE_EXPIRED
              : P2_CODES.LEASE_CLAIM_INVALID,
          'factory assertMissionClaim reported an invalid claim',
        );
      }
      // A fence that went backwards is a stale-authority signal even if the
      // implementation called the claim valid.
      const claimFence = Number(claim.fencingToken ?? claim.fence);
      const resultFence = Number(result.fencingToken ?? result.fence);
      if (Number.isFinite(claimFence) && Number.isFinite(resultFence) && resultFence !== claimFence) {
        deny(
          resultFence < claimFence ? P2_CODES.FENCE_STALE : P2_CODES.FENCE_REGRESSED_DURING_READ,
          'fence changed between claim and assertion',
        );
      }
    }
    // Local expiry check as defence in depth: even a lenient assert cannot
    // extend a claim past its own recorded expiry.
    const expiresAt = claim.expiresAt ?? claim.expires_at ?? claim.leaseExpiresAt;
    if (expiresAt !== undefined && expiresAt !== null) {
      const ms = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
      if (!Number.isFinite(ms)) deny(P2_CODES.LEASE_CLAIM_INVALID, 'claim expiry is unparseable');
      if (clock() >= ms) deny(P2_CODES.LEASE_EXPIRED, 'claim expiry elapsed');
    }
    return true;
  }

  /** Execute `fn` strictly inside the Factory's write-authority scope. */
  function withWriteAuthority(claim, fn) {
    if (typeof fn !== 'function') deny(P2_CODES.GATE_CONFIGURATION_DENIED, 'fn must be callable');
    let settled = false;
    let outcome;
    let failure;

    const result = module.withMissionClaimWriteAuthority(claim, (authority) => {
      // Enforce single-shot use: the gate must run exactly once per claim scope.
      if (settled) deny(P2_CODES.GATE_REENTRANT_DENIED, 'claim scope entered twice');
      settled = true;
      try {
        outcome = fn(authority);
        return outcome;
      } catch (error) {
        failure = error;
        throw error;
      }
    });

    if (failure) throw failure;
    // If the Factory returned a promise the gate was NOT synchronous: that is a
    // contract violation for P1/P2 reads and must be surfaced, not awaited.
    if (result && typeof result.then === 'function') {
      deny(P2_CODES.GATE_CONFIGURATION_DENIED, 'withMissionClaimWriteAuthority returned a promise; synchronous scope required');
    }
    if (!settled) {
      deny(P2_CODES.GATE_NOT_IN_CLAIM_SCOPE, 'withMissionClaimWriteAuthority never invoked the scope');
    }
    return outcome;
  }

  function claim(mission) {
    try {
      const result = module.claimMission(mission);
      if (result && typeof result.then === 'function') {
        deny(P2_CODES.GATE_CONFIGURATION_DENIED, 'claimMission returned a promise; synchronous claim required');
      }
      if (!result) deny(P2_CODES.LEASE_CLAIM_INVALID, 'claimMission returned nothing');
      return result;
    } catch (error) {
      if (error instanceof P2Denied) throw error;
      deny(classifyLeaseFailure(error), 'factory claimMission failed');
    }
  }

  function release(claimArg) {
    try {
      return module.releaseMissionClaim(claimArg);
    } catch (error) {
      deny(classifyLeaseFailure(error), 'factory releaseMissionClaim failed');
    }
  }

  return Object.freeze({ identity, assertClaim, withWriteAuthority, claim, release, module });
}
