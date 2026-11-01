# Install and run — Wolf × Ruflo integration package

Prerequisites: Node.js 22.x (verified with 22.22.3), npm 10.x (verified with 10.9.8).
For the upstream source build only: pnpm **8.15.0** (the version declared by upstream `v3/package.json`).
pnpm 12 is **not** supported for this lockfile (see TEST-RESULTS.md §1.1).

## 1. Test package (Wolf side)

```bash
git clone https://github.com/insidethemarginmedia-cpu/wolf-factory-home.git
cd wolf-factory-home
git checkout arena/3f5e2ca6-wolf-factory-home
cd integration-tests
npm ci                # uses the committed package-lock.json (verified: exit 0)
npm test              # 47 tests; currently exit 1 with 4 documented FAILs (see TEST-RESULTS.md)
```

Individual suites:

```bash
npm run test:wolf-adapter   # 15/15 expected
npm run test:mcp            # 17/20 expected: 5c, 5d (upstream allowlist) and 12 (upstream daemon default) fail
npm run test:rvf            # 11/12 expected: concurrency test fails (lost writes)
```

Expected results are the **current** results, not acceptance. A green run is not claimed.

## 2. Ruflo CLI source (optional, upstream commit)

The default test target is the npm-registry package `ruflo@3.67.0` installed by `npm ci`.
To run the suite against an upstream source build instead:

```bash
git clone https://github.com/ruvnet/claude-flow.git ruflo-src
cd ruflo-src && git checkout 66df9b95e1ab79d7263e491d23b20464f2906eec
npx --yes pnpm@8.15.0 install --frozen-lockfile --ignore-scripts   # run from v3/
cd v3 && npx --yes pnpm@8.15.0 -r build                             # exit 0 verified
cd @claude-flow/cli && npx --yes pnpm@8.15.0 run build              # exit 0 verified
cd /path/to/wolf-factory-home/integration-tests
RUFLO_CLI=/path/to/ruflo-src/v3/@claude-flow/cli/bin/cli.js npm test
```

Do **not** run `npm ci` inside `v3/@claude-flow/cli`: no lockfile exists there (exit 1).

## 3. Wolf MCP entry point

Use the proxy, not the raw server, if the Wolf allowlist must be enforced:

```bash
node integration-tests/adapter/mcp-allowlist-proxy.mjs \
  integration-tests/node_modules/@claude-flow/cli/bin/cli.js \
  integration-tests/adapter/wolf-mcp-allowlist.json
```

The raw `ruflo mcp start` exposes 380 tools, does not enforce the allowlist at call time, and (by default) starts a detached daemon. Set `RUFLO_DAEMON_AUTOSTART=0` when running it directly.

## 4. Environment

- `RUFLO_CLI` — path to the Ruflo CLI entry (default: the npm-installed package).
- `RUFLO_DAEMON_AUTOSTART=0` — **required** for any Wolf use of the Ruflo CLI in a workspace. Without it, the CLI starts a detached background daemon (see TEST-RESULTS.md §5). The test suites and the Wolf MCP proxy set it.
- `CLAUDE_FLOW_DB_PATH` — set per test to isolated temp directories by the suites. Never point it at a shared store.
- No credentials are required. Tests set sentinel values only, to check they are not leaked.
- Expect `✅ Using sql.js (WASM SQLite…)` and `persistence is not guaranteed` in CLI output. This is the known fallback, not a passing durable backend.
