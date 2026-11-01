// P2 authorization gate.
//
// The gate is the ONLY path through which P1 memory may be read during a
// mission. It composes, in this order and inside one synchronous claim scope:
//
//   1. LEASE CHECK      factory.assertMissionClaim(claim)   -- before any IO
//   2. SCOPE DERIVATION missionId/namespace taken FROM THE CLAIM, never from
//                       the caller, so a worker cannot ask for another
//                       mission's memory
//   3. SYNC READ        real SQLite read (node:sqlite is synchronous)
//   4. REVALIDATION     factory.assertMissionClaim(claim)   -- AFTER the read,
//                       BEFORE the data is returned
//   5. RELEASE          data is returned only if 1..4 held
//
// Step 4 is the whole point: a lease released, expired or fenced-out *while the
// read was in flight* must not yield data. Because the read is synchronous and
// the scope is inside withMissionClaimWriteAuthority, step 4 cannot be raced by
// another task on this thread; competing processes are serialised by the
// Factory's own lease, and the revalidation is what catches them.

import { openMissionMemory } from './p1-memory-reader.mjs';
import { P2_CODES, P2Denied, deny, isP2Denied } from './p2-errors.mjs';
import { DEFAULT_POLICY, assertMissionAdmission } from './p2-policy.mjs';

/**
 * Derive the memory scope from the claim. The caller may narrow the namespace,
 * never widen it, and can never choose the mission.
 */
export function deriveScope(claim, requestedNamespace = undefined) {
  if (!claim || typeof claim !== 'object') {
    deny(P2_CODES.LEASE_CLAIM_INVALID, 'claim is required to derive a scope');
  }
  const missionId = claim.missionId ?? claim.mission_id;
  if (typeof missionId !== 'string' || !missionId.trim()) {
    deny(P2_CODES.NAMESPACE_DENIED, 'claim carries no mission identity');
  }
  const claimNamespace = claim.namespace ?? claim.namespaceId ?? null;

  let namespace = requestedNamespace ?? claimNamespace;
  if (typeof namespace !== 'string' || !namespace.trim()) {
    deny(P2_CODES.NAMESPACE_DENIED, 'no namespace available for this claim');
  }
  if (claimNamespace && namespace !== claimNamespace) {
    // The claim is authority for one namespace; asking for another is an
    // isolation violation, not a configuration error.
    deny(P2_CODES.NAMESPACE_MISMATCH, 'requested namespace is not the claimed namespace');
  }
  return Object.freeze({ missionId, namespace });
}

export function createP2Gate({
  adapter,
  memoryPath,
  policy = DEFAULT_POLICY,
  clock = () => Date.now(),
  // Fault-injection seam used by tests only. Called after the read, before
  // revalidation, so "lease released/expired during read" is reproducible.
  afterReadHook = null,
  // Explicit opt-in recorded in the receipt: production must stay false.
  allowUnverifiedLease = false,
  // Reader seam. Defaults to the real SQLite reader; tests substitute a failing
  // reader to prove that a reader exception denies rather than returns empty.
  readerFactory = openMissionMemory,
} = {}) {
  if (!adapter || typeof adapter.assertClaim !== 'function' || typeof adapter.withWriteAuthority !== 'function') {
    deny(P2_CODES.GATE_CONFIGURATION_DENIED, 'a lease adapter with assertClaim + withWriteAuthority is required');
  }
  if (typeof memoryPath !== 'string' || !memoryPath) {
    deny(P2_CODES.GATE_CONFIGURATION_DENIED, 'memoryPath is required');
  }
  const leaseIdentity = adapter.identity ?? { verified: false, state: 'LEASE_SOURCE_UNPINNED' };
  if (leaseIdentity.verified !== true && allowUnverifiedLease !== true) {
    // Refusing here is the difference between an integration and a rehearsal.
    deny(P2_CODES.LEASE_MODULE_UNVERIFIED, 'lease module is not digest-verified; refusing to authorize reads');
  }

  let reader = null;
  const receipts = [];

  function getReader() {
    if (reader) return reader;
    if (typeof readerFactory !== 'function') {
      deny(P2_CODES.GATE_CONFIGURATION_DENIED, 'readerFactory must be callable');
    }
    reader = readerFactory({ path: memoryPath });
    return reader;
  }

  function recordReceipt(receipt) {
    receipts.push(Object.freeze({ ...receipt, at: new Date(clock()).toISOString() }));
    return receipts[receipts.length - 1];
  }

  /**
   * Run `fn` inside one authorized claim scope. `fn` receives the scope and the
   * memory reader; whatever it returns is revalidated against the lease before
   * being released to the caller.
   */
  function authorize(claim, fn, { requestedNamespace, operation = 'memory.read' } = {}) {
    if (typeof fn !== 'function') deny(P2_CODES.GATE_CONFIGURATION_DENIED, 'fn must be callable');

    const scope = deriveScope(claim, requestedNamespace);
    const meta = {
      operation,
      missionId: scope.missionId,
      namespace: scope.namespace,
      fencingToken: Number(claim.fencingToken ?? claim.fence ?? NaN),
      leaseMode: leaseIdentity.mode ?? 'UNKNOWN',
      leaseVerified: leaseIdentity.verified === true,
      leaseSha256: leaseIdentity.sha256 ?? null,
      leaseSourceCommit: leaseIdentity.sourceCommit ?? null,
    };

    // ---- 1. lease check before any IO -------------------------------------
    try {
      adapter.assertClaim(claim);
    } catch (error) {
      if (isP2Denied(error)) {
        recordReceipt({ ...meta, outcome: 'DENIED_PRE_READ', code: error.code, dataReleased: false });
        throw error;
      }
      recordReceipt({ ...meta, outcome: 'DENIED_PRE_READ', code: P2_CODES.LEASE_CLAIM_INVALID, dataReleased: false });
      deny(P2_CODES.LEASE_CLAIM_INVALID, 'lease check failed before read');
    }

    let payload;
    let readCompleted = false;

    // ---- 2/3. synchronous read strictly inside the claim scope ------------
    adapter.withWriteAuthority(claim, () => {
      const mem = getReader();
      payload = fn({ scope, memory: mem, claim });
      readCompleted = true;

      // ---- 4. revalidate AFTER the read, BEFORE returning ---------------
      if (typeof afterReadHook === 'function') {
        afterReadHook({ scope, claim, meta });
      }
      try {
        adapter.assertClaim(claim);
      } catch (error) {
        const code = isP2Denied(error)
          ? // Distinguish "the lease moved under us during the read".
            error.code === P2_CODES.LEASE_RELEASED
            ? P2_CODES.LEASE_RELEASED_DURING_READ
            : error.code === P2_CODES.LEASE_EXPIRED
              ? P2_CODES.LEASE_EXPIRED_DURING_READ
              : error.code === P2_CODES.FENCE_STALE
                ? P2_CODES.FENCE_REGRESSED_DURING_READ
                : error.code
          : P2_CODES.LEASE_CLAIM_INVALID;
        recordReceipt({ ...meta, outcome: 'DENIED_POST_READ', code, dataReleased: false, readCompleted });
        // The payload is deliberately dropped on this path.
        deny(code, 'lease invalidated during read; data not released');
      }
      recordReceipt({ ...meta, outcome: 'AUTHORIZED', code: null, dataReleased: true, readCompleted });
    });

    if (!readCompleted) {
      // The scope never executed: treat as a hard failure, not an empty success.
      deny(P2_CODES.GATE_NOT_IN_CLAIM_SCOPE, 'claim scope did not execute the read');
    }
    return payload;
  }

  return Object.freeze({
    /** Read one key from P1 memory under full P2 authorization. */
    read(claim, key, options = {}) {
      return authorize(
        claim,
        ({ scope, memory }) => memory.get(scope, key),
        { ...options, operation: 'memory.read' },
      );
    },

    /** List one namespace from P1 memory under full P2 authorization. */
    list(claim, options = {}) {
      return authorize(
        claim,
        ({ scope, memory }) => memory.list(scope, { limit: options.limit }),
        { ...options, operation: 'memory.list' },
      );
    },

    /** Run an arbitrary scoped action under full P2 authorization. */
    authorize,

    /** Admission of a worker/provider/cost intent (no IO). */
    admit(intent) {
      return assertMissionAdmission(intent, policy);
    },

    /** Receipts produced so far (append-only, non-sensitive). */
    receipts() {
      return Object.freeze([...receipts]);
    },

    stats() {
      return getReader().stats();
    },

    close() {
      if (reader) {
        reader.close();
        reader = null;
      }
    },

    get identity() {
      return Object.freeze({
        memoryPath,
        lease: leaseIdentity,
        policy: { eurSpendCap: policy.eurSpendCap, costUnknown: policy.costUnknown },
        allowUnverifiedLease: allowUnverifiedLease === true,
      });
    },
  });
}

export { P2_CODES, P2Denied, deny };
