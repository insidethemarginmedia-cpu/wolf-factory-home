import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const root = path.join(import.meta.dirname, '..');
const workflows = fs.readdirSync(path.join(root, '.github', 'workflows')).filter(name => name.endsWith('.yml'));

function localRefs() {
  const refs = [];
  for (const file of workflows) {
    const source = fs.readFileSync(path.join(root, '.github', 'workflows', file), 'utf8');
    for (const match of source.matchAll(/uses:\s*insidethemarginmedia-cpu\/wolf-factory-home\/\.github\/workflows\/([^\s@]+)@([A-Za-z0-9._-]+)/g)) {
      refs.push({file, workflow: match[1], ref: match[2]});
    }
  }
  return refs;
}

// A shallow CI checkout only contains the tip commit. Rather than skip the
// assertion there, ask the remote for the object so the same check runs both
// locally and in CI.
const fetched = new Set();
function fetchRef(ref) {
  if (fetched.has(ref)) return;
  fetched.add(ref);
  try {
    execFileSync('git', ['fetch', '--no-tags', '--depth', '1', 'origin', ref], {cwd: root, stdio: 'ignore', timeout: 120000});
  } catch {
    // Fall through: the object checks below report the real outcome.
  }
}

function commitExists(ref) {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], {cwd: root, stdio: 'ignore'});
    return true;
  } catch {
    fetchRef(ref);
    try {
      execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], {cwd: root, stdio: 'ignore'});
      return true;
    } catch {
      return false;
    }
  }
}

function workflowExistsAt(ref, workflow) {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:.github/workflows/${workflow}`], {cwd: root, stdio: 'ignore'});
    return true;
  } catch {
    fetchRef(ref);
    try {
      execFileSync('git', ['cat-file', '-e', `${ref}:.github/workflows/${workflow}`], {cwd: root, stdio: 'ignore'});
      return true;
    } catch {
      return false;
    }
  }
}

test('every reusable-workflow pin resolves to a real commit', () => {
  const refs = localRefs();
  assert.ok(refs.length >= 1, 'expected at least one reusable workflow reference');
  for (const entry of refs) {
    assert.equal(commitExists(entry.ref), true, `${entry.file} pins ${entry.ref}, which does not exist`);
  }
});

test('every reusable-workflow pin points at a tree that actually contains the workflow', () => {
  for (const entry of localRefs()) {
    assert.equal(
      workflowExistsAt(entry.ref, entry.workflow),
      true,
      `${entry.file} pins ${entry.ref}, which does not contain .github/workflows/${entry.workflow}`,
    );
  }
});
