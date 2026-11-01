// External-effect replay guard.
//
// DBOS remains the durable workflow authority. This module is NOT a second
// store: it is a pure decision function over a receipt that DBOS (or the
// publication ledger) already holds. Nothing here writes.
//
// The two failure modes it exists to close:
//
//   LOST RESPONSE   The effect committed, the acknowledgement was lost, and the
//                   worker retries. A correct system returns the committed
//                   receipt and performs NO second effect.
//
//   UNKNOWN         The effect may or may not have landed. Replay is unsafe
//                   because it could double-execute, so it is denied outright
//                   and left for reconciliation.

import { P2_CODES, deny } from './p2-errors.mjs';

export const EFFECT_STATE = Object.freeze({
  ABSENT: 'ABSENT',
  INTENT: 'INTENT',
  COMMITTED: 'COMMITTED',
  UNKNOWN: 'UNKNOWN',
  FAILED: 'FAILED',
});

export const REPLAY_DECISION = Object.freeze({
  ADMIT_NEW: 'ADMIT_NEW',
  ALREADY_COMMITTED: 'ALREADY_COMMITTED',
  DENY_UNKNOWN: 'DENY_UNKNOWN',
  DENY_DUPLICATE: 'DENY_DUPLICATE',
  DENY_CORRUPT: 'DENY_CORRUPT',
});

const VALID_STATES = new Set(Object.values(EFFECT_STATE));

/**
 * Decide whether a requested external effect may execute.
 *
 * @param {object} args
 * @param {object|null} args.recorded   receipt already held (null = nothing recorded)
 * @param {object} args.requested       { missionId, executionKey, effectKind }
 * @returns {{decision: string, execute: boolean, replayed: boolean, reason: string|null, receipt: object|null}}
 */
export function decideEffectReplay({ recorded = null, requested = {} } = {}) {
  const requestedKey = requested?.executionKey;
  const requestedMission = requested?.missionId;

  if (recorded === null || recorded === undefined) {
    return {
      decision: REPLAY_DECISION.ADMIT_NEW,
      execute: true,
      replayed: false,
      reason: null,
      receipt: null,
    };
  }

  if (typeof recorded !== 'object') {
    return {
      decision: REPLAY_DECISION.DENY_CORRUPT,
      execute: false,
      replayed: false,
      reason: P2_CODES.EFFECT_LEDGER_CORRUPT,
      receipt: null,
    };
  }

  const state = recorded.state;
  if (!VALID_STATES.has(state)) {
    // An unrecognisable state cannot be proven safe.
    return {
      decision: REPLAY_DECISION.DENY_CORRUPT,
      execute: false,
      replayed: false,
      reason: P2_CODES.EFFECT_LEDGER_CORRUPT,
      receipt: null,
    };
  }

  // A receipt for a different mission must never authorise this one.
  if (recorded.missionId && requestedMission && recorded.missionId !== requestedMission) {
    return {
      decision: REPLAY_DECISION.DENY_CORRUPT,
      execute: false,
      replayed: false,
      reason: P2_CODES.NAMESPACE_MISMATCH,
      receipt: null,
    };
  }

  switch (state) {
    case EFFECT_STATE.COMMITTED: {
      const sameKey = !recorded.executionKey || !requestedKey || recorded.executionKey === requestedKey;
      if (sameKey) {
        // THE LOST-RESPONSE CASE: the effect already happened. Report it; do not
        // execute a second time.
        return {
          decision: REPLAY_DECISION.ALREADY_COMMITTED,
          execute: false,
          replayed: true,
          reason: null,
          receipt: freezeReceipt(recorded),
        };
      }
      // A *different* execution key for the same mission is a duplicate effect
      // attempt, not a retry.
      return {
        decision: REPLAY_DECISION.DENY_DUPLICATE,
        execute: false,
        replayed: false,
        reason: P2_CODES.EFFECT_ALREADY_COMMITTED,
        receipt: freezeReceipt(recorded),
      };
    }

    case EFFECT_STATE.UNKNOWN:
      // Never replay what may already have landed.
      return {
        decision: REPLAY_DECISION.DENY_UNKNOWN,
        execute: false,
        replayed: false,
        reason: P2_CODES.EFFECT_UNKNOWN_REPLAY_DENIED,
        receipt: freezeReceipt(recorded),
      };

    case EFFECT_STATE.INTENT: {
      // An intent that was never acknowledged may be re-attempted ONLY with the
      // identical execution key, which is what makes the retry idempotent. If
      // the key differs we cannot prove we are retrying rather than doubling.
      if (requestedKey && recorded.executionKey && requestedKey === recorded.executionKey) {
        return {
          decision: REPLAY_DECISION.ADMIT_NEW,
          execute: true,
          replayed: true,
          reason: null,
          receipt: freezeReceipt(recorded),
        };
      }
      return {
        decision: REPLAY_DECISION.DENY_DUPLICATE,
        execute: false,
        replayed: false,
        reason: P2_CODES.EFFECT_ALREADY_COMMITTED,
        receipt: freezeReceipt(recorded),
      };
    }

    case EFFECT_STATE.FAILED:
      // A provably-failed effect performed nothing; a fresh attempt is safe but
      // must carry a fresh execution key so the two are distinguishable.
      if (recorded.executionKey && requestedKey && recorded.executionKey === requestedKey) {
        return {
          decision: REPLAY_DECISION.DENY_DUPLICATE,
          execute: false,
          replayed: false,
          reason: P2_CODES.EFFECT_ALREADY_COMMITTED,
          receipt: freezeReceipt(recorded),
        };
      }
      return {
        decision: REPLAY_DECISION.ADMIT_NEW,
        execute: true,
        replayed: false,
        reason: null,
        receipt: freezeReceipt(recorded),
      };

    case EFFECT_STATE.ABSENT:
    default:
      return {
        decision: REPLAY_DECISION.ADMIT_NEW,
        execute: true,
        replayed: false,
        reason: null,
        receipt: null,
      };
  }
}

/** Throwing wrapper for call sites that must not continue on denial. */
export function assertEffectReplayAllowed(args) {
  const decision = decideEffectReplay(args);
  if (!decision.execute && decision.decision !== REPLAY_DECISION.ALREADY_COMMITTED) {
    deny(decision.reason ?? P2_CODES.EFFECT_UNKNOWN_REPLAY_DENIED, `effect replay denied: ${decision.decision}`);
  }
  return decision;
}

function freezeReceipt(recorded) {
  return Object.freeze({
    missionId: recorded.missionId ?? null,
    executionKey: recorded.executionKey ?? null,
    state: recorded.state,
    effectKind: recorded.effectKind ?? null,
    commitSha: recorded.commitSha ?? null,
    recordedAt: recorded.recordedAt ?? null,
  });
}
