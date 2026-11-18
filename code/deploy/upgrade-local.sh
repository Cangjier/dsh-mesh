#!/usr/bin/env bash
#
# Compatibility entry point only.
#
# The deploy runner (including the one from an older package) executes this
# path, so it stays as a two-line shim: find the extracted package it was
# handed and run the single implementation, upgrade-local.mjs. Everything else
# lives in the .mjs — there is no shell upgrade logic left to keep in sync.
#
set -euo pipefail

STAGE=""
prev=""
for arg in "$@"; do
  case "$prev" in
    --stage) STAGE=$arg ;;
  esac
  case "$arg" in
    --stage=*) STAGE=${arg#--stage=} ;;
  esac
  prev=$arg
done
if [ -z "$STAGE" ]; then
  HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  STAGE=$(CDPATH= cd -- "$HERE/../.." && pwd)
fi
NODE="$STAGE/runtime/node/bin/node"
[ -x "$NODE" ] || NODE=$(command -v node || true)
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "[error] 找不到 node（包内 runtime 缺失）" >&2; exit 1; }
exec "$NODE" "$STAGE/code/deploy/upgrade-local.mjs" "$@"
