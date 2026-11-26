# Executor Pin Recovery — Integration Candidate Only

Status on 2026-11-24: **SHA and reusable-interface defect resolved for the public PR candidate; not approved for activation or dispatch.**

## Recovered executor

The listener now pins the reusable bridge to the existing full-history commit:

```text
b3f397fd959f41c1a843e917b35e0a5914f53c11
```

This is an existing immutable commit in the public Factory Home PR history, not a new repository or fabricated object. GitHub's commit API resolves it to tree `c61b1bb7f4260880053ae9bb33033a515f958599`; the tree contains:

- `.github/workflows/private-ci-bridge.yml` (blob `b95a8ef057e4f311edbd1f76306ae630ece8cb95`)
- `.github/workflows/mission-listener.yml`
- `scripts/private-ci-listener-store.mjs`
- `scripts/private-ci-listener-gate-cli.mjs`

The pinned bridge declares the four required `workflow_call` string inputs actually passed by the listener: `sha`, `missionId`, `deliveryId`, and `executorSha`. Its workflow also contains the read-only `mission_admission` job, the admission-conditioned `execute` job, and the non-optional in-job recheck before private access. This resolves the repository-local missing-SHA and caller/interface mismatch for the candidate.

The prior value `9679aa76397c7b248c3708be2c063e75a7058ae5` did not resolve and has been removed. The older valid commit `6c2848d1849d85e70ff3a9590a42b3df0465c487` was not substituted: its workflow predates the `executorSha` input and the current durable admission gate. Tests now inspect the pinned commit's actual tree and gate/interface, and fetch the immutable SHA from `origin` when running in a shallow CI checkout; an unavailable pin still fails closed.

## Verification boundary

The full local regression run before the fix was **484 passed / 6 failed of 490**. All six failures were pin-related: four listener-pin checks plus the two reusable-workflow resolution/tree checks. The listener pin and shallow-checkout handling were corrected without loosening those checks. The current local suite is **491 passed / 0 failed** for `node --test tests/*.test.mjs`; the focused pin/interface suite is **10/10 passed**. A depth-1 clone initially lacked the pinned object and then passed the same **10/10** tests after fetching the immutable pin. Public run [45901165849](https://github.com/insidethemarginmedia-cpu/wolf-factory-home/actions/runs/45901165849) on the 490-test predecessor passed `validate`. The current 491-test candidate at `64b8446e2ef09c011b81f44a73273d8ce60fa13c` was validated by push run [45901460667](https://github.com/insidethemarginmedia-cpu/wolf-factory-home/actions/runs/45901460667): `validate` passed, and `probe`, `inventory`, `mission_admission`, and `execute` were skipped. The earlier run `45889750580` failed its public `validate` step, but GitHub's log download returned EOF, so its exact cause was not established.

The executor recovery proves only that this repository contains a resolvable, interface-compatible candidate commit. It does **not** establish Factory/Build Wolf or Wolf Compute acceptance, callback authenticity, a durable execution queue/lease/recovery owner, required approval, private-worker output, or permission to activate or dispatch. The PR remains inactive and fail-closed.

## Existing Compute contract boundary and coordination

The existing public `donraposo1-source/wolf-compute` repository at `f00dd8860edd245e53a11feee24270bc553ded2b` exposes a `PUBLIC_STANDARD_RUNNER` canary bound to `mission_id`, `fence`, source/workflow/binding SHAs and a result digest. Its current tree does not define an authenticated private-worker callback, terminal receipt, admission authority, or durable queue/recovery protocol. That canary is not worker acceptance.

A read-only contract request was opened in the existing repository: [Wolf Compute issue #2](https://github.com/donraposo1-source/wolf-compute/issues/2). It asks the Build Wolf and Wolf Compute owners for the authoritative versioned admission envelope, callback authentication and retry semantics, durable lease/fence/recovery owner, terminal receipt, and zero-cost approval boundary. No confirmation has been received. No Build Wolf contract artifact was available in the repositories inspected; no endpoint, credential, queue, or schema has been inferred or simulated.

`EUR_SPEND=0`. Do not merge, activate, dispatch, or call a test/canary/HTTP response/green CI run private-worker acceptance while the upstream contracts, recovery ownership, and required approvals remain unresolved.
