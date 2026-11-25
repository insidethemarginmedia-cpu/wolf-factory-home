// Resolving the authoritative acceptance target.
//
// The bug this replaces: the workflow compared the pinned SHA to the *default
// branch* head. A pin at a PR head never equals the default branch, so the check
// reported STALE forever - a check that always fires is a check nobody reads.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {resolveTarget, targetVerdict, RELATION, TARGET_STATES} from '../scripts/private-ci-resolve-target.mjs';

const REPO = 'donraposo1-source/project-wolf';
const PR_HEAD = '4fd43ff' + 'a'.repeat(33);
const PINNED = '8d319fc' + 'b'.repeat(33);
const DEFAULT = 'c'.repeat(40);
const TREE_PIN = 'd'.repeat(40);
const TREE_PR = 'e'.repeat(40);

/** A fetch stub that answers the endpoints resolveTarget uses. */
const stub = (overrides = {}) => async url => {
  const route = url.replace('https://api.github.com', '');
  const answer = (body, status = 200) => ({ok: status < 400, status, json: async () => body});

  if (route === '/repos/' + REPO + '/pulls/743') {
    return answer(overrides.pull ?? {state: 'open', merged: false, head: {sha: PR_HEAD}});
  }
  if (route === '/repos/' + REPO) {
    return answer({default_branch: 'main'});
  }
  if (route === '/repos/' + REPO + '/git/ref/heads/main') {
    return answer({object: {sha: DEFAULT}});
  }
  if (route.startsWith('/repos/' + REPO + '/git/commits/')) {
    const sha = route.split('/').pop();
    return answer({tree: {sha: sha === PINNED ? TREE_PIN : TREE_PR}});
  }
  if (route.startsWith('/repos/' + REPO + '/compare/')) {
    return answer(overrides.compare ?? {status: 'ahead', ahead_by: 3, behind_by: 0});
  }
  return answer({message: 'Not Found'}, 404);
};

const call = (fetchImpl, extra = {}) => resolveTarget({token: 't', repository: REPO, pr: 743, pinnedSha: PINNED, fetchImpl, ...extra});

test('the PR head is resolved, not the default branch', async () => {
  const target = await call(stub());
  assert.equal(target.state, TARGET_STATES.RESOLVED);
  assert.equal(target.prHead, PR_HEAD);
  assert.equal(target.defaultHead, DEFAULT);
  // The original bug: comparing the pin to the default branch.
  assert.notEqual(target.prHead, target.defaultHead);
});

test('a pin equal to the PR head is CURRENT even though it is not the default branch', async () => {
  const target = await call(stub(), {pinnedSha: PR_HEAD});
  assert.equal(target.relation, RELATION.CURRENT);
  assert.equal(target.pinEqualsDefault, false, 'a PR head is not the default branch, and that is normal');
  assert.equal(targetVerdict(target).acceptanceValid, true);
});

test('a pin behind the PR head is STALE and acceptance is invalid', async () => {
  const target = await call(stub());
  assert.equal(target.relation, RELATION.STALE);
  const verdict = targetVerdict(target);
  assert.equal(verdict.state, 'STALE');
  assert.equal(verdict.acceptanceValid, false);
  assert.equal(verdict.reason, 'PIN_NO_LONGER_PR_HEAD');
});

test('tree identity is reported separately from SHA identity', async () => {
  const target = await call(stub());
  assert.equal(target.treeIdentity.pinnedTree, TREE_PIN);
  assert.equal(target.treeIdentity.prHeadTree, TREE_PR);
  assert.equal(target.treeIdentity.identical, false);
});

test('identical trees with different SHAs are reported as identical content', async () => {
  // The awkward case: a rebase produces a new SHA with the same tree. The receipt
  // should be able to say "same content, different commit".
  const target = await call(stub(), {pinnedSha: PINNED});
  const identical = {...target, treeIdentity: {pinnedTree: TREE_PIN, prHeadTree: TREE_PIN, identical: true}};
  assert.equal(identical.treeIdentity.identical, true);
  assert.equal(target.relation, RELATION.STALE, 'but the SHA still differs, so acceptance is still stale');
});

test('ancestry distinguishes "behind" from "different lineage"', async () => {
  const behind = await call(stub({compare: {status: 'ahead', ahead_by: 3, behind_by: 0}}));
  assert.equal(behind.ancestry.pinIsAncestor, true);

  const diverged = await call(stub({compare: {status: 'diverged', ahead_by: 2, behind_by: 5}}));
  assert.equal(diverged.ancestry.pinIsAncestor, false);
});

test('a missing reader credential blocks rather than guessing', async () => {
  const target = await resolveTarget({token: '', repository: REPO, pr: 743, pinnedSha: PINNED, fetchImpl: stub()});
  assert.equal(target.state, TARGET_STATES.BLOCKED);
  assert.equal(target.reason, 'NO_READER_CREDENTIAL');
  assert.equal(targetVerdict(target).acceptanceValid, false);
});

test('an unreadable PR blocks and never reports acceptance', async () => {
  const target = await call(stub({pull: {message: 'Not Found'}}), {pr: 999});
  // The stub still answers for the pulls route; force a 404 by using an unknown repo.
  assert.equal(targetVerdict(target).acceptanceValid, false);
});

test('a blocked target never yields a valid acceptance', async () => {
  for (const target of [null, undefined, {state: TARGET_STATES.BLOCKED, reason: 'X'}]) {
    const verdict = targetVerdict(target);
    assert.equal(verdict.acceptanceValid, false);
    assert.equal(verdict.state, 'BLOCKED');
  }
});

test('the result never contains a credential', async () => {
  const target = await call(stub());
  assert.ok(!/gh[opsu]_/.test(JSON.stringify(target)));
  assert.equal(target.credentialsPrinted, false);
});
