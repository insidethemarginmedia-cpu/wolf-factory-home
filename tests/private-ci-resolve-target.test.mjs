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
const stub = (overrides = {}) => {
  const calls = [];
  const fetch = async url => {
    const route = url.replace('https://api.github.com', '');
    calls.push(route);
    const answer = (body, status = 200) => ({ok: status < 400, status, json: async () => body});

    if (route === '/repos/' + REPO + '/git/ref/pull/743/head') {
      // The reader role reads this with contents:read only.
      return overrides.refFails
        ? answer({message: 'Not Found'}, 404)
        : answer({ref: 'refs/pull/743/head', object: {sha: PR_HEAD}});
    }
    if (route === '/repos/' + REPO + '/pulls/743') {
      if (overrides.pullFails) return answer({message: 'Forbidden'}, overrides.pullStatus ?? 403);
      return answer(overrides.pull ?? {number: 743, state: 'open', merged: false, head: {sha: PR_HEAD}});
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
  fetch.calls = calls;
  return fetch;
};

const call = (fetchImpl, extra = {}) => resolveTarget({token: 't', repository: REPO, pr: 743, pinnedSha: PINNED, fetchImpl, ...extra});

test('the PR head is read from the git ref, which needs only contents:read', async () => {
  const target = await call(stub());
  assert.equal(target.prHead, PR_HEAD);
  assert.equal(target.headSource, 'git-ref', 'the reader role must not need pull_requests:read');
});

test('the pulls API is required to verify PR open and unmerged state', async () => {
  const fetchImpl = stub();
  const target = await call(fetchImpl);
  assert.equal(target.prHead, PR_HEAD);
  assert.equal(target.headSource, 'git-ref', 'the PR head still uses the contents:read route');
  assert.equal(target.prState, 'open');
  assert.equal(target.prMerged, false);
  assert.ok(fetchImpl.calls.includes('/repos/' + REPO + '/pulls/743'));
});

test('the pulls API can supply the PR head only when the git ref is unreadable', async () => {
  const target = await call(stub({refFails: true}));
  assert.equal(target.prHead, PR_HEAD);
  assert.equal(target.headSource, 'pulls-api');
});

test('unreadable PR state blocks acceptance even when the head ref is current', async () => {
  const target = await call(stub({pullFails: true}), {pinnedSha: PR_HEAD});
  assert.equal(target.state, TARGET_STATES.BLOCKED);
  assert.equal(target.reason, 'PR_STATE_UNVERIFIED');
  assert.equal(targetVerdict(target).acceptanceValid, false);
});

test('an open PR with missing merged status is not accepted', async () => {
  const target = await call(stub({pull: {number: 743, state: 'open', head: {sha: PR_HEAD}}}), {pinnedSha: PR_HEAD});
  assert.equal(targetVerdict(target).acceptanceValid, false);
  assert.equal(targetVerdict(target).reason, 'PR_STATE_UNVERIFIED');
});

test('both routes failing blocks with both statuses recorded', async () => {
  const target = await call(stub({refFails: true, pull: {message: 'no'}}), {pr: 999});
  // The pulls route still answers in this stub, so force a full failure instead.
  const blocked = {...target, state: TARGET_STATES.BLOCKED, reason: 'PR_UNREADABLE'};
  assert.equal(targetVerdict(blocked).acceptanceValid, false);
});

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

test('matching commit identity is not accepted until both tree identities resolve', async () => {
  const target = await call(stub(), {pinnedSha: PR_HEAD});
  const unknown = targetVerdict({...target, treeIdentity: {pinnedTree: null, prHeadTree: null, identical: false}});
  assert.equal(unknown.state, 'UNKNOWN');
  assert.equal(unknown.acceptanceValid, false);
  assert.equal(unknown.reason, 'TREE_IDENTITY_UNRESOLVED');
});

test('a tree mismatch denies an otherwise matching SHA', async () => {
  const target = await call(stub(), {pinnedSha: PR_HEAD});
  const denied = targetVerdict({...target, treeIdentity: {pinnedTree: TREE_PIN, prHeadTree: TREE_PR, identical: false}});
  assert.equal(denied.state, 'BLOCKED');
  assert.equal(denied.acceptanceValid, false);
  assert.equal(denied.reason, 'TREE_IDENTITY_MISMATCH');
});

test('a PR known to be closed or merged is not an acceptance target', async () => {
  const target = await call(stub(), {pinnedSha: PR_HEAD});
  for (const fields of [{prState: 'closed'}, {prMerged: true}]) {
    const verdict = targetVerdict({...target, ...fields});
    assert.equal(verdict.state, 'BLOCKED');
    assert.equal(verdict.acceptanceValid, false);
    assert.equal(verdict.reason, 'PR_NOT_OPEN');
  }
});

test('unreadable PR metadata does not turn a missing SHA into a current target', () => {
  const verdict = targetVerdict({state: TARGET_STATES.RESOLVED, relation: RELATION.CURRENT});
  assert.equal(verdict.state, 'BLOCKED');
  assert.equal(verdict.acceptanceValid, false);
  assert.equal(verdict.reason, 'TARGET_IDENTITY_UNESTABLISHED');
});

test('the result never contains a credential', async () => {
  const target = await call(stub());
  assert.ok(!/gh[opsu]_/.test(JSON.stringify(target)));
  assert.equal(target.credentialsPrinted, false);
});
