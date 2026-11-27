import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {classifySyncState, resolveRepositoryPath, validateManifest} from '../scripts/engineering-workspace.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'docs/engineering-workspace.json'), 'utf8'));

test('the checked-in workspace inventory contains exact, valid recovery anchors', () => {
  assert.equal(validateManifest(manifest), manifest);
  assert.equal(manifest.repositories.find(entry => entry.id === 'wolf-compute').recoverySha, 'f00dd8860edd245e53a11feee24270bc553ded2b');
  assert.equal(manifest.repositories.find(entry => entry.id === 'project-wolf').availability, 'blocked-unverified-access');
  assert.equal(manifest.unresolvedTargets.find(entry => entry.id === 'build-wolf-pr-749').pullRequest, 749);
});

test('invalid repository identities, URLs, branches, and recovery SHAs fail closed', () => {
  const cases = [
    value => { value.repositories[0].repository = 'somewhere-else/repo'; },
    value => { value.repositories[0].url = 'https://example.com/repo.git'; },
    value => { value.repositories[0].branch = '../main'; },
    value => { value.repositories[0].recoverySha = 'latest'; },
  ];
  for (const mutate of cases) {
    const invalid = structuredClone(manifest);
    mutate(invalid);
    assert.throws(() => validateManifest(invalid));
  }
});

test('workspace clone destinations cannot escape the persistent workspace root', () => {
  assert.equal(resolveRepositoryPath('/repo', '.engineering-workspace/repos', 'wolf-compute'), '/repo/.engineering-workspace/repos/wolf-compute');
  for (const badPath of ['../outside', 'nested/../../outside', '/tmp/other']) {
    assert.throws(() => resolveRepositoryPath('/repo', '.engineering-workspace/repos', badPath), /WORKSPACE_REPOSITORY_PATH_INVALID/);
  }
  assert.throws(() => resolveRepositoryPath('/repo', '../../outside', 'wolf-compute'), /WORKSPACE_PATH_INVALID/);
});

test('sync classification refuses dirty, wrong-branch, ahead, and diverged worktrees', () => {
  const common = {expectedBranch: 'main', localSha: 'a'.repeat(40), remoteSha: 'b'.repeat(40), localIsAncestor: true, remoteIsAncestor: false};
  assert.equal(classifySyncState({...common, dirty: true, currentBranch: 'main'}), 'DIRTY_NOT_MERGED');
  assert.equal(classifySyncState({...common, dirty: false, currentBranch: 'feature'}), 'WRONG_BRANCH');
  assert.equal(classifySyncState({...common, dirty: false, currentBranch: 'main'}), 'FAST_FORWARD_REQUIRED');
  assert.equal(classifySyncState({...common, dirty: false, currentBranch: 'main', localSha: 'b'.repeat(40), remoteSha: 'a'.repeat(40), localIsAncestor: false, remoteIsAncestor: true}), 'LOCAL_AHEAD');
  assert.equal(classifySyncState({...common, dirty: false, currentBranch: 'main', localIsAncestor: false, remoteIsAncestor: false}), 'DIVERGED');
  assert.equal(classifySyncState({...common, dirty: false, currentBranch: 'main', localSha: 'b'.repeat(40), remoteSha: 'b'.repeat(40), localIsAncestor: true, remoteIsAncestor: true}), 'UP_TO_DATE');
});
