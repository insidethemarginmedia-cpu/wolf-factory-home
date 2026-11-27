# Activation Package — Historical Mission Listener Snapshot

**Superseded and NOT activation-ready as of 2026-11-24.** This package records an
earlier P144 design. Its patch, pins, line/test counts, and copy/paste instructions
do not match the current implementation. The listener is only in the engineering
PR worktree. A read-only GitHub API check confirmed that `main` (the default
branch) has neither the listener nor the bridge workflow. At the time this
historical snapshot was prepared, its worktree pin
`9679aa76397c7b248c3708be2c063e75a7058ae5` did not resolve. The current public
candidate now uses the history-backed `b3f397fd959f41c1a843e917b35e0a5914f53c11`
pin, but this old package remains superseded and must not be applied. Activation
and dispatch are still unauthorized.

Historical preparation reference: `arena/38f3a7f7-wolf-factory-home` @ `0225e82`.

---

## 1. Why this exists

A cross-repository mission cannot start the listener from this PR branch:
GitHub starts `repository_dispatch` workflows from the repository's default
branch, and `main` does not carry either workflow. A read-only API check on
2026-11-24 returned 404 for both workflow paths on `main`. The POST/403/PATCH
results below are historical and were not repeated in this review:

```
POST …/dispatches                                    -> 2xx, zero runs created
GET  …/contents/…/private-ci-bridge.yml?ref=main     -> 404
repository_dispatch listeners on main                -> none
POST …/actions/workflows/<id>/dispatches (any ref)   -> 403
PATCH …/repos/… -f default_branch=…                  -> 403
```

Earlier revisions of this work claimed `main` was an orphan root. **That was
wrong** — the sandbox clone was shallow. `merge-base` is `da2ae9b`, `main` is 2
commits ahead and 259 behind. An ordinary merge exists; it is simply not what this
package recommends, for the security reason in §4.

## 2. What the package changes

Exactly four files, 682 lines, no modification of anything already on `main`:

| File | Purpose |
| --- | --- |
| `.github/workflows/mission-listener.yml` | The listener. Admit or refuse, then hand off. |
| `scripts/private-ci-listener.mjs` | Admission policy: sender auth, executor pinning, replay, volume. |
| `scripts/private-ci-listener-cli.mjs` | The `admit` command surface the workflow calls. |
| `scripts/private-ci-mission.mjs` | The strict mission contract, reused rather than reimplemented. |

`docs/activation/mission-listener.patch` and its digests are preserved as a
historical artifact only. Its old apply-cleanly result does not apply to the
current implementation and is not authorization to apply it.

## 3. Security evidence

### 3.1 What the listener cannot do

- It holds **no** GitHub App private key, no PAT, no deploy key (`credentialsRequired: false`).
- It never checks out private source.
- It cannot publish a check, a receipt or a status.
- Its privileged job is a job-level `uses:` with **no `runs-on` and no `steps`**, so it is structurally incapable of running shell.

### 3.2 Why credential-free is not the guarantee

Removing credentials removes what an attacker gains from *reaching* the listener.
It says nothing about what the listener *admits*. So admission is an explicit allow
decision with positive evidence, and every refusal is recorded with a reason:

| Control | Behaviour | Tests |
| --- | --- | --- |
| Sender authorisation | Read from the authenticated event envelope, never the payload. An **empty allowlist refuses everything** rather than admitting everything. | 3 |
| Executor pinning | Must be 40 hex **and** on the approved list. The event cannot override the workflow pin; a disagreement is a refusal. | 3 |
| Event type | Only `wolf-private-ci`. | 1 |
| Replay | Delivery id and `missionId@sha` both checked. | 4 |
| Volume | 12 admissions per sender per rolling hour. | 2 |
| Mission contract | Strict schema reused from the bridge; workflow/ref/token/paid rejected. | 6 |
| Second gate | Privileged job re-verifies the admission and refuses a tampered output. | 4 |

Historical snapshot only: the original package reported **23 adversarial tests**
plus **11 CLI entry-point tests** and **382 passing, 0 failing** at that time.
These counts do not describe the current worktree or its regression suite.

### 3.3 The delivery-identity defect found while testing

`repository_dispatch` carries no `after` field and the `X-GitHub-Delivery` header
is not exposed to workflows. The first draft therefore had a null delivery id and
**would have refused every mission**. Identity now derives from the run id, which
GitHub assigns and the caller cannot influence; mission-level replay is covered
separately by `missionId@sha`, so a caller reusing a delivery id still cannot
re-execute the same work.

This is the kind of defect that only appears when the contract is executed rather
than reviewed.

## 4. Why this, and not adopting the branch as default

Adopting this history as the default branch would work, and is one settings
change. It is not recommended because it puts the **private-source checkout path**
on the default branch, where every future change to `main` interacts with it.

This package inverts that: the default branch gets the component with no
credentials and no source access, and the privileged pipeline stays behind an
immutable SHA pin. The blast radius of a compromised listener is one dispatch that
the mission schema then validates.

The honest cost: the executor's code lives on a non-default branch, so the pin can
go stale. That is why the bridge reports `PRIVATE_HEAD_RELATION` as `CURRENT` or
`STALE`, and why the pin is an immutable SHA rather than a ref — a stale pin is
visible, not silent.

## 5. Dependency contract

| Dependency | Version | Why |
| --- | --- | --- |
| `actions/checkout` | `11d5960a…` (pinned) | Reads the admission logic at the pinned executor. `persist-credentials: false`. |
| Historical executor workflow | `private-ci-bridge.yml@96cab355878d6ca37dcd6d40ab79b7ac595d1c22` | Superseded snapshot; predates `workflow_call` and must not be used. |
| Node | runner default (22) | The CLI is dependency-free ESM. |

No new secret, App, PAT or billing configuration is introduced by this package.

## 6. Rollback

Delete `.github/workflows/mission-listener.yml`. The other three files are inert
without it — nothing invokes them. `main`'s existing workflows are untouched by
this package, so rollback restores the exact prior state.

If the listener has already admitted a mission, deleting the file stops all
future admissions; an in-flight reusable-workflow call completes or is cancelled
with its own run, and its receipt remains bound to that run's SHA.

## 7. What is still required before activation

1. **Founder approval** to put this on `main` (explicitly withheld by design).
2. **Independent security acceptance.** Wolf Independent Verification's findings
   are not yet published — branch prefix `arena/156d9fee-wolf-factor*` does not
   exist on the remote (checked across all remote heads). Its 11 findings are
   **not** claimed closed here, and this package has not been reviewed by it.
3. **Correlated executor run.** HTTP 204 is not acceptance; the handoff must be
   observed producing a run id and a terminal receipt. This cannot be shown for
   the listener until it exists on the default branch.

## 8. Economics

`EUR_SPEND=0`. No paid endpoint, no billing change, no artefact upload, no
`COST_UNKNOWN` path. Runner minutes are GitHub-hosted standard runners already in
use by this repository.
