// Canonical denial/error vocabulary for the P2 authorization gate.
// Every denial carries a stable machine-readable code. Nothing in this file
// performs IO, and nothing here may ever be used to permit an operation.

export const P2_CODES = Object.freeze({
  // Lease / fencing (Factory authority)
  LEASE_MODULE_UNAVAILABLE: 'P2_LEASE_MODULE_UNAVAILABLE',
  LEASE_MODULE_UNVERIFIED: 'P2_LEASE_MODULE_UNVERIFIED',
  LEASE_CLAIM_INVALID: 'P2_LEASE_CLAIM_INVALID',
  LEASE_NOT_HELD: 'P2_LEASE_NOT_HELD',
  LEASE_RELEASED: 'P2_LEASE_RELEASED',
  LEASE_EXPIRED: 'P2_LEASE_EXPIRED',
  LEASE_EXPIRED_DURING_READ: 'P2_LEASE_EXPIRED_DURING_READ',
  LEASE_RELEASED_DURING_READ: 'P2_LEASE_RELEASED_DURING_READ',
  LEASE_MISSION_MISMATCH: 'P2_LEASE_MISSION_MISMATCH',
  FENCE_STALE: 'P2_FENCE_STALE',
  FENCE_REGRESSED_DURING_READ: 'P2_FENCE_REGRESSED_DURING_READ',
  FENCE_MISSING: 'P2_FENCE_MISSING',

  // Namespace isolation
  NAMESPACE_DENIED: 'P2_NAMESPACE_DENIED',
  NAMESPACE_MISMATCH: 'P2_NAMESPACE_MISMATCH',

  // Memory / storage
  MEMORY_UNAVAILABLE: 'P2_MEMORY_UNAVAILABLE',
  MEMORY_CORRUPT: 'P2_MEMORY_CORRUPT',
  MEMORY_READ_FAILED: 'P2_MEMORY_READ_FAILED',
  MEMORY_WRITE_DENIED: 'P2_MEMORY_WRITE_DENIED',
  MEMORY_SCHEMA_DENIED: 'P2_MEMORY_SCHEMA_DENIED',

  // Economic / worker / provider admission
  COST_DENIED: 'P2_COST_DENIED',
  COST_UNKNOWN_DENIED: 'P2_COST_UNKNOWN_DENIED',
  PAID_FALLBACK_DENIED: 'P2_PAID_FALLBACK_DENIED',
  TRIAL_CREDIT_DENIED: 'P2_TRIAL_CREDIT_DENIED',
  JULES_PROHIBITED: 'P2_JULES_PROHIBITED',
  WORKER_NOT_ADMITTED: 'P2_WORKER_NOT_ADMITTED',
  PROVIDER_NOT_ADMITTED: 'P2_PROVIDER_NOT_ADMITTED',

  // Effects
  EFFECT_UNKNOWN_REPLAY_DENIED: 'P2_EFFECT_UNKNOWN_REPLAY_DENIED',
  EFFECT_ALREADY_COMMITTED: 'P2_EFFECT_ALREADY_COMMITTED',
  EFFECT_LEDGER_CORRUPT: 'P2_EFFECT_LEDGER_CORRUPT',

  // Gate misuse
  GATE_NOT_IN_CLAIM_SCOPE: 'P2_GATE_NOT_IN_CLAIM_SCOPE',
  GATE_REENTRANT_DENIED: 'P2_GATE_REENTRANT_DENIED',
  GATE_CONFIGURATION_DENIED: 'P2_GATE_CONFIGURATION_DENIED',
});

/**
 * A denial is a *classification*, not an exception of convenience: callers must
 * never be able to catch one and proceed with stale data.
 */
export class P2Denied extends Error {
  constructor(code, detail = undefined) {
    if (!Object.values(P2_CODES).includes(code)) {
      throw new Error(`P2Denied requires a known code, received: ${String(code)}`);
    }
    super(code);
    this.name = 'P2Denied';
    this.code = code;
    // Detail is diagnostic only; it must never carry secret material.
    this.detail = detail;
    // Explicit: a denial always means "no data was released".
    this.dataReleased = false;
  }

  toJSON() {
    return { name: this.name, code: this.code, detail: this.detail ?? null, dataReleased: false };
  }
}

export function deny(code, detail) {
  throw new P2Denied(code, detail);
}

export function isP2Denied(error) {
  return error instanceof P2Denied;
}
