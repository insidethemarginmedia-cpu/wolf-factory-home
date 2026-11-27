import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ensureCommit, hasObjectAt} from './private-ci-git-pin-helpers.mjs';

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

test('every reusable-workflow pin resolves to a real commit', () => {
  const refs = localRefs();
  assert.ok(refs.length >= 1, 'expected at least one reusable workflow reference');
  for (const entry of refs) {
    assert.equal(ensureCommit(entry.ref), true, `${entry.file} pins ${entry.ref}, which does not exist`);
  }
});

test('every reusable-workflow pin points at a tree that actually contains the workflow', () => {
  for (const entry of localRefs()) {
    assert.equal(
      hasObjectAt(entry.ref, `.github/workflows/${entry.workflow}`),
      true,
      `${entry.file} pins ${entry.ref}, which does not contain .github/workflows/${entry.workflow}`,
    );
  }
});
