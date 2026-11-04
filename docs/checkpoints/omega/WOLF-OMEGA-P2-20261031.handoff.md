# Wolf Omega P2.0 — recovery handoff (2026-10-31)

Branch: `arena/b9b951dd-wolf-factory-home`, forked from `e2eeed64dd4d0f5ecd54a31b39712a913438c183`
(PR #1 head, still OPEN / DRAFT / UNMERGED). Nothing was merged, promoted or force-pushed.

Machine-readable companion: `docs/checkpoints/omega/WOLF-OMEGA-P2-20261031.inventory.json`.

## 1. What this environment can and cannot touch

| Surface | State | Hard evidence |
| --- | --- | --- |
| `insidethemarginmedia-cpu/wolf-factory-home` | GRANTED | `gh api repos/...` → `private=false` |
| `donraposo1-source/project-wolf` | **BLOCKED** | REST → `404 Not Found`; `git ls-remote` → `remote: Write access to repository not granted` / `error: 403` |
| CircleCI `verify-build #11280` | **BLOCKED** | no credentials; logs unreachable |
| gitleaks 8.30.1 binary | **BLOCKED** | release download 302 → `objects.githubusercontent.com`, then `SSL_ERROR_SYSCALL` |
| Composio MCP | **BLOCKED** | `list_connector_tools('composio')` → `unsupported` |
| Google Antigravity | **BLOCKED** | zero references in any tracked file |

This is why several P0 items below are reported as blocked rather than "fixed". No scan,
test, receipt or execution result in this document was invented.

## 2. Defects found, reproduced, corrected

### D1 — a scheduled wakeup can be green while doing nothing  (P0, §12)

**Reproduced from live CI, not from reading code.** Run `41174505505`
(`schedule`, `main@3742bcc`, callee `private-controller-preflight.yml@c6ddef9c`) concluded
`success` in 8 seconds after executing exactly one step:

```
Reserve one durable wakeup without external mission effects      success
Require currently observable free provider quota before inference skipped
Persist safe suspension after bounded gate failure               skipped
every downstream mission job                                     skipped
```

The reservation reported `ready != 'true'`. The quota gate and all mission jobs were
therefore skipped, and the only disposition step required `failure()`, which cannot be true
for an idle job. The run was administratively green while provably performing no mission
work — exactly the `STOPPED_RECONCILIATION_REQUIRED` pattern the mandate says must never be
counted as autonomous acceptance.

**Correction** (`.github/workflows/private-controller-preflight.yml`): a wakeup that does not
admit mission work now runs `Record explicit operational skip without mission work`, which
writes `WOLF_WAKEUP_OPERATIONAL_OUTCOME=NO_MISSION_WORK_PERFORMED` to the run summary and a
machine-readable `operational_outcome` output. The job publishes one authoritative
`operational_outcome` (`MISSION_WORK_ADMITTED` / `NO_MISSION_WORK_PERFORMED` /
`V1_TERMINAL_DISPOSITION_ONLY` / `OPERATIONAL_OUTCOME_UNDETERMINED`) and declares it under
`on.workflow_call.outputs`. The new step is credential-free: no token, no secret, no git, no
provider call, no private script — it cannot create an external effect.

**Tests** — `tests/night-shift-operational-outcome.test.mjs`, 6 tests: the exact production
step statuses now force a receipt; the admitted flag still requires the quota gate;
suspension still follows a real gate failure; every disposition resolves to a definite
value. Falsified against the pre-fix workflow (all assertions fail before the change).

### D2 — a proven external effect could be stranded as UNKNOWN forever  (P0, §8/§9)

`recoverPublicationUncertainty` confirmed an effect only when the remote tip equalled the
recorded candidate exactly. In the normal protocol the branch legitimately advances past a
candidate (the next mission or checkpoint), so a push that *did* land was reported as
`CONFLICTING_REMOTE_STATE` and stayed `UNKNOWN_UNTIL_RECONCILED` permanently. Every later
`publishCompareAndSwapCommit` for that mission then failed with
`UNKNOWN_EXTERNAL_EFFECT_REPLAY_DENIED`: the mission could never progress and no terminal
classification was ever recorded.

**Correction** (`scripts/git-publication-preflight.mjs`): when the recorded candidate is a
Git ancestor of the observed tip — computed only from objects already present locally, with
no fetch and no push — the effect is confirmed as
`externalEffectState: "VERIFIED"`, `effectDisposition: "CONFIRMED_SUPERSEDED"`,
`supersededBy: <tip>`, preserving `headSha`, `baseSha`, `missionId`, `checkpointId` and
`leaseFence`. Anything else (rewritten history, unrelated divergence, absent ref) is
unchanged and stays UNKNOWN with `ancestryProven: false`. Nothing is inferred from an empty
result.

**Tests** — `tests/publication-reconciliation-superseded.test.mjs`, 3 tests: superseded land
is confirmed without touching the remote; the mission then reports `alreadyCompleted` with the
original commit and the remote ref is byte-identical (no second effect); rewritten history and
an absent ref still stay UNKNOWN. Falsified against the pre-fix script (3/3 fail).

### D3 — gitleaks suppression policy was unenforced  (P0, §4)

I could not run the scanner, so I did not claim a scan. What I could do — and did — was verify
the seven suppressions directly, by fetching the exact blob at the exact fingerprint commit and
reading the exact line:

- 4 × `generic-api-key` are the literal `"executionKey": "<sha256>"` (and one `jobB` line) of a
  public canonical mission digest, equal to the recorded `expectedDigest`;
- 3 × `private-key` are single-line validation literals,
  `startsWith/endsWith('-----BEGIN OPENSSH PRIVATE KEY-----')`, with no PEM body;
- a repository-wide scan finds no complete PEM block with a base64 body.

`tests/gitleaks-immutable-findings.test.mjs` (7 tests) now enforces the policy permanently:
only exact `<40-hex>:<path>:<rule>:<line>` fingerprints, no wildcards, no rule/path/pattern
allowlist, exact one-to-one correspondence with the evidence document, `credential: false`
required for every suppressed finding, mission digests recomputed against the repository, and
a falsification case proving an unrelated new finding can never be suppressed by these entries.
The PEM detector was itself falsified with a synthetic key block.

## 3. Verification receipts

```
node --test tests/*.test.mjs           156/156 PASS   (140 baseline + 16 new)
node --check scripts/*.mjs tests/*.mjs ALL_MODULES_PARSE=OK
YAML parse (yaml@2, out-of-tree)        private-controller-preflight.yml + night-shift-wakeup.yml OK
```

Pre-push guard, executed as a real process in a real repository:

```
valid single-ref input, fence present ..... proceeds to lease/fence checks
two refs in one push ..................... MULTIPLE_PUBLICATION_REFS_DENIED (exit 1)
missing WOLF_GIT_PUBLICATION_FENCE ....... STALE_LEASE_FENCE_REJECTED (exit 1)
```

## 4. Mission B — unchanged, EFFECT_UNKNOWN

`docs/checkpoints/runner-loss/41040712384-b-intent.json` corroborates the mandate:
`state: INTENT`, `fencingToken: 1`, `executionKey: 8efdf3d4…f96b`, checkpoint A persisted at
`e6b2270152552ef4bcd91922b7a30c3c79c5fd8b`, and `docs/checkpoints/runner-loss/41040712384.json`
holds the durable `NEXT_READY` continuation.

The authoritative external evidence — Boxxkite create identity, DBOS journal, mission lease,
publication record — is not reachable. Absence of evidence is not evidence of absence, so the
classification remains **EFFECT_UNKNOWN**. No replay, no replacement execution key, no lease
release and no terminal checkpoint was produced by this work.

## 5. What must happen next, in order

1. **Grant private read access** (or a scoped token) to `donraposo1-source/project-wolf`.
   Everything in §4/§7/§8/§9/§10/§11/§13 of the mandate is currently unreachable through this
   single dependency.
2. **Reproduce `verify-build #11280`** with gitleaks 8.30.1 and the pinned SHA-256 once the
   binary is obtainable; the classification method proven here (exact blob at the exact
   fingerprint commit) transfers directly to `docs/checkpoints/omega/WORK-RECOVERY-P0-20261030.json`.
3. **Promote D1 deliberately.** The fix is inert until the reusable-workflow pin in
   `.github/workflows/night-shift-wakeup.yml` is advanced on `main`; that is a separate founder
   decision and was not taken here.
4. **Reconcile Mission B** against authoritative receipts, then admit Mission C.
5. **Do not** treat any of the recent green scheduled runs as autonomous acceptance. The
   evidence in §2/D1 shows why.
