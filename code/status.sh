#!/usr/bin/env bash
# 查看 DeepSeek Harness Web 的运行状态：加载配置、检查端口、请求健康检查。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=80
BIND="::"
if [ -f "$ROOT/config/gate.env" ]; then
  # 只读取需要的两个键，避免覆盖调用方环境
  PORT="$(grep -E '^DSH_GATE_PORT=' "$ROOT/config/gate.env" | tail -1 | cut -d= -f2- || true)"
  BIND="$(grep -E '^DSH_GATE_BIND=' "$ROOT/config/gate.env" | tail -1 | cut -d= -f2- || true)"
  PORT="${PORT:-80}"
  BIND="${BIND:-::}"
fi

echo "安装目录 : $ROOT"
echo "监听地址 : [${BIND}]:${PORT}"

if [ -f "$ROOT/data/gate.pid" ]; then
  PID="$(tr -dc '0-9' < "$ROOT/data/gate.pid")"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "网关进程 : 运行中 (pid $PID)"
  else
    echo "网关进程 : 已退出（pid 文件残留）"
  fi
else
  echo "网关进程 : 未通过 start.sh 手动运行（systemd 部署请用 systemctl status dsh-web）"
fi

if command -v curl >/dev/null 2>&1; then
  echo -n "健康检查 : "
  BODY="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/__gate/health" 2>/dev/null || true)"
  if [ -n "$BODY" ]; then
    echo "$BODY"
  else
    echo "无响应（服务未启动，或端口不是 ${PORT}）"
  fi
fi

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files dsh-web.service >/dev/null 2>&1; then
  echo -n "systemd  : "
  systemctl is-active dsh-web 2>/dev/null || true
fi
