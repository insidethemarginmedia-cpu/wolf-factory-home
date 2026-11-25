# Omega P0.02 — initial revalidation and history correction

**Evidence cut:** 2026-11-25 UTC  
**Disposition:** **BLOCKED — no private-target execution or acceptance**  
**Current Arena branch:** `arena/156d9fee-wolf-factory-home` at the time of this record; no branch switch or history rewrite was performed.

This addendum preserves the original 11-finding evidence in [`docs/private-ci-omega-p0-evidence.md`](../../private-ci-omega-p0-evidence.md) and its structured checkpoint [`OMEGA-P0-VERIFICATION-20261125.json`](OMEGA-P0-VERIFICATION-20261125.json). The original report remains a point-in-time record; this addendum records new read-only checks and corrects an earlier history inference.

## Private target revalidation

The user supplied Kai's report that private PR #743 is OPEN, targets `main`, and has HEAD `a866a4d62baf7b834283d11f5868b3d288729f18`. From the current `gh` identity (`donraposo1-source`), these read-only requests returned HTTP 404:

- `GET /repos/donraposo1-source/project-wolf/pulls/743`
- `GET /repos/donraposo1-source/project-wolf/commits/a866a4d62baf7b834283d11f5868b3d288729f18`

Treat this as **private access unavailable / target indeterminate**, not evidence that the repository, PR, SHA, or Kai's observation is false. The claimed `a866…` SHA is **not independently validated** and was not used for checkout, dispatch, or execution. It is distinct from the older Home receipt's pinned private SHA `8d319fc50be4e4d225e3bb80de963583899c25ec`, the prior Home run controller SHA `6a7f982e29fee2775fd92be7e725805df5d973bd`, and current session base `0e7c519a16fea7eb37c929885720cac87d9ffd3b`.

GitHub App metadata lookup by slug returned App ID `5913418`, slug `wolf-factory-automation`, owner `insidethemarginmedia-cpu`. This verifies public App metadata only; it does **not** establish an installation on `project-wolf`, permission grants, or usable App credentials in this session. The GitHub connector lookup returned `unsupported`; the existing `gh` CLI was used without printing credential values.

## Corrected Home history relation — no rewrite

An earlier local note and the inherited commit subject describe `main` as an orphan/unrelated root. That conclusion is **superseded**:

- This checkout is shallow: `git rev-parse --is-shallow-repository` returned `true`; `.git/shallow` lists `0e7c519a16fea7eb37c929885720cac87d9ffd3b`, `20f1872da5f8e32cb4b5285fb28e591a8652a586`, and `3742bcc76ee2a5a8ff09897dda6611d50a4ef053` as shallow boundaries. Local commit records consequently show no parents, and local `git merge-base` returned no result.
- The read-only GitHub Compare API for `main...arena/38f3a7f7-wolf-factory-home` returned `status=diverged`, `ahead_by=251`, `behind_by=2`, and **merge base `da2ae9b4cef830e0d441f5e0b4b2fdab16196bdd`**.
- PR #2 remains OPEN from `arena/38f3a7f7-wolf-factory-home` at `0e7c519a16fea7eb37c929885720cac87d9ffd3b` to `feat/public-runtime-probe-20261022` at `20f1872da5f8e32cb4b5285fb28e591a8652a586`.

The prior “no merge base / single orphan commit” result was a shallow-checkout artifact, not the remote graph. The branches have shared history and have diverged. This does not by itself validate a merge or change the separate default-branch workflow/permission facts. **No reset, rebase, cherry-pick, amend, force push, or default-branch change was made.** Preserve the old commit subject as historical metadata; correct current documentation in a new commit.

## Skills and execution gate

No repository-local `SKILL.md`, `AGENTS.md`, skill directory, or loader was found in this Home checkout; **0/7** skills are independently loaded or validated now. The 2026-11-04 Composio checkpoint is historical evidence only. No new App, PAT, key, or paid fallback was created or requested.

No target workflow was dispatched and no private code was executed during this revalidation. Because the private PR, current head, PR base, and target Actions/check APIs could not be read, the current authorized target SHA remains **null** and all live exact-SHA acceptance remains **BLOCKED**. No inference is drawn from HTTP 204 on the unrelated prior `actionlint.yml` dispatch.
