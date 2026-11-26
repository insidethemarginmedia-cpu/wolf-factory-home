// Resolves the authoritative target for a private acceptance run.
//
// Two distinct questions were being conflated in the workflow:
//
//   1. What commit does PR #743 currently point at?  (the acceptance target)
//   2. What is the default branch?                    (a different question)
//
// A pin at a PR head is *correct* while the PR head has not moved, even though it
// never equals the default branch. Comparing the pin to the default branch would
// therefore report STALE forever, and a check that always fires is a check nobody
// reads. This module resolves the actual PR head, compares the pin to it, and
// reports tree identity so "same SHA" and "same content" are not confused.
//
// Everything here is read-only and names only SHAs, refs and booleans. No
// credential and no private content is returned.

const API = 'https://api.github.com';

const headersFor = token => ({
  authorization: 'Bearer ' + token,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
});

async function get(path, token, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(API + path, {
    headers: headersFor(token),
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) return {ok: false, httpStatus: response.status, body: null};
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return {ok: true, httpStatus: response.status, body};
}

export const TARGET_STATES = Object.freeze({
  RESOLVED: 'RESOLVED',
  BLOCKED: 'BLOCKED',
});

export const RELATION = Object.freeze({
  CURRENT: 'CURRENT',
  STALE: 'STALE',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Resolves PR head, default-branch head and the pinned commit's tree.
 *
 * The tree SHA is what makes "exact SHA" meaningful: two different commits can
 * carry an identical tree, and the same commit always carries the same tree. It
 * lets a receipt say which *content* was verified, not only which commit.
 */
export async function resolveTarget({
  token,
  repository,
  pr,
  pinnedSha,
  fetchImpl = globalThis.fetch,
} = {}) {
  const base = {repository, pr: String(pr ?? ''), pinnedSha: pinnedSha ?? null, credentialsPrinted: false};
  if (typeof token !== 'string' || !token.trim()) {
    return {...base, state: TARGET_STATES.BLOCKED, reason: 'NO_READER_CREDENTIAL'};
  }
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(String(repository ?? ''))) {
    return {...base, state: TARGET_STATES.BLOCKED, reason: 'REPOSITORY_INVALID'};
  }

  // The PR head ref is the narrow contents:read route. Verifying that the PR is
  // still open and unmerged is a separate acceptance requirement and needs the
  // read-only `pull_requests:read` scope. Both are queried: using only the ref
  // would accept a closed or merged PR because git refs do not expose that state.
  // This is the minimum scope expansion justified by the exact-target policy; no
  // write permission is added to the reader role.
  if (!/^[1-9][0-9]*$/.test(String(pr ?? ''))) {
    return {...base, state: TARGET_STATES.BLOCKED, reason: 'PR_NUMBER_INVALID'};
  }
  const [ref, pull] = await Promise.all([
    get(`/repos/${repository}/git/ref/pull/${pr}/head`, token, fetchImpl),
    get(`/repos/${repository}/pulls/${pr}`, token, fetchImpl),
  ]);

  if (!pull.ok) {
    return {
      ...base,
      state: TARGET_STATES.BLOCKED,
      reason: ref.ok ? 'PR_STATE_UNVERIFIED' : 'PR_UNREADABLE',
      httpStatus: pull.httpStatus,
      refHttpStatus: ref.httpStatus,
    };
  }
  const pullNumber = Number(pull.body?.number);
  const prState = typeof pull.body?.state === 'string' ? pull.body.state : null;
  const mergedKnown = typeof pull.body?.merged === 'boolean';
  const prMerged = mergedKnown ? pull.body.merged : null;
  const pullHead = pull.body?.head?.sha;
  if (pullNumber !== Number(pr) || !['open', 'closed'].includes(prState) || !mergedKnown
      || !/^[0-9a-f]{40}$/.test(String(pullHead ?? ''))) {
    return {
      ...base,
      state: TARGET_STATES.BLOCKED,
      reason: 'PR_STATE_UNVERIFIED',
      prState,
      prMerged,
      prHead: ref.body?.object?.sha ?? pullHead ?? null,
    };
  }
  const refHead = ref.ok ? ref.body?.object?.sha : null;
  if (ref.ok && !/^[0-9a-f]{40}$/.test(String(refHead ?? ''))) {
    return {...base, state: TARGET_STATES.BLOCKED, reason: 'PR_HEAD_UNRESOLVED', prState, prMerged};
  }
  if (refHead && refHead !== pullHead) {
    return {
      ...base,
      state: TARGET_STATES.BLOCKED,
      reason: 'PR_HEAD_CHANGED_DURING_RESOLUTION',
      prState,
      prMerged,
      refHead,
      pullHead,
    };
  }
  const prHead = refHead ?? pullHead;
  if (!/^[0-9a-f]{40}$/.test(String(prHead ?? ''))) {
    return {...base, state: TARGET_STATES.BLOCKED, reason: 'PR_HEAD_UNRESOLVED', prState, prMerged};
  }

  const repo = await get(`/repos/${repository}`, token, fetchImpl);
  const defaultBranch = repo.ok && typeof repo.body?.default_branch === 'string' ? repo.body.default_branch : null;
  let defaultHead = null;
  if (defaultBranch) {
    const ref = await get(`/repos/${repository}/git/ref/heads/${defaultBranch}`, token, fetchImpl);
    defaultHead = typeof ref.body?.object?.sha === 'string' ? ref.body.object.sha : null;
  }

  // Tree identity for the pin and for the PR head, so the receipt can state which
  // content was verified rather than only which commit.
  const treeOf = async sha => {
    if (!/^[0-9a-f]{40}$/.test(String(sha ?? ''))) return null;
    const commit = await get(`/repos/${repository}/git/commits/${sha}`, token, fetchImpl);
    return typeof commit.body?.tree?.sha === 'string' ? commit.body.tree.sha : null;
  };
  const pinnedTree = await treeOf(pinnedSha);
  const prHeadTree = await treeOf(prHead);

  // Is the pin an ancestor of the PR head? If so the pin is behind but real; if not
  // it is a different lineage entirely, which is a stronger statement than "stale".
  let ancestry = null;
  if (/^[0-9a-f]{40}$/.test(String(pinnedSha ?? ''))) {
    const compare = await get(`/repos/${repository}/compare/${pinnedSha}...${prHead}`, token, fetchImpl);
    if (compare.ok) {
      ancestry = {
        status: compare.body?.status ?? null,
        aheadBy: compare.body?.ahead_by ?? null,
        behindBy: compare.body?.behind_by ?? null,
        // 'ahead'/'identical' means the pin is an ancestor of the PR head.
        pinIsAncestor: compare.body?.status === 'ahead' || compare.body?.status === 'identical',
      };
    }
  }

  const relation = pinnedSha === prHead ? RELATION.CURRENT : RELATION.STALE;

  return {
    ...base,
    state: TARGET_STATES.RESOLVED,
    reason: null,
    prState,
    prMerged,
    // Which route produced the head, so the receipt states how it was read.
    headSource: ref.ok && prHead === ref.body?.object?.sha ? 'git-ref' : (pull.ok ? 'pulls-api' : 'unknown'),
    prHead,
    defaultBranch,
    defaultHead,
    relation,
    // Same commit implies same tree; this states it rather than assuming it.
    treeIdentity: {
      pinnedTree,
      prHeadTree,
      identical: pinnedTree !== null && pinnedTree === prHeadTree,
    },
    ancestry,
    // A pin equal to the default branch is only expected for a merged PR.
    pinEqualsDefault: pinnedSha !== null && pinnedSha === defaultHead,
  };
}

/**
 * The verdict a run should publish.
 *
 * `CURRENT` requires the pin to equal the PR head. Anything else is STALE and is
 * reported as such: acceptance against a commit that is no longer the PR head is
 * not acceptance of the PR, and saying so is the whole point of resolving the
 * target instead of trusting the pin.
 */
export function targetVerdict(target) {
  if (!target || target.state !== TARGET_STATES.RESOLVED) {
    const unavailable = target?.reason === 'PR_UNREADABLE' || target?.reason === 'PR_HEAD_UNRESOLVED';
    return {
      state: unavailable ? 'UNKNOWN' : 'BLOCKED',
      acceptanceValid: false,
      reason: target?.reason ?? 'TARGET_UNRESOLVED',
    };
  }

  const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
  if (!sha(target.prHead) || !sha(target.pinnedSha)) {
    return {state: 'BLOCKED', acceptanceValid: false, reason: 'TARGET_IDENTITY_UNESTABLISHED'};
  }
  if (target.pinnedSha !== target.prHead) {
    return {
      state: 'STALE',
      acceptanceValid: false,
      reason: 'PIN_NO_LONGER_PR_HEAD',
      prHead: target.prHead,
      pinnedSha: target.pinnedSha,
      treeIdentical: target.treeIdentity?.identical === true,
    };
  }
  if (target.relation !== RELATION.CURRENT) {
    return {state: 'UNKNOWN', acceptanceValid: false, reason: 'PR_HEAD_RELATION_UNVERIFIED'};
  }
  if (target.prMerged === true || target.prState === 'closed') {
    return {state: 'BLOCKED', acceptanceValid: false, reason: 'PR_NOT_OPEN'};
  }
  if (target.prState !== 'open' || target.prMerged !== false) {
    return {state: 'BLOCKED', acceptanceValid: false, reason: 'PR_STATE_UNVERIFIED'};
  }

  const pinnedTree = target.treeIdentity?.pinnedTree;
  const prHeadTree = target.treeIdentity?.prHeadTree;
  if (!sha(pinnedTree) || !sha(prHeadTree)) {
    return {
      state: 'UNKNOWN',
      acceptanceValid: false,
      reason: 'TREE_IDENTITY_UNRESOLVED',
      prHead: target.prHead,
      pinnedSha: target.pinnedSha,
      treeIdentical: false,
    };
  }
  if (pinnedTree !== prHeadTree || target.treeIdentity?.identical !== true) {
    return {
      state: 'BLOCKED',
      acceptanceValid: false,
      reason: 'TREE_IDENTITY_MISMATCH',
      prHead: target.prHead,
      pinnedSha: target.pinnedSha,
      treeIdentical: false,
    };
  }

  // No tree-equivalence exception exists in this acceptance policy. The exact
  // immutable commit must be both the resolved PR head and the tree whose tests ran.
  return {
    state: 'CURRENT',
    acceptanceValid: true,
    reason: null,
    prHead: target.prHead,
    pinnedSha: target.pinnedSha,
    treeIdentical: true,
  };
}
