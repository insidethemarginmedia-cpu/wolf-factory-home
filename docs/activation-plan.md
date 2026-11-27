# Activation Plan and Rollback — Mission Transport

Status as of 2026-11-24: **BLOCKED / NOT ACTIVATED.** This is a historical
planning record, not a dispatch runbook. The original Option B shell sketch below
was incomplete and is withdrawn; do not copy it. The current hardened listener is
`.github/workflows/mission-listener.yml` on the authorized PR branch only. No
`main` change, permission change, mission, or spend occurred in this session.

---

## 1. The problem, stated exactly

A `repository_dispatch` mission cannot start the bridge because GitHub starts
`repository_dispatch` workflows **only from the default branch**, and `main` does
not carry `.github/workflows/private-ci-bridge.yml`.

The dispatch/write probe values below are archival claims from an earlier
checkpoint; they were not repeated in this review. A read-only GitHub API check
on 2026-11-24 confirmed `main` is still the default branch and returned 404 for
both `.github/workflows/mission-listener.yml` and
`.github/workflows/private-ci-bridge.yml` on `main`. No dispatch, write, or
permission-change request was made.

| Probe | Result |
| --- | --- |
| `POST …/dispatches -f event_type=wolf-private-ci` | 2xx, **zero runs created** |
| `GET …/contents/.github/workflows/private-ci-bridge.yml?ref=main` | 404 |
| `repository_dispatch` listeners on `main` | none |
| `POST …/actions/workflows/429186774/dispatches -f ref=<branch>` | 403 |
| `PATCH …/repos/… -f default_branch=…` | 403 |
| `git merge-base origin/main HEAD` | `da2ae9b` — **an ordinary merge is possible** |

Two earlier conclusions are retracted and should not be relied on: that `main` is
an orphan root (it is not — the sandbox clone was shallow), and that merging PR #2
lands the trigger (it does not — PR #2 targets
`feat/public-runtime-probe-20261022`).

## 2. Option A — adopt this history as the default branch

**What changes:** the repository default branch moves to a branch that already
contains the bridge. One settings change.

- **Security:** the bridge, its scripts and its permissions become the default
  branch content. This is the same code already running green on this branch, but
  on the default branch it is reachable by `repository_dispatch`, which is the
  point. `main`'s two inert Ollama/night-shift registration files are *not*
  carried over, so their inertness is preserved by absence.
- **Dependencies:** the whole 251-commit history moves with it, including any
  unrelated content. That is the cost of this option.
- **Compatibility:** every workflow that pins `@main` or a SHA on `main`
  (`night-shift-wakeup.yml` pins `private-controller-preflight.yml@c6ddef9…` and
  `@20f1872…`) must be re-checked after the switch.
- **Rollback:** one setting change back to `main`. No history is rewritten and no
  branch is deleted, so rollback is exact.
- **Continuity:** `main`'s two commits (`75ed208`, `3742bcc`) remain reachable on
  `main`; nothing is lost.

**Risk:** broad. It changes the default branch for *every* consumer of this
repository to fix one trigger.

## 3. Option B — hardened listener handoff (implemented on the PR branch only)

The current PR worktree contains `.github/workflows/mission-listener.yml`, which
is designed to derive the sender from GitHub rather than the payload, derive
delivery identity from the run id, and persist admitted missions to a hash-chained
ledger plus anchor before handoff. The bridge has a second exact-identity gate
before private checkout or credential mint and the listener maps only named
workflow secrets. These are implementation claims supported by local tests, not
live admission evidence.

The former listener SHA `9679aa76397c7b248c3708be2c063e75a7058ae5` did not
resolve. It has been replaced for this public candidate with the existing-history
commit `b3f397fd959f41c1a843e917b35e0a5914f53c11`, whose tree contains the exact
`workflow_call` inputs and durable gates. The repository-local SHA/interface
defect is now fixed for review; this does not approve activation or dispatch.
Authoritative Factory/Build Wolf/Compute contracts, recovery ownership and
required approvals remain unresolved.

This is **not activated**: the file remains on this engineering PR branch, no
listener run was observed, and no default-branch change was authorized. The older
copy/paste `forward` job was withdrawn because it did not establish authenticated
sender admission, durable replay protection, or correlation. Do not restore it.

The hardened listener ledger is admission/replay evidence, not an execution
queue. Home currently has no durable lease/fence/settlement recovery job; the
cron and local-only journal path were removed rather than advertised as working.
No second queue or scheduler should be added. Reconcile with the existing
Factory/Compute owner before enabling recovery.

**Risk:** still requires Founder approval, exact sender allowlist, the verified
reusable-workflow pin, upstream contract reconciliation, and independent
security acceptance.

## 4. Recommendation

The minimal, hardened listener remains the preferred *design*, but it must not
be activated until the P1.59 / P1.47+ authenticated-envelope and callback
contracts are reconciled, the exact executor pin is verified, durable recovery
semantics are present in the existing control plane, and independent review
accepts the security boundary. No schedule or mission is authorized by this plan.

## 5. Prerequisites before either option

Not yet satisfied; both must close first.

1. **Independent verification findings.** Wolf Independent Verification is
   reported to hold 11 critical findings. **No branch, PR, report or checkpoint
   from it exists in this repository** (checked: open PRs #1 and #2 only; no
   `independent-verification` ref among all remote heads). Closure cannot be
   claimed and has not been claimed. Activation should not proceed until those
   findings are reviewed.
2. **Authenticated contract reconciliation.** The authoritative Factory P1.59
   and Factory 2 P1.47+ envelope, nonce, callback signature, lease/fence,
   idempotency, and receipt definitions are not present here; compatibility is
   unverified.
3. **Durable recovery and correlation.** The local JSON journal does not survive
   a new GitHub-hosted runner. A production queue/recovery/settlement path and
   run-to-callback correlation must be proved through the existing Home/Compute
   control plane; no cron is enabled.
4. **Real worker acceptance.** A deterministic public canary is not a worker
   result. Require exact-SHA worker output, authenticated callback, zero-cost
   evidence and an independent verifier.

## 6. What has not been done, deliberately

- No default-branch change (403 for automation, and a founder decision regardless).
- No merge to `main`.
- No force push, no history rewrite.
- No mission dispatch or mission simulation.
- No claim that the 11 findings are closed.
- No cron/recovery claim; the scheduled path is absent until durable state exists.

`EUR_SPEND=0`. `COST_UNKNOWN=DENY`. `PAID_FALLBACK=DENY`. `TRIAL_CREDIT=DENY`.
