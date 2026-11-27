# Wolf Private CI Bridge — Historical CI and Credential Notes

Status as of 2026-11-24: **HISTORICAL ONLY — no current mission or private-worker
acceptance is claimed.** The run IDs, receipts, API responses, and test counts
below have not been re-fetched or independently revalidated in this review. The
code now under review has a different execution path. In particular, the old
local-journal recovery claim is withdrawn in §4 and the old “live acceptance”
wording is withdrawn in §10.

This document records public, non-sensitive facts only: workflow names, commit
SHAs, check names, exit codes, durations and timestamps. No private Wolf source,
log, credential or configuration value is reproduced here. Historical run results
remain as recorded; they do not prove the current branch or worker acceptance.

## 1. Identity and access

| Item | Evidence |
| --- | --- |
| Public runner | `insidethemarginmedia-cpu/wolf-factory-home` (public, Actions enabled) |
| Private Factory | `donraposo1-source/project-wolf` (private) |
| Target commit | `8d319fc50be4e4d225e3bb80de963583899c25ec` (PR #743 HEAD) |
| Source-read credential | `WOLF_FACTORY_REPO_TOKEN` — fine-grained PAT, Contents + Metadata read-only, scoped to the one repository |
| Source-checkout credential | `WOLF_FACTORY_DEPLOY_KEY` — SSH deploy key, unchanged |
| Status-write credential | `WOLF_FACTORY_STATUS_TOKEN` — **not configured**; reserved for publishing check runs to the private commit, deliberately separate from the reader |

### Token recovery result

The previous PAT was expired (HTTP 401). With the rotated token the probe now
returns `PROBED`:

- `/repos/donraposo1-source/project-wolf` → **200**, `private: true`
- target commit present, `sha` matches
- identity `donraposo1-source`
- probe job conclusion: **success**

Authorisation is decided by the private repository read, not by `/user`: a
fine-grained PAT scoped to one repository returns 403 on `/user` even when it is
perfectly valid. The probe previously reported such a token as denied; it no
longer does.

### Remaining 403s and their cause

These are the expected consequence of a Contents+Metadata-only credential, not
defects:

| Endpoint | Status | Requires |
| --- | --- | --- |
| `/actions/workflows` | 403 | Actions: read |
| `/commits/{sha}/check-runs` | 403 | Checks: read |
| `/branches/{b}/protection` | 403 | Administration: read |
| `/actions/permissions` | 403 | Administration: read |
| workflow dispatch | 403 | **Actions: write** |

`diagnose-dispatch` performs each capability probe and names the minimum missing
permission (`actions: write`) without broadening anything. The bridge does not
need dispatch: execution is driven by the runner's own triggers, and the
deploy-key path is what reads private source.

## 2. Historical check report — not revalidated

The previous report claimed that thirteen checks ran against a checkout asserted
equal to the requested SHA and were all **blocking**. The run and receipt were
not re-fetched in this review; this is not evidence of the current workflow or of
private-worker acceptance.

| Check | Source | Result |
| --- | --- | --- |
| `security` | audit + secret scan | success |
| `lint` | the repository's `scripts/run-actionlint.sh` | success |
| `typecheck` | syntax/type gate | success |
| `unit` | `npm test` | success |
| `integration` | `prepare` → `crash` (77) → `recover` (0) | success |
| `build` | `npm run build` | success |
| `migrations` | schema verification on postgres 17 | success |
| `postgres-schema` | `.github/workflows/postgres-schema.yml` (real steps) | success |
| `postgres-concurrency` | `.github/workflows/postgres-concurrency-evidence.yml` (real steps) | success |
| `test` | `.github/workflows/test.yml` | success |
| `http-load-evidence` | `.github/workflows/http-load-evidence.yml` | success |
| `ocr-tesseract` | `.github/workflows/ocr-tesseract.yml` | success |
| `ocr-paddle` | `.github/workflows/ocr-paddle.yml` | success |

The six original Wolf workflows (`test`, `postgres-schema`,
`postgres-concurrency-evidence`, `http-load-evidence`, `ocr-tesseract`,
`ocr-paddle`) run their **own** commands, parsed from the workflow definitions
by a fail-closed reader that inlines local composite actions and records any
step it cannot reproduce instead of silently skipping it.

### How Postgres was made faithful

Three distinct problems had to be separated:

1. **Platform surface.** Supabase migrations reference `auth.users`, `storage.*`,
   the Supabase roles and extensions that the hosted platform ships. The bridge
   supplies that shape through a quoted heredoc (a double-quoted or
   JSON-encoded form corrupts `$$`, `$f$` and multi-line SQL) so the SQL arrives
   byte-for-byte.
2. **Who owns the roles.** The migrations create the Supabase roles themselves
   in a guarded block, while the concurrency workflow issues an unguarded
   `create role authenticated`. Pre-creating the roles for the migrations makes
   the workflow fail; supplying schemas only lets both succeed.
3. **Cluster scope.** Roles are cluster-scoped in PostgreSQL, so the schema and
   concurrency workflows cannot share one cluster: they collide on
   `authenticated`. Each gets its own `postgres:17` cluster (5432/5433/5434),
   mirroring the private repository where each workflow declares its own
   service container.

The concurrency workflow runs completely unmodified — it builds its own
canonical fixture and then measures it, so any bootstrap would change what it
measures.

## 3. Historically reported artefacts — not revalidated

| Artefact | State at the time of the old report |
| --- | --- |
| Sanitized public receipt (commit comment) | published, SHA-bound, with `receiptHash` |
| Public check runs `execute` / `inventory` / `probe` | success |
| Check run `wolf-private-ci-743` on the public commit | created, success |
| Private receipt branch `wolf-ci-receipts/<sha>` | `PUBLISHED` over the deploy key |
| Private status check (`wolf-private-ci-743` on the private commit) | `BLOCKED` — `PRIVATE_STATUS_TOKEN_REQUIRED`, names `checks: write` |

`privateSourcePublished`, `privateLogsPublished`, `inferencePerformed` and
`refUpdated` are `false` in every receipt.

### Identity separation

Writing a check to the private commit is the only private-side write, and it
uses its own credential. Supplying the same credential for reading and writing
is refused (`STATUS_TOKEN_MUST_DIFFER_FROM_SOURCE_TOKEN`), so the reader can
never be widened by accident.

## 4. Durable operation — previous claim withdrawn

The earlier statement that `scripts/private-ci-journal.mjs` provided a durable
production queue and that an hourly sweep reclaimed expired leases was incorrect.
That module and its CLI use a runner-local JSON file; a new GitHub-hosted runner
cannot read the previous run's file. The bridge also had no schedule-matched
recovery job. Unit tests of `claimNext` prove only the in-process helper, not
cross-run persistence, lease renewal, fencing, or automatic recovery.

The current bridge therefore no longer declares a raw `repository_dispatch` or
`schedule` trigger, and it no longer invokes the local mission/journal CLIs. The
only privileged mission path is the typed reusable-workflow call from the
separate authenticated listener. A `contents: read` admission job verifies the
ledger before the privileged `execute` job (and its service containers) can
start; `execute` re-checks the exact admission before private checkout or App
credential mint. That ledger records admitted missions and replay identity; it
is **not** an execution queue or lease/fence store.

Status: **NO PRODUCTION RECOVERY SWEEP.** Do not infer recovery from the older
three-run journal observation (`b56c795`, `2b9811e`, `3628709`) or from its unit
tests. A durable execution queue, lease/fence transitions, terminal settlement,
recovery caller, and correlated terminal receipt remain open prerequisites.

## 5. Cost and platform

| Control | Value |
| --- | --- |
| `EUR_SPEND` | `0` |
| `COST_UNKNOWN` | `DENY` |
| `PAID_FALLBACK` | `DENY` |
| `TRIAL_CREDIT` | `DENY` |
| Billable minutes (measured, 3 jobs) | `total_ms: 0` |
| Inference performed by the bridge | none |

The workflow is public-repository standard-runner only. No paid endpoint, no
inference provider and no paid fallback is reachable from the bridge; the only
network operations are GitHub, the pinned MIT DBOS donor and the package
registry.

## 6. Security posture

- Private source is cloned into the ephemeral runner only, `--filter=blob:none`,
  then `checkout --detach` with `git rev-parse HEAD` asserted equal to the
  requested SHA.
- Deploy key written `0600` in `RUNNER_TEMP`, pinned `github.com` ed25519 host
  key, `BatchMode=yes`, `StrictHostKeyChecking=yes`, removed after use.
- Public checkout uses `persist-credentials: false`; all actions pinned to full
  commit SHAs.
- Per-command logs at mode `0600` outside the repository, destroyed by an
  `always()` step that asserts they are gone; no artifacts uploaded.
- Failures publish PostgreSQL `SQLSTATE` plus `DETAIL`/`HINT`, never the
  offending statement; Python failures publish interpreter tags, never commands.
- Leak audit over every public comment: no source lines, keys or token patterns.

## 7. Defects found and repaired in this phase

| Defect | Repair |
| --- | --- |
| Probe reported a valid fine-grained PAT as denied (403 on `/user`) | Authorisation decided by the repository read; permissions recorded |
| Platform provisioning emitted raw SQL as shell lines | Quoted heredoc; a test asserts the DDL arrives byte-for-byte |
| Migrations failed on missing `auth.users` | Platform shape supplied; schemas only, roles left to migrations |
| Concurrency failed on `role "authenticated" already exists` | Each role-creating workflow gets its own cluster |
| Postgres checks reported as advisory | Advisory tier removed; every check is blocking |
| PaddleOCR install failed on the runner interpreter | `actions/setup-python@6d4fd22…` pinned to 3.11 |
| Step failures were unattributable | Receipts name the workflow step, error class and SQLSTATE |

## 8. Historical local verification count — not current

An earlier snapshot reported `node --test tests/*.test.mjs` as **299 passing,
0 failing**. That count predates the current worktree and is not evidence for the
current branch. See the current test run recorded in this document's revision
notes or CI; do not reuse the historical count as a release gate.

## 9. Historical credential-design notes — not activated

The recurring PAT is being replaced by GitHub App installation tokens. The App
path is implemented, wired into the run and green; the PAT and the deploy key
remain the working fallbacks until the App can be installed.

### 9.1 What was discovered before anything was created

| Question | Answer |
| --- | --- |
| Any authorised GitHub App already available? | Only Arena's own agent app (`app_id 4187077`), installed on both accounts |
| Can it be reused? | No. It belongs to Arena, not to Wolf, and an installation token cannot be minted without its private key |
| Is a Wolf-owned App installed? | No — this is the one remaining Founder action |

Two installations were listed: `176017917` on `donraposo1-source` (all 15
repositories, including `project-wolf`) and `176144552` on
`insidethemarginmedia-cpu` (selected: `wolf-factory-home` only). Attempting
`POST /app/installations/<id>/access_tokens` returned 401 *"A JSON web token could
not be decoded"*, confirming no App private key exists in this environment.

### 9.2 Role separation

| Role | Installation permissions | Used for | Token variable |
| --- | --- | --- | --- |
| reader | `contents: read`, `metadata: read` | Clone and read the private commit | `WOLF_CI_APP_READER_TOKEN` |
| publisher | `checks: write`, `metadata: read` | Publish the check run to the private commit | `WOLF_CI_APP_PUBLISHER_TOKEN` |
| dispatcher | `actions: write`, `metadata: read` | Dispatch the private workflow | `WOLF_CI_APP_DISPATCHER_TOKEN` |

No role can do another's job. A reader that asks for a write permission is
refused locally, before any request is made. A token whose *granted*
permissions differ from the request is denied rather than used (`APP_GRANT_DIFFERS`),
so a misconfigured installation cannot silently escalate.

### 9.3 Implementation

- RS256 App JWT built locally: `iat` skewed 60 s back, expiry clamped to 60–600 s,
  RSA keys only, PKCS#1 and PKCS#8 both accepted.
- Installation tokens are repository-scoped to `project-wolf`; omitting the
  repository is an error, not a default.
- Tokens are `::add-mask::`-ed before anything is written, persisted to a
  mode-`0600` file, and never printed. The private key and the JWT never leave
  the process and never reach a file.
- Renewal is a re-mint inside a five-minute margin (`RENEWAL_MARGIN_MS`).
  Restart recovery is proven by `mint` twice from a cold start (`verify`).
- Secret names: `WOLF_FACTORY_APP_ID`, `WOLF_FACTORY_APP_PRIVATE_KEY`,
  `WOLF_FACTORY_{READER,PUBLISHER,DISPATCHER}_INSTALLATION_ID`. The legacy
  `WOLF_FACTORY_APP_INSTALLATION_ID` is still reported.
- Two supported entry points: `actions/create-github-app-token` pinned at
  `f418cff399f7aef4c2f0ad47e25ca7a6abbdd6fc` (v3.4.0), and the in-repo CLI
  (`scripts/private-ci-app-auth-cli.mjs`).

### 9.4 Fail-closed behaviour

`mint` exits 0 both when it mints an App token *and* when it falls back to the
PAT, so the workflow treats the **presence of the token file**, not the exit
code, as the authority. This was a real defect: the first run of the wired
workflow failed because the step sourced a file that legitimately did not exist
under fallback. It is repaired and pinned by a regression test.

### 9.5 Dispatch verification

The dispatch probe resolves its target workflow itself — an explicit id, then an
explicit file, then the oldest workflow the credential can see — so verification
does not depend on an operator setting. It dispatches once and compares the run
count before and after: a dispatch that creates no new run is reported as
suppressed, not trusted. Duplicates are reported, never retried.

### 9.6 Historical state snapshot — not current or reverified

Accepting run: `45492528355` on `5a55a7e` — `state: VERIFIED`, 13/13 checks,
private receipt `PUBLISHED`, every privacy flag `false`.


| Field | Value | Meaning |
| --- | --- | --- |
| `authentication.mode` | `pat-fallback` | No App secrets yet; the PAT is doing the work |
| `authentication.credentialsPrinted` | `false` | No credential material in any receipt |
| `dispatchVerification.state` | `BLOCKED` / `WORKFLOW_LIST_UNAVAILABLE` | The read-only PAT has no `actions:read`, so even listing workflows is refused |

Both are honest blocked outcomes, not passes. The PAT's scope is unchanged and
was **not** broadened to make the probe look green.

### 9.6a Renewal, expiry and revocation

`verify` previously reported VERIFIED while falling back, because it tested a
field that does not exist. That false green is repaired and pinned by a test: a
PAT run now returns `NOT_APPLICABLE` (exit 78) and only an App run that issued two
distinct, fresh tokens per role returns `VERIFIED`.

The recovery ladder distinguishes `FRESH` / `RENEW` / `EXPIRED` / `REVOKED` /
`FALLBACK` / `NONE`, re-mints only when the state demands it, heals a `401`
exactly once, and never treats a `403` as something a new token can fix.

### 9.7 Former setup request — withdrawn

The earlier request to create/install an App or supply named secrets is not a
current instruction. Do not create or store credentials based on this historical
section. Current activation prerequisites are listed in §11.3 and require
explicit approval and contract review first.

## 10. Historical App and CI claims — not current acceptance

The older text in this section described App-token experiments and workflow
receipts, then labelled them **“ACCEPTED”** and “live acceptance.” That wording is
withdrawn as current status. Referenced run IDs, App metadata, API responses, and
receipts were not re-fetched or independently verified in this review.

Those historical claims, even if accurate when written, describe GitHub API,
credential, and Home CI behavior only. They do **not** establish a current
admitted mission, real private-worker execution, authenticated callback,
correlated terminal settlement, or independent worker acceptance. The terms
`ACCEPTED`, `VERIFIED`, `PUBLISHED`, and `7/7 PASS` in older revisions of this
file must not be read as worker acceptance or authorization to dispatch.

No mission dispatch, private worker run, callback, or production write occurred
in this session. A public canary, fixture, unit test, green push run, or old
receipt is not a substitute for private-worker acceptance.

## 11. Current mission interface — code under review, not activated

The local listener accepts a GitHub `repository_dispatch` event only on the
listener workflow, validates the mission, and durably appends **admitted**
records to a hash-chained ledger plus a same-writer head anchor. Schema 2 stores
a domain-separated commitment over repository, mission id and source SHA rather
than raw selectors. Public Actions logs emit only the aggregate decision and stable
reason code, not the event payload. Refused events are not persisted to that ledger.
The bridge re-reads and verifies the exact commitment before private checkout.
This code has only fake-GitHub/unit-test evidence so far; no production admission
or mission run occurred.

The listener and bridge are absent from the default branch `main` (read-only
GitHub API lookups returned 404 for both workflow files on 2026-11-24). The former
worktree value `9679aa76397c7b248c3708be2c063e75a7058ae5` did not resolve. It is
now replaced in this candidate by `b3f397fd959f41c1a843e917b35e0a5914f53c11`,
which resolves through GitHub and whose tree contains the bridge, listener store,
and admission-gate files. Its reusable interface declares exactly `sha`,
`missionId`, `deliveryId`, and `executorSha`; the bridge also has a read-only
pre-job admission and a mandatory execution-time recheck. The older valid
`6c2848d1849d85e70ff3a9590a42b3df0465c487` predates the current executor input
and durable gate, so it was not substituted. This is repository-local pin and
interface verification only; no upstream contract, approval, activation, or
worker acceptance follows from it. No dispatch command is provided.

### 11.1 Non-executable schema sketch

The current local validator expects the following shape. This is pseudocode, not
a payload to submit; it intentionally contains no runnable SHA or timestamp:

```text
schemaVersion: 1
missionId: <8–128 characters matching the local schema>
repository: donraposo1-source/project-wolf
sha: <full lowercase 40-hex commit SHA>
issuedAt: <positive Unix epoch milliseconds, numeric; create at send time>
```

`issuedAt` is not ISO 8601. Optional `checks`, `attempt`, and `requestedBy` are
metadata only. The sender is taken from GitHub's event envelope; delivery
identity is derived from the GitHub run id; executor SHA is fixed by listener
policy. A mission may not choose a workflow, token, permissions, ref, or paid
execution.

The full key `missionId@sha` is used only in memory. Public ledger schema 2
stores a domain-separated SHA-256 commitment to the exact repository, mission ID
and target SHA, paired with the GitHub run id; this protects **admission replay**
without publishing those selectors. It does not establish external-effect
idempotency or authenticity. This schema has no separate nonce, signed callback,
lease/fence state, or authenticated terminal receipt. No compatibility claim is
made for Factory P1.59 / Factory 2 P1.47+ until their authoritative contracts are
reviewed against it.

### 11.2 Recovery and acceptance limits

There is no production durable execution queue, lease/fence settlement, or
scheduled recovery sweep. `scripts/private-ci-journal.mjs` and its CLI are
runner-local helpers/fixtures, not cross-run recovery. The admission ledger is
not an execution queue. A same-run rerun is not automatic recovery and must not
be used to replay unknown external effects.

A local `VERIFIED` receipt, if one is produced later, would only report the
bridge's exact-SHA checks. Worker acceptance additionally requires a real private
worker result, authenticated callback, run-to-terminal correlation,
independently verified evidence, and zero-cost confirmation. No fixture, canary,
credential probe, or public workflow run supplies that evidence.

### 11.3 Activation blockers

- Founder approval to place the listener on `main` and confirm its sender allowlist.
- Explicit review/approval of the now-verified immutable executor candidate and
  its workflow tree, exact inputs, durable admission gate, named secrets, and tests;
  the SHA/interface proof alone is not activation approval.
- Authoritative Factory / Factory 2 envelope and callback-contract reconciliation.
- The existing owner-approved durable recovery/queue path and terminal correlation.
- Independent security review and one explicitly authorized zero-cost validation.

Until these are resolved, do not dispatch a mission, create a second queue, or
call any old run a current acceptance result.
