/*
 * Wolf Omega P0 -- no fabricated worker completion, Jules removal in routing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  assertWorkerAllowed, chooseWorker, evaluatePollingOutcome, isForbiddenWorker,
  verifyWorkerCompletion, DEFAULT_ALLOWED_WORKER_TYPES,
} from '../scripts/omega-p0/worker-evidence.mjs';
import {
  createAuthorityFixture, validCompletionClaim, hex, seal,
} from './fixtures/omega-p0-authority.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture(mutate) {
  return createAuthorityFixture({mutate});
}

test('an authenticated, independently verified receipt yields the only COMPLETED state', async () => {
  const f = fixture();
  const result = await verifyWorkerCompletion({claim: validCompletionClaim(f), ports: f.ports});
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.independentlyVerified, true);
  assert.equal(result.jobId, f.ids.jobId);
  assert.equal(result.evidenceDigest, f.state.receipt.evidenceDigest);
});

test('a finished polling loop, mock response, process exit, session id and adapter assumption are NOT completion', async () => {
  const f = fixture();
  const cases = [
    [{pollFinished: true, pollsExhausted: 3}, 'POLL_LOOP_FINISHED_IS_NOT_EXECUTION_EVIDENCE'],
    [{mockResponse: {ok: true}}, 'MOCK_RESPONSE_IS_NOT_EXECUTION_EVIDENCE'],
    [{processExitCode: 0}, 'PROCESS_EXIT_IS_NOT_EXECUTION_EVIDENCE'],
    [{sessionId: 'remote-session-generated'}, 'REMOTE_SESSION_ID_IS_NOT_EXECUTION_EVIDENCE'],
    [{adapterAssumedSuccess: true}, 'ADAPTER_ASSUMPTION_IS_NOT_EXECUTION_EVIDENCE'],
    [{}, 'AUTHENTICATED_RECEIPT_MISSING'],
  ];
  for (const [outcome, reason] of cases) {
    const result = await evaluatePollingOutcome({outcome, ports: f.ports});
    assert.equal(result.state, 'NOT_VERIFIED', reason);
    assert.equal(result.reason, reason);
    assert.equal(result.automaticCompletion, false);
  }
});

test('a job id without a durable authenticated receipt stays NOT_VERIFIED', async () => {
  const f = fixture(state => { state.receipt = null; });
  const claim = {...validCompletionClaim(f), receipt: {state: 'COMPLETED'}};
  const result = await evaluatePollingOutcome({outcome: claim, ports: f.ports});
  assert.equal(result.state, 'NOT_VERIFIED');
  assert.equal(result.reason, 'EXECUTION_RECEIPT_MISSING');
});

test('forged and unauthenticated receipts are rejected', async () => {
  const f = fixture(state => { state.receipt = {...state.receipt, resultDigest: hex('forged')}; });
  const result = await verifyWorkerCompletion({claim: validCompletionClaim(f), ports: f.ports});
  assert.equal(result.state, 'NOT_VERIFIED');
  assert.equal(result.reason, 'EXECUTION_RECEIPT_UNTRUSTED');
});

test('every identity field of the receipt must match the claim', async () => {
  const fields = ['missionId', 'attemptId', 'executionKey', 'idempotencyKey', 'workflowId', 'workerId', 'workerType', 'jobId', 'checkpointId'];
  for (const field of fields) {
    const f = fixture();
    const claim = {...validCompletionClaim(f), [field]: 'mismatched-value'};
    const result = await verifyWorkerCompletion({claim, ports: f.ports});
    assert.equal(result.state, 'NOT_VERIFIED', field);
    assert.ok(['EVIDENCE_IDENTITY_MISMATCH', 'EXECUTION_RECEIPT_MISSING'].includes(result.reason), field + ': ' + result.reason);
  }
});

test('unbounded results, missing digests, stale fences and missing checkpoints deny completion', async () => {
  const cases = [
    [state => { state.receipt = {...state.receipt, resultBytes: 99, _invalid: true}; }, 'EXECUTION_RECEIPT_UNTRUSTED'],
    [state => { state.receipt = {...state.receipt, _mac: 'f'.repeat(64)}; }, 'EXECUTION_RECEIPT_UNTRUSTED'],
    [state => { state.currentFence = 8; }, 'STALE_FENCING_GENERATION'],
    [state => { state.checkpoint = null; }, 'DURABLE_CHECKPOINT_MISSING'],
  ];
  for (const [mutate] of cases) {
    const f = fixture(mutate);
    const result = await verifyWorkerCompletion({claim: validCompletionClaim(f), ports: f.ports});
    assert.equal(result.state, 'NOT_VERIFIED');
  }
  const bounded = fixture(state => { state.receipt = seal({...state.receipt, resultBytes: 2_000_000}); });
  const boundedResult = await verifyWorkerCompletion({
    claim: validCompletionClaim(bounded), ports: bounded.ports,
  });
  assert.equal(boundedResult.state, 'NOT_VERIFIED');
  assert.equal(boundedResult.reason, 'RESULT_NOT_BOUNDED');
});

test('Jules is forbidden under every alias and cannot win fallback selection', () => {
  for (const alias of ['jules', 'Jules', 'google-jules', 'jules_agent', 'jules-worker', 'JulesExecutor', 'jules/agent']) {
    assert.equal(isForbiddenWorker(alias), true, alias);
    assert.throws(
      () => assertWorkerAllowed({workerType: alias, workerId: 'worker-1'}),
      error => error.wolfReason === 'JULES_FORBIDDEN',
      alias,
    );
  }
  assert.equal(isForbiddenWorker('openhands'), false);
  assert.equal(assertWorkerAllowed({workerType: 'openhands', workerId: 'openhands-1'}), true);
  const selected = chooseWorker(['jules', 'openhands'], {authorized: () => true});
  assert.equal(selected.state, 'WORKER_SELECTED');
  assert.equal(selected.workerType, 'openhands');
  const denied = chooseWorker(['jules', 'google-jules'], {authorized: () => true});
  assert.equal(denied.state, 'WORKER_SELECTION_DENIED');
  assert.equal(chooseWorker([], {authorized: () => true}).state, 'WORKER_SELECTION_DENIED');
  assert.ok(DEFAULT_ALLOWED_WORKER_TYPES.has('openhands'));
  assert.equal(DEFAULT_ALLOWED_WORKER_TYPES.has('jules'), false);
});

test('no executable Jules path exists in scripts or workflows (historical docs may remain)', () => {
  const sources = [];
  const walk = dir => {
    if (!fs.existsSync(dir)) return; // a standalone bundle may not vendor the workflows directory
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|js|cjs|yml|yaml|py|sh)$/.test(entry.name)) sources.push(full);
    }
  };
  walk(path.join(root, 'scripts'));
  walk(path.join(root, '.github', 'workflows'));
  const executionPatterns = [
    /\b(?:spawn|spawnSync|exec|execFile|execFileSync|fork)\s*\([^)\n]*jules/i,
    /\bimport\s+[^;\n]*jules/i,
    /\brequire\s*\(\s*['"][^'\n]*jules/i,
    /workerType\s*[:=]\s*['"`]jules/i,
    /createJules|JulesAdapter|julesExecutor|JULES_(?:API_)?KEY|JULES_ENABLED/i,
    /JULES_ISOLATED_TEST/i,
  ];
  const offenders = [];
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of executionPatterns) {
      if (pattern.test(text)) offenders.push(path.relative(root, file) + ' :: ' + pattern);
    }
  }
  assert.deepEqual(offenders, [], 'no executable Jules path may remain');
});
