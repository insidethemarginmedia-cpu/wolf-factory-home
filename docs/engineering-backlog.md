# Canonical Wolf Factory engineering backlog

This is the single ordered infrastructure backlog. Other documents are evidence and implementation detail, not competing task lists. Re-evaluate the order at the start of each engineering mission; never bypass the authorization, privacy, billing, or approval gates below.

## Current state

- Factory Home PR [#2](https://github.com/insidethemarginmedia-cpu/wolf-factory-home/pull/2) is open and not approved. Its executor pin/interface defect is resolved for the public candidate; no activation or private-worker acceptance is established.
- Public validation has passed on earlier PR heads, with private-path jobs skipped. The preserved historical baseline is `node --test tests/*.test.mjs`: **491 passed, 0 failed**. The current dirty worktree now passes **502/502** local regression tests; this is not a private workflow run or public CI result.
- The current session has read access to public Wolf Compute, but no confirmed read access to private Project Wolf. Wolf Compute issue [#2](https://github.com/donraposo1-source/wolf-compute/issues/2) remains unanswered; a prior attempt to add a comment was denied with 403. Do not retry that write without authorized access.
- No mission, worker run, authenticated callback, production write, deployment, merge, or dispatch occurred. `EUR_SPEND=0`.

## Ordered work

1. **BLOCKED — Recover Build Wolf PR #749 from its authoritative repository.** Repository owner/URL, PR branch, and exact head SHA are not established by the visible GitHub inventory. Do not infer from a PR number. Continue unrelated work; resume this item when the authorized repository identity is available.
2. **BLOCKED — Re-establish read-only access to private Project Wolf.** The current GitHub API request returns 404. Last historical checkpoint: branch `feat/factory-real-worker-m1-20261006`, SHA `4c9726d2a964ad32b01263b4a5e3b9a7014660fe` (not a current-head claim). Recover and synchronize only if existing authorized read access returns; do not create another repository or ask for credentials in chat.
3. **BLOCKED — Reconcile versioned upstream contracts and obtain consumer acknowledgement.** Need authoritative Build Wolf/Factory/Compute contracts for mission admission/dispatch, callback authentication and retries, terminal receipts, leases/fencing, idempotency, and durable recovery ownership. Publish only through an authorized repository-mediated channel and verify an actual consumer acknowledgement; tests and public canaries are not acknowledgements.
4. **BLOCKED — Establish private exact-SHA CI acceptance without source or credential exposure.** The candidate separates target metadata, private execution, and aggregate status publication; revokes its read token before private code and keeps package/test output runner-local. It still uses `ubuntu-latest` with outbound network access, so source non-disclosure is not guaranteed. Independently verify an actual private-runner egress boundary, billing, and provider authorization before setting any of the workflow's fail-closed approval variables. Public Home CI passing is repository validation only; private jobs remain skipped. No inference, private fetch, or dispatch without zero-cost owner admission and independent approval.
5. **BLOCKED — Obtain independent review and required owner approval for PR #2.** Review request is pending; no review or approval is recorded. Keep the PR open and inactive. Do not merge as a substitute for upstream contracts or permission.
6. **BLOCKED — Controlled merge and bounded end-to-end mission.** Only after items 1–5 and the executor pin, recovery ownership, trusted-caller gate, exact-SHA contract, callback authentication, receipts, retries, idempotency, interruption recovery, EUR0 evidence, and independent acceptance are verified. Then use the existing Factory only, with one bounded mission; no duplicate controller, queue, repository, database, or scheduler.

## Completed in this mission

- Added a persistent-workspace manifest and recovery/sync utility that reuses the current Home clone, materializes public Wolf Compute locally, probes private read access without persisting credentials, and fast-forwards only clean expected branches.
- Added safeguards and tests for dirty/diverged worktrees, repository identity, branch pinning, and path traversal. Verified the local working files matched the existing PR head before safely fast-forwarding the local branch to it.

## Standing gates

`EUR_SPEND=0`; `COST_UNKNOWN=DENY`; `PAID_FALLBACK=DENY`; `UNVERIFIED_BILLING=DENY`; `UNVERIFIED_PROVIDER=DENY`; Jules is prohibited. No unauthorized production deployment, hosted database mutation, credential disclosure, destructive Git operation, or required-check bypass. Never claim private-worker acceptance from unit tests, a public canary, historical receipts, HTTP 2xx, or skipped-job green runs.
