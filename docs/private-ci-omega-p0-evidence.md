# Project Wolf — Independent Verification Omega P0

**Evidence cut:** 2026-11-25T10:53:23Z. **Verdict:** **BLOCKED / NOT ACCEPTED** — the Home-side evidence can be checked, but current private-target, PR #743, Factory/Factory 2, and exact-SHA acceptance cannot be independently completed with the available read access. Several Home-side fail-open behaviors are reproducible. This report is not a claim of LEGO, Factory, or production acceptance.

## Scope and evidence rules

This review used the checked-out public Home repository, its local tests and source, public Home GitHub metadata/comments/check-runs, and existing historical checkpoints. The reviewer did **not** fetch private target source in this audit. API `404` responses under the current CLI identity are treated as **access unavailable / target indeterminate**, not as proof that the repository or PR is absent. This audit initiated no dispatch and ran no private target code; the pre-existing Home run's App-diagnosis check separately reports an HTTP 204 dispatch to `actionlint.yml`. No credential values were read and no merge, deployment, billing action, or infrastructure change was made.

Evidence labels used below:

- **Current local** — the Home checkout/source at the identified commit.
- **GitHub-reported** — public Home run/check/comment data; useful as a report of what that run claimed, not independent evidence of the private target's own check-runs.
- **Historical** — prior dated checkpoint; not refreshed or promoted to current acceptance.
- **Isolated repro** — temporary synthetic fixture using fake values only; proves local code behavior, not a live private run or exfiltration.

**Revision boundary:** The public Home run used controller SHA `6a7f982e29fee2775fd92be7e725805df5d973bd`; this audit's local source is `0e7c519a16fea7eb37c929885720cac87d9ffd3b`. They are four commits apart with different trees. Unless a row explicitly cites a GitHub-reported run artifact, current-source findings and local repros below describe the checked-out Home controller only; they do **not** establish that the older run executed the same scripts or that its private checks used the intended source tree.

## Current repository truth

| Surface | Observed truth | Status |
| --- | --- | --- |
| Session branch / checkout | `arena/156d9fee-wolf-factory-home`, HEAD `0e7c519a16fea7eb37c929885720cac87d9ffd3b`; worktree was clean before this report was added | Verified locally |
| Verified base branch | Remote `arena/38f3a7f7-wolf-factory-home` also resolves to `0e7c519a16fea7eb37c929885720cac87d9ffd3b` | Verified read-only with `git ls-remote` |
| Home default branch | `main` at `3742bcc76ee2a5a8ff09897dda6611d50a4ef053`; `feat/public-runtime-probe-20261022` at `20f1872da5f8e32cb4b5285fb28e591a8652a586` | Verified read-only |
| Existing Home PR #2 | OPEN from `arena/38f3a7f7-wolf-factory-home` at `0e7c519a…` into `feat/public-runtime-probe-20261022` at `20f1872…`; this session branch is not its head and was not pushed or changed remotely. | Read-only; not modified |
| Session branch remote ref | No `origin/arena/156d9fee-wolf-factory-home` ref was returned by `git ls-remote` | Not published remotely |
| Home commit used by reported run | `6a7f982e29fee2775fd92be7e725805df5d973bd`; compare against local HEAD reports four commits ahead and different trees | Run evidence is for an earlier controller revision |
| Private target access | Reads for `donraposo1-source/project-wolf`, PR #743, and its refs returned HTTP 404 for the current `gh` identity | **Unverified; do not infer absence** |
| Repository-local skills | No tracked/hidden `SKILL.md`, `AGENTS.md`, skill directory, or local skill loader exists in this Home checkout | 0/7 revalidated here |

## Evidence matrix

| Acceptance area | Evidence and limitation | Verdict |
| --- | --- | --- |
| Seven repository-local skills | Home checkout contains no skill files/loaders, so no repository-local activation could be performed. Historical checkpoint `docs/checkpoints/integrations/COMPOSIO-UNIFIED-FACTORY-ACCESS-20261104.md` reports Recovery, Debugging, Repair, Testing, Security, MCP, and Python as 7/7 loaded on 2026-11-04 and names a private Factory loader at that time. The private repo/HEAD and loader are not available for current verification. | **BLOCKED / historical only** |
| Home controller branch truth | Branch and remote refs listed above. The local controller is newer than the Home run reviewed below; the run's Home `head_sha` is four commits behind and has a different tree from local HEAD. The workflow YAML at the run SHA was fetched in the prior read-only review and confirmed the fixed target pin / separately handled request SHA, but this is not proof of every script body or command output that executed. Do not treat the run as testing current HEAD. | **VERIFIED locally; run not current** |
| Home run [`45540160074`](https://github.com/insidethemarginmedia-cpu/wolf-factory-home/actions/runs/45540160074) | Public API reports push event, Home `head_sha=6a7f982…`, completed/success, run #87, start `2026-11-25T03:27:57Z`, update `03:36:30Z`. Execute job `138956444632` ran `03:27:59–03:36:29Z` (~8m30s). A filtered log query returned no matching output; full/unfiltered logs and exact target checkout evidence remain outstanding. | **Home orchestration succeeded; not target acceptance** |
| `wolf-private-ci-743` check | Check-run `138959628052` is a success check attached to **Home** commit `6a7f982…`, with summary “SHA-bound private CI receipt: VERIFIED”. It is not a check-run independently read from the private target commit. | **Reported only; private check unverified** |
| Published receipt comment | The Home commit comment claims `VERIFIED` for private repository `donraposo1-source/project-wolf`, SHA `8d319fc50be4e4d225e3bb80de963583899c25ec`, PR #743, receipt hash `71ae171d0d6311e17e1e63e5c3be745621b755c869491d1056e7e181e7a6a8ab`. It is a published Home-side claim, not an independently read target check-run or proof of PR-head equality. | **Claim preserved; target run unverified** |
| App acceptance / dispatch | Home check-run `wolf-app-diagnosis` (`138956973754`) is neutral and reports 7/7 acceptance checks plus dispatch HTTP 204 to `.github/workflows/actionlint.yml`; the same diagnosis reports the minimal-permission dispatcher probe failed with HTTP 422. In the current checkout, the dispatcher can fall back to the first discoverable `workflow_dispatch` workflow; after HTTP 204 it records a run-count delta but returns PASS without requiring a new run or waiting for completion. The observed target was `actionlint.yml`, not evidence that the intended private CI workflow completed for the requested SHA. | **Capability evidence only; target execution not proved** |
| Private metadata probe | Home check-run `wolf-private-ci-probe` (`138956482808`) reports target commit `8d319fc50be4e4d225e3bb80de963583899c25ec` present and says private source was not fetched. PR/workflow/check-runs/protection/Actions reads returned 403. | **Commit-presence report only** |
| Deploy-key inventory | The sanitized inventory comment on the same run reports `sshAccess=true`, `commitPresent=true`, and `privateSourceFetched=false`. The current implementation clones with `--no-checkout`, then reads selected workflow and `package.json` blobs to publish derived metadata (not whole file bodies). Therefore the flag does not prove that no private file contents were fetched; the code does not publish the full source tree. | **Metadata inventory; source-read flag is misleading** |
| PR #743 alignment | The sanitized deploy-key inventory comment reports `pullRequestHeadMatches=false` and `pullRequestHeadRefObserved=true` for pinned `8d319fc…`. No exact PR-head SHA was published there; current PR metadata remains inaccessible. The current inventory implementation still returns `state=INVENTORIED` when this comparison is false. | **Mismatch at the run snapshot; current head unknown; not fail-closed** |
| Target SHA integrity | Current local workflow has three static `WOLF_CI_SHA` pins at `8d319fc50be4e4d225e3bb80de963583899c25ec`. `workflow_dispatch`/`repository_dispatch` request SHA is used in the journal path, not as the checkout identity; see findings. The comparison literal `7b0a592000000000000000000000000000000000` is not independently established as the authorized target SHA. | **FAIL CLOSED required; no authorized target SHA established** |
| Cross-repository mission | Current workflow executes the private checks before validating a `repository_dispatch` mission. The requested SHA is not compared to the fixed target pin. Mission validation, durable dedupe/rate limits, and timestamp parsing also have local gaps. | **BLOCKED / P0 controller defects** |
| Receipt integrity | `verifyReceiptBinding` accepts fabricated/failed receipts and ignores receipt schema/hash/state and checks outside its six-name default. The public `publish-receipt` path does not call that validator. | **FAIL CLOSED required** |
| Executor source binding | `executePrivateCi` accepts a 40-hex SHA without proving that `root` is a Git checkout at that SHA. An isolated non-Git fixture returned `VERIFIED`. The live workflow has a separate clone assertion, but the helper itself is not an independent source-integrity check. | **FAIL CLOSED required** |
| Credential separation | The App reader token is written to `$GITHUB_ENV` before private workflow commands run. The executor passes the ambient environment to child shells that execute target workflow commands. A synthetic fixture saw a fake reader token in the child. This proves a credential transfer path, **not** real-token exfiltration. The publisher token is minted after the executor and is not in that earlier path. | **P0 security boundary defect** |
| Economic controls | `EUR_SPEND=0`, `COST_UNKNOWN=DENY`, `PAID_FALLBACK=DENY`, and `TRIAL_CREDIT=DENY` are declared as environment values. The executor does not enforce network/provider denial; `inferencePerformed:false` is hard-coded in its receipt. No billing/account evidence for the run was independently read. | **Static policy only; economic acceptance unverified** |
| Factory / Factory 2 | Historical 2026-11-04 checkpoint reports private Factory HEAD `4c9726d…`, CI run `41738678409`, no active Boxxkite sandbox, offline persistent devices, and no live inference/mission. These are dated claims, not current Factory/Factory 2 health evidence. Current private access is unavailable. | **Historical only / current state unknown** |
| 15 / 60 / 480 minute gates | Current code has workflow timeouts of 5/10/45 minutes, a 20-minute journal lease, a one-hour mission age limit, and an hourly recovery schedule. No 15- or 480-minute Factory execution gate was found. The 60-minute mission-age limit is not a Factory execution-duration measurement. The Home execute job duration (~8m30s) is a GitHub Actions job duration, not a DBOS/Factory mission duration. Arena session duration was not used. | **NOT VERIFIED** |
| Historical receipts | Existing bridge/activation docs contain past “VERIFIED”, “PUBLISHED”, and “ACCEPTED” claims. They are retained as historical self-reports; this review did not restart those runs or treat them as current independent acceptance. | **Historical only** |

## Reproduced Home-side defects

All reproductions below used the checked-out Home source and synthetic values only. No private token, private source, real mission, or paid provider was used.

| ID | Severity | Reproduction / source path | Acceptance impact |
| --- | --- | --- | --- |
| OMEGA-01 | P0 | `verifyReceiptBinding` returned `VERIFIED` for a fabricated object with an unsupported schema, `state: FAILED`, a non-hash receipt value, all six default checks marked successful, and an additional `postgres-concurrency` failure. The helper checks only SHA, repository, and six names/outcomes; the current workflow publisher does not call this helper. | If this verifier is used as an acceptance gate, it can report a false green for a failed or incomplete receipt; it does not prove what the older live run published. |
| OMEGA-02 | P0 | `executePrivateCi` ran a passing synthetic workflow step from a temporary root with no `.git` metadata and emitted `state: VERIFIED` for an arbitrary 40-character SHA. | The executor’s SHA claim is caller-supplied unless the workflow’s separate clone guard is trusted; the helper itself does not bind code to SHA/tree. |
| OMEGA-03 | P0 | In an isolated temp GitHub-workflow fixture, a fake `WOLF_CI_APP_READER_TOKEN` in the parent environment was visible to the target workflow command spawned by the executor. Current workflow exports the App reader token through `GITHUB_ENV` before executor invocation. | Target workflow code receives a repository-read credential. No actual exfiltration was observed; untrusted-code status of the target commit is unknown. |
| OMEGA-04 | P0 | Workflow source order is `Execute …` at line 608 before `Validate the cross-repository mission` at line 614. `REQUEST_SHA` is used later by the journal; executor still uses the job-level fixed `WOLF_CI_SHA`. Settlement marks the request completed if the receipt says `VERIFIED`, without comparing the receipt SHA to the requested SHA. | A mission/input can be accepted or settled against a SHA different from the tested commit. |
| OMEGA-05 | P0 | A documented ISO timestamp such as `2026-11-25T00:00:00.000Z` is rejected as `MISSION_ISSUED_AT_REQUIRED` because validation applies `Number()` to the string. Existing tests use epoch milliseconds instead. | The published mission contract example cannot pass its own validator. |
| OMEGA-06 | P0 | The mission CLI reads `.wolf-ci/journal.jsonl`; workflow journal CLI writes `.wolf-ci/journal.json`; the mission CLI writes its record only to a temporary output file. The JSONL path is not written by the workflow. Two identical synthetic missions with the missing JSONL journal both returned `ACCEPTED`. | Duplicate suppression/rate limiting is not durably enforced by the deployed workflow path; declared `maxPerSenderPerHour` is not applied by the validator/CLI. |
| OMEGA-07 | P0 | `auditCredentialExposure()` returns `CLEAR` for the shipped workflow even though it contains the token export and later private-command execution. The guard treats the presence of `private-ci-app-auth-cli.mjs` as a masking path and does not model step/environment reachability. | Existing green exposure tests do not cover the reader-token-to-test-process path. |
| OMEGA-08 | P1 | The current job requests 13 checks, but `normalizeChecks` in the bridge verifier only allows the six `DEFAULT_REQUIRED_CHECKS`; supplying the job's 13 names to `verifyReceiptBinding` throws `BRIDGE_CHECK_DENIED`. The executor itself treats its planned checks as blocking, while the current public receipt publisher reads the executor receipt without calling this verifier. | The job, optional verifier, and publisher do not share one enforced required-check contract; the publisher's path does not cryptographically validate the receipt. This is a current-source finding, not proof about the older run. |
| OMEGA-09 | P1 | `inventoryPrivateRepository` sets `privateSourceFetched:false`, but it clones the repository and calls `git show` on workflow and `package.json` blobs, parsing their contents into derived metadata. | The public inventory flag can be misread as “no private file content was fetched.” The code does not publish complete file bodies or the full source tree; the flag needs a narrower, truthful definition. |
| OMEGA-10 | P1 | For the observed inventory snapshot, `pullRequestHeadMatches=false`. Current inventory code still returns `state: INVENTORIED`; it records the mismatch rather than rejecting it. | Inventory success is not a PR-head acceptance gate. A pinned commit present in the repository is not thereby proven to be the current PR head. |
| OMEGA-11 | P1 | The current App dispatcher may choose the first discoverable workflow when the configured workflow is not found. After HTTP 204, it records (but does not require) a higher run count and returns PASS without waiting for a successful completion or checking the dispatched run's SHA. | A dispatch acknowledgment can be reported as acceptance without proving the intended workflow started or completed successfully; the observed run reports `actionlint.yml`. |

The focused local command `node --test tests/private-ci-bridge.test.mjs tests/private-ci-execute.test.mjs tests/private-ci-mission.test.mjs tests/private-ci-mission-cli.test.mjs tests/private-ci-journal.test.mjs tests/private-ci-app-exposure.test.mjs tests/private-ci-app-acceptance.test.mjs` passed **96/96**. That focused run did not include `tests/private-ci-inventory.test.mjs`; it does not negate the reproductions above, and some passing assertions encode unsafe behavior. A prior full Home test run was **299/299** on Node `v22.22.3`.

## Local source pointers (checked-out HEAD only)

These line references are for Home HEAD `0e7c519a16fea7eb37c929885720cac87d9ffd3b`, unless explicitly marked as run metadata. They are static-review pointers, not proof that an older workflow run executed these exact file versions.

| Path | Lines / surface | Relevance |
| --- | --- | --- |
| `.github/workflows/private-ci-bridge.yml` | 280–301, 342–410 | Static SHA/check pins, zero-cost environment labels, reader-token export, private clone and exact-HEAD assertion. |
| `.github/workflows/private-ci-bridge.yml` | 608–663, 777–787 | Executor-before-mission-validation ordering, request SHA journaling, then settlement based on receipt state only. |
| `scripts/private-ci-bridge.mjs` | 201–207, 604–619 | Six-check allowlist and receipt binding helper. |
| `scripts/private-ci-bridge.mjs` | 791–909 | Public receipt/check-run publication reads the receipt state directly; `verify-receipt` is a separate CLI branch. |
| `scripts/private-ci-execute.mjs` | 166–184, 560–621 | Child process inherits `process.env`; helper accepts caller-supplied SHA and creates receipt state/hash without a local Git HEAD/tree assertion. |
| `scripts/private-ci-publish-receipt.mjs` | 26–64 | Private branch publication checks only SHA equality before force-pushing the receipt; it does not call `verifyReceiptBinding`. |
| `scripts/private-ci-mission.mjs` | 61–117, 120–183 | ISO timestamp conversion, 60-minute age limit, declared hourly cap, mission key/dedupe helper. |
| `scripts/private-ci-mission-cli.mjs` | 25–103 | JSONL reader path, dedupe call, separate output record write. |
| `scripts/private-ci-inventory.mjs` | 66–164 | `privateSourceFetched:false`, deploy-key clone, selected blob reads, PR-head comparison, and unconditional `INVENTORIED` success state. |
| `scripts/private-ci-app-acceptance.mjs` | 276–448, 568–610 | Dispatch reports status/run-count change without waiting for completion; static credential audit's limited pattern checks. |
| `scripts/private-ci-app-auth-cli.mjs` | 118–124; workflow lines 356–390 | Token file creation and reader token export into the job environment. |

## 15 / 60 / 480 gate detail

| Gate | What is present locally | What is not established |
| --- | --- | --- |
| 15 minutes | No corresponding private Factory execution gate in the checked-out Home code. | No current private Factory run, claim, or owner-issued gate receipt. |
| 60 minutes | Mission maximum age is 60 minutes; executor job timeout is 45 minutes; journal lease is 20 minutes. | Mission age is not run duration or a completion SLA. |
| 480 minutes | No 480-minute gate or current Factory runtime evidence was found in this checkout. | No long-running Factory execution was measured. |

## Build, security, and publication limits

- Target-source build/security checks were **not run** because private source access was unavailable. No Home root `package.json`, `actionlint`, or `shellcheck` is present in this checkout/environment, so those local commands were not available.
- The focused Home tests were run; they are contract/unit tests, not private-repository acceptance.
- No exact-SHA acceptance is claimed. The private PR head and target check-runs remain unreadable from this identity.
- At this initial OMEGA evidence cut (Home source `0e7c519a16fea7eb37c929885720cac87d9ffd3b`), no source code was changed; only the sanitized matrix and checkpoint were added to the then-unpublished session branch. The later P1.50 implementation and current verification are recorded in [`docs/private-ci-p150-verification.md`](private-ci-p150-verification.md). No other branch was changed or merged, and this initial audit initiated no external dispatch.

## Handoff / next safe action

To finish independent acceptance, grant read-only access through the **existing** GitHub connection/App to `donraposo1-source/project-wolf` sufficient to inspect PR #743 head, current refs, workflow/check-runs, and the existing seven-skill loader. Do not create a new App, PAT, key, or paid fallback. The responsible team should then review OMEGA-01 through OMEGA-11; the private target should remain blocked until exact requested SHA, PR-head equality, source isolation, receipt binding, credential isolation, dispatch completion, and durable mission idempotency are demonstrated. No change to LEGO PR #743 is proposed here.
