# Wolf Home — Integration Contract

For **Factory**, **Factory 2** and **LEGO Wolf Development**.

This document is the complete interface. If you need something not described
here, that is a contract change, not a configuration detail.

> **Status correction (2026-11-25): this document contains stale acceptance claims.** The current private PR #743 head and target check runs are not accessible to the current GitHub identity, and the Home bridge has not been independently accepted for the claimed target SHA. Treat the operational claims below as historical until revalidated. See [`docs/private-ci-omega-p0-evidence.md`](private-ci-omega-p0-evidence.md) and [`docs/checkpoints/private-ci-omega-p0/OMEGA-P0.02-INITIAL-REVALIDATION-20261125.md`](checkpoints/private-ci-omega-p0/OMEGA-P0.02-INITIAL-REVALIDATION-20261125.md).

Status: the bridge was reported as running and verified at the time this contract was written; the current exact-SHA target acceptance is **BLOCKED / NOT VERIFIED**. The history/dispatch discussion in §5 is likewise historical and subject to the correction below.

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
| `missionId` | string | yes | 8–128 characters; first character alphanumeric, remaining characters `[A-Za-z0-9._:-]` |
| `repository` | string | yes | Must be `donraposo1-source/project-wolf` |
| `sha` | string | yes | **Full 40 hex characters.** Abbreviations, tags and branch names are rejected |
| `issuedAt` | ISO-8601 string | yes | Must be within 1 hour of arrival |
| `pr` | integer | optional | When supplied, must be the configured target PR `743` |
| `checks` | string array | optional | If supplied, must equal the fixed 13-check contract; callers cannot choose a subset |
| `requestedBy` | string | optional | If supplied, must match the authenticated GitHub actor |

The authenticated sender must also be present in the Home repository's explicit
`WOLF_CI_MISSION_ALLOWED_ACTORS` allowlist. An empty or missing allowlist denies
admission.

Any of `workflow`, `workflowFile`, `token`, `permissions`, `credentials`,
`ref` or `paid` present in the payload — **even set to `false`** — causes
rejection. You cannot name a workflow, redirect the ref, supply a credential or
authorise spending. Those are not configurable.

### 2.3 Idempotency and durable reservation

The identity key is **`missionId@sha`** (the target repository is fixed by
policy). Before any private-target access, the Home controller creates a
write-once reservation ref in its own repository. Reusing the key is therefore
suppressed across workflow runs, not merely within one runner's temporary files.

| Situation | Result |
| --- | --- |
| New `missionId@sha` with a free sender slot | `ACCEPTED` — reservation is durable before target access |
| Same `missionId@sha` re-sent | `DUPLICATE` — **no new work**, even if the prior run did not complete |
| Same `missionId`, different `sha` | New identity and reservation; target PR-head validation still applies |
| Hourly sender cap reached | `RATE_LIMITED`; the mission key remains durably consumed |

`issuedAt` and `attempt` are excluded from the identity key. A durable reservation
is not automatically released or re-armed after a failed/blocked run. To request
an intentional retry, use a **fresh `missionId`** for the same SHA; this is a new
mission and counts against the sender's hourly limit. A repeated delivery with
the old ID cannot be used to retry.

### 2.4 Retries — caller responsibility

The current admission path does not retry target execution automatically and
does not call the sender back. Read the published workflow result and decide
whether a new attempt is warranted. If the initial admission outcome is unknown,
reusing the same key is safe but can only return `DUPLICATE`; use a fresh ID only
when an additional execution is deliberately authorized.

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
| Automatic retries | none in the current admission path |
| Sender rate limit | 12 durable reservations per authenticated actor per UTC hour |

Admission and target execution are not automatically retried. A caller may
request a new attempt only with a fresh `missionId`, and only when the
per-sender cap allows it. Invalid payloads and actor/allowlist refusals are
rejected before any target access; they are not written to the durable mission
reservation refs. Once a reservation is created, duplicate and rate-limit
outcomes remain deduplicated even if a later ledger call or execution fails.

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

GitHub starts `repository_dispatch` workflows **only from the default branch**,
and the default branch here cannot carry the bridge by any path available to
automation. Each step below was measured:

| Probe | Result |
| --- | --- |
| `POST …/dispatches -f event_type=wolf-private-ci` | 2xx, **zero runs created** |
| `GET …/contents/.github/workflows/private-ci-bridge.yml?ref=main` | **404** |
| `repository_dispatch` listeners on `main` | **none** — `main` holds only `night-shift-wakeup.yml` (`schedule`, `workflow_dispatch`) and `ollama-public-synthetic-qualification.yml` (`workflow_dispatch`) |
| `POST …/actions/workflows/429186774/dispatches -f ref=<branch>` | **403** |
| Same call against a *default-branch* workflow | **403** — so this is token capability, not a branch problem |
| `PATCH …/repos/… -f default_branch=…` | **403** |
| `git merge-base HEAD origin/main` | **no merge base — unrelated histories** |
| `git rev-list --max-parents=0` (each) | `main` root `3742bcc`; this branch root `20f1872` |

### History correction — 2026-11-25

The “no merge base / orphan root” conclusion in the earlier rows was produced by
a shallow checkout: `.git/shallow` marked the branch and `main` commits as graft
boundaries. The read-only GitHub Compare API for
`main...arena/38f3a7f7-wolf-factory-home` reports **diverged**, `ahead_by=251`,
`behind_by=2`, and shared merge base
`da2ae9b4cef830e0d441f5e0b4b2fdab16196bdd`. The orphan-history inference is
**superseded**; no history rewrite is needed or authorized. PR #2 still targets
`feat/public-runtime-probe-20261022`, not `main`, so default-branch workflow
placement and permissions remain a separate issue that must be revalidated.

**Historical proposal (not current guidance or authorization).** The original
“must be a landing, not a merge” recommendation was based on the false orphan
inference. A conventional PR/merge is graph-compatible; whether it is currently
permitted or sufficient to put the bridge on the default branch is unverified.
Do not change the default branch, merge, or dispatch on the basis of this old
section. The original alternatives are retained below as historical context:

Land `.github/workflows/private-ci-bridge.yml` and the `scripts/` it imports on
`main`. Two shapes proposed at the time:

1. **Adopt this history as default (preferred).** Set the repository default
   branch to `feat/public-runtime-probe-20261022`, or fast-forward `main` to that
   tip. This is a settings change, reversible, and needs no history rewrite.
2. **Copy the files onto `main`.** Commit the bridge workflow plus the
   `scripts/` it imports onto `main` as a new commit. The original note said this
   would keep “orphan history”; that rationale was wrong because the branches
   share history. A normal commit on `main` would not rewrite its existing
   history. The `scripts/` must travel with the workflow or it will fail at its
   first `node` call.

The following sentence in the original assessment (“Nothing else is outstanding”)
is also historical and is **not current acceptance**: this audit could not verify
the App installation, private PR, exact target run, receipt publisher, or current
Factory state. The earlier `2xx`/zero-runs observation was point-in-time; current
dispatch behavior must be revalidated. No dispatch was initiated in this audit.

**Current control:** do not dispatch the private target until the private PR head,
workflow identity, durable mission admission, exact source tree, and final
check-run are readable and bound to the same SHA.

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
