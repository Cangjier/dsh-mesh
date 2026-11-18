#!/usr/bin/env bash
#
# Compatibility entry point only.
#
# The gateway's acceptance page copies this file into its own transient unit
# and runs it. It resolves the stable rollback orchestrator under the layout
# root and hands over; all logic is in rollback-local.mjs.
#
set -euo pipefail

ROOT=""
prev=""
for arg in "$@"; do
  case "$prev" in
    --root) ROOT=$arg ;;
  esac
  case "$arg" in
    --root=*) ROOT=${arg#--root=} ;;
  esac
  prev=$arg
done
[ -n "$ROOT" ] || { echo '[rollback] --root is required' >&2; exit 2; }
NODE="$ROOT/runtime/node/bin/node"
[ -x "$NODE" ] || NODE=$(command -v node || true)
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo '[rollback] no node runtime' >&2; exit 1; }
MJS="$ROOT/rollback-local.mjs"
[ -f "$MJS" ] || { echo "[rollback] $MJS is missing (install/upgrade first)" >&2; exit 1; }
exec "$NODE" "$MJS" --root "$ROOT" "$@"
