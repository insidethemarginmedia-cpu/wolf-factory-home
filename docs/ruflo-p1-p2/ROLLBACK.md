# ROLLBACK

The integration is additive: it introduces new files and modifies no existing
module, workflow, schema or checkpoint. Rolling back therefore never requires
restoring previous behaviour — it requires *removing* the new surface and
confirming nothing imported it.

---

## 0. Before you start

Determine what is actually deployed, because rollback differs:

| Deployment state | Rollback |
| --- | --- |
| Files copied in, nothing imports `createP2Gate` | §1 (delete) |
| Factory imports `createP2Gate` but no mission uses it | §2 (unwire) |
| Missions have run through the gate | §3 (unwire + audit) |

## 1. Remove the files (no consumers)

```bash
cd <checkout>
git apply -R ../../../wolf-acceptance/WOLF-RUFLO-P1-P2-FINAL-ACCEPTANCE/ruflo-p1-p2.patch
# or, if the patch does not apply cleanly:
rm -rf infra/autonomy/p2-errors.mjs infra/autonomy/p2-policy.mjs \
       infra/autonomy/p1-memory-reader.mjs infra/autonomy/p1-memory-fixture.mjs \
       infra/autonomy/p2-lease-interface.mjs infra/autonomy/p2-gate.mjs \
       infra/autonomy/p2-effect-guard.mjs infra/autonomy/test-support \
       scripts/factory-lease-retrieval.mjs scripts/build-acceptance-package.mjs \
       tests/p1-memory-reader.test.mjs tests/p2-policy.test.mjs \
       tests/p2-lease-interface.test.mjs tests/p2-gate-security.test.mjs \
       tests/p2-gate-falsification.test.mjs tests/p2-effect-guard.test.mjs \
       tests/p2-concurrency.test.mjs tests/p2-restart-recovery.test.mjs \
       tests/factory-lease-retrieval.test.mjs docs/ruflo-p1-p2
```

Then confirm the repository is back to the pre-integration baseline:

```bash
node --test tests/*.test.mjs     # expect 184/184 (the documented baseline)
```

## 2. Unwire without deleting

If the Factory calls the gate, remove the call sites first — deleting the module
underneath a live import turns a working mission into a crash. The gate is
fail-closed, so an unwired gate means **reads stop**, not "reads fall back to
unprotected SQLite". Anyone performing this step must plan for mission reads to
fail closed during the window.

1. Remove `createP2Gate` imports and call sites in Factory code.
2. Keep `p1-memory-reader.mjs` out of any path that can still reach mission data
   directly: the entire point of the gate is that there is no second route.
3. Run `node --test tests/*.test.mjs`; with the modules present it must still be
   green, proving removal did not leave a dangling reference.

## 3. After missions have run through the gate

The gate writes **nothing** to the P1 store: the reader is opened with
`readOnly: true` and pinned with `PRAGMA query_only=ON`, and
`proveReadOnly()` demonstrates a write is refused. So there is no data to undo.

The only durable traces to audit are:

- `gate.receipts()` — in-memory, append-only, lost on process exit. Not durable
  state, and they contain no payloads (asserted by
  `tests/p2-gate-security.test.mjs`).
- Any `mission-lease.mjs` file placed by `factory-lease-retrieval.mjs`, and the
  `CANONICAL_LEASE_PIN` values you set. Revert both together; a pin that no
  longer matches the file is detected by
  `verifyLeaseModuleSource` and denies rather than proceeding.

Leases are released by the Factory's own `releaseMissionClaim`. Do not release
leases as part of a rollback: a released lease is a state transition the Factory
owns, and doing it from a rollback script could strand a live mission.

## 4. Verify the rollback

```bash
git status --porcelain          # clean, or only intended removals
node --test tests/*.test.mjs    # 184/184 after a full §1 removal
grep -rn "createP2Gate" --include=*.mjs .   # expect no production call sites
```

## 5. Explicit non-actions

Rollback does **not** and must **not**:

- merge, close or reopen any pull request;
- promote a reusable-workflow pin;
- touch `docs/checkpoints/**` — those are durable mission records;
- modify the DBOS journal, KCT admission state or any publication record;
- replay, cancel or replace any mission.
