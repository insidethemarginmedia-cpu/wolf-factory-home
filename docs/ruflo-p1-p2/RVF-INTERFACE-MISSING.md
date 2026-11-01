# The RVF interface that is still missing

The mandate says: *"If native Ruflo RVF is unavailable, complete the SQLite
integration first and document the precise RVF interface still missing."*

Native Ruflo RVF is unavailable. This is that document. It is a specification of
the seam, not a claim that anything behind it exists.

---

## 1. What is implemented today

```
P2 gate ──► p1-memory-reader.mjs ──► node:sqlite ──► mission_memory table
```

The reader's contract is deliberately narrow:

```js
reader.get(scope, key)      // -> row | null      (scope = { missionId, namespace })
reader.list(scope, opts)    // -> row[]           (never crosses mission)
reader.stats()              // -> { rows, schemaVersion }
reader.proveReadOnly()      // -> { readOnly: true, method }
reader.close()
```

with the invariants the gate depends on:

| Invariant | Enforced by |
| --- | --- |
| synchronous completion | `node:sqlite` is a synchronous binding |
| read-only | `{ readOnly: true }` + `PRAGMA query_only=ON` |
| namespace isolation | every statement parameterised on `mission_id` **and** `namespace`, plus a post-fetch assertion |
| fail-closed | typed `P2Denied` — never an empty result for an unreadable store |
| schema contract | `P1_REQUIRED_COLUMNS` checked before the first read |

## 2. What Ruflo RVF must provide to replace it

An RVF backend becomes admissible only when it can satisfy **all eight** of the
following. Each is stated as a testable assertion, so the acceptance test can be
written before the backend exists.

**R1 — Synchronous, or explicitly scoped read.**
Either a synchronous read API, or a documented guarantee that an in-flight RVF
read cannot interleave with revocation on the same runtime. The current design
relies on synchronous execution to make "revalidate before return" race-free.
An async RVF client must therefore be wrapped so the whole
check → read → revalidate sequence runs inside one claim scope with no
`await` between read and revalidation.

**R2 — Mission-scoped addressing.**
A read must be expressible as `(missionId, namespace, key)` and must return
nothing else. Wildcard or "all namespaces" handles must not exist, or must be
unrepresentable in the adapter.

**R3 — Read-only handles with a provable mode.**
An equivalent of `proveReadOnly()`: a mode the adapter can assert, plus a
negative probe proving a write is refused. A backend that only *documents*
read-only is not acceptable.

**R4 — Integrity signal, not silent emptiness.**
A way to distinguish "corrupt / unavailable / schema-drifted" from "no rows".
Concretely: an integrity or health call whose failure raises, so `MEMORY_CORRUPT`
can be produced. Returning `[]` for a broken store is the single most dangerous
possible behaviour here and must be absent.

**R5 — Stable identity for the store.**
Something to pin in the integration manifest — a store version, generation
counter, or content digest — so a receipt can record *which* memory store served
a read.

**R6 — Durability bound across restart.**
A stated guarantee about what survives a process restart, and after how long.
`tests/p2-restart-recovery.test.mjs` currently proves this for SQLite; the RVF
equivalent must be provable by the same shape of test.

**R7 — Error taxonomy mapping to `P2_CODES`.**
A documented error surface the adapter can map onto
`MEMORY_UNAVAILABLE` / `MEMORY_CORRUPT` / `MEMORY_READ_FAILED` /
`MEMORY_SCHEMA_DENIED`. Unmapped errors must default to a denial, never to data.

**R8 — No bypass path around the gate.**
No second client, admin handle, or "direct" constructor that lets a worker read
memory without going through `createP2Gate`. In the SQLite implementation this is
enforced by not exporting the `DatabaseSync` handle; RVF must offer the same
closure property.

## 3. What is needed to close this out

1. A Ruflo RVF backend reachable from the Factory environment.
2. Its read/health/mode API, or a pointer to it in a reachable repository.
3. A decision on R1 (synchronous, or a locked scope around async reads).

With those, `p1-memory-reader.mjs` becomes one of two implementations behind a
shared port, and `p2-gate.mjs` does not change at all — which is the point of
having kept the reader's surface this narrow.

## 4. Explicit non-claims

- No RVF code was written, because there is no specification to write it against.
- No RVF test exists or was skipped-as-passing. The suite reports
  `# skipped 0`; nothing is being hidden behind a skip.
- The SQLite integration is *not* a stand-in for RVF. It is a complete
  implementation of the P1 port for a SQLite store.
