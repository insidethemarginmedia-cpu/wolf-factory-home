import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const workflowPath = path.join(root, '.github', 'workflows', 'private-ci-bridge.yml');
const source = fs.readFileSync(workflowPath, 'utf8');
const lines = source.split('\n');

// A shell variable can only be populated by a `NAME:` mapping key in the job or
// step environment. Rather than parsing the whole document, collect every
// mapping key declared anywhere inside the job block and compare it with the
// variables the job's shell snippets reference. This catches the real defect
// class: a step referencing a variable nobody declared.
// Workflow-level `env:` is inherited by every job, so a variable declared
// there counts as declared.
export function workflowLevelKeys(text) {
  const keys = new Set();
  const lines = text.split('\n');
  let inEnv = false;
  for (const line of lines) {
    if (/^env:\s*$/.test(line)) { inEnv = true; continue; }
    if (inEnv) {
      const match = line.match(/^ {2}([A-Za-z_][A-Za-z0-9_]*):/);
      if (match) { keys.add(match[1]); continue; }
      if (line.trim() !== '' && !line.startsWith(' ')) { inEnv = false; }
      else if (/^ {2}[A-Za-z0-9_-]+:/.test(line) && !/^ {2}[A-Z_]+:/.test(line)) { inEnv = false; }
    }
  }
  return keys;
}

export function jobBlock(name) {
  const start = lines.findIndex(line => line === `  ${name}:`);
  assert.notEqual(start, -1, `job ${name} must exist`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[index]) || /^[a-z]/.test(lines[index])) { end = index; break; }
  }
  return lines.slice(start, end).join('\n');
}

export function declaredKeys(block) {
  const keys = new Set();
  for (const line of block.split('\n')) {
    const match = line.match(/^\s+(?:- )?([A-Za-z_][A-Za-z0-9_]*):(?!:)/);
    if (match) keys.add(match[1]);
  }
  return keys;
}

export function referencedVariables(block) {
  const names = new Set();
  for (const match of block.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\b/g)) names.add(match[1]);
  return names;
}

// Shell locals are assigned inside the snippets (`for path in ...`,
// `key_file="$RUNNER_TEMP/..."`) instead of being declared as environment keys.
export function assignedInShell(block) {
  const names = new Set();
  for (const match of block.matchAll(/(?:^|[;&|(]\s*|\n\s*)([A-Za-z_][A-Za-z0-9_]*)=(?!=)/g)) names.add(match[1]);
  for (const match of block.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/g)) names.add(match[1]);
  return names;
}

// Variables provided by the runner itself or by GitHub, not declared here.
const PROVIDED = new Set([
  'RUNNER_TEMP', 'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_TOOL_CACHE', 'HOME', 'PATH', 'PWD',
  'GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY', 'GITHUB_WORKSPACE', 'GITHUB_SHA',
  'GITHUB_REPOSITORY', 'GITHUB_TOKEN', 'GITHUB_REF', 'GITHUB_PATH', 'BASH_SOURCE', 'SECONDS', 'RANDOM',
  // Optional runtime configuration: expanded with ${VAR:-default}, so it is
  // deliberately absent from the workflow environment.
  'PIP_INDEX_URL',
]);

test('the job block reader returns the requested job only', () => {
  const block = jobBlock('execute');
  assert.match(block, /^ {2}execute:/);
  assert.doesNotMatch(block, /^ {2}(probe|inventory):/m, 'the block must stop at the next job');
  assert.ok(declaredKeys(block).has('WOLF_CI_PRIVATE_ROOT'));
});

test('every shell variable the execute job uses is declared in that job', () => {
  const block = jobBlock('execute');
  const declared = new Set([...declaredKeys(block), ...workflowLevelKeys(source)]);
  const assigned = assignedInShell(block);
  const missing = [...referencedVariables(block)]
    .filter(name => !declared.has(name) && !assigned.has(name) && !PROVIDED.has(name))
    .sort();
  assert.deepEqual(missing, [], `execute job references undeclared variables: ${missing.join(', ')}`);
});

test('the referenced-variable scanner sees real private-source and receipt paths', () => {
  const found = referencedVariables(jobBlock('execute'));
  assert.ok(found.has('WOLF_CI_RECEIPT'), 'the private receipt path must be detected');
  assert.ok(found.has('WOLF_CI_PRIVATE_ROOT'));
});

test('workflow-level env is recognised as a declaration', () => {
  const keys = workflowLevelKeys(['env:', '  WOLF_CI_JOURNAL: .wolf-ci/journal.json', '  WOLF_CI_INBOX: .wolf-ci/inbox', 'concurrency:', '  group: x'].join('\n'));
  assert.ok(keys.has('WOLF_CI_JOURNAL'));
  assert.ok(keys.has('WOLF_CI_INBOX'));
  assert.equal(keys.has('group'), false, 'keys outside the env block must not be collected');
});

test('the guard rejects the exact defect it was written for', () => {
  // Reproduce the shipped bug: the private-publish step wrote to
  // $WOLF_CI_PRIVATE_PUBLICATION_FILE while only the later step declared it.
  const broken = [
    '  execute:',
    '    env:',
    '      WOLF_CI_PRIVATE_ROOT: /tmp/wolf-private',
    '    steps:',
    '      - name: Publish',
    '        env:',
    '          WOLF_CI_DEPLOY_KEY: x',
    '        run: |',
    '          node scripts/p.mjs > "$WOLF_CI_PRIVATE_PUBLICATION_FILE"',
  ].join('\n');
  const declared = declaredKeys(broken);
  const assigned = assignedInShell(broken);
  const missing = [...referencedVariables(broken)].filter(name => !declared.has(name) && !assigned.has(name) && !PROVIDED.has(name));
  assert.deepEqual(missing, ['WOLF_CI_PRIVATE_PUBLICATION_FILE']);
});
