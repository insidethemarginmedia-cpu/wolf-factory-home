# Activation Plan and Rollback — Mission Transport

Status: **prepared, not executed.** Both options below are reversible and neither
has been applied. Nothing here changes the default branch; that decision is the
founder's.

---

## 1. The problem, stated exactly

A `repository_dispatch` mission cannot start the bridge because GitHub starts
`repository_dispatch` workflows **only from the default branch**, and `main` does
not carry `.github/workflows/private-ci-bridge.yml`.

Measured 2026-11-25:

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

## 3. Option B — install a minimal trusted mission listener on `main`

**What changes:** a single small workflow is committed to `main` that listens for
`repository_dispatch: [wolf-private-ci]` and does nothing but start the real
bridge at a **pinned SHA** of this branch:

```yaml
name: Wolf Mission Listener
on:
  repository_dispatch:
    types: [wolf-private-ci]
permissions:
  contents: read
  actions: write
jobs:
  forward:
    if: github.repository == 'insidethemarginmedia-cpu/wolf-factory-home'
    runs-on: ubuntu-latest
    steps:
      - name: Forward the mission to the pinned bridge
        env:
          GH_TOKEN: ${{ secrets.WOLF_FACTORY_REPO_TOKEN }}
          BRIDGE_SHA: <40-hex pinned sha>
          PAYLOAD: ${{ toJSON(github.event.client_payload) }}
        run: |
          set -euo pipefail
          printf '%s' "$PAYLOAD" > /tmp/payload.json
          # The payload is forwarded verbatim; the bridge validates it against the
          # mission schema, so a hostile payload is refused there, not here.
```

- **Security:** the listener holds no App credentials, reads no private source and
  cannot publish. It only forwards an event to a pinned SHA. The blast radius of
  compromising it is one dispatch, which the mission schema then rejects if
  malformed. **Least privilege is materially better than Option A**, because the
  default branch never holds the private-source path at all.
- **Dependencies:** depends on this branch continuing to exist at the pinned SHA.
  A force-push or deletion breaks it — but this branch is append-only, and the pin
  is a SHA so a moved branch does not change behaviour.
- **Compatibility:** additive. Nothing on `main` changes except one new file.
- **Rollback:** delete one file. Nothing else in the repository is touched.
- **Continuity:** `main`'s inert entrypoints stay inert. The status quo for every
  existing consumer is preserved.

**Risk:** narrow. One file on `main`, no credential, no source access.

## 4. Recommendation

**Option B.** The reason is not convenience, it is the security boundary: Option A
puts the private-source checkout path on the default branch, where any future
change to `main` interacts with it directly. Option B keeps the default branch
credential-free and puts exactly one privilege — *dispatch a pinned SHA* — in the
one place that needs it.

The honest caveat: Option B means the bridge's *code* lives on a non-default
branch, so a stale pin is possible. That is why the workflow now reports
`PRIVATE_HEAD_RELATION` and the bridge pins an immutable SHA rather than a ref. A
stale pin produces a visibly `STALE` relation, not a silent pass.

## 5. Prerequisites before either option

Not yet satisfied; both must close first.

1. **Independent verification findings.** Wolf Independent Verification is
   reported to hold 11 critical findings. **No branch, PR, report or checkpoint
   from it exists in this repository** (checked: open PRs #1 and #2 only; no
   `independent-verification` ref among all remote heads). Closure cannot be
   claimed and has not been claimed. Activation should not proceed until those
   findings are reviewed.
2. **Mission transport correlation.** HTTP 204 is not evidence a run started — the
   silent-failure probe returned 2xx with zero runs. The bridge must correlate a
   dispatch to a run id before transport is called complete. This is prepared, not
   finished.

## 6. What has not been done, deliberately

- No default-branch change (403 for automation, and a founder decision regardless).
- No merge to `main`.
- No force push, no history rewrite.
- No mission simulated to stand in for a real dispatch.
- No claim that the 11 findings are closed.

`EUR_SPEND=0`. `COST_UNKNOWN=DENY`. `PAID_FALLBACK=DENY`. `TRIAL_CREDIT=DENY`.
