# BLOCKERS — genuinely unresolved issues

This file lists only things that are **actually** blocked, with the command that
demonstrates the block. Nothing in this package is reported as passing unless it
ran here.

---

## B1 — `BLOCKING`. The canonical Factory lease implementation was never retrieved.

**Impact:** the single most important acceptance criterion — *"use the real
Factory lease implementation"* — **cannot be satisfied**. No test in this package
exercised `infra/autonomy/mission-lease.mjs`.

**Evidence (reproducible from this environment):**

```
$ curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $GH_TOKEN" \
    https://api.github.com/repos/donraposo1-source/project-wolf
404

$ curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $GH_TOKEN" \
    https://api.github.com/repos/donraposo1-source/project-wolf/git/ref/heads/feat/factory-real-worker-m1-20261006
404
{"message":"Not Found","documentation_url":"https://docs.github.com/rest/git/refs#get-a-reference","status":"404"}

$ git ls-remote https://github.com/donraposo1-source/project-wolf.git
remote: Write access to repository not granted.
fatal: unable to access '...': The requested URL returned error: 403

$ curl -sS https://raw.githubusercontent.com/donraposo1-source/project-wolf/90cf21ae.../infra/autonomy/mission-lease.mjs
curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL   # host outside egress allowlist

$ gh api /user/repos --jq '.[].full_name'
insidethemarginmedia-cpu/wolf-factory-home          # the only repository this token can see
```

The authenticated identity is `insidethemarginmedia-cpu` with a single-repository
token. There is no credential in this environment that can read
`donraposo1-source/project-wolf`. This is the same block recorded in
`docs/checkpoints/omega/WOLF-OMEGA-P2-20261031.handoff.md` §1 and
`WOLF-OMEGA-P4-20261031.handoff.md` §1 — it is not a transient failure.

**What was done instead (and why it is not a substitute):**

`infra/autonomy/test-support/reference-lease-engine.mjs` implements the same
four-export contract (`claimMission`, `assertMissionClaim`,
`releaseMissionClaim`, `withMissionClaimWriteAuthority`) over real SQLite, with
real file locking and real fence advancement. It is a **test double**. Every
receipt it produces is stamped `leaseMode: "UNVERIFIED_INTERFACE_ONLY"` and
`leaseVerified: false`, and `createP2Gate` **refuses to construct** against it
unless the caller passes `allowUnverifiedLease: true`. `CANONICAL_LEASE_PIN.sha256`
is `null` and `retrievalMethod` is `"UNRETRIEVED"` — deliberately, because
inventing a digest would be a fabrication.

**Removal:** grant a read-scoped token for `donraposo1-source/project-wolf`, then:

```bash
WOLF_FACTORY_REPO_TOKEN=<token> \
WOLF_LEASE_OUT=infra/autonomy/mission-lease.mjs \
node scripts/factory-lease-retrieval.mjs
# -> {"state":"RETRIEVAL_VERIFIED","sourceCommit":"<40-hex>","sha256":"<64-hex>",...}
```

Then set `CANONICAL_LEASE_PIN.sha256` / `sourceCommit` in
`infra/autonomy/p2-lease-interface.mjs`, import the module, and re-run the suite
with `allowUnverifiedLease: false`. The gate wiring does not change.

---

## B2 — `BLOCKING`. Native Ruflo RVF memory was not exercised.

**Impact:** `"do not claim native RVF integration unless a real Ruflo RVF backend
is actually exercised"` — so none is claimed. The P1 store here is **SQLite**,
read through `node:sqlite`.

**Evidence:** there is no Ruflo RVF backend, adapter, schema, or specification
in the accessible repository. A case-insensitive search of every tracked file
for `rvf` returns no implementation to integrate against:

```
$ grep -ril "rvf" . --exclude-dir=.git --exclude-dir=node_modules
(no matches)
```

The precise interface that is still missing is specified in
[`RVF-INTERFACE-MISSING.md`](./RVF-INTERFACE-MISSING.md).

---

## B3 — `NON-BLOCKING` but relevant. The public runtime cannot run the private suite.

`insidethemarginmedia-cpu/wolf-factory-home` contains no `package.json` and no
application source (by design — see its `README.md`). The private `npm test`,
`npm run build` and the CircleCI `verify-build` pipeline referenced in the
mandate live only in the private repository and remain unreachable, exactly as
recorded in §1 of the P4 handoff.

---

## B4 — `ENVIRONMENTAL`, not a product defect. Node's `fetch` cannot reach GitHub here.

In this sandbox `fetch()` fails with `unable to verify the first certificate`
against `api.github.com` (TLS-intercepting egress proxy), while `curl` and `git`
get clean HTTP responses. This is why
`scripts/factory-lease-retrieval.mjs` run *here* reports
`RETRIEVAL_NETWORK_FAILED` at the `ref` stage rather than `REF_NOT_FOUND`.

Both roads end at the same place — **the repository is not readable** — but B1
is classified on the `curl`/`git` evidence, which is the stronger signal
(authoritative HTTP 404/403, not a transport fault). The retrieval script's own
logic is covered by 9 deterministic tests with an injected transport
(`tests/factory-lease-retrieval.test.mjs`).

---

## Not blocked, and therefore not listed here

The following were asked for and are **done and passing**: real SQLite P1 reads,
read-only enforcement, namespace isolation, expired/released/stale-fence
rejection, revalidation before data release, concurrent multi-process
serialization, restart recovery, UNKNOWN-effect replay denial, lost-response
idempotency, Jules rejection, and zero-spend admission. See
[`TEST-RESULTS.md`](./TEST-RESULTS.md).
