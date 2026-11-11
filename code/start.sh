#!/usr/bin/env bash
# 前台启动 DeepSeek Harness Web（网关 + 内部 dsh web）。
# systemd 服务实际执行的就是这个脚本；手动运行时也在前台输出日志。
#
# 配置来自 config/gate.env，但不会覆盖调用方已经设好的同名环境变量
# （systemd 的 EnvironmentFile、docker -e、命令行 export 都优先）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

strip_quotes() {
  local value="$1"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

load_defaults() {
  local file="$1" line key value
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    value="$(strip_quotes "${line#*=}")"
    # 已存在的环境变量优先
    if [ -z "${!key:-}" ]; then
      export "${key}=${value}"
    fi
  done < "$file"
}

load_defaults "$ROOT/config/gate.env"

NODE="$ROOT/runtime/node/bin/node"
if [ ! -x "$NODE" ]; then
  NODE="$(command -v node || true)"
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "找不到 Node.js 运行时，请先运行 ./install.sh（或安装系统 Node >= 24.9）" >&2
  exit 1
fi

mkdir -p "$ROOT/data"
export DSH_PACKAGE_ROOT="$ROOT"
export DSH_APP_DIR="${DSH_APP_DIR:-$ROOT/app}"
export DSH_GATE_DATA_DIR="${DSH_GATE_DATA_DIR:-$ROOT/data}"
exec "$NODE" "$ROOT/gate/server.mjs"
