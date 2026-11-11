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
if [ -f "$CONF" ]; then
  log "Existing config found: $CONF"
  PRIVATE_KEY=$(sed -n 's/^PrivateKey[[:space:]]*=[[:space:]]*//p' "$CONF" | head -n 1)
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
PAYLOAD='{"name":"'"$NAME"'","publicKey":"'"$PUBLIC_KEY"'","code":"'"$JOIN_CODE"'","family":"'"$FAMILY"'"}'
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

log "Assigned VPN address: $ADDRESS"
log "WireGuard endpoint: $ENDPOINT"
log "VPN subnet: $VPN_CIDR"
log "MTU: $MTU"
if [ -n "$DNS" ]; then
  log "DNS: $DNS"
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
  echo "AllowedIPs = $VPN_CIDR"
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

log "Connected successfully"
log "VPN address: $ADDRESS"
log "WireGuard endpoint: $ENDPOINT"
log "Config: $CONF"
log "Disconnect: sudo wg-quick down $IFACE"
if command -v wg >/dev/null 2>&1; then
  log "Interface status:"
  wg show "$IFACE" 2>&1 | sed 's/^/[dsh-wg]   /' || true
fi
`;
