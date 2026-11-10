#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DSH_HOME=${DSH_HOME:-$ROOT/home}
PORT=${DSH_INTEROP_PORT:-8765}
BIND=${DSH_INTEROP_BIND:-127.0.0.1}
MODEL=${DSH_INTEROP_MODEL:-deepseek-flash}
PROVIDER=${DSH_INTEROP_PROVIDER:-deepseek-official}
TOKEN=${DSH_INTEROP_TOKEN:-}
APPROVE=${DSH_INTEROP_APPROVE:-0}
USE_GATE=0
NODE=${DSH_INTEROP_NODE:-$ROOT/runtime/node/bin/node}
UNIT=/etc/systemd/system/dsh-interop.service

while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT=$2; shift 2 ;;
    --dsh-home) DSH_HOME=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --bind) BIND=$2; shift 2 ;;
    --model) MODEL=$2; shift 2 ;;
    --provider) PROVIDER=$2; shift 2 ;;
    --token) TOKEN=$2; shift 2 ;;
    --approve) APPROVE=1; shift ;;
    --use-gate-password) USE_GATE=1; shift ;;
    --node) NODE=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done
if [ "$USE_GATE" = "1" ]; then
  TOKEN=$(sed -n 's/^DSH_GATE_PASSWORD=//p' "$ROOT/config/gate.env" | tail -n1)
  if [ -z "$TOKEN" ]; then
    echo 'config/gate.env has no DSH_GATE_PASSWORD' >&2
    exit 1
  fi
fi
if [ -z "$TOKEN" ]; then
  TOKEN=$(head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n')
fi
mkdir -p "$ROOT/config" "$ROOT/data"
cat > "$ROOT/config/interop.env" <<EOF
DSH_HOME=$DSH_HOME
DSH_INTEROP_BIND=$BIND
DSH_INTEROP_PORT=$PORT
DSH_INTEROP_TOKEN=$TOKEN
DSH_INTEROP_PROVIDER=$PROVIDER
DSH_INTEROP_MODEL=$MODEL
DSH_INTEROP_APPROVE=$APPROVE
DSH_INTEROP_USE_GATE_PASSWORD=$USE_GATE
DSH_INTEROP_NODE=$NODE
EOF
chmod 600 "$ROOT/config/interop.env"
printf '%s\n' "$TOKEN" > "$ROOT/data/interop-token"
chmod 600 "$ROOT/data/interop-token"
chmod +x "$ROOT/start-interop.sh"
cat > "$UNIT" <<EOF
[Unit]
Description=DSH interaction HTTP service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
EnvironmentFile=$ROOT/config/interop.env
ExecStart=$ROOT/start-interop.sh
Restart=always
RestartSec=2
User=root

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now dsh-interop.service
CHECK_HOST=$BIND
case "$CHECK_HOST" in
  0.0.0.0|::|'[::]') CHECK_HOST=127.0.0.1 ;;
esac
if printf '%s' "$CHECK_HOST" | grep -q ':'; then
  CHECK_HOST="[$CHECK_HOST]"
fi
for _ in $(seq 1 60); do
  HEALTH=$(curl -fsS "http://$CHECK_HOST:$PORT/healthz" 2>/dev/null || true)
  if printf '%s' "$HEALTH" | grep -q '"sdk":"ready"'; then
    printf '%s\n' "$HEALTH"
    echo "Interop service is running on http://$BIND:$PORT"
    echo "Token: $TOKEN"
    exit 0
  fi
  sleep 2
done
journalctl -u dsh-interop.service -n 80 --no-pager || true
echo 'Interop service did not become healthy' >&2
exit 1
