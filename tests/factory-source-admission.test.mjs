import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/private-controller-preflight.yml', import.meta.url), 'utf8');
const shaA = '58127da11aa1628a5f6e53376449574b7e2cc20e';
const shaB = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const env = {
  GITHUB_REPOSITORY: 'insidethemarginmedia-cpu/wolf-factory-home',
  GITHUB_ACTOR: 'insidethemarginmedia-cpu',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/fix/omega-acceptance-ready-20261028',
  WOLF_FACTORY_REPO_TOKEN: 'synthetic-read-only-token',
  EUR_SPEND: '0', COST_UNKNOWN: 'DENY', PAID_FALLBACK: 'DENY', TRIAL_CREDIT: 'DENY',
};
function resolver() {
  const source = workflow.match(/\/\/ FACTORY_SOURCE_ADMISSION_BEGIN\n([\s\S]*?)\n\s*\/\/ FACTORY_SOURCE_ADMISSION_END/);
  assert.ok(source, 'workflow must resolve one immutable Factory SHA at admission');
  return new Function(source[1] + '\nreturn resolveFactorySource;')();
}
const response = (sha, extra = {}) => new Response(JSON.stringify({
  ref: 'refs/heads/feat/factory-real-worker-m1-20261006', object: {type: 'commit', sha}, ...extra,
}));

test('next admission accepts a legitimate advanced HEAD while the first admission remains immutable', async () => {
  const resolve = resolver();
  let next = shaA;
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/donraposo1-source/project-wolf/git/ref/heads/feat/factory-real-worker-m1-20261006');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer synthetic-read-only-token');
    return response(next);
  };
  const first = await resolve(env, fetchImpl);
  next = shaB;
  const second = await resolve(env, fetchImpl);
  assert.equal(first.sha, shaA);
  assert.equal(second.sha, shaB);
  assert.ok(Object.isFrozen(first));
  assert.throws(() => { first.sha = shaB; }, TypeError);
});

test('admission rejects foreign actors, refs, missing credentials and unknown costs before network access', async () => {
  const resolve = resolver();
  for (const delta of [
    {GITHUB_ACTOR: 'outsider'}, {GITHUB_REPOSITORY: 'outsider/fork'},
    {GITHUB_REF: 'refs/heads/main'}, {GITHUB_REF: 'refs/heads/unapproved'},
    {GITHUB_EVENT_NAME: 'pull_request_target'}, {WOLF_FACTORY_REPO_TOKEN: ''},
    {EUR_SPEND: '1'}, {COST_UNKNOWN: 'ALLOW'}, {PAID_FALLBACK: 'ALLOW'}, {TRIAL_CREDIT: 'ALLOW'},
  ]) {
    await assert.rejects(resolve({...env, ...delta}, () => assert.fail('denied admission must not access the network')), /FACTORY_SOURCE_/);
  }
});

test('admission rejects mismatched refs, tags, invalid SHAs, denied HTTP and malformed responses', async () => {
  const resolve = resolver();
  for (const fetchImpl of [
    async () => response(shaA, {ref: 'refs/heads/main'}),
    async () => response(shaA, {object: {type: 'tag', sha: shaA}}),
    async () => response('HEAD'),
    async () => new Response('{}', {status: 403}),
    async () => new Response('not JSON'),
    async () => new Response('x'.repeat(8193)),
  ]) await assert.rejects(resolve(env, fetchImpl), /FACTORY_SOURCE_/);
});

test('network failure is sanitized and scheduled admission stays restricted to the existing main wakeup', async () => {
  const resolve = resolver();
  await assert.rejects(resolve(env, async () => { throw Error('synthetic-read-only-token'); }), /^Error: FACTORY_SOURCE_NETWORK_FAILED$/);
  const scheduled = {...env, GITHUB_EVENT_NAME: 'schedule', GITHUB_REF: 'refs/heads/main'};
  assert.equal((await resolve(scheduled, async () => response(shaA))).sha, shaA);
  await assert.rejects(resolve({...scheduled, GITHUB_REF: env.GITHUB_REF}, () => assert.fail('no IO')), /FACTORY_SOURCE_SCOPE_DENIED/);
});
