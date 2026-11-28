# Executor Pin Recovery — Integration Candidate Only

Status on 2026-11-24: **BLOCKED — the initially recovered pin is interface-valid but not safe for activation; its replacement remains unapproved.**

## Recovered executor and follow-up pin review

The original history-recovered candidate was:

```text
b3f397fd959f41c1a843e917b35e0a5914f53c11
```

It is an existing immutable commit in the public Factory Home history, and its bridge declares the four `workflow_call` inputs (`sha`, `missionId`, `deliveryId`, and `executorSha`) and contains durable admission plus an execution-time recheck. That resolved the missing-SHA/interface question only. It did **not** qualify the actual pinned executor: Home PR #4's at-pin tests and review found that this commit lacks the `target_verification` and isolated `publish_status` jobs and leaves write permissions in `execute`, although newer worktree code contains those protections. The current PR #2 branch still pins `b3f397f`; do not activate or execute it.

PR #4 proposes the narrowly scoped correction: pin the listener to the exact published commit `1c13579433540d377d254fda3089216d2925c60f` and test the invoked commit's target-verification, economic/isolation gates, and publication permissions. PR #4 is open at head `0ddebd8c3c41b570c7fbfe091b0d6567aca236cb`, with no approval recorded. Its public `validate` run `45920988656` passed; private mission, target, execution, and publication jobs were skipped. This is a review candidate, not approval or activation. Do not merge an experimental branch wholesale or silently move the pin.

The earlier value `9679aa76397c7b248c3708be2c063e75a7058ae5` did not resolve. The older valid commit `6c2848d1849d85e70ff3a9590a42b3df0465c487` was not substituted: its workflow predates the `executorSha` input and durable admission gate. The current review test inspects the actual pinned commit's tree and gate/interface, and fetches the immutable SHA from `origin` in a shallow CI checkout; an unavailable pin still fails closed.

## Verification boundary

At the earlier recovery checkpoint the local suite was **491 passed / 0 failed**, followed by a historical **502 passed / 0 failed** run. Public runs [45901460667](https://github.com/insidethemarginmedia-cpu/wolf-factory-home/actions/runs/45901460667) and [45901572224](https://github.com/insidethemarginmedia-cpu/wolf-factory-home/actions/runs/45901572224) passed `validate`; [45917702188](https://github.com/insidethemarginmedia-cpu/wolf-factory-home/actions/runs/45917702188) passed the then-current 502-test suite while `probe`, `inventory`, `mission_admission`, `target_verification`, `execute`, and `publish_status` were skipped. The earlier run `45889750580` failed `validate`, but the log download returned EOF and its exact cause was not established.

At the earlier PR #2 checkpoint `3b6b25873a87f0aa38c6aaee1105ac94aab01d99`, the local suite passed **510/510** and public run [46016992335](https://github.com/insidethemarginmedia-cpu/wolf-factory-home/actions/runs/46016992335) passed `validate`; all private-facing jobs were skipped. On recovery implementation commit `fc41490de35a2dcbfed4eba879cf84033eed7a4f`, `node --test tests/*.test.mjs` passed **523/523**, and public run [46090648591](https://github.com/insidethemarginmedia-cpu/wolf-factory-home/actions/runs/46090648591) passed `validate` at that exact SHA. `probe`, `inventory`, `mission_admission`, `target_verification`, `execute`, and `publish_status` were skipped. PR #4's exact head also has a passing public `validate` run ([45920988656](https://github.com/insidethemarginmedia-cpu/wolf-factory-home/actions/runs/45920988656)), with private-facing jobs skipped. These are public-controller regression results, not private-source workflow runs or worker acceptance.

The executor recovery proves only that this repository contains a resolvable, interface-compatible candidate commit. It does **not** establish Factory/Build Wolf or Wolf Compute acceptance, callback authenticity, a durable execution queue/lease/recovery owner, required approval, private-worker output, or permission to activate or dispatch. The PR remains inactive and fail-closed.

## Existing Compute contract boundary and coordination

The existing public `donraposo1-source/wolf-compute` repository at `f00dd8860edd245e53a11feee24270bc553ded2b` exposes a `PUBLIC_STANDARD_RUNNER` canary bound to `mission_id`, `fence`, source/workflow/binding SHAs and a result digest. Inspection covered all reachable public refs, not only `main`: the `main` canary and lab branches do not define an authenticated private-worker callback, terminal receipt, or durable queue/recovery protocol. A lab-branch `WOLF_ROOT_ADMISSION_DOCTRINE_V1` artifact (commit `4a52cd4d7a6d64013d723f798930d9f0744a1260`) states the EUR0/admission/authority boundary and explicitly grants no merge, deployment, scheduler, or queue authority; it is a policy artifact, not a callback schema or proof of production acceptance. The canary is not worker acceptance.

A read-only contract request was opened in the existing repository: [Wolf Compute issue #2](https://github.com/donraposo1-source/wolf-compute/issues/2). It asks the Build Wolf and Wolf Compute owners for the authoritative versioned admission envelope, callback authentication and retry semantics, durable lease/fence/recovery owner, terminal receipt, and zero-cost approval boundary. No confirmation has been received. No Build Wolf contract artifact was available in the repositories inspected; no endpoint, credential, queue, or schema has been inferred or simulated.

`EUR_SPEND=0`. Do not merge, activate, dispatch, or call a test/canary/HTTP response/green CI run private-worker acceptance while the upstream contracts, recovery ownership, and required approvals remain unresolved.
