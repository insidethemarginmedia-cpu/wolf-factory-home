// Regression: a bounded wakeup must never conclude as a silent green run.
//
// Observed production defect (evidence, not inference):
//   run 41174505505 (schedule, main@3742bcc, callee c6ddef9c) concluded `success`
//   in 8s after executing exactly one step:
//     - "Reserve one durable wakeup without external mission effects"  success
//     - "Require currently observable free provider quota..."          skipped
//     - "Persist safe suspension after bounded gate failure"           skipped
//     - every downstream mission job                                  skipped
//   The reservation reported ready != 'true', so the quota gate and all mission
//   jobs were skipped, and the only disposition step required failure(). The run
//   was therefore administratively green while provably performing no mission work.
//
// Invariant now enforced: for every reachable disposition, either mission work was
// admitted, or a step durably records an explicit non-mission operational outcome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(
  new URL('../.github/workflows/private-controller-preflight.yml', import.meta.url),
  'utf8',
);

function jobBlock(source, name) {
  const block = source.match(
    new RegExp('^  ' + name + ':(\\n[\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:|$(?![\\s\\S]))', 'm'),
  )?.[1];
  assert.ok(block, 'existing job must be present: ' + name);
  return block;
}

// Steps are the only entries at exactly four spaces followed by "- ".
function stepByName(block, name) {
  const marker = '    - name: ' + name + '\n';
  const start = block.indexOf(marker);
  assert.ok(start >= 0, 'existing step must be present: ' + name);
  const rest = block.slice(start + marker.length);
  const next = rest.search(/\n    - name: |\n    - uses: /);
  return (next === -1 ? rest : rest.slice(0, next)) + '\n';
}

function stepCondition(step) {
  return step.match(/^      if: (.+)$/m)?.[1] ?? null;
}

// Evaluate a GitHub Actions expression with JavaScript semantics. The subset used
// here (||, &&, ==, !=, literals, step context) is identical in both languages.
function evaluate(expression, context) {
  return new Function('github', 'inputs', 'steps', 'failure', 'always', 'success', 'return (' + expression + ');')(
    context.github,
    context.inputs,
    context.steps,
    context.failure ?? (() => false),
    context.always ?? (() => true),
    context.success ?? (() => true),
  );
}

const job = jobBlock(workflow, 'night-shift-admission');
const skipStep = stepByName(job, 'Record explicit operational skip without mission work');
const terminalStep = stepByName(job, 'Publish only a separately approved V1 terminal disposition');
const quotaStep = stepByName(job, 'Admit one bounded direct Groq Free attempt without OpenRouter quota dependency');
const suspendStep = stepByName(job, 'Persist safe suspension after bounded gate failure');
const reserveStep = stepByName(job, 'Reserve one durable wakeup without external mission effects');

const steps = name => ({outputs: {}, outcome: 'success', conclusion: 'success', name});

test('an idle reservation records an explicit outcome instead of concluding silently', () => {
  const condition = stepCondition(skipStep);
  assert.ok(condition, 'the skip disposition must be conditional, never unconditional');
  const github = {event_name: 'schedule', ref: 'refs/heads/main'};
  const run = (inputs, reserveReady) =>
    evaluate(condition, {
      github,
      inputs,
      steps: {
        reserve: {outputs: {ready: reserveReady}, outcome: 'success', conclusion: 'success'},
      },
    });

  // The exact production case: schedule, reservation succeeded, ready is false/empty.
  assert.equal(run({night_shift: true, v1_terminal_request: ''}, 'false'), true);
  assert.equal(run({night_shift: true, v1_terminal_request: ''}, ''), true);
  // Mission work admitted: the skip receipt must not fire.
  assert.equal(run({night_shift: true, v1_terminal_request: ''}, 'true'), false);
  // Separately approved V1 disposition owns its own outcome.
  assert.equal(run({night_shift: true, v1_terminal_request: '{"a":1}'}, 'false'), false);
});

test('the skip receipt is durable, credential-free and creates no external effect', () => {
  assert.match(skipStep, /^\s+id: operational_skip$/m);
  assert.match(skipStep, />> "\$GITHUB_STEP_SUMMARY"/, 'outcome must be visible on the run summary');
  assert.match(skipStep, /operational_outcome=\$\{outcome\}.*>> "\$GITHUB_OUTPUT"/, 'outcome must be machine readable');
  assert.match(skipStep, /NO_MISSION_WORK_PERFORMED/);
  assert.match(skipStep, /NOT autonomous acceptance/);
  // No credential, provider, publication, git or private-script access in this path.
  for (const forbidden of [
    'GITHUB_TOKEN',
    'secrets.',
    'node scripts/',
    'git ',
    'curl',
    'wget',
    'npm ',
  ]) {
    assert.equal(skipStep.includes(forbidden), false, 'skip receipt must not use: ' + forbidden);
  }
});

test('the operational outcome is declared as a reusable-workflow output', () => {
  assert.match(
    job,
    /^      operational_outcome: \$\{\{ steps\.operational_skip\.outputs\.operational_outcome \|\| steps\.terminal\.outputs\.operational_outcome \|\| /m,
    'job must publish a single authoritative operational outcome',
  );
  assert.match(
    workflow,
    /^    outputs:\n      operational_outcome:\n[\s\S]*?value: \$\{\{ jobs\.night-shift-admission\.outputs\.operational_outcome \}\}/m,
    'callers must be able to observe the disposition',
  );
});

test('every reachable disposition resolves to a definite, machine-readable outcome', () => {
  const raw = job.match(/^      operational_outcome: (.+)$/m)?.[1];
  assert.ok(raw, 'operational outcome expression must exist');
  const expression = raw.replace(/^\$\{\{/, '').replace(/\}\}$/, '').trim();
  const resolve = state =>
    evaluate(expression, {
      github: {event_name: 'schedule', ref: 'refs/heads/main'},
      inputs: {night_shift: true, v1_terminal_request: ''},
      steps: state,
    });

  const admitted = resolve({
    reserve: {outputs: {ready: 'true'}, outcome: 'success', conclusion: 'success'},
    quota: {outputs: {}, outcome: 'success', conclusion: 'success'},
    operational_skip: {outputs: {}, outcome: 'skipped', conclusion: 'skipped'},
    terminal: {outputs: {}, outcome: 'skipped', conclusion: 'skipped'},
  });
  assert.equal(admitted, 'MISSION_WORK_ADMITTED');

  const idle = resolve({
    reserve: {outputs: {ready: 'false'}, outcome: 'success', conclusion: 'success'},
    quota: {outputs: {}, outcome: 'skipped', conclusion: 'skipped'},
    operational_skip: {outputs: {operational_outcome: 'NO_MISSION_WORK_PERFORMED'}, outcome: 'success', conclusion: 'success'},
    terminal: {outputs: {}, outcome: 'skipped', conclusion: 'skipped'},
  });
  assert.equal(idle, 'NO_MISSION_WORK_PERFORMED');

  const terminal = resolve({
    reserve: {outputs: {}, outcome: 'skipped', conclusion: 'skipped'},
    quota: {outputs: {}, outcome: 'skipped', conclusion: 'skipped'},
    operational_skip: {outputs: {}, outcome: 'skipped', conclusion: 'skipped'},
    terminal: {outputs: {operational_outcome: 'V1_TERMINAL_DISPOSITION_ONLY'}, outcome: 'success', conclusion: 'success'},
  });
  assert.equal(terminal, 'V1_TERMINAL_DISPOSITION_ONLY');

  // Anything else must be reported as undetermined, never as admission.
  const undetermined = resolve({
    reserve: {outputs: {ready: 'true'}, outcome: 'failure', conclusion: 'failure'},
    quota: {outputs: {}, outcome: 'skipped', conclusion: 'skipped'},
    operational_skip: {outputs: {}, outcome: 'skipped', conclusion: 'skipped'},
    terminal: {outputs: {}, outcome: 'skipped', conclusion: 'skipped'},
  });
  assert.equal(undetermined, 'OPERATIONAL_OUTCOME_UNDETERMINED');
});

test('the admitted flag still requires the quota gate, and suspension still follows a gate failure', () => {
  assert.match(job, /^      ready: \$\{\{ steps\.reserve\.outputs\.ready == 'true' && steps\.quota\.outcome == 'success' \}\}$/m);
  assert.equal(stepCondition(quotaStep), "steps.reserve.outputs.ready == 'true'");
  assert.equal(stepCondition(suspendStep), "failure() && steps.reserve.outputs.ready == 'true'");
  // reserve must never itself be conditional on the outcome it produces
  assert.equal(stepCondition(reserveStep), "inputs.v1_terminal_request == ''");
});

test('the recorded production defect cannot recur: a skipped quota gate always emits a receipt', () => {
  // Reconstruct run 41174505505's observed step statuses.
  const observed = {
    reserve: {outputs: {ready: 'false'}, outcome: 'success', conclusion: 'success'},
    quota: {outputs: {}, outcome: 'skipped', conclusion: 'skipped'},
    suspend: {outputs: {}, outcome: 'skipped', conclusion: 'skipped'},
  };
  // Previously: no disposition step fired at all, so the job simply succeeded.
  assert.equal(evaluate(stepCondition(suspendStep), {github: {}, inputs: {night_shift: true, v1_terminal_request: ''}, steps: observed}), false);
  // Now: the skip receipt is mandatory for that same observation.
  assert.equal(
    evaluate(stepCondition(skipStep), {
      github: {},
      inputs: {night_shift: true, v1_terminal_request: ''},
      steps: observed,
    }),
    true,
  );
  assert.ok(steps);
});
