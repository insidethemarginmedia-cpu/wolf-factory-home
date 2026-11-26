# Activation Manifest — Historical Cryptographic Digest (Superseded)

**This manifest is not an activation instruction.** It describes the earlier
P144 patch and pins, not the current durable-store/reusable-workflow implementation.
Do not apply the patch or follow any old branch/merge command. Current status is
BLOCKED; only `arena/38f3a7f7-wolf-factory-home` is authorized, and no default-
branch change or mission dispatch is approved by this document.

Reviewed against `main` = `3742bcc76ee2a5a8ff09897dda6611d50a4ef053`.
Prepared on `arena/38f3a7f7-wolf-factory-home` @ `0cc694f`.

## 1. Patch digest

```
file     docs/activation/mission-listener.patch
sha256   d4aabd7ae16f79107c2c24cecafd4b6c1aa0feaafe4a4248809ec245faa14d51
base     3742bcc76ee2a5a8ff09897dda6611d50a4ef053
status   APPLIES CLEANLY (verified against a fresh git archive of main)
```

## 2. Per-file digests

```
31e83d4a21ae8d2aa822a78678218c6f16600d3c10186ce9d069bb00059a5a7d  .github/workflows/mission-listener.yml
1cbf3d7215eb2d839d0a408c281ce6f00882071b3606e01e4cfa32b9cdcfd097  scripts/private-ci-listener.mjs
d0298d00c96bc202def7fa7c2e2f793ac665f9a92edd70fa59609bb791768d03  scripts/private-ci-listener-cli.mjs
7e4ccb940e7caadf570374ee9fb9a6199975acf1ec7d0496d304d59bccf45e6c  scripts/private-ci-mission.mjs
```

Verify before applying:

```bash
sha256sum -c <<'EOF'
31e83d4a21ae8d2aa822a78678218c6f16600d3c10186ce9d069bb00059a5a7d  .github/workflows/mission-listener.yml
1cbf3d7215eb2d839d0a408c281ce6f00882071b3606e01e4cfa32b9cdcfd097  scripts/private-ci-listener.mjs
d0298d00c96bc202def7fa7c2e2f793ac665f9a92edd70fa59609bb791768d03  scripts/private-ci-listener-cli.mjs
7e4ccb940e7caadf570374ee9fb9a6199975acf1ec7d0496d304d59bccf45e6c  scripts/private-ci-mission.mjs
EOF
```

## 3. The executor pin, and why it changed twice

The listener calls the bridge at an immutable SHA. Two corrections were needed, and
both are worth recording because each was invisible without a specific check.

| Pin | Why it was wrong |
| --- | --- |
| `96cab35` | Predates `workflow_call`. `grep -c workflow_call` at that commit returns **0**, so a job-level `uses:` against it fails with "workflow is not reusable". Immutable and approved, and still unusable. |
| `aefeb45` | Correct interface, but referenced an intermediate commit rather than the reviewed one. |

At this historical snapshot (`0cc694f`), the listener was configured to use
**`6c2848d1849d85e70ff3a9590a42b3df0465c487`**. That object exists and contains
`workflow_call`, but its tree predates the current durable admission gate,
`executorSha` input, and explicit secret contract; it is not a valid activation pin
for the current implementation.

The later worktree value `9679aa76397c7b248c3708be2c063e75a7058ae5` was checked
against both the local Git object database and GitHub's commit API and does not
resolve. No replacement was guessed. A usable pin must resolve to a real remote
commit whose workflow tree passes `tests/private-ci-listener-pin.test.mjs` and
`tests/workflow-pins-resolve.test.mjs`; a 40-hex string alone is insufficient.

## 4. Activation instructions — withdrawn

The earlier branch-creation and patch-application procedure is withdrawn and
must not be run. It conflicts with the current branch restriction,
and its patch predates durable admission, gate checks, explicit secret passing,
and the current no-recovery status.

There is no activation command in this manifest. Any default-branch landing,
permission change, or first mission requires explicit Founder approval and an
independent review after the current contract and pin have been verified.

## 5. Rollback

Delete `.github/workflows/mission-listener.yml`. The three scripts are inert
without it; nothing else invokes them, and no file already on `main` is modified by
this patch. Rollback restores the exact prior state.

## 6. Historical outstanding items; current blockers remain open

| Requirement | Status |
| --- | --- |
| Founder approval | **NOT GIVEN** — and deliberately not assumed |
| Independent security acceptance | **NOT AVAILABLE** — `arena/156d9fee-wolf-factor*` absent from all remote heads |
| Correlated listener run | **CANNOT BE SHOWN** until the listener exists on the default branch |
| PR #743 pin decision | **OPEN** — historical P145 recorded pin `8d319fc` vs head `4fd43ff`; refresh through authorized private reader before any mission |
| Factory P1.59 / Factory 2 P1.47+ envelope and callback schema | **NOT RECONCILED** |
| Durable execution queue, lease/fence, schedule recovery | **NOT IMPLEMENTED / DISABLED** |
| Real worker + authenticated callback + independent verification | **NOT OBSERVED** |

This historical patch is not ready for activation. The current implementation,
executor pin, upstream contract, and required approvals must be reviewed together.
