# Zero-Touch Activation — Historical Notes (Withdrawn)

Status as of 2026-11-24: **BLOCKED / NOT ACTIVATED / NO PRIVATE-WORKER
ACCEPTANCE CLAIMED.** This page formerly contained GitHub App setup steps and a
“live acceptance” narrative. Those instructions and conclusions are withdrawn as
current guidance. Do not create an App, install one, store or rotate secrets,
dispatch a mission, or change repository settings based on this file.

A read-only GitHub API check on 2026-11-24 confirmed that `main` is the default
branch and that `.github/workflows/mission-listener.yml` and
`.github/workflows/private-ci-bridge.yml` are absent there. The former invalid
listener executor pin `9679aa76397c7b248c3708be2c063e75a7058ae5` has been replaced
for the public PR candidate with `b3f397fd959f41c1a843e917b35e0a5914f53c11`,
which resolves remotely and contains the exact reusable interface and admission
gates. This closes only the repository-local SHA/interface defect; it does not
authorize activation. The upstream Factory/Factory 2 contract, callback
authentication, durable execution recovery, and required approvals remain
unresolved. See [`executor-pin-recovery.md`](executor-pin-recovery.md).

No mission dispatch, private worker run, authenticated callback, production
write, new GitHub App, new secret, billing change, or spend occurred in this
session. The only current contract is the blocked status in
[`integration-contract.md`](integration-contract.md).

## Historical claims — not revalidated and not worker acceptance

Earlier revisions of this document reported App authentication experiments,
workflow runs, receipt publication, and a seven-check “acceptance” result. The
referenced run IDs and API responses were not fetched or independently verified
in this review. They are retained only as historical text, not as current
capability evidence or authorization.

Even if those prior Home CI or GitHub App API checks occurred as described, they
do **not** demonstrate a real private-worker mission. They do not establish an
admitted current mission, exact-SHA private execution, a real worker result, an
authenticated callback, correlated durable terminal settlement, or independent
acceptance. A fixture, unit test, local simulation, green public canary,
`state: VERIFIED`, HTTP 2xx, or successful credential probe is not a substitute.

The old section labelled “Status: ACCEPTED” and its run-specific acceptance
claims are explicitly withdrawn as claims of current acceptance. See
[`private-ci-bridge-evidence.md`](private-ci-bridge-evidence.md) for the historical
record, which is also non-authoritative for current operation.

## Do not use old setup or dispatch instructions

The former “Founder click” sequence, App manifest details, installation mapping,
secret names, token roles, run IDs, payload example, and `gh api .../dispatches`
command are stale and withdrawn. No dispatch command is provided here. The
current mission validator expects `issuedAt` as a positive Unix epoch timestamp
in milliseconds, not an ISO 8601 string; the authoritative upstream envelope is
still unverified.

Before any future activation, obtain explicit approval, reconcile the
Factory/Factory 2 contract, verify a real immutable executor commit and workflow
tree, confirm the existing durable queue/recovery owner, and secure independent
review. Do not add a second queue or scheduler. A canary or fixture must never be
reported as real private-worker acceptance.
