# Activation Manifest — Cryptographic Digest and Exact Instructions

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

Current pin: **`6c2848d1849d85e70ff3a9590a42b3df0465c487`**, which carries the
`workflow_call` interface and the tests that validate it.

Pinning an immutable commit is necessary but not sufficient. The commit must also
expose the interface the caller uses, and nothing verified that until
`tests/private-ci-listener-pin.test.mjs` existed.

## 4. Exact activation instructions

Do **not** apply until founder approval and independent security acceptance (§6).

```bash
# 1. Verify the base is still the reviewed commit.
git fetch origin main
test "$(git rev-parse origin/main)" = "3742bcc76ee2a5a8ff09897dda6611d50a4ef053" \
  || { echo "MAIN MOVED - re-review required"; exit 1; }

# 2. Verify the patch digest.
sha256sum docs/activation/mission-listener.patch
# expect d4aabd7ae16f79107c2c24cecafd4b6c1aa0feaafe4a4248809ec245faa14d51

# 3. Apply on a branch off main.
git switch -c activation/mission-listener-20261125 origin/main
git apply docs/activation/mission-listener.patch

# 4. Verify the four digests from §2, then commit and open a PR to main.
```

After merge, the first mission is a separate, bounded decision — see
`docs/activation/FIRST-MISSION.md`.

## 5. Rollback

Delete `.github/workflows/mission-listener.yml`. The three scripts are inert
without it; nothing else invokes them, and no file already on `main` is modified by
this patch. Rollback restores the exact prior state.

## 6. Outstanding before activation

| Requirement | Status |
| --- | --- |
| Founder approval | **NOT GIVEN** — and deliberately not assumed |
| Independent security acceptance | **NOT AVAILABLE** — `arena/156d9fee-wolf-factor*` absent from all remote heads |
| Correlated listener run | **CANNOT BE SHOWN** until the listener exists on the default branch |
| PR #743 pin decision | **OPEN** — pin is `8d319fc`, PR head is `4fd43ff`, `acceptanceValid: false` |

The patch is ready. The gate is not the engineering.
