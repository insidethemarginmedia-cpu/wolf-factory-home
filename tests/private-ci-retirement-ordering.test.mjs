// Ordering invariants for durable retirement.
//
// The bypass this guards against is not in the selector, it is in the *sequence*:
// if any step that consumes a PAT is declared before the retirement decision is
// hydrated, that step enforces nothing and the retirement is advisory again.
// Unit tests of `selectCredential` cannot catch that, because the selector is
// never reached with the right input. So the workflow's own step order is tested.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';

import {parseWorkflowJobs} from '../scripts/private-ci-workflow.mjs';

const WORKFLOW = '.github/workflows/private-ci-bridge.yml';
const text = fs.readFileSync(WORKFLOW, 'utf8');
const jobs = parseWorkflowJobs(text);
const execute = jobs.find(job => job.name === 'execute');

// A step "consumes the PAT" if its env or run block mentions any PAT secret.
// Both are checked because the workflow mixes `token:` inputs with `env:`.
const patMarkers = ['WOLF_FACTORY_REPO_TOKEN', 'WOLF_FACTORY_STATUS_TOKEN'];
const consumesPat = step => patMarkers.some(marker => JSON.stringify(step).includes(marker));

const indexOfStep = predicate => execute.steps.findIndex(predicate);

test('the execute job exists and carries the retirement steps', () => {
  assert.ok(execute, 'execute job must exist');
  assert.ok(execute.steps.length > 20, 'execute job should still carry its full pipeline');
});

test('durable retirement is hydrated before the first PAT-consuming step', () => {
  const hydrate = indexOfStep(step => step.name === 'Hydrate durable retirement before any credential is selected');
  assert.ok(hydrate >= 0, 'the hydration step must exist');

  const firstPat = indexOfStep(consumesPat);
  assert.ok(firstPat >= 0, 'expected at least one PAT-consuming step');

  assert.ok(
    hydrate < firstPat,
    `hydration is step ${hydrate + 1} but the first PAT-consuming step is ${firstPat + 1} ` +
    `("${execute.steps[firstPat].name}") - a step that runs before hydration cannot be gated by it`,
  );
});

test('hydration runs immediately after checkout, before any credential work', () => {
  const hydrate = indexOfStep(step => step.name === 'Hydrate durable retirement before any credential is selected');
  const names = execute.steps.slice(0, hydrate).map(step => step.name);
  // Only the checkout may precede it. Anything else is an ungated step.
  assert.equal(names.length, 1, 'only checkout may run before hydration, saw: ' + JSON.stringify(names));
  assert.match(names[0], /Checkout/);
});

test('the retirement decision is persisted so later runs inherit it', () => {
  const persist = execute.steps.find(step => step.name === 'Persist the retirement decision so later runs inherit it');
  assert.ok(persist, 'a persistence step must exist');
  // `continue-on-error` is not among the keys the step parser surfaces, so the
  // raw block is checked. Persistence failing must not turn a green run red.
  const block = text.slice(text.indexOf('Persist the retirement decision'));
  const head = block.slice(0, block.indexOf('- name:', 10) === -1 ? 1200 : block.indexOf('- name:', 10));
  assert.match(head, /continue-on-error:\s*true/, 'persistence failure must not turn a green run red');
  // It must target the dedicated ledger branch, never the default branch.
  assert.match(String(persist.run), /wolf-ci-retirement/);
  assert.doesNotMatch(String(persist.run), /branch=main\b/);
});

test('no step writes retirement evidence to the default branch', () => {
  const offenders = execute.steps.filter(step => {
    const body = String(step.run ?? '');
    return /contents\/\.wolf-ci|retirement-ledger/.test(body) && /branch=main\b|-f branch=main/.test(body);
  });
  assert.deepEqual(offenders.map(s => s.name), []);
});

test('the persistence step creates its branch before writing to it', () => {
  // The contents API writes into an existing branch and cannot create one. A write
  // attempted first returns 404, and with continue-on-error the run stays green
  // while the ledger silently never exists.
  const persist = execute.steps.find(step => step.name === 'Persist the retirement decision so later runs inherit it');
  const body = String(persist.run);
  const createsRef = body.indexOf('git/refs');
  const writesContent = body.indexOf('contents/.wolf-ci/retirement-ledger.jsonl');
  assert.ok(createsRef >= 0, 'the step must create the ledger branch explicitly');
  assert.ok(writesContent >= 0, 'the step must write the ledger file');
  assert.ok(createsRef < writesContent, 'the branch must be created before the first write');
  // The existence probe reads the file; only the writes must come after the
  // branch exists, and the ref creation is what guarantees that.
  assert.ok(/git\/ref\/heads\/wolf-ci-retirement/.test(body), 'the step must probe for the branch before creating it');
});

test('the hydration step does not fail the run when no ledger exists', () => {
  // Absence of retirement evidence must never be an outage: the App path does not
  // depend on the PAT, and a missing ledger is not evidence of retirement.
  const hydrate = execute.steps.find(step => step.name === 'Hydrate durable retirement before any credential is selected');
  const block = text.slice(text.indexOf('Hydrate durable retirement'));
  const head = block.slice(0, block.indexOf('- name:', 10) === -1 ? 1500 : block.indexOf('- name:', 10));
  assert.match(head, /continue-on-error:\s*true/, 'a missing ledger must not fail the run');
  assert.match(String(hydrate.run), /RETIREMENT_LEDGER=ABSENT/);
});

test('the target resolver runs after the reader credential is established', () => {
  // The resolver needs a reader token. Declared before the authentication step it
  // can only ever report NO_READER_CREDENTIAL, and the receipt then publishes
  // NOT_REPORTED - a resolution step that resolves nothing, on a green run.
  const auth = execute.steps.findIndex(step => /Authenticate to the private Factory/.test(step.name ?? ''));
  const resolve = execute.steps.findIndex(step => /Resolve the authoritative PR head/.test(step.name ?? ''));
  assert.ok(auth >= 0, 'the authentication step must exist');
  assert.ok(resolve >= 0, 'the resolver step must exist');
  assert.ok(resolve > auth, `resolver is step ${resolve + 1} but authentication is step ${auth + 1}`);
});

test('the resolver publishes its verdict onto the receipt', () => {
  // A resolved target that never reaches the receipt is a check nobody can read.
  const bridge = fs.readFileSync('scripts/private-ci-bridge.mjs', 'utf8');
  assert.match(bridge, /acceptanceTarget:/);
  assert.match(bridge, /acceptanceValid/);
});

test('the target output path is job-level, so the receipt builder can read it', () => {
  // Declared only in the resolver step, the path was invisible to the step that
  // builds the receipt: the resolution happened and published as NOT_REPORTED.
  const envBlock = text.slice(text.indexOf('\n    env:\n'), text.indexOf('\n    steps:'));
  assert.match(envBlock, /WOLF_CI_TARGET_OUTPUT:/, 'the path must be visible to every step in the job');
});
