# Wolf Omega P0 — integration notes (Loop 3 review copy)

Status: **INDEPENDENTLY TESTABLE PATCH / NOT PUBLISHED / NOT PRODUCTION-ACTIVATED**
Source base: `insidethemarginmedia-cpu/wolf-factory-home` @ `061d9ffd05dc4b7f528087761755ca01468e324c`
(PR #1 head, `fix/omega-acceptance-ready-20261028`, still OPEN/DRAFT/UNMERGED).

## 1. What this patch is, and is not

It is a **pre-effect boundary library** plus adversarial regression tests. It is not a
Factory, control plane, scheduler, database, publication owner, worker adapter or
autonomous system. No existing component is replaced or rewritten: Flint, CEZAR,
OpenCode, Boxxkite transports, economic controls, KCT/DBOS durable recovery,
publication authority and checkpoints are untouched. Jules is denied, not replaced
by a second control plane.

The library performs **no** HTTP request, starts **no** mission, writes **no**
authority state and never claims completion. It only READS the existing Factory
authority/ledger through injected `ports`, re-verifies each record and denies before
the caller's existing external request.

## 2. Source availability (hard evidence, this session)

| Surface | Result |
| --- | --- |
| `insidethemarginmedia-cpu/wolf-factory-home` @ `061d9ffd…` | GRANTED; `git ls-remote`, `gh pr view 1` 200 |
| `donraposo1-source/project-wolf` (REST) | `404 Not Found` |
| `git ls-remote https://github.com/donraposo1-source/project-wolf.git` | `403 Write access to repository not granted` |
| canonical branch ref `feat/factory-real-worker-m1-20261006` | `404 Not Found` |
| PR #701 API / `.diff` URL | `404` / `http=404` |
| issue #699 API | `404 Not Found` |

Consequence: the canonical HEAD, PR #701 HEAD, the private Omega B/C Python
adapters, the proposed worker adapters, skill loaders, economic router and the
Loop 1–5 checkpoint bodies could **not** be read. Nothing was invented about them.
The failure classes were reproduced offline against an explicitly labelled
reconstruction (`tests/fixtures/omega-p0-legacy-adapter.mjs`) of the *reported*
pattern: caller-supplied fence/economic declarations reaching `POST /api/runs`,
and `COMPLETED` derived from a polling loop / mock response / exit status / session
id. Loop 3 must re-run the same negative cases against the real private modules
once scoped read access is granted.

## 3. Files and exact wiring

Source modules (`scripts/omega-p0/`):

| Module | Responsibility |
| --- | --- |
| `policy.mjs` | fail-closed constants, canonical JSON, SHA-256, exact-origin URL admission |
| `pre-effect-admission.mjs` | trusted 10-point pre-effect gate, exact-request binding, one-shot guarded dispatch |
| `worker-evidence.mjs` | authentic worker completion, polling-boundary non-success states, Jules-denied routing |
| `skill-loader.mjs` | canonical-path skill confinement, symlink/ancestor escape denial, inert manifests |
| `offline-install.mjs` | exact SHA-256, safe tar parse, atomic install + rollback, resumable chunk hashes |
| `recovery.mjs` | durable recovery guards over existing atomic ledger CAS operations |
| `index.mjs` | public barrel + integration contract |

### 3.1 Omega B/C before `POST /api/runs` (P0 §6)

```js
import {
  createPreEffectGate, withPreEffectAdmission,
} from './scripts/omega-p0/pre-effect-admission.mjs';

const gate = createPreEffectGate(existingFactoryAuthorityPorts, existingPolicyConfig);
const dispatch = withPreEffectAdmission(existingOmegaAdapter.dispatch, gate);
const result = await dispatch(request);   // identifiers only, NO authority declarations
if (result.state === 'DENIED_BEFORE_EFFECT') return persistDenyBeforeIO(result.reason);
```

`request` carries identifiers only: `missionId`, `attemptId`, `executionKey`,
`idempotencyKey`, `workflowId`, `workerId`, `workerType`, `workerEndpoint`,
`provider`, `account`, `model`, `endpoint`, `method`, `path`, `body`. Any field
named `fence`, `authorization`, `economicReceipt`, `costUsd`, `verified`, … is a
**denial**, not a claim. The gate derives all authority facts from `ports`.

### 3.2 `ports` must be adapters over the EXISTING authority/ledger

`readMission`, `verifyMission`, `readKctClaim`, `verifyKctClaim`,
`readCurrentFencingGeneration`, `readWorkflowOwnership`, `verifyWorkflowOwnership`,
`readLease`, `readWorkerRegistry`, `verifyWorkerIdentity`, `readEndpointRegistry`,
`readEconomicAuthorization`, `verifyEconomicReceipt`, `readExternalEffect`,
`readExecutionReceipt`, `verifyExecutionReceipt`, `readDurableCheckpoint`,
`readCheckpoint`, `readOwnerIdentity`, `readRunnerState`, `readDelivery`,
`compareAndSwapDelivery`, `compareAndSwapRecoveryLease`, `readNextReady`,
`compareAndSwapNextReady`, `readPublication`, `compareAndSwapPublication`.

These names are **integration seams**, not new tables. Loop 3 must bind them to the
existing KCT/DBOS authority, immutable ledger and independent verifier. A missing
port, a failed read or an unverifiable record is a fail-closed denial
(`AUTHORITY_PORT_MISSING` / `AUTHORITY_READ_FAILED` / `*_UNVERIFIED`). Tests use a
MAC-authenticated in-memory stand-in (`tests/fixtures/omega-p0-authority.mjs`).

`existingPolicyConfig` must supply the existing trusted endpoint origins, worker
endpoint origins, allowed paths, allowed providers, qualified accounts, supported
models, allowed worker types and a deterministic clock. Defaults are fixtures for
tests; production values come from the existing Factory policy, never from a caller.

### 3.3 Worker completion (P0 §5A)

Replace every `COMPLETED` derived from polling with
`evaluatePollingOutcome(...)` / `verifyWorkerCompletion(...)`. Only an authenticated
receipt re-read from the existing independent verifier, bound to the exact
mission/attempt/worker/job with bounded results, evidence digests, a current fence
and a durable checkpoint produces `COMPLETED`. Otherwise the state is
`NOT_VERIFIED` / `FAILED` with a stable reason.

### 3.4 Jules removal (P0 §5D)

`assertWorkerAllowed` / `chooseWorker` deny any worker type or id whose normalized
name contains `jules`, including fallback selection. `tests/omega-p0-worker-completion.test.mjs`
also statically scans every executable script and workflow for executable Jules
paths. Historical documentation and mission records are preserved.

### 3.5 Skill loaders (P0 §7)

`loadSkill` / `discoverSkills` canonicalize trusted roots, reject symlinks at every
path level (including ancestor-directory escapes), reject traversal/absolute paths,
allow data-only manifest keys and never import, eval or execute skill content.
Untrusted directories cannot inject executable instructions.

### 3.6 Offline tooling (P0 §7)

`installOfflineTool` verifies the exact SHA-256, parses a strictly bounded tar
(no symlink/hardlink/device/pax entries, no traversal, no setuid modes), verifies
`package/package.json` version, stages in an isolated workspace, installs with one
atomic rename, and rolls back deterministically on any failure. It has no network
API. `verifyResumableChunks` supports per-chunk SHA-256 reassembly so large
artifacts are never moved as Base64 through chat or command arguments.

### 3.7 Durable recovery (P0 §8)

`admitRecovery`, `consumeNextReady`, `recordPublication`,
`classifyExternalWindow` and `reconcileUnknownEffect` are guards called by the
**existing** recovery workflow. They revalidate KCT/checkpoint/lease/fence/owner,
use the existing atomic CAS ledger for duplicate delivery, concurrent recovery,
single NEXT_READY drain and single publication, and classify crash windows so a
lost response is `EFFECT_UNKNOWN` → `RECONCILE_ONLY` with `automaticRetry: false`.

## 4. Dependencies

* Node.js >= 20 (`AbortSignal.timeout`, `node:test`); verified on Node `v22.22.3`.
* Zero runtime dependencies: only Node built-ins (`node:crypto`, `node:fs`, `node:os`,
  `node:path`). No `package.json`, no npm install, no network, no credentials.
* No database, service, token or provider account is required to run the tests.

## 5. Test commands

```sh
node --test tests/*.test.mjs                         # full offline suite
node --test tests/omega-p0-*.test.mjs               # focused P0 suites
node --check scripts/*.mjs scripts/omega-p0/*.mjs tests/*.mjs tests/fixtures/*.mjs
WOLF_OMEGA_P0_FALSIFY=1 node --test tests/omega-p0-pre-effect-admission.test.mjs  # RED reproduction
```

See `test-results/` for the captured outputs. The `FALSIFY` switch is a test-only
falsification control; production wiring never uses it.

## 6. Known remaining blockers

1. Private Factory read access: without it the exact canonical HEAD, PR #701 HEAD,
   the real adapters and the Loop 1–5 checkpoint bodies cannot be compared or
   patched in place. This patch is against a clearly identified public base.
2. PR #1 and PR #701 are unmerged drafts; no merge, promotion or publication was
   performed. Loop 3 remains the sole publication owner.
3. No GitHub Actions run, real mission, real worker, inference, sandbox creation or
   production dispatch was started. Existing workflows are unchanged.
4. The reported `verify-build` / gitleaks binary reproduction remains outside this
   environment's egress allowlist; no scan is claimed.
5. Live runner-loss recovery, `NEXT_READY` consumption in a fresh job and
   provider-side economic receipts require separately authorized evidence.
6. The protected UNKNOWN external effect stays UNKNOWN and was never replayed,
   released, re-keyed or terminally classified.

**AUTONOMY ACCEPTANCE: NOT ACCEPTED.** Offline tests do not prove
REAL MISSION → REAL WORKER → REAL SOURCE CHANGE → TESTS → INDEPENDENT
VERIFICATION → DURABLE CHECKPOINT → RUNNER-LOSS RECOVERY → NEXT_READY.
