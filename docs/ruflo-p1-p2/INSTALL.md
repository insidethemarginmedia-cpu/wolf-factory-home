# INSTALL — Ruflo P1/P2 integration

Nothing here merges, promotes or publishes. Every step is explicit and reversible
(see [`ROLLBACK.md`](./ROLLBACK.md)).

---

## 0. What you are installing

Six production modules, four test-support modules, two scripts, and nine test
files. The integration adds **no** scheduler, no database authority and no
publication system: DBOS stays the durable workflow authority, KCT stays the
admission authority, the Factory stays the sole mission controller.

```
infra/autonomy/
  p2-errors.mjs              typed denial vocabulary (dataReleased:false always)
  p2-policy.mjs              EUR_SPEND=0 / COST_UNKNOWN=DENY / Jules prohibited
  p1-memory-reader.mjs       real SQLite, read-only, namespace-isolated
  p1-memory-fixture.mjs      canonical schema + fixture writer
  p2-lease-interface.mjs     digest-pinned bridge to the canonical lease module
  p2-gate.mjs                THE gate: check -> read -> revalidate -> release
  p2-effect-guard.mjs        pure UNKNOWN/lost-response replay decisions
  test-support/              reference lease engine, worker CLI, ledger, fixtures
scripts/
  factory-lease-retrieval.mjs   reproducible GitHub retrieval (no S3)
  build-acceptance-package.mjs  rebuilds this package
```

## 1. Requirements

- Node.js **>= 22.5** for `node:sqlite` (verified on v22.22.3). No npm
  dependencies, no install step, no lockfile.
- `node:sqlite` emits an `ExperimentalWarning`; it is stable enough for the
  synchronous read-only use here, and the warning is expected output.

## 2. Install the files

The package mirrors the repository layout, so it can be applied wholesale:

```bash
unzip WOLF-RUFLO-P1-P2-FINAL-ACCEPTANCE.zip -d wolf-acceptance
cd <your checkout of insidethemarginmedia-cpu/wolf-factory-home>
git apply --check ../../../wolf-acceptance/WOLF-RUFLO-P1-P2-FINAL-ACCEPTANCE/ruflo-p1-p2.patch
git apply          ../../../wolf-acceptance/WOLF-RUFLO-P1-P2-FINAL-ACCEPTANCE/ruflo-p1-p2.patch
```

or copy `infra/`, `scripts/` and `tests/` directly. Both produce the same tree.

## 3. Verify the package before trusting it

```bash
cd WOLF-RUFLO-P1-P2-FINAL-ACCEPTANCE
sha256sum -c SHA256SUMS          # must print OK for every file
sha256sum -c ruflo-p1-p2.patch.sha256
```

## 4. Run the tests

```bash
# integration only
node --test tests/p1-memory-reader.test.mjs \
            tests/p2-policy.test.mjs \
            tests/p2-lease-interface.test.mjs \
            tests/p2-gate-security.test.mjs \
            tests/p2-gate-falsification.test.mjs \
            tests/p2-effect-guard.test.mjs \
            tests/p2-concurrency.test.mjs \
            tests/p2-restart-recovery.test.mjs \
            tests/factory-lease-retrieval.test.mjs

# whole repository (this is the release gate)
node --test tests/*.test.mjs
```

Expected: the numbers in [`TEST-RESULTS.md`](./TEST-RESULTS.md). The concurrency
tests spawn real OS processes and take ~1.5 s; the restart tests sleep briefly
for a lease to expire.

## 5. Wire it to the real Factory lease — REQUIRED before admission

**The package as shipped runs against a reference test double, not the Factory.**
`CANONICAL_LEASE_PIN.sha256` is `null` and `createP2Gate` refuses to construct
without `allowUnverifiedLease: true`. Do not ship that flag.

```bash
export WOLF_FACTORY_REPO_TOKEN=<read-scoped token for donraposo1-source/project-wolf>
WOLF_LEASE_OUT=infra/autonomy/mission-lease.mjs \
  node scripts/factory-lease-retrieval.mjs
#  verified   -> {"state":"RETRIEVAL_VERIFIED","sourceCommit":"<40hex>","sha256":"<64hex>"}
#  blocked    -> any other state, exit 78, and NOTHING is written
```

Then in `infra/autonomy/p2-lease-interface.mjs` set:

```js
export const CANONICAL_LEASE_PIN = Object.freeze({
  sha256: '<the sha256 printed above>',
  sourceCommit: '<the sourceCommit printed above>',
  retrievalMethod: 'GITHUB_RAW_PINNED_COMMIT',
});
```

and construct the gate with the real module:

```js
import * as factoryLease from './mission-lease.mjs';

const sourceIdentity = verifyLeaseModuleSource({
  filePath: new URL('./mission-lease.mjs', import.meta.url).pathname,
  expectedSha256: CANONICAL_LEASE_PIN.sha256,
  expectedCommit: CANONICAL_LEASE_PIN.sourceCommit,
});
if (!sourceIdentity.verified) throw new Error(sourceIdentity.state);

const adapter = createFactoryLeaseAdapter({ module: factoryLease, sourceIdentity });
const gate = createP2Gate({ adapter, memoryPath: '<P1 store path>' }); // no override flag
```

`gate.identity.lease.mode` must read `CANONICAL_VERIFIED`, and every receipt must
carry `leaseVerified: true`. If it does not, stop.

## 6. Installing into the Factory

- Place `infra/autonomy/*` alongside the existing Factory autonomy modules. The
  only import the rest of the Factory needs is `createP2Gate`.
- The memory database path is configuration, not code. Point it at the P1 store
  the Factory already maintains; this package does not create or migrate one in
  production (`p1-memory-fixture.mjs` is for tests and self-checks).
- Do **not** wire `test-support/*` into any production path. Those files are
  test doubles and are labelled as such at the top of every one of them.

## 7. What "installed" does and does not mean

Installed and passing tests means: the gate logic, SQLite reader, policy,
concurrency and replay decisions are verified. It does **not** mean the Factory
is ready to admit missions — that requires step 5 and is currently blocked. See
[`BLOCKERS.md`](./BLOCKERS.md).
