# Wolf Omega P4.0/P4.1 — engineering repair handoff (2026-10-31)

Branch: `arena/35e73e30-wolf-factory-home`, forked from `653b58a0322960cbad768069f92ce42b911644a1`
(tip of `fix/omega-acceptance-ready-20261028`, PR #1 head, still OPEN / DRAFT / UNMERGED).
Nothing was merged, promoted, force-pushed, dispatched or replayed. The original Mission B
(`OMEGA_B_41040712384`, run `41040712384`) was not touched; its four durable records are now
guarded byte-for-byte by `tests/omega-b-preservation.test.mjs`.

Machine-readable companion: `docs/checkpoints/omega/WOLF-OMEGA-P4-20261031.inventory.json`.

## 1. Access matrix (live evidence, this session)

| Surface | State | Hard evidence |
| --- | --- | --- |
| `insidethemarginmedia-cpu/wolf-factory-home` | GRANTED | `git ls-remote`, `gh api` → 200; full history fetched |
| `donraposo1-source/project-wolf` (private Factory) | **BLOCKED** | `gh api repos/donraposo1-source/project-wolf` → 404; `gh api .../branches/feat/factory-real-worker-m1-20261006` → 404 |
| Actions **run/job/step metadata** for run 41201041594 | GRANTED | `gh api .../actions/runs/41201041594/jobs` → step names, conclusions, timestamps |
| Actions **log archives** | **BLOCKED** | `gh run view --log` → `results-receiver.actions.githubusercontent.com` EOF (host outside egress allowlist); annotations API returns only "Process completed with exit code 1" |
| Run **artifacts** | NONE EXIST | `gh api .../runs/41201041594/artifacts` → `total_count: 0` (also 0 for run 41193744041) |
| **workflow_dispatch reproduction** | **BLOCKED** | `gh api -X POST .../workflows/private-controller-preflight.yml/dispatches` → `403 Resource not accessible by integration` (session token lacks `actions:write`) |

Consequences, stated plainly: the failing test file and the two modules under repair
(`infra/autonomy/boxxkite-jules-test-runner.mjs`, `infra/autonomy/boxxkite-transport.mjs`,
`tests/wolf-boxxkite-jules-test-runner.test.mjs`) live **only** in the private repository, cannot be
read, executed or patched from this environment, and no change to them was fabricated. Live CI
reproduction by dispatch is also blocked by token scope. Both blockers are recorded with their exact
errors above; everything else below was executed, not proposed.

## 2. P0-A — CI failure `JULES_ISOLATED_TEST_FAILED_OR_UNRESOLVED`: what the public evidence proves

Failing run: [41201041594](https://github.com/insidethemarginmedia-cpu/wolf-factory-home/actions/runs/41201041594),
job `integrated-factory`, step 10 `Full private regression and build` (the step that runs
`npm ci --prefix infra/worker-router/mastra-runtime`, `npm test`, one extra `node --test` file, `npm run build`).

Step-duration telemetry collected through the Jobs API (UTC):

| Run | Public SHA | Step 10 window | Duration | Outcome |
| --- | --- | --- | --- | --- |
| 41201041594 | 653b58a | 12:27:09 → 12:27:30 | **21 s** | FAILURE |
| 41193744041 | ac7383a | 10:42:27 → 10:42:48 | **21 s** | FAILURE |
| 41195261777 | ac7383a | 11:04:55 → 11:05:32 | 37 s | success |
| 41152854023 | e2eeed6 | 00:58:11 → 00:58:52 | 41 s | success |
| 41064289201 | 637bda5 | 13:35:04 → 13:35:37 | 33 s | success |
| 41042718440 | a218315 | 10:43:46 → 10:44:18 | 32 s | success |
| 41040259520 | 0e470ba | 10:23:43 → 10:24:16 | 33 s | success |

**Confirmed from this telemetry**

1. Both failing runs terminate the step after ~21 s; every passing run needs 32–41 s. Under the
   step's default `bash -e` shell, a failing `npm test` (exit 1) aborts the step before the extra
   admission test and `npm run build` — the 11–20 s deficit is exactly the skipped tail. So the
   private suite **ran to completion** (consistent with the founder-reported 1,300 PASS / 1 FAIL /
   1,301 TOTAL) and the step failed on the suite result, not on npm, the checkout or the build.
2. The identical 21 s failure signature occurred twice, ~105 minutes apart, on **two different
   public SHAs** (ac7383a and 653b58a). The public-side commits between those runs changed only
   workflow gating and runtime scripts — nothing the private `npm test` imports.
3. Run 41193744041 (FAIL, ac7383a, 10:41) and run 41195261777 (SUCCESS, ac7383a, 11:03) share the
   same public SHA 22 minutes apart. If the private HEAD did not move in that window, this pair is
   direct proof of **non-determinism** (flakiness) in the private suite. The private HEAD per run is
   resolved inside `factory-source-admission` and is not observable from here — this remains a
   strongly-supported inference, not a confirmed fact.

**Hypothesis status (unchanged in kind, upgraded in support):** the synthetic Jules isolated-test
scenario polls a detached child with a short interval and a bounded poll count; under `node --test`
file-level parallelism on a 4-core GitHub runner the detached process is scheduled late, the poll
budget is exhausted before the JSON receipt is observable, and the runner reports the fail-closed
`JULES_ISOLATED_TEST_FAILED_OR_UNRESOLVED`. Isolated Composio executions pass because there is no
co-scheduled contention. This matches every public observation above, but it is **not proven**: the
state machine, poll budget and receipt writes are private code this session cannot read.

**Repair constraints for the private-side fix (design contract, not a fabricated patch):**

- Distinguish `STARTING` / `RUNNING` / `COMPLETED` / `FAILED` / `RECEIPT_MISSING` at the polling
  boundary; never collapse "process still alive" into "unresolved" without a terminal-state probe.
- On poll-budget exhaustion, perform exactly one bounded terminal reconciliation (child exit status
  + final receipt read) before declaring UNRESOLVED. This converts the race into a deterministic
  decision without lengthening the happy path and without unbounded waiting.
- Receipt writes must be atomic (temp file + rename) so a poller can never observe partial JSON;
  receipt reads must tolerate `ENOENT` but never a torn file.
- Make the test's poll budget contention-aware (or serialize that one test file via the existing
  runner's concurrency controls). Raising constants alone is forbidden by the mandate and would
  leave the race in place.
- Fail-closed semantics preserved: `COMPLETED` only from a complete receipt with a matching job id;
  anything else stays `FAILED`/`UNRESOLVED`; sandbox cleanup stays mandatory on every terminal path.

**Exact files required to execute the private-side repair** (requested, not invented):
`infra/autonomy/boxxkite-jules-test-runner.mjs`, `infra/autonomy/boxxkite-transport.mjs`,
`tests/wolf-boxxkite-jules-test-runner.test.mjs`, plus the private `package.json` `test` script
definition — at private HEAD `b0fc7815df993579b4d270c694ab9e2a86ed40c6` (or its current successor).

## 3. P0-B — two-job recovery hardened on the public side (executed)

Defect found in the existing public `runner-loss-recover` restore step (pre-fix, 653b58a):

1. Every read failure was flattened into one opaque `DURABLE_CHECKPOINT_READ_FAILED`
   (`catch(() => …)` swallowed the real reason), so a missing checkpoint, an oversize body, a
   corrupt envelope and an already-present target were indistinguishable in CI logs.
2. The envelope was handed to the private restore **without any public-side identity or integrity
   validation**: no check that `context.sourceSha` equals the admitted private source SHA, that
   `context.runID` equals the recovering run, that `context.workflowID` is the runner-loss workflow,
   or that the sealed structure is the exact canonical 8-key envelope the publisher produced.

Correction (`.github/workflows/private-controller-preflight.yml`, restore step of
`runner-loss-recover`): a marked, unit-testable `restoreSealedRunnerState(env, fetchImpl, writeImpl)`
gate, structurally symmetric to the already-tested `publishFeatureCheckpoint`:

- Scope + economic admission before any IO (`RESTORE_SCOPE_DENIED`, `RESTORE_COST_DENIED`);
  pins (SNAPSHOT_SHA/run/source SHA/RUNNER_TEMP) validated up front (`SNAPSHOT_SHA_REQUIRED`,
  `RESTORE_CONTEXT_REQUIRED`).
- Exactly one bounded fetch from the immutable
  `raw.githubusercontent.com/…/{SNAPSHOT_SHA}/docs/checkpoints/runner-loss/{RUN_ID}.json`
  (`redirect:'error'`, 20 s abort, 1 MiB cap). No polling loop, no retry: `fetchCount:1, retryCount:0`
  are asserted by tests and echoed in the `WOLF_RUNNER_STATE_RESTORE_GATE` receipt.
- Distinct fail-closed dispositions: `RESTORE_CHECKPOINT_MISSING` (404) vs legacy
  `DURABLE_CHECKPOINT_UNAVAILABLE` (other non-OK) vs legacy `DURABLE_CHECKPOINT_READ_FAILED`
  (network) vs legacy `CHECKPOINT_LIMIT` vs `RESTORE_CHECKPOINT_CORRUPT` (canonical-form, key-set,
  version/algorithm, base64 field-size violations, duplicate-key smuggling) vs
  `RESTORE_CHECKPOINT_IDENTITY_MISMATCH` (wrong source SHA / run / workflow identity) vs
  `RESTORE_TARGET_EXISTS` (exclusive-write collision = duplicate restore attempt).
- Byte-exact exclusive write (`wx`, 0600) to the same `RUNNER_TEMP/wolf-runner-state.envelope.json`
  the private restore already consumes — existing API untouched.

Canonical-form strictness is evidence-backed, not assumed: **all three** real published envelopes
(`40238444987`, `40621309211` — both from the private `wolf-dbos-runner-state.mjs publish` path on
the probe branch — and `40941257246` from the feature-branch publisher) are byte-canonical
`JSON.stringify(envelope)+"\n"` with the identical 8-key schema and `wolf-runner-loss-{run}` context.

Verification: `tests/runner-state-restore-gate.test.mjs` (9 tests) extracts the gate from the raw
workflow and fault-injects it; the YAML-decoded heredoc was separately proven byte-identical
(after de-indent) and functionally identical (positive + negative smoke); the suite **fails against
the pre-fix workflow** (falsified). `tests/runner-loss-two-job-contract.test.mjs` (8 tests) pins the
whole two-job contract: distinct jobs, B gated on A success, durable-Git-only transport (no
artifacts anywhere in the workflow), fence advancement + stale-fence/expired-lease guard reasons in
both hook copies, duplicate-wakeup rejection with zero new effects, verified destruction on both
sides, non-cancelling concurrency group, fresh per-run mission identities, zero-cost env on both jobs.

**Live two-job acceptance: NOT VERIFIED** — dispatch is blocked (403, above) and no authorized run
executed these jobs during this session. No claim of live acceptance is made.

## 4. P0-C — original Mission B protected (executed)

`tests/omega-b-preservation.test.mjs` (9 tests) freezes the four durable records byte-for-byte
(SHA-256 pins), re-validates the fenced-receipt digest chains at runtime
(`recordDigest == sha256(compact JSON)` for both the INTENT→b-intent and READY→continuation pairs),
asserts `state: INTENT` / `NEXT_READY` / `replayed: false` / `originalProcessTerminated: true`
remain as sealed, trip-wires any **new** tracked file referencing run `41040712384` (a silent FINAL
or reconciliation record can never appear without a deliberate test change), forbids any
machine-readable surface from converting the observation into a negative-creation or completed
disposition, proves no workflow or script can target the run or its execution identity, and
re-executes the read-only reconciliation contract for the exact original label: 39 listed sandboxes,
zero matches → `NO_MATCH_OBSERVED`, `createOutcome: UNKNOWN`, `automaticRetryAuthorized: false`,
one fetch, no mutation, no inference. When full Git history is present (not in shallow CI) the test
additionally proves the records are unchanged since their sealing commits
(`329967c7`, `572c4505`, `f567816a`, `55311484`).

Authoritative evidence that could establish a terminal disposition for the UNKNOWN creation
(specification only — nothing here authorizes retry): provider-side account audit logs or a support
attestation covering sandbox creations in the run window with the exact label; billing/usage records
showing whether a sandbox was metered; or the sandbox id itself observed by an authorized read-only
listing. Absent one of these, the disposition stays `UNKNOWN` and replay stays denied.

## 5. Fault-injection matrix (P0-D) — disposition

Executable now (all PASS, see inventory): corrupt checkpoint, missing checkpoint, incorrect source
SHA, duplicate recovery (gate-level exclusive write + workflow-level duplicate-wakeup contract),
concurrent recovery (non-cancelling concurrency group), stale KCT fencing token and expired lease
(pre-existing live-hook tests `git-publication-preflight.test.mjs` + new static pins), unknown
external effect (pre-existing `publication-reconciliation-superseded` / boxxkite diagnostic tests +
new preservation test), crash before/after checkpoint (static gating contract), crash after durable
Mission B intent (intent frozen + NEXT_READY semantics pinned), cleanup failure (verified-destruction
assertions both jobs).

**BLOCKED pending private source:** delayed detached-process startup, late completion after polling
timeout, failed isolated test, missing/malformed async receipt, duplicate DBOS scheduling at the
DBOS-runtime level. These five are exactly the private-module scenarios; their acceptance criteria
are written into §2's design contract so the private-side repair can be verified the moment the
files listed above are provided.

## 6. Verification receipts (this session)

```
node --test tests/*.test.mjs        182/182 PASS  exit 0   (156 baseline + 26 new)
node --test tests/runner-state-restore-gate.test.mjs     9/9 PASS   exit 0
node --test tests/omega-b-preservation.test.mjs          9/9 PASS   exit 0
node --test tests/runner-loss-two-job-contract.test.mjs  8/8 PASS   exit 0
node --check scripts/*.mjs tests/*.test.mjs              ALL_MODULES_PARSE=OK
YAML parse (yaml@2.9.1, out-of-tree)                     9 jobs OK
decoded restore step: bash -n OK; heredoc node --check OK
decoded gate == raw gate (after de-indent)               true
decoded gate functional smoke                            RESTORED + IDENTITY_MISMATCH negative OK
falsification vs pre-fix workflow (653b58a)              gate suite FAILS (marker absent);
                                                         two-job contract test 2 FAILS; rest pin
                                                         pre-existing contracts (pass before/after)
```

Zero-cost contract held end-to-end: no inference, no sandbox creation, no Jules, no CircleCI, no new
repository/PR/workflow/scheduler, no credential read, no production mutation, no merge, no replay of
the UNKNOWN effect. The only network operations were read-only GitHub API/git fetches against the
public repository and one denied dispatch POST (403, recorded above).
