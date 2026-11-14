/** Static, parameterized Linux client bootstrap served by the control panel. */

/**
 * This script contains no server-specific values. The one-click command passes
 * the control URL and join code as $1 and $2; $3 optionally overrides the
 * interface name.
 */
export const LINUX_CLIENT_SCRIPT = String.raw`#!/bin/sh
# DSH WireGuard client bootstrap for Linux (unknown distribution).
# Usage: sudo sh dsh-wg-client.sh <control-url> <join-code> [ipv4|ipv6] [interface]
set -eu

log() { printf '[dsh-wg] %s\n' "$*"; }
die() { printf '[dsh-wg] ERROR: %s\n' "$*" >&2; exit 1; }
trap 'rc=$?; if [ "$rc" -ne 0 ]; then printf "[dsh-wg] ERROR: aborted (exit %s)\n" "$rc" >&2; fi' EXIT

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <control-url> <join-code> [ipv4|ipv6] [interface]" >&2
  exit 1
fi
CONTROL_URL=$1
JOIN_CODE=$2
FAMILY=""
if [ "$#" -ge 3 ]; then
  FAMILY=$3
fi
case "$FAMILY" in
  ''|ipv4|ipv6) ;;
  *) die "Family must be ipv4 or ipv6." ;;
esac
IFACE=dshwg0
if [ "$#" -ge 4 ]; then
  IFACE=$4
fi
if [ -z "$CONTROL_URL" ] || [ -z "$JOIN_CODE" ]; then
  die "Control URL and join code are required."
fi
CONTROL_URL=$(printf '%s' "$CONTROL_URL" | sed 's:/*$::')
CONF="/etc/wireguard/$IFACE.conf"

if [ "$(id -u)" -ne 0 ]; then
  die "Run this script as root (or with sudo)."
fi

log "Starting DSH WireGuard client bootstrap"
log "Control URL: $CONTROL_URL"
log "Interface: $IFACE"
if [ -n "$FAMILY" ]; then
  log "Deployment family: $FAMILY"
fi
log "Running as root"

log "Checking required tools: wg, wg-quick, ip, curl"
need_install=0
for tool in wg wg-quick ip curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    log "Missing tool: $tool"
    need_install=1
  fi
done

if [ "$need_install" -ne 0 ]; then
  log "Installing WireGuard tools..."
  if command -v apt-get >/dev/null 2>&1; then
    log "Using apt-get"
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y wireguard-tools iproute2 curl
  elif command -v dnf >/dev/null 2>&1; then
    log "Using dnf"
    dnf install -y epel-release >/dev/null 2>&1 || true
    dnf install -y wireguard-tools iproute curl
  elif command -v yum >/dev/null 2>&1; then
    log "Using yum"
    yum install -y epel-release >/dev/null 2>&1 || true
    yum install -y wireguard-tools iproute curl
  elif command -v pacman >/dev/null 2>&1; then
    log "Using pacman"
    pacman -Sy --needed --noconfirm wireguard-tools iproute2 curl
  elif command -v zypper >/dev/null 2>&1; then
    log "Using zypper"
    zypper --non-interactive install wireguard-tools iproute2 curl
  elif command -v apk >/dev/null 2>&1; then
    log "Using apk"
    apk add --no-cache wireguard-tools iproute2 curl
  else
    die "Unknown package manager. Install wireguard-tools, iproute2 and curl, then rerun."
  fi
  log "Package installation finished"
else
  log "Required tools are already installed"
fi

for tool in wg wg-quick ip curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    die "Missing required tool after installation: $tool"
  fi
done

PRIVATE_KEY=""
EXISTING_ENDPOINT=""
if [ -f "$CONF" ]; then
  log "Existing config found: $CONF"
  PRIVATE_KEY=$(sed -n 's/^PrivateKey[[:space:]]*=[[:space:]]*//p' "$CONF" | head -n 1)
  # A member that joined over IPv6 may only be able to reach the hub over IPv6.
  # Re-running the join script must not silently downgrade it to IPv4.
  EXISTING_ENDPOINT=$(sed -n 's/^Endpoint[[:space:]]*=[[:space:]]*//p' "$CONF" | head -n 1)
fi
PUBLIC_KEY=""
if [ -n "$PRIVATE_KEY" ]; then
  PUBLIC_KEY=$(printf '%s' "$PRIVATE_KEY" | wg pubkey 2>/dev/null || true)
fi
if [ -z "$PUBLIC_KEY" ]; then
  log "Generating a new WireGuard key pair"
  PRIVATE_KEY=$(wg genkey)
  PUBLIC_KEY=$(printf '%s' "$PRIVATE_KEY" | wg pubkey)
else
  log "Reusing the existing WireGuard key"
fi

NAME=$(hostname 2>/dev/null || echo linux-client)
log "Joining server as device: $NAME"
PAYLOAD='{"name":"'"$NAME"'","publicKey":"'"$PUBLIC_KEY"'","code":"'"$JOIN_CODE"'","family":"'"$FAMILY"'","platform":"linux"}'
JOIN=$(curl -sS -X POST -H "content-type: application/json" --data "$PAYLOAD" "$CONTROL_URL/join") || die "Cannot reach $CONTROL_URL."
if ! printf '%s' "$JOIN" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
  die "Join failed: $JOIN"
fi
log "Join request accepted"

json_str() {
  printf '%s' "$1" | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}
json_num() {
  printf '%s' "$1" | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n 1
}

ADDRESS=$(json_str "$JOIN" address)
SERVER_KEY=$(json_str "$JOIN" publicKey)
ENDPOINT=$(json_str "$JOIN" endpoint)
VPN_CIDR=$(json_str "$JOIN" vpnCidr)
MTU=$(json_num "$JOIN" mtu)
DNS=$(json_str "$JOIN" dns)
HUB_IP=$(json_str "$JOIN" vpnIp)
EGRESS=0
if printf '%s' "$JOIN" | grep -Eq '"egress"[[:space:]]*:[[:space:]]*true'; then
  EGRESS=1
fi

if [ -z "$FAMILY" ] && [ -n "$EXISTING_ENDPOINT" ]; then
  ENDPOINT=$EXISTING_ENDPOINT
  log "Keeping the existing endpoint: $ENDPOINT"
fi
if [ -z "$ADDRESS" ] || [ -z "$SERVER_KEY" ] || [ -z "$ENDPOINT" ] || [ -z "$VPN_CIDR" ]; then
  die "The server response is incomplete: $JOIN"
fi
case "$ADDRESS" in
  */*) ;;
  *) ADDRESS="$ADDRESS/32" ;;
esac
if [ -z "$MTU" ]; then
  MTU=1420
fi
ALLOWED_IPS=$VPN_CIDR
if [ "$EGRESS" -eq 1 ]; then
  ALLOWED_IPS=0.0.0.0/0
  if [ -z "$HUB_IP" ]; then
    die "The server enabled egress but did not return its VPN address."
  fi
fi

log "Assigned VPN address: $ADDRESS"
log "WireGuard endpoint: $ENDPOINT"
log "VPN subnet: $VPN_CIDR"
log "MTU: $MTU"
if [ -n "$DNS" ]; then
  log "DNS: $DNS"
fi
if [ "$EGRESS" -eq 1 ]; then
  log "IPv4 egress via hub: $HUB_IP"
fi

log "Writing configuration: $CONF"
mkdir -p /etc/wireguard
umask 077
{
  echo "# Managed by the dsh-wireguard client bootstrap."
  echo "[Interface]"
  echo "PrivateKey = $PRIVATE_KEY"
  echo "Address = $ADDRESS"
  echo "MTU = $MTU"
  if [ -n "$DNS" ]; then
    echo "DNS = $DNS"
  fi
  echo ""
  echo "[Peer]"
  echo "PublicKey = $SERVER_KEY"
  echo "Endpoint = $ENDPOINT"
  echo "AllowedIPs = $ALLOWED_IPS"
  echo "PersistentKeepalive = 25"
} > "$CONF"
log "Configuration written"

if wg show "$IFACE" >/dev/null 2>&1; then
  log "Existing interface $IFACE found; bringing it down"
  wg-quick down "$IFACE" || ip link delete "$IFACE" || true
fi
log "Bringing up interface: $IFACE"
wg-quick up "$IFACE"
log "Tunnel is up"

if command -v systemctl >/dev/null 2>&1; then
  if systemctl enable "wg-quick@$IFACE" >/dev/null 2>&1; then
    log "Enabled wg-quick@$IFACE at boot"
  else
    log "Could not enable wg-quick@$IFACE at boot (continuing)"
  fi
fi

if [ "$EGRESS" -eq 1 ]; then
  log "Installing IPv4 egress persistence via $HUB_IP"
  UNIT=/etc/systemd/system/dsh-mesh-egress.service
  # wg-quick already routes 0.0.0.0/0 into table 51820 (the not-fwmark rule),
  # which leaves the main table's physical default free for the endpoint.
  # Adding a main-table default via $HUB_IP makes the hub unreachable:
  # the handshake packets fall through to that very route and loop back into
  # the tunnel. Keep the tunnel default out of the main table.
  wg set "$IFACE" peer "$SERVER_KEY" allowed-ips 0.0.0.0/0
  ip route del default via "$HUB_IP" dev "$IFACE" 2>/dev/null || true
  if ! ip route show table 51820 2>/dev/null | grep -q '^default'; then
    log "WARNING: wg-quick did not install the table-51820 default; egress may not work"
  fi
  if command -v systemctl >/dev/null 2>&1 && [ -d /etc/systemd/system ]; then
    cat >"$UNIT" <<EOF
[Unit]
Description=dsh-mesh: route IPv4 egress through the hub ($HUB_IP)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
# 0.0.0.0/0 has to be in the peer's AllowedIPs or wg-quick never creates the
# table-51820 default that carries egress. The main table stays untouched so
# the WireGuard endpoint itself keeps using the physical route.
ExecStart=/bin/sh -c 'wg set $IFACE peer $SERVER_KEY allowed-ips 0.0.0.0/0; ip route del default via $HUB_IP dev $IFACE 2>/dev/null || true'
ExecStop=/bin/sh -c 'ip route del default via $HUB_IP dev $IFACE 2>/dev/null || true'

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    if systemctl enable --now dsh-mesh-egress.service >/dev/null 2>&1; then
      log "Enabled dsh-mesh-egress.service at boot"
    else
      log "Could not enable dsh-mesh-egress.service; egress is active until reboot"
    fi
  else
    log "systemd is unavailable; egress will not survive a reboot"
  fi
fi

# --- SSH access for the gateway -------------------------------------------
# The Windows bootstrap installs OpenSSH too; Linux must do the same so the
# gateway can deploy DSH over SSH right after the mesh join.
log "Configuring SSH access for the gateway"
SSH_TOKEN=$(json_str "$JOIN" sshToken)
SSH_ERROR=""
SSH_INSTALLED=0
SSH_RUNNING=0
SSH_READY=0
SSH_VERSION=""
SERVER_SSH_KEY=""

find_sshd() {
  if command -v sshd >/dev/null 2>&1; then command -v sshd; return 0; fi
  for candidate in /usr/sbin/sshd /usr/local/sbin/sshd /usr/bin/sshd; do
    if [ -x "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
  done
  return 1
}

SSHD_BIN=$(find_sshd || true)
if [ -z "$SSHD_BIN" ]; then
  log "SSH: openssh-server is missing; installing it"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server || SSH_ERROR="apt-get install openssh-server failed"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y openssh-server || SSH_ERROR="dnf install openssh-server failed"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y openssh-server || SSH_ERROR="yum install openssh-server failed"
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --needed --noconfirm openssh || SSH_ERROR="pacman install openssh failed"
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install openssh || SSH_ERROR="zypper install openssh failed"
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache openssh || SSH_ERROR="apk add openssh failed"
  else
    SSH_ERROR="unknown package manager; install openssh-server manually"
  fi
  SSHD_BIN=$(find_sshd || true)
fi
if [ -n "$SSHD_BIN" ]; then
  SSH_INSTALLED=1
fi

if [ "$SSH_INSTALLED" -eq 1 ]; then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now sshd >/dev/null 2>&1 || systemctl enable --now ssh >/dev/null 2>&1 || true
  elif command -v service >/dev/null 2>&1; then
    service sshd start >/dev/null 2>&1 || service ssh start >/dev/null 2>&1 || true
  fi
  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ':22 '; then
    SSH_RUNNING=1
  elif command -v netstat >/dev/null 2>&1 && netstat -ltn 2>/dev/null | grep -q ':22 '; then
    SSH_RUNNING=1
  elif pgrep -x sshd >/dev/null 2>&1; then
    SSH_RUNNING=1
  fi
fi

if [ -n "$SSH_TOKEN" ]; then
  KEY_RESP=$(curl -sS -X POST -H 'content-type: application/json' --data '{"publicKey":"'"$PUBLIC_KEY"'","token":"'"$SSH_TOKEN"'"}' "$CONTROL_URL/ssh/key" 2>/dev/null || true)
  SERVER_SSH_KEY=$(json_str "$KEY_RESP" publicKey)
else
  if [ -z "$SSH_ERROR" ]; then SSH_ERROR="the join response did not include an SSH token"; fi
fi
if [ -n "$SERVER_SSH_KEY" ]; then
  mkdir -p /root/.ssh
  chmod 700 /root/.ssh
  touch /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
  if ! grep -qxF "$SERVER_SSH_KEY" /root/.ssh/authorized_keys 2>/dev/null; then
    printf '%s\n' "$SERVER_SSH_KEY" >> /root/.ssh/authorized_keys
  fi
  log "SSH: gateway key installed for root"
else
  if [ -z "$SSH_ERROR" ]; then SSH_ERROR="gateway did not return an SSH public key"; fi
fi

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi 'active'; then
  ufw allow 22/tcp >/dev/null 2>&1 || true
fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=ssh >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
fi

if [ -n "$SSHD_BIN" ]; then
  # Some images disable root logins; keep key-only root access for the gateway.
  if "$SSHD_BIN" -T 2>/dev/null | grep -qi '^permitrootlogin no'; then
    mkdir -p /etc/ssh/sshd_config.d
    printf '%s\n' 'PermitRootLogin prohibit-password' > /etc/ssh/sshd_config.d/99-dsh-mesh.conf
    if command -v systemctl >/dev/null 2>&1; then
      systemctl reload sshd >/dev/null 2>&1 || systemctl reload ssh >/dev/null 2>&1 || true
    fi
  fi
  if command -v restorecon >/dev/null 2>&1; then
    restorecon -R /root/.ssh >/dev/null 2>&1 || true
  fi
  SSH_VERSION=$("$SSHD_BIN" -V 2>&1 | head -n 1 || true)
fi
if [ -z "$SSH_VERSION" ]; then
  SSH_VERSION="OpenSSH"
fi

if [ "$SSH_INSTALLED" -eq 1 ] && [ "$SSH_RUNNING" -eq 1 ] && [ -n "$SERVER_SSH_KEY" ]; then
  SSH_READY=1
  log "SSH: ready on port 22 for root"
else
  if [ -z "$SSH_ERROR" ]; then SSH_ERROR="sshd is not listening on port 22"; fi
  log "SSH: not ready ($SSH_ERROR)"
fi

# --- SSH access back to the gateway ----------------------------------------
# Enrollment is symmetric. The member keeps its own Ed25519 identity, and the
# gateway only stores the public half, pinned to this VPN address, so
# "ssh dsh-gateway" works from here without a password or an agent.
REVERSE_KEY="/root/.ssh/id_ed25519_dsh_mesh"
REVERSE_READY=0
REVERSE_ERROR=""
if [ -n "$SSH_TOKEN" ]; then
  log "SSH: preparing the member key for the gateway"
  mkdir -p /root/.ssh
  chmod 700 /root/.ssh
  if [ ! -f "$REVERSE_KEY" ]; then
    if command -v ssh-keygen >/dev/null 2>&1; then
      ssh-keygen -q -t ed25519 -N '' -C "dsh-mesh@$NAME" -f "$REVERSE_KEY" >/dev/null 2>&1 || REVERSE_ERROR="ssh-keygen failed"
      chmod 600 "$REVERSE_KEY" 2>/dev/null || true
    else
      REVERSE_ERROR="ssh-keygen is missing"
    fi
  fi
  MEMBER_KEY=""
  if [ -f "$REVERSE_KEY.pub" ]; then
    MEMBER_KEY=$(head -n 1 "$REVERSE_KEY.pub")
  fi
  if [ -n "$MEMBER_KEY" ]; then
    AUTHORIZE=$(curl -sS -X POST -H 'content-type: application/json' --data '{"publicKey":"'"$PUBLIC_KEY"'","token":"'"$SSH_TOKEN"'","sshPublicKey":"'"$MEMBER_KEY"'"}' "$CONTROL_URL/ssh/authorize" 2>/dev/null || true)
    GW_HOST=$(json_str "$AUTHORIZE" host)
    GW_USER=$(json_str "$AUTHORIZE" user)
    GW_PORT=$(json_num "$AUTHORIZE" port)
    GW_CONFIG=$(json_str "$AUTHORIZE" sshConfigB64)
    GW_KNOWN=$(json_str "$AUTHORIZE" knownHostsB64)
    [ -n "$GW_USER" ] || GW_USER=root
    [ -n "$GW_PORT" ] || GW_PORT=22
    if [ -n "$GW_HOST" ]; then
      # Keep the rest of ~/.ssh/config: only the managed block is replaced.
      touch /root/.ssh/config
      chmod 600 /root/.ssh/config
      awk '/^# >>> dsh-mesh:gateway >>>$/{skip=1;next} /^# <<< dsh-mesh:gateway <<<$/{skip=0;next} skip!=1{print}' /root/.ssh/config > /root/.ssh/config.dsh-mesh
      cat /root/.ssh/config.dsh-mesh > /root/.ssh/config
      rm -f /root/.ssh/config.dsh-mesh
      if [ -n "$GW_CONFIG" ] && command -v base64 >/dev/null 2>&1; then
        printf '%s' "$GW_CONFIG" | base64 -d >> /root/.ssh/config
      else
        {
          echo "Host dsh-gateway $GW_HOST"
          echo "  HostName $GW_HOST"
          echo "  User $GW_USER"
          echo "  Port $GW_PORT"
          echo "  IdentityFile ~/.ssh/id_ed25519_dsh_mesh"
          echo "  IdentitiesOnly yes"
          echo "  StrictHostKeyChecking accept-new"
        } >> /root/.ssh/config
      fi
      if [ -n "$GW_KNOWN" ] && command -v base64 >/dev/null 2>&1; then
        touch /root/.ssh/known_hosts
        chmod 600 /root/.ssh/known_hosts
        printf '%s' "$GW_KNOWN" | base64 -d >> /root/.ssh/known_hosts
      fi
      REVERSE_READY=1
      log "SSH: reverse access ready ($GW_USER@$GW_HOST:$GW_PORT, key $REVERSE_KEY)"
    else
      if [ -z "$REVERSE_ERROR" ]; then
        REVERSE_ERROR="the gateway did not authorize the member key: $AUTHORIZE"
      fi
      log "SSH: reverse access failed ($REVERSE_ERROR)"
    fi
  else
    if [ -z "$REVERSE_ERROR" ]; then REVERSE_ERROR="no member public key"; fi
    log "SSH: reverse access failed ($REVERSE_ERROR)"
  fi
else
  log "SSH: reverse access skipped (no agent token)"
fi

if [ -n "$SSH_TOKEN" ]; then
  if [ "$SSH_READY" -eq 1 ]; then
    REPORT=$(curl -sS -X POST -H 'content-type: application/json' --data '{"publicKey":"'"$PUBLIC_KEY"'","token":"'"$SSH_TOKEN"'","user":"root","platform":"linux","hostname":"'"$NAME"'","sshInstalled":true,"sshRunning":true,"sshReady":true,"sshPort":22,"sshVersion":"'"$SSH_VERSION"'","sshError":null}' "$CONTROL_URL/ssh/report" 2>/dev/null || true)
  else
    REPORT=$(curl -sS -X POST -H 'content-type: application/json' --data '{"publicKey":"'"$PUBLIC_KEY"'","token":"'"$SSH_TOKEN"'","user":"root","platform":"linux","hostname":"'"$NAME"'","sshInstalled":false,"sshRunning":false,"sshReady":false,"sshPort":22,"sshVersion":"'"$SSH_VERSION"'","sshError":"SSH setup did not complete; see the deploy log"}' "$CONTROL_URL/ssh/report" 2>/dev/null || true)
  fi
  if ! printf '%s' "$REPORT" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
    log "SSH: report was not accepted: $REPORT"
  fi
fi

log "Connected successfully"
log "VPN address: $ADDRESS"
log "WireGuard endpoint: $ENDPOINT"
log "Config: $CONF"
if [ "$REVERSE_READY" -eq 1 ]; then
  log "Gateway SSH: ssh dsh-gateway (key $REVERSE_KEY)"
else
  log "Gateway SSH: not installed ($REVERSE_ERROR)"
fi
log "Disconnect: sudo wg-quick down $IFACE"
if command -v wg >/dev/null 2>&1; then
  log "Interface status:"
  wg show "$IFACE" 2>&1 | sed 's/^/[dsh-wg]   /' || true
fi
`;
