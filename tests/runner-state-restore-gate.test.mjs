// Deterministic restore-gate fault injection for the runner-loss two-job recovery.
// Synthetic fetch and write recorders only: no network, no credentials, no Git, no external effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const raw = fs.readFileSync(new URL('../.github/workflows/private-controller-preflight.yml', import.meta.url), 'utf8');
const match = raw.match(/\/\/ RUNNER_STATE_RESTORE_GATE_BEGIN\n([\s\S]*?)\n\s*\/\/ RUNNER_STATE_RESTORE_GATE_END/);
assert.ok(match, 'runner-loss-recover must gate its sealed checkpoint read behind the tested restore function');
const restoreSealedRunnerState = new Function(match[1] + '\nreturn restoreSealedRunnerState;')();

// Real published envelope: docs/checkpoints/runner-loss/40941257246.json sealed at commit 0e470ba8…
const snapshot = '0e470ba861154ca3b438e84885fc1921a8da690b';
const source = '0cc54c0a2e16513c9abe764977bbdf24b9124394';
const realContent = fs.readFileSync(new URL('../docs/checkpoints/runner-loss/40941257246.json', import.meta.url), 'utf8');
const realPayloadDigest = JSON.parse(realContent).payloadSha256; // expected value read from the pinned artifact, never hardcoded

const env = {
  GITHUB_REPOSITORY: 'insidethemarginmedia-cpu/wolf-factory-home', GITHUB_ACTOR: 'insidethemarginmedia-cpu',
  GITHUB_EVENT_NAME: 'workflow_dispatch', WOLF_RUNNER_LOSS_TEST: '1',
  SNAPSHOT_SHA: snapshot, GITHUB_RUN_ID: '40941257246', WOLF_FACTORY_EXPECTED_SHA: source,
  RUNNER_TEMP: '/tmp/wolf-restore-gate',
  EUR_SPEND: '0', COST_UNKNOWN: 'DENY', PAID_FALLBACK: 'DENY', TRIAL_CREDIT: 'DENY',
};

function sealed(context, overrides = {}) {
  const envelope = {
    version: 1, algorithm: 'aes-256-gcm+scrypt+gzip', context,
    salt: Buffer.alloc(32, 1).toString('base64'), iv: Buffer.alloc(12, 2).toString('base64'),
    tag: Buffer.alloc(16, 3).toString('base64'), ciphertext: Buffer.alloc(64, 4).toString('base64'),
    payloadSha256: 'a'.repeat(64), ...overrides,
  };
  return JSON.stringify(envelope) + '\n';
}
const identity = {workflowID: 'wolf-runner-loss-40941257246', runID: '40941257246', sourceSha: source};

function net({status = 200, body = realContent, throws = false} = {}) {
  const calls = [];
  return {calls, fetchImpl: async (url, options) => {
    calls.push({url, options});
    if (throws) throw Error('synthetic network failure');
    return new Response(status === 200 ? body : (status === 404 ? '404: Not Found' : 'transient'), {status});
  }};
}
function recorder() {
  const writes = [];
  return {writes, writeImpl: (file, content) => { writes.push({file, content}); }};
}
const eexistWriter = () => { const error = new Error('file already exists'); error.code = 'EEXIST'; throw error; };
const target = '/tmp/wolf-restore-gate/wolf-runner-state.envelope.json';

test('restores the real published envelope with one bounded pinned fetch and one exclusive byte-exact write', async () => {
  const n = net(), rec = recorder();
  const receipt = await restoreSealedRunnerState(env, n.fetchImpl, rec.writeImpl);
  assert.equal(receipt.state, 'RESTORED');
  assert.match(realPayloadDigest, /^[a-f0-9]{64}$/);
  assert.equal(receipt.payloadSha256, realPayloadDigest);
  assert.deepEqual(receipt.context, identity);
  assert.equal(receipt.snapshotSha, snapshot);
  assert.equal(receipt.fetchCount, 1);
  assert.equal(receipt.retryCount, 0);
  assert.equal(n.calls.length, 1, 'exactly one fetch: no polling loop and no retry');
  assert.equal(n.calls[0].url, 'https://raw.githubusercontent.com/insidethemarginmedia-cpu/wolf-factory-home/' + snapshot + '/docs/checkpoints/runner-loss/40941257246.json');
  assert.equal(n.calls[0].options.redirect, 'error');
  assert.ok(n.calls[0].options.signal instanceof AbortSignal, 'fetch must be time-bounded');
  assert.deepEqual(rec.writes, [{file: target, content: realContent}], 'byte-exact exclusive write of the sealed envelope');
});

test('accepts a fresh synthetic sealed envelope without depending on the historical artifact', async () => {
  const body = sealed(identity);
  const n = net({body}), rec = recorder();
  const receipt = await restoreSealedRunnerState(env, n.fetchImpl, rec.writeImpl);
  assert.equal(receipt.state, 'RESTORED');
  assert.equal(rec.writes.length, 1);
  assert.equal(rec.writes[0].content, body);
});

test('missing checkpoint (404) is RESTORE_CHECKPOINT_MISSING with no write and no retry', async () => {
  const n = net({status: 404}), rec = recorder();
  await assert.rejects(restoreSealedRunnerState(env, n.fetchImpl, rec.writeImpl), /RESTORE_CHECKPOINT_MISSING/);
  assert.equal(n.calls.length, 1);
  assert.equal(rec.writes.length, 0);
});

test('server errors and network failures stay fail-closed with distinct reasons and a single attempt', async () => {
  for (const [scenario, reason] of [[{status: 500}, /DURABLE_CHECKPOINT_UNAVAILABLE/], [{throws: true}, /DURABLE_CHECKPOINT_READ_FAILED/]]) {
    const n = net(scenario), rec = recorder();
    await assert.rejects(restoreSealedRunnerState(env, n.fetchImpl, rec.writeImpl), reason);
    assert.equal(n.calls.length, 1, 'a failed read is never re-attempted inside the gate');
    assert.equal(rec.writes.length, 0);
  }
});

test('oversized payloads are refused with CHECKPOINT_LIMIT before parsing', async () => {
  const n = net({body: 'x'.repeat(1048577)}), rec = recorder();
  await assert.rejects(restoreSealedRunnerState(env, n.fetchImpl, rec.writeImpl), /CHECKPOINT_LIMIT/);
  assert.equal(rec.writes.length, 0);
});

test('corrupt envelopes are refused with RESTORE_CHECKPOINT_CORRUPT and never written', async () => {
  const corrupt = {
    truncated: realContent.slice(0, realContent.length - 40),
    prettyPrinted: JSON.stringify(JSON.parse(realContent), null, 2) + '\n',
    missingNewline: realContent.trimEnd(),
    extraKey: sealed(identity, {plaintext: 'must-not-ride-along'}),
    droppedKey: (() => { const e = JSON.parse(realContent); delete e.payloadSha256; return JSON.stringify(e) + '\n'; })(),
    wrongVersion: sealed(identity, {version: 2}),
    wrongAlgorithm: sealed(identity, {algorithm: 'plaintext'}),
    badBase64Salt: sealed(identity, {salt: 'not base64!!'}),
    shortIv: sealed(identity, {iv: Buffer.alloc(11, 2).toString('base64')}),
    longTag: sealed(identity, {tag: Buffer.alloc(17, 3).toString('base64')}),
    emptyCiphertext: sealed(identity, {ciphertext: ''}),
    shortPayloadHash: sealed(identity, {payloadSha256: 'a'.repeat(63)}),
    duplicateKeySmuggle: '{"ciphertext":"U1lOVEhFVElDX1BMQUlOVEVYVA==",' + sealed(identity).slice(1),
  };
  for (const [name, body] of Object.entries(corrupt)) {
    const n = net({body}), rec = recorder();
    await assert.rejects(restoreSealedRunnerState(env, n.fetchImpl, rec.writeImpl), /RESTORE_CHECKPOINT_CORRUPT/, name);
    assert.equal(rec.writes.length, 0, name);
  }
});

test('wrong source SHA, wrong run and wrong workflow identity are RESTORE_CHECKPOINT_IDENTITY_MISMATCH', async () => {
  const cases = [
    ['stale private source SHA', {...env, WOLF_FACTORY_EXPECTED_SHA: 'b'.repeat(40)}, realContent],
    ['foreign run envelope', {...env, GITHUB_RUN_ID: '999'}, sealed({workflowID: 'wolf-runner-loss-40941257246', runID: '40941257246', sourceSha: source})],
    ['foreign workflow identity', env, sealed({workflowID: 'wolf-cross-job-40941257246', runID: '40941257246', sourceSha: source})],
    ['cross-job envelope on the runner-loss path', env, sealed({workflowID: 'wolf-runner-loss-40941257246', runID: '40941257246', sourceSha: source}, {context: {workflowID: 'wolf-cross-job-40941257246', runID: '40941257246', sourceSha: source}})],
  ];
  for (const [name, caseEnv, body] of cases) {
    const n = net({body}), rec = recorder();
    await assert.rejects(restoreSealedRunnerState(caseEnv, n.fetchImpl, rec.writeImpl), /RESTORE_CHECKPOINT_IDENTITY_MISMATCH/, name);
    assert.equal(rec.writes.length, 0, name);
  }
  const n = net({body: sealed(identity)});
  await assert.rejects(restoreSealedRunnerState({...env, GITHUB_RUN_ID: '999'}, n.fetchImpl, recorder().writeImpl), /RESTORE_CHECKPOINT_IDENTITY_MISMATCH/);
  assert.match(n.calls[0].url, /\/docs\/checkpoints\/runner-loss\/999\.json$/, 'the fetch path itself is pinned to the recovering run');
});

test('scope, actor, event and economic gates deny before any fetch happens', async () => {
  const denials = [
    [{GITHUB_REPOSITORY: 'other/repo'}, /RESTORE_SCOPE_DENIED/],
    [{GITHUB_ACTOR: 'outsider'}, /RESTORE_SCOPE_DENIED/],
    [{GITHUB_EVENT_NAME: 'schedule'}, /RESTORE_SCOPE_DENIED/],
    [{WOLF_RUNNER_LOSS_TEST: '0'}, /RESTORE_SCOPE_DENIED/],
    [{EUR_SPEND: '1'}, /RESTORE_COST_DENIED/],
    [{COST_UNKNOWN: 'ALLOW'}, /RESTORE_COST_DENIED/],
    [{PAID_FALLBACK: 'ALLOW'}, /RESTORE_COST_DENIED/],
    [{TRIAL_CREDIT: 'ALLOW'}, /RESTORE_COST_DENIED/],
    [{SNAPSHOT_SHA: ''}, /SNAPSHOT_SHA_REQUIRED/],
    [{SNAPSHOT_SHA: 'xyz'}, /SNAPSHOT_SHA_REQUIRED/],
    [{GITHUB_RUN_ID: '12a'}, /RESTORE_CONTEXT_REQUIRED/],
    [{GITHUB_RUN_ID: '0'}, /RESTORE_CONTEXT_REQUIRED/],
    [{WOLF_FACTORY_EXPECTED_SHA: ''}, /RESTORE_CONTEXT_REQUIRED/],
    [{RUNNER_TEMP: ''}, /RESTORE_CONTEXT_REQUIRED/],
  ];
  for (const [delta, reason] of denials) {
    const n = net(), rec = recorder();
    await assert.rejects(restoreSealedRunnerState({...env, ...delta}, n.fetchImpl, rec.writeImpl), reason, JSON.stringify(delta));
    assert.equal(n.calls.length, 0, 'denied scopes perform zero IO: ' + JSON.stringify(delta));
    assert.equal(rec.writes.length, 0);
  }
  await assert.rejects(restoreSealedRunnerState(env, net().fetchImpl, null), /RESTORE_CONTEXT_REQUIRED/);
});

test('a duplicate restore into an existing target is RESTORE_TARGET_EXISTS and cannot double-write', async () => {
  const n = net();
  await assert.rejects(restoreSealedRunnerState(env, n.fetchImpl, eexistWriter), /RESTORE_TARGET_EXISTS/);
  assert.equal(n.calls.length, 1);
});
