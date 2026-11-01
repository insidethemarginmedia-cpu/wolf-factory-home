// Economic, worker and provider admission policy.
//
// Founder policy (verbatim, non-negotiable):
//   EUR_SPEND=0        COST_UNKNOWN=DENY
//   PAID_FALLBACK=DENY TRIAL_CREDIT=DENY
//
// Everything here is a pure function over supplied facts. No IO, no clock,
// no environment reads: the caller must present the facts and the policy
// decides. Uncertainty always resolves to DENY.

import { P2_CODES, deny } from './p2-errors.mjs';

export const PROHIBITED_WORKERS = Object.freeze(['jules']);

export const ADMITTED_WORKERS = Object.freeze([
  'cezar',
  'opencode',
  'openhands',
  'qwen-code',
]);

export const ADMITTED_PROVIDERS = Object.freeze(['groq', 'flint', 'ollama']);

export const DEFAULT_POLICY = Object.freeze({
  currency: 'EUR',
  eurSpendCap: 0,
  costUnknown: 'DENY',
  paidFallback: 'DENY',
  trialCredit: 'DENY',
  admittedWorkers: ADMITTED_WORKERS,
  prohibitedWorkers: PROHIBITED_WORKERS,
  admittedProviders: ADMITTED_PROVIDERS,
});

function normalize(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Permanently rejects prohibited workers. There is no override, no flag and no
 * "temporarily admitted" path: if the worker is Jules, this throws.
 */
export function assertWorkerAdmission(worker, policy = DEFAULT_POLICY) {
  const id = normalize(worker?.id ?? worker);
  if (!id) deny(P2_CODES.WORKER_NOT_ADMITTED, 'worker id missing');

  if (policy.prohibitedWorkers.map(normalize).includes(id) || PROHIBITED_WORKERS.includes(id)) {
    // Named separately so logs can never be mistaken for a generic rejection.
    deny(P2_CODES.JULES_PROHIBITED, 'prohibited worker is permanently denied');
  }

  const admitted = (policy.admittedWorkers ?? ADMITTED_WORKERS).map(normalize);
  if (!admitted.includes(id)) deny(P2_CODES.WORKER_NOT_ADMITTED, `worker not in admission list`);
  return true;
}

export function assertProviderAdmission(provider, policy = DEFAULT_POLICY) {
  const id = normalize(provider?.id ?? provider);
  if (!id) deny(P2_CODES.PROVIDER_NOT_ADMITTED, 'provider id missing');
  const admitted = (policy.admittedProviders ?? ADMITTED_PROVIDERS).map(normalize);
  if (!admitted.includes(id)) deny(P2_CODES.PROVIDER_NOT_ADMITTED, 'provider not in admission list');
  return true;
}

/**
 * Admit an inference request under zero-spend policy.
 *
 * `cost` is the *known* cost as { amount, currency } or null/undefined when the
 * provider could not state one. Unknown cost is a denial, never "assume free".
 *
 * Recognised denial reasons:
 *   - cost unknown / non-numeric / negative      -> COST_UNKNOWN_DENIED
 *   - currency is not EUR and no conversion       -> COST_UNKNOWN_DENIED
 *   - any amount above the cap (default 0)        -> COST_DENIED
 *   - trial credit would be consumed              -> TRIAL_CREDIT_DENIED
 *   - the call would fall back to a paid tier     -> PAID_FALLBACK_DENIED
 */
export function assertEconomicAdmission(request = {}, policy = DEFAULT_POLICY) {
  const {
    cost,
    usesTrialCredit = false,
    paidFallback = false,
    requiresPaidTier = false,
  } = request;

  if (usesTrialCredit) deny(P2_CODES.TRIAL_CREDIT_DENIED, 'trial credit is not spend authority');
  if (paidFallback) deny(P2_CODES.PAID_FALLBACK_DENIED, 'paid fallback is not permitted');
  if (requiresPaidTier) deny(P2_CODES.PAID_FALLBACK_DENIED, 'paid tier requested');

  if (cost === null || cost === undefined || cost === '') {
    deny(P2_CODES.COST_UNKNOWN_DENIED, 'cost is unknown');
  }

  if (typeof cost !== 'object') deny(P2_CODES.COST_UNKNOWN_DENIED, 'cost is not a cost record');

  const { amount, currency } = cost;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || Number.isNaN(amount)) {
    deny(P2_CODES.COST_UNKNOWN_DENIED, 'cost amount is not a finite number');
  }
  if (amount < 0) deny(P2_CODES.COST_UNKNOWN_DENIED, 'negative cost is not a valid cost');
  if (normalize(currency) !== normalize(policy.currency)) {
    deny(P2_CODES.COST_UNKNOWN_DENIED, 'cost currency is not the policy currency');
  }
  if (amount > policy.eurSpendCap) {
    deny(P2_CODES.COST_DENIED, 'cost exceeds the zero-spend cap');
  }

  return { admitted: true, amount, currency: policy.currency, spendCap: policy.eurSpendCap };
}

/**
 * Single entry point used by the gate: admission of a full execution intent.
 */
export function assertMissionAdmission(intent = {}, policy = DEFAULT_POLICY) {
  if (intent.worker !== undefined) assertWorkerAdmission(intent.worker, policy);
  if (intent.provider !== undefined) assertProviderAdmission(intent.provider, policy);
  const economic = assertEconomicAdmission(intent, policy);
  return { admitted: true, economic };
}
