import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

import {
  ACTIVATION_STATUS,
  buildWizardHtml,
  secretInstructions,
  ACCOUNTS,
  WIZARD_STEPS,
} from '../scripts/private-ci-activation-wizard.mjs';

const html = buildWizardHtml();

test('the former App wizard is permanently withdrawn and requests no credential setup', () => {
  assert.equal(ACTIVATION_STATUS, 'WITHDRAWN');
  assert.deepEqual(secretInstructions(), []);
  assert.deepEqual(ACCOUNTS, []);
  assert.deepEqual(WIZARD_STEPS, []);
  assert.match(html, /BLOCKED \/ NOT AUTHORIZED/);
  assert.match(html, /does not create or install a GitHub App/);
  assert.match(html, /do not use earlier forms/i);
  assert.equal(/<form\b/i.test(html), false);
  assert.equal(/WOLF_FACTORY_[A-Z_]+/.test(html), false);
});

test('the blocked page has no setup links or dispatch instructions', () => {
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(hrefs, ['../integration-contract.md']);
  assert.equal(/github\.com\/(?:settings|apps)\//i.test(html), false);
  assert.equal(/dispatch(?:es|ing)? a mission/i.test(html), true, 'the page explicitly warns against dispatch');
  assert.match(html, /EUR_SPEND=0/);
});

test('the blocked page is complete HTML and links to the current contract', () => {
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<\/html>\s*$/);
  assert.match(html, /\.\.\/integration-contract\.md/);
});

test('the published activation assets cannot submit a form or request secret changes', () => {
  const activate = fs.readFileSync('docs/app-activation/activate.html', 'utf8');
  const formerManifest = fs.readFileSync('docs/app-activation/wolf-factory-automation.html', 'utf8');
  const steps = JSON.parse(fs.readFileSync('docs/app-activation/founder-steps.json', 'utf8'));
  for (const page of [activate, formerManifest]) {
    assert.match(page, /BLOCKED \/ NOT AUTHORIZED/);
    assert.equal(/<form\b/i.test(page), false);
    assert.equal(/github\.com\/(?:settings|apps)\//i.test(page), false);
    assert.equal(/WOLF_FACTORY_[A-Z_]+/.test(page), false);
  }
  assert.equal(steps.state, 'WITHDRAWN');
  assert.deepEqual(steps.authorizedActions, []);
  assert.deepEqual(steps.steps, []);
  assert.equal(steps.dispatchAuthorized, false);
  assert.equal(steps.appCreationAuthorized, false);
  assert.equal(steps.secretChangesAuthorized, false);
  const readme = fs.readFileSync('README.md', 'utf8');
  assert.match(readme, /Withdrawn credential and App setup guidance/);
  assert.doesNotMatch(readme, /Required Actions repository secrets/);
});

test('the wizard CLI emits only a machine-readable refusal and exits blocked', () => {
  const result = spawnSync(process.execPath, ['scripts/private-ci-activation-wizard.mjs'], {encoding: 'utf8'});
  assert.equal(result.status, 78);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.state, 'BLOCKED');
  assert.equal(report.reason, 'APP_ACTIVATION_WITHDRAWN');
  assert.deepEqual(report.authorizedActions, []);
  assert.equal(report.credentialsPrinted, false);
  assert.equal(result.stdout.includes('PRIVATE_KEY'), false);
});
