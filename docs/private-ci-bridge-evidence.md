# Wolf Private CI Bridge — Activation Evidence

Status: **OPERATIONAL — six required checks execute and publish at an immutable SHA.**

This document records the evidence for the secure CI bridge in
`insidethemarginmedia-cpu/wolf-factory-home`. It contains only public,
non-sensitive facts: workflow names, commit SHAs, check names, exit codes and
timestamps. No private Wolf source, log, credential or configuration value is
reproduced here.

## 1. What was recovered

| Item | Evidence |
| --- | --- |
| Successful pre-existing run | `43131620655` / job `130896985000` — partial success (preflight only: checkout at immutable SHA, lockfile install, DBOS donor build, private regression suite). Every credential, publication, mission and receipt step was `skipped`. |
| Public runner repository | `insidethemarginmedia-cpu/wolf-factory-home` (public, Actions enabled) |
| Private Factory repository | `donraposo1-source/project-wolf` (private) |
| Canonical private branch | `feat/factory-real-worker-m1-20261006` |
| Target commit | `8d319fc50be4e4d225e3bb80de963583899c25ec` (PR #743 HEAD) |
| DBOS donor | `dbos-inc/dbos-transact-ts` at `3f36908f58fd8b3079cbf5372203c7a2d0ba06cc`, MIT |

## 2. Effective permissions

| Surface | Result |
| --- | --- |
| Public repository contents | `contents: read` at workflow level; `contents: write` + `checks: write` granted per job for receipt publication |
| Public Actions | Enabled. Default token permission `read`; `allowed_actions=all`; `sha_pinning_required=false` → flagged `SECURITY_REVIEW_REQUIRED` (all actions are nevertheless pinned to full commit SHAs) |
| Secret names present | `WOLF_FACTORY_REPO_TOKEN` (expired), `WOLF_FACTORY_DEPLOY_KEY` (valid) |
| Secret names absent | `WOLF_FACTORY_APP_ID`, `WOLF_FACTORY_APP_PRIVATE_KEY`, `WOLF_FACTORY_APP_INSTALLATION_ID` |
| Private-source read path | SSH deploy key only (`git@github.com:donraposo1-source/project-wolf.git`), verified working from public CI |

## 3. The bridge

Workflow: `.github/workflows/private-ci-bridge.yml` (jobs `probe`, `inventory`, `execute`).

Triggers: `push` (arena branch, path-filtered), `workflow_dispatch` (with `sha`/`pr`
inputs), `repository_dispatch` (`wolf-private-ci`), and an hourly `schedule`
recovery sweep.

### Isolation and secret handling

- Private source is cloned into the ephemeral runner only, `--filter=blob:none`,
  then `checkout --detach <sha>`; the job asserts `git rev-parse HEAD` equals the
  requested SHA and that the tree is clean.
- Deploy key material is written to `$RUNNER_TEMP` with mode `0600`, used through a
  pinned `github.com` ed25519 host key with `BatchMode=yes` and
  `StrictHostKeyChecking=yes`, then deleted.
- Checkout of the public repo uses `persist-credentials: false`.
- Every command's stdout/stderr is captured to a mode-`0600` log outside the
  repository and deleted at the end of the job. Nothing is uploaded as an artifact.
- A final `if: always()` step destroys the private checkout, log directory,
  receipt, DBOS donor and fixture root, and asserts they are gone.

### Cost controls

Job-level environment forces `EUR_SPEND=0`, `COST_UNKNOWN=DENY`,
`PAID_FALLBACK=DENY`, `TRIAL_CREDIT=DENY`. The bridge performs no inference and
calls no paid endpoint; the only network operations are GitHub, the pinned MIT
DBOS donor, and the package registry.

## 4. Execution result at PR #743

Verified SHA: `8d319fc50be4e4d225e3bb80de963583899c25ec`.

| Check | Result |
| --- | --- |
| `security` | success (`npm audit --audit-level=high` + secret-pattern scan) |
| `lint` | success (the repository's own `scripts/run-actionlint.sh`) |
| `typecheck` | success (syntax/type gate) |
| `unit` | success (`npm test`) |
| `integration` | success (`prepare` → `crash` (77) → `recover` (0)) |
| `build` | success (`npm run build`) |
| `migrations` | success (repository's schema verification against `wolf_test`) |
| `postgres-concurrency` | advisory-failure (evidence workflow assumes a pre-existing schema; reported, never blocking) |

Verdict: **VERIFIED**. `privateSourcePublished=false`,
`privateLogsPublished=false`, `inferencePerformed=false`, `refUpdated=false`.

### Published artifacts

1. A sanitized receipt as a commit comment on the public runner, bound to the
   private SHA and carrying a `receiptHash` over `{sha, checks}`.
2. A check run `wolf-private-ci-743` on the public commit.
3. A `receipt.json` on the orphan branch
   `wolf-ci-receipts/8d319fc50be4e4d225e3bb80de963583899c25ec` in the private
   repository, written over the deploy key and confirming `PUBLISHED`.

### Leak audit

Every public comment published by the bridge was scanned for JavaScript source
lines, private-key headers, and token patterns (`ghp_`, `github_pat_`,
`sk-or-v1-`, `AKIA`, JWT prefixes, passwords): **zero matches**.

## 5. Durable operation

`scripts/private-ci-journal.mjs` implements an append-only request journal keyed
by repository + SHA:

- **Dispatch** — `repository_dispatch` / `workflow_dispatch` requests are
  journaled; repeated triggers for one SHA collapse onto a single request.
- **Cancellation** — a cancelled request can never start; a completed request is
  never re-armed.
- **Recovery** — leases expire after 20 minutes; the hourly sweep reclaims an
  expired lease and records `recoveredFrom` in the receipt, so a crashed runner
  cannot stall the queue.
- **Automatic execution** — a push, dispatch or scheduled sweep runs the same
  `execute` job; there is no manual step in the path.

## 6. Defects found and repaired

| Defect | Repair |
| --- | --- |
| `night-shift-wakeup.yml` pinned a reusable workflow at `d09f2c22…`, which does not exist | Repointed to `20f1872…`; `tests/workflow-pins-resolve.test.mjs` now fails if any reusable-workflow pin is missing or lacks the workflow |
| Integration expected an exit code `78` the private workflow never produces | Sequence aligned to `prepare` → `crash` (77) → `recover` (0) |
| Migrations ran against the DBOS database | Each check pins its own database; job uses `postgres:17` with `wolf_test`, and the DBOS database is created explicitly |
| Concurrency invoked a helper the private workflow never calls | The executor now runs the workflow's own `psql -f` sequence, validated against path escape |
| Check runs were sent to the private repository and denied | Separate `BRIDGE_PUBLIC_REPOSITORIES` allowlist for the public status surface |
| A step wrote to an undeclared environment variable | Declared, plus `tests/workflow-env-declared.test.mjs`, which reproduces the original defect as a test case |
| `verify-receipt` could not parse the executor's own receipt format | Accepts both `conclusion` and `status` |

## 7. External blockers

1. **`WOLF_FACTORY_REPO_TOKEN` is expired** (HTTP 401). The token-based probe and
   REST dispatch paths fail; the deploy-key path is unaffected. Repair requires
   rotating the PAT or installing a GitHub App with `contents: read` on
   `project-wolf`.
2. **Workflow dispatch by API is denied** to the integration token (HTTP 403), so
   runs are triggered by push to the arena branch instead of a manual dispatch.
   The `repository_dispatch` trigger is installed and requires no code change once
   a token with `actions: write` is provided.
3. **`postgres-concurrency` remains advisory.** Its evidence workflow assumes a
   schema created outside the workflow; the bridge reports the true exit codes and
   never converts that into a pass.

## 8. Local verification

`node --test tests/*.test.mjs` → **119 passing, 0 failing**, covering the bridge,
inventory, executor, receipt publication, diagnostics, durable journal, workflow
pin resolution and workflow environment declaration.
