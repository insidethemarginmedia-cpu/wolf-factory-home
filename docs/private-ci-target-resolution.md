# PR #743 Target Resolution — Live Evidence

**Status: the pinned SHA is STALE. Acceptance against it is invalid.**

Recorded 2026-11-25 from run `45635798669` (`bb99420`).

## 1. The result

```json
{
  "state": "RESOLVED",
  "relation": "STALE",
  "prHead": "4fd43ffebfb87a9fbb74b4de1ded3af9c8bb1ca2",
  "pinnedSha": "8d319fc50be4e4d225e3bb80de963583899c25ec",
  "treeIdentical": false,
  "acceptanceValid": false,
  "reason": "PIN_NO_LONGER_PR_HEAD",
  "credentialsPrinted": false
}
```

The workflow is pinned at `8d319fc`. The current PR #743 head is `4fd43ff`. They
are different commits with different trees, so every `VERIFIED` receipt produced
so far is **acceptance of a historical commit, not of the PR**. That has been true
since the pin was set and was invisible until the target was resolved.

This is reported rather than repaired internally: changing the pin would silently
convert historical receipts into claims about a commit that was never executed.

## 2. Independent corroboration

| Source | Value |
| --- | --- |
| LEGO W1.09 report | `4fd43ff` |
| Live reader-App resolution (this run) | `4fd43ffebfb87a9fbb74b4de1ded3af9c8bb1ca2` |

Two independent paths agree, and the full SHA is now on record rather than the
abbreviation.

## 3. Confirmed private

```
GET /repos/insidethemarginmedia-cpu/wolf-factory-home/commits/4fd43ff…/check-runs
-> 422 "No commit found for SHA"
```

The commit is not visible to the public API, which is the expected posture for a
commit in a private repository. No private content was fetched or published to
resolve it: the reader role read one git ref.

## 4. How it was resolved, and why that matters

Two routes to a PR head exist:

| Route | Permission | Used |
| --- | --- | --- |
| `refs/pull/{n}/head` (git ref) | `contents: read` | **first** |
| `/pulls/{n}` (REST) | `pull_requests: read` | fallback only |

The reader role holds `contents:read` and `metadata:read` **by design**. The first
live attempt used the pulls API, returned `BLOCKED / PR_UNREADABLE`, and the fix
was to read the git ref — **not** to widen the reader role. Trading a real
permission for a nicer response is the wrong direction, and least privilege is only
meaningful if keeping it costs something.

The receipt records `headSource` so which route was used is visible rather than
implied.

## 5. What this does not establish

- Whether `4fd43ff` passes the six required checks. That requires executing it,
  which changes the pin and is a founder decision.
- Whether the private check was published against `4fd43ff`. No check exists there
  from this pipeline.
- Tree identity between `8d319fc` and `4fd43ff`: `treeIdentical: false`, so they
  differ in content, not merely in commit id.

## 6. What is required next

1. A decision to move the pin to `4fd43ff` (or to keep verifying `8d319fc` as a
   historical baseline, explicitly labelled as such).
2. A run executing that commit with all six checks, publishing the private check
   against it.
3. Independent acceptance of that run.

Until all three happen, the pipeline's `VERIFIED` state means "this commit passed
the checks", not "PR #743 is accepted". The distinction is now on the receipt as
`acceptanceTarget.acceptanceValid: false`, so a reader cannot miss it.
