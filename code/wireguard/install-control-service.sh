#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# The upgrade runner is started by systemd without HOME in some environments.
# Defer the default until after --dsh-home is parsed, and never expand an
# unset HOME under `set -u`.
DSH_HOME=${DSH_HOME:-}
NODE=${DSH_WIREGUARD_NODE:-$(command -v node || true)}
UNIT=${DSH_WIREGUARD_UNIT_FILE:-/etc/systemd/system/dsh-wireguard-control.service}

while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT=$2; shift 2 ;;
    --dsh-home) DSH_HOME=$2; shift 2 ;;
    --node) NODE=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done
if [ -z "$DSH_HOME" ]; then
  if [ -z "${HOME:-}" ]; then
    HOME=$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6 || true)
  fi
  DSH_HOME=${HOME:-/root}/.dsh
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "node not found; pass --node <path>" >&2
  exit 1
fi
cat > "$ROOT/control-service.env" <<EOF
DSH_HOME=$DSH_HOME
DSH_WIREGUARD_NODE=$NODE
EOF
chmod +x "$ROOT/start-control.sh"
cat > "$UNIT" <<EOF
[Unit]
Description=DSH WireGuard control panel (51821)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
EnvironmentFile=$ROOT/control-service.env
ExecStart=$ROOT/start-control.sh
Restart=always
RestartSec=2
User=root

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now dsh-wireguard-control.service
systemctl --no-pager status dsh-wireguard-control.service
