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
  const hydrate = indexOfStep(step => step.name === 'Hydrate and verify durable retirement evidence before credential selection');
  assert.ok(hydrate >= 0, 'the hydration step must exist');

  const firstPat = indexOfStep(consumesPat);
  assert.ok(firstPat >= 0, 'expected at least one PAT-consuming step');

  assert.ok(
    hydrate < firstPat,
    `hydration is step ${hydrate + 1} but the first PAT-consuming step is ${firstPat + 1} ` +
    `("${execute.steps[firstPat].name}") - a step that runs before hydration cannot be gated by it`,
  );
});

test('retirement hydration runs immediately after the in-job admission re-check, before credential work', () => {
  const hydrate = indexOfStep(step => step.name === 'Hydrate and verify durable retirement evidence before credential selection');
  const names = execute.steps.slice(0, hydrate).map(step => step.name);
  // The exact ledger re-check must be the only step between checkout and retirement
  // hydration. No credential selector, service probe or private-source access may
  // precede either gate.
  assert.deepEqual(names, [
    'Checkout the public controller without persisted credentials',
    'Re-verify durable mission admission before private access',
  ]);
  const admissionGate = indexOfStep(step => step.name === 'Re-verify durable mission admission before private access');
  assert.ok(admissionGate >= 0 && admissionGate < hydrate);
});

test('the retirement decision is persisted so later runs inherit it', () => {
  const persist = execute.steps.find(step => step.name === 'Persist the retirement decision without rewriting remote history');
  assert.ok(persist, 'a persistence step must exist');
  // `continue-on-error` is not among the keys the step parser surfaces, so the
  // raw block is checked. Persistence failure is separately saved to a receipt.
  const start = text.indexOf('Persist the retirement decision without rewriting remote history');
  const end = text.indexOf('- name:', start + 10);
  const block = text.slice(start, end === -1 ? start + 2500 : end);
  assert.match(block, /continue-on-error:\s*true/);
  assert.match(String(persist.run), /private-ci-retirement-persist\.mjs/);
  assert.match(block, /RETIREMENT_PERSISTENCE_EXIT=/);
  assert.doesNotMatch(String(persist.run), /branch=main\b/);
});

test('no step writes retirement evidence to the default branch', () => {
  const offenders = execute.steps.filter(step => {
    const body = String(step.run ?? '');
    return /contents\/\.wolf-ci|retirement-ledger/.test(body) && /branch=main\b|-f branch=main/.test(body);
  });
  assert.deepEqual(offenders.map(s => s.name), []);
});

test('the persistence step delegates branch creation and remote fetch to the tested CLI', () => {
  const persist = execute.steps.find(step => step.name === 'Persist the retirement decision without rewriting remote history');
  assert.ok(persist, 'the persistence step must exist');
  assert.match(String(persist.run), /private-ci-retirement-persist\.mjs persist/);
  assert.match(JSON.stringify(persist.env), /WOLF_CI_RETIREMENT_PERSIST_FILE/);

  const source = fs.readFileSync('scripts/private-ci-retirement-persist.mjs', 'utf8');
  const createBranch = source.indexOf('/git/refs');
  const fetchFiles = source.indexOf('const [ledgerFile, anchorFile]');
  const writeLedger = source.indexOf('/contents/${RETIREMENT_LEDGER_PATH}');
  const writeAnchor = source.indexOf('/contents/${RETIREMENT_ANCHOR_PATH}');
  assert.ok(createBranch >= 0 && fetchFiles > createBranch, 'the ref is resolved before remote contents are read');
  assert.ok(writeLedger > fetchFiles && writeAnchor > writeLedger, 'the remote ledger is written before its anchor');
});

test('unavailable retirement evidence withholds PAT but does not block the App path', () => {
  const hydrate = execute.steps.find(step => step.name === 'Hydrate and verify durable retirement evidence before credential selection');
  const start = text.indexOf('Hydrate and verify durable retirement evidence');
  const end = text.indexOf('- name:', start + 10);
  const block = text.slice(start, end === -1 ? start + 6000 : end);
  assert.doesNotMatch(block, /continue-on-error:\s*true/, 'an error cannot be hidden as successful hydration');
  assert.match(String(hydrate.run), /WOLF_CI_RETIREMENT_REQUIRE_ANCHOR=true/);
  assert.match(String(hydrate.run), /RETIREMENT_FALLBACK=WITHHELD_EVIDENCE_UNVERIFIABLE/);
  assert.match(String(hydrate.run), /RETIREMENT_LEDGER=UNAVAILABLE/);
});

test('the resolver receives a step-scoped App reader token before private source access', () => {
  const reader = execute.steps.findIndex(step => /Mint the reader installation token with the official action/.test(step.name ?? ''));
  const resolve = execute.steps.findIndex(step => /Resolve the authoritative PR head/.test(step.name ?? ''));
  const clone = execute.steps.findIndex(step => /Clone the private commit/.test(step.name ?? ''));
  assert.ok(reader >= 0, 'the official reader token action must exist');
  assert.ok(resolve > reader, `resolver is step ${resolve + 1} but reader token action is step ${reader + 1}`);
  assert.ok(clone > resolve, 'target resolution must precede the private clone');
  assert.match(JSON.stringify(execute.steps[resolve].env), /steps\.app_reader\.outputs\.token/);
  assert.doesNotMatch(JSON.stringify(execute.steps[resolve].env), /\$\{\{\s*env\.WOLF_CI_APP_READER_TOKEN/);
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
  // Sized from the execute job's own env block, located by its distinctive first
  // entry rather than by the first `env:` in the file, which belongs to another job.
  const jobStart = text.indexOf('\n  execute:');
  assert.ok(jobStart > 0, 'the execute job must exist');
  // Anchored on the execute job, because the probe job opens with the same first
  // variable and would match a naive search for the first `env:` block.
  const envStart = text.indexOf('    env:\n', jobStart);
  assert.ok(envStart > 0, 'the execute job must have a job-level env block');
  const envEnd = text.indexOf('    steps:', envStart);
  const envBlock = text.slice(envStart, envEnd);
  // Six-space indent is job level; ten-space is a step. The distinction is the bug.
  assert.match(envBlock, /^      WOLF_CI_TARGET_OUTPUT:/m, 'the path must be job-level, not step-level');
});

test('the persistence CLI verifies and anchors the exact remote ledger bytes', () => {
  const source = fs.readFileSync('scripts/private-ci-retirement-persist.mjs', 'utf8');
  assert.match(source, /verifyLedger\(ledgerText\)/);
  assert.match(source, /compareToAnchor\(verification, previousAnchor\)/);
  assert.match(source, /buildHeadAnchor\(finalVerification/);
  assert.match(source, /RETIREMENT_LEDGER_ANCHOR_PAIR_INCOMPLETE/);
  assert.match(source, /LEDGER_SHORTER_THAN_ANCHOR/);
  assert.ok(source.indexOf('/contents/${RETIREMENT_LEDGER_PATH}') < source.indexOf('/contents/${RETIREMENT_ANCHOR_PATH}'));
});

test('the prior anchor is parsed and compared before it can be overwritten', () => {
  const source = fs.readFileSync('scripts/private-ci-retirement-persist.mjs', 'utf8');
  const fetchAnchor = source.indexOf('getContents({repository, file: RETIREMENT_ANCHOR_PATH');
  const compare = source.indexOf('compareToAnchor(verification, previousAnchor)');
  const writeAnchor = source.indexOf('/contents/${RETIREMENT_ANCHOR_PATH}');
  assert.ok(fetchAnchor >= 0 && compare > fetchAnchor, 'remote anchor is read and verified first');
  assert.ok(writeAnchor > compare, 'anchor write follows the successful comparison');
});
