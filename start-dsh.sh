#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE="$ROOT/runtime/node/bin/node"
if [ ! -x "$NODE" ]; then
  echo "missing $NODE" >&2
  exit 1
fi
exec "$NODE" "$ROOT/code/dsh-service/supervisor.mjs"
