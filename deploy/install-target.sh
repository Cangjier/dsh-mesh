#!/usr/bin/env bash
# Deploy the packaged dsh-person-web + dsh-wireguard onto an existing member
# host. The old dsh-web service is stopped without running the old plugin's
# dispose path, so the live WireGuard interface and state survive the switch.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OLD_ROOT=${OLD_ROOT:-/root/.dsh/dsh-web-linux}
DSH_HOME=${DSH_HOME:-$OLD_ROOT/data/home}
OLD_SERVICE=${OLD_SERVICE:-dsh-web}
CLUSTER_KEY=${Dsh_GATE_CLUSTER_KEY:-}
INTEROP_TOKEN=${DSH_INTEROP_TOKEN:-}
INTEROP_BIND=${DSH_INTEROP_BIND:-10.66.66.1}
INTEROP_PORT=${DSH_INTEROP_PORT:-8765}
INTEROP_PROVIDER=${DSH_INTEROP_PROVIDER:-deepseek-account}
INTEROP_MODEL=${DSH_INTEROP_MODEL:-deepseek-flash}
APPROVE=${DSH_INTEROP_APPROVE:-1}
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$DSH_HOME/deploy-backup-$STAMP"
LOG="$ROOT/deploy-$STAMP.log"

while [ $# -gt 0 ]; do
  case "$1" in
    --old-root) OLD_ROOT=$2; shift 2 ;;
    --dsh-home) DSH_HOME=$2; shift 2 ;;
    --old-service) OLD_SERVICE=$2; shift 2 ;;
    --cluster-key) CLUSTER_KEY=$2; shift 2 ;;
    --interop-token) INTEROP_TOKEN=$2; shift 2 ;;
    --interop-bind) INTEROP_BIND=$2; shift 2 ;;
    --interop-port) INTEROP_PORT=$2; shift 2 ;;
    --interop-provider) INTEROP_PROVIDER=$2; shift 2 ;;
    --interop-model) INTEROP_MODEL=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done
if [ -z "$CLUSTER_KEY" ]; then echo 'missing --cluster-key' >&2; exit 1; fi
if [ -z "$INTEROP_TOKEN" ]; then echo 'missing --interop-token' >&2; exit 1; fi
NODE="$ROOT/runtime/node/bin/node"
PROFILE="$DSH_HOME/profiles/web"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*" | tee -a "$LOG"; }
warn() { printf '\033[1;33m[warning]\033[0m %s\n' "$*" | tee -a "$LOG" >&2; }
die() { printf '\033[1;31m[error]\033[0m %s\n' "$*" | tee -a "$LOG" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die 'run as root'
[ -x "$NODE" ] || die "missing $NODE"
[ -d "$DSH_HOME" ] || die "missing DSH_HOME $DSH_HOME"
[ -f "$OLD_ROOT/config/gate.env" ] || die "missing $OLD_ROOT/config/gate.env"

mkdir -p "$ROOT/config" "$ROOT/data" "$ROOT/workspace" "$BACKUP"
cp -a "$OLD_ROOT/config/gate.env" "$ROOT/config/gate.env"
mkdir -p "$ROOT/config/tls"
if [ -f "$OLD_ROOT/config/tls/cert.pem" ] && [ -f "$OLD_ROOT/config/tls/key.pem" ]; then
  cp -a "$OLD_ROOT/config/tls/cert.pem" "$ROOT/config/tls/cert.pem"
  cp -a "$OLD_ROOT/config/tls/key.pem" "$ROOT/config/tls/key.pem"
fi
cp -a "$PROFILE/package.json" "$BACKUP/profile-package.json"
cp -a "$PROFILE/cordis.patch.yml" "$BACKUP/profile-cordis.patch.yml" 2>/dev/null || true
cp -a "$DSH_HOME/wireguard" "$BACKUP/wireguard" 2>/dev/null || true
cp -a "/etc/systemd/system/$OLD_SERVICE.service" "$BACKUP/$OLD_SERVICE.service" 2>/dev/null || true
say "backup at $BACKUP"

# Gate config: preserve password/TLS/trusted hosts, point mutable paths at the
# new package and keep DSH_HOME on the existing profile/state.
"$NODE" - "$ROOT/config/gate.env" "$ROOT" "$DSH_HOME" "$CLUSTER_KEY" <<'NODE'
const fs = require('node:fs')
const [file, root, home, cluster] = process.argv.slice(2)
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
const values = new Map()
for (const line of lines) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
  if (m) values.set(m[1], m[2])
}
values.set('DSH_WORKDIR', `${root}/workspace`)
values.set('DSH_HOME', home)
values.set('DSH_GATE_MEMBER_PORT', '80')
values.set('DSH_GATE_CLUSTER_KEY', cluster)
values.set('DSH_WEB_HEAP_MB', '512')
values.set('DSH_GATE_NO_SPAWN', '1')
values.set('DSH_WEB_TOKEN_FILE', `${root}/data/dsh-web.json`)
if (fs.existsSync(`${root}/config/tls/cert.pem`)) {
  values.set('DSH_GATE_TLS_CERT', `${root}/config/tls/cert.pem`)
  values.set('DSH_GATE_TLS_KEY', `${root}/config/tls/key.pem`)
}
const comments = lines.filter(line => line.startsWith('#') || line.trim() === '')
const output = [
  ...comments,
  ...[...values.entries()].map(([key, value]) => `${key}=${value}`),
]
fs.writeFileSync(file, `${output.join('\n')}\n`, { mode: 0o600 })
NODE
say 'gate.env prepared (password/TLS preserved)'

# Install both plugins into the existing profile. Remove any previous local or
# GitHub source for the same plugin, then link the packaged copies.
"$NODE" - "$PROFILE/package.json" "$ROOT" <<'NODE'
const fs = require('node:fs')
const [file, root] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
pkg.dependencies ||= {}
for (const key of Object.keys(pkg.dependencies)) {
  if (key === '@local/dsh-person-web' || key === '@local/dsh-wireguard') delete pkg.dependencies[key]
  if (/Cangjier\/dsh-(person-web|wireguard)/i.test(String(pkg.dependencies[key]))) delete pkg.dependencies[key]
}
pkg.dependencies['@local/dsh-person-web'] = `link:${root}/plugins/dsh-person-web`
pkg.dependencies['@local/dsh-wireguard'] = `link:${root}/plugins/dsh-wireguard`
pkg.dsh ||= { profile: {} }
pkg.dsh.profile ||= {}
pkg.dsh.profile.bundles ||= []
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(name => name !== '@local/dsh-person-web' && name !== '@local/dsh-wireguard')
pkg.dsh.profile.bundles.push('@local/dsh-person-web', '@local/dsh-wireguard')
fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
NODE
mkdir -p "$PROFILE/node_modules/@local"
rm -rf "$PROFILE/node_modules/@local/dsh-person-web" "$PROFILE/node_modules/@local/dsh-wireguard"
ln -s "$ROOT/plugins/dsh-person-web" "$PROFILE/node_modules/@local/dsh-person-web"
ln -s "$ROOT/plugins/dsh-wireguard" "$PROFILE/node_modules/@local/dsh-wireguard"
say 'profile plugins replaced: dsh-person-web + dsh-wireguard'

# Add deploy-owned patch rows without touching unrelated user patch entries.
"$NODE" - "$PROFILE/cordis.patch.yml" "$INTEROP_TOKEN" <<'NODE'
const fs = require('node:fs')
const [file, token] = process.argv.slice(2)
let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '[]\n'
text = text.replace(/# BEGIN dsh-person-web deploy[\s\S]*?# END dsh-person-web deploy\n?/g, '')
const block = [
  '# BEGIN dsh-person-web deploy',
  '- id: dsh-wireguard',
  '  config:',
  '    externalControlPanel: true',
  '    keepTunnelOnExit: true',
  '- id: dsh-person-web',
  '  config:',
  `    interopToken: '${token.replace(/'/g, "''")}'`,
  '    interopPort: 8765',
  '    interopUseGatePassword: false',
  '- id: ui-settings-general',
  '  config:',
  '    welcomeNoticeVersion: "2026-09-28.1"',
  '# END dsh-person-web deploy',
  '',
].join('\n')
fs.writeFileSync(file, `${text.trimEnd()}\n${block}`)
NODE
say 'profile patch rows installed'

# Stop the old service without invoking the old dsh-wireguard dispose path.
mkdir -p "/etc/systemd/system/$OLD_SERVICE.service.d"
cat > "/etc/systemd/system/$OLD_SERVICE.service.d/deploy-restart.conf" <<'EOF'
[Service]
Restart=no
EOF
systemctl daemon-reload
pkill -9 -f "$OLD_ROOT/gate/server.mjs" 2>/dev/null || true
pkill -9 -f "$OLD_ROOT/app/node_modules/@deepseek-ai/dsh/lib/bin.js" 2>/dev/null || true
for pidfile in "$OLD_ROOT/data/gate.pid" "$OLD_ROOT/data/dsh-web.pid"; do
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile" | tr -dc '0-9')
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
  fi
done
systemctl stop "$OLD_SERVICE" 2>/dev/null || true
systemctl disable "$OLD_SERVICE" 2>/dev/null || true
systemctl reset-failed "$OLD_SERVICE" 2>/dev/null || true
sleep 1
if ss -ltn 2>/dev/null | grep -qE ':(80|443)\b'; then
  warn 'port 80/443 still has a listener; inspect before continuing'
fi
say 'old dsh-web service stopped and disabled'

# Make the WireGuard server survive a reboot. Do not start wg-quick now; the
# existing interface is already live and the new plugin/control service adopts it.
if [ -f "$DSH_HOME/wireguard/server.conf" ] && command -v wg-quick >/dev/null 2>&1; then
  install -m 600 "$DSH_HOME/wireguard/server.conf" /etc/wireguard/dshwg0.conf
  systemctl enable wg-quick@dshwg0 >/dev/null 2>&1 || warn 'could not enable wg-quick@dshwg0'
  for unit in dsh-wireguard-control dsh-web-app; do
    mkdir -p "/etc/systemd/system/$unit.service.d"
    cat > "/etc/systemd/system/$unit.service.d/after-wireguard.conf" <<'EOF'
[Unit]
After=wg-quick@dshwg0.service
Wants=wg-quick@dshwg0.service
EOF
  done
  systemctl daemon-reload
  say 'wg-quick@dshwg0 enabled for boot (not restarted)'
else
  warn 'server.conf or wg-quick missing; WireGuard boot persistence not configured'
fi

# Independent 51821 control service.
bash "$ROOT/plugins/dsh-wireguard/install-control-service.sh" \
  --root "$ROOT/plugins/dsh-wireguard" \
  --dsh-home "$DSH_HOME" \
  --node "$NODE"
for _ in $(seq 1 30); do
  if curl -fsS 'http://127.0.0.1:51821/api/dsh-wireguard/health' >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS 'http://127.0.0.1:51821/api/dsh-wireguard/health' >/dev/null || die 'control service 51821 is not healthy'
say 'WireGuard control service is healthy on 51821'

# Independent DSH app + gateway services.
bash "$ROOT/code/dsh-service/install-split.sh"
say 'DSH app and gateway services installed'

# Independent interop HTTP service (SDK runtime).
args=(--root "$ROOT" --dsh-home "$DSH_HOME" --port "$INTEROP_PORT" --bind "$INTEROP_BIND" --provider "$INTEROP_PROVIDER" --model "$INTEROP_MODEL" --node "$NODE" --token "$INTEROP_TOKEN")
if [ "$APPROVE" = "1" ]; then args+=(--approve); fi
bash "$ROOT/install-interop-service.sh" "${args[@]}"
say 'interop HTTP service installed'
mkdir -p /etc/systemd/system/dsh-interop.service.d
cat > /etc/systemd/system/dsh-interop.service.d/after-wireguard.conf <<'EOF'
[Unit]
After=wg-quick@dshwg0.service
Wants=wg-quick@dshwg0.service
EOF
systemctl daemon-reload
if ! grep -q '^NODE_OPTIONS=' "$ROOT/config/interop.env"; then
  echo 'NODE_OPTIONS=--max-old-space-size=384' >> "$ROOT/config/interop.env"
  systemctl restart dsh-interop.service
  sleep 3
fi
systemctl restart dsh-interop.service
sleep 3

# Final checks.
systemctl --no-pager --full status dsh-web-app.service dsh-web-gate.service dsh-wireguard-control.service dsh-interop.service | sed -n '1,80p' | tee -a "$LOG"
curl -fsS 'http://127.0.0.1:80/__gate/health' | tee -a "$LOG" || true
CHECK_HOST=$INTEROP_BIND
case "$CHECK_HOST" in
  0.0.0.0|::|'[::]') CHECK_HOST=127.0.0.1 ;;
esac
if printf '%s' "$CHECK_HOST" | grep -q ':'; then CHECK_HOST="[$CHECK_HOST]"; fi
curl -fsS "http://$CHECK_HOST:$INTEROP_PORT/healthz" | tee -a "$LOG" || true
wg show dshwg0 | sed -n '1,20p' | tee -a "$LOG" || true
say "deployment complete; log $LOG; backup $BACKUP"
