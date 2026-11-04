import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const workflowPath = path.join(root, '.github', 'workflows', 'private-controller-preflight.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const lines = workflow.split('\n');

const RETIRED_PINS = ['ee2d8ba15cd99d8788409c00c2fec3b1cd052370', 'ff0a29aae8179d9c4a0c57d5772ae58f282c5ea6', '57dd1e11344af0f736a6b7b07c7e5e15c768cbcd'];
const PINNED_REF = '${{ env.WOLF_FACTORY_EXPECTED_SHA }}';
const PRIVATE_REPOSITORY = 'donraposo1-source/project-wolf';

function jobBlocks() {
  const starts = [];
  lines.forEach((line, index) => { if (/^ {2}[a-z0-9-]+:$/.test(line) && index > lines.findIndex(l => l === 'jobs:')) starts.push({ name: line.trim().slice(0, -1), index }); });
  return starts.map((entry, position) => ({ name: entry.name, body: lines.slice(entry.index, starts[position + 1]?.index ?? lines.length).join('\n') }));
}

test('the pinned Factory SHA is declared exactly once, at workflow level', () => {
  const definitions = lines.filter(line => /^\s*WOLF_FACTORY_EXPECTED_SHA:/.test(line));
  assert.equal(definitions.length, 1, 'exactly one source-of-truth pin is required');
  assert.match(definitions[0], /^ {2}WOLF_FACTORY_EXPECTED_SHA: [a-f0-9]{40}$/);
});

test('no retired Factory SHA survives anywhere in the preflight', () => {
  for (const retired of RETIRED_PINS) assert.equal(workflow.includes(retired), false, `retired pin ${retired} must not be referenced`);
});

test('every private Factory checkout uses the single pinned identity', () => {
  let checkouts = 0;
  lines.forEach((line, index) => {
    if (!line.includes('repository: ' + PRIVATE_REPOSITORY)) return;
    checkouts += 1;
    const block = lines.slice(index, index + 8).join('\n');
    assert.match(block, /ref: \$\{\{ env\.WOLF_FACTORY_EXPECTED_SHA \}\}/, 'private checkout must use the workflow pin');
    assert.doesNotMatch(block, /ref: [a-f0-9]{40}/, 'private checkout must not hard-code a SHA');
  });
  assert.ok(checkouts >= 5, `expected the existing private checkouts to remain, found ${checkouts}`);
});

test('immutable source assertions compare against the pin and never a literal', () => {
  const assertions = lines.filter(line => line.includes('git rev-parse HEAD'));
  assert.ok(assertions.length >= 4);
  for (const line of assertions) assert.doesNotMatch(line, /'[a-f0-9]{40}'/, 'assertions must not hard-code a SHA');
  assert.ok(assertions.some(line => line.includes('$WOLF_FACTORY_EXPECTED_SHA')));
});

test('the live canonical branch is verified before any durable journal write', () => {
  const jobs = jobBlocks();
  const gate = jobs.find(job => job.name === 'source-pin-verification');
  assert.ok(gate, 'an explicit source pin gate job is required');
  assert.match(gate.body, /node scripts\/wolf-factory-source-pin\.mjs verify/);
  const admission = jobs.find(job => job.name === 'night-shift-admission');
  assert.match(admission.body, /needs:.*source-pin-verification/, 'journal reservation must depend on the gate');
  const verifyStep = gate.body.indexOf('wolf-factory-source-pin.mjs verify');
  assert.ok(verifyStep > 0);
});

test('publication admission uses the shared guard instead of ad-hoc stderr matching', () => {
  assert.match(workflow, /node preflight-guard\/scripts\/wolf-factory-source-pin\.mjs admit-publication/);
  assert.doesNotMatch(workflow, /CONCURRENT_BRANCH_ADVANCED':p\.status/, 'the misclassifying inline classifier must be gone');
  assert.match(workflow, /preflight-guard-remove|rm -rf preflight-guard/);
});

test('the test gate runs against the revision that is executing', () => {
  const security = jobBlocks().find(job => job.name === 'security-tests');
  assert.ok(security);
  assert.doesNotMatch(security.body, /f13d1a3e0a2abb93890a0e36746f4eefb9c94f82/, 'tests must not run against a historical public revision');
  assert.match(security.body, /ref: \$\{\{ github\.sha \}\}/);
});

test('the preflight can never force-push, merge or auto-resolve divergence', () => {
  assert.doesNotMatch(workflow, /git push[^\n]*--force/);
  assert.doesNotMatch(workflow, /git push[^\n]*\s\+\d/);
  assert.doesNotMatch(workflow, /git (merge|pull|rebase)\b/);
  assert.doesNotMatch(workflow, /--force-with-lease/);
});
