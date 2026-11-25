# First Live Mission — Bounded Plan (Not Executed)

Prepared, not run. This describes the single bounded mission that would follow
activation, with its exact identity and acceptance criteria stated in advance so the
result cannot be reinterpreted afterwards.

## 1. Mission identity

```json
{
  "schemaVersion": 1,
  "missionId": "wolf-first-live-20261125-01",
  "repository": "donraposo1-source/project-wolf",
  "sha": "4fd43ffebfb87a9fbb74b4de1ded3af9c8bb1ca2",
  "issuedAt": "<within 1 hour of dispatch>"
}
```

| Field | Value | Why |
| --- | --- | --- |
| `missionId` | `wolf-first-live-20261125-01` | Unique, stable, dated; a retry reuses it so the key `missionId@sha` dedupes |
| `repository` | `donraposo1-source/project-wolf` | The only allowlisted source |
| `sha` | `4fd43ffe…` | The **current** PR #743 head, resolved live (see `docs/private-ci-target-resolution.md`) |
| sender | `insidethemarginmedia-cpu` or `donraposo1-source` | On the listener's authorized list |
| executor | `6c2848d1849d85e70ff3a9590a42b3df0465c487` | The approved pin |
| `deliveryId` | assigned by GitHub from the run id | Not caller-chosen, so replay protection holds |

**This requires a pin change.** The workflow currently pins `8d319fc`, which the
resolver reports as `STALE` against `4fd43ff`. A first mission must either:

- target `4fd43ff` (requires moving the pin — a founder decision), or
- explicitly accept `8d319fc` as a **historical baseline**, labelled as such, which
  is a different claim and must be written that way on the receipt.

Running a mission against a stale pin and calling it PR acceptance is the exact
failure this work exists to prevent.

## 2. Acceptance criteria — all must hold, none is sufficient alone

| # | Criterion | How it is observed |
| --- | --- | --- |
| 1 | Admission recorded | A listener admission record with `admitted: true` and the correct `missionKey` |
| 2 | Executor is the approved pin | The reusable-workflow call names `6c2848d…` |
| 3 | Exact private SHA executed | Receipt `acceptanceTarget.pinnedSha` equals the mission `sha` |
| 4 | Tree identity | Receipt `acceptanceTarget.treeIdentical` is `true` for that SHA |
| 5 | All blocking checks pass | 13/13, no `BLOCKED`, no advisory downgrade for `postgres-concurrency` |
| 6 | Independent test results | The private suite's own results, not inferred from exit codes |
| 7 | Private check published | A check exists on `4fd43ff` from this pipeline |
| 8 | Durable receipt | Receipt committed to the private publication branch, bound to the SHA |
| 9 | Duplicate suppressed | Re-sending the identical payload yields `DUPLICATE`, no second execution |
| 10 | Authenticated transport | `authentication.mode: github-app`, no PAT used |
| 11 | Zero cost | `EUR_SPEND=0`, no paid endpoint in the run |
| 12 | Correlated run | The listener event maps to exactly one executor run id |

HTTP 2xx, a green push-triggered run, or a `VERIFIED` state on a different SHA
satisfies **none** of these.

## 3. Adversarial cases to exercise around the first mission

Each is a test the transport must survive, run deliberately and recorded:

| Case | Expected |
| --- | --- |
| Duplicate delivery (same payload twice) | `DUPLICATE`, one execution |
| Expired mission (issuedAt > 1h ago) | `REJECTED / MISSION_EXPIRED`, no execution |
| Unauthorized sender | `LISTENER_SENDER_UNAUTHORIZED`, no execution |
| Invalid SHA (branch name, short SHA) | `REJECTED / MISSION_SHA_INVALID` |
| Unapproved executor SHA | `LISTENER_EXECUTOR_SHA_NOT_APPROVED` |
| Revoked credential mid-run | Fail closed; no fallback to a retired PAT |
| Crash recovery | A restarted run re-mints and completes, or refuses cleanly |
| Stale receipt | A receipt whose `acceptanceValid` is false is not counted as acceptance |

## 4. What would make the mission void

Any of these means the run is discarded rather than reinterpreted:

- the pin moved during the run
- the private SHA changed after admission
- the receipt was produced by a push trigger rather than the listener
- any check was downgraded rather than passed
- the ledger anchor changed underneath the run in a way the run did not record

## 5. Non-goals

- Not the eight-hour shift. That requires its own acceptance and is not implied by
  a green first mission.
- Not autonomous operation. One mission, one SHA, observed end to end.
