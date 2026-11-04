# Publication path repair — stale source pin vs branch concurrency

Date: 2026-11-04
Scope: the existing public preflight `.github/workflows/private-controller-preflight.yml`.
No new workflow, controller, scheduler, database or publication authority was added.

## Verified defect

Failed run: https://github.com/insidethemarginmedia-cpu/wolf-factory-home/actions/runs/41751367852

The `integrated-factory` job checked out the private Factory at an immutable pin and then
asserted publication admission with a `git push --dry-run`. The pin was
`ee2d8ba15cd99d8788409c00c2fec3b1cd052370`. Its ancestry is unambiguous:

| fact | value |
| --- | --- |
| canonical branch | `feat/factory-real-worker-m1-20261006` |
| canonical head | `4c9726d2a964ad32b01263b4a5e3b9a7014660fe` |
| canonical head authored | 2026-11-03T23:22:24Z |
| failed run started | 2026-11-04T01:03:37Z |
| pinned SHA | `ee2d8ba1…` — a strict ancestor of the canonical head |
| commits behind | 101 (`git rev-list --count ee2d8ba1..4c9726d2`) |

Because the checkout was a strict ancestor of the remote branch, `git push --dry-run`
could only fail as a non-fast-forward, and the historical inline classifier mapped any
`non-fast-forward|fetch first|rejected` stderr to `CONCURRENT_BRANCH_ADVANCED`. The branch
never moved during the run; the pin was stale. A stale source pin was therefore reported
as concurrent branch advancement, and the bounded mission was suspended with
`UNKNOWN_UNTIL_RECONCILED`.

Three further pins were never synchronised (`ff0a29aa…`, 207 commits behind, and
`57dd1e11…`, 175 commits behind, in two jobs), so one run could use three different
source identities. The `security-tests` gate under `night_shift` also ran against the
public revision `f13d1a3e…`, 128 commits behind the executing revision, so the test gate
could not observe the code that was actually running.

## Repair

1. **One immutable source identity.** `WOLF_FACTORY_EXPECTED_SHA` is declared once, at
   workflow level, pinned to the verified canonical head `4c9726d2…`. Every per-job and
   per-step override was removed and every private checkout uses
   `ref: ${{ env.WOLF_FACTORY_EXPECTED_SHA }}`. Every immutability assertion compares
   `git rev-parse HEAD` with that variable, never with a literal.
2. **Pinned source verified against the live branch before any durable write.** A new
   `source-pin-verification` job runs `scripts/wolf-factory-source-pin.mjs verify-remote`
   and `night-shift-admission` now `needs:` it, so no wakeup journal reservation can be
   written from an unverified pin.
3. **Publication admission distinguishes the four causes.** `admit-publication` resolves
   the live branch head and its ancestry relationship to the pin (read-only GitHub API,
   `compare/<expected>...<remote>`) and refuses publication unless the checkout is exactly
   the pin. States are disjoint: `STALE_PINNED_SOURCE` (exit 79),
   `STALE_CHECKOUT_REFUSED` (76), `CONCURRENT_BRANCH_ADVANCED` / `DIVERGENT_HISTORY_REFUSED`
   (77), `AUTHENTICATION_FAILED` / `WRITE_ACCESS_DENIED` / `SHALLOW_HISTORY_DENIED` /
   `TRANSPORT_UNAVAILABLE` (78), `GENUINE_GIT_DEFECT` (1). Only an admitted checkout reaches
   the transport probe, and the probe is `--dry-run` only: `refUpdated:false`, no force,
   no merge, no rebase, no history rewrite.
4. **Test gate runs the executing revision.** `security-tests` uses `github.sha`.
5. **Regression coverage.** `tests/wolf-factory-source-pin.test.mjs` covers the
   classification matrix, the refusal ordering (no transport probe from a stale checkout),
   credential redaction and the dry-run-only guarantee.
   `tests/private-controller-preflight-pin.test.mjs` statically prevents pin drift, literal
   SHAs, retired pins, a historical test revision and any force-push/merge construct from
   returning.

## Pin compatibility (verified before replacing the SHA)

`git rev-list --count` and file presence were checked per job, and the private suite was
executed at the pinned commit with the workflow's own install steps:

| command | result |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` | exit 0, 66 packages |
| `npm ci --prefix infra/worker-router/mastra-runtime` | exit 0, 159 packages |
| `npm test` (private) | 1441/1441 pass, exit 0 |
| `node --test infra/worker-router/groq-opencode-admission.test.mjs` | 26/26 pass, exit 0 |
| `npm run build` | exit 0 |
| workflow-cited safety contracts (5 files) | 44/44 pass, exit 0 |

The nested `mastra-runtime` install is an existing prerequisite of the private suite; it was
not removed or bypassed.

## Live classification evidence

Executed against the real private repository (`GET /git/ref/heads/…` and
`compare/…`), read-only, no inference:

| pin supplied | state | ancestry | exit |
| --- | --- | --- | --- |
| `4c9726d2…` | `PIN_VERIFIED_IN_SYNC` | identical | 0 |
| `ee2d8ba1…` | `STALE_PINNED_SOURCE` | ahead (remote newer) | 79 |
| unknown SHA | `SOURCE_REF_DENIED` | — | 78 |
| missing credential | `BLOCKED` | — | 78 |

The historical failure mode is now reported as a stale pin, and the value that would have
been misreported can no longer reach a publication probe.
