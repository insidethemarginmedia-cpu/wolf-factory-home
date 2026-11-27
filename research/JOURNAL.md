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

## Open questions (next experiments)

| # | Question | Type | Needs |
|---|---|---|---|
| 1 | Does product-first beat Factory-first on time-to-integrated-value? | `HYPOTHESIS` | Q6 |
| 2 | Does consolidating branches drop conflicts below 10/91? | `HYPOTHESIS` | convergence |
| 3 | Can a product-domain test be written and made to fail? | `HYPOTHESIS` | Q6, Q7 |
| 4 | Does a bounded task take longer with or without an agent, measured wall-clock? | `HYPOTHESIS` (METR replication) | task pool |
| 5 | Does fixing authorship alone restore deploys? | `HYPOTHESIS` | Q8 |

**Exhausted investigations (do not repeat):** GitHub token scope probing
(404 is conclusive), Supabase project listing (empty, twice), Factory Home
branch enumeration (16 branches, all measured), test-suite execution (three
conditions, recorded).
