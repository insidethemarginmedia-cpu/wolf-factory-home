# Authorization recovery checkpoint — 2026-11-27

This checkpoint is not operational acceptance or permission to activate a mission.
The existing integration work remains in [Home PR #2](https://github.com/insidethemarginmedia-cpu/wolf-factory-home/pull/2); the independent review is [PR #3](https://github.com/insidethemarginmedia-cpu/wolf-factory-home/pull/3). Do not duplicate those branches or treat this inventory as their replacement.

## Current session evidence

The supplied GitHub session authenticated as `donraposo1-source`. Repository metadata, workflow, issue, pull-request and HEAD check-run reads succeeded for Home and Compute. GitHub reports Home `WRITE` and Compute `ADMIN` as repository-level viewer roles; these roles do **not** prove the current credential has every endpoint permission. The Actions policy read returned 403 for both repositories. All six reads returned 404 for `donraposo1-source/project-wolf` and `insidethemarginmedia-cpu/composio-engineering-kit`; 404 cannot distinguish absence from lack of access. No private source or credentials were retrieved.

Run `node scripts/github-access-audit.mjs` to reproduce the fixed, read-only endpoint checks. It requires `gh` authentication and Node.js, reports HTTP status only, and exits nonzero if any repository metadata read is not successful. Endpoint readability is not proof of write, dispatch, runner cost, or authorization. A 403 can also indicate rate limiting; consult GitHub access configuration before concluding which permission is missing. Tests: `node --test tests/*.test.mjs`.

The Arena-provided session is environment-authenticated; this checkout cannot refresh or replace its injected credential. Reconnect/refresh the GitHub connection through Arena and verify the app installation/repository selection and necessary endpoint permissions, then rerun the audit. Do not post or store credentials.

## Blocked boundaries

- The existing [Compute coordination issue #2](https://github.com/donraposo1-source/wolf-compute/issues/2) requests the authoritative admission, authenticated callback, durable recovery and terminal receipt contracts. A public canary is not a private-worker contract or acceptance.
- PR #2 explicitly remains unactivated pending contract reconciliation, recovery ownership, isolation/cost evidence and independent approvals. PR #3 reports security blockers and is conflicting with its integration base. Do not merge or activate as a workaround.
- No dispatch, private execution, billing changes, paid fallback or production write was attempted. GitHub-hosted execution costs and provider authorization have not been established for a new run; `COST_UNKNOWN=DENY`, `PAID_FALLBACK=DENY`. The local unit tests and metadata reads do not establish end-to-end acceptance.

A push of the audit to the current Home branch succeeded, demonstrating that specific contents write. An attempted coordination comment on Compute issue #2 was denied by GitHub with `Resource not accessible by integration`; no comment was published. The Compute viewer `ADMIN` role therefore must not be mistaken for issue-comment write permission of this session's credential.
