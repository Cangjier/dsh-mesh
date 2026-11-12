#!/usr/bin/env bash
#
# DeepSeek Harness Web —— Linux 一键安装脚本
#
# 做三件事：
#   1. 准备 Node.js 运行时（默认下载官方 linux 二进制，可选使用系统 node）
#   2. 在本目录的 app/ 下安装 @deepseek-ai/dsh（即 `dsh web` 的全部服务端与前端产物）
#   3. 写入 config/gate.env 与 systemd 服务，打开 80 端口的密码登录网关
#
# 用法：sudo ./install.sh                （装到当前目录，并注册 systemd 服务）
#       ./install.sh --no-systemd        （只准备文件，不注册服务）
#       ./install.sh --system-node       （不下载 Node，使用 PATH 中的 node/npm）
#       ./install.sh --skip-install      （app/ 已由离线包准备好，跳过 npm 安装）
#       ./install.sh --port 8080 --password 'x' --user dsh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_PASSWORD='ChangeMe-Please-2026'
NODE_VERSION="${NODE_VERSION:-v24.22.2}"
DSH_VERSION="${DSH_VERSION:-0.2.2-rc.1}"
DSH_NPM_SPEC="${DSH_NPM_SPEC:-@deepseek-ai/dsh@${DSH_VERSION}}"

USE_SYSTEM_NODE=0
SKIP_INSTALL=0
INSTALL_SYSTEMD=1
PORT=""
PASSWORD=""
RUN_USER=""
PUBLIC_IP=""
TLS_CERT=""
TLS_KEY=""
WITH_CHROME=0

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[警告]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[错误]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --system-node) USE_SYSTEM_NODE=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --no-systemd) INSTALL_SYSTEMD=0 ;;
    --port) PORT="${2:?--port 需要一个端口}"; shift ;;
    --password) PASSWORD="${2:?--password 需要一个密码}"; shift ;;
    --public-ip) PUBLIC_IP="${2:?--public-ip 需要一个地址}"; shift ;;
    --tls-cert) TLS_CERT="${2:?--tls-cert 需要证书文件}"; shift ;;
    --tls-key) TLS_KEY="${2:?--tls-key 需要私钥文件}"; shift ;;
    --with-chrome) WITH_CHROME=1 ;;
    --user) RUN_USER="${2:?--user 需要一个用户名}"; shift ;;
    --node-version) NODE_VERSION="${2:?--node-version 需要一个版本}"; shift ;;
    -y|--yes) : ;;
    -h|--help) usage ;;
    *) die "未知参数：$1（--help 查看用法）" ;;
  esac
  shift
done

[ "$(uname -s)" = "Linux" ] || die "这个安装脚本只适用于 Linux；Windows/macOS 请直接使用官方安装包。"

if [ -z "$PORT" ]; then PORT=80; fi
if [ -z "$PASSWORD" ]; then PASSWORD="$DEFAULT_PASSWORD"; fi
if [ -z "$RUN_USER" ]; then RUN_USER="$(id -un)"; fi

case "$PORT" in
  ''|*[!0-9]*) die "--port 需要一个数字，收到：$PORT" ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  die "--port 必须在 1-65535 之间，收到：$PORT"
fi
if [ "$(printf '%s' "$PASSWORD" | wc -l)" != "0" ]; then
  die "密码不能包含换行符"
fi
if [ "${#PASSWORD}" -lt 8 ]; then
  die "密码至少 8 位"
fi

case "$(uname -m)" in
  x86_64|amd64) NODE_ARCH="linux-x64" ;;
  aarch64|arm64) NODE_ARCH="linux-arm64" ;;
  *) die "不支持的 CPU 架构：$(uname -m)（官方 Node 只提供 x64 / arm64）" ;;
esac

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1，请先安装（例如 apt install $2）"; }

# 离线整包自带 Node 运行时与 app/，标记文件让安装跳过所有联网步骤。
if [ -f "$ROOT/.offline-payload" ] && [ "$SKIP_INSTALL" != "1" ]; then
  SKIP_INSTALL=1
  say "检测到离线整包（.offline-payload）：跳过 Node 下载与 npm 安装"
fi

# ── 1. Node.js 运行时 ────────────────────────────────────────────────────────
NODE_BIN=""
NPM_CLI=""
if [ "$USE_SYSTEM_NODE" = "1" ]; then
  need_cmd node nodejs
  need_cmd npm npm
  NODE_BIN="$(command -v node)"
  NPM_CLI="$(command -v npm)"
  say "使用系统 Node：$("$NODE_BIN" -v)（$(command -v npm)）"
else
  if [ -x "$ROOT/runtime/node/bin/node" ]; then
    NODE_BIN="$ROOT/runtime/node/bin/node"
    NPM_CLI="$ROOT/runtime/node/lib/node_modules/npm/bin/npm-cli.js"
    say "复用已下载的 Node 运行时：$("$NODE_BIN" -v)"
  else
    need_cmd curl curl
    need_cmd tar tar
    need_cmd xz xz-utils
    say "下载 Node.js ${NODE_VERSION}（${NODE_ARCH}）"
    mkdir -p "$ROOT/runtime"
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    BASE="https://nodejs.org/dist/${NODE_VERSION}"
    ARCHIVE="node-${NODE_VERSION}-${NODE_ARCH}.tar.xz"
    curl -fsSL --retry 3 -o "$TMP/$ARCHIVE" "${BASE}/${ARCHIVE}" \
      || die "下载 Node 失败，请检查网络；或改用 --system-node 使用已安装的 Node。"
    if curl -fsSL --retry 3 -o "$TMP/SHASUMS256.txt" "${BASE}/SHASUMS256.txt"; then
      # The checksum line names the archive, so keep the canonical file name.
      ( cd "$TMP" && grep " ${ARCHIVE}\$" SHASUMS256.txt | sha256sum -c - ) \
        || die "Node 安装包校验失败（下载被篡改或网络异常）。"
    else
      warn "无法获取 SHASUMS256.txt，跳过校验。"
    fi
    mkdir -p "$ROOT/runtime/node"
    tar -xJf "$TMP/$ARCHIVE" -C "$ROOT/runtime/node" --strip-components=1
    NODE_BIN="$ROOT/runtime/node/bin/node"
    NPM_CLI="$ROOT/runtime/node/lib/node_modules/npm/bin/npm-cli.js"
    [ -x "$NODE_BIN" ] || die "Node 运行时就绪失败：$NODE_BIN 不存在。"
  fi
fi

"$NODE_BIN" -e '
  const [major, minor] = process.versions.node.split(".").map(Number)
  if (major > 24 || (major === 24 && minor >= 9)) process.exit(0)
  console.error(`DeepSeek Harness 需要 Node.js >= 24.9，当前为 ${process.versions.node}`)
  process.exit(1)
' || die "Node.js 版本过低。"

# ── 2. 安装 @deepseek-ai/dsh ────────────────────────────────────────────────
# 系统 npm 是 shell 包装脚本，自带运行时里是 npm-cli.js：两种都要能跑。
npm_run() {
  if [ "${NPM_CLI##*.}" = "js" ]; then
    "$NODE_BIN" "$NPM_CLI" "$@"
  else
    "$NPM_CLI" "$@"
  fi
}

if [ "$SKIP_INSTALL" = "1" ]; then
  say "跳过 npm 安装（--skip-install）"
else
  say "安装 ${DSH_NPM_SPEC} 到 $ROOT/app（首次约需 3~8 分钟）"
  mkdir -p "$ROOT/app"
  if [ ! -f "$ROOT/app/package.json" ]; then
    cat > "$ROOT/app/package.json" <<'JSON'
{
  "name": "dsh-web-app",
  "private": true,
  "version": "1.0.0",
  "description": "Installed DeepSeek Harness runtime for the packaged Web deployment."
}
JSON
  fi
  # npm 11.19 起默认不执行依赖的安装脚本；node-pty 等原生模块需要它们。
  NPM_FLAGS="--omit=dev --no-audit --no-fund --loglevel=error"
  if npm_run install --help 2>/dev/null | grep -q -- '--dangerously-allow-all-scripts'; then
    NPM_FLAGS="$NPM_FLAGS --dangerously-allow-all-scripts"
  fi
  ( cd "$ROOT/app" && npm_run install "$DSH_NPM_SPEC" $NPM_FLAGS ) \
    || die "npm 安装失败。请检查网络/代理，或使用离线包（见 README 的“离线安装”）。"
fi

DSH_ENTRY="$ROOT/app/node_modules/@deepseek-ai/dsh/lib/bin.js"
[ -f "$DSH_ENTRY" ] || die "安装不完整：$DSH_ENTRY 不存在。"

# ── 3. 配置 ─────────────────────────────────────────────────────────────────
mkdir -p "$ROOT/config" "$ROOT/data" "$ROOT/workspace"
# 修改已有 gate.env 里的单个变量（密码里常有 @ & | 等字符，不能用 sed 拼接）
set_env_var() {
  local file="$1" key="$2" value="$3"
  if grep -q "^${key}=" "$file"; then
    awk -v k="$key" -v v="$value" 'BEGIN { FS = OFS = "=" } $1 == k { print k "=" v; next } { print }' \
      "$file" > "$file.tmp"
    mv "$file.tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

if [ ! -f "$ROOT/config/gate.env" ]; then
  say "生成 config/gate.env"
  cat > "$ROOT/config/gate.env" <<EOF
# DeepSeek Harness Web 网关配置（由 install.sh 生成，可直接编辑后重启服务）
# 监听端口。默认 80；小于 1024 的端口需要 root 或 CAP_NET_BIND_SERVICE。
DSH_GATE_PORT=${PORT}
# 监听地址：:: 同时接受 IPv4/IPv6；只想绑 IPv4 时改成 0.0.0.0。
DSH_GATE_BIND=::
# 访问密码：首次访问任意页面都会要求输入。改完重启服务生效。
DSH_GATE_PASSWORD=${PASSWORD}
# 登录有效期（天）。
DSH_GATE_COOKIE_DAYS=30
# 工作目录：新会话的默认工作区，也是 Web 里“选择文件夹”的起点。
DSH_WORKDIR=${ROOT}/workspace
# 额外的可信主机名（浏览器用域名访问时填写，逗号分隔）。本机所有 IP 已自动加入。
# 作为成员被其他网关切换时，把外层入口的域名/IP 也写进来，否则成员 DSH 的 Host 栅栏会 403。
#DSH_TRUSTED_HOSTS=dsh.example.com,harness.internal
# 成员组网：所有成员填同一个 32+ 字节随机串。留空则只做本机网关，不参与成员切换。
#DSH_GATE_CLUSTER_KEY=change-me-to-a-long-random-string
# 如果 peer 通过不同端口访问本 gate，填这个端口（默认等于 DSH_GATE_PORT）。
#DSH_GATE_MEMBER_PORT=80
# 允许调用 /__gate/cluster 的额外来源地址（默认只允许回环与 RFC1918/VPN 网段）。
#DSH_GATE_CLUSTER_ALLOW=203.0.113.10
# 内部 dsh web 监听端口；固定端口让浏览器会话 cookie 在重启后仍然有效（0 = 随机，重启会使已打开页面掉线）。
DSH_WEB_PORT=31280
# dsh web 的堆上限（MB）。留空 = 自动：内存小于 3.5 GB 的机器限到 1024，避免 OOM 拖死整机；0 = 不限制。
#DSH_WEB_HEAP_MB=1024
EOF
  chmod 600 "$ROOT/config/gate.env"
else
  say "保留已有配置 config/gate.env"
  if [ -n "$PORT" ] && [ "$PORT" != "80" ]; then
    set_env_var "$ROOT/config/gate.env" DSH_GATE_PORT "$PORT"
  fi
  if [ -n "$PASSWORD" ] && [ "$PASSWORD" != "$DEFAULT_PASSWORD" ]; then
    set_env_var "$ROOT/config/gate.env" DSH_GATE_PASSWORD "$PASSWORD"
  fi
fi

# 云服务器的公网 IP 通常是 NAT 映射，不在网卡上，必须显式写进信任列表，
# 否则浏览器能打开页面但每个接口都 403。
if [ -n "$PUBLIC_IP" ]; then
  EXISTING="$(grep -E '^DSH_TRUSTED_HOSTS=' "$ROOT/config/gate.env" | tail -1 | cut -d= -f2- || true)"
  case ",${EXISTING}," in
    *",${PUBLIC_IP},"*) : ;;
    *) set_env_var "$ROOT/config/gate.env" DSH_TRUSTED_HOSTS "${EXISTING:+$EXISTING,}${PUBLIC_IP}" ;;
  esac
  say "可信地址追加公网 IP：$PUBLIC_IP"
fi

# 可选：让网关自己终止 TLS（例如 Cloudflare Origin CA 证书 + Full (strict) 回源）。
# 两份文件会复制进 config/tls/，随部署目录一起备份。
if [ -n "$TLS_CERT" ] || [ -n "$TLS_KEY" ]; then
  if [ -z "$TLS_CERT" ] || [ -z "$TLS_KEY" ]; then
    die "--tls-cert 与 --tls-key 必须同时给出"
  fi
  [ -f "$TLS_CERT" ] || die "证书文件不存在：$TLS_CERT"
  [ -f "$TLS_KEY" ] || die "私钥文件不存在：$TLS_KEY"
  mkdir -p "$ROOT/config/tls"
  cp "$TLS_CERT" "$ROOT/config/tls/cert.pem"
  cp "$TLS_KEY" "$ROOT/config/tls/key.pem"
  chmod 600 "$ROOT/config/tls/key.pem"
  set_env_var "$ROOT/config/gate.env" DSH_GATE_TLS_CERT "$ROOT/config/tls/cert.pem"
  set_env_var "$ROOT/config/gate.env" DSH_GATE_TLS_KEY "$ROOT/config/tls/key.pem"
  say "已启用 HTTPS 监听（443）：$(basename "$TLS_CERT")"
fi
chmod +x "$ROOT/start.sh" "$ROOT/stop.sh" "$ROOT/status.sh" "$ROOT/doctor.sh" 2>/dev/null || true

# ── inotify 上限 ────────────────────────────────────────────────────────────
# 配置热加载（chokidar）和 systemd 自己的 cgroup 监视都吃 inotify；镜像默认值
# 常常只有一万出头，启动时会报 ENOSPC 并丢一个插件。只升不降。
if [ -d /etc/sysctl.d ]; then
  CURRENT_WATCHES="$(cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null || echo 0)"
  if [ "${CURRENT_WATCHES:-0}" -lt 131072 ] 2>/dev/null; then
    cat > /etc/sysctl.d/99-dsh-web.conf <<'SYSCTL'
# DeepSeek Harness Web：配置热加载与 systemd 的 cgroup 监视需要更多 inotify
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 1024
SYSCTL
    sysctl --system >/dev/null 2>&1 || true
    say "inotify 上限已提升到 524288（原 ${CURRENT_WATCHES}）"
  fi
fi

# ── 网络调优：BBR + fq ──────────────────────────────────────────────────────
# 成员常常跨洲（比如 150ms RTT、3~5% 丢包），cubic 在这种链路上会崩到几百 Kbps，
# 实测同一链路 BBR 能到 10 Mbps 以上。只写自己的调优文件，不动别人的 sysctl.d。
if [ -d /etc/sysctl.d ] && [ "$(id -u)" = "0" ]; then
  modprobe tcp_bbr >/dev/null 2>&1 || true
  modprobe sch_fq >/dev/null 2>&1 || true
  if grep -qw bbr /proc/sys/net/ipv4/tcp_available_congestion_control 2>/dev/null; then
    cat > /etc/sysctl.d/99-dsh-mesh-net.conf <<'SYSCTL'
# dsh-mesh：跨地域成员之间的高延迟/丢包链路使用 BBR 拥塞控制
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
SYSCTL
    sysctl --system >/dev/null 2>&1 || true
    say "网络调优已开启：BBR + fq"
  else
    warn "内核 $(uname -r) 没有 bbr 模块，跳过网络调优"
  fi
fi

# 运行用户拥有数据与工作区
if [ "$(id -u)" = "0" ] && [ "$RUN_USER" != "root" ]; then
  if ! id -u "$RUN_USER" >/dev/null 2>&1; then
    say "创建运行用户 $RUN_USER"
    useradd --system --create-home --shell /bin/bash "$RUN_USER"
  fi
  chown -R "$RUN_USER":"$RUN_USER" "$ROOT/app" "$ROOT/data" "$ROOT/workspace" "$ROOT/config" "$ROOT/runtime" 2>/dev/null || true
fi

# ── 可选：账号扫码登录所需的本机 Chrome ─────────────────────────────────────
# DeepSeek 账号登录的回调必须落在 http://127.0.0.1:<port>，所以完成登录的浏览器
# 只能跑在服务器上；网关把它的画面转给远程用户扫码。
if [ "$WITH_CHROME" = "1" ]; then
  if command -v google-chrome >/dev/null 2>&1; then
    say "Chrome 已安装：$(google-chrome --version 2>/dev/null)"
  elif [ "$NODE_ARCH" != "linux-x64" ]; then
    warn "Google Chrome 只提供 x64 包；当前架构 $NODE_ARCH 需要自行安装 chromium 并设置 DSH_GATE_CHROME"
  else
    say "安装 Google Chrome（账号扫码登录用，约 100 MB）"
    CHROME_TMP="$(mktemp -d)"
    if curl -fsSL --retry 3 -o "$CHROME_TMP/chrome.rpm" https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm; then
      if command -v dnf >/dev/null 2>&1; then
        dnf install -y "$CHROME_TMP/chrome.rpm" >/dev/null 2>&1 || warn "Chrome 安装失败，可手动安装后设 DSH_GATE_CHROME"
      elif command -v yum >/dev/null 2>&1; then
        yum install -y "$CHROME_TMP/chrome.rpm" >/dev/null 2>&1 || warn "Chrome 安装失败，可手动安装后设 DSH_GATE_CHROME"
      elif command -v apt-get >/dev/null 2>&1; then
        apt-get install -y "$CHROME_TMP/chrome.rpm" >/dev/null 2>&1 || warn "Chrome 安装失败（apt 不收 rpm），请安装 chromium 后设 DSH_GATE_CHROME"
      fi
      rm -rf "$CHROME_TMP"
      if command -v google-chrome >/dev/null 2>&1; then
        say "Chrome 就绪：$(google-chrome --version 2>/dev/null)"
      else
        warn "Chrome 未装上；扫码助手会提示缺少浏览器"
      fi
    else
      rm -rf "$CHROME_TMP"
      warn "下载 Chrome 失败；扫码助手不可用（可手动安装后设 DSH_GATE_CHROME）"
    fi
  fi
fi

# ── 4. systemd ──────────────────────────────────────────────────────────────
if [ "$INSTALL_SYSTEMD" = "1" ]; then
  if [ "$(id -u)" != "0" ]; then
    warn "非 root 运行，跳过 systemd 安装；请用 sudo 重新执行，或手动运行 ./start.sh"
  elif ! command -v systemctl >/dev/null 2>&1; then
    warn "本机没有 systemd，跳过服务安装；请用 ./start.sh 前台运行或自行配置守护进程。"
  else
    say "安装 systemd 服务 dsh-web.service"
    UNIT=/etc/systemd/system/dsh-web.service
    CAP_LINES=""
    if [ "$RUN_USER" != "root" ] && [ "$PORT" -lt 1024 ]; then
      CAP_LINES="AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE"
    fi
    cat > "$UNIT" <<EOF
[Unit]
Description=DeepSeek Harness Web (password gate on port ${PORT})
Documentation=file://${ROOT}/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${ROOT}
EnvironmentFile=${ROOT}/config/gate.env
ExecStart=${ROOT}/start.sh
Restart=always
RestartSec=3
TimeoutStopSec=20
KillMode=mixed
LimitNOFILE=65536
${CAP_LINES}

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable dsh-web >/dev/null 2>&1 || true
    systemctl restart dsh-web
    sleep 2
    if systemctl is-active --quiet dsh-web; then
      say "服务已启动：dsh-web.service"
    else
      warn "服务未能启动，查看日志：journalctl -u dsh-web -n 100 --no-pager"
    fi
  fi
fi

cat <<EOF

────────────────────────────────────────────────────────────
 DeepSeek Harness Web 安装完成

   访问地址 ： http://<本机IP>:${PORT}/
   访问密码 ： 见 ${ROOT}/config/gate.env 中的 DSH_GATE_PASSWORD
   工作目录 ： ${ROOT}/workspace

   启动/停止 ： sudo systemctl start|stop|restart dsh-web
   查看日志 ： journalctl -u dsh-web -f
   健康检查 ： ${ROOT}/status.sh

 提示：
   * 局域网/公网访问需要放行 TCP ${PORT}（firewall-cmd / ufw）。
   * 用域名访问时，把域名写进 config/gate.env 的 DSH_TRUSTED_HOSTS。
   * 修改密码：编辑 config/gate.env 后 systemctl restart dsh-web。
────────────────────────────────────────────────────────────
EOF

# Split the gateway and DSH into independent systemd services.
if [ "$INSTALL_SYSTEMD" = "1" ] && [ "$(id -u)" = "0" ] && command -v systemctl >/dev/null 2>&1; then
  if [ -f "$ROOT/code/dsh-service/install-split.sh" ]; then
    bash "$ROOT/code/dsh-service/install-split.sh" || warn "split service install failed; inspect journalctl"
  fi
  # The WireGuard control panel ships inside this package; keep it independent
  # from DSH so a Harness restart cannot drop the mesh.
  if [ -x "$ROOT/code/wireguard/install-control-service.sh" ]; then
    bash "$ROOT/code/wireguard/install-control-service.sh" \
      --root "$ROOT/code/wireguard" \
      --dsh-home "${DSH_HOME:-$ROOT/home}" \
      --node "${NODE_BIN:-$ROOT/runtime/node/bin/node}" || warn "WireGuard control service install failed"
  fi
fi