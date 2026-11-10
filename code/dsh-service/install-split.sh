#!/usr/bin/env bash
# Split the old single dsh-web.service into an independent DSH app service and
# an independent gateway service. Run as root from the installed package.
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
ENV_FILE="$ROOT/config/gate.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "missing $ENV_FILE; install the gateway once first" >&2
  exit 1
fi
NODE="$ROOT/runtime/node/bin/node"
if [ ! -x "$NODE" ]; then
  echo "missing $NODE" >&2
  exit 1
fi
chmod +x "$ROOT/start.sh" "$ROOT/start-dsh.sh" 2>/dev/null || true

# Keep the gateway in external-DSH mode; it watches this file instead of
# spawning a child.
TOKEN_FILE="$ROOT/data/dsh-web.json"
sed -i '/^DSH_GATE_NO_SPAWN=/d' "$ENV_FILE"
sed -i '/^DSH_WEB_TOKEN_FILE=/d' "$ENV_FILE"
{
  echo 'DSH_GATE_NO_SPAWN=1'
  echo "DSH_WEB_TOKEN_FILE=$TOKEN_FILE"
} >> "$ENV_FILE"

cat > /etc/systemd/system/dsh-web-app.service <<EOF
[Unit]
Description=DSH Web App (independent from the gateway)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
EnvironmentFile=$ENV_FILE
ExecStart=$NODE $ROOT/code/dsh-service/supervisor.mjs
Restart=always
RestartSec=2
User=root

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/dsh-web-gate.service <<EOF
[Unit]
Description=DSH Person Web gateway (port 80)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
EnvironmentFile=$ENV_FILE
ExecStart=$ROOT/start.sh
Restart=always
RestartSec=2
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl disable --now dsh-web.service 2>/dev/null || true
systemctl enable dsh-web-app.service dsh-web-gate.service
systemctl restart dsh-web-app.service
for _ in $(seq 1 60); do
  [ -f "$TOKEN_FILE" ] && break
  sleep 2
done
if [ ! -f "$TOKEN_FILE" ]; then
  journalctl -u dsh-web-app.service -n 80 --no-pager || true
  echo 'DSH app service did not write the token file' >&2
  exit 1
fi
systemctl restart dsh-web-gate.service
PORT=$(sed -n 's/^DSH_GATE_PORT=//p' "$ENV_FILE" | tail -n1)
PORT=${PORT:-80}
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/__gate/health" >/dev/null 2>&1; then
    echo 'split complete: dsh-web-app.service and dsh-web-gate.service are independent'
    systemctl --no-pager --full status dsh-web-app.service dsh-web-gate.service | sed -n '1,20p'
    exit 0
  fi
  sleep 2
done
echo 'gateway health check failed' >&2
journalctl -u dsh-web-gate.service -n 80 --no-pager || true
exit 1
