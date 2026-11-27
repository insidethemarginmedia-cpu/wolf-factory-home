# Engineering Research Lab — Wolf

**Domain:** Engineering Research Lab (Wolf)
**Status:** ACTIVE · first checkpoint 2026-11-27
**Owner:** interdisciplinary research institute operating at university chair level
**Scope:** the fastest scientifically defensible path to a functional, integrated, progressively autonomous Wolf

This is a **knowledge domain**, not a competing task list. The single ordered
engineering queue is [`queue/wolf-queue.json`](../queue/wolf-queue.json).
Evidence files here are *outputs of instrumented runs*, never hand-typed claims.

---

## Epistemic labels

Every claim in this domain carries one of these labels. They are not
interchangeable and must not be upgraded without new evidence.

| Label | Meaning |
|---|---|
| `VERIFIED FACT` | Observed directly from a reproducible command or a primary source; re-runnable by anyone with the recorded access. |
| `SCIENTIFIC THEORY` | Published, peer-reviewed or institutionally documented explanation with cited primary source. |
| `HYPOTHESIS` | Plausible, falsifiable, not yet tested here. |
| `ESTIMATE` | reasoned quantity with stated assumptions; not measured. |
| `SIMULATION` | Output of a model under assumed inputs; not an observation of reality. |
| `EXPERIMENTALLY VALIDATED RESULT` | Measured under a controlled comparison with a recorded control condition. |
| `BLOCKED_EXTERNAL` | Cannot be advanced by any agent-side action; requires a Founder or third-party intervention. |

---

## Contents

| File | Purpose |
|---|---|
| [`BASELINE.md`](BASELINE.md) | Scientific baseline: what actually exists, measured. |
| [`LITERATURE.md`](LITERATURE.md) | Interdisciplinary review with primary sources and stated evidence strength. |
| [`SIMPLIFICATION-MATRIX.md`](SIMPLIFICATION-MATRIX.md) | RETAIN / SIMPLIFY / DECOUPLE / REPLACE / DEFER / RETIRE decisions with evidence. |
| [`JOURNAL.md`](JOURNAL.md) | Durable research journal: hypotheses, methods, results, decisions, next experiments. |
| [`evidence/`](evidence/) | Machine-generated baseline snapshots. |
| [`../scripts/wolf-research-instrument.mjs`](../scripts/wolf-research-instrument.mjs) | The instrument that regenerates every repository figure. |
| [`../scripts/wolf-loop.mjs`](../scripts/wolf-loop.mjs) | Minimum autonomous engineering loop. |
| [`../tests/`](../tests/) | Independent verification of both tools. |

---

## Reproducing everything

```sh
# 1. Regenerate the repository baseline (all figures in BASELINE.md)
node scripts/wolf-research-instrument.mjs --repo . --pretty

# 2. Verify the instrument itself
node --test tests/wolf-research-instrument.test.mjs

# 3. Verify the autonomous loop
node --test tests/wolf-loop.test.mjs

# 4. Inspect / advance the queue
node scripts/wolf-loop.mjs status
node scripts/wolf-loop.mjs run --task <ID>
node scripts/wolf-loop.mjs history
```

---

## Standing gates

`EUR_SPEND=0` · `COST_UNKNOWN=DENY` · `PAID_FALLBACK=DENY` · `TRIAL_CREDIT=DENY`

No credential exposure · no confidential source leakage · no unauthorized
merge · no production deployment · no branch-protection or required-check
bypass · no weakened security gate.

Negative results are preserved. A failed verification is a receipt, not an
error to be deleted.
