# Wolf Omega P6.0 — Composio → Flint delegation repair (2026-10-31)

Branch: `arena/96b41b62-wolf-factory-home`, forked from `dc5a35c41aac23a0410653dbf73aa5390cf9ae09`
(tip of `fix/omega-acceptance-ready-20261028`, = PR #1 head, still OPEN / DRAFT / UNMERGED).
Nothing was merged, promoted, force-pushed, dispatched or replayed. PR #1 was not touched.

Machine-readable companion: `WOLF-OMEGA-P6-20261031.inventory.json`.

## Final acceptance

**PARTIALLY VERIFIED — autonomy BLOCKED at four named boundaries.**

Real implementation work was completed, executed and falsified against the pre-repair tree
(200/200 tests). Every autonomy condition that requires a model call, a private-repository read,
a workflow dispatch or a write to the protected default branch remains **unverified**, and this
document states why with exact errors rather than inference.

---

## 1. Access matrix (live evidence, this session)

| Surface | State | Exact evidence |
| --- | --- | --- |
| `insidethemarginmedia-cpu/wolf-factory-home` (public runtime) | **GRANTED** | `git fetch` OK; `gh api repos/...` 200; PR #1 readable |
| `donraposo1-source/project-wolf` (private Factory) | **BLOCKED** | `gh api repos/donraposo1-source/project-wolf` → `404 Not Found`; `git clone` → `remote: Write access to repository not granted.` / `error: 403` |
| Workflow **dispatch** | **BLOCKED** | `POST .../workflows/private-controller-preflight.yml/dispatches` → `403 Resource not accessible by integration`; token is a GitHub App installation token (`x-oauth-scopes:` empty) with no `actions:write` |
| Actions **run/job/step metadata** | GRANTED | `GET /actions/runs/{id}/jobs` returns step names and conclusions |
| Composio connector (7 engineering skills) | **BLOCKED** | `list_connector_tools('composio')` → `unsupported` |
| **All AI provider egress** | **BLOCKED** | `curl https://api.groq.com/` → `000`, and identical `000` for `api.openai.com`, `openrouter.ai`, `generativelanguage.googleapis.com`, `api.anthropic.com`, `www.googleapis.com` |
| Local inference runtime | **ABSENT** | `http://127.0.0.1:11434/api/version` → no listener; no `ollama` binary |
| Provider credentials | **ABSENT** | no `GROQ_API_KEY` / `OPENROUTER_API_KEY` / `BOXXKITE_API_KEY` in the environment |

The sandbox reaches `github.com`, `api.github.com`, `codeload.github.com`, `registry.npmjs.org`,
`pypi.org` and `files.pythonhosted.org` only. No model provider is reachable, so **no claim of
real Flint, Groq or Ollama inference is made anywhere in this package.**

---

## 2. P0 — WHY Composio could not obtain an authoritative Flint result

### 2.1 The recovered integration (correcting earlier reports)

Flint is **not** a separate service. The existing integration is an OpenRouter model reached
through the private worker adapter:

- worker model identity: `recursive/flint-v1.0:free` (`scripts/existing-worker-qualification.mjs`)
- adapter: `infra/worker-router/direct-openrouter-executor.mjs` (private, fetched at runtime)
- policy: `infra/worker-router/engineering-model-policy.mjs` (private)
- economic admission: `scripts/private-controller-preflight.mjs::verifyPrivateControllerAccess`
  requires `is_free_tier === true`, `limit === 0`, `byok_usage === 0` **and** every pricing field
  of the model equal to `'0'`, else `EXACT_FREE_MODEL_REQUIRED`.
- receipt contract: `model` matches exactly, `costUsd === 0`, non-empty `generationId`,
  `content === 'WOLF_RUNTIME_OK'`, else `WORKER_QUALIFICATION_RECEIPT_INVALID`.

The mission-submission schema is **not** an HTTP API. It is a `workflow_dispatch` on
`.github/workflows/private-controller-preflight.yml` with 18 declared inputs, gated by:

```
github.repository == 'insidethemarginmedia-cpu/wolf-factory-home'
github.actor      == 'insidethemarginmedia-cpu'
github.ref        ∈ {refs/heads/feat/public-runtime-probe-20261022,
                     refs/heads/fix/omega-acceptance-ready-20261028,
                     refs/heads/main (schedule only)}
EUR_SPEND=0, COST_UNKNOWN=DENY, PAID_FALLBACK=DENY, TRIAL_CREDIT=DENY
```

**Consequence for Composio:** an external MCP tool cannot reach this surface at all unless it
holds a credential with `actions:write` for the public runtime *and* presents as the owner actor.
The exact failure mode is reproducible and was observed with this session's own credential:
`403 Resource not accessible by integration` → classified `DISPATCH_TOKEN_SCOPE_DENIED`.

### 2.2 The defect found in the existing code (confirmed, fixed)

Even with a correctly scoped credential, a valid `qualify_worker` dispatch **executed nothing.**

`service-access` hosts the single-step worker qualification, gated on
`inputs.qualify_worker == true`. But a step only runs if its **job** runs, and the job gate
honoured `qualify_worker` only on the legacy probe branch:

```
((github.ref == 'refs/heads/feat/public-runtime-probe-20261022') ||
 (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/fix/omega-acceptance-ready-20261028'
   && (inputs.verify_private_source == true || inputs.reconcile_boxxkite_label != '')) ||
 (github.event_name == 'schedule' && github.ref == 'refs/heads/main' && inputs.night_shift == true && ...))
```

Measured with a faithful GitHub-expressions evaluator (absent inputs resolve to their **declared
defaults**, not `undefined` — an earlier naive evaluation inverted this and nearly produced a
phantom finding):

| Request | `service-access` before repair |
| --- | --- |
| `qualify_worker=true` on `fix/omega-acceptance-ready-20261028` (**the active branch**) | **skipped** |
| `qualify_worker=true` on `feat/public-runtime-probe-20261022` | runs |
| `qualify_worker=true` on `main` (schedule) | skipped |
| no inputs | skipped |

So the only single-step real-inference qualification in the public runtime was reachable **only
by dispatching at a legacy branch**, and never from the scheduled path. That is why a delegation
attempt could report success while producing no Flint output.

### 2.3 The repair (smallest compatible change)

One additive disjunct, no other gate touched — `1 file changed, 1 insertion(+), 1 deletion(-)`:

```diff
-      (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/fix/omega-acceptance-ready-20261028' && (inputs.verify_private_source == true || inputs.reconcile_boxxkite_label != '')) ||
+      (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/fix/omega-acceptance-ready-20261028' && (inputs.verify_private_source == true || inputs.reconcile_boxxkite_label != '' || inputs.qualify_worker == true)) ||
```

It grants no new actor, repository, event or branch; `main` and the scheduled path are unchanged;
workflow permissions stay `contents: read` and the job declares no `permissions:` block, so it
inherits read-only. Zero-cost admission is enforced in code **before** the executor is
constructed, so the repair cannot introduce spend.

Repaired execution chain for `qualify_worker=true` on the active branch:
`security-tests` (`node --test tests/*.test.mjs`) → `service-access` → worker qualification →
`WORKER_INFERENCE_VERIFIED` receipt with `controllerMissionVerified: false`.

### 2.4 Falsification

`tests/worker-qualification-reachability.test.mjs` (7 tests) extracts the real job gate, evaluates
it with parsed declared input defaults, and embeds the exact pre-repair gate as a literal
(integrity-checked against the real `dc5a35c` blob whenever history is present).

```
reverted to dc5a35c workflow  ->  # pass 6  # fail 1   (test 4: "repaired gate admits bounded
                                                       qualification on the active branch only")
repair re-applied             ->  # pass 7  # fail 0
```

---

## 3. P0 — the missing Composio → admission transport contract

`scripts/composio-mission-admission.mjs` (new, 0 dependencies beyond `node:fs`/`node:path`) supplies
what an MCP tool actually needs and what did not previously exist: a pure validator, payload
builder, outcome classifier and duplicate-effect guard for the **existing** dispatch surface.
It creates no controller, scheduler, queue, database or second orchestration platform, and it
performs no network or process I/O.

It enforces, and is adversarially tested for (`tests/composio-mission-admission.test.mjs`, 11 tests):

1. **Explicit authorised mission identity** — only the identities the reachable authority already
   recognises (`OMEGA_[ABC]_<n>`, `WOLF_WAKEUP_MANUAL_<n>`, `WOLF_WAKEUP_SCHEDULE_ACCEPTANCE_V<n>`).
   `FLINT-F1`-style new identities are **refused** rather than invented.
2. **Exact worker identity** — `flint → recursive/flint-v1.0:free`, `groq → openai/gpt-oss-120b`,
   `ollama → qwen2.5-coder:0.5b`, each with `maxCostUsd: 0`.
3. **Economic policy** — all four variables must be present *and* exact, else
   `ADMISSION_COST_DENIED` before any payload exists.
4. **One input per dispatch** — modes are mutually exclusive, so a single dispatch can never
   combine acceptance paths.
5. **No duplicate external effects** — `workflow_dispatch` is not idempotent, so
   `retryAuthorized` is always `false` and `reserveOnce()` refuses a second reservation for the
   same 64-hex execution key (`DUPLICATE_ADMISSION_RESERVED`, `wx` + `0600`).
6. **No secret leakage** — `findSecretMaterial()` scans payloads and receipts for credential
   values, PAT patterns, PEM blocks and `x-access-token:`; a smuggled credential yields
   `ADMISSION_PAYLOAD_SECRET_DENIED`.
7. **Terminal failure states** — `401 → DISPATCH_CREDENTIAL_DENIED`, `403` (observed body)
   `→ DISPATCH_TOKEN_SCOPE_DENIED`, `404 → DISPATCH_WORKFLOW_OR_REPOSITORY_NOT_FOUND`,
   `422 → DISPATCH_PAYLOAD_REJECTED`, `429`, `5xx`, `0 → DISPATCH_TRANSPORT_FAILED`.
8. **Structured receipt** — frozen, secret-free, `replayAuthorized:false`, and nothing is ever
   admitted by omission (`NO_ADMISSION_EVALUATED`).

This is a contract, not a proof of delegation. End-to-end delegation remains blocked at §1.

---

## 4. §8 — automatic wakeup: confirmed defect, unrepaired here

The existing scheduler does not admit work — and this is not a transient condition. **Five of five
consecutive scheduled runs across three days** concluded `success` while **every** mission job was
skipped:

| Run | Date (UTC) | Conclusion | `night-shift-admission` | every mission job |
| --- | --- | --- | --- | --- |
| `41202573628` | 2026-10-31 12:46 | **success** | success | skipped |
| `41174505505` | 2026-10-31 05:55 | **success** | success | skipped |
| `41061101794` | 2026-10-30 13:10 | **success** | success | skipped |
| `41011531152` | 2026-10-30 06:00 | **success** | success | skipped |
| `40880808815` | 2026-10-29 13:19 | **success** | success | skipped |

`service-access`, `runner-loss-prepare`, `security-tests`, `opencode-runtime`,
`integrated-factory`, `dbos-runtime`, `runner-loss-recover` — `skipped` in all five.

Step telemetry for `41202573628` (the closest window): checkout → *Reserve one durable wakeup*
success → *Require currently observable free provider quota before inference* **skipped** →
*Persist safe suspension after bounded gate failure* **skipped**.

In this observed window the scheduled path has never admitted a single mission. It is green while
performing no work, which is precisely the disposition the mandate forbids counting as autonomous
acceptance.

Root cause is behind the reservation gate: `scripts/wolf-night-shift-wakeup.mjs prepare` returns
`ready != 'true'`, and that script lives in the private Factory. The P2.0 correction that records
`NO_MISSION_WORK_PERFORMED` is present on this branch but **not** in the callee pinned by `main`
(`7001be5`, which is 186 ahead / 2 behind `main`), so the live scheduler is still
administratively green while provably performing no mission work.

Repair requires either a write to the protected default branch (forbidden) or a readable private
reservation state (blocked). Nothing was changed here.

---

## 5. Provider admission status

| Provider | Identity recovered from code | Admission state in this environment |
| --- | --- | --- |
| **Flint** | `recursive/flint-v1.0:free` via OpenRouter | **BLOCKED** — `openrouter.ai` egress `000`; no key; private adapter unreadable. Exact blocked reason: `DISPATCH_SCOPE_DENIED` (cannot dispatch) ∧ `PROVIDER_EGRESS_BLOCKED` |
| **Groq** | `openai/gpt-oss-120b` (pinned in workflow env), `GROQ_FREE_PLAN_CONFIRMED: 'true'` | **BLOCKED** — `api.groq.com` egress `000`; no key. Note: the "free plan" assertion is a *static* workflow env literal, not a runtime verification — it cannot be re-validated from here |
| **Ollama** | `qwen2.5-coder:0.5b`, digest-pinned (`4ff64a7f…3fb09`) + image digest `4599…3da` | **BLOCKED** — no local runtime, no container engine session, egress to registries outside the allowlist |

Economic policy was **not** bypassed anywhere: `EUR_SPEND=0`, `COST_UNKNOWN=DENY`,
`PAID_FALLBACK=DENY`, `TRIAL_CREDIT=DENY` remain enforced by
`PUBLIC_RUNTIME_COST_DENIED` / `FACTORY_SOURCE_COST_DENIED` / `ADMISSION_COST_DENIED`.

---

## 6. The seven engineering skills — provider-side issue and Factory-side workaround

`list_connector_tools('composio')` → `unsupported` in this conversation. The skills therefore
cannot be discovered, loaded or tested here at all, and **no claim about their persistence is
made**: absence of visibility through this interface is not evidence of deletion.

**Provider-side issue (exact):**

- Surface: Arena connector registry — connector slug `composio` absent → status `unsupported`.
- Effect: no `list` or `execute` tool is exposed, so workspace/namespace/identity selection is
  impossible from inside the conversation; prior sessions' "empty results" and the mis-routing of
  searches to an unrelated MCP integration are consistent with a missing/incorrectly-bound
  connector record rather than deleted skills.
- Requested resolution: confirm the Composio *organisation* and *workspace* that owns the seven
  skill IDs, confirm the connection is bound to that workspace (not a default/other org), and
  expose it with a read-scoped tool list.

**Compatible Factory-side workaround that does not weaken authorisation:** run the discovery and
per-skill load from a composio-side client with an API key scoped to that workspace (outside
Arena), and route any engineering effect back through the existing admission surface using
`scripts/composio-mission-admission.mjs` (§3), which preserves actor, repository, ref and
zero-cost gates. No bypass, no duplicated skill records, no new controller.

---

## 7. Protected historical state

The protected Mission B was **not** replayed, recreated, lease-reset, deleted, reassigned or
given a fabricated terminal outcome. `git diff --name-only` returns **no** path under
`docs/checkpoints/runner-loss/` or `docs/checkpoints/night-shift/operations/`, so all four
sealed records are byte-unchanged, and the sealing digests are re-verified on every test run
by `tests/omega-b-preservation.test.mjs`.

Its exact identity, run id and record paths are deliberately **not** restated here: that test
maintains a closed allowlist of files permitted to reference them, so any new tracked file
mentioning the run requires a deliberate, explicit authorisation rather than an incidental
documentation edit. Full forensic detail (identity, paths, SHA-256 of each sealed record) is
carried in the delivered package evidence, outside version control:

```
EVIDENCE/protected-state.txt   (this package)
```

Two consequences worth stating plainly:

- its external effect classification remains **UNKNOWN**, and no reconciliation was attempted;
- new work uses fresh identities only. The admission contract added in §3 refuses any mission
  identity the reachable authority does not already recognise, and refuses the protected one
  for new work by construction.

## 8. Verification receipts (executed, this session)

```
base commit                                    dc5a35c41aac23a0410653dbf73aa5390cf9ae09
node --test tests/*.test.mjs (baseline)        182/182 PASS  exit 0
node --test tests/*.test.mjs (after repair)    200/200 PASS  exit 0   (182 + 18 new)
node --test tests/worker-qualification-reachability.test.mjs   7/7 PASS
node --test tests/composio-mission-admission.test.mjs         11/11 PASS
falsification vs pre-repair workflow           6 pass / 1 FAIL (as required)
node --check scripts/*.mjs tests/*.test.mjs    ALL_MODULES_PARSE=OK
YAML parse (PyYAML 6.x)                        preflight(9 jobs) + night-shift + probe OK
repair diff                                    1 file, +1 / -1
```

---

## 9. Exact remaining blockers

| # | Blocker | Owner action required |
| --- | --- | --- |
| B1 | Private Factory unreadable (`403` / `404`) → no mission admission, CEZAR/OpenCode worker, DBOS/KCT, publication code | Grant read access for `donraposo1-source/project-wolf` to the automation identity |
| B2 | Dispatch `403 Resource not accessible by integration` → cannot execute the repaired path | Credential with `actions:write` on the public runtime |
| B3 | Provider egress `000` and no keys → no real inference of any kind | Run the qualification inside Actions (secrets + egress exist there) |
| B4 | Composio connector `unsupported` → seven skills unreachable | Rebind the Composio connector to the owning workspace |
| B5 | Scheduled wakeup inert (`ready != 'true'`, private reservation) | Read private reservation state; promote the operational-outcome fix to the `main` callee pin (separate founder gate) |
| B6 | No real-mission identity is authorised in the reachable authority surface | Authorise a fresh non-`OMEGA_B` mission identity in the private authority record |

The single command that would move B1–B3 forward once B2 is resolved is unchanged and already
exists — no new code is required for it:

```
gh api -X POST repos/insidethemarginmedia-cpu/wolf-factory-home/actions/workflows/private-controller-preflight.yml/dispatches \
  -f ref=fix/omega-acceptance-ready-20261028 -F inputs[qualify_worker]=true
```

Before the repair this dispatch was a no-op; after it, it reaches the qualification step.
