# Wolf Omega P0 — exact test execution commands

Source base: `061d9ffd05dc4b7f528087761755ca01468e324c`.
Environment: Node `v22.22.3`, npm `10.9.8`, no `package.json`, no dependencies.

```sh
cd <checkout of insidethemarginmedia-cpu/wolf-factory-home @ 061d9ffd05dc4b7f528087761755ca01468e324c>
git apply --check wolf-arena-omega-p0.patch
git apply wolf-arena-omega-p0.patch

# 1. Syntax / module parse (all production and test modules)
node --check scripts/*.mjs scripts/omega-p0/*.mjs tests/*.mjs tests/fixtures/*.mjs

# 2. Focused adversarial P0 suites
node --test tests/omega-p0-*.test.mjs

# 3. RED reproduction (same assertions, reconstructed pre-fix adapter)
WOLF_OMEGA_P0_FALSIFY=1 node --test tests/omega-p0-pre-effect-admission.test.mjs

# 4. GREEN after the boundary is wired
node --test tests/omega-p0-pre-effect-admission.test.mjs

# 5. Full offline regression suite (existing + new)
node --test tests/*.test.mjs
```

Captured outputs: `test-results/red-before.txt`, `test-results/green-after.txt`,
`test-results/focused-suites.txt`, `test-results/full-suite.txt`.

Observed results (this session):

| Command | Result |
| --- | --- |
| `node --test tests/*.test.mjs` (baseline, before patch) | 184 / 184 PASS |
| `WOLF_OMEGA_P0_FALSIFY=1 node --test tests/omega-p0-pre-effect-admission.test.mjs` | 5 PASS / 12 FAIL (exit 1) — defect reproduced |
| `node --test tests/omega-p0-pre-effect-admission.test.mjs` | 17 / 17 PASS (exit 0) |
| `node --test tests/omega-p0-*.test.mjs` | 55 / 55 PASS (exit 0) |
| `node --test tests/*.test.mjs` (after patch) | 239 / 239 PASS (exit 0) |
| `node --check scripts/*.mjs scripts/omega-p0/*.mjs tests/*.mjs tests/fixtures/*.mjs` | ALL_MODULES_PARSE=OK |

Not executed (blocked / not authorized): GitHub Actions dispatch, private Factory
regression suite, private build, provider-side economic receipt verification,
gitleaks binary scan, CircleCI (prohibited), any real inference or mission.
