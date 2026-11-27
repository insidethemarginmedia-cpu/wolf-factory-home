# Interdisciplinary Literature Review

**Compiled 2026-11-27** from primary sources and reproducible engineering case
studies located via documented search. Each entry states methodology, evidence
strength, limitations, and applicability to Wolf.

> **Integrity rule:** no reference is included that was not retrieved during
> this session. Where a source is a secondary summary rather than the primary
> paper, that is stated. Commercial claims are not treated as scientific
> evidence.

---

## 1. Continuous delivery and throughput

### DORA — *Accelerate: State of DevOps* (2024, 2025)
- **Source:** DORA / Google Cloud research programme; 2024 report summarised at
  [octopus.com/devops/metrics/dora-metrics](https://octopus.com/devops/metrics/dora-metrics/)
  (secondary) and [zbmowrey.com/blog/state-of-the-state-of-devops](https://zbmowrey.com/blog/state-of-the-state-of-devops/)
  (secondary, longitudinal synthesis).
- **Method:** annual multi-thousand-respondent survey plus archival analysis;
  2024 sample referenced as 39 000+ respondents.
- **Findings relevant to Wolf:** throughput and stability are distinct factors;
  a **25% increase in AI adoption correlated with −1.5% throughput, −7.2%
  stability, −2.6% time on valuable work** in 2024, despite ~75% of practitioners
  reporting personal productivity gains — the "vacuum hypothesis": freed time is
  absorbed by lower-value work. Platform engineering showed a J-curve
  (short-term throughput/stability loss, payoff only if sustained).
- **Evidence strength:** moderate — large sample, but **cross-sectional and
  correlational; no causal identification**. The *Accelerate* book's causal
  language is contested, and it used p<0.10 rather than p<0.05
  ([zbmowrey.com/blog/dora-metrics-what-the-research-actually-says](https://zbmowrey.com/blog/dora-metrics-what-the-research-actually-says/),
  secondary critique).
- **Applicability to Wolf (`HYPOTHESIS`):** Wolf's own baseline shows the same
  signature — high reported activity (402 commits/20 days) with −throughput
  (0 merged PRs). The vacuum hypothesis predicts exactly this: agent capacity
  absorbed by evidence-writing and CI repair rather than product.

---

## 2. Coordination and scheduling laws

### Brooks' Law — *The Mythical Man-Month* (1975; ann. ed. 1995)
- **Primary claim:** adding manpower to a late project makes it later, because
  training + communication overhead grow quadratically while work grows linearly.
- **Empirical tests:**
  - Blackburn, McKinney, Mazzucchelli & Zeller, *Brooks' Law Revisited*
    (system-dynamics simulation) — **adding people always increases cost; the
    project is delayed only under sufficient sequential constraint**, and there
    exists a critical time *T* (roughly one-third through the schedule) before
    which added manpower can still meet the date
    ([ResearchGate 2498872](https://www.researchgate.net/publication/2498872_Brooks'_Law_Revisited_A_System_Dynamics_Approach),
    abstract; conference paper 2000).
  - Gote, Müller & Zimmermann (2022), *Big Data = Big Insights? Operationalising
    Brooks' Law in a Massive GitHub dataset* — correlation + regression over a
    large GitHub corpus; **negative relationship between team size and every
    productivity metric, stable across tools**
    (replicated and described in
    [arXiv:2510.06844](https://arxiv.org/pdf/2510.06844), secondary replication report).
  - Blackburn et al., *Brooks' Law Revisited: Improving Software Productivity by
    Managing Complexity*, dataset of 117 Finnish projects — complexity raises
    maximum team size; maximum team size lowers productivity
    ([ResearchGate 228233532](https://www.researchgate.net/publication/228233532)).
- **Contradictory evidence:** Schweik & English, *Brooks' Versus Linus' Law*
    (NCDG WP 07-009, 2007) find that in open-source projects more developers
    correlated with **higher** success probability — with the caveat that
    communication structure, not headcount, is the operative variable.
- **Evidence strength:** strong for "communication overhead is real"; mixed on
  the sign of headcount effects; the *Mythical Man-Month* itself is
  observation, not experiment.
- **Applicability (`HYPOTHESIS`):** Wolf's 16-branch, 4-PR, 8-author topology is
  a textbook high-communication-overhead configuration. Brooks' caveat about
  *sequential constraints* is directly testable: Wolf's conflict graph (48/91)
  measures that constraint.

### Conway's Law (1968) and the mirroring hypothesis
- **Primary:** M. E. Conway, *How Do Committees Invent?* (1968) — organisations
  produce designs that copy their communication structure.
- **Empirical test:** MacCormack, Rusnak & Baldwin (Harvard/MIT),
  *Exploring the Duality between Product and Organizational Architectures*
  (2007/2008) — compared matched pairs of software products; **loosely-coupled
  (open-source) organisations produced significantly more modular products, by
  up to a factor of eight in potential change propagation**
  (summarised in secondary sources
  [virtasant.com](https://www.virtasant.com/blog/how-conways-law-influences-software-development),
  [thinkinsights.net](https://thinkinsights.net/strategy/conways-law)).
- **Mixed results:** a controlled pilot at Federal University of Pernambuco
  (2013) found treatment-group architectures **closer to the ideal architecture
  than to the imposed communication structure**, i.e. partial contradiction;
  results were inconclusive at small sample size. A 2011 pilot
  ([ResearchGate 254051718](https://www.researchgate.net/publication/254051718_Design_Team_Perception_of_Development_Team_Composition))
  found *perception* of team composition mattered more than actual composition.
- **Evidence strength:** moderate; strong on modularity, weak/inconsistent on
  exact structural copying.
- **Applicability (`HYPOTHESIS`):** Factory Home's architecture mirrors its
  organisation: many parallel agents → many parallel branches → 48/91 conflicting
  pairs concentrated in shared workflow files. The **Inverse Conway Maneuver**
  (restructure the team to induce the desired architecture) implies that
  collapsing to one agent + one branch would collapse the conflict graph.

### Little's Law and the Theory of Constraints
- **Primary:** J. D. C. Little (1961), *A proof for the queuing formula
  L = λW* — exact for any stable system, no distributional assumptions.
- **Empirical:** an 8 000+ work-item study across five software teams confirmed
  lower WIP ↔ shorter lead time
  ([productionalchemist.com](https://www.productionalchemist.com/p/littles-law-conways-law-constraints-game-studio-delivery),
  secondary). CircleCI *Q3 2026 Pulse* reports active branches per contributor
  rising 7 → 9 while **median main-branch throughput stayed flat at 1.7 runs/day**
  — WIP grew, completion did not
  ([daily.dev summary](https://daily.dev/posts/work-in-progress-wip-is-the-new-software-delivery-bottleneck-7xif44njt),
  vendor report, treat as industry data not peer review).
- **TOC (Goldratt):** five focusing steps — identify → exploit → subordinate →
  elevate → repeat. Reported practitioner diagnostics: constraints correctly
  identified on first attempt ≈ 30%; organisations skip to "elevate" ≈ 85%
  (secondary, [yagnipedia](http://yagnipedia.com/wiki/theory-of-constraints) —
  **not a measured statistic; treat as illustrative only**).
- **Evidence strength:** Little's Law is a *theorem* — strongest possible;
  TOC is a management framework with case-support, not a controlled experiment.
- **Applicability (`VERIFIED FACT` + theory):** Wolf's WIP is 14 branches ×
  ~250 commits with 0 completions. Little's Law then *requires* cycle time to
  explode. The measured constraint (§1 of BASELINE) is access, not capacity —
  so **subordination** means stopping Factory-side work until access returns.

---

## 3. AI software engineering productivity

### METR RCT (2025) — the central contrary result
- **Primary:** Becker, Rush, Barnes & Rein, *Measuring the Impact of Early-2025
  AI on Experienced Open-Source Developer Productivity*,
  [metr.org/blog/2025-07-10](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/)
- **Method:** randomised controlled trial, **16 experienced developers, 246
  real tasks**, each developer's own mature repositories (avg 22k+ stars,
  1M+ LOC), Feb–Jun 2025; task-level assignment to AI-allowed vs AI-disallowed.
- **Result:** allowing AI **increased completion time by 19%**. Developers
  predicted +24% beforehand and still reported +20% afterwards — a ~39-point
  perception gap.
- **Limitations (stated by METR):** small participant sample; mature high-quality
  codebases; 20 min–4 hr tasks; early-2025 tools; METR now labels the result
  historical. A 2026 follow-up attempt was abandoned for **selection bias** —
  too many developers refused the no-AI arm
  ([particula.tech](https://particula.tech/blog/metr-reversed-19-percent-slower-ai-coding-study),
  secondary).
- **Evidence strength:** **high** — randomised, within-subject, measured
  rather than surveyed; the strongest single design in this review.
- **Contradictory evidence:** GitHub's controlled study reports 55% faster
  completion on an unfamiliar-codebase task; DORA 2025 reports 80%+
  self-reporting gains (both summarised in
  [valueaddvc.com](https://valueaddvc.com/blog/ai-coding-productivity-2026-what-metr-github-and-dora-studies-actually-show),
  secondary). These measure different populations and task types and are not
  directly commensurable with METR.
- **Applicability (`HYPOTHESIS`, high priority):** the durable lesson is
  **perceived speed ≠ measured speed**. Wolf's 402 commits are activity, not
  throughput. This is precisely why this lab measures merged, verified, working
  software instead of commit counts — and why METR's own recommended design
  (task-level randomisation, enforced control arm, wall-clock timing, rework
  signal) is adopted as the template for §6 of the lab plan.

### SWE-bench and benchmark validity
- Benchmark scores (SWE-bench Verified, RE-Bench) use **algorithmic scoring** on
  author-written tests; METR's RCT used **human review satisfaction** on real
  PRs. The two disagree in sign. (`SCIENTIFIC THEORY` of measurement validity —
  the construct being measured differs.)
- **Applicability:** a green test suite is not evidence of product value unless
  the tests encode product acceptance criteria. Wolf's 504 green tests encode
  *CI-pipeline* criteria (§3.2 of BASELINE) — hence green ≠ working Wolf.

---

## 4. Architecture and incremental construction

### Monolith-first / modular monolith
- **Primary practitioner source:** Martin Fowler, *MonolithFirst* (2015) —
  "almost all the successful microservice stories have started with a monolith
  that got too big and was broken up"; wrong boundaries in a distributed system
  are expensive, inside a monolith they are a refactor.
- **Supporting:** Sam Newman, *Monolith to Microservices* (strangler fig);
  Richards & Ford, *Fundamentals of Software Architecture*.
- **Recent evidence:** Su, Li & Taibi (2023, arXiv) report migrations **from
  microservices back to monoliths** have become more common (cited in
  [tms-outsource.com](https://tms-outsource.com/blog/posts/modular-software-architecture/),
  secondary).
- **Quantified trade-off (illustrative, `SIMULATION`):** 6 modules → 1
  deployable (modular monolith) vs 6 deployables with up to 15 pairwise network
  links; 4 sequential 99.9% services compose to ≈99.6% availability.
- **Evidence strength:** strong practitioner consensus, weak controlled
  evidence; no credible source argues for premature distribution.
- **Applicability (`HYPOTHESIS`):** Wolf already *has* a deployed product
  (Vercel, hobby plan, one project). The question is not monolith-vs-services
  but whether Factory-side services (bridge, listener, preflight, mission,
  ledger, retirement) are on the product's critical path at all. §16 of the
  simplification matrix treats them as **DECOUPLE/DEFER**, not rebuild.

---

## 5. Autonomous agent harnesses (state of the art)

Sources: *Harness Engineering: Anatomy, Architecture, and Evolution of Coding
Agents* ([arXiv:2609.00006](https://arxiv.org/pdf/2609.00006)) and *Inside the
Scaffold: A Source-Code Taxonomy of Coding Agent Architectures*
([arXiv:2604.03515](https://arxiv.org/pdf/2604.03515)) — both preprint/primary
taxonomy papers; plus product documentation summaries for Lovable.

| System | Loop | Verification mechanism | Context strategy |
|---|---|---|---|
| **mini-swe-agent** | linear `while` over one bash tool | format-error cap | none — smallest possible harness |
| **Aider** | generator + inner reflection loop | lint (syntax→compile→flake8) → tests → re-prompt, default **max 3 reflections**; **no tool-call loop**; turn ends when stream ends | PageRank-weighted tree-sitter **repo map** in a strict token budget |
| **OpenHands** | event-sourced conversation, append-only `EventLog`, parallel action batches | re-run tests before `FinishAction`; **5 stuck-detection scenarios** | PromptRegistry, 18 named static sections + cache tiers; summarisation |
| **SWE-agent** | sequential ReAct | custom **ACI** (Agent-Computer Interface): `find/open/edit/submit`, structured observations, **not raw bash** | bounded 100-line viewing slices |
| **Agentless** | fixed 10-stage pipeline, JSONL between stages | **no feedback loop between stages** | per-stage scoping |

**Convergent findings across the corpus (`SCIENTIFIC THEORY`):**
1. The `str_replace` editor (old-str → new-str) appears in 5 of 13 agents —
   exact string replacement is the de-facto standard action space.
2. **Reflection/lint/test inner loops are near-universal**; the differentiator
   is *what* is fed back (Aider: lint+tests; OpenHands: observations+stuck
   detection).
3. Stuck detection is rare and mostly manual; OpenHands is the outlier with
   five automated scenarios.
4. State management spans a spectrum: Aider's two-list destructive summarisation
   → OpenHands' fully event-sourced, replayable log.
5. Safety is either **the human** (Aider), **a policy engine** (OpenHands), or
   **an LLM judging another LLM's actions** (one system scores 0–100 and blocks
   >80).

**Applicability (`HYPOTHESIS`):** Wolf's loop should take *mini-swe-agent's
minimalism* (one bash tool, one linear loop), *Aider's bounded reflection*
(max 3 re-prompt attempts before escalating), and *OpenHands' append-only
receipt log* (already implemented as `queue/receipts/*.jsonl`). It should
reject Agentless-style stage pipelines with no feedback — that is the shape
Factory Home currently has.

### Lovable and the prompt-to-app paradigm
- **Documented mechanism** (secondary product documentation:
  [datacamp.com/tutorial/lovable-ai](https://www.datacamp.com/tutorial/lovable-ai),
  [buildrlabs.ai/tool-guide/lovable](https://buildrlabs.ai/tool-guide/lovable/)):
  React + TypeScript + Tailwind frontend; **Supabase** for database, auth and
  RLS; **GitHub sync from day one** so code ownership is the user's; a
  **planning stage** that proposes feature list and DB schema *for approval
  before any code is written*; immediate deploy to a subdomain; iteration by
  chat with re-deploy per change.
- **Contrast table (documented):** Lovable = persistent Supabase + GitHub sync;
  Bolt.new = ephemeral WebContainers + Netlify; v0 = UI components only.
- **Evidence strength:** vendor/tutorial documentation — **not peer-reviewed**.
  Used here only for *mechanism* description, not for efficacy claims.
- **Applicability (`HYPOTHESIS`, central to the simplification thesis):**
  Lovable's loop is small: **plan → approve → build → deploy → observe →
  iterate**, with *one* repository, *one* database, *one* deploy target and
  verification = *the running app*. Wolf has 16 branches, 2 databases' worth of
  ambiguity (Supabase invisible), 1 blocked deploy target, and verification =
  504 CI-pipeline tests. The transferable principle is **verification by
  running software**, not by test-count.

---

## 6. Evidence-quality summary

| Claim area | Strongest evidence available | Verdict for Wolf |
|---|---|---|
| WIP ↔ cycle time | Little's Law (theorem) + team studies | Stop starting; finish |
| Headcount ↔ productivity | Brooks/Gote (mixed sign), RCT-quality weak | Do not add agents |
| AI ↔ measured speed | **METR RCT** (randomised) | Measure, don't survey |
| Architecture ↔ org structure | MacCormack et al. (modularity, strong) | Fewer agents ⇒ simpler code |
| Premature distribution | Fowler/Newman consensus + 2023 reversal data | Don't split what isn't constrained |
| Agent harness design | 2 taxonomies, 11 systems, source-code analysis | Minimal loop + bounded reflection |
| Prompt-to-app efficacy | Vendor docs only | **Insufficient — must test ourselves** |

**`BLOCKED_EXTERNAL`** — no primary literature exists on *this* project. Every
applicability row above is a `HYPOTHESIS` until the lab's own controlled
experiments (§6 of the plan) are run.
