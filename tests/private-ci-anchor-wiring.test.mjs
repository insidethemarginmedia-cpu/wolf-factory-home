// Runtime tests still exercise durable retirement enforcement in the selector;
// these workflow checks now prove the mission executor has no PAT fallback at all.
// Removing that credential path is stricter than hydrating an authorization ledger
// before selecting it, and avoids carrying fallback credentials into private code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';

const WORKFLOW = '.github/workflows/private-ci-bridge.yml';
const AUTH = 'scripts/private-ci-app-auth.mjs';
const CLI = 'scripts/private-ci-app-auth-cli.mjs';
const workflow = fs.readFileSync(WORKFLOW, 'utf8');
const auth = fs.readFileSync(AUTH, 'utf8');
const cli = fs.readFileSync(CLI, 'utf8');
const executeStart = workflow.indexOf('  execute:\n');
const executeTail = workflow.slice(executeStart);
const nextJob = executeTail.slice(1).search(/^  [a-z][a-z0-9_-]*:\n/m);
const execute = executeTail.slice(0, nextJob < 0 ? undefined : nextJob + 1);

test('the private-source executor has no PAT, deploy-key, or dispatcher fallback', () => {
  assert.ok(executeStart >= 0, 'execute job must exist');
  assert.doesNotMatch(execute, /WOLF_FACTORY_(?:REPO|STATUS|DEPLOY|DISPATCHER)_TOKEN|WOLF_FACTORY_DEPLOY_KEY|WOLF_CI_RETIRE_PAT/);
  assert.match(execute, /permission-contents: read/);
  assert.match(execute, /persist-credentials: false/);
});

test('the single-use source-read token is revoked before dependencies or private code run', () => {
  const mint = execute.indexOf('Mint the least-privilege read token for private source checkout');
  const checkout = execute.indexOf('Checkout the private target at the immutable SHA');
  const revoke = execute.indexOf('Revoke the private-source read token before running private code');
  const install = execute.indexOf('Install private lockfile dependencies');
  const runPrivate = execute.indexOf('Execute the six required checks');
  assert.ok(mint >= 0 && checkout > mint && revoke > checkout, 'reader token -> immutable checkout -> explicit revocation');
  assert.ok(install > revoke && runPrivate > revoke, 'no private dependency or test code runs with the token alive');
  assert.match(execute.slice(mint, checkout), /permission-contents: read/);
  assert.match(execute.slice(mint, checkout), /skip-token-revoke: true/);
  assert.match(execute.slice(revoke, install), /method: 'DELETE'/);
  assert.match(execute.slice(revoke, install), /api\.github\.com\/installation\/token/);
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
