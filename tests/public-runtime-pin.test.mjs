import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/private-controller-preflight.yml', import.meta.url), 'utf8');
const repository = 'insidethemarginmedia-cpu/wolf-factory-home';
const pin = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const baseEnv = {GITHUB_REPOSITORY: repository, GITHUB_ACTOR: 'insidethemarginmedia-cpu', GITHUB_EVENT_NAME: 'schedule', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_TOKEN: 'fixture-token', WOLF_PUBLIC_RUNTIME_SHA: pin, EUR_SPEND: '0', COST_UNKNOWN: 'DENY', PAID_FALLBACK: 'DENY', TRIAL_CREDIT: 'DENY'};
const referenced = {id: 123, event: 'schedule', head_sha: baseEnv.GITHUB_SHA, run_attempt: 1, path: '.github/workflows/night-shift-wakeup.yml', referenced_workflows: [{path: repository + '/.github/workflows/private-controller-preflight.yml@' + pin, sha: pin}]};
function resolver() {
  const block = workflow.match(/\/\/ PUBLIC_RUNTIME_PIN_BEGIN\n([\s\S]*?)\n\s*\/\/ PUBLIC_RUNTIME_PIN_END/);
  assert.ok(block, 'runtime pin must be admitted before the private branch or wakeup journal is accessed');
  return new Function(block[1] + '\nreturn resolvePublicRuntimePin;')();
}
const response = value => new Response(JSON.stringify(value));

test('scheduled runtime pin equals GitHub authoritative called-workflow SHA and direct dispatch remains bound to its own HEAD', async () => {
  const resolve = resolver();
  const admitted = await resolve(baseEnv, async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/' + repository + '/actions/runs/123/attempts/1');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer fixture-token');
    return response(referenced);
  });
  assert.equal(admitted, pin);
  const manual = {...baseEnv, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/feat/public-runtime-probe-20261022', WOLF_PUBLIC_RUNTIME_SHA: ''};
  assert.equal(await resolve(manual, async () => response({...referenced, event: 'workflow_dispatch', path: '.github/workflows/private-controller-preflight.yml', referenced_workflows: []})), manual.GITHUB_SHA);
});

test('runtime admission rejects source mismatch, mutable refs, foreign actors and unknown cost before effects', async () => {
  const resolve = resolver();
  for (const delta of [{GITHUB_ACTOR: 'other'}, {GITHUB_REPOSITORY: 'other/repo'}, {GITHUB_REF: 'refs/heads/fix/omega-acceptance-ready-20261028'}, {WOLF_PUBLIC_RUNTIME_SHA: 'main'}, {WOLF_PUBLIC_RUNTIME_SHA: ''}, {GITHUB_RUN_ID: '../secrets'}, {EUR_SPEND: '1'}, {COST_UNKNOWN: 'ALLOW'}, {PAID_FALLBACK: 'ALLOW'}, {TRIAL_CREDIT: 'ALLOW'}]) {
    await assert.rejects(resolve({...baseEnv, ...delta}, () => assert.fail('no IO allowed')), /PUBLIC_RUNTIME_/);
  }
  for (const value of [{...referenced, id: 124}, {...referenced, run_attempt: 2}, {...referenced, event: 'workflow_dispatch'}, {...referenced, head_sha: pin}, {...referenced, referenced_workflows: []}, {...referenced, referenced_workflows: [...referenced.referenced_workflows, ...referenced.referenced_workflows]}, {...referenced, referenced_workflows: [{...referenced.referenced_workflows[0], sha: baseEnv.GITHUB_SHA}]}, {...referenced, referenced_workflows: [{path: repository + '/.github/workflows/private-controller-preflight.yml@main', sha: pin}]}]) {
    await assert.rejects(resolve(baseEnv, async () => response(value)), /PUBLIC_RUNTIME_/);
  }
  await assert.rejects(resolve(baseEnv, async () => { throw Error('fixture-token'); }), /^Error: PUBLIC_RUNTIME_METADATA_UNAVAILABLE$/);
  await assert.rejects(resolve(baseEnv, async () => new Response('{}', {status: 403})), /PUBLIC_RUNTIME_METADATA_UNAVAILABLE/);
});

test('public pin validation precedes private admission and journal reservation; scheduled security tests use its immutable output', () => {
  assert.ok(workflow.indexOf('await resolvePublicRuntimePin(process.env)') < workflow.indexOf('const admission = await resolveFactorySource(process.env)'));
  assert.match(workflow, /public_runtime_sha: \$\{\{ steps\.pin\.outputs\.public_runtime_sha \}\}/);
  assert.match(workflow, /ref: \$\{\{ inputs\.night_shift == true && needs\.factory-source-admission\.outputs\.public_runtime_sha \|\| github\.sha \}\}/);
  assert.match(workflow, /security-tests:\n\s+needs: \[night-shift-admission, factory-source-admission\]/);
  assert.match(workflow, /night-shift-admission:\n\s+needs: factory-source-admission/);
  assert.equal(workflow.includes("'f13d1a3e0a2abb93890a0e36746f4eefb9c94f82'"), false);
});
