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
  const response = await fetchImpl(API + path, {headers: headersFor(token)});
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

  const pull = await get(`/repos/${repository}/pulls/${pr}`, token, fetchImpl);
  if (!pull.ok) {
    return {...base, state: TARGET_STATES.BLOCKED, reason: 'PR_UNREADABLE', httpStatus: pull.httpStatus};
  }
  const prHead = typeof pull.body?.head?.sha === 'string' ? pull.body.head.sha : null;
  if (!/^[0-9a-f]{40}$/.test(String(prHead ?? ''))) {
    return {...base, state: TARGET_STATES.BLOCKED, reason: 'PR_HEAD_UNRESOLVED'};
  }
  const prState = pull.body?.state ?? null;
  const prMerged = pull.body?.merged === true;

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
    return {state: 'BLOCKED', acceptanceValid: false, reason: target?.reason ?? 'TARGET_UNRESOLVED'};
  }
  const current = target.relation === RELATION.CURRENT;
  return {
    state: current ? 'CURRENT' : 'STALE',
    acceptanceValid: current,
    reason: current ? null : 'PIN_NO_LONGER_PR_HEAD',
    prHead: target.prHead,
    pinnedSha: target.pinnedSha,
    treeIdentical: target.treeIdentity?.identical === true,
  };
}
