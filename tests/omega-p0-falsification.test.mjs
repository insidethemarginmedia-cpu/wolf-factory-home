/*
 * Permanent, executable reproduction of the reported failure class.
 *
 * The actual PR #701 source cannot be read from this environment (private Factory
 * access is blocked), so this test uses the explicitly labelled reconstruction in
 * tests/fixtures/omega-p0-legacy-adapter.mjs. It proves the defect is REAL as a
 * class: without a trusted pre-effect boundary, forged caller declarations reach
 * `POST /api/runs` and a polling loop reports COMPLETED. The hardened gate is
 * proved necessary by the FALSIFY switch in
 * tests/omega-p0-pre-effect-admission.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createLegacyDispatchAdapter, legacyTrustGuard, mockFetchFactory} from './fixtures/omega-p0-legacy-adapter.mjs';
import {createAuthorityFixture, validRequest} from './fixtures/omega-p0-authority.mjs';
import {createPreEffectGate} from '../scripts/omega-p0/pre-effect-admission.mjs';
import {chooseWorker} from '../scripts/omega-p0/worker-evidence.mjs';
import {loadSkill} from '../scripts/omega-p0/skill-loader.mjs';

test('REPRODUCED D1: caller-supplied fence and economic declarations reach POST /api/runs', async () => {
  const mock = mockFetchFactory();
  const adapter = createLegacyDispatchAdapter({fetchImpl: mock.fetch});
  const request = {
    ...validRequest(),
    declaredFence: 'false',
    economicAuthorized: 'false',
    economicReceipt: 'forged',
  };
  const result = await adapter.dispatch(request);
  assert.equal(mock.calls, 1, 'the external effect happened');
  assert.equal(mock.callsMade[0].init.method, 'POST');
  assert.match(mock.callsMade[0].url, /\/api\/runs$/);
  const body = JSON.parse(mock.callsMade[0].init.body);
  assert.equal(body.fence, 'false', 'the caller-supplied fence was forwarded as authority');
  assert.equal(body.economicAuthorized, 'false');
  assert.equal(result.state, 'COMPLETED', 'fabricated completion from a mock response');
  assert.match(result.sessionId, /^remote-session-/);
});

test('REPRODUCED D2: a finished local polling loop fabricates COMPLETED', async () => {
  const mock = mockFetchFactory();
  const adapter = createLegacyDispatchAdapter({fetchImpl: mock.fetch});
  const result = await adapter.pollUntilComplete();
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.reason, 'POLL_LOOP_FINISHED');
  assert.equal(mock.calls, 0, 'no authenticated worker result was ever read');
});

test('a trust-everything gate admits forged declarations (the boundary must not be that gate)', async () => {
  const verdict = await legacyTrustGuard(validRequest({declaredFence: 'false'}));
  assert.equal(verdict.state, 'ADMITTED');
  assert.equal(verdict.reason, 'CALLER_DECLARATIONS_TRUSTED');
});

test('the same forged declarations are denied by the trusted boundary before any IO', async () => {
  const fixture = createAuthorityFixture();
  const gate = createPreEffectGate(fixture.ports, fixture.policyConfig);
  const verdict = await gate(validRequest({declaredFence: 'false', economicAuthorized: 'false'}));
  assert.equal(verdict.state, 'DENIED');
  assert.equal(verdict.reason, 'CALLER_SUPPLIED_AUTHORITY_DECLARATION');
});

test('REPRODUCED D3: a naive skill path join reads outside the trusted root', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wolf-skill-falsify-'));
  try {
    const trusted = path.join(base, 'trusted');
    fs.mkdirSync(trusted);
    fs.writeFileSync(path.join(base, 'secret.md'), 'SECRET OUTSIDE TRUSTED ROOT');
    // The pre-fix pattern: resolve a caller path with a bare join and read it.
    const naive = relativePath => fs.readFileSync(path.join(trusted, relativePath), 'utf8');
    assert.match(naive('../secret.md'), /SECRET OUTSIDE TRUSTED ROOT/);
    const hardened = loadSkill({root: trusted, relativePath: '../secret.md', trustedRoots: [trusted]});
    assert.equal(hardened.state, 'DENIED');
    assert.equal(hardened.reason, 'SKILL_PATH_TRAVERSAL_DENIED');
  } finally { fs.rmSync(base, {recursive: true, force: true}); }
});

test('REPRODUCED D4: naive fallback selection picks the Jules worker', () => {
  const naiveFallback = candidates => candidates[0];
  assert.equal(naiveFallback(['jules', 'openhands']), 'jules');
  assert.equal(chooseWorker(['jules', 'openhands'], {authorized: () => true}).workerType, 'openhands');
  assert.equal(chooseWorker(['jules'], {authorized: () => true}).state, 'WORKER_SELECTION_DENIED');
});

test('REPRODUCED D5: a non-atomic recovery claim admits two concurrent workers', () => {
  let holder = null;
  const naiveClaim = workerId => { holder = workerId; return true; }; // no CAS
  assert.equal(naiveClaim('worker-A'), true);
  assert.equal(naiveClaim('worker-B'), true, 'the second worker also "wins"');
  assert.equal(holder, 'worker-B');
  // Hardened counterpart is asserted in tests/omega-p0-recovery.test.mjs:
  // compareAndSwapRecoveryLease admits exactly one worker.
});
