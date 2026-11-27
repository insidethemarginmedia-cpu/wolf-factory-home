# Persistent multi-repository engineering workspace

The canonical recovery inventory is [`engineering-workspace.json`](engineering-workspace.json). It records the exact recovery SHAs, branch names, repository URLs and permission boundaries observed for this session. It distinguishes current refs from historical checkpoints and unresolved repository identities.

## Recovery and synchronization

The current Factory Home checkout remains the repository root. The local workspace creates a sibling symlink to that existing clone and stores other permitted clones under the ignored, persistent path `.engineering-workspace/repos/`; it does not make a second Home repository or a new remote repository.

```sh
node scripts/engineering-workspace.mjs --plan
node scripts/engineering-workspace.mjs
node scripts/engineering-workspace.mjs --strict
```

The default run may create a missing clone, fetch refs, and fast-forward a clean checkout of its recorded branch. `--plan` is local and read-only. `--strict` returns nonzero if any requested repo cannot be synchronized or a required repository identity is unresolved. The script never resets, cleans, checks out, rebases, pushes, dispatches, or merges a PR. If a worktree is dirty, it fetches remote refs only and leaves the files and branch untouched. If branches diverge or the recorded recovery anchor is missing, it refuses to move the checkout. Credentials are never copied into a URL or manifest; existing Git credential helpers are used only for a read-only access probe and clone/fetch.

## Verified repository state

- **Factory Home** — existing clone at this repository root, branch `arena/38f3a7f7-wolf-factory-home`. Recovery anchor `4579e4f990595e0704e24d65ed9babb557b0d0d4`; PR #2 is open against `feat/public-runtime-probe-20261022`. The anchor predates this workspace change; future commits on the PR branch should descend from it. The current session can push its branch. Dispatch is not authorized; merge approval is absent.
- **Wolf Compute** — public repository `donraposo1-source/wolf-compute`, branch `main`, exact observed HEAD `f00dd8860edd245e53a11feee24270bc553ded2b`. Its two other reachable branches were `lab/composio-g3-20261006` at `ad995ee92988adbe958b52ba31b47db9c211c04c` and `lab/wolf-composio-skill-pack-v1-20261006` at `4a52cd4d7a6d64013d723f798930d9f0744a1260`. The public main and those refs do not supply the authoritative private-worker callback, terminal receipt, or durable recovery contract described in [`executor-pin-recovery.md`](executor-pin-recovery.md). A persistent clone of `main` is kept locally when storage permits.
- **Private Project Wolf** — URL `https://github.com/donraposo1-source/project-wolf.git`; the historical checkpoint records branch `feat/factory-real-worker-m1-20261006` at `4c9726d2a964ad32b01263b4a5e3b9a7014660fe`. That is **not** asserted as the current head. The current session's GitHub API request returned 404, so read access and current refs cannot be verified; the recovery script leaves it un-cloned unless a read-only Git probe succeeds under existing authorization.
- **Build Wolf PR #749** — repository identity, URL, branch, and SHA remain unresolved. The authenticated visible-repository inventory did not identify a Build Wolf repository; a PR number alone is not enough to fetch safely. No repo is guessed and no private code is copied.

## Recovery guarantees and limits

If the ignored clone directory is removed by an ephemeral environment, the tracked manifest and script can reconstruct public Wolf Compute from the authoritative GitHub URL and verify the exact recovery anchor. The existing Home root remains the canonical Home clone. Private Project Wolf is recovered only when the environment can read it and its branch contains the recorded historical anchor; otherwise the tool reports the access/anchor blocker without overwriting local data. PR #749 cannot be recovered until its authoritative repository URL is established.

This workspace is engineering support only. It does not change hosted databases, deploy through Vercel, activate Factory Home, create a mission, dispatch a worker, or spend money. `EUR_SPEND=0`; `COST_UNKNOWN=DENY`, `PAID_FALLBACK=DENY`, `UNVERIFIED_BILLING=DENY`, and `UNVERIFIED_PROVIDER=DENY`; Jules remains prohibited.
