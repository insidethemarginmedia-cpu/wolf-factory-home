#!/usr/bin/env bash
set -euo pipefail
# Removes ONLY the isolated installer directory, never a memory store or Factory.
[[ $# == 2 && "$1" == /* && "$2" == 'DELETE-ISOLATED-INSTALL' ]] || { echo 'usage: rollback.sh /absolute/isolated-install DELETE-ISOLATED-INSTALL' >&2; exit 2; }
root="$1"
[[ ! -L "$root" && -d "$root" && -f "$root/.wolf-ruflo-install" && ! -L "$root/.wolf-ruflo-install" ]] || { echo 'installation marker missing' >&2; exit 1; }
[[ "$(cat "$root/.wolf-ruflo-install")" == wolf-ruflo-isolated-v1 ]] || exit 1
canonical="$(realpath -e -- "$root")"
repo="$(realpath -e -- "$(dirname "$0")/..")"
home="$(realpath -e -- "$HOME")"
[[ "$canonical" != / && "$canonical" != /home && "$canonical" != "$home" ]] || exit 1
case "$repo/" in "$canonical/"*) echo 'repository or its ancestor denied' >&2; exit 1;; esac
rm -rf -- "$canonical"
echo 'isolated installation removed; memory and Factory not touched'
