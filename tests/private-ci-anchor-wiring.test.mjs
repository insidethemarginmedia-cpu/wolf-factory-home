// Anchor tests that only exercise hardenedRetirementVerdict are insufficient: a
// correct integrity function behind a workflow that never hydrates the anchor is
// still a broken system. These guard the actual CLI -> selector -> workflow path.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';

const WORKFLOW = '.github/workflows/private-ci-bridge.yml';
const AUTH = 'scripts/private-ci-app-auth.mjs';
const CLI = 'scripts/private-ci-app-auth-cli.mjs';
const workflow = fs.readFileSync(WORKFLOW, 'utf8');
const auth = fs.readFileSync(AUTH, 'utf8');
const cli = fs.readFileSync(CLI, 'utf8');
const start = workflow.indexOf('Hydrate and verify durable retirement evidence before credential selection');
const end = workflow.indexOf('- name:', start + 10);
const hydrate = workflow.slice(start, end === -1 ? start + 6000 : end);

test('hydration fetches the ledger and published anchor before any PAT selector runs', () => {
  assert.ok(start >= 0, 'hydration must run in the execute job');
  assert.match(hydrate, /retirement-ledger\.jsonl\?ref=wolf-ci-retirement/);
  assert.match(hydrate, /retirement-head\.json\?ref=wolf-ci-retirement/);
  assert.match(hydrate, /retirement-check[\s\\\S]*--ledger[\s\\\S]*--anchor[\s\\\S]*--require-anchor/);
});

test('the exact checked evidence reaches later steps via GITHUB_ENV', () => {
  assert.match(hydrate, /WOLF_CI_RETIREMENT_LEDGER_B64=/);
  assert.match(hydrate, /WOLF_CI_RETIREMENT_ANCHOR_B64=/);
  assert.match(hydrate, /WOLF_CI_RETIREMENT_REQUIRE_ANCHOR=true/);
  assert.doesNotMatch(hydrate, /continue-on-error:\s*true/);
});

test('selector decodes evidence and requires the anchor before PAT fallback', () => {
  assert.match(auth, /WOLF_CI_RETIREMENT_LEDGER_B64/);
  assert.match(auth, /WOLF_CI_RETIREMENT_ANCHOR_B64/);
  assert.match(auth, /WOLF_CI_RETIREMENT_REQUIRE_ANCHOR/);
  assert.match(auth, /hardenedRetirementVerdict\(resolvedLedgerText/);
  assert.match(auth, /requireAnchor/);
});

test('the real retirement-check CLI loads the anchor file and reports fail-closed state', () => {
  const block = cli.slice(cli.indexOf("command === 'retirement-check'"));
  assert.match(block.slice(0, 2800), /--anchor/);
  assert.match(block.slice(0, 2800), /hardenedRetirementVerdict/);
  assert.match(block.slice(0, 2800), /APP_AUTH_EXIT\.BLOCKED/);
});
