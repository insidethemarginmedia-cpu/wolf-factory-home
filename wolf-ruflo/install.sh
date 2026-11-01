#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 || "$1" != /* ]]; then echo 'usage: install.sh /absolute/new-directory' >&2; exit 2; fi
root="$1"
mkdir -m 700 "$root"
printf '%s\n' wolf-ruflo-isolated-v1 > "$root/.wolf-ruflo-install"
exec > >(tee "$root/install.log") 2>&1
trap 'rc=$?; echo "install_exit=$rc"' EXIT
export RUFLO_DAEMON_AUTOSTART=0
node --version; corepack pnpm@8.15.0 --version
node -e 'if (+process.versions.node.split(".")[0] < 20) process.exit(1)'
[[ "$(corepack pnpm@8.15.0 --version)" == 8.15.0 ]] || exit 1
url=https://codeload.github.com/ruvnet/ruflo/tar.gz/66df9b95e1ab79d7263e491d23b20464f2906eec
curl -fLsS --retry 2 "$url" -o "$root/source.tar.gz"
echo "598aa22534a1ae8fe4a063568331a8b5460281755dfd8efd5af58b3d9d77bc71  $root/source.tar.gz" | sha256sum -c -
tar -xzf "$root/source.tar.gz" -C "$root"
source="$root/ruflo-66df9b95e1ab79d7263e491d23b20464f2906eec"
cd "$source/v3"
echo 'c64b8fd88fe5b10caef563ef0fb64e7f5e5de72f376eda35b781887d6a13c3b9  pnpm-lock.yaml' | sha256sum -c -
[[ ! -e @claude-flow/cli/dist ]] || { echo 'unexpected prebuilt CLI'; exit 1; }
corepack pnpm@8.15.0 --filter '@claude-flow/cli...' install --frozen-lockfile --ignore-scripts --reporter=append-only
for pkg in cli-core security neural memory; do
  echo "building=$pkg"
  corepack pnpm@8.15.0 exec tsc -p "./@claude-flow/$pkg"
done
corepack pnpm@8.15.0 exec tsc -b ./@claude-flow/cli --force
corepack pnpm@8.15.0 --filter '@claude-flow/cli' list --depth 0
node -e "let p=require('./@claude-flow/cli/node_modules/nostr-tools/package.json');if(p.version!=='2.25.2')process.exit(1);console.log('nostr-tools='+p.version)"
mkdir -m 700 "$root/smoke-home"
(cd "$root/smoke-home"; env -i PATH="$PATH" HOME="$root/smoke-home" RUFLO_DAEMON_AUTOSTART=0 node "$source/bin/cli.js" --help > "$root/cli-help.log")
echo 'CLI help exit=0; lifecycle scripts disabled; warnings and optional capabilities require review'
