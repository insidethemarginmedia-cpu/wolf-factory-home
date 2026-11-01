// Economic, worker and provider admission policy.
// EUR_SPEND=0, COST_UNKNOWN=DENY, PAID_FALLBACK=DENY, TRIAL_CREDIT=DENY.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertWorkerAdmission,
  assertProviderAdmission,
  assertEconomicAdmission,
  assertMissionAdmission,
  DEFAULT_POLICY,
} from '../infra/autonomy/p2-policy.mjs';

const EUR0 = { amount: 0, currency: 'EUR' };

test('Jules is rejected permanently, in every spelling and shape', () => {
  for (const worker of ['jules', 'JULES', 'Jules', ' jules ', 'JULES\t', { id: 'jules' }, { id: 'JULES' }]) {
    assert.throws(
      () => assertWorkerAdmission(worker),
      (error) => error.code === 'P2_JULES_PROHIBITED',
      `Jules variant was admitted: ${JSON.stringify(worker)}`,
    );
  }
});

test('Jules cannot be admitted by widening the policy list', () => {
  const permissive = {
    ...DEFAULT_POLICY,
    admittedWorkers: [...DEFAULT_POLICY.admittedWorkers, 'jules'],
  };
  // Prohibition is not a policy preference; it survives a permissive list.
  assert.throws(() => assertWorkerAdmission('jules', permissive), (e) => e.code === 'P2_JULES_PROHIBITED');
});

test('admitted workers pass, unknown workers do not', () => {
  for (const w of ['cezar', 'opencode', 'openhands', 'qwen-code', 'QWEN-CODE']) {
    assert.equal(assertWorkerAdmission(w), true);
  }
  for (const w of ['', null, undefined, 'some-other-agent', 'gpt-runner']) {
    assert.throws(() => assertWorkerAdmission(w), (e) => e.code === 'P2_WORKER_NOT_ADMITTED');
  }
});

test('provider admission is limited to groq, flint and ollama', () => {
  for (const p of ['groq', 'flint', 'ollama', 'OLLAMA']) assert.equal(assertProviderAdmission(p), true);
  for (const p of ['openai', 'anthropic', 'gemini', '', null]) {
    assert.throws(() => assertProviderAdmission(p), (e) => e.code === 'P2_PROVIDER_NOT_ADMITTED');
  }
});

test('zero-cost known-EUR work is admitted', () => {
  const result = assertEconomicAdmission({ cost: EUR0 });
  assert.equal(result.admitted, true);
  assert.equal(result.spendCap, 0);
});

test('unknown cost is denied, never assumed free', () => {
  const unknowns = [
    {},
    { cost: undefined },
    { cost: null },
    { cost: '' },
    { cost: 'free' },
    { cost: 0 },
    { cost: { } },
    { cost: { amount: 0 } },
    { cost: { currency: 'EUR' } },
    { cost: { amount: NaN, currency: 'EUR' } },
    { cost: { amount: Infinity, currency: 'EUR' } },
    { cost: { amount: '0', currency: 'EUR' } },
    { cost: { amount: -1, currency: 'EUR' } },
  ];
  for (const request of unknowns) {
    assert.throws(
      () => assertEconomicAdmission(request),
      (e) => e.code === 'P2_COST_UNKNOWN_DENIED',
      `unknown cost admitted: ${JSON.stringify(request)}`,
    );
  }
});

test('any non-zero EUR cost is denied under EUR_SPEND=0', () => {
  for (const amount of [0.0001, 0.01, 1, 1000]) {
    assert.throws(
      () => assertEconomicAdmission({ cost: { amount, currency: 'EUR' } }),
      (e) => e.code === 'P2_COST_DENIED',
    );
  }
});

test('non-EUR cost is denied rather than converted', () => {
  for (const currency of ['USD', 'GBP', 'BRL', '', null]) {
    assert.throws(
      () => assertEconomicAdmission({ cost: { amount: 0, currency } }),
      (e) => e.code === 'P2_COST_UNKNOWN_DENIED',
    );
  }
});

test('paid fallback and trial credit are denied', () => {
  assert.throws(() => assertEconomicAdmission({ cost: EUR0, paidFallback: true }), (e) => e.code === 'P2_PAID_FALLBACK_DENIED');
  assert.throws(() => assertEconomicAdmission({ cost: EUR0, requiresPaidTier: true }), (e) => e.code === 'P2_PAID_FALLBACK_DENIED');
  assert.throws(() => assertEconomicAdmission({ cost: EUR0, usesTrialCredit: true }), (e) => e.code === 'P2_TRIAL_CREDIT_DENIED');
});

test('trial credit is denied even when the cost looks free', () => {
  // A "free" call paid for by trial credit is still not zero-spend authority.
  assert.throws(
    () => assertEconomicAdmission({ cost: { amount: 0, currency: 'EUR' }, usesTrialCredit: true }),
    (e) => e.code === 'P2_TRIAL_CREDIT_DENIED',
  );
});

test('mission admission composes worker, provider and economics', () => {
  const ok = assertMissionAdmission({ worker: 'opencode', provider: 'ollama', cost: EUR0 });
  assert.equal(ok.admitted, true);
  assert.throws(
    () => assertMissionAdmission({ worker: 'jules', provider: 'ollama', cost: EUR0 }),
    (e) => e.code === 'P2_JULES_PROHIBITED',
  );
  assert.throws(
    () => assertMissionAdmission({ worker: 'opencode', provider: 'ollama', cost: { amount: 5, currency: 'EUR' } }),
    (e) => e.code === 'P2_COST_DENIED',
  );
});
