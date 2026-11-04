# Project Wolf — Composio unified Factory access: verified operational checkpoint

**Date:** 2026-11-04 (UTC).  
**Scope:** Existing Project Wolf Factory only; no new runtime, scheduler, repository, database, controller, PR, or mission.  
**Policy:** `EUR_SPEND=0`, `COST_UNKNOWN=DENY`, `PAID_FALLBACK=DENY`, `TRIAL_CREDIT=DENY`. Jules prohibited. CircleCI not used.

## Source snapshots and independently checked access

| Surface | Evidence | State |
| --- | --- | --- |
| Private Factory | `donraposo1-source/project-wolf` branch `feat/factory-real-worker-m1-20261006`, HEAD `4c9726d2a964ad32b01263b4a5e3b9a7014660fe` | GitHub read access confirmed |
| Public runtime | `insidethemarginmedia-cpu/wolf-factory-home` branch `feat/public-runtime-probe-20261022`, prior HEAD `511ea0b5448e5d79af7f812603f0a49eb8746a6a` | GitHub read/write via Composio confirmed |
| GroqCloud | `GROQCLOUD_LIST_MODELS` returned 11 models, including `openai/gpt-oss-120b` | Connected; live inference **not** run |
| Ollama | `OLLAMA_LIST_MODELS` returned 25 models, including `gpt-oss:120b` | Connected; live inference **not** run |
| Boxxkite Wolf Executor | `list_sandboxes(active_only=true)` returned `No sandboxes found.` | Management endpoint reachable; no active executor |
| Boxxkite independent volumes/images | API returned `not enabled on this deployment` | Not available |
| Desktop Commander | `wolf-build-box` and `codespaces-c6b2f0` devices all offline | No connected persistent runner |
| Composio remote bash | Remote command ran successfully, but `GROQ_API_KEY`, `OPENHANDS_API_KEY`, `BOXXKITE_API_KEY`, `DATABASE_URL`, `DBOS_SYSTEM_DATABASE_URL`, `GITHUB_TOKEN` were **absent in that ephemeral shell** | Not the authorized Factory runtime; absence here says nothing about secret stores elsewhere |

**Private Factory CI:** GitHub Actions run [41738678409](https://github.com/donraposo1-source/project-wolf/actions/runs/41738678409), jobs `dbos-outer-e2e` and `openhands-integration-ci` both successful. CI fixtures are not a real OpenHands mission.

## Seven Engineering Skills: successfully loaded in both tool environments

Composio Skills: Recovery, Debugging, Repair, Testing, Security, MCP, Python — **7/7** `COMPOSIO_USE_SKILL` successful.

Composio MCP Nativo Skills: Recovery, Debugging, Repair, Testing, Security, MCP, Python — **7/7** `COMPOSIO_USE_SKILL` successful.

Skill loading authorizes *guidance only*, not new permissions, credentials, or mission effects.

## Verified code integration entrypoints (private canonical HEAD)

- `infra/autonomy/resident-entrypoint.mjs`: existing resident modes `deterministic`, `dbos-engineering`, `dbos-external`.
- `scripts/wolf-dbos-existing-factory-engineering.mjs`: existing DBOS engineering invocation; requires an authorized Factory cwd, runtime root, DBOS SDK, DBOS system database URL and workflow ID. Routes CEZAR/OpenCode with configured inference/publication.
- `scripts/wolf-dbos-external-mission.mjs`: external OpenHands mission entrypoint; uses existing Composio delegation adapter and owner-controlled submission/reconciliation. **Do not invoke without the authorized existing runtime and admissible mission.**
- `infra/autonomy/composio-external-delegation.mjs`: existing DBOS/KCT delegated-worker adapter, lease/fencing, idempotency, independent verification and strict OpenHands-only external transport. Jules remains denied.
- `infra/autonomy/external-mission-controller.mjs`: reads `WOLF_EXTERNAL_ADMISSION_FILE` outside both repository and runtime roots; requires mission-exact owner economic admission including `openhandsZeroCostVerified=true` and `privateSourceAuthorized=true`. **Do not forge or bypass.**
- `infra/worker-router/openhands-session-transport.mjs` and `openhands-artifact-worker.mjs`: authenticated transport and independent artifact verification code present.
- `infra/worker-router/cezar-flint-chat-tool-adapter.mjs`: existing Flint `recursive/flint-v1.0:free` through OpenRouter with `allow_fallbacks=false`; current provider routability/zero-cost receipt NOT verified this run.
- `infra/worker-router/factory-service-transports.mjs`: Groq, OpenRouter, Boxxkite and policy-gated local Ollama transports; in-process routing, not a public service.
- `infra/autonomy/boxxkite-service-transport.mjs`: existing client with restricted one-sandbox admission and zero-cost eligibility checks.
- `infra/worker-router/composio-seven-skill-bridge.mjs`: pinned and checksum-validated local seven-skill loader.
- Qwen Code: `lib/qwen-installer.mjs`, `scripts/wolf-qwen-installer.mjs`; installed/working in current persistent controller not checked.
- Ruflo and KCT/DBOS: existing engineering checkpoints and components in private Factory; live resident health not checked.

## Current decision and blockers

**Can Composio list connected model provider tools?** YES.  
**Can Composio read and write the authorized GitHub public runtime branch?** YES.  
**Can it inspect existing Factory code and checkpoints?** YES.  
**Can it submit a safe real mission to the authoritative durable Factory now?** **NOT VERIFIED / NOT AUTHORIZED FROM THIS SESSION**: no reachable persistent owner runtime, no accessible owner-issued mission/admission file, no DBOS state/SDK credentials in the current remote shell, and no active Boxxkite sandbox. External OpenHands economic admission not proven by CI.

No new mission, external inference, sandbox, workflow dispatch, paid fallback, publication of private code, or PR was initiated.

## Minimal operational recovery path (existing infrastructure only)

1. Reconnect the **existing** authorized persistent Factory runtime (Desktop Commander devices are currently offline), or find an already-authorized existing execution surface holding the DBOS/KCT runtime and owner-issued admission. Do not deploy another controller.
2. On that surface, verify DBOS SDK, DBOS system database health, current canonical HEAD, mission inbox, lease/fence and UNKNOWN-effect quarantine. Avoid disclosing secret values.
3. Use existing Composio/MCP access to address provider calls; prefer Groq where free-tier admission is satisfied. Existing account Free Plan evidence: [GROQ-FREE-PLAN-ACCOUNT-EVIDENCE-20261104.md](../economic/GROQ-FREE-PLAN-ACCOUNT-EVIDENCE-20261104.md). Do not repeat plan qualification.
4. Check current Flint availability/observed cost without falling back to a paid endpoint. OpenHands remains blocked from live dispatch until its owner-issued economic and private-source admission is valid. Boxxkite sandbox creation requires qualifying cost and idempotent controller-owned intent.
5. Submit at most one fresh, explicitly admissible mission via the **existing** controller, only after verifying no duplicate/UNKNOWN effects. Capture independent test/worker/model receipts, checkpoint SHA, branch/commit and NEXT_READY, or report precise refusal.
6. Keep credentials inside the existing secret manager/runtime and expose only the minimum supported operations to Composio. A chat prompt cannot mint credentials or supply durable controller uptime.

**No capability is marked as live-autonomous from API listing, GitHub fixture CI, or skill loading alone.**
