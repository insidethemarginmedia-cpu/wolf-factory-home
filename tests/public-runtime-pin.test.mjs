import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/private-controller-preflight.yml', import.meta.url), 'utf8');
const caller = fs.readFileSync(new URL('../.github/workflows/night-shift-wakeup.yml', import.meta.url), 'utf8');
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

function jobBlock(source, name) {
  const block = source.match(new RegExp('^  ' + name + ':\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:|$(?![\\s\\S]))', 'm'))?.[1];
  assert.ok(block, 'existing job must be present: ' + name);
  return block;
}

function jobPermissions(source, name) {
  const permissions = jobBlock(source, name).match(/^    permissions:\n((?:      [a-z-]+: (?:read|write|none)\n)+)/m)?.[1];
  assert.ok(permissions, 'job permission boundary must be explicit: ' + name);
  return Object.fromEntries([...permissions.matchAll(/^      ([a-z-]+): (read|write|none)$/gm)].map(match => match.slice(1)));
}

test('existing caller can grant the callee Actions metadata read without expanding its write boundary', () => {
  const available = jobPermissions(caller, 'existing-factory');
  const required = jobPermissions(workflow, 'factory-source-admission');
  const rank = {none: 0, read: 1, write: 2};
  for (const [scope, level] of Object.entries(required)) {
    assert.ok((rank[available[scope]] ?? 0) >= rank[level], 'caller cannot grant required ' + scope + ':' + level);
  }
  assert.deepEqual(available, {contents: 'write', actions: 'read'});
});

test('scheduled caller pins identical immutable callee and runtime input, and caller edits receive exact-HEAD CI', () => {
  const block = jobBlock(caller, 'existing-factory');
  const callee = block.match(/^    uses: insidethemarginmedia-cpu\/wolf-factory-home\/\.github\/workflows\/private-controller-preflight.yml@([a-f0-9]{40})$/m)?.[1];
  const input = block.match(/^      public_runtime_sha: ([a-f0-9]{40})$/m)?.[1];
  assert.ok(callee, 'mutable callee refs are denied');
  assert.equal(input, callee, 'runtime input must match the actual reusable workflow');
  const triggerPaths = workflow.split('\npermissions:\n')[0];
  assert.match(triggerPaths, /^      - '\.github\/workflows\/night-shift-wakeup.yml'$/m);
});

test('manual caller diagnostic on the PR branch admits source only and cannot reserve or execute a wakeup', () => {
  const github = {repository, actor: 'insidethemarginmedia-cpu', event: {repository: {private: false}}, event_name: 'workflow_dispatch', ref: 'refs/heads/fix/omega-acceptance-ready-20261028'};
  const inputs = {night_shift: true};
  const needs = {'factory-source-admission': {result: 'success'}, 'security-tests': {result: 'skipped'}, 'night-shift-admission': {outputs: {ready: 'false'}}};
  const enabled = name => {
    const expression = jobBlock(workflow, name).match(/^    if: ([\s\S]*?)(?=\n    [a-zA-Z_-]+:)/m)?.[1].replace(/\n\s*/g, ' ').replaceAll('needs.factory-source-admission', 'needs["factory-source-admission"]').replaceAll('needs.security-tests', 'needs["security-tests"]').replaceAll('needs.night-shift-admission', 'needs["night-shift-admission"]');
    assert.ok(expression, 'existing condition must remain explicit: ' + name);
    return new Function('github', 'inputs', 'needs', 'always', 'return (' + expression + ');')(github, inputs, needs, () => true);
  };
  assert.equal(enabled('factory-source-admission'), true);
  assert.equal(enabled('night-shift-admission'), false);
  assert.equal(enabled('integrated-factory'), false);
});

const scheduledContext = {
  github: {repository, actor: 'insidethemarginmedia-cpu', event: {repository: {private: false}}, event_name: 'schedule', ref: 'refs/heads/main'},
  inputs: {night_shift: true},
  needs: {
    'factory-source-admission': {result: 'success'},
    'security-tests': {result: 'success'},
    'night-shift-admission': {result: 'success', outputs: {ready: 'true'}},
    'runner-loss-prepare': {result: 'success'},
  },
  env: {OPENROUTER_API_KEY: ''},
};
function evaluate(expression, context = scheduledContext) {
  const executable = expression.replace(/^>-?\n\s*/, '').replace(/\n\s*/g, ' ').replace(/needs\.([a-z][a-z0-9-]*)/g, 'needs["$1"]');
  return Boolean(new Function('github', 'inputs', 'needs', 'env', 'always', 'return (' + executable + ');')(
    context.github, context.inputs, context.needs, context.env, () => true));
}
function eligible(name, context = scheduledContext) {
  const expression = jobBlock(workflow, name).match(/^    if: ([\s\S]*?)(?=\n    [a-zA-Z_-]+:)/m)?.[1];
  assert.ok(expression, 'explicit job boundary required: ' + name);
  return evaluate(expression, context);
}
function stepCondition(name) {
  const service = jobBlock(workflow, 'service-access');
  const start = service.indexOf('      - name: ' + name + '\n');
  assert.notEqual(start, -1, 'existing service step required: ' + name);
  const end = service.indexOf('\n      - ', start + 1);
  const block = service.slice(start, end === -1 ? undefined : end);
  const expression = block.match(/^        if: (.+)$/m)?.[1];
  assert.ok(expression, 'optional provider step requires an explicit boundary: ' + name);
  return expression;
}

test('admitted main schedule reaches operational Factory and read-only service checks', () => {
  for (const name of ['factory-source-admission', 'night-shift-admission', 'security-tests', 'integrated-factory', 'service-access']) {
    assert.equal(eligible(name), true, name + ' must accept an admitted scheduled wakeup');
  }
  assert.match(jobBlock(workflow, 'integrated-factory'), /needs: \[security-tests, night-shift-admission, factory-source-admission\]/);
  assert.match(jobBlock(workflow, 'service-access'), /needs: \[security-tests, factory-source-admission, night-shift-admission\]/);
  assert.match(jobBlock(workflow, 'service-access'), /ref: \$\{\{ inputs\.night_shift == true && needs\.factory-source-admission\.outputs\.public_runtime_sha \|\| github\.sha \}\}/);
});

test('suspended or failed admission cannot activate scheduled service checks or mission execution', () => {
  for (const admission of [{result: 'success', outputs: {ready: 'false'}}, {result: 'failure', outputs: {}}, {result: 'skipped', outputs: {}}]) {
    const context = {...scheduledContext, needs: {...scheduledContext.needs, 'night-shift-admission': admission}};
    assert.equal(eligible('service-access', context), false);
    assert.equal(eligible('integrated-factory', context), false);
  }
});

test('schedule cannot enable DBOS fixtures, OpenCode qualification or runner-loss diagnostics even with diagnostic flags', () => {
  const context = {...scheduledContext, inputs: {...scheduledContext.inputs, verify_dbos_runtime: true, qualify_opencode: true, verify_runner_loss: true, use_publication_deploy_key: true}};
  for (const name of ['dbos-runtime', 'opencode-runtime', 'runner-loss-prepare', 'runner-loss-recover']) {
    assert.equal(eligible(name, context), false, name + ' must remain explicitly manual');
  }
});

test('operational and service jobs reject foreign repositories, actors, refs and untrusted triggers', () => {
  for (const delta of [{repository: 'outsider/fork'}, {actor: 'outsider'}, {ref: 'refs/heads/other'}, {event_name: 'pull_request_target'}]) {
    const context = {...scheduledContext, github: {...scheduledContext.github, ...delta}};
    for (const name of ['service-access', 'integrated-factory']) assert.equal(eligible(name, context), false, JSON.stringify({name, delta}));
  }
});

test('scheduled checks and execution fail closed when source or security admission fails', () => {
  for (const dependency of ['factory-source-admission', 'security-tests']) {
    for (const result of ['failure', 'skipped', 'cancelled']) {
      const context = {...scheduledContext, needs: {...scheduledContext.needs, [dependency]: {result}}};
      for (const name of ['service-access', 'integrated-factory']) assert.equal(eligible(name, context), false);
    }
  }
});

test('optional OpenRouter does not gate a qualified scheduled Groq path', () => {
  const call = workflow.split('  workflow_dispatch:')[0];
  assert.match(call, /      OPENROUTER_API_KEY:\n        required: false/);
  for (const name of ['Verify OpenRouter authentication independently (no inference)', 'Read current free request allowance without inference', 'Verify service access without inference or private checkout']) {
    const condition = stepCondition(name);
    assert.equal(evaluate(condition), false);
    assert.equal(evaluate(condition, {...scheduledContext, env: {OPENROUTER_API_KEY: 'synthetic-present'}}), false);
    assert.equal(evaluate(condition, {...scheduledContext, github: {...scheduledContext.github, event_name: 'workflow_dispatch'}, inputs: {}, env: {OPENROUTER_API_KEY: ''}}), false);
  }
  assert.match(jobBlock(workflow, 'integrated-factory'), /for name in WOLF_FACTORY_REPO_TOKEN GROQ_API_KEY BOXXKITE_API_KEY; do/);
  assert.match(jobBlock(workflow, 'integrated-factory'), /continue-on-error: true # Ollama is advisory/);
});

test('existing manual diagnostics remain available on their approved refs without scheduling them', () => {
  const feature = {...scheduledContext, github: {...scheduledContext.github, event_name: 'workflow_dispatch', ref: 'refs/heads/feat/public-runtime-probe-20261022'}, inputs: {verify_dbos_runtime: true, qualify_opencode: true, verify_runner_loss: true, use_publication_deploy_key: true}};
  for (const name of ['dbos-runtime', 'opencode-runtime', 'service-access', 'runner-loss-prepare', 'runner-loss-recover']) assert.equal(eligible(name, feature), true, name);
  const reviewed = {...feature, github: {...feature.github, ref: 'refs/heads/fix/omega-acceptance-ready-20261028'}, inputs: {verify_private_source: true}};
  assert.equal(eligible('service-access', reviewed), true);
  assert.equal(eligible('night-shift-admission', reviewed), false);
  assert.equal(eligible('integrated-factory', reviewed), false);
  for (const name of ['runner-loss-prepare', 'runner-loss-recover']) assert.equal(eligible(name, reviewed), false);
});
