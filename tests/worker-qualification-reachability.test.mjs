// Reachability regression for the ONLY existing real-inference execution path.
//
// `service-access` hosts the single-step worker qualification that performs genuine model
// inference in isolation (separate from the multi-step integrated mission path).
// (`scripts/existing-worker-qualification.mjs` -> `recursive/flint-v1.0:free`).
// That step is gated on `inputs.qualify_worker`, but a step can only run when its
// parent JOB runs. Before this test, the job gate honoured `qualify_worker` only on
// the legacy probe branch, so the input was inert on the active working branch:
// Composio (or any authorized operator) could dispatch a perfectly valid
// `qualify_worker` request and receive no Flint result at all.
//
// No dispatch, credential, network call or external effect is performed here.
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const WORKFLOW = new URL('../.github/workflows/private-controller-preflight.yml', import.meta.url);
const source = fs.readFileSync(WORKFLOW, 'utf8');
const REPOSITORY = 'insidethemarginmedia-cpu/wolf-factory-home';
const ACTOR = 'insidethemarginmedia-cpu';
const ACTIVE_REF = 'refs/heads/fix/omega-acceptance-ready-20261028';
const PROBE_REF = 'refs/heads/feat/public-runtime-probe-20261022';
const MAIN_REF = 'refs/heads/main';

// The exact pre-repair gate body, taken from commit dc5a35c. Kept as a literal so
// falsification holds even in a shallow checkout, and integrity-checked against the
// real blob below whenever full history is available.
const PRE_REPAIR_GATE = [
  "always() && needs.security-tests.result == 'success' &&",
  "(inputs.verify_private_regression != true || needs.factory-source-admission.result == 'success') &&",
  `github.repository == '${REPOSITORY}' && github.actor == '${ACTOR}' &&`,
  "((github.ref == 'refs/heads/feat/public-runtime-probe-20261022') ||",
  `(github.event_name == 'workflow_dispatch' && github.ref == '${ACTIVE_REF}' && (inputs.verify_private_source == true || inputs.reconcile_boxxkite_label != '')) ||`,
  "(github.event_name == 'schedule' && github.ref == 'refs/heads/main' && inputs.night_shift == true &&",
  "needs.factory-source-admission.result == 'success' && needs.night-shift-admission.outputs.ready == 'true'))",
].join(' ');

function jobBody(name) {
  const body = source.split('\n  ' + name + ':\n')[1]?.split(/\n  [a-z][a-z-]+:\n/)[0];
  assert.ok(body, 'job ' + name + ' must exist');
  return body;
}

/** Extract a job gate, unfolding the `>-` block scalar like YAML would. */
function jobGate(name) {
  const match = jobBody(name).match(/ {4}if: ([\s\S]*?)\n {4}runs-on:/);
  assert.ok(match, 'job ' + name + ' must declare one gate before runs-on');
  return match[1].replace(/^\s*>-/, '').replace(/\n\s+/g, ' ').trim();
}

/** Declared workflow_dispatch defaults: GitHub supplies these, not `undefined`. */
function declaredInputDefaults() {
  const block = source.split('  workflow_dispatch:\n')[1].split('\npermissions:')[0];
  const defaults = {};
  const pattern = /^ {6}([a-z0-9_]+):\n(?: {8}.*\n)*? {8}default: (.*)$/gm;
  for (const match of block.matchAll(pattern)) {
    const raw = match[2].trim();
    defaults[match[1]] =
      raw === 'true' ? true : raw === 'false' ? false : raw.replace(/^'(.*)'$/, '$1');
  }
  return defaults;
}
const INPUT_DEFAULTS = declaredInputDefaults();

/**
 * Translate a GitHub Actions expression to JavaScript that keeps the same meaning:
 * hyphenated `needs.<job-id>.` paths become bracket access, and absent inputs
 * resolve to the declared default instead of `undefined` (a bare `!= ''` on
 * `undefined` is true in JS but false in Actions, which would silently invert
 * every negative assertion).
 */
function toJavaScript(expression) {
  return expression.replace(/needs\.([a-z][a-z0-9-]*)\./g, (_, job) => 'needs[' + JSON.stringify(job) + '].');
}

function evaluate(gateExpression, {github = {}, inputs = {}, results = {}} = {}) {
  const context = {
    repository: REPOSITORY,
    actor: ACTOR,
    event_name: 'workflow_dispatch',
    ref: ACTIVE_REF,
    ...github,
  };
  const inputView = new Proxy(
    {...INPUT_DEFAULTS, ...inputs},
    {get: (target, key) => (Object.hasOwn(target, key) ? target[key] : '')},
  );
  const needs = new Proxy(
    {},
    {
      get: (_, name) => ({
        result: results[name] ?? 'success',
        outputs: {ready: results['night-shift-admission:ready'] ?? 'false'},
      }),
    },
  );
  const body =
    'return (' + toJavaScript(gateExpression) + ');';
  return new Function('github', 'inputs', 'needs', 'always', body)(
    context,
    inputView,
    needs,
    () => true,
  );
}
const serviceAccess = options => evaluate(jobGate('service-access'), options);

test('the single-step real-inference qualification is recognised and stays bounded and manual', () => {
  const body = jobBody('service-access');
  const steps = body.split('\n      - name: ').slice(1);
  const qualification = steps.filter(step => step.startsWith('Qualify existing private worker adapter'));
  assert.equal(qualification.length, 1, 'exactly one real-inference qualification step');
  assert.match(qualification[0], /\n        if: github\.event_name == 'workflow_dispatch' && inputs\.qualify_worker == true\n/);
  assert.match(qualification[0], /\n {8}run: node scripts\/existing-worker-qualification\.mjs(?:\n|$)/);
  // The input is off unless explicitly requested.
  assert.match(source, /qualify_worker:\n {8}description: .*\n {8}type: boolean\n {8}default: false/);
});

test('pre-repair gate refused qualification on the active branch (falsification)', () => {
  assert.equal(evaluate(PRE_REPAIR_GATE, {inputs: {qualify_worker: true}}), false);
  // ...while the very same input was accepted on the legacy probe branch, which is
  // exactly why the defect was invisible to earlier qualification attempts.
  assert.equal(evaluate(PRE_REPAIR_GATE, {github: {ref: PROBE_REF}, inputs: {qualify_worker: true}}), true);
});

test('pre-repair literal is byte-faithful to the published base commit when history exists', t => {
  const exists = spawnSync('git', ['cat-file', '-e', 'dc5a35c41aac23a0410653dbf73aa5390cf9ae09'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  if (exists.status !== 0) return t.skip('shallow checkout: base commit object unavailable');
  const original = spawnSync(
    'git',
    ['show', 'dc5a35c41aac23a0410653dbf73aa5390cf9ae09:.github/workflows/private-controller-preflight.yml'],
    {cwd: new URL('..', import.meta.url), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024},
  );
  assert.equal(original.status, 0);
  const folded = original.stdout
    .split('\n  service-access:\n')[1]
    .split(/\n  [a-z][a-z-]+:\n/)[0]
    .match(/ {4}if: ([\s\S]*?)\n {4}runs-on:/)[1]
    .replace(/^\s*>-/, '')
    .replace(/\n\s+/g, ' ')
    .trim();
  assert.equal(folded, PRE_REPAIR_GATE, 'falsification baseline must match the real pre-repair blob');
});

test('repaired gate admits bounded qualification on the active branch only', () => {
  assert.equal(serviceAccess({inputs: {qualify_worker: true}}), true);
  const gate = jobGate('service-access');
  assert.ok(
    gate.includes("inputs.reconcile_boxxkite_label != '' || inputs.qualify_worker == true"),
    'the repair must be exactly one additive disjunct',
  );
});

test('repair grants no new identity, repository, event or branch access', () => {
  const denied = [
    {github: {actor: 'outsider'}, inputs: {qualify_worker: true}},
    {github: {actor: ''}, inputs: {qualify_worker: true}},
    {github: {repository: 'outsider/fork'}, inputs: {qualify_worker: true}},
    {github: {ref: 'refs/heads/unapproved'}, inputs: {qualify_worker: true}},
    {github: {ref: 'refs/heads/feat/other-branch'}, inputs: {qualify_worker: true}},
    {github: {ref: MAIN_REF}, inputs: {qualify_worker: true}},
    {github: {ref: MAIN_REF, event_name: 'schedule'}, inputs: {qualify_worker: true, night_shift: true}},
    {github: {ref: MAIN_REF, event_name: 'push'}, inputs: {qualify_worker: true}},
    {github: {event_name: 'pull_request'}, inputs: {qualify_worker: true}},
    {github: {event_name: 'pull_request_target'}, inputs: {qualify_worker: true}},
    {inputs: {qualify_worker: true}, results: {'security-tests': 'skipped'}},
    {inputs: {qualify_worker: true}, results: {'security-tests': 'failure'}},
    {inputs: {}},
  ];
  for (const options of denied) assert.equal(serviceAccess(options), false, JSON.stringify(options));
  // `main` stays reachable for the existing scheduled wakeup only, and only when the
  // durable reservation reports ready — the repair must not touch that path.
  assert.equal(
    serviceAccess({
      github: {ref: MAIN_REF, event_name: 'schedule'},
      inputs: {night_shift: true},
      results: {'factory-source-admission': 'success', 'night-shift-admission:ready': 'true'},
    }),
    true,
  );
  assert.equal(
    serviceAccess({
      github: {ref: MAIN_REF, event_name: 'schedule'},
      inputs: {night_shift: true},
      results: {'factory-source-admission': 'success', 'night-shift-admission:ready': 'false'},
    }),
    false,
  );
});

test('the repair adds no executable permission to the job or the workflow', () => {
  assert.match(source.split('\npermissions:\n  contents: read\n')[0] + '\npermissions:\n  contents: read\n', /permissions:\n {2}contents: read\n/);
  assert.doesNotMatch(jobBody('service-access'), /\n {4}permissions:/);
  assert.doesNotMatch(source, /permissions:\n {2}(contents|actions|packages|id-token|pull-requests|checks|statuses): write\n/);
});

test('zero-cost admission is enforced before any inference can occur', () => {
  const runtime = fs.readFileSync(new URL('../scripts/existing-worker-qualification.mjs', import.meta.url), 'utf8');
  const preflight = fs.readFileSync(new URL('../scripts/private-controller-preflight.mjs', import.meta.url), 'utf8');
  // Economic refusal precedes executor construction and therefore the model call.
  assert.ok(
    runtime.indexOf("throw Error('ECONOMIC_ADMISSION_REQUIRED')") < runtime.indexOf('loadExecutor=()=>'),
    'economic admission must be decided before the executor is built',
  );
  assert.match(runtime, /auth\.economicAdmission!=='PASS'/);
  assert.match(runtime, /auth\.authenticationVerified!==true/);
  // The worker identity is the exact free Flint model, and pricing must be all zero.
  assert.match(runtime, /recursive\/flint-v1\.0:free/);
  assert.match(runtime, /receipt\.costUsd!==0/);
  assert.match(preflight, /pricing\.prompt!=='0'/);
  assert.match(preflight, /Object\.values\(pricing\)\.some\(price=>price!=='0'\)/);
  assert.match(preflight, /key\.data\?\.is_free_tier!==true\|\|key\.data\?\.limit!==0\|\|key\.data\?\.byok_usage!==0/);
  // A qualification success must never be reported as a controller mission.
  assert.match(runtime, /controllerMissionVerified:false/);
});
