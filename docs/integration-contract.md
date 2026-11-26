# Wolf Home — Integration Contract

For **Factory**, **Factory 2** and **LEGO Wolf Development**.

This document is the complete interface. If you need something not described
here, that is a contract change, not a configuration detail.

Status as of 2026-11-24: **BLOCKED — no mission dispatch or worker acceptance is
claimed.** The older direct-dispatch contract below is superseded where noted;
its historical run claims were not revalidated in this session. The engineering
branch contains an authenticated listener and reusable-workflow admission gate,
but neither is activated on `main`; the configured listener executor pin currently
does not resolve to a commit in this repository. Factory/Factory 2 P1.59/P1.47+
contracts have not been reconciled from authoritative sources, and no durable
execution lease/recovery path is enabled.

---

## 1. What this service does

The intended Home verifier executes a **pinned commit of
`donraposo1-source/project-wolf`** on a GitHub-hosted runner and emits a receipt
bound to that exact SHA. This path is currently blocked and has not been
accepted as a real worker or Factory mission in this session.

Home is a verifier, not a builder or a worker. A local `VERIFIED` check receipt
would not by itself establish external worker output, callback authentication,
zero cost, or independent acceptance.

```
mission payload  →  validate  →  execute 6 required checks  →  publish receipt
   (JSON)            (schema)      (immutable SHA)              (durable, public)
```

## 2. How to call it

### 2.1 Transport — blocked pending activation and contract reconciliation

**Do not dispatch using the historical command.** The direct
`repository_dispatch` trigger has been removed from `private-ci-bridge.yml`; a
raw event cannot enter privileged execution. The intended path is:

1. An authenticated, authorized sender submits `wolf-private-ci` to the
   repository's default-branch mission listener.
2. The listener derives `sender` from GitHub's event envelope, derives delivery
   identity from the GitHub-assigned run id, validates the exact mission and
   immutable executor pin, and durably records admission plus its ledger anchor.
3. Only an admitted listener run invokes the reusable bridge at its immutable
   SHA. A dedicated `contents: read` admission job re-reads the durable record
   before the privileged `execute` job (including its service containers) can
   start. `execute` then verifies the same mission id, target repository/SHA,
   delivery id, executor SHA, and caller run id again before private checkout or
   App-token mint. Neither gate alone is worker acceptance.

That listener is present only on this engineering branch. No default-branch
activation or permission change was performed. An upstream caller needs only the
minimum permission approved for dispatching the listener; it must not receive
private-source access, and it must not send credentials in payloads.

The current anti-replay identity is the GitHub run id plus the durable
`missionId@sha` key. There is no separate nonce field, HMAC, or signed callback
contract in this repository. Compatibility with Factory P1.59 / Factory 2
P1.47+ is therefore **NOT VERIFIED** until their authoritative envelope, nonce,
callback-signature, receipt and retry schemas are reviewed side by side.

The old `gh api .../dispatches` example is withdrawn. A 2xx dispatch response is
not evidence of an admitted mission, a workflow run, or worker acceptance.

### 2.2 Payload — code contract, not an activated API

The current local validator expects this mission data in `client_payload`:

| Field | Type | Rule |
| --- | --- | --- |
| `schemaVersion` | integer | Must be `1` |
| `missionId` | string | `[A-Za-z0-9][A-Za-z0-9._:-]{7,127}` |
| `repository` | string | Must be allowlisted; current listener allows `donraposo1-source/project-wolf` |
| `sha` | string | Full 40-character lowercase hex commit SHA |
| `issuedAt` | number / numeric string | Unix epoch milliseconds; no more than 5 minutes in the future or 1 hour old |
| `checks` | optional array | 1–64 lowercase names matching `[a-z0-9][a-z0-9-]{0,63}` |
| `attempt` | optional positive integer | Metadata only; cannot skip replay protection or start a retry |
| `requestedBy` | optional string | Non-authoritative display metadata only |

The authenticated `sender` is read from `github.event.sender.login`, never from
`client_payload`. Delivery identity is derived from the GitHub run id; executor
identity is fixed by the reviewed workflow pin and must match the admitted record.
Neither is a caller-selected permission.

The validator rejects any presence of `workflow`, `workflowFile`, `token`,
`permissions`, `credentials`, `ref`, `paid`, or `allowPaidExecution`.
Credentials, callback signatures, nonce fields, execution leases, fences, and
callback receipts are **not** part of this local schema. Do not treat an extra
`nonce` property as protected: the current validator does not authenticate or
persist it. This is one of the unresolved compatibility points with Factory
P1.59 and Factory 2 P1.47+; no compatibility claim is made until their exact
schemas are available and compared.

### 2.3 Replay and idempotency

The durable admission key is **`missionId@sha`**, paired with a delivery id
derived from the GitHub run id. The admission ledger and external head anchor
must both verify before the bridge proceeds. Same-run retries may repair the
exact pending anchor; a new run carrying the same mission key is refused.
Only admitted missions are written to the durable ledger. A refusal is reported
in its GitHub Actions run log; it is not currently a separately durable ledger
record.

This protects admission replay. It is **not** execution-effect idempotency for
Factory, Factory 2, DBOS, or external workers. The Home bridge currently has no
production durable lease/fence state, callback signature verification, or
schedule-backed retry/recovery. Do not change `missionId` to bypass a duplicate,
and do not replay work with unknown external effects; reconcile with the existing
Factory owner/controller first.

### 2.4 Retries — no automatic recovery is enabled

A failed, cancelled, or ambiguous run is not automatically retried. A same-run
GitHub rerun still requires the exact durable admission and must be reviewed
against external-effect evidence. No schedule trigger or local file journal is
used as a production queue. `state: VERIFIED` is not worker acceptance; it is
only the bridge's check receipt for the exact target SHA.

## 3. Historical receipt shape — no current receipt produced

The old bridge emitted a **public check run** attached to the executed commit. Read it
with a token that can see `wolf-factory-home`:

```bash
gh api repos/insidethemarginmedia-cpu/wolf-factory-home/commits/<full-sha>/check-runs \
  --jq '.check_runs[] | select(.name=="wolf-app-diagnosis") | .output.text'
```

The check is named **`wolf-app-diagnosis`** and its output is JSON.

### 3.1 Historical receipt fields — not an active interface

The fields below describe old receipt formats only. No current receipt was
produced in this session, and the current code/pin has not been accepted as a
service contract. Do not use this table as proof of a current run or worker.

| Field | Historical meaning | Current status |
| --- | --- | --- |
| `state` | `VERIFIED` after the then-configured checks passed | historical only |
| `checks[]` | Per-check `name`, `status`, `detail` | not revalidated |
| `authentication.mode` | Previously reported auth mechanism | not revalidated |
| `appAcceptance.state` | Prior `ACCEPTED` / `BLOCKED` / `FAILED` field | not worker acceptance |
| `fallbackRetirement.state` | Prior retirement decision | not revalidated |
| `privateStatusCheck.state` | Prior private-check publication state | not revalidated |
| `privateReceipt.state` | Prior receipt-publication state | not revalidated |

Even a historical `state == \"VERIFIED\"` means only the code's checks for an
exact SHA passed at that time; it is not Factory mission acceptance or private
worker acceptance. An HTTP 2xx, a workflow appearing `active`, or a green run
cannot establish worker output, callback authenticity, or external effects.

### 3.2 What the receipt never contains

No private source, no tokens, no credential fragments, no private log bodies.
`credentialsPrinted`, `privateLogsPublished` and `privateSourcePublished` are
always `false`. If you ever see private content in a receipt, that is a
security defect — report it, do not consume it.

## 4. Limits and refusal behaviour

| Limit | Current local rule |
| --- | --- |
| Mission age | 1 hour; up to 5 minutes future skew |
| Missions per sender | 12 per rolling hour (admission policy) |
| Delivery replay | GitHub-assigned run id plus durable ledger check |
| Mission replay | `missionId@sha`, durably anchored before handoff |
| Automatic retry / lease recovery | **Disabled / not implemented as a durable Home queue** |
| Unknown or paid cost | `DENY`; no mission run is authorized by this document |

The policy and fake-GitHub tests establish local admission/ledger behavior only.
They do not establish upstream nonce compatibility, worker-side idempotency,
lease renewal, fencing, authenticated callbacks, or a real external effect. A
refusal is not permission to try another transport or credential.

## 5. Current status — blocked, no mission executed

| Capability | Status on 2026-11-24 | Evidence / boundary |
| --- | --- | --- |
| Target SHA fallback | **REPAIRED IN LOCAL CODE; NOT LIVE-ACCEPTED** | `WOLF_CI_SHA` resolves only from typed `inputs.sha`; missing input stays empty and fails closed |
| Listener executor pin | **BLOCKED / UNRESOLVED** | Current `9679aa76397c7b248c3708be2c063e75a7058ae5` is not found in this repository (GitHub API returned 422); older pins do not contain the current gate interface |
| Private mission entrypoint | **IMPLEMENTED IN THE PR WORKTREE; NOT ACTIVATED** | Fake-GitHub tests exercise admission/anchor logic; the listener is absent from `main`, and no production admission occurred |
| Raw bridge `repository_dispatch` | **REMOVED** | The bridge has no raw dispatch trigger; a read-only pre-job gate and an in-job re-check require the trusted default-branch listener caller and typed mission inputs before private access |
| Direct manual private execution | **DENIED BY CONDITION** | Full execute job is limited to a `repository_dispatch` call from `mission-listener.yml@refs/heads/main`; manual inputs cannot satisfy it |
| Durable admission/replay ledger | **UNIT-TESTED, LIVE PERSISTENCE UNKNOWN** | Fake GitHub API exercises anchored append, stale/conflict refusal, replay and gate; no production admission run occurred |
| Durable execution queue / lease / fence / schedule recovery | **NOT IMPLEMENTED / BLOCKED** | The local JSON journal is test-only; no cron is exposed |
| Factory P1.59 / Factory 2 P1.47+ envelope compatibility | **NOT VERIFIED** | The authoritative versioned contracts were not present in this checkout or independently fetched |
| Real Compute worker output / authenticated callback | **NOT VERIFIED** | A public-standard-runner canary or fixture is not real worker acceptance |
| Independent verification | **NOT AVAILABLE IN THIS RUN** | No new verifier result was obtained; prior acceptance remains blocked |
| Mission, spend, production deploy, default-branch change | **NONE** | `EUR_SPEND=0`; no mission dispatch or production action occurred |

### 5.1 Minimum Founder actions before any dispatch

1. **Approve the default-branch listener activation** (or provide the authoritative existing dispatch entrypoint) and confirm the exact sender allowlist. No `main` change is authorized from this session.
2. **Provide/review the canonical Factory P1.59 and Factory 2 P1.47+ contract artifacts**: authenticated envelope, nonce/replay rules, signature/callback verification, lease/fence fields, idempotency key, and durable terminal receipt. Reconcile them against this code before widening its schema.
3. **Confirm the existing Home/Compute authorization path and durable queue owner**, including safe `contents:write` or approved store access for the admission/receipt ledger. Do not create a second scheduler or queue.
4. **Authorize one bounded, zero-cost validation only after all prior gates**, with exact target and executor SHAs, real worker output, authenticated callback, and an independent verifier. No public canary substitutes for this.

Until those actions are complete, no caller should send a mission, and no result in the historical evidence sections should be treated as current worker acceptance.

## 6. What you must not do

- Do not send a mission while the default-branch listener, upstream envelope,
  nonce/callback, durable queue/recovery, and independent-verification gates are
  unresolved.
- Do not grant credentials to arbitrary caller workflows. Keep each token/key
  scoped to the exact job/step and repository permission it needs; no
  `secrets: inherit` is used for the reusable mission handoff.
- Do not send a token, key or credential in a payload.
- Do not send branch names, tags or short SHAs as a target.
- Do not change `missionId` to bypass replay denial, or replay work with unknown
  external effects.
- Do not create a second queue, scheduler, publisher, or control plane; reconcile
  with the existing Factory/Compute owner contract first.

## 7. Cost

`EUR_SPEND=0`. `COST_UNKNOWN=DENY`. `PAID_FALLBACK=DENY`. `TRIAL_CREDIT=DENY`.

There is no paid endpoint, no billing configuration and no artefact upload in
this path. Any integration that would incur cost is outside this contract and
requires explicit Founder authorisation before it exists.

## 8. Where to look when something goes wrong

| Symptom | First thing to check |
| --- | --- |
| No listener on the default branch | Do not dispatch; obtain Founder approval for the existing listener handoff |
| Reusable bridge refuses before checkout | Check the durable admission ledger/anchor and exact run, delivery, executor and target SHAs |
| `WOLF_CI_SHA` is empty | The run did not receive a typed immutable target input; do not restore a baked-in fallback |
| `DUPLICATE` / replay refusal | Reconcile the existing admission/worker effect; do not mint a new mission id to bypass it |
| Missing terminal receipt | Treat as UNKNOWN; inspect the existing owner-controlled run and callback evidence before any retry |
| Worker output is a public canary | Not real worker acceptance; do not mark the mission accepted |
