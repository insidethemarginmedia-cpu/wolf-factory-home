// Synthetic encrypted-envelope fixtures; no inference or external publication.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const raw = fs.readFileSync(new URL('../.github/workflows/private-controller-preflight.yml', import.meta.url), 'utf8');
const base = '1111111111111111111111111111111111111111';
const source = '58127da11aa1628a5f6e53376449574b7e2cc20e';
const tree = '2222222222222222222222222222222222222222';
const commit = '3333333333333333333333333333333333333333';
const branch = 'fix/omega-acceptance-ready-20261028';
const env = {
  GITHUB_REPOSITORY: 'insidethemarginmedia-cpu/wolf-factory-home', GITHUB_ACTOR: 'insidethemarginmedia-cpu',
  GITHUB_REF: 'refs/heads/' + branch, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: '123', GITHUB_SHA: base,
  WOLF_RUNNER_LOSS_TEST: '1', WOLF_FACTORY_EXPECTED_SHA: source, WOLF_RUNTIME_CHECKPOINT_TOKEN: 'synthetic-token',
  EUR_SPEND: '0', COST_UNKNOWN: 'DENY', PAID_FALLBACK: 'DENY', TRIAL_CREDIT: 'DENY',
};
const envelope = {
  version: 1, algorithm: 'aes-256-gcm+scrypt+gzip',
  context: {workflowID: 'wolf-runner-loss-123', runID: '123', sourceSha: source},
  salt: Buffer.alloc(32, 1).toString('base64'), iv: Buffer.alloc(12, 2).toString('base64'),
  tag: Buffer.alloc(16, 3).toString('base64'), ciphertext: Buffer.alloc(64, 4).toString('base64'), payloadSha256: 'a'.repeat(64),
};
const content = JSON.stringify(envelope) + '\n';
function publisher() {
  const match = raw.match(/\/\/ FEATURE_CHECKPOINT_PUBLICATION_BEGIN\n([\s\S]*?)\n\s*\/\/ FEATURE_CHECKPOINT_PUBLICATION_END/);
  assert.ok(match, 'runner-loss must publish its encrypted snapshot to the authorized feature branch');
  return new Function(match[1] + '\nreturn publishFeatureCheckpoint;')();
}
function network({race = false, duplicate = false, wrongReadback = false, unknown = false, returnedContent = content} = {}) {
  const calls = [];
  let tip = base;
  return {calls, tip: () => tip, fetchImpl: async (url, options) => {
    const route = url.replace('https://api.github.com/repos/insidethemarginmedia-cpu/wolf-factory-home', '');
    const method = options.method;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({method, route, body});
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer synthetic-token');
    const res = (value, status = 200) => new Response(JSON.stringify(value), {status});
    if (method === 'GET' && route === '/git/ref/heads/' + branch) return res({ref: 'refs/heads/' + branch, object: {sha: tip, type: 'commit'}});
    if (method === 'GET' && route === '/git/commits/' + base) return res({sha: base, tree: {sha: tree}});
    if (method === 'GET' && route.endsWith('?ref=' + base)) return res({}, duplicate ? 200 : 404);
    if (method === 'POST' && route === '/git/trees') return res({sha: tree});
    if (method === 'POST' && route === '/git/commits') {
      assert.deepEqual(body.parents, [base]);
      return res({sha: commit, tree: {sha: tree}, parents: [{sha: base}]});
    }
    if (method === 'PATCH' && route === '/git/refs/heads/' + branch) {
      assert.deepEqual(body, {sha: commit, force: false});
      if (unknown) throw Error('synthetic-token');
      if (race) { tip = '4'.repeat(40); return res({}, 422); }
      tip = commit; return res({object: {sha: commit}});
    }
    if (method === 'GET' && route.endsWith('?ref=' + commit)) return res({content: Buffer.from(wrongReadback ? '{}' : returnedContent).toString('base64')});
    assert.fail('unexpected API operation: ' + method + ' ' + route);
  }};
}

test('publishes only the sealed envelope with an immutable parent, non-forced ref update and exact SHA/content readback', async () => {
  const net = network();
  const receipt = await publisher()(env, content, net.fetchImpl);
  assert.equal(receipt.commitSha, commit);
  assert.equal(receipt.path, 'docs/checkpoints/runner-loss/123.json');
  assert.equal(net.tip(), commit);
  const entry = net.calls.find(c => c.route === '/git/trees').body.tree;
  assert.deepEqual(entry, [{path: receipt.path, mode: '100644', type: 'blob', content}]);
});

test('denies main, base branch, foreign actor, unknown costs, plaintext, extra fields and wrong context before IO', async () => {
  const publish = publisher();
  for (const delta of [{GITHUB_REF: 'refs/heads/main'}, {GITHUB_REF: 'refs/heads/feat/public-runtime-probe-20261022'}, {GITHUB_ACTOR: 'outsider'}, {COST_UNKNOWN: 'ALLOW'}, {WOLF_RUNTIME_CHECKPOINT_TOKEN: ''}]) {
    let calls = 0;
    await assert.rejects(publish({...env, ...delta}, content, () => { calls++; throw Error('unexpected IO'); }), /CHECKPOINT_/);
    assert.equal(calls, 0);
  }
  for (const value of [null, {databaseDump: 'private'}, {...envelope, plaintext: 'private'}, {...envelope, algorithm: 'plaintext'}, {...envelope, context: {...envelope.context, runID: '999'}}, {...envelope, salt: 'bad'}]) {
    let calls = 0;
    await assert.rejects(publish(env, JSON.stringify(value), () => { calls++; throw Error('unexpected IO'); }), /CHECKPOINT_/);
    assert.equal(calls, 0);
  }
});

test('concurrent advancement, duplicate snapshots, uncertain writes and readback mismatches never trigger retry', async () => {
  const publish = publisher();
  for (const scenario of [{race: true}, {duplicate: true}, {wrongReadback: true}, {unknown: true}]) {
    const net = network(scenario);
    await assert.rejects(publish(env, content, net.fetchImpl), /CHECKPOINT_/);
    assert.ok(net.calls.filter(c => c.method === 'PATCH').length <= 1);
    if (scenario.race) assert.equal(net.tip(), '4'.repeat(40));
    if (scenario.duplicate) assert.equal(net.calls.some(c => c.method === 'POST'), false);
  }
});

test('duplicate JSON keys cannot hide plaintext in bytes submitted as an encrypted envelope', async () => {
  const malicious = '{"ciphertext":"SYNTHETIC_PLAINTEXT_MARKER",' + content.slice(1);
  const net = network({returnedContent: malicious});
  await assert.rejects(publisher()(env, malicious, net.fetchImpl), /CHECKPOINT_CANONICAL_ENVELOPE_REQUIRED/);
  assert.equal(net.calls.length, 0);
});
