#!/usr/bin/env bash
# 部署前自检：只读检查，不安装、不修改任何东西。
# 在目标 Linux 机器上、解压后的目录里执行：./doctor.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAILED=0
WARNED=0

ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$*"; WARNED=$((WARNED + 1)); }
bad()  { printf '  \033[1;31m✗\033[0m %s\n' "$*"; FAILED=$((FAILED + 1)); }
# Named `section`, not `head`: a function named `head` shadows the utility.
section() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }

section "系统"
if [ "$(uname -s)" = "Linux" ]; then ok "Linux（$(uname -r)）"; else bad "不是 Linux：$(uname -s)；这个包只能在 Linux 上跑"; fi
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  ok "架构 $ARCH → 使用 linux-x64" ;;
  aarch64|arm64) ok "架构 $ARCH → 使用 linux-arm64" ;;
  *) bad "不支持的架构：$ARCH（官方 Node 只有 x64 / arm64）" ;;
esac
if command -v systemctl >/dev/null 2>&1; then ok "systemd 可用（可注册为开机自启服务）"; else warn "没有 systemd：只能用 ./start.sh 前台运行或自行配置守护进程"; fi
if [ "$(id -u)" = "0" ]; then ok "以 root 运行（可以直接绑 80 端口）"; else warn "非 root：install.sh 会自动给 systemd 单元加 CAP_NET_BIND_SERVICE；否则请改用 --port 8080"; fi
if command -v ldd >/dev/null 2>&1; then
  LDD_OUT="$(ldd --version 2>&1 | sed -n '1p')"
  if printf '%s' "$LDD_OUT" | grep -qi musl; then
    warn "musl libc（Alpine 之类）：官方 Node 二进制是 glibc 版，请用 --system-node（apk add nodejs npm）安装 Node"
  else
    GLIBC="$(printf '%s' "$LDD_OUT" | grep -oE '[0-9]+\.[0-9]+' | head -1)"
    if [ -n "${GLIBC:-}" ]; then
      if awk -v v="$GLIBC" 'BEGIN { split(v, a, "."); exit !((a[1] > 2) || (a[1] == 2 && a[2] >= 28)) }'; then
        ok "glibc $GLIBC（自带 Node 24 需要 ≥ 2.28）"
      else
        warn "glibc $GLIBC 偏旧：自带 Node 24 需要 ≥ 2.28，请用 --system-node 或改用较新的系统镜像"
      fi
    fi
  fi
fi
MEM_MB="$(awk '/MemTotal/ { printf "%d", $2 / 1024 }' /proc/meminfo 2>/dev/null || echo '')"
if [ -n "${MEM_MB:-}" ]; then
  if [ "$MEM_MB" -lt 3500 ]; then
    ok "内存 ${MEM_MB} MB：网关会自动把 dsh web 堆限到 1024 MB（DSH_WEB_HEAP_MB 可改）"
  else
    ok "内存 ${MEM_MB} MB"
  fi
fi
WATCHES="$(cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null || echo '')"
if [ -n "${WATCHES:-}" ]; then
  if [ "$WATCHES" -lt 131072 ]; then
    warn "inotify 监视数上限只有 $WATCHES：配置热加载会报 ENOSPC（install.sh 会自动调高）"
  else
    ok "inotify 监视数上限 $WATCHES"
  fi
fi
# 云服务器（阿里云/AWS/GCP）的公网 IP 常是 1:1 NAT，不在网卡上；
# 网关只信任本机网卡地址，所以 NAT 公网 IP 必须显式加入。
PUBLIC_IPS="$(ip -4 addr show 2>/dev/null | awk '/inet / { print $2 }' | cut -d/ -f1 | grep -vE '^(10\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)' || true)"
if [ -z "${PUBLIC_IPS:-}" ] && [ -z "${DSH_TRUSTED_HOSTS:-}" ]; then
  warn "本机没有公网 IPv4（云服务器常见）：浏览器用公网 IP/域名访问时，把那个地址写进 config/gate.env 的 DSH_TRUSTED_HOSTS，否则接口会 403"
fi

section "依赖命令"
for cmd in curl tar xz sha256sum; do
  if command -v "$cmd" >/dev/null 2>&1; then ok "$cmd"; else bad "缺少 $cmd"; fi
done
if command -v git >/dev/null 2>&1; then ok "git（智能体的改动卡片会用到）"; else warn "没有 git：功能可用，但「改动的文件」卡片和 git 相关工具不可用"; fi

section "Node.js"
if [ -x "$ROOT/runtime/node/bin/node" ]; then
  ok "已带运行时 $("$ROOT/runtime/node/bin/node" -v)（$ROOT/runtime/node）"
elif command -v node >/dev/null 2>&1; then
  V="$("node" -v 2>/dev/null || echo unknown)"
  MAJOR="${V#v}"; MAJOR="${MAJOR%%.*}"
  if [ "${MAJOR:-0}" -ge 24 ] 2>/dev/null; then
    ok "系统 Node $V（install.sh 加 --system-node 可直接用）"
  else
    warn "系统 Node $V 低于 24.9；install.sh 默认会自行下载 Node，不用管它"
  fi
else
  ok "没有 Node —— install.sh 会自动下载官方 linux 运行时"
fi

section "网络（安装需要）"
if curl -fsS --max-time 8 -o /dev/null "https://nodejs.org/dist/index.json"; then ok "可访问 nodejs.org"; else bad "访问 nodejs.org 失败：无法下载 Node（离线安装见 README）"; fi
if curl -fsS --max-time 8 -o /dev/null "https://registry.npmjs.org/-/ping"; then ok "可访问 npm registry"; else bad "访问 npm registry 失败：无法安装 @deepseek-ai/dsh（离线安装见 README）"; fi

section "端口与磁盘"
PORT=80
BIND="::"
if [ -f "$ROOT/config/gate.env" ]; then
  PORT="$(grep -E '^DSH_GATE_PORT=' "$ROOT/config/gate.env" | tail -1 | cut -d= -f2- || true)"; PORT="${PORT:-80}"
  BIND="$(grep -E '^DSH_GATE_BIND=' "$ROOT/config/gate.env" | tail -1 | cut -d= -f2- || true)"; BIND="${BIND:-::}"
fi
case "$PORT" in ''|*[!0-9]*) bad "config/gate.env 里的 DSH_GATE_PORT 不是数字：$PORT" ;; esac
if command -v ss >/dev/null 2>&1; then
  if ss -lnt 2>/dev/null | awk -v p=":${PORT}" '$4 ~ p"$" { found=1 } END { exit found ? 0 : 1 }'; then
    bad "端口 $PORT 已被占用（ss -lntp | grep :$PORT 看是谁）"
  else
    ok "端口 $PORT 空闲"
  fi
elif command -v netstat >/dev/null 2>&1; then
  if netstat -lnt 2>/dev/null | grep -qE "[:.]${PORT}[[:space:]]"; then bad "端口 $PORT 已被占用"; else ok "端口 $PORT 空闲"; fi
else
  warn "没有 ss/netstat，无法检查端口 $PORT"
fi
FREE_KB="$(df -Pk "$ROOT" 2>/dev/null | awk 'NR==2 { print $4 }')"
if [ -n "${FREE_KB:-}" ]; then
  if [ "$FREE_KB" -ge 3145728 ]; then ok "可用磁盘 $((FREE_KB / 1024 / 1024)) GB"; else warn "可用磁盘只有 $((FREE_KB / 1024)) MB，建议至少 3 GB"; fi
fi

section "安装状态"
if [ -f "$ROOT/app/node_modules/@deepseek-ai/dsh/lib/bin.js" ]; then
  ok "已安装 @deepseek-ai/dsh（$ROOT/app）"
else
  warn "尚未安装 dsh：运行 ./install.sh（会自动下载 Node + 安装依赖，约 3~8 分钟）"
fi
if [ -f "$ROOT/config/gate.env" ]; then
  if grep -q '^DSH_GATE_PASSWORD=ChangeMe-Please-2026' "$ROOT/config/gate.env"; then
    ok "配置已生成（密码为默认值 ChangeMe-Please-2026）"
  else
    ok "配置已生成（密码已自定义）"
  fi
  ok "监听 ${BIND}:${PORT}"
else
  warn "尚未生成 config/gate.env：install.sh 会创建它"
fi
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files dsh-web.service >/dev/null 2>&1; then
  ok "systemd 服务 dsh-web 已注册（状态：$(systemctl is-active dsh-web 2>/dev/null || echo unknown)）"
fi

printf '\n────────────────────────────────────────────\n'
if [ "$FAILED" -gt 0 ]; then
  printf '\033[1;31m自检未通过：%d 个阻塞问题\033[0m，请先处理上面标 ✗ 的项。\n' "$FAILED"
  exit 1
fi
if [ "$WARNED" -gt 0 ]; then
  printf '\033[1;32m可以安装\033[0m（有 %d 条提醒，通常不影响启动）。\n' "$WARNED"
else
  printf '\033[1;32m全部检查通过，直接运行：sudo ./install.sh\033[0m\n'
fi
