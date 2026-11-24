import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildWorkflowPlan, parseWorkflowJobs, readLocalCompositeAction} from '../scripts/private-ci-workflow.mjs';

const sample = [
  'name: Sample',
  'on:',
  '  push:',
  'jobs:',
  '  verify:',
  '    runs-on: ubuntu-latest',
  '    services:',
  '      postgres:',
  '        image: postgres:17',
  '    steps:',
  '      - name: Checkout',
  '        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  '      - name: Run the sequence',
  '        env:',
  '          PGDATABASE: wolf_test',
  '        run: |',
  '          set -euo pipefail',
  '          psql -f scripts/verify-a.sql',
  '          node scripts/measure.mjs',
  '      - name: Inline command',
  '        run: npm test',
  '  evidence:',
  '    steps:',
  '      - name: Only a name',
  '        if: always()',
].join('\n');

test('jobs and steps are parsed with their order preserved', () => {
  const jobs = parseWorkflowJobs(sample);
  assert.deepEqual(jobs.map(job => job.name), ['verify', 'evidence']);
  assert.deepEqual(jobs[0].steps.map(step => step.name), ['Checkout', 'Run the sequence', 'Inline command']);
  assert.equal(jobs[0].steps[0].uses, 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262');
  assert.match(jobs[0].steps[1].run, /psql -f scripts\/verify-a\.sql/);
  assert.match(jobs[0].steps[1].run, /node scripts\/measure\.mjs/);
  assert.equal(jobs[0].steps[1].env.PGDATABASE, 'wolf_test');
  assert.equal(jobs[0].steps[2].run, 'npm test');
});

test('block scalars stop at the next step and keep internal blank lines', () => {
  const text = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - name: One',
    '        run: |',
    '          line-1',
    '',
    '          line-3',
    '      - name: Two',
    '        run: echo two',
  ].join('\n');
  const jobs = parseWorkflowJobs(text);
  assert.equal(jobs[0].steps[0].run, 'line-1\n\nline-3');
  assert.equal(jobs[0].steps[1].run, 'echo two');
});

test('a step with no run or uses is preserved rather than dropped', () => {
  const plan = buildWorkflowPlan(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')), 'missing.yml');
  assert.equal(plan.state, 'ABSENT');
  const jobs = parseWorkflowJobs(sample);
  assert.equal(jobs[1].steps[0].run, null);
});

test('local composite actions are inlined in place', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-composite-'));
  fs.mkdirSync(path.join(root, '.github', 'actions', 'verify'), {recursive: true});
  fs.writeFileSync(path.join(root, '.github', 'actions', 'verify', 'action.yml'), [
    'name: verify',
    'runs:',
    '  using: composite',
    '  steps:',
    '    - name: Install psql',
    '      shell: bash',
    '      run: apt-get install -y postgresql-client',
    '    - name: Apply migrations',
    '      shell: bash',
    '      run: |',
    '        for file in supabase/migrations/*.sql; do psql -f "$file"; done',
  ].join('\n'));
  fs.mkdirSync(path.join(root, '.github', 'workflows'), {recursive: true});
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'schema.yml'), [
    'jobs:',
    '  verify-invoice-schema:',
    '    steps:',
    '      - name: Run the verification',
    '        uses: ./.github/actions/verify',
  ].join('\n'));

  const composite = readLocalCompositeAction(root, './.github/actions/verify');
  assert.equal(composite.steps.length, 2);
  assert.match(composite.steps[1].run, /supabase\/migrations/);

  const plan = buildWorkflowPlan(root, '.github/workflows/schema.yml');
  assert.equal(plan.jobs[0].steps.length, 2);
  assert.equal(plan.jobs[0].steps[0].run, 'apt-get install -y postgresql-client');
  assert.equal(plan.jobs[0].steps[0].fromComposite, '.github/actions/verify/action.yml');
  fs.rmSync(root, {recursive: true, force: true});
});

test('unreadable workflows fail closed instead of returning an empty plan', () => {
  assert.throws(() => parseWorkflowJobs(''), /WORKFLOW_TEXT_REQUIRED/);
  assert.throws(() => parseWorkflowJobs('name: x\non: push'), /WORKFLOW_JOBS_MISSING/);
  assert.throws(() => parseWorkflowJobs('jobs:\non: push'), /WORKFLOW_JOBS_EMPTY/);
});

test('quoted values and inline comments are handled without corrupting commands', () => {
  const text = [
    'jobs:',
    '  a:',
    '    steps:',
    "      - name: 'Quoted name'",
    '        run: echo hello # trailing comment',
    '      - name: Hash in quotes',
    '        run: echo "a # b"',
  ].join('\n');
  const jobs = parseWorkflowJobs(text);
  assert.equal(jobs[0].steps[0].name, 'Quoted name');
  assert.equal(jobs[0].steps[0].run, 'echo hello');
  assert.equal(jobs[0].steps[1].run, 'echo "a # b"');
});
