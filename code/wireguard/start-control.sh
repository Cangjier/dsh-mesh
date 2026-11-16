#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$ROOT/control-service.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/control-service.env"
  set +a
fi
NODE=${DSH_WIREGUARD_NODE:-}
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  # A recorded path can go stale: upgrades used to point DSH_WIREGUARD_NODE
  # into the deploy stage, which the runner deletes once the upgrade is done.
  # Fall back to the runtime shipped with this installation before giving up.
  PACKAGE_ROOT=$(CDPATH= cd -- "$ROOT/../.." && pwd)
  if [ -x "$PACKAGE_ROOT/runtime/node/bin/node" ]; then
    echo "DSH_WIREGUARD_NODE ${NODE:-<unset>} is not executable; using $PACKAGE_ROOT/runtime/node/bin/node" >&2
    NODE="$PACKAGE_ROOT/runtime/node/bin/node"
  fi
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  NODE=$(command -v node || true)
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "node not found; set DSH_WIREGUARD_NODE in $ROOT/control-service.env" >&2
  exit 1
fi
exec "$NODE" "$ROOT/control-service.js"
