#!/usr/bin/env bash
#
# 平铺安装（网关这种 <root>/config/gate.env + start.sh 的布局）的就地升级。
#
# 平铺安装没有 releases/current 可以原子切换，所以升级方式是把新包的文件覆盖到
# 现有安装目录，保留 config/data/home/workspace，然后重写 profile 接线与 systemd
# 单元，让 dsh-web-app / dsh-web-gate / control / interop 重启到新版本。
#
# 调用方是 code/deploy/runner.mjs：它跑在独立的 systemd 临时单元里，所以本脚本
# 重启 dsh-web / gate 不会把升级本身打断。脚本的 stdout/stderr 就是面板里的日志。
#
#   bash code/deploy/upgrade-local.sh --app-root /root/.dsh/dsh-person-web \
#        --dsh-home /root/.dsh/dsh-web-linux/data/home --port 80
#
#   --no-restart   只做备份、覆盖与接线，不动服务（用于验证脚本本身）
#
set -euo pipefail

APP_ROOT=""
JOB_DIR=""
STAGE_OVERRIDE=""
DSH_HOME_OVERRIDE=""
PORT_OVERRIDE=""
INTEROP_TOKEN_OVERRIDE=""
NO_RESTART=0

while [ $# -gt 0 ]; do
  case "$1" in
    --app-root) APP_ROOT=$2; shift 2 ;;
    --job-dir) JOB_DIR=$2; shift 2 ;;
    --stage) STAGE_OVERRIDE=$2; shift 2 ;;
    --dsh-home) DSH_HOME_OVERRIDE=$2; shift 2 ;;
    --port) PORT_OVERRIDE=$2; shift 2 ;;
    --interop-token) INTEROP_TOKEN_OVERRIDE=$2; shift 2 ;;
    --no-restart) NO_RESTART=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

say() { printf '==> %s\n' "$*"; }
warn() { printf '[warn] %s\n' "$*" >&2; }
die() { printf '[error] %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die '升级需要 root（要重写 systemd 单元）'
[ -n "$APP_ROOT" ] || die '--app-root is required'
APP_ROOT=$(CDPATH= cd -- "$APP_ROOT" && pwd) || die "无效的 --app-root：$APP_ROOT"
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# 默认把脚本所在目录的上一级当作部署包（脚本位于 <包>/code/deploy/）。
# --stage 用于从插件目录里的脚本升级：脚本与 runner 同版本，包内容另行指定。
if [ -n "$STAGE_OVERRIDE" ]; then
  STAGE=$(CDPATH= cd -- "$STAGE_OVERRIDE" && pwd) || die "无效的 --stage：$STAGE_OVERRIDE"
else
  STAGE=$(CDPATH= cd -- "$SELF_DIR/../.." && pwd)
fi
ENV_FILE="$APP_ROOT/config/gate.env"
[ -f "$ENV_FILE" ] || die "不是已安装的平铺目录：缺少 $ENV_FILE"
[ -d "$APP_ROOT/plugins/dsh-mesh" ] || die "缺少 $APP_ROOT/plugins/dsh-mesh"
[ -f "$STAGE/manifest.json" ] || die "部署包不完整：缺少 $STAGE/manifest.json"
[ -f "$STAGE/start.sh" ] || die "部署包不完整：缺少 $STAGE/start.sh"
[ -d "$STAGE/plugins/dsh-mesh" ] || die "部署包不完整：缺少 $STAGE/plugins/dsh-mesh"

# The gateway shows the acceptance page from this marker. Clear a stale one
# first: an aborted run must not leave the next page redirecting forever.
PENDING_MARKER="$APP_ROOT/data/upgrade-pending.json"
rm -f "$PENDING_MARKER" 2>/dev/null || true

# 空间预检：要同时放得下新包、旧文件的备份，以及解压/复制过程中的临时占用。
# 磁盘写满发生在复制中途是最坏的情况——备份也可能写不进去，只能人工救。
avail_kb=$(df -Pk "$APP_ROOT" | awk 'NR==2{print $4}')
stage_kb=$(du -sk "$STAGE" 2>/dev/null | cut -f1)
stage_kb=${stage_kb:-0}
need_kb=$((stage_kb * 2 + 204800))
if [ "$avail_kb" -lt "$need_kb" ]; then
  die "磁盘空间不足：$APP_ROOT 需要约 $((need_kb / 1024)) MiB 可用（新包 $((stage_kb / 1024)) MiB ×2 + 余量），当前只有 $((avail_kb / 1024)) MiB；未做任何修改"
fi
say "空间预检通过（可用 $((avail_kb / 1024)) MiB，需要 $((need_kb / 1024)) MiB）"

# Prefer the installed runtime. The copy above has already refreshed
# $APP_ROOT/runtime from the package, while the deploy runner deletes the stage
# directory as soon as this script returns; recording a node path inside the
# stage leaves the control service unable to start after the next reboot.
NODE="$APP_ROOT/runtime/node/bin/node"
[ -x "$NODE" ] || NODE="$STAGE/runtime/node/bin/node"
[ -x "$NODE" ] || NODE=$(command -v node || true)
[ -n "$NODE" ] && [ -x "$NODE" ] || die '找不到可执行的 node'

env_get() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n1; }
INTEROP_ENV="$APP_ROOT/config/interop.env"
interop_get() {
  if [ -f "$INTEROP_ENV" ]; then sed -n "s/^$1=//p" "$INTEROP_ENV" | tail -n1; fi
}

OLD_HOME=$(env_get DSH_HOME)
OLD_WORKDIR=$(env_get DSH_WORKDIR)
GATE_PASSWORD=$(env_get DSH_GATE_PASSWORD)
DSH_HOME=${DSH_HOME_OVERRIDE:-${OLD_HOME:-$APP_ROOT/home}}
WORKDIR=${OLD_WORKDIR:-$APP_ROOT/workspace}
PORT=${PORT_OVERRIDE:-$(env_get DSH_GATE_PORT)}
PORT=${PORT:-80}
PROFILE="$DSH_HOME/profiles/web"

I_BIND=$(interop_get DSH_INTEROP_BIND); I_BIND=${I_BIND:-127.0.0.1}
I_PORT=$(interop_get DSH_INTEROP_PORT); I_PORT=${I_PORT:-8765}
I_PROVIDER=$(interop_get DSH_INTEROP_PROVIDER); I_PROVIDER=${I_PROVIDER:-deepseek-account}
I_MODEL=$(interop_get DSH_INTEROP_MODEL); I_MODEL=${I_MODEL:-deepseek-flash}
I_APPROVE=$(interop_get DSH_INTEROP_APPROVE); I_APPROVE=${I_APPROVE:-1}
I_USE_GATE=$(interop_get DSH_INTEROP_USE_GATE_PASSWORD); I_USE_GATE=${I_USE_GATE:-0}
I_TOKEN=${INTEROP_TOKEN_OVERRIDE:-$(interop_get DSH_INTEROP_TOKEN)}
I_TOKEN=${I_TOKEN:-$GATE_PASSWORD}

say "升级 $APP_ROOT（DSH_HOME=$DSH_HOME，端口 $PORT）"
say "新包 $STAGE"

# ── 1. 备份 ────────────────────────────────────────────────────────────────
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$APP_ROOT/.upgrade-backup/$STAMP"
mkdir -p "$BACKUP"
for item in config manifest.json install.sh start.sh start-dsh.sh start-interop.sh code gate plugins locale docs package.json deploy cordis.patch.yml; do
  if [ -e "$APP_ROOT/$item" ]; then
    cp -a "$APP_ROOT/$item" "$BACKUP/" 2>/dev/null || warn "备份 $item 失败（继续）"
  fi
done
cp -a "$PROFILE/package.json" "$BACKUP/profile-package.json" 2>/dev/null || true
cp -a "$PROFILE/cordis.patch.yml" "$BACKUP/profile-cordis.patch.yml" 2>/dev/null || true
say "备份到 $BACKUP"

RESTORED=0
FINISHED=0
restore() {
  if [ "$RESTORED" = "1" ]; then return 0; fi
  RESTORED=1
  rm -f "$PENDING_MARKER" 2>/dev/null || true
  warn "开始回滚到升级前的文件（备份 $BACKUP）"
  for item in config code gate plugins locale docs package.json manifest.json start.sh start-dsh.sh start-interop.sh install.sh deploy; do
    if [ -e "$BACKUP/$item" ]; then
      rm -rf "${APP_ROOT:?}/$item"
      cp -a "$BACKUP/$item" "$APP_ROOT/" 2>/dev/null || warn "恢复 $item 失败"
    fi
  done
  if [ -f "$BACKUP/profile-package.json" ]; then
    cp -a "$BACKUP/profile-package.json" "$PROFILE/package.json" 2>/dev/null || true
  fi
  if [ -f "$BACKUP/profile-cordis.patch.yml" ]; then
    cp -a "$BACKUP/profile-cordis.patch.yml" "$PROFILE/cordis.patch.yml" 2>/dev/null || true
  fi
  if [ "$NO_RESTART" = "1" ]; then
    warn '--no-restart：只恢复文件，不重启服务'
    return 0
  fi
  systemctl daemon-reload 2>/dev/null || true
  systemctl restart dsh-web-app.service dsh-web-gate.service dsh-wireguard-control.service 2>/dev/null || true
  systemctl restart dsh-interop.service 2>/dev/null || true
  # 回滚后必须自己验一次：只“重启过”不等于“能访问”。
  ok=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/__gate/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  if [ "$ok" = "1" ]; then
    warn '回滚完成：网关健康，安装已回到升级前的文件'
  else
    warn '回滚完成但仍不健康：文件已恢复，手动执行 systemctl restart dsh-web-app dsh-web-gate 并用 journalctl 看原因'
  fi
}

# 意外中断（脚本报错、进程被 SIGTERM、systemctl stop 掉升级任务）也要回到升级前，
# 否则会留下“文件是新的一半、服务是旧的一半”的目录，比不升级更糟。
on_exit() {
  code=$?
  if [ "$FINISHED" != "1" ] && [ "$RESTORED" != "1" ]; then
    warn "升级中断（exit $code），用备份恢复"
    restore
  fi
}
trap on_exit EXIT
trap 'exit 143' TERM INT

# ── 2. 覆盖文件 ────────────────────────────────────────────────────────────
say '复制新版本文件（保留 config/data/home/workspace）'
if ! ( cd "$STAGE" && tar -cf - \
    --exclude=./config --exclude=./data --exclude=./home --exclude=./workspace \
    --exclude=./deploy --exclude=./logs --exclude=./.upgrade-backup \
    --exclude='./*.log' . ) | tar -xf - -C "$APP_ROOT"; then
  restore
  die '复制新版本文件失败'
fi
chmod +x "$APP_ROOT"/*.sh 2>/dev/null || true
chmod +x "$APP_ROOT/code/wireguard/"*.sh "$APP_ROOT/code/dsh-service/"*.sh 2>/dev/null || true

# ── 3. 接线：gate.env 与 profile ───────────────────────────────────────────
say '重写 gate.env 与 profile 接线'
WIRE_PROFILE="$SELF_DIR/wire-profile.mjs"
[ -f "$WIRE_PROFILE" ] || WIRE_PROFILE="$STAGE/code/deploy/wire-profile.mjs"
[ -f "$WIRE_PROFILE" ] || WIRE_PROFILE="$APP_ROOT/code/deploy/wire-profile.mjs"
[ -f "$WIRE_PROFILE" ] || { restore; die '找不到 wire-profile.mjs（脚本目录/新包/安装目录都没有）'; }
say "profile 接线脚本 $WIRE_PROFILE"
"$NODE" "$WIRE_PROFILE" \
  --root "$APP_ROOT" \
  --profile "$PROFILE" \
  --env "$ENV_FILE" \
  --dsh-home "$DSH_HOME" \
  --workdir "$WORKDIR" \
  --port "$PORT" \
  --token "$I_TOKEN" || { restore; die 'profile 接线失败'; }

if [ "$NO_RESTART" = "1" ]; then
  say '--no-restart：跳过服务重装与重启'
  FINISHED=1
  exit 0
fi

# ── 3.5 写待验收标记（新网关会先显示回退页） ──────────────────────────────
write_pending_marker() {
  if [ "$NO_RESTART" = "1" ]; then return 0; fi
  # A package built before the acceptance page must not leave a marker the old
  # gateway cannot understand.
  if ! grep -q '__gate/fallback' "$APP_ROOT/gate/server.mjs" 2>/dev/null; then
    rm -f "$PENDING_MARKER" 2>/dev/null || true
    return 0
  fi
  local from_version to_version
  from_version=$("$NODE" -e 'try{process.stdout.write(String(require(process.argv[1]).version||""))}catch(e){}' "$BACKUP/manifest.json" 2>/dev/null || true)
  to_version=$("$NODE" -e 'try{process.stdout.write(String(require(process.argv[1]).version||""))}catch(e){}' "$APP_ROOT/manifest.json" 2>/dev/null || true)
  mkdir -p "$APP_ROOT/data"
  if "$NODE" - "$PENDING_MARKER" "$APP_ROOT" "$BACKUP" "${from_version:-unknown}" "${to_version:-unknown}" "$PORT" "$DSH_HOME" <<'DSH_MESH_PENDING'
const fs = require('fs')
const [file, root, backup, from, to, port, dshHome] = process.argv.slice(2)
const state = {
  format: 1,
  status: 'pending',
  layout: 'flat',
  root,
  backup,
  from,
  to,
  port: Number(port) || 80,
  dshHome,
  upgradedAt: new Date().toISOString(),
}
fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
DSH_MESH_PENDING
  then
    say "待验收标记已写入（$PENDING_MARKER）：打开网页会先进入回退/验收页"
  else
    warn '写待验收标记失败；升级本身已完成，但不会显示回退页'
    rm -f "$PENDING_MARKER" 2>/dev/null || true
  fi
}
write_pending_marker

# ── 4. 重装 systemd 单元并重启 ─────────────────────────────────────────────
say '重装 DSH app + gateway 服务（会重启 dsh-web-app / dsh-web-gate）'
[ -f "$APP_ROOT/code/dsh-service/install-split.sh" ] || { restore; die '安装目录缺少 code/dsh-service/install-split.sh：包不完整，未重启任何服务'; }
if ! bash "$APP_ROOT/code/dsh-service/install-split.sh"; then
  restore
  die 'install-split.sh 失败'
fi

say '重装 WireGuard 控制服务（51821）'
if ! bash "$APP_ROOT/code/wireguard/install-control-service.sh" \
    --root "$APP_ROOT/code/wireguard" \
    --dsh-home "$DSH_HOME" \
    --node "$NODE"; then
  restore
  die 'install-control-service.sh 失败'
fi
systemctl restart dsh-wireguard-control.service || warn 'control service 未能重启'

say '重装 interop 服务'
INTEROP_ARGS=(--root "$APP_ROOT" --dsh-home "$DSH_HOME" --port "$I_PORT" --bind "$I_BIND"
  --provider "$I_PROVIDER" --model "$I_MODEL" --node "$NODE")
if [ "$I_APPROVE" = "1" ]; then INTEROP_ARGS+=(--approve); fi
if [ "$I_USE_GATE" = "1" ]; then INTEROP_ARGS+=(--use-gate-password); else INTEROP_ARGS+=(--token "$I_TOKEN"); fi
if ! bash "$APP_ROOT/install-interop-service.sh" "${INTEROP_ARGS[@]}"; then
  restore
  die 'install-interop-service.sh 失败'
fi

# ── 5. 健康检查 ────────────────────────────────────────────────────────────
say '健康检查'
gate_ok=0
for _ in $(seq 1 45); do
  if curl -fsS "http://127.0.0.1:$PORT/__gate/health" >/dev/null 2>&1; then gate_ok=1; break; fi
  sleep 2
done
if [ "$gate_ok" != "1" ]; then
  journalctl -u dsh-web-gate.service -n 60 --no-pager 2>/dev/null || true
  restore
  die "网关健康检查失败（http://127.0.0.1:$PORT/__gate/health）"
fi
control_ok=0
for _ in $(seq 1 30); do
  if curl -fsS 'http://127.0.0.1:51821/api/dsh-wireguard/health' >/dev/null 2>&1; then control_ok=1; break; fi
  sleep 2
done
if [ "$control_ok" != "1" ]; then
  journalctl -u dsh-wireguard-control.service -n 40 --no-pager 2>/dev/null || true
  restore
  die '控制服务（51821）健康检查失败'
fi
say '网关与控制服务都健康'
FINISHED=1

# ── 6. 只保留最近 3 份升级备份 ─────────────────────────────────────────────
mapfile -t BACKUPS < <(ls -1dt "$APP_ROOT/.upgrade-backup"/* 2>/dev/null || true)
for ((i=3; i<${#BACKUPS[@]}; i++)); do
  rm -rf "${BACKUPS[$i]}" || true
done

say "升级完成：$APP_ROOT（备份 $BACKUP）"
