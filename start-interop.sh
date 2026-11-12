#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$ROOT/config/interop.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/config/interop.env"
  set +a
fi
NODE=${DSH_INTEROP_NODE:-"$ROOT/runtime/node/bin/node"}
if [ ! -x "$NODE" ]; then
  echo "missing $NODE" >&2
  exit 1
fi
exec "$NODE" "$ROOT/code/interop-service/server.mjs"
