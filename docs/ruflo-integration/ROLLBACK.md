# Rollback — Wolf × Ruflo integration package

This package changes only paths under `integration-tests/` and `docs/ruflo-integration/`.
Nothing under `main`, `.github/`, `scripts/`, `tests/` (public runtime), or the existing checkpoints was modified.
PR #1 was not touched.

## Revert the package

```bash
cd /home/user/wolf-factory-home            # or your clone
git checkout arena/3f5e2ca6-wolf-factory-home
git revert --no-edit <commit-that-added-integration-tests>
git push origin arena/3f5e2ca6-wolf-factory-home
```

Or remove the directories directly (equivalent, without history):

```bash
rm -rf integration-tests docs/ruflo-integration
```

Verify the revert left the public runtime suite unchanged:

```bash
node --test tests/*.test.mjs        # expected: 184 pass (baseline)
```

## Remove local state

- `integration-tests/node_modules/` — `rm -rf` (regenerable with `npm ci`).
- Temp directories created by tests (`/tmp/wolf-mem-*`, `/tmp/wolf-mcp-*`, `/tmp/wolf-adapter-*`) are removed by each suite; leftovers from crashed runs can be deleted safely.
- Adapter state files written by tests live only in those temp directories. No production store is written.
- Upstream scratch clone `/home/user/claude-flow-source` (outside the repo) can be deleted: `rm -rf /home/user/claude-flow-source`.

## Not applicable

No database migrations, no workflow changes, no secrets, no deployed services. No external effects were created.
