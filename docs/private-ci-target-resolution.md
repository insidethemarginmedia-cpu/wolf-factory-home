# PR #743 Target Resolution — Historical Record (Not Live Evidence)

**Status as of 2026-11-24: NOT REVALIDATED. This record is not a current target
resolution or mission acceptance.** The original text is dated 2026-11-25, which is
later than the review date in this worktree; that timestamp is inconsistent and
must not be treated as contemporaneous evidence. No private PR lookup or execution
was performed in this review.

The quoted values below are preserved as historical claims from the old record.

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

The old record reported a workflow pin of `8d319fc` and PR #743 head
`4fd43ff`. It stated that they differed in both commit and tree identity. These
values have not been refreshed; no statement here identifies the current PR head
or current workflow pin.

The historical note correctly warned against silently converting old receipts
into claims about a commit that was never executed. Keep that caution; do not use
the old values as a current target or acceptance result.

## 2. Historical corroboration claim (not revalidated)

| Source | Value |
| --- | --- |
| LEGO W1.09 report | `4fd43ff` |
| Live reader-App resolution (this run) | `4fd43ffebfb87a9fbb74b4de1ded3af9c8bb1ca2` |

Two independent paths agree, and the full SHA is now on record rather than the
abbreviation.

## 3. Historical visibility observation (not revalidated)

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
