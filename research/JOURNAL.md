# Research Journal — Engineering Research Lab (Wolf)

Durable, append-only. New entries at the bottom. Never rewrite past entries;
correct them by adding a correction entry that cites the original.

**Epistemic labels:** `VERIFIED FACT` · `SCIENTIFIC THEORY` · `HYPOTHESIS` ·
`ESTIMATE` · `SIMULATION` · `EXPERIMENTALLY VALIDATED RESULT` · `BLOCKED_EXTERNAL`

---

## Entry 001 — 2026-11-27 · Baseline established

**Question.** What is the actual state of Project Wolf and its Factory, and why
has three months of engineering not produced an integrated product?

**Method.** Direct observation through authorized access only: GitHub API/GraphQL
(`gh`), Vercel connector, Supabase connector, full git history of
`wolf-factory-home`, plus controlled execution of its test suite in three
workspace conditions.

**Findings (all `VERIFIED FACT` unless noted).**
1. Private `project-wolf` → HTTP 404 for the session token, yet Vercel reports
   `repoId 1328239266`, private, pushed 2026-11-25T15:07:18Z. The repository
   exists and is active; access is denied. → `BLOCKED_EXTERNAL`
2. Supabase connector returns **zero projects**, while production env references
   `qkrwndkqibpvxvrxhchj.supabase.co`. → `BLOCKED_EXTERNAL`
3. ≥10 consecutive Vercel deployments on 2026-11-25 `BLOCKED` with
   `COMMIT_AUTHOR_REQUIRED` (author `wolf-private-ci-bridge@users.noreply.github.com`).
   Production last `READY` 2026-10-15 → **41 days stale**.
4. Factory Home: 402 unique commits / 20 active days; **76.4% non-product**
   classes; `feat` = 8.2%; `docs`+`checkpoint` = 27.9%.
5. **46 of 52** test files are CI plumbing; **0** test product domains.
6. **4 open PRs, 0 merged**; bases are other feature branches, not `main`.
   `main` = 3 files; largest branch = 193 files / +26 204 lines.
7. Pairwise `merge-tree` over 91 long-lived branch pairs: **48 conflict**,
   115 conflicted paths, concentrated in 2 shared workflow files.
8. Test suite: 504/504 with full history; 496/504 fresh clone; 492/504 export.

**Conclusion.** The binding constraint is **access**, not capacity or
architecture. `SCIENTIFIC THEORY` (Theory of Constraints): optimising any
non-constraint cannot raise throughput. The Factory is the most-built and
least-load-bearing component; the product is the least-reachable and
most-needed.

**Decision.** Adopt product-first sequencing; subordinate Factory work to
measured product blockers (see `SIMPLIFICATION-MATRIX.md` rows 11–12).

**Limitation.** Findings are about *this* repository at *this* moment; no
statistical generalisation is claimed.

---

## Entry 002 — 2026-11-27 · Negative result: instrument false-negative

**Hypothesis.** The new instrument would correctly measure branch conflicts.

**Result.** First run reported **0 conflicts across all 91 pairs** — directly
contradicting a manual `git merge-tree` that showed conflicts for the same pair.

**Diagnosis.** `git()` re-threw failures as a new `InstrumentError` built from
`stderr` only, discarding `stdout`. `git merge-tree --write-tree` exits 1 and
prints conflict detail **on stdout**, so all conflict text was lost and the
parser saw an empty string.

**Classification:** `EXPERIMENTALLY VALIDATED RESULT` (a *negative* one).

**Fix.** Preserve `stdout`/`stderr`/`status` on the wrapped error; parse
`CONFLICT … Merge conflict in <path>`; distinguish rc=1 (conflicts) from rc≥2
(hard failure, fail closed).

**Regression guard.** `tests/wolf-research-instrument.test.mjs` #6 (synthetic
conflict must be detected) and #7 (disjoint edits must report 0).

**Lesson.** A measurement tool that fails *quietly toward zero* would have
reported "no integration debt" and invalidated the entire baseline. Silent
understatement is more dangerous than an obviously wrong number. Every
instrument in this lab must fail closed or fail loudly.

---

## Entry 003 — 2026-11-27 · Negative result: autonomous scheduler picked an impossible task

**Hypothesis.** Value/effort ranking over the queue would surface the most
valuable next action.

**Result.** First `wolf-loop status` returned `next: Q6` — *Restore read-only
access to private project-wolf*, a task **no agent can execute** (GitHub 404).
The loop would have stalled on its first step while reporting itself healthy.

**Classification:** `EXPERIMENTALLY VALIDATED RESULT` (design defect found by
running the thing, not by reading it).

**Fix.** Added `owner: agent | founder`. Autonomous runs select only
`agent`-owned tasks; `founder` tasks are surfaced separately as
`founderInterventions`, with `stalledOnFounder` reported when no agent work
remains. Queue now separates 6 agent tasks from 3 Founder interventions (Q6–Q8).

**Lesson.** Autonomy requires *knowing what you cannot do*. A queue that mixes
human-gated and agent-executable work will either stall or — worse — attempt
unauthorized actions. This is the mechanism behind directive #18: one instruction
works only when blocked work is *classified*, not hidden.

---

## Entry 004 — 2026-11-27 · Negative result: first end-to-end run failed at Q5

**Observation.** Running the queue in order: Q1 ✓, Q2 ✓, Q3 ✓, Q4 ✓, then Q5 ✗
(exit 1, 3 ms) because the research documents did not yet exist.

**Classification:** `VERIFIED FACT`.

**Significance.** This is the loop working *correctly*: verification failed →
receipt written (`queue/receipts/Q5-1.json`) → **task left pending** → state
not advanced. A system that marks incomplete work done is the failure mode the
Factory's 402-commit history exhibits.

**Action.** Wrote the research domain, then re-ran Q5.

---

## Entry 005 — 2026-11-27 · Literature position

Reviewed primary sources for DORA, Brooks' Law, Conway's Law, Little's Law/TOC,
METR's RCT, monolith-first, and two coding-agent architecture taxonomies;
plus documented mechanisms for Lovable/Bolt/v0.

**Strongest evidence available:** METR's randomised controlled trial
(16 devs, 246 tasks, +19% time with AI, +20% perceived) — the only
RCT-quality design in the set, and it measures *perception vs reality*, which
is exactly the distortion 402 commits with 0 merges displays.

**Weakest evidence:** prompt-to-app efficacy (vendor documentation only).

**Adopted design principle (`HYPOTHESIS`):** verification must be *running
software*, not test-count. Lovable's loop is plan→approve→build→deploy→observe
with one repo, one database, one deploy target. Wolf has 16 branches, an
invisible database, and a blocked deploy target.

**Planned falsification test.** When Q6 resolves: run a bounded task twice —
once Factory-first, once product-first — and measure time-to-integrated-value.
Prediction: product-first wins (matrix row 12).

---

## Entry 006 — 2026-11-27 · Minimal loop demonstrated

**Built.** `scripts/wolf-loop.mjs` (one file) + `queue/wolf-queue.json` (one
document) + append-only receipts. No new service, repository, framework or
abstraction layer.

**Verified.** 26/26 loop tests; 8/8 instrument tests. Both suites include
fail-closed cases (malformed queue, unknown dep, cycle, invalid status,
out-of-range value, timeout, non-repo path).

**Executed.** Q1–Q4 completed with receipts and durations; Q5's failure
preserved (Entry 004); Founder interventions isolated.

**Mapping to the required loop:**
`UNDERSTAND` (research/) → `PLAN` (queue + deps) → `IMPLEMENT` (files) →
`EXECUTE` (`run --task`) → `OBSERVE` (receipt) → `CORRECT` (Entries 002–004) →
`VERIFY` (per-task `verify`) → `INTEGRATE` (branch + PR, pending) →
`CONTINUE` (`next`).

**Not claimed.** No product functionality added — the product repository is
unreadable. This entry demonstrates the *method*, not Wolf itself.

---

---

## Entry 007 — 2026-11-27 · Reuse directive: what actually exists

**Question (Founder directive OMEGA X):** can existing builders (Lovable,
Hercules, Bolt, Replit, v0, bolt.diy, OpenHands, OpenCode, Aider, Dyad)
replace custom Factory components?

**Method.** Licences read from each repository's own `LICENSE` via
`GET /repos/{owner}/{repo}/license` — not from blog posts. Versions from
`npm view`. Timings bracketed with `date +%s%3N` in this workspace.

**Findings.**
1. **`VERIFIED FACT`** — "Hercules" names **three unrelated projects**: an
   AGPL-3.0 spec-first plugin (`mbienkowski/hercules`), an AGPL-3.0 browser test
   agent (`test-zeus-ai/testzeus-hercules`), and an MIT UI clone *inspired by*
   Hercules.ai. Any decision citing it must name the repository.
2. **`VERIFIED FACT`** — **bolt.diy** code is MIT but its README states
   WebContainers *"requires licensing for production usage in a commercial,
   for-profit setting. Prototypes or POCs do not."* ⇒ POC-only for Wolf.
3. **`VERIFIED FACT`** — **Dyad** reports `NOASSERTION`: Apache-2.0 outside
   `src/pro`, **Functional Source License 1.1** inside. Only the Apache-2.0
   region is safe to reuse.
4. **`VERIFIED FACT`** — clean and usable: `sst/opencode` (MIT, 229 577★),
   `cline/cline` (Apache-2.0), `OpenHands/OpenHands` (MIT),
   `Aider-AI/aider` (Apache-2.0, last push 2026-05-22 — **6 months stale**).

**Decision.** AGPL components **deferred pending recorded Founder decision**
(Q14), not silently adopted. Split/commercial licences excluded from production
use. `EUR_SPEND=0` maintained — all installs from public registries.

---

## Entry 008 — 2026-11-27 · Negative result: no model credential in environment

**Hypothesis.** An existing open-source harness could serve as the Factory's
engineering engine immediately.

**Probe (`VERIFIED FACT`):** node v22.22.3, npm 10.9.8, python3 3.11.2;
**uv, docker, ollama all absent**; **no `OPENROUTER_*`/`OPENAI_*`/
`ANTHROPIC_*`/`GROQ_*` env keys** (names inspected only, no value read);
egress to npm/pypi/github = 200.

**Result (`EXPERIMENTALLY VALIDATED RESULT`, E3):**
- **Aider** → `litellm.AuthenticationError: Missing Anthropic API Key`
- **OpenCode** (installed from npm in 63 s) → `rc=0` but prints only
  `> build · claude-sonnet-4.6`, **no output, no completion** — recorded
  *inconclusive*, not success.

**Classification:** the GENERATE row of any Lovable-shaped loop is
**`BLOCKED_EXTERNAL`**. This falsifies "adopt a builder as the engine today"
and simultaneously *confirms* that the blocker is a credential, not missing
tooling. Recorded as queue task **Q13** (Founder-owned).

**Lesson.** Reuse research that ignores the runtime environment produces
nonsense recommendations. Probe capability *before* ranking platforms.

---

## Entry 009 — 2026-11-27 · Measured: reuse beats building, where it applies

**`EXPERIMENTALLY VALIDATED RESULT`** — components executed offline against
real Wolf Factory code, no key, no network:

| experiment | component | result |
|---|---|---|
| **E1** | Aider `RepoMap` (Apache-2.0) | **0.547 s** → 23 files, 11 035 chars / 344 lines |
| **E2** | Aider `Linter` (Apache-2.0) | **0.363 s**; caught real `SyntaxError`, passed clean file |
| **E5** | full loop, CONTEXT+VERIFY stages | **2.969 s wall** tooling total |

**E5 functional result:** a real `.gitignore` for the research lab, verified
with `git check-ignore` control — three cache paths **IGNORED**, two evidence
files **still TRACKED**, suite **34/34** after the change.

**Graceful-degradation observation:** Aider attempted to fetch litellm pricing
from `raw.githubusercontent.com`, was blocked by egress, and **still produced
the map**. A component that fails soft under `COST_UNKNOWN=DENY` is reusable
here; one that fails hard is not.

**Negative result preserved:** two earlier attempts at E1 failed on guessed API
signatures (`map_refresh` kwarg; `RepoMap` exported from `aider.repo` instead of
`aider.repomap`). Fixed by reading the installed source rather than guessing —
the same lesson as Entry 002: **inspect, don't assume**.

---

## Entry 010 — 2026-11-27 · The reuse arithmetic

**`VERIFIED FACT`:** `scripts/private-ci-*.mjs` = **8 310** lines,
`tests/private-ci-*.mjs` = **6 778** lines ⇒ **15 088 lines** in the private-CI
family, while all other scripts+tests total ~1 640.

**`VERIFIED FACT`** — `private-ci-journal.mjs`'s own header:

> *"This file does not provide cross-run durability on GitHub-hosted runners:
> the JSON file lives on one ephemeral runner. It is not the production mission
> queue, recovery service, or admission source."*

**`VERIFIED FACT`** — official MIT equivalents already published:
`actions/create-github-app-token` (922★), `@octokit/rest` 22.0.1, `yaml` 2.9.1,
`better-sqlite3` 13.2.0, `nanoid` 6.0.2.

**`ESTIMATE`** (not measured by deletion): replacing the three clearly-covered
layers retires on the order of 2 000–3 000 custom lines plus a share of the
6 778 test lines. Offered as a bound for a controlled experiment.

**Decision.** Recorded as decisions R3–R6 in `REUSE-MATRIX.md`, with three
falsifiable predictions (P1 line retirement >1 500 with ≥34 green; P2 measured
speedup; P3 one key unlocks GENERATE).

---

---

## Entry 011 — 2026-11-27 · E6: reuse wired into the loop, with a negative control

**Purpose.** Entries 009 benchmarked components *standalone*. This entry proves
one actually runs **inside** `wolf-loop.mjs` as an executable verify gate —
i.e. reuse, not a demo.

**Design.** Treatment / control pair, the discipline P1 requires:

| arm | input | result |
|---|---|---|
| **treatment** | clean `scripts/wolf-loop.mjs` | gate **PASSES**; Q15 receipt `ok:true` |
| **control** | same file + injected `function broken( {` at line 453 | gate **BLOCKS**, reporting the exact line |
| restore | `diff -q` against pre-edit backup | byte-identical, `RESTORED OK` |

**`EXPERIMENTALLY VALIDATED RESULT`** — a gate that passes everything is not a
gate; the control demonstrates rejection of a real `SyntaxError`.

**Cost:** one `verify` command, **zero new orchestration, zero new service,
EUR 0**. This is the concrete answer to "can an existing component replace a
custom Factory mechanism" — for the *verification* layer, yes, immediately.

**Still open:** the *generation* layer remains `BLOCKED_EXTERNAL` (Entry 008).

---

## Open questions (next experiments)

| # | Question | Type | Needs |
|---|---|---|---|
| 1 | Does product-first beat Factory-first on time-to-integrated-value? | `HYPOTHESIS` | Q6 |
| 2 | Does consolidating branches drop conflicts below 10/91? | `HYPOTHESIS` | convergence |
| 3 | Can a product-domain test be written and made to fail? | `HYPOTHESIS` | Q6, Q7 |
| 4 | Does a bounded task take longer with or without an agent, measured wall-clock? | `HYPOTHESIS` (METR replication) | task pool |
| 5 | Does fixing authorship alone restore deploys? | `HYPOTHESIS` | Q8 |
| 6 | Can one model key move GENERATE from `BLOCKED_EXTERNAL` to runnable with no further infra? | `HYPOTHESIS` | Q13 |
| 7 | Do R3+R4+R5 retire >1 500 lines of `private-ci-*` with ≥34 tests still green? | `HYPOTHESIS` (P1) | Q10 |
| 8 | Is adopting an AGPL component acceptable, or should Hercules be rejected in writing? | `HYPOTHESIS` | Q14 |

**Exhausted investigations (do not repeat):** GitHub token scope probing
(404 is conclusive), Supabase project listing (empty, twice), Factory Home
branch enumeration (16 branches, all measured), test-suite execution (three
conditions, recorded), **candidate licence enumeration (7 repositories read
from their own `LICENSE`; three "Hercules" names disambiguated)**,
**model-credential probing (absent; aider and opencode both confirmed unable
to complete a run)**, **offline component benchmarking (repo map and linter
timed; both reusable)**.
