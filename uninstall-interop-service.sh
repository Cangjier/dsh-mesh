#!/usr/bin/env bash
set -euo pipefail
systemctl disable --now dsh-interop.service 2>/dev/null || true
rm -f /etc/systemd/system/dsh-interop.service
systemctl daemon-reload
echo 'Removed dsh-interop.service'
