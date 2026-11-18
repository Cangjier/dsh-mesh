#!/usr/bin/env bash
#
# Roll a dsh-mesh install back to the version that was running before the last
# upgrade. The gateway's acceptance page (`回退`) starts this script in its own
# transient systemd unit, because the script restarts the gateway it is talking
# to; running it inside the gateway's cgroup would let systemd kill it halfway.
#
#   bash code/deploy/rollback-local.sh --root /root/.dsh/dsh-person-web
#
# It reads <root>/data/upgrade-pending.json (flat) or
# <root>/shared/data/upgrade-pending.json (blue-green), restores the previous
# files/release, restarts the services, verifies /__gate/health, and removes the
# marker so the next page load is the normal DSH page again.
#
set -Eeuo pipefail

ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$ROOT" ] || { echo '--root is required' >&2; exit 2; }
ROOT=$(CDPATH= cd -- "$ROOT" && pwd)
[ -d "$ROOT" ] || { echo "not a directory: $ROOT" >&2; exit 2; }

if [ -d "$ROOT/releases" ] && [ -L "$ROOT/current" ]; then
  LAYOUT=bluegreen
  PENDING="$ROOT/shared/data/upgrade-pending.json"
  LOG="$ROOT/shared/data/upgrade-rollback.log"
else
  LAYOUT=flat
  PENDING="$ROOT/data/upgrade-pending.json"
  LOG="$ROOT/data/upgrade-rollback.log"
fi
if [ ! -f "$PENDING" ] && [ -f "$ROOT/data/upgrade-pending.json" ]; then
  PENDING="$ROOT/data/upgrade-pending.json"
  LOG="$ROOT/data/upgrade-rollback.log"
fi
mkdir -p "$(dirname "$LOG")"
# The script is normally started with stdio ignored; keep a durable log for the
# operator next to the marker. `exec` also captures the ERR trap output.
exec >> "$LOG" 2>&1
echo "[rollback $(date -Is)] layout=$LAYOUT root=$ROOT"

say() { printf '==> %s\n' "$*"; }
warn() { printf '[warn] %s\n' "$*" >&2; }
die() { printf '[rollback] %s\n' "$*" >&2; set +e; set_state failed "$*"; exit 1; }

NODE="$ROOT/runtime/node/bin/node"
[ -x "$NODE" ] || NODE="$ROOT/current/runtime/node/bin/node"
[ -x "$NODE" ] || NODE=$(command -v node || true)
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo '[rollback] no node runtime; cannot read the upgrade marker' >&2; exit 1; }

read_field() {
  "$NODE" -e '
    const fs = require("fs");
    const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = state[process.argv[2]];
    process.stdout.write(value === undefined || value === null ? "" : String(value));
  ' "$PENDING" "$1" 2>/dev/null || true
}

set_state() {
  "$NODE" -e '
    const fs = require("fs");
    const file = process.argv[1];
    const status = process.argv[2];
    const error = process.argv[3] || "";
    let state = {};
    try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    state.status = status;
    if (error === "") delete state.error; else state.error = error;
    state.rollbackFinishedAt = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  ' "$PENDING" "$1" "${2:-}" 2>/dev/null || true
}

on_error() {
  code=$?
  echo "[rollback] failed with exit $code"
  set +e
  set_state failed "回退脚本执行失败（exit $code），详见 $LOG"
  exit "$code"
}
trap on_error ERR

[ -f "$PENDING" ] || die "没有找到升级标记：$PENDING"
FROM=$(read_field from)
TO=$(read_field to)
BACKUP=$(read_field backup)
PREVIOUS=$(read_field previous)
DSH_HOME=$(read_field dshHome)
PORT=$(read_field port)
say "回退 $TO -> $FROM"

restore_profile() {
  local profile="$1"
  [ -n "$profile" ] || return 0
  [ -d "$profile" ] || mkdir -p "$profile"
  if [ -f "$BACKUP/profile-package.json" ]; then cp -a "$BACKUP/profile-package.json" "$profile/package.json"; fi
  if [ -f "$BACKUP/profile-cordis.patch.yml" ]; then cp -a "$BACKUP/profile-cordis.patch.yml" "$profile/cordis.patch.yml"; fi
}

health() {
  local gate_ok=0
  for _ in $(seq 1 45); do
    if curl -fsS "http://127.0.0.1:$PORT/__gate/health" >/dev/null 2>&1; then gate_ok=1; break; fi
    sleep 2
  done
  if [ "$gate_ok" != "1" ]; then return 1; fi
  local env_file="$ROOT/config/interop.env"
  if [ "$LAYOUT" = "bluegreen" ]; then env_file="$ROOT/shared/config/interop.env"; fi
  if [ -f "$env_file" ]; then
    local bind port host
    bind=$(sed -n 's/^DSH_INTEROP_BIND=//p' "$env_file" | tail -n1)
    port=$(sed -n 's/^DSH_INTEROP_PORT=//p' "$env_file" | tail -n1)
    if [ -n "$port" ]; then
      host=$bind
      if [ -z "$host" ] || [ "$host" = "0.0.0.0" ]; then host=127.0.0.1; fi
      for _ in $(seq 1 30); do
        if curl -fsS "http://$host:$port/healthz" >/dev/null 2>&1; then return 0; fi
        sleep 2
      done
      return 1
    fi
  fi
  return 0
}

# A release with the embedded listener keeps dsh-interop.service stopped; an
# older release still needs the standalone unit. The release manifest records
# which is which.
settle_interop() {
  local release="$1"
  if { [ -f "$release/manifest.json" ] && grep -q 'embedded-interop' "$release/manifest.json"; } || grep -q 'dsh-mesh-embedded-interop-v1' "$release/plugins/dsh-mesh/index.js" 2>/dev/null; then
    systemctl stop dsh-interop.service >/dev/null 2>&1 || true
    systemctl disable dsh-interop.service >/dev/null 2>&1 || true
  else
    systemctl enable --now dsh-interop.service >/dev/null 2>&1 || true
  fi
}

restart_units() {
  systemctl daemon-reload 2>/dev/null || true
  # Split-service installs have dsh-web-app/dsh-web-gate; a very old install
  # only has dsh-web. Restart each one independently: one missing unit must not
  # skip the others.
  systemctl restart dsh-web-app.service 2>/dev/null || true
  systemctl restart dsh-web-gate.service 2>/dev/null || true
  systemctl restart dsh-web.service 2>/dev/null || true
  systemctl restart dsh-wireguard-control.service 2>/dev/null || true
}

if [ "$LAYOUT" = "flat" ]; then
  case "$BACKUP" in
    "$ROOT"/.upgrade-backup/*) ;;
    *) die "升级标记里的备份路径不在 $ROOT/.upgrade-backup 下：$BACKUP" ;;
  esac
  [ -d "$BACKUP" ] || die "升级备份不存在：$BACKUP"
  [ -f "$BACKUP/manifest.json" ] || die "备份不完整（缺少 manifest.json）：$BACKUP"
  # Backups made before 2026-11-17 only carry config/code/gate/plugins/docs.
  # Restoring those on top of the new runtime is the failure this script now
  # avoids; say so instead of reporting a healthy rollback that still cannot
  # boot the page.
  for layer in app runtime web; do
    [ -e "$BACKUP/$layer" ] || warn "备份缺少 $layer（修复前的旧备份）：只能恢复工具层，运行时仍是新版本，页面可能仍无法加载"
  done
  # The overlay copy replaces every one of these, so rollback has to restore
  # every one of them. `app`, `runtime` and `web` are the ones that matter most:
  # restoring old scripts on top of a new runtime cannot boot. Keep in sync with
  # upgrade-local.sh's BACKUP_ITEMS.
  BACKUP_ITEMS=(
    app runtime web shared code gate plugins locale docs config deploy
    VERSION manifest.json package.json cordis.patch.yml browse-picker.patch.yml
    install.sh install.ps1 install-interop-service.sh uninstall-interop-service.sh
    start.sh start.ps1 start-dsh.sh start-interop.sh start.cmd start-stack.ps1
    stop.sh stop.ps1 stop.cmd status.sh doctor.sh
  )
  say "恢复文件备份 $BACKUP"
  for item in "${BACKUP_ITEMS[@]}"; do
    if [ -e "$BACKUP/$item" ]; then
      rm -rf "${ROOT:?}/$item"
      cp -a "$BACKUP/$item" "$ROOT/" || die "恢复 $item 失败"
    fi
  done
  chmod +x "$ROOT"/*.sh 2>/dev/null || true
  chmod +x "$ROOT/runtime/node/bin/node" 2>/dev/null || true
  if [ -z "$DSH_HOME" ] && [ -f "$ROOT/config/gate.env" ]; then
    DSH_HOME=$(sed -n 's/^DSH_HOME=//p' "$ROOT/config/gate.env" | tail -n1)
  fi
  DSH_HOME=${DSH_HOME:-$ROOT/home}
  restore_profile "$DSH_HOME/profiles/web"
  if [ -f "$ROOT/config/gate.env" ]; then
    PORT=$(sed -n 's/^DSH_GATE_PORT=//p' "$ROOT/config/gate.env" | tail -n1)
  fi
  PORT=${PORT:-80}
  say "重启服务（端口 $PORT）"
  restart_units
  settle_interop "$ROOT"
  if ! health; then
    systemctl --no-pager --full status dsh-web-app.service dsh-web-gate.service 2>/dev/null | head -60 || true
    die "回退后网关健康检查失败：http://127.0.0.1:$PORT/__gate/health"
  fi
else
  case "$PREVIOUS" in
    "$ROOT"/releases/*) ;;
    *) die "升级标记里的上一版本不在 $ROOT/releases 下：$PREVIOUS" ;;
  esac
  [ -d "$PREVIOUS" ] || die "上一版本目录不存在：$PREVIOUS"
  say "切换 current 到 $PREVIOUS"
  ln -sfn "$PREVIOUS" "$ROOT/current"
  if [ -z "$DSH_HOME" ] && [ -f "$ROOT/shared/config/gate.env" ]; then
    DSH_HOME=$(sed -n 's/^DSH_HOME=//p' "$ROOT/shared/config/gate.env" | tail -n1)
  fi
  DSH_HOME=${DSH_HOME:-$ROOT/shared/home}
  restore_profile "$DSH_HOME/profiles/web"
  if [ -f "$ROOT/shared/config/gate.env" ]; then
    PORT=$(sed -n 's/^DSH_GATE_PORT=//p' "$ROOT/shared/config/gate.env" | tail -n1)
  fi
  PORT=${PORT:-80}
  say "重启服务（端口 $PORT）"
  restart_units
  settle_interop "$PREVIOUS"
  if ! health; then
    die "回退后网关健康检查失败：http://127.0.0.1:$PORT/__gate/health"
  fi
fi

set +e
rm -f "$PENDING"
echo "[rollback $(date -Is)] rolled back to $FROM; marker removed"
say "回退完成：$FROM"
exit 0
