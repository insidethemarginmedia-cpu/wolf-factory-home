// Keep every controller component and its regression test on a workflow path
// filter. An omitted path lets a breaking change merge without running its tests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const workflowPath = '.github/workflows/private-ci-bridge.yml';
const workflow = fs.readFileSync(path.join(root, workflowPath), 'utf8');

function pathPatterns(trigger) {
  const onStart = workflow.indexOf('\non:');
  const permissionsAt = workflow.indexOf('\npermissions:', onStart);
  assert.notEqual(onStart, -1, 'workflow must declare triggers');
  assert.notEqual(permissionsAt, -1, 'trigger block must end before permissions');
  const lines = workflow.slice(onStart, permissionsAt).split(/\r?\n/);
  const start = lines.findIndex(line => line === `  ${trigger}:`);
  assert.notEqual(start, -1, `${trigger} trigger must exist`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index])) { end = index; break; }
  }
  const block = lines.slice(start, end);
  const pathsAt = block.findIndex(line => line === '    paths:');
  assert.notEqual(pathsAt, -1, `${trigger} trigger must declare a paths filter`);
  const patterns = [];
  for (const line of block.slice(pathsAt + 1)) {
    if (!line.trim()) continue;
    const match = line.match(/^      - '([^']+)'\s*$/);
    if (!match) break;
    patterns.push(match[1]);
  }
  assert.ok(patterns.length, `${trigger} paths filter must list at least one file`);
  return patterns;
}

function globRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function covers(patterns, file) {
  return patterns.some(pattern => globRegex(pattern).test(file));
}

function walk(directory, result = []) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, result);
    else result.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return result;
}

test('the bridge workflow triggers when its own definition changes', () => {
  for (const trigger of ['push', 'pull_request']) {
    assert.ok(covers(pathPatterns(trigger), workflowPath), `${trigger} paths must cover ${workflowPath}`);
  }
});

test('push and pull-request path filters cover the same controller surface', () => {
  assert.deepEqual(pathPatterns('push'), pathPatterns('pull_request'));
});

test('every bridge script and matching regression test is covered by both triggers', () => {
  const relevant = walk(path.join(root, 'scripts')).concat(walk(path.join(root, 'tests')))
    .filter(file => /\.(?:mjs|test\.mjs)$/.test(file))
    .filter(file => /private-ci|workflow-env|workflow-pins|private-controller/.test(path.basename(file)));
  for (const trigger of ['push', 'pull_request']) {
    const patterns = pathPatterns(trigger);
    const missing = relevant.filter(file => !covers(patterns, file));
    assert.deepEqual(missing, [], `${trigger} path filter misses controller files: ${missing.join(', ')}`);
  }
});

test('current integration and OMEGA evidence documents trigger controller validation', () => {
  const relevantDocs = [
    'docs/private-ci-bridge-evidence.md',
    'docs/private-ci-omega-p0-evidence.md',
    'docs/private-ci-p150-verification.md',
    'docs/integration-contract.md',
    'docs/activation-plan.md',
    'docs/zero-touch-activation.md',
    'docs/checkpoints/WOLF-P140-ZERO-TOUCH-MISSION-TRANSPORT.json',
    ...walk(path.join(root, 'docs/checkpoints/private-ci-omega-p0')),
  ].filter(file => fs.existsSync(path.join(root, file)));
  for (const trigger of ['push', 'pull_request']) {
    const patterns = pathPatterns(trigger);
    const missing = relevantDocs.filter(file => !covers(patterns, file));
    assert.deepEqual(missing, [], `${trigger} path filter misses evidence docs: ${missing.join(', ')}`);
  }
});
