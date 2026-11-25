# Wolf Home — Integration Contract

For **Factory**, **Factory 2** and **LEGO Wolf Development**.

This document is the complete interface. If you need something not described
here, that is a contract change, not a configuration detail.

Status: the bridge runs and is verified on this branch; the cross-repository
trigger is **blocked on one Founder action** (see §5). Everything below says
exactly which parts are live and which are pending.

---

## 1. What this service does

Wolf Home executes a **pinned commit of `donraposo1-source/project-wolf`** on a
GitHub-hosted runner and publishes a receipt bound to that exact SHA.

It is a verifier, not a builder. You give it a SHA; it gives you a verdict.

```
mission payload  →  validate  →  execute 6 required checks  →  publish receipt
   (JSON)            (schema)      (immutable SHA)              (durable, public)
```

## 2. How to call it

### 2.1 Transport

A `repository_dispatch` event of type **`wolf-private-ci`** on
`insidethemarginmedia-cpu/wolf-factory-home`.

```bash
gh api -X POST repos/insidethemarginmedia-cpu/wolf-factory-home/dispatches \
  -f event_type=wolf-private-ci \
  -f 'client_payload[schemaVersion]=1' \
  -f 'client_payload[missionId]=factory-nightly-0001' \
  -f 'client_payload[repository]=donraposo1-source/project-wolf' \
  -f 'client_payload[sha]=8d319fc50be4e4d225e3bb80de963583899c25ec' \
  -f "client_payload[issuedAt]=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
```

Your token needs **only** `actions:write` (or `repo` scope) on
`wolf-factory-home`. It must **not** have any access to `project-wolf` — the
service reads private source with its own App installation, never with yours.
This is deliberate: a caller who could read the private repo would not need the
service, and a caller who cannot read it cannot leak it.

### 2.2 Payload

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `schemaVersion` | integer | yes | Must be `1` |
| `missionId` | string | yes | Your own stable id, `[A-Za-z0-9._:-]`, ≤ 120 chars |
| `repository` | string | yes | Must be `donraposo1-source/project-wolf` |
| `sha` | string | yes | **Full 40 hex characters.** Abbreviations, tags and branch names are rejected |
| `issuedAt` | ISO-8601 string | yes | Must be within 1 hour of arrival |

Any of `workflow`, `workflowFile`, `token`, `permissions`, `credentials`,
`ref` or `paid` present in the payload — **even set to `false`** — causes
rejection. You cannot name a workflow, redirect the ref, supply a credential or
authorise spending. Those are not configurable.

### 2.3 Idempotency

The identity key is **`missionId@sha`**.

| Situation | Result |
| --- | --- |
| New `missionId@sha` | `ACCEPTED` — work starts |
| Same `missionId@sha` re-sent | `DUPLICATE` — success, **no new work** |
| Same `missionId`, different `sha` | New work (a new commit is a new mission) |

`issuedAt` and `attempt` are **excluded** from the key, so retrying a delivery
never duplicates work. Send the same payload again to retry; do not invent a new
`missionId` to work around a duplicate response — that is the failure mode the
key exists to prevent.

### 2.4 Retries — your responsibility

The service does not call you back and does not retry on your behalf beyond the
bounds in §4. Poll the receipt (§3) and resend the **identical** payload if the
run did not start.

## 3. How to read the result

The receipt is a **public check run** attached to the executed commit. Read it
with a token that can see `wolf-factory-home`:

```bash
gh api repos/insidethemarginmedia-cpu/wolf-factory-home/commits/<full-sha>/check-runs \
  --jq '.check_runs[] | select(.name=="wolf-app-diagnosis") | .output.text'
```

The check is named **`wolf-app-diagnosis`** and its output is JSON.

### 3.1 Receipt fields you may depend on

| Field | Meaning | Stable? |
| --- | --- | --- |
| `state` | `VERIFIED` only when all 13 checks pass | yes |
| `checks[]` | Per-check `name`, `status`, `detail` | yes |
| `authentication.mode` | `github-app` when the service authenticated as its App | yes |
| `appAcceptance.state` | `ACCEPTED` / `BLOCKED` / `FAILED` | yes |
| `fallbackRetirement.state` | `RETIRE_FALLBACK` / `KEEP_FALLBACK` | yes |
| `privateStatusCheck.state` | `PUBLISHED` when the check was written | yes |
| `privateReceipt.state` | `PUBLISHED` when the durable receipt was committed | yes |

**`state == "VERIFIED"` is the only success signal.** Do not infer success from
HTTP 2xx on the dispatch (§5), from the workflow appearing `active`, or from a
green workflow run on its own — a run can be green while checks are `BLOCKED`.

### 3.2 What the receipt never contains

No private source, no tokens, no credential fragments, no private log bodies.
`credentialsPrinted`, `privateLogsPublished` and `privateSourcePublished` are
always `false`. If you ever see private content in a receipt, that is a
security defect — report it, do not consume it.

## 4. Limits and refusal behaviour

| Limit | Value |
| --- | --- |
| Mission age | 1 hour |
| Missions per sender | 12 per hour |
| Retry attempts | 3, bounded |
| Never retried | `PAT_FALLBACK_RETIRED`, `PERMISSION_OR_RATE_LIMIT`, `NOT_FOUND_OR_NO_ACCESS` |

Non-retryable failures mean **stop and escalate**, not "try again". Permission
and not-found errors are a statement about your token, not transient weather.

Every rejection is journaled with its reason, including payloads that never
became missions. A refusal always leaves evidence.

## 5. Current status — what is live and what is blocked

| Capability | Status | Evidence |
| --- | --- | --- |
| Execute one immutable SHA, 6 checks + build + migrations + scans | **LIVE** | run `45591153763` — `VERIFIED`, 13/13 |
| Authenticate as the GitHub App, no PAT | **LIVE** | `authentication.mode: github-app` |
| Publish the private status check via App `checks:write` | **LIVE** | `privateStatusCheck: PUBLISHED` |
| Enforce fallback retirement operationally | **LIVE** | `fallbackRetirement.enforced: true` **while** the check published — the App carried the work, the PAT was unusable |
| Durable receipt publication | **LIVE** | `privateReceipt: PUBLISHED` |
| Mission schema validation and dedupe | **LIVE (unit-tested, 20 tests)** | `tests/private-ci-mission*.test.mjs` |
| **Start a run via `repository_dispatch`** | **BLOCKED** | see below |

### 5.1 The blocker, precisely

GitHub starts `repository_dispatch` workflows **only from the default branch**.
The bridge is not on `main`:

```
POST …/dispatches              → 2xx, zero runs created
GET  …/contents/…/private-ci-bridge.yml?ref=main → 404
repository_dispatch listeners on main            → none
POST …/workflows/429186774/dispatches (ref=branch) → 403
POST …/workflows/<default-branch workflow>/dispatches → 403
```

The last line matters: the 403 is **token capability**, not a branch problem, so
no branch-ref workaround exists for automation either.

**Required Founder action — one, and it is small:** land
`.github/workflows/private-ci-bridge.yml` on `main` (merge PR #2, or cherry-pick
that single file). The App, its permissions, the installation IDs, the receipt
publisher and the retirement enforcement all already work; only the trigger is
missing.

**Until then, do not dispatch.** The API will answer 2xx and nothing will run.
That silent acceptance is the single most dangerous property of this integration
— it looks like success and produces no work.

## 6. What you must not do

- Do not grant this service more than `contents:read`, `metadata:read`,
  `checks:write`, `actions:write`. Least privilege is deliberate; the service's
  403s have been diagnoses, not defects.
- Do not send a token, key or credential in a payload. It will be rejected, and
  it should never have been in the payload.
- Do not send branch names, tags or short SHAs. They are rejected.
- Do not treat a duplicate exit as failure.
- Do not build a second publisher for the same receipt. Coordinate through this
  document instead of duplicating the pipeline.

## 7. Cost

`EUR_SPEND=0`. `COST_UNKNOWN=DENY`. `PAID_FALLBACK=DENY`. `TRIAL_CREDIT=DENY`.

There is no paid endpoint, no billing configuration and no artefact upload in
this path. Any integration that would incur cost is outside this contract and
requires explicit Founder authorisation before it exists.

## 8. Where to look when something goes wrong

| Symptom | First thing to check |
| --- | --- |
| Dispatch returned 2xx, nothing ran | Is the bridge on `main`? (§5.1) |
| No receipt on the commit | Read `wolf-app-diagnosis` check-run on **that full SHA** |
| `state != VERIFIED` | Read `checks[]` — the failing check names its own step |
| `DUPLICATE` response | Correct behaviour; poll the existing receipt |
| `REJECTED` | Journal holds the reason; check SHA length and payload age first |
