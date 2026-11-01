# Wolf × Ruflo integration — test results (2026-11-01)

**Package verdict: NOT READY FOR FACTORY INTEGRATION.**

Critical criteria that are FAIL, BLOCKED or NOT VERIFIED are listed in §4. This document
reports only what was executed in this session. Earlier checkpoint numbers were not reused.

Branch: `arena/3f5e2ca6-wolf-factory-home` (base `061d9ffd05dc4b7f528087761755ca01468e324c`).
Ruflo upstream commit: `66df9b95e1ab79d7263e491d23b20464f2906eec`, version `3.67.0`.
Node `v22.22.3`, npm `10.9.8`, pnpm `8.15.0` (declared by upstream `v3/package.json`).

Legend: **PASS / FAIL / BLOCKED / NOT VERIFIED**.

---

## 0. Previous package recovery (Step A)

| Artifact | State | Evidence |
| --- | --- | --- |
| `wolf-ruflo-integration.zip` | **NOT VERIFIED — missing** | `find / -name` across the sandbox: not present |
| `wolf-ruflo-integration.patch` | **NOT VERIFIED — missing** | same |
| `TEST-RESULTS.md`, `INSTALL.md`, `ROLLBACK.md`, `INTEGRATION-MANIFEST.json`, `SHA256SUMS` (previous) | **NOT VERIFIED — missing** | same |

The previous package contents were **not reconstructed**. All files in this directory are new and were produced in this session.

---

## 1. Dependency repair and build (Steps B–C)

### 1.1 Root-cause analysis

| Symptom (checkpoint) | Finding in this session | Classification |
| --- | --- | --- |
| `nostr-tools` "missing" | `@claude-flow/cli` declares `nostr-tools ^2.7.0` as an **optional** dependency. The pnpm lockfile resolves it (`2.25.2`). **Neither npm lockfile** (`package-lock.json`, `v3/package-lock.json`) contains it at the pinned commit. The CLI source imports it (`x-federation-*.ts`). With the declared toolchain, `import('nostr-tools')` succeeds. | **npm-lockfile drift for an optional dependency.** Not missing metadata, not an upstream packaging defect. |
| `TypeScript build FAILED` | Reproduced only under **pnpm 12.16.1** (not the declared `pnpm@8.15.0`). With pnpm 8.15.0 and `--frozen-lockfile`: install exit 0, `pnpm -r build` **exit 0, 0 TS errors**, CLI `tsc` **exit 0**. | **Toolchain mismatch.** The earlier failure is not reproducible on the declared toolchain. |
| `npm ls` FAILED "invalid dependencies" | Consumer tree `integration-tests`: `npm ci` failed on an **optional peer conflict**: `@claude-flow/cli` requires `@metaharness/router@^0.4.0` (optional peer), but a transitive `ruvector → agentic-flow` path pins `^0.3.2`, so npm hoists `0.3.3` to the top level and the lock is invalid. | **Genuine upstream packaging conflict** for optional peers, surfaced through npm's resolver. |

### 1.2 Fix applied (Wolf side only; no upstream source changed)

`integration-tests/package.json` now declares `@metaharness/router: 0.4.0` as an explicit direct
dependency. This is a justified exception: it satisfies the optional peer at the root. The lock was
regenerated from the new `package.json`.

| Check | Command | Exit | Log |
| --- | --- | --- | --- |
| npm ci **before** fix | `npm ci` | **1 FAIL** (`lock file's @metaharness/router@0.3.3 does not satisfy 0.4.0`) | `logs/npm-ci-BEFORE-fix-FAILED.log` |
| npm ci **after** fix | `npm ci` | **0 PASS** (395 packages) | `logs/npm-ci-after-fix.log` |
| npm ls | `npm ls` | **0** (invalid = 0; **43 extraneous** optional-dep leftovers reported as warnings) | `logs/npm-ls.txt` |

### 1.3 Build verification (upstream commit, declared toolchain)

| Step | Command | Exit | Log |
| --- | --- | --- | --- |
| Frozen install | `pnpm@8.15.0 install --frozen-lockfile --ignore-scripts` (in `v3/`) | **0 PASS** | `logs/pnpm8-frozen-install.log` |
| Monorepo build | `pnpm@8.15.0 -r build` | **0 PASS** (0 `error TS`) | `logs/monorepo-pnpm8-build.log` |
| CLI build | `pnpm@8.15.0 run build` in `v3/@claude-flow/cli` | **0 PASS** | `logs/cli-build-pnpm8.log` |
| `nostr-tools` import | `import('nostr-tools')` | **PASS** | (session output) |
| Frozen install, pnpm 12 | `pnpm install --frozen-lockfile` | **1 FAIL** (`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`, pnpm field ignored) | `logs/pnpm12-frozen-install-FAILED.log` |

Build caveat: "CLI runs without relying on stale build output" is **NOT VERIFIED**. The build was not
run from a clean `dist/`. The CLI was run after a successful rebuild, but stale output was not removed first.

### 1.4 CLI and MCP operation

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| CLI runs (`--version`) | **PASS** | `ruflo v3.67.0` from both the npm package and the source build |
| MCP server starts and answers `initialize` | **PASS** | `logs/mcp-safety.tap` tests 1–10 |
| MCP server starts with **autostart explicitly disabled** | **PASS with `RUFLO_DAEMON_AUTOSTART=0`; default FAIL (npm build)** | Ruflo starts a detached `daemon start` after CLI commands in any "Ruflo project" (e.g. one containing `.swarm/memory.db`). The default is ON. Disabled by `RUFLO_DAEMON_AUTOSTART=0`. Tests 11 (disabled: no daemon, PASS) and 12 (default: daemon starts with the npm `ruflo@3.67.0` CLI, **FAIL**). The source-built CLI did **not** reproduce the default-ON daemon in test 12 (PASS). The behaviour is build-dependent. Wolf MCP proxy forces the variable off for its child. |

---

## 2. Durable memory (Step E–F)

**Scope limitation (critical):** the Ruflo memory CLI in this sandbox runs on the **sql.js (WASM)
fallback**. better-sqlite3 native bindings are not loaded, and the CLI prints
`persistence is not guaranteed`. Evidence: `evidence/memory-backend.json`
(`sqlJsFallbackWarning: true`, `nativeBridgeActive: false`, `invalidPragmaSeen: true`).
**No test in this package uses the RVF file format.** RVF durability is therefore **NOT VERIFIED**.

Results from `tests/rvf-durable-memory.test.mjs` (12 tests; log `logs/rvf-durable-memory.tap`):

| # | Criterion | Verdict | Notes |
| --- | --- | --- | --- |
| 1 | Durable write/read | **PASS** (CLI, sql.js) | Not RVF |
| 2 | Restart recovery | **PASS (limited)** | A new process reads the value. No crash-kill test. |
| 3 | Executor-replacement recovery | **NOT VERIFIED** | Export/import on the **same host** only. Not two distinct execution environments. |
| 4 | Interrupted-write recovery | **PASS (detection only)** | Truncated file is refused, not repaired. |
| 5 | Concurrent writers | **FAIL** | 3 processes × 5 writes. CLI reported 15/15 success each run; persisted **5, 11, 10, 12** across runs. Lost updates. |
| 6 | Idempotent operations | **PASS** (upsert) / **BLOCKED** (append-only) | `--append-only` fails closed on fallback (`Immutable append requires a native writer`). |
| 7 | Mission namespace isolation | **PASS** | |
| 8 | Corruption detection | **PASS** | Garbage and truncated files return an error. |
| 9 | Snapshot and backup recovery | **PASS** | export count = 5, import restores 5 |
| 10 | Schema/version compatibility | **NOT VERIFIED** | Provenance is written but not returned by `retrieve`. No migration test. |

### 2.1 Wolf adapter store (Ruflo-independent, file-backed)

`adapter/wolf-adapter.mjs` provides a locked, atomic-write JSON store (lockfile with O_EXCL,
stale-lock timeout, temp file + fsync + rename). This is **not** RVF. It is a Wolf-owned durable adapter,
which the brief permits when RVF does not provide the guarantee. Tests: `tests/wolf-adapter-contracts.test.mjs`.

| Contract | Verdict |
| --- | --- |
| Lease exclusion while live; takeover after expiry | **PASS** |
| Fence strictly increasing; stale fence refused across restart | **PASS** |
| Idempotency: duplicate runs once; replay after restart returns stored result | **PASS** |
| Failed operation not recorded (retry may run) | **PASS** |
| Verification: executor cannot verify itself | **PASS** |
| Publication: needs independent PASS; blocked by UNKNOWN effect | **PASS** |
| External effect: stays UNKNOWN without evidence; reconciled only by matching receipt | **PASS** |
| Economic admission: zero-cost policy, COST_UNKNOWN/PAID_FALLBACK/TRIAL_CREDIT denied | **PASS** |
| Interrupted write does not replace committed state | **PASS** |
| Corruption refused (not reset); unknown schema version refused | **PASS** |
| **Concurrency: 3 OS processes × 5 locked writes → 15 entries** | **PASS** |
| No scheduler/timer/network in adapter (static token check, one permitted lock-backoff `setTimeout`) | **PASS** (weak check: token scan) |

**Falsification of the concurrency test:** the same workload with the lock disabled persisted
**14, 15, 11** entries out of 15 across three runs. The lock is load-bearing.

---

## 3. MCP safety (Step D/H)

`tests/mcp-safety.test.mjs`, log `logs/mcp-safety.tap`. Runs against the npm-installed CLI (`ruflo 3.67.0`) by default. Source-build run: `logs/mcp-source-build.tap` (18/20; 5c and 5d fail; 12 passes).

| # | Criterion | Verdict |
| --- | --- | --- |
| 1 | Startup answers `initialize`; stdin close → exit 0 | **PASS** |
| 2 | SIGTERM terminates the server | **PASS** |
| 3 | No child processes spawned | **PASS** |
| 4 | No listening TCP sockets (stdio) | **PASS** |
| 5a | Default advertised surface: upstream catalogue present | **PASS** |
| 5b | `CLAUDE_FLOW_MCP_TOOLS` restricts the advertised list exactly | **PASS** |
| 5c | **Default start exposes only Wolf-allowlisted tools** | **FAIL** — default exposes **380** tools (`evidence/mcp-tool-surface.json`) |
| 5d | **Allowlist enforced at call time** | **FAIL** — `system_info` (not allowlisted) **executes** when called with the upstream selector. Upstream comment: "Execution remains registered internally; only the advertised schema is reduced." |
| 5e | Wolf proxy: `tools/list` = allowlist exactly | **PASS** |
| 5f | Wolf proxy: non-allowlisted call refused, not executed; allowlisted call works | **PASS** |
| 5g | Wolf proxy: startup, shutdown, invalid args still correct | **PASS** |
| 6 | Unknown tool name rejected | **PASS** |
| 7 | Invalid arguments rejected by schema | **PASS** |
| 8 | Secret sentinels in env never appear in stderr/stdout | **PASS** (sentinel test; not a full log audit) |
| 9 | Repeated start/stop (3 cycles); no leftover children | **PASS** |
| 10 | Read-only call creates no agent and no `memory.db` | **PASS** (limited) |
| 11 | Autostart disabled (`RUFLO_DAEMON_AUTOSTART=0`), default DB location: no detached daemon | **PASS** |
| 12 | Default configuration (autostart unset): no detached daemon | **FAIL** (npm `ruflo@3.67.0`: daemon started; source build: not reproduced, PASS) |

**Allowlist position:** the Wolf MCP surface is `adapter/wolf-mcp-allowlist.json`
(`agent_list, agent_status, memory_store, memory_retrieve, memory_list`). It is enforced at the
**Wolf proxy** `adapter/mcp-allowlist-proxy.mjs`, which filters `tools/list`, refuses `tools/call` for
non-allowlisted names, and forwards everything else unchanged. The raw upstream server does **not** meet
the allowlist requirement (5c, 5d). The MCP layer remains subordinate to the Wolf controller: the proxy
admits no missions and schedules nothing.

---

## 4. Acceptance criteria — summary

| Criterion | Verdict | Blocker / reason |
| --- | --- | --- |
| Reproducible clean dependency installation | **PASS** (pnpm 8.15.0 frozen; `integration-tests` `npm ci`) | Residual: 43 extraneous npm entries |
| Valid dependency tree, or justified optional exceptions | **PASS** (npm: 0 invalid; `@metaharness/router` pinned as justified exception) | Upstream optional-peer conflict remains upstream |
| TypeScript build exits 0 | **PASS** (CLI and monorepo, pnpm 8.15.0) | Not on pnpm 12 (drift) |
| CLI runs without stale build output | **NOT VERIFIED** | Clean `dist/` rebuild not performed |
| MCP starts with autostart explicitly disabled | **PASS when set; FAIL by default** | Tests 11 / 12, §1.4 |
| Focused regressions pass | **PARTIAL** — 43/47 | 4 FAIL (below) |
| Durable memory recovery (RVF) | **NOT VERIFIED** | No RVF interface used; sql.js fallback |
| Cross-executor recovery | **NOT VERIFIED** | Same host only |
| Concurrent writers (Ruflo memory CLI) | **FAIL** | Lost writes (5, 11, 10, 12, 12 of 15 persisted across five runs; CLI reported 15/15 each time) |
| Concurrent writers (Wolf adapter) | **PASS** | Lock verified by multi-process test + falsification |
| MCP explicit tool allowlist (raw upstream) | **FAIL** | 5c, 5d |
| MCP explicit tool allowlist (Wolf proxy) | **PASS** | 5e, 5f |
| MCP lifecycle, no child processes, credentials, invalid tools | **PASS** | §3 |
| MCP no unintended background daemon | **PASS with autostart off; FAIL with upstream default (npm build)** | Tests 11, 12 |
| DBOS / KCT authority preserved | **NOT VERIFIED** | No DBOS/KCT code access; the adapter is written not to schedule or admit |
| Worker adapters (CEZAR/OpenCode, OpenHands, Qwen Code) | **NOT VERIFIED** | Contracts written; no worker executed |
| Groq / Flint / Ollama inference | **NOT VERIFIED** | Not exercised. No provider calls made. |
| Jules | **Prohibited — not used** | |
| Real Factory integration | **BLOCKED** | See §5 |
| Zero-cost policy (EUR_SPEND=0 etc.) | **PASS** (policy function + tests; no paid service invoked) | |
| Reproducible package and rollback | **PARTIAL** | This package is reproducible from the commit; the previous package is missing (§0) |

---

## 5. Blockers

| Surface | State | Evidence (this session) |
| --- | --- | --- |
| `donraposo1-source/project-wolf` (private Factory) | **BLOCKED** | `gh api repos/donraposo1-source/project-wolf` → **404**; `git ls-remote …/project-wolf.git feat/factory-real-worker-m1-20261006` → **403 "Write access to repository not granted"**. The token is authenticated as `insidethemarginmedia-cpu`. The public repo is reachable. The 404 is consistent with the token lacking repository access. It is **not** evidence of deletion. Resolution requires the repository owner to grant access. No bypass was attempted. |
| Composio | **BLOCKED — unsupported in Arena** | `list_connector_tools('composio')` → `unsupported` |
| PR #1 (`insidethemarginmedia-cpu/wolf-factory-home`) | **Unchanged** | `OPEN`, `isDraft: true`, `mergedAt: null`. Not merged, not modified. |
| Public runtime suite (`node --test tests/*.test.mjs`) | **PASS, 184/184** | `logs/public-runtime-tests.txt` (unchanged code; regression check) |
| Stray Ruflo daemon during development | **Found, stopped, contained** | An early test run used the upstream source CLI with the default working directory, which created `integration-tests/.swarm/` and a detached daemon (pid 23228, ppid 1, `--workspace integration-tests`). It was stopped with SIGTERM. Runtime state was then removed from the tree, and `.gitignore` now excludes `.claude-flow/ .claude/ .swarm/ *.rvf`. Tests now set `cwd` to a temp root and `RUFLO_DAEMON_AUTOSTART=0`. Post-fix, no `daemon start` processes remain after any suite run. |

---

## 6. Remaining work before Factory integration

0. Decide the Ruflo autostart policy: keep `RUFLO_DAEMON_AUTOSTART=0` as a Wolf requirement, or pin a project config that disables it (test 12 documents the default).
1. Restore access to `donraposo1-source/project-wolf` (owner grant), then run the Factory's own regression against the adapter contracts.
2. Enforce the MCP allowlist upstream (or keep the Wolf proxy as the only MCP entry point and forbid direct `ruflo mcp start`).
3. Fix or replace the Ruflo memory CLI write path for concurrent writers, or route all Wolf writes through the Wolf adapter store.
4. Obtain a real RVF (or native better-sqlite3) backend and re-run `rvf-durable-memory` with `nativeBridgeActive: true`.
5. Execute DBOS/KCT and worker integrations; none were exercised.
6. Clean-`dist/` rebuild and an autostart audit of the Ruflo CLI.
