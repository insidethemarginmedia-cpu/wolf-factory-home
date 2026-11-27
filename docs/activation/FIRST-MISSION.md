# First Mission Checklist — Historical and Blocked

Status as of 2026-11-24: **NOT AUTHORIZED / NOT EXECUTED.** This file is a review
checklist only, not a mission payload, dispatch runbook, or approval. No target
SHA, executor pin, sender identity, timestamp, or earlier acceptance statement in
this historical plan is current authorization. No mission, private worker run,
authenticated callback, or spend occurred in this session.

## Contract shape (illustrative only; not a dispatch payload)

The local validator expects `issuedAt` to be a positive Unix epoch timestamp in
**milliseconds**, as a JSON number (numeric strings are also parsed). The old ISO
8601 sample was invalid for this validator. A live timestamp must be created at
submission time; never reuse a historical value.

```text
schemaVersion: 1
missionId: <8–128 characters matching the local schema>
repository: donraposo1-source/project-wolf
sha: <full lowercase 40-hex commit SHA>
issuedAt: <current Unix epoch milliseconds, numeric>
```

This pseudocode intentionally contains no executable target SHA or dispatch
command. The authoritative Factory/Factory 2 envelope, nonce/replay rules,
callback authentication, and terminal receipt contract still need reconciliation.

## Preconditions — every item must be independently resolved

1. Obtain approval for the actual default-branch listener and its exact sender
   allowlist. The current listener is not on `main`; no default-branch change is
   authorized here.
2. Verify that the immutable executor pin resolves to a real remote commit and
   that its tree contains the exact reusable workflow inputs, durable admission
   gate, and tested implementation. A syntactically valid SHA is not sufficient.
3. Reconcile the authoritative Factory P1.59 / Factory 2 P1.47+ contract,
   including nonce/replay rules, callback signatures, lease/fence semantics,
   idempotency, and terminal receipts. The local schema does not supply these.
4. Verify the exact target SHA and its tree through the approved read path. A
   missing SHA must remain empty and fail closed; do not substitute a branch,
   tag, or baked-in value.
5. Confirm the existing durable queue/recovery owner and run-to-callback
   correlation. The admission ledger is not an execution queue; runner-local
   journal fixtures do not prove recovery.
6. Require exact-SHA private checks, real worker output, an authenticated
   callback, zero-cost evidence, and independent verification before describing
   anything as accepted.

## Evidence that would be required

- A durable admission record and anchor matching mission id, target repository and
  SHA, sender-issued delivery identity, executor SHA, and GitHub run id.
- A reusable-workflow run at the reviewed immutable executor commit, with the
  durable admission gate successful before private checkout or any secret/write
  step.
- Exact target/tree identity and all required blocking private checks.
- A real private-worker result and authenticated callback correlated to that run,
  plus an independent verifier's result.
- A durable terminal receipt and a cost record showing no paid fallback.

A fixture, unit test, local simulation, `workflow_dispatch` run, HTTP 2xx, green
public canary, or `state: VERIFIED` check receipt is **not** private-worker
acceptance. No one should dispatch until every prerequisite above is reviewed and
explicitly approved.

## Adversarial checks to retain

| Case | Expected result |
| --- | --- |
| Duplicate delivery or repeated `missionId@sha` | Refuse without a second execution |
| Expired or future-issued mission | Refuse before handoff |
| Unauthorized sender or empty allowlist | Refuse before handoff |
| Branch name, tag, short, missing, or malformed target SHA | Fail closed; no fallback |
| Unapproved or unresolved executor SHA | Refuse before private access |
| Missing/tampered admission ledger or anchor | Refuse before private checkout and credential mint |
| Failed admission gate followed by `always()` steps | No secret-bearing or write step runs; cleanup may still run |
| Crash, unknown external effect, or missing terminal receipt | State remains unknown; no automatic replay |
