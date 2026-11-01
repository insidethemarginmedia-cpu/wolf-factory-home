# Ruflo P1 — isolated experimental installation

**NOT READY FOR FACTORY INTEGRATION.** Do not connect this package to production missions, secrets, or private Factory workers. Cross-executor persistence and real KCT/DBOS integration have not been demonstrated. The runtime is subordinate to the existing controller; no scheduler, admission, publishing or provider implementation is supplied here.

## Reproducible installation and build

Tested on Linux x86_64, Node 22.22.3, corepack 0.34.6 with pnpm 8.15.0, Python 3.11.2. Ruflo declares Node >=20. The target must be a new absolute directory. The script downloads the source, verifies the pinned archive and v3 lock SHA-256, installs the pnpm 8.15.0 frozen workspace lock without lifecycle scripts, and builds `cli-core`, `security`, `neural`, `memory`, then the CLI from an initially absent dist. It disables daemon autostart and tests `--help` in a fresh empty HOME:

```
./wolf-ruflo/install.sh /absolute/path/to/new-isolated-directory
```

Requires network access to codeload.github.com and registry.npmjs.org. The install log contains commands' output and final `install_exit`; inspect it before sharing because your own environment may produce sensitive output. Only a subset of workspace packages is built; intentionally ignored lifecycle scripts may be needed by native optional packages. pnpm reported missing `agentdb` and pre-build workspace bin targets; inspect `TEST-RESULTS.md` before treating any optional feature as usable. The full runtime, native modules, and dependency graph are **not** accepted as production safe. The frozen lock records exact versions/integrities in `pnpm-lock.yaml`; `dependency-lock.json` is the legacy root npm lock inventory, not the active v3 graph. No global npm installation or dependency version update is performed.

Archive SHA-256 `598aa22534a1ae8fe4a063568331a8b5460281755dfd8efd5af58b3d9d77bc71`; v3 pnpm lock SHA-256 `c64b8fd88fe5b10caef563ef0fb64e7f5e5de72f376eda35b781887d6a13c3b9`. These are pinned checksums, not independent source signatures.

## Tests and MCP

```
export WOLF_RUFLO_CLI=/absolute/path/to/new-isolated-directory/ruflo-66df9b95e1ab79d7263e491d23b20464f2906eec/bin/cli.js
./wolf-ruflo/verify.sh
python3 wolf-ruflo/mcp_probe.py "$WOLF_RUFLO_CLI"
```

Without `WOLF_RUFLO_CLI`, the real MCP gateway test is skipped; check test output. `mcp_gateway.py "$WOLF_RUFLO_CLI"` is a local experimental stdio gateway which forwards only `agent_list` with empty arguments. It rejects all other calls and methods itself; upstream advertising filters alone are not authorization. It starts a child with an empty temporary HOME, no inherited provider credentials and `RUFLO_DAEMON_AUTOSTART=0`, and shuts it down on EOF, SIGTERM or SIGINT. It does not isolate the network, authenticate users, enforce KCT, or provide tenant isolation. It must not be exposed as a production MCP server. Do not run unrestricted upstream commands or the upstream server against production state; upstream has autonomous and cloud-facing features.

## Memory and Factory contracts

`ruflo_memory.py` maps a small JSON subset of the real Ruflo `MemoryEntry` (`namespace`, `key`, `content`, and JSON-compatible additional fields) to `memory.py`'s SQLite store. It is **not** the upstream RVF backend, not an implementation of the full Ruflo `IMemoryBackend`, and not wired into the CLI or Factory. No vector search is supplied. It is a portable local context adapter, not a durable cross-executor service.

SQLite stores plaintext; no secrets. Use a trusted private directory on a local POSIX filesystem with SQLite locking and fsync support; do not assume network filesystems, multi-host locks or ephemeral files survive executor replacement. The code rejects WAL sidecar files and operates only on the default rollback-journal mode. `memory.initialize(path)` creates a new version-1 store exclusively. `WolfContextStore(path).store(mission, operation, fence, entry)` and `.get_by_key(mission, key)` isolate namespaces but **do not authorize callers**. Local monotonic fencing detects some stale values only after a newer fence is recorded, and is not a lease. The trusted Factory must verify current KCT admission and fence atomically at the true effect boundary.

`worker_contract.prepare` is a non-executing context contract: a trusted injected authority supplies verified claims, including lease, identity, economic decision and effect state. The function rejects unknown/receipted effects instead of replaying, prohibits Jules and returns no capability to run or publish anything. The fake authority in tests is not KCT. Duplicate-delivery prevention and the independent verifier, journal, reconciliation and publication gates remain responsibilities of the existing Factory. No worker router or Flint provider code was changed.

Backup and offline copy recovery are described in ROLLBACK.md. There is no automatic migration: incompatible state fails closed. Approval, actual integration, secure durable storage and live acceptance are outstanding.
