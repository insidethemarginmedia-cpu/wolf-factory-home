# Simplification Matrix — RETAIN / SIMPLIFY / DECOUPLE / REPLACE / DEFER / RETIRE

**Decided 2026-11-27** from measured evidence in
[`BASELINE.md`](BASELINE.md) and [`LITERATURE.md`](LITERATURE.md).

**Rule applied:** no component is indispensable because effort was already spent
in it (sunk cost is not evidence). Every row cites its evidence and states the
measurable product impact of the decision. Recoverable history is preserved in
all cases — nothing is deleted, only re-classified.

Evidence keys: **B** = BASELINE section, **L** = LITERATURE section,
**Q** = queue task.

### Epistemic status of these decisions

Each decision below carries a label. The label describes *how well supported the
decision is*, not how confident anyone feels about it.

| Label | Where it applies here |
|---|---|
| `VERIFIED FACT` | Rows 1, 4, 5, 6, 7, 10, 13, 19 — grounded in directly re-runnable measurements (instrument output, GitHub 404, Vercel `COMMIT_AUTHOR_REQUIRED`, 48/91 conflict matrix, 112 docs/checkpoint commits). |
| `SCIENTIFIC THEORY` | Rows 11, 12 — applying Theory of Constraints (Goldratt) and Little's Law to the measured state; the *laws* are established, their *application to Wolf* is inference. |
| `HYPOTHESIS` | Rows 8, 9, 14, 15, 16 — predictions that have a stated acceptance test but have not yet been run. Row 12's ordering claim is a falsifiable prediction, not a result. |
| `ESTIMATE` | Rows 10, 15, 16 — effort and risk magnitudes are reasoned, not measured; no timing figure is offered as a measurement. |
| `SIMULATION` | Row 17's availability/arithmetic illustrations (0.999⁴ ≈ 0.996, 15 pairwise links) are arithmetic consequences of assumptions, not observations of Wolf. |
| `BLOCKED_EXTERNAL` | Rows 1, 2, 4, 13 — cannot be advanced until the Founder restores repository, database and deploy-path access (queue Q6–Q8). |
| `EXPERIMENTALLY VALIDATED RESULT` | Rows 6, 10 — validated against control conditions (synthetic clean/conflicting repositories; 91-pair measured matrix with a preserved false-negative regression test). |

---

## DECISION SUMMARY

| # | Component | Decision | Evidence | Product impact if wrong |
|---|---|---|---|---|
| 1 | Private `project-wolf` codebase | **RETAIN** | B1 | n/a — it *is* the product |
| 2 | Product domain (inventory, purchasing, recipes, costing, auth, dashboards) | **RETAIN** | B1, B2 | n/a — the value proposition |
| 3 | Academy knowledge + Assistant + LEGO + Quant Lab assets | **RETAIN** | B1 (Vercel commit evidence) | Losing accumulated assets |
| 4 | Existing Vercel project + Supabase references | **RETAIN** | B1, B2 | Re-provisioning cost, credential risk |
| 5 | Single ordered queue (`queue/wolf-queue.json`) | **RETAIN** | B3.1, B3.3 | Reverting to 4 competing docs |
| 6 | Durable per-attempt receipts | **RETAIN** | B3.4 | Losing negative results |
| 7 | Repository instrument | **RETAIN** | Q1, Q2 | Unverifiable claims return |
| 8 | Test suite of 504 (as the *only* gate) | **SIMPLIFY** | B3.2, B3.4 | False confidence either way |
| 9 | Hand-authored evidence writing (docs/checkpoint) | **SIMPLIFY** | B3.1 (27.9% of commits) | Loss of audit trail if over-cut |
| 10 | 14 long-lived parallel branches | **DECOUPLE → consolidate** | B3.3 (48/91 conflict) | Temporary merge effort |
| 11 | Chain-of-PR integration topology | **REPLACE** | B3.3 (0 merged) | Slower first merge, faster after |
| 12 | Factory-first sequencing ("Factory must be operational first") | **REPLACE** | B4, L2 | Delayed but correct ordering |
| 13 | CI bridge authorship / Vercel mapping | **REPLACE** | B2 | Deploys stay blocked |
| 14 | History-dependent verification | **SIMPLIFY** | B3.4 | CI false failures |
| 15 | Agent count / parallel orchestration | **DEFER** | B3.1, L2, L3 | Reversible; add when constrained |
| 16 | Private-CI control plane (bridge, listener, preflight, mission, ledger, retirement) | **DEFER** | B3.2, L4 | None while access is denied |
| 17 | Microservice-style decomposition of Factory | **RETIRE (as a goal)** | L4 | None — never demonstrated needed |
| 18 | Build Wolf PR #749 recovery attempt | **RETIRE (until identity known)** | B5 | None — guessing a repo is unsafe |
| 19 | Commit-count / activity KPIs | **RETIRE** | B3.1, L3 | None — they caused the distortion |
| 20 | New orchestration framework | **RETIRE (do not build)** | L5, Q | None — rejected by design |

---

## RETAIN

### 1. Private `project-wolf` codebase — *it is the product*
**Evidence:** B1. Vercel proves `repoId 1328239266` exists, private, pushed
2026-11-25, with PR numbers up to #748 and commit messages describing RBAC,
PostgreSQL acceptance and 1084 passing Node tests.
**Why not replace:** rebuilding from commit messages would destroy verified
work. **Recoverable history:** preserved by definition.
**Impact of decision:** zero-cost; blocked only by access (Q6).

### 2. Product domains — auth, org isolation, inventory, purchasing, recipes, costing, dashboards
**Evidence:** B1 (implemented per commit messages), B2 (Supabase required for
all of them), B3.2 (**zero** product tests exist in Factory Home).
**Why not simplify away:** these are the minimum complete user journeys that
constitute real product value.
**Impact:** none until Q6/Q7 resolve.

### 3. Academy, Assistant, LEGO, Quant Lab and accumulated knowledge
**Evidence:** B1 — Vercel env shows `WOLF_ASSISTANT_*` routes, free-model pools
and a founder-companion project; `docs/ruflo-integration/` and
`entrega-project-wolf-p1.zip` hold a delivered P1 package (47 files) with
install/rollback/verification evidence.
**Why:** preserving existing functionality was an explicit Founder directive;
the P1 package is already *delivered*, not speculative.

### 4. Existing Vercel project and Supabase references
**Evidence:** B1, B2. One project, hobby plan, EUR0-compatible.
**Why:** re-provisioning risks credentials and breaks the only live deploy path.

### 5. One ordered, dependency-aware queue
**Evidence:** B3.1 (402 commits, no single source of truth), B3.3 (4 open PRs
targeting other feature branches — i.e. *ad hoc* ordering made literal).
**Measurable impact:** `node scripts/wolf-loop.mjs status` gives one number
instead of four PRs and fifteen branches to reconcile.

### 6. Durable per-attempt receipts, including failures
**Evidence:** B3.4 (negative result preserved: history-dependent tests);
this session's own preserved negative result (instrument false-negative) and
the preserved Q5 failure receipt.
**Why:** Founder directive requires negative results be kept. Implemented as
`queue/receipts/*.json` + `history.jsonl` — append-only.

### 7. The repository instrument
**Evidence:** Q1/Q2 pass; control conditions in B3.3 validate conflict
measurement; regression test guards the false-negative failure mode.
**Why:** without it, every figure in this domain is an unverifiable hand-typed
number — the exact failure mode that produced 112 docs/checkpoint commits.

---

## SIMPLIFY

### 8. The 504-test suite — keep it, but stop treating it as the gate
**Evidence:** B3.2 — **46 of 52 test files are CI plumbing; 0 test product
domains.** B3.4 — the suite is history-dependent (504/504 with history,
496/504 in a fresh clone, 492/504 as an export).
**Change:** run it as a *regression* check on the Factory branch, and add a
**product** verification command per queue task (verification = running
software, per L6).
**Risk if over-simplified:** losing regression detection — mitigated by keeping
the suite intact and unchanged.
**Acceptance:** suite still exits 0 on a full clone; product tasks gain their
own `verify`.

### 9. Hand-authored evidence writing
**Evidence:** B3.1 — `docs` + `checkpoint` = 112/402 commits = **27.9%**, the
largest non-`fix` class; top-2 files absorb 16.8% of all edits.
**Change:** evidence becomes an *instrument output* (`research/evidence/*.json`
regenerated by Q1) plus the append-only receipt log. Human-authored prose is
kept only for decisions and limitations, not for state.
**Risk:** losing narrative context — mitigated by `research/JOURNAL.md`.
**Acceptance (Q9):** baseline regenerates from the instrument, not by hand.

---

## DECOUPLE

### 10. Fourteen long-lived parallel branches
**Evidence:** B3.3 — 14 branches 197–289 commits ahead; **48/91 pairs
conflict**, 115 conflicted paths, dominated by two shared workflow files.
**Change:** converge to **one integration branch + short-lived task branches**
(Inverse Conway Maneuver, L2). Do not delete branches: `git` keeps them, and
history is preserved by the directive.
**Risk:** merge effort concentrated at convergence — mitigated because 43/48
conflicting pairs share the *same two files*, so resolving them once resolves
most of the graph (measured: `night-shift-wakeup.yml` + `private-controller-
preflight.yml` appear in nearly every conflicting pair).
**Acceptance:** pairwise conflict count falls below 10/91 without bypassing
required checks.

### 11. Factory control-plane services from the product path
**Evidence:** B4 — while access is denied, Factory-side optimisation cannot
increase product throughput (Theory of Constraints, L2).
**Change:** the product deploy path (GitHub → Vercel) must not *depend* on
bridge/listener/preflight being healthy. Authorship mapping (Q8) is on the
critical path; the rest is not.
**Acceptance:** a product deploy succeeds with the control plane idle.

---

## REPLACE

### 12. "Factory must be fully operational before the Wolf is usable"
**Evidence:** B1 + B2 + B4. The Factory is *most* operational (504 green tests)
while the product is *least* reachable (404 + zero Supabase projects + 41-day
stale production). The sequencing assumption is empirically inverted.
**Replace with:** product-first vertical slices, with Factory improvements
admitted **only** when they remove a measured product blocker.
**Falsifiable prediction:** restoring Q6 alone moves product throughput more
than any Factory task completed before it.

### 13. CI-bridge commit authorship
**Evidence:** B2 — `COMMIT_AUTHOR_REQUIRED` blocked ≥10 consecutive deploys on
2026-11-25; production 41 days stale.
**Replace with:** an author identity Vercel maps to a Git account, *or* deploy
triggered from a human-owned branch. Must not weaken the isolation gates.
**Acceptance:** next `project-wolf` deployment reaches `READY`.

### 14. History-dependent verification
**Evidence:** B3.4 — 8 failures in a fresh clone, all SHA-pin resolution.
**Replace with:** either (a) full-history checkout in CI, or (b) pins resolved
against a recorded manifest instead of live git objects.
**Acceptance:** the suite passes identically in a full clone *and* a
single-ref checkout.

---

## DEFER

### 15. Adding agents / expanding parallel orchestration
**Evidence:** B3.1 (76.4% non-product commits across 8 authors), L2 (Brooks/Gote:
headcount↔productivity negative, mixed sign but communication cost certain),
L3 (METR RCT: +19% time with AI for experts).
**Why defer:** Brooks' critical time *T* and Little's Law both say adding
capacity now lengthens cycle time while WIP (14 branches) is unfinished.
**Revisit when:** merged-PR throughput is non-zero and the conflict graph is
resolved. Explicitly reversible.

### 16. Private-CI control plane (bridge, listener, preflight, mission, ledger, retirement)
**Evidence:** B3.2 (this *is* the 46 CI test files), B3.1 (top-2 churn files
are these very workflows), B4.
**Why defer:** it cannot be validated without private access (its own tests
require SHA resolution and private refs), and it is not on the product critical
path once #11 is applied.
**Cost of deferral:** low — no product capability depends on it today.
**Revisit when:** Q6 resolves and an actual private worker run is required.

---

## RETIRE

### 17. Microservice-style decomposition of the Factory — as a goal
**Evidence:** L4 — no source argues for premature distribution; 2023 evidence
shows reverse migrations increasing; Wolf has one deployable and one database
reference.
**Status:** never actually attempted; retire *as an objective* before it
accumulates sunk cost. Architecture stays a modular monolith by default.

### 18. Build Wolf PR #749 recovery — until repository identity is known
**Evidence:** B5 — repository identity unresolved; a PR number is not an
identity. Guessing risks acting on the wrong repository.
**Status:** retire the *attempt*, keep the item recorded (queue history +
`engineering-workspace.json` already document it).

### 19. Commit counts, agent activity and report length as success metrics
**Evidence:** B3.1 — 402 commits produced 0 merged PRs; L3 — perceived +20%
vs measured −19% (METR).
**Replace with:** *completed, verified, integrated, usable* deliverables.
**Status:** retired as KPIs; retained only as raw instrument input.

### 20. Building another orchestration framework
**Evidence:** L5 — 11 existing harnesses already solve agent looping,
verification and state; mini-swe-agent demonstrates the minimal harness is
~one bash tool. Q4/Q3 demonstrate one file + one JSON queue suffices here.
**Status:** **retired by design.** `scripts/wolf-loop.mjs` is 1 file and
`queue/wolf-queue.json` is 1 document. No new service, repository, or
abstraction layer was introduced.

---

## What would change these decisions

- **Q6 resolves** → rows 11, 12, 16 become testable; product verification (row 8)
  becomes the binding gate.
- **A product test exists and fails** → row 8's product-verification requirement
  becomes urgent rather than procedural.
- **Conflict count falls below 10/91 after consolidation** → row 10 confirmed;
  if it does not, the branch topology hypothesis (Conway) is weakened.
- **Any decision above is falsified by a controlled experiment** → the matrix is
  revised in `JOURNAL.md` with the negative result preserved.
