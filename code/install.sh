#!/usr/bin/env bash
#
# DeepSeek Harness Web —— Linux 指针布局安装。
#
# 在解压好的离线包里运行：把当前目录安装成 <root>/releases/<id>，写好启动器
# 和 systemd 单元，翻转指针并启动服务。以后升级只需要换 release + 翻指针。
#
# 用法：
#   sudo ./install.sh                     # 装到 /root/.dsh，监听 80
#   sudo ./install.sh --root /srv/dsh --port 8080 --password 'x'
#   sudo ./install.sh --no-systemd        # 只准备文件，不注册/启动服务
#
set -euo pipefail

PACKAGE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${DSH_MESH_LAYOUT_ROOT:-${HOME:-/root}/.dsh}"
PORT=80
PASSWORD=''
NO_SYSTEMD=0

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[错误]\033[0m %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --no-systemd) NO_SYSTEMD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

[ -f "$PACKAGE/manifest.json" ] || die "$PACKAGE 不是完整安装包（缺少 manifest.json）"

NODE="$PACKAGE/runtime/node/bin/node"
if [ ! -x "$NODE" ]; then
  NODE="$(command -v node || true)"
fi
[ -n "$NODE" ] && [ -x "$NODE" ] || die '找不到 Node 运行时（包内 runtime/node 或 PATH 中都没有）'

case "$PORT" in
  ''|*[!0-9]*) die "端口不合法：$PORT" ;;
esac

# 安装和升级是同一个实现：写好 shared/ 的配置，把包放进 releases/，写单元，
# 翻指针，按 control → gate 顺序重启并做健康检查。
ARGS=(
  --stage "$PACKAGE"
  --layout-root "$ROOT"
  --port "$PORT"
  --gate-port "$PORT"
  --services 'dsh-wireguard-control.service=control,dsh-web-gate.service=gate'
)
[ -n "$PASSWORD" ] && ARGS+=(--gate-password "$PASSWORD")
if [ "$NO_SYSTEMD" = 1 ]; then
  export DSH_MESH_NO_UNITS=1
  ARGS+=(--no-restart)
fi

say "安装到 $ROOT"
"$NODE" "$PACKAGE/code/deploy/upgrade-local.mjs" "${ARGS[@]}"

say "安装完成"
cat <<EOF
  安装根   : $ROOT
  指针     : $ROOT/dsh-mesh.json
  版本     : $(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$ROOT/releases"/*/manifest.json 2>/dev/null | tail -1)
  面板     : http://<本机地址>:$PORT/   （密码在 $ROOT/shared/config/gate.env）
  日志     : systemctl status dsh-web-gate
EOF
