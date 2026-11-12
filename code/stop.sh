#!/usr/bin/env bash
# 停止手动启动的 DeepSeek Harness Web（systemd 部署请用 systemctl stop dsh-web）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$ROOT/data/gate.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "没有找到 $PID_FILE，服务可能没有在运行（或使用 systemd：systemctl status dsh-web）"
  exit 0
fi

PID="$(tr -dc '0-9' < "$PID_FILE")"
if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
  echo "进程不存在，清理 pid 文件"
  rm -f "$PID_FILE"
  exit 0
fi

echo "停止网关进程 $PID ..."
kill -TERM "$PID"
for _ in $(seq 1 40); do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "已停止"
    rm -f "$PID_FILE"
    exit 0
  fi
  sleep 0.5
done

echo "进程未在 20 秒内退出，发送 SIGKILL"
kill -KILL "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
