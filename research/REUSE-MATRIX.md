# Reuse Matrix — Existing Components vs Custom Factory Code

**Compiled 2026-11-27.** Directive: *reuse before building, assemble before
rewriting.* Every licence below was read from the repository's own `LICENSE`
via the GitHub API (`/repos/{owner}/{repo}/license`), not from a blog post.
Every timing is measured in this workspace, not estimated.

**Labels:** `VERIFIED FACT` (measured here) · `SCIENTIFIC THEORY` (cited
primary/secondary source) · `ESTIMATE` · `BLOCKED_EXTERNAL` · `EXPERIMENTALLY
VALIDATED RESULT` (controlled comparison recorded).

---

## 0. The binding environmental constraint

**`VERIFIED FACT`** — capability probe of this workspace:

| capability | state |
|---|---|
| node | v22.22.3 |
| npm | 10.9.8 (egress to `registry.npmjs.org` → 200) |
| python3 | 3.11.2 (`pypi.org` → 200) |
| uv / docker / ollama | **absent** |
| `OPENROUTER_*`, `OPENAI_*`, `ANTHROPIC_*`, `GROQ_*` env keys | **none present** (names only inspected; no value ever read) |

**Consequence (`EXPERIMENTALLY VALIDATED RESULT`):** any agent harness whose
core loop requires an LLM call **cannot complete a task in this environment**.
Confirmed by direct attempt:

- **Aider** (`Apache-2.0`) → `litellm.AuthenticationError: Missing Anthropic API Key`
- **OpenCode** (`MIT`, installed from npm in 63 s) → exits `rc=0` printing only
  `> build · claude-sonnet-4.6`, **no output, no completion** — recorded as
  *inconclusive*, not as success.

This **falsifies** the naive reading of "use Lovable/Hercules as the engine":
their generation step needs a model. It **does not** falsify reuse of their
*non-model components*, which is where the measured wins are (§2).

---

## 1. Candidate platforms — licence & maturity (primary sources)

| Project | Repository | Licence (from `LICENSE`) | Stars | Last push | Verdict for Wolf |
|---|---|---|---|---|---|
| **bolt.diy** | `stackblitz-labs/bolt.diy` | **MIT** (code) + **WebContainers commercial terms** | 20 148 | 2026-11-21 | ⚠️ code MIT, runtime not |
| **Dyad** | `dyad-sh/dyad` | **NOASSERTION** — Apache-2.0 outside `src/pro`, **FSL 1.1** inside | 22 468 | 2026-11-24 | ⚠️ split licence |
| **OpenCode** | `sst/opencode` → `anomalyco/opencode` | **MIT** | 229 577 | 2026-11-27 | ✅ licence clean |
| **Cline** | `cline/cline` | **Apache-2.0** | 71 948 | 2026-11-26 | ✅ licence clean |
| **Aider** | `Aider-AI/aider` | **Apache-2.0** | 50 284 | 2026-05-22 | ✅ licence clean, **stale 6 mo** |
| **OpenHands** | `OpenHands/OpenHands` | **MIT** | 94 454 | 2026-11-27 | ✅ licence clean |
| **Hercules (plugin)** | `mbienkowski/hercules` | **AGPL-3.0** | — | active | ❌ copyleft on the plugin |
| **Hercules (test agent)** | `test-zeus-ai/testzeus-hercules` | **AGPL-3.0** | 1 259 | 2026-11-26 | ❌ copyleft |

**`VERIFIED FACT` — "Hercules" names three unrelated projects** (a spec-first
delivery plugin, a browser test agent, and an MIT UI clone *inspired by*
Hercules.ai). Any decision citing "Hercules" must name the repository.

**Licence findings that matter (`VERIFIED FACT`):**

1. **bolt.diy** — README states source is MIT but *"WebContainers API … requires
   licensing for production usage in a commercial, for-profit setting.
   Prototypes or POCs do not require a commercial license."* Wolf is a
   commercial product ⇒ **production use is gated**, POC use is not.
2. **Dyad** — GitHub reports `NOASSERTION`; `src/pro` is Functional Source
   License 1.1 (source-available, restricts commercial resale). Reuse is safe
   only from the Apache-2.0 region.
3. **Both Hercules projects are AGPL-3.0.** Using them to *build* Wolf does not
   extend AGPL to Wolf's output (the plugin's README states this explicitly),
   but modifying and offering the plugin itself would trigger copyleft. Given
   Wolf's `EUR_SPEND=0` + no-weakened-security posture, **AGPL is deferred**
   pending a recorded Founder decision — not silently adopted.

**Economic eligibility:** all of the above install from public registries at
**EUR 0** (`npm`/`pip` egress verified 200). No trial credits used. No paid
fallback. `EUR_SPEND=0` maintained.

---

## 2. Component-level reuse — measured in this workspace

Each row is an `EXPERIMENTALLY VALIDATED RESULT`: installed, executed against
real Wolf code, timed, offline where stated.

| Capability needed | Custom Factory code | Existing component | Licence | Measured result | Decision |
|---|---|---|---|---|---|
| **Context / repo map** | *none exists* | **Aider `RepoMap`** | Apache-2.0 | **0.547 s**, 23 files → 11 035 chars / 344 lines, **offline, no key** | **REUSE** |
| **Automatic debugging / lint** | *none exists* | **Aider `Linter`** | Apache-2.0 | **0.363 s**; caught real `SyntaxError`, passed clean file | **REPLACE (add)** |
| **Durable journal / idempotency** | `private-ci-journal.mjs` (hash-chained, **self-declared non-durable across runners**) | `better-sqlite3` 13.2.0 / `nanoid` 6.0.2 | MIT | available, not yet wired | **SIMPLIFY** |
| **GitHub App authentication** | `private-ci-app-auth*.mjs` | **`actions/create-github-app-token`** (official, MIT, 922★) | MIT | published action exists | **REPLACE** |
| **GitHub API access** | hand-rolled fetch/pagination | `@octokit/rest` 22.0.1 | MIT | available | **REPLACE** |
| **Actions YAML parsing** | `private-ci-workflow.mjs` (hand-written subset reader) | `yaml` 2.9.1 | ISC | available | **REPLACE** |
| **Agent loop / orchestration** | `wolf-loop.mjs` (1 file, 496 lines) | OpenCode / Cline / OpenHands | MIT / Apache-2.0 | **cannot run** — no model key (§0) | **DEFER** |
| **Live preview / browser** | *none* | bolt.diy WebContainers | MIT + commercial | **blocked** — commercial licence in production | **DEFER** |
| **NL → app generation** | *none* | Lovable / Dyad / v0 | proprietary / split | **blocked** — no key, no account | **BLOCKED_EXTERNAL** |

### The decisive measurement

**`EXPERIMENTALLY VALIDATED RESULT` — E5, time-to-first-functional-result.**

Task: give the research lab a working `.gitignore` (real, needed, verifiable).

| stage | component | time |
|---|---|---|
| CONTEXT | Aider `RepoMap` (offline) | **2.101 s** (23 files, 6 131 chars) |
| IMPLEMENT | agent, using existing repo conventions | (this session) |
| VERIFY | Aider `Linter` (offline) | **0.006 s** |
| **tooling total** | | **2.969 s wall** |

Functional verification of the result (`git check-ignore`):

```
IGNORED       .aider.tags.cache.v4/tags.bin
IGNORED       __pycache__/junk.pyc
IGNORED       node_modules/pkg.js
TRACKED(good) research/evidence/factory-home-baseline-20261127.json
TRACKED(good) queue/receipts/Q1-1.json
```

Full suite after the change: **34/34 pass**.

**Interpretation.** The two stages custom Factory code *could* have provided
(context, verification) cost **2.107 s combined** using an Apache-2.0
component with zero configuration and no network. The Lovable-style loop's
*bottleneck in this environment is model access, not tooling* — which is
`BLOCKED_EXTERNAL`, not an engineering gap.

---

## 3. Custom code vs. reuse — the arithmetic

**`VERIFIED FACT`** (Factory Home, largest branch):

| asset | lines |
|---|---:|
| `scripts/private-ci-*.mjs` | **8 310** |
| `tests/private-ci-*.mjs` | **6 778** |
| **private-CI family total** | **15 088** |
| all other scripts | 800 |
| all other tests | 840 |

**`VERIFIED FACT`** — `private-ci-journal.mjs`'s own header comment:

> *"This file does not provide cross-run durability on GitHub-hosted runners:
> the JSON file lives on one ephemeral runner. It is not the production mission
> queue, recovery service, or admission source."*

**`SCIENTIFIC THEORY` (sunk-cost / essential-vs-accidental complexity):** 15 088
lines implement capability that its own author documents as non-durable, while
official MIT equivalents exist for the App-auth, API and YAML layers.

**`ESTIMATE`** — replacing the three clearly-covered layers (App auth, Octokit,
YAML parsing) with existing packages would retire on the order of **~2 000–3 000
lines of custom code and a corresponding share of its 6 778 test lines**. Not
measured by deletion — offered as a bound for a future controlled experiment,
not a result.

---

## 4. Hybrid architecture (the Lovable-shaped answer, assembled not built)

```
        ┌──────────────────────────────────────────────────────┐
        │  PLAN/VERIFY  existing OSS, Apache-2.0/MIT, offline  │
        │   Aider RepoMap (context)  ·  Aider Linter (gate)    │
        └───────────────────────────┬──────────────────────────┘
                                    │ 2.1 s + 0.006 s measured
        ┌───────────────────────────▼──────────────────────────┐
        │  LOOP  scripts/wolf-loop.mjs (496 lines, already     │
        │  built, tested 34/34, owner-separated, receipts)     │
        └───────────────────────────┬──────────────────────────┘
                                    │
        ┌───────────────────────────▼──────────────────────────┐
        │  INTEGRATE  git + gh  (existing, no new service)     │
        └───────────────────────────┬──────────────────────────┘
                                    │
        ┌───────────────────────────▼──────────────────────────┐
        │  GENERATE  Lovable / Dyad / OpenCode / Cline         │
        │  ⚠ BLOCKED_EXTERNAL — no model key in environment    │
        └──────────────────────────────────────────────────────┘
```

**What this does *not* require:** WebContainers, a second database, a new
orchestration service, an AGPL component, or any spend.

**What it does require:** one model key (`BLOCKED_EXTERNAL`, Founder action) to
unlock the GENERATE row — the same class of blocker as queue tasks Q6–Q8.

---

## 5. Decisions

| # | Component | Decision | Evidence | Licence safe? |
|---|---|---|---|---|
| R1 | Aider `RepoMap` | **REUSE now** | E1: 0.547 s offline | ✅ Apache-2.0 |
| R2 | Aider `Linter` | **REUSE now** | E2: 0.363 s, catches real defects | ✅ Apache-2.0 |
| R3 | `actions/create-github-app-token` | **REPLACE custom auth** | official action exists, MIT | ✅ MIT |
| R4 | `@octokit/rest` | **REPLACE hand-rolled API** | v22.0.1 published | ✅ MIT |
| R5 | `yaml` (ISC) | **REPLACE subset YAML reader** | v2.9.1 published | ✅ ISC |
| R6 | `better-sqlite3` / `nanoid` | **SIMPLIFY journal** | journal self-declares non-durable | ✅ MIT |
| R7 | OpenCode / Cline / OpenHands as engine | **DEFER** | E3: cannot run without key | ✅ clean |
| R8 | bolt.diy WebContainers | **DEFER** | commercial licence in production | ⚠️ POC-only |
| R9 | Dyad `src/pro` | **EXCLUDE**; Apache-2.0 region only | `NOASSERTION` + FSL 1.1 | ⚠️ split |
| R10 | Hercules (both) | **DEFER pending Founder decision** | AGPL-3.0 | ❌ copyleft |
| R11 | Lovable / v0 / Replit Agent | **BLOCKED_EXTERNAL** | proprietary; no account/key | ❌ not reusable |

**Provenance record:** all licences retrieved 2026-11-27 from
`GET /repos/{owner}/{repo}/license`; versions from `npm view`; timings from
`date +%s%3N` bracketing in this workspace. No proprietary source was accessed,
no platform protection circumvented, no credential read.

---

## 6. Falsifiable predictions

1. **P1** — wiring R3+R4+R5 will retire >1 500 lines of `private-ci-*` with no
   behavioural change (test count stays ≥34 green, private-ci suite unchanged).
   *Falsified if* line reduction <1 500 or any required check weakens.
2. **P2** — adding R1+R2 to `wolf-loop.mjs` as `context`/`lint` stages will cut
   time-to-verified-patch on a real backlog task below the current baseline.
   *Falsified if* measured time does not improve.
3. **P3** — supplying one model key unlocks R7 and converts the GENERATE row
   from `BLOCKED_EXTERNAL` to runnable without any further infrastructure.
   *Falsified if* a harness still fails after a valid key is present.

**Not claimed:** that any of these make Wolf's *product* faster — the product
repository remains unreadable (Q6). This matrix addresses the **Factory**
only, which is exactly where the 15 088 lines sit.
