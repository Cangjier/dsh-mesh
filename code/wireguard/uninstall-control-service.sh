#!/usr/bin/env bash
set -euo pipefail
systemctl disable --now dsh-wireguard-control.service 2>/dev/null || true
rm -f /etc/systemd/system/dsh-wireguard-control.service
systemctl daemon-reload
echo 'Removed dsh-wireguard-control.service'
