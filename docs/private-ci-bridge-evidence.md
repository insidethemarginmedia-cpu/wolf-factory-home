# Wolf Private CI Bridge — Acceptance Evidence

Status: **OPERATIONAL — thirteen checks execute at an immutable SHA and publish authenticated, SHA-bound receipts.**

This document records public, non-sensitive facts only: workflow names, commit
SHAs, check names, exit codes, durations and timestamps. No private Wolf source,
log, credential or configuration value is reproduced here.

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

## 2. Checks executed at the immutable SHA

All thirteen run against a checkout asserted equal to the requested SHA. Every
check is **blocking** — there is no advisory tier.

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

## 3. Published artefacts

| Artefact | State |
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

## 4. Durable operation

`scripts/private-ci-journal.mjs` keeps an append-only journal keyed by
repository + SHA:

- repeated triggers for one SHA collapse onto a single request;
- cancellation is terminal, and a completed request is never re-armed;
- leases expire after 20 minutes and are reclaimed by an hourly sweep, recording
  `recoveredFrom` in the receipt, so a crashed runner cannot stall the queue;
- triggers: `push`, `workflow_dispatch`, `repository_dispatch`, `schedule`.

Verified across three real runs (`b56c795`, `2b9811e`, `3628709`), each
producing exactly one `wolf-private-ci-743` check run — duplicate suppression
holding in practice, not only in tests.

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

## 8. Local verification

`node --test tests/*.test.mjs` → **141 passing, 0 failing**, covering the bridge,
probe, dispatch diagnosis, inventory, executor, workflow reader, schema
provisioning, receipt publication, private status checks, durable journal,
workflow pin resolution and workflow environment declaration.
