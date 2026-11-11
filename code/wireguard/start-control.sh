#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$ROOT/control-service.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/control-service.env"
  set +a
fi
NODE=${DSH_WIREGUARD_NODE:-$(command -v node || true)}
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "node not found; set DSH_WIREGUARD_NODE in $ROOT/control-service.env" >&2
  exit 1
fi
exec "$NODE" "$ROOT/control-service.js"
