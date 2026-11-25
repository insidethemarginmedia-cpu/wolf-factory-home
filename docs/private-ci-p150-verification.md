# P1.50 independent verification follow-up

**Evidence cut:** 2026-11-25 (UTC). **Verdict:** **BLOCKED / NOT ACCEPTED**. The P1.50 Home-side patch passes its local regression suite, and the current Home integration head passes its own suite when tested with the repository object database. The two trees have **not** been combined or independently reviewed together. PR #3 is a draft with merge conflicts. Private PR #743, its current HEAD, and target-side check-runs remain unreadable to the authenticated GitHub identity; no live target execution or exact-SHA acceptance is claimed.

## Revision and publication boundary

| Item | Verified value |
| --- | --- |
| Authorized session branch | `arena/156d9fee-wolf-factory-home` |
| P1.50 source checkpoint tested | `d91645b65b91a987e3933bdbdc96818f000556f8` |
| Source checkpoint tree | `3766038d8cfed5ce5d1a72b65589f34c83927cb2` |
| Common branch point | `0e7c519a16fea7eb37c929885720cac87d9ffd3b` |
| Current Home integration branch when checked | `arena/38f3a7f7-wolf-factory-home` at `003b2488df3326c5b4a837b4a50625d9a355a339`, tree `a82b7b30253adc203f7103f69a2867e3b337d9e2` |
| Integration distance | 16 commits ahead of the common branch point; session source checkpoint is one commit ahead of it |
| Source-checkpoint diff accounting | 34 files, **3,813 insertions / 1,062 deletions** against `0e7c519`; all paths are CI source, tests, workflow, or related evidence/docs; no generated binaries or unrelated product files found |
| Review PR | [Home PR #3](https://github.com/insidethemarginmedia-cpu/wolf-factory-home/pull/3), base `arena/38f3a7f7-wolf-factory-home`, OPEN / DRAFT / CONFLICTING at last status refresh; the reviewed P1.50 source checkpoint is `d91645b…` |
| Existing integration PR | [Home PR #2](https://github.com/insidethemarginmedia-cpu/wolf-factory-home/pull/2), OPEN from the integration branch to `feat/public-runtime-probe-20261022`; unchanged by this audit |

The P1.50 session branch was pushed only to its authorized existing branch. I did **not** merge PR #2 or #3, rebase, force-push, dispatch a workflow, or modify a default branch. A local attempt to preview the integration merge exposed conflicts in the bridge workflow, evidence docs, and trigger-coverage test; it was aborted before committing. PR #3 therefore remains a draft/conflicting review artifact rather than a merge-ready combined implementation.

## Local validation — P1.50 source checkpoint only

| Validation | Result | Boundary |
| --- | --- | --- |
| `node --test tests/*.test.mjs` | **347 passed / 0 failed** | Home session source at `d91645b…`; local tests, not target acceptance |
| Focused OMEGA/adversarial group | **90 passed / 0 failed** | Synthetic API/process fixtures; no real credential or target run |
| `node --check` | **65 `.mjs` files passed** | Syntax only |
| `git diff --check` | Clean for the source checkpoint | Whitespace only |
| `@action-validator/cli@0.6.0` | Exit 0 | Warns that `on.push.paths` and `on.pull_request.paths` globs are not validated; `actionlint` was not available |
| High-confidence credential-pattern scan | No real token/private key found | Hits are synthetic PEM/token fixtures in tests |
| Live target build, dispatch, or check-run | **Not performed** | Private PR #743 access unavailable; no live acceptance claim |

The current integration tree was tested separately from a temporary source archive with the local Git object database available: `node --test tests/*.test.mjs` passed **398/398** at `003b248…`. An initial archive-only test attempt lacked Git objects and failed only the two pin-resolution tests; the corrected read-only rerun passed both. These are separate suites on separate trees and **must not be added together as a combined acceptance count**.

## Original OMEGA-01 through OMEGA-11: local repair status

“Patched/tested” below means the P1.50 session tree has focused code and regression coverage. It does not mean the patch is integrated into the Home base, independently reviewed, or accepted by the private target.

| Finding | P1.50 session-tree result | Current independent-acceptance limit |
| --- | --- | --- |
| OMEGA-01 — fabricated/failed receipts could verify | **Patched/tested locally:** signed receipt schema, hash/signature, full required-check contract, state, SHA/repository, and mission/reservation bindings are checked; publisher path invokes verification. | No target receipt/check-run independently read. |
| OMEGA-02 — executor trusted caller SHA/non-Git root | **Patched/tested locally:** executor checks the actual Git checkout, remote/ref, exact commit/tree, and clean state before/after; receipt is source-bound. | No private checkout performed. |
| OMEGA-03 — reader credential inherited by target commands | **Patched/tested locally:** target commands use a separate OS identity and a reduced environment; adversarial tests attempt token, signer, Git metadata, log, and process-lifetime access. | Synthetic values only; no real credential exposure test. |
| OMEGA-04 — execution preceded mission validation / wrong SHA could settle | **Patched/tested locally:** a durable pre-execution mission-admission job gates inventory, probe, and execution; the admitted SHA/PR are passed downstream and the clone rechecks the PR head. | The session workflow conflicts with the integration workflow; no combined workflow run. |
| OMEGA-05 — ISO-8601 `issuedAt` rejected | **Patched/tested locally:** strict ISO-8601 and numeric timestamp handling; actor and fixed-PR checks remain mandatory. | No live mission submitted. |
| OMEGA-06 — runner-local/mismatched journal allowed replay | **Patched/tested locally:** Home-side durable reservation uses create-only Git refs for the exact mission key and per-actor hourly slots; errors and duplicates do not emit `accepted=true`. | Fake GitHub API tests only. This does **not** repair the separate P1.44 listener path described below. |
| OMEGA-07 — exposure audit returned false CLEAR | **Patched/tested locally:** audit examines workflow/job/step credential scope and target-execution reachability; the exact prior exposure fixture is rejected. | Static workflow audit only. |
| OMEGA-08 — six-check verifier vs thirteen-check executor | **Patched/tested locally:** one fixed thirteen-check contract is required end-to-end; omitted, failed, or extra unsupported checks reject. | No private target receipt. |
| OMEGA-09 — `privateSourceFetched=false` masked selected file reads | **Patched/tested locally:** inventory reports selected workflow/package file reads explicitly, distinguishes full-tree fetch, and does not publish workflow command arguments. | No current private inventory run; the selected-file metadata is still private content access. |
| OMEGA-10 — PR-head mismatch still reported `INVENTORIED` | **Patched/tested locally:** inventory queries only `refs/pull/<n>/head`, rechecks the fetched head, and returns BLOCKED for missing/mismatched/moving heads. | No current private PR head could be read. |
| OMEGA-11 — HTTP 204/other workflow could be called PASS | **Patched/tested locally:** dispatch is restricted to the configured workflow and requires a new correlated completed successful workflow run plus a completed successful target check bound to exact SHA and run ID. | No dispatch or target check-run was initiated/read. |

## P1.44 and later Home integration checkpoints

The latest fetched integration head is 16 commits beyond the common branch point, including P1.44 (`899571f`) and two subsequent target-resolution commits (`08e74ee`, `003b248`). The P1.44 JSON checkpoint is historical evidence, not a live acceptance receipt. Current integration tests pass 398/398 locally as described above.

### Option B listener — **do not activate**

- **Trust boundary present:** listener sender is derived from `github.event.sender.login`, not client payload, and an explicit allowlist is configured. The executor SHA is a full immutable value on an allowlist. The exact reusable-workflow pin `96cab355878d6ca37dcd6d40ab79b7ac595d1c22` exists in the Home Git object database and its tree contains `private-ci-bridge.yml`; the integration pin tests pass with Git metadata present.
- **Replay/rate limit not durable:** `scripts/private-ci-listener-cli.mjs` passes `deliveries: []` and `recentAdmissions: []` on every invocation. The listener workflow prints the admission record to logs but does not persist it. A repeated delivery gets a fresh run identity and the same mission key is not checked against prior persisted admissions. The concurrency group serializes runs but does not deduplicate them; the per-sender hourly cap is therefore not enforced by this workflow path.
- **Second privileged admission gate not established:** the listener workflow gates its reusable-workflow job on a Boolean output from the listener job, but the called bridge workflow accepts `sha`, `missionId`, and `deliveryId` without a durable admission record or sender proof and does not reverify that record. The caller passes target fields from the event payload rather than a verified persisted reservation. The P1.50 session workflow intentionally does not admit `workflow_call`, so it would fail closed rather than activate Option B if this session version were used.
- **Activation state:** no live listener run was initiated; the integration branch is not the default branch; PR #2 targets a feature branch. Option B remains **BLOCKED / NOT ACTIVATED** pending repair and independent review.

### Target resolver — static reporting is not yet an acceptance gate

The integration resolver reports STALE when its fixed pin differs from the current PR head, but its verdict primarily treats SHA equality as acceptance; it does not require the PR to remain open/unmerged or both tree resolutions to succeed. In the integration workflow the resolver step writes a report but does not gate subsequent execution on `acceptanceValid`. A later exact `refs/pull/743/head` clone comparison is a separate guard, but the workflow still has a fixed historical `WOLF_CI_SHA` rather than a trusted admitted target SHA. Current PR #743 HEAD is unknown here; neither the historical `8d319fc…` pin nor the user-reported `a866a4d…` SHA is confirmed as the current PR head.

### Retirement ledger — rollback and atomicity claims are unverified and contradicted by the call path

A synthetic Home-side reproduction against the integration implementation returned `integrity=TAMPERED, retired=false, safeToFallBack=true` for an edited ACTIVE ledger, and `integrity=ROLLED_BACK, retired=false, safeToFallBack=true` for a truncated chain with a known expected head. `hardenedRetirementVerdict` falls through to `safeToFallBack=true` for non-retired TAMPERED/ROLLED_BACK states.

Additional static findings:

1. The CLI persistence path appends `retirementRecord()` JSON directly; it does not use the integrity module's `appendRecord()` hash-chain writer. The runtime ledger therefore does not receive the claimed chain hash/sequence from that path.
2. Workflow hydration has `continue-on-error: true` and maps every API read failure to an empty ledger. `retirement-check` uses `readLedgerVerdict`, not the hardened verifier, and the workflow supplies no independent expected head or sequence.
3. The workflow exports `WOLF_CI_RETIREMENT_LEDGER_TEXT` as a **file path**, while `selectCredential()` treats it as ledger text. That is not a verified content read. The per-run flag can enforce a visible RETIRED line after a successful hydrate, but it does not establish rollback/deletion protection when hydration fails or the entry is absent.
4. Persistence is a read-then-write Contents API update with a file SHA, a single attempt, `continue-on-error`, and no conflict retry/merge. `mergeLedgers()` is not called by the workflow; its code comment says local wins while iteration order actually lets remote win for identical sequence keys.

**Retirement status:** do not claim hash-chain enforcement, rollback resistance, or atomic concurrent writes. A failed or unverifiable ledger must not authorize fallback.

## Exact-SHA acceptance matrix and current blockers

| Gate | Evidence | Verdict |
| --- | --- | --- |
| Home P1.50 source tests | 347/347 at `d91645b…` | **LOCAL PASS ONLY** |
| Home integration tests | 398/398 at `003b248…` | **SEPARATE LOCAL PASS ONLY** |
| Current private PR #743 HEAD | `gh api` reads return HTTP 404 for current identity | **UNKNOWN / ACCESS UNAVAILABLE**; not proof of absence |
| User-reported target SHA `a866a4d…` | Not independently resolved in the private repo | **UNVERIFIED** |
| Historical Home pin `8d319fc…` | Present in Home workflow/checkpoint only; no current target-side PR binding | **NOT ACCEPTED** |
| Private target check-run / completed execution | No target API access; no dispatch initiated | **NOT VERIFIED** |
| Option B durable replay / second gate | Static listener path uses empty replay arrays and has no persisted record | **FAIL / BLOCKED** |
| Retirement rollback / atomic persistence | Synthetic fail-open reproduced; runtime writer/reader and workflow path do not establish the claims | **FAIL / BLOCKED** |
| P1.50 review PR against integration | PR #3 is OPEN/DRAFT but CONFLICTING | **REVIEW PUBLISHED; COMBINED IMPLEMENTATION NOT YET REVIEWABLE/ACCEPTED** |
| Factory / Factory 2 live state | Private access unavailable; only dated historical evidence exists | **UNKNOWN** |

## Remediation contracts before any activation or acceptance

1. **Admission:** create a durable create-only reservation before emitting `admitted=true`; bind authenticated sender, stable delivery identity, mission ID, target repository/PR/SHA, executor SHA, rate slot, and run. The privileged workflow must consume the reservation's immutable values and independently verify its integrity/existence. Replays, store errors, rate-limit errors, and missing second-gate proof must deny execution.
2. **Target resolution:** require readable PR metadata, open/unmerged status, exact requested SHA equal to the live PR head, and resolved tree identity; make the workflow gate execution on that verdict. Any unreadable, stale, closed, mismatched, or incomplete resolution must be non-accepting.
3. **Retirement ledger:** write the chained format used by the verifier; pass the actual file contents and an independent expected head/sequence into every selector; distinguish a known never-created ledger from API/storage failure; fail closed on tamper/rollback/unavailability; update by compare-and-swap with bounded conflict retry and verify the committed head after write. Add adversarial tests for tamper, truncation, deletion, API failure, concurrent append, and merge integrity.
4. **Acceptance:** only a newly created, completed target run and completed successful check-run correlated to the same target SHA and run ID may be reported as accepted. An HTTP 204, synthetic receipt, stale pin, or Home-side summary is insufficient.
5. **Review/activation:** resolve the integration conflict on the authorized session branch without force-push, run the combined suite/workflow validation, and obtain independent review before Option B activation. Do not merge this PR or deploy from this evidence.

## Access and guardrails

The current GitHub identity cannot read `donraposo1-source/project-wolf` PR #743 or the queried target SHAs (HTTP 404). This is recorded as **access unavailable**, not repository/PR absence. No private source was fetched, no target workflow dispatched, no credential value read or published, no merge/deployment/billing change made, and `EUR_SPEND=0` throughout. Home was notified with a comment on the existing [PR #2 coordination thread](https://github.com/insidethemarginmedia-cpu/wolf-factory-home/pull/2#issuecomment-7165167110); the full verification report and blocker summary are also published in [draft PR #3](https://github.com/insidethemarginmedia-cpu/wolf-factory-home/pull/3). No existing Factory 2 or Kilo & Co GitHub issue/PR/channel was identifiable in repositories visible to this identity, so those notifications could not be sent without creating or guessing a destination. No unrelated third-party channel or new issue was created.
