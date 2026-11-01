// External-effect replay safety: lost responses and UNKNOWN effects.
//
// The decision function under test is production code (p2-effect-guard.mjs).
// The ledger and the effect are test harnesses (see test-support/effect-ledger),
// because DBOS remains the durable authority in the real Factory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decideEffectReplay,
  assertEffectReplayAllowed,
  REPLAY_DECISION,
  EFFECT_STATE,
} from '../infra/autonomy/p2-effect-guard.mjs';
import { openEffectLedger, performExternalEffect, countEffects } from '../infra/autonomy/test-support/effect-ledger.mjs';
import { makeWorkspace } from '../infra/autonomy/test-support/fixtures.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REQUEST = { missionId: 'MISSION_A', executionKey: 'ek-0001', effectKind: 'push' };

test('no recorded receipt admits a new effect exactly once', () => {
  const decision = decideEffectReplay({ recorded: null, requested: REQUEST });
  assert.equal(decision.decision, REPLAY_DECISION.ADMIT_NEW);
  assert.equal(decision.execute, true);
  assert.equal(decision.replayed, false);
});

test('lost response after a committed effect does not duplicate the effect', () => {
  const ws = makeWorkspace();
  const effectPath = join(ws.dir, 'effects.log');
  const ledger = openEffectLedger(join(ws.dir, 'ledger.db'));
  try {
    // Attempt 1: admit, perform, commit.
    const first = decideEffectReplay({ recorded: null, requested: REQUEST });
    assert.equal(first.execute, true);
    performExternalEffect(effectPath, { attempt: 1, key: REQUEST.executionKey });
    ledger.write({ ...REQUEST, state: EFFECT_STATE.COMMITTED, commitSha: 'f'.repeat(40) });

    // The acknowledgement is lost: the caller never saw the success and retries
    // with the SAME execution key.
    const recorded = ledger.read(REQUEST.missionId, REQUEST.executionKey);
    const retry = decideEffectReplay({ recorded, requested: REQUEST });

    assert.equal(retry.decision, REPLAY_DECISION.ALREADY_COMMITTED);
    assert.equal(retry.execute, false, 'retry must not execute');
    assert.equal(retry.replayed, true);
    assert.equal(retry.receipt.commitSha, 'f'.repeat(40));

    // Ground truth: exactly one effect happened.
    assert.equal(countEffects(effectPath), 1);
  } finally { ledger.close(); ws.cleanup(); }
});

test('UNKNOWN effect prevents unsafe replay', () => {
  const ws = makeWorkspace();
  const effectPath = join(ws.dir, 'effects.log');
  const ledger = openEffectLedger(join(ws.dir, 'ledger.db'));
  try {
    // The effect may or may not have landed; DBOS records UNKNOWN.
    ledger.write({ ...REQUEST, state: EFFECT_STATE.UNKNOWN });
    const recorded = ledger.read(REQUEST.missionId, REQUEST.executionKey);

    const decision = decideEffectReplay({ recorded, requested: REQUEST });
    assert.equal(decision.decision, REPLAY_DECISION.DENY_UNKNOWN);
    assert.equal(decision.execute, false);
    assert.equal(decision.reason, 'P2_EFFECT_UNKNOWN_REPLAY_DENIED');

    // And the throwing wrapper refuses too.
    assert.throws(
      () => assertEffectReplayAllowed({ recorded, requested: REQUEST }),
      (e) => e.code === 'P2_EFFECT_UNKNOWN_REPLAY_DENIED',
    );
    assert.equal(countEffects(effectPath), 0, 'no effect may be performed while UNKNOWN');
  } finally { ledger.close(); ws.cleanup(); }
});

test('a different execution key for a committed effect is a duplicate, not a retry', () => {
  const recorded = { missionId: 'MISSION_A', executionKey: 'ek-old', state: EFFECT_STATE.COMMITTED, commitSha: 'a'.repeat(40) };
  const decision = decideEffectReplay({
    recorded,
    requested: { missionId: 'MISSION_A', executionKey: 'ek-new' },
  });
  assert.equal(decision.decision, REPLAY_DECISION.DENY_DUPLICATE);
  assert.equal(decision.execute, false);
  assert.equal(decision.reason, 'P2_EFFECT_ALREADY_COMMITTED');
});

test('INTENT replays only under the identical execution key', () => {
  const recorded = { missionId: 'MISSION_A', executionKey: 'ek-1', state: EFFECT_STATE.INTENT };
  const same = decideEffectReplay({ recorded, requested: { missionId: 'MISSION_A', executionKey: 'ek-1' } });
  assert.equal(same.decision, REPLAY_DECISION.ADMIT_NEW);
  assert.equal(same.execute, true);
  assert.equal(same.replayed, true);

  const different = decideEffectReplay({ recorded, requested: { missionId: 'MISSION_A', executionKey: 'ek-2' } });
  assert.equal(different.decision, REPLAY_DECISION.DENY_DUPLICATE);
  assert.equal(different.execute, false);
});

test('a receipt for another mission never authorises this one', () => {
  const recorded = { missionId: 'MISSION_OTHER', executionKey: 'ek-1', state: EFFECT_STATE.COMMITTED };
  const decision = decideEffectReplay({ recorded, requested: { missionId: 'MISSION_A', executionKey: 'ek-1' } });
  assert.equal(decision.decision, REPLAY_DECISION.DENY_CORRUPT);
  assert.equal(decision.execute, false);
  assert.equal(decision.reason, 'P2_NAMESPACE_MISMATCH');
});

test('corrupt or unrecognisable receipt state fails closed', () => {
  for (const recorded of [
    { state: 'MAYBE' },
    { state: '' },
    {},
    'a string',
    42,
  ]) {
    const decision = decideEffectReplay({ recorded, requested: REQUEST });
    assert.equal(decision.execute, false, `corrupt receipt was admitted: ${JSON.stringify(recorded)}`);
    assert.equal(decision.decision, REPLAY_DECISION.DENY_CORRUPT);
    assert.equal(decision.reason, 'P2_EFFECT_LEDGER_CORRUPT');
  }
});

test('FAILED effect admits a fresh attempt only under a new execution key', () => {
  const recorded = { missionId: 'MISSION_A', executionKey: 'ek-1', state: EFFECT_STATE.FAILED };
  assert.equal(
    decideEffectReplay({ recorded, requested: { missionId: 'MISSION_A', executionKey: 'ek-2' } }).execute,
    true,
  );
  assert.equal(
    decideEffectReplay({ recorded, requested: { missionId: 'MISSION_A', executionKey: 'ek-1' } }).execute,
    false,
  );
});

test('committed state survives a process restart and still blocks replay', () => {
  const ws = makeWorkspace();
  const effectPath = join(ws.dir, 'effects.log');
  const ledgerPath = join(ws.dir, 'ledger.db');

  // Process 1 commits the effect and exits.
  const script = `
    import { openEffectLedger, performExternalEffect } from ${JSON.stringify(join(ROOT, 'infra/autonomy/test-support/effect-ledger.mjs'))};
    const ledger = openEffectLedger(${JSON.stringify(ledgerPath)});
    performExternalEffect(${JSON.stringify(effectPath)}, { attempt: 1 });
    ledger.write({ missionId: 'MISSION_A', executionKey: 'ek-0001', state: 'COMMITTED', commitSha: 'd'.repeat(40) });
    ledger.close();
  `;
  const run1 = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(run1.status, 0, run1.stderr);

  // Process 2 (a brand new OS process) reads the durable receipt.
  const ledger = openEffectLedger(ledgerPath);
  try {
    const recorded = ledger.read('MISSION_A', 'ek-0001');
    assert.equal(recorded.state, EFFECT_STATE.COMMITTED);
    const decision = decideEffectReplay({ recorded, requested: REQUEST });
    assert.equal(decision.decision, REPLAY_DECISION.ALREADY_COMMITTED);
    assert.equal(decision.execute, false);
    assert.equal(countEffects(effectPath), 1, 'restart must not duplicate the effect');
  } finally { ledger.close(); ws.cleanup(); }
});
