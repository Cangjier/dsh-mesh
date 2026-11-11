// src/control-service.ts
import { homedir } from "node:os";
import path5 from "node:path";

// src/lib/constants.ts
var PLUGIN_VERSION = "0.2.0";
var SERVICE_NAME = "dsh-wireguard";
var API_PREFIX = "/api/dsh-wireguard";
var DEFAULT_CONTROL_PORT = 51821;
var DEFAULT_LISTEN_PORT = 51820;
var DEFAULT_VPN_CIDR = "10.66.66.0/24";
var DEFAULT_SERVER_IP = "10.66.66.1";
var DEFAULT_INTERFACE = "dshwg0";
var DEFAULT_MTU = 1420;
var MAX_PEERS = 1024;
var MAX_STATE_BYTES = 2 * 1024 * 1024;
var MAX_REQUEST_BYTES = 64 * 1024;

// src/lib/errors.ts
var WireGuardError = class extends Error {
  code;
  status;
  hint;
  command;
  details;
  constructor(code, message, options = {}) {
    super(message, options.cause === void 0 ? void 0 : { cause: options.cause });
    this.name = "WireGuardError";
    this.code = code;
    this.status = options.status ?? 400;
    this.hint = options.hint;
    this.command = options.command;
    this.details = options.details;
  }
  toJSON() {
    const body = { code: this.code, message: this.message };
    if (this.hint) body.hint = this.hint;
    if (this.command) body.command = this.command;
    if (this.details !== void 0) body.details = this.details;
    return body;
  }
};
function missingToolHint(tool, platform) {
  if (platform === "win32") {
    return `Install the official WireGuard client from https://www.wireguard.com/install/ and restart Harness. Expected ${tool} in C:\\Program Files\\WireGuard.`;
  }
  if (platform === "linux") {
    return `Install WireGuard tools (for example: sudo apt install wireguard iproute2), then restart Harness. Missing: ${tool}.`;
  }
  return `WireGuard is supported on Windows and Linux; this host reports ${platform}.`;
}

// src/lib/http-api.ts
var AGENT_HEADER = "x-dsh-wireguard";
function writeJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}
async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new WireGuardError("request_too_large", "Request body is too large.", { status: 413 });
    chunks.push(buffer);
  }
  if (size === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WireGuardError("invalid_json", "Request body is not valid JSON.", { status: 400 });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WireGuardError("invalid_json", "Request body must be a JSON object.", { status: 400 });
  }
  return parsed;
}
function createHttpApiHandler(service2) {
  return async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://local.invalid");
      const path6 = url.pathname;
      if (method === "GET" && path6 === `${API_PREFIX}/state`) {
        writeJson(response, 200, { ok: true, state: await service2.getState() });
        return;
      }
      if (method === "GET" && path6 === `${API_PREFIX}/health`) {
        writeJson(response, 200, { ok: true, service: "dsh-wireguard" });
        return;
      }
      if (method !== "POST") {
        writeJson(response, 405, { ok: false, error: { code: "method_not_allowed", message: "Use GET or POST." } });
        return;
      }
      if (request.headers[AGENT_HEADER] !== "1") {
        writeJson(response, 403, { ok: false, error: { code: "forbidden", message: "Missing the local WireGuard request header." } });
        return;
      }
      const body = await readJson(request);
      let result;
      if (path6 === `${API_PREFIX}/install`) result = await service2.installWireGuard();
      else if (path6 === `${API_PREFIX}/server/start`) result = await service2.startServer(body);
      else if (path6 === `${API_PREFIX}/server/stop`) result = await service2.stopServer();
      else if (path6 === `${API_PREFIX}/peers/remove`) result = await service2.removePeer(String(body.publicKey ?? ""));
      else if (path6 === `${API_PREFIX}/peers/ssh`) result = await service2.configurePeerSsh(body);
      else if (path6 === `${API_PREFIX}/client/connect`) result = await service2.connectClient(body);
      else if (path6 === `${API_PREFIX}/client/retry`) result = await service2.retryClient();
      else if (path6 === `${API_PREFIX}/client/disconnect`) result = await service2.disconnectClient();
      else if (path6 === `${API_PREFIX}/refresh`) result = await service2.getState({ force: true });
      else {
        writeJson(response, 404, { ok: false, error: { code: "not_found", message: "Unknown WireGuard endpoint." } });
        return;
      }
      if (result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "state")) {
        writeJson(response, 200, { ok: true, ...result });
      } else {
        writeJson(response, 200, { ok: true, state: result });
      }
    } catch (error) {
      const state = service2.snapshot();
      if (error instanceof WireGuardError) {
        writeJson(response, error.status, { ok: false, error: error.toJSON(), state });
        return;
      }
      writeJson(response, 500, {
        ok: false,
        error: {
          code: "internal_error",
          message: error instanceof Error ? error.message : "The WireGuard operation failed."
        },
        state
      });
    }
  };
}

// src/lib/service.ts
import { execFile as execFile2 } from "node:child_process";
import { createHash as createHash2 } from "node:crypto";
import { chmod as chmod2, mkdir as mkdir3, readFile as readFile2, rm as rm2, writeFile as writeFile2 } from "node:fs/promises";
import { isIP as isIP2 } from "node:net";
import path4 from "node:path";
import { promisify } from "node:util";

// src/lib/access.ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
function generateJoinCode() {
  return randomBytes(9).toString("base64url");
}
function secretsMatch(supplied, expected) {
  if (!supplied || !expected) return false;
  const left = createHash("sha256").update(supplied).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

// src/lib/config.ts
import { isIP } from "node:net";

// src/lib/ip.ts
var IPV4_PATTERN = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
function parseIpv4(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!IPV4_PATTERN.test(text)) return null;
  const parts = text.split(".").map(Number);
  return (parts[0] << 24 | parts[1] << 16 | parts[2] << 8 | parts[3]) >>> 0;
}
function ipv4ToString(value) {
  const n = value >>> 0;
  return `${n >>> 24 & 255}.${n >>> 16 & 255}.${n >>> 8 & 255}.${n & 255}`;
}
function parseCidr(value) {
  if (typeof value !== "string") return null;
  const match = /^([^/]+)\/(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const ip = parseIpv4(match[1]);
  const prefix = Number(match[2]);
  if (ip === null || !Number.isInteger(prefix) || prefix < 8 || prefix > 30) return null;
  const mask = prefix === 0 ? 0 : 4294967295 << 32 - prefix >>> 0;
  const network = (ip & mask) >>> 0;
  const size = 2 ** (32 - prefix);
  const broadcast = network + size - 1 >>> 0;
  return {
    network,
    prefix,
    mask,
    first: network + 1 >>> 0,
    last: broadcast - 1 >>> 0,
    broadcast,
    normalized: `${ipv4ToString(network)}/${prefix}`
  };
}
function isIpInCidr(ip, cidr) {
  if (!cidr) return false;
  return (ip & cidr.mask) >>> 0 === cidr.network;
}
function isUsableHost(ip, cidr) {
  return isIpInCidr(ip, cidr) && ip !== cidr.network && ip !== cidr.broadcast;
}
function defaultServerIp(cidr) {
  return ipv4ToString(cidr.first);
}
function allocatePeerIp(cidr, used, serverIp) {
  const reserved = /* @__PURE__ */ new Set([serverIp]);
  for (const value of used) {
    if (typeof value === "string") reserved.add(value);
  }
  const limit = Math.min(cidr.last, cidr.network + 65535);
  for (let candidate = cidr.network + 2 >>> 0; candidate <= limit; candidate = candidate + 1 >>> 0) {
    if (candidate === cidr.broadcast) break;
    const text = ipv4ToString(candidate);
    if (!reserved.has(text)) return text;
  }
  return null;
}

// src/lib/config.ts
var DEFAULT_SETTINGS = Object.freeze({
  controlPort: DEFAULT_CONTROL_PORT,
  listenPort: DEFAULT_LISTEN_PORT,
  vpnCidr: DEFAULT_VPN_CIDR,
  serverIp: DEFAULT_SERVER_IP,
  mtu: DEFAULT_MTU,
  interfaceName: DEFAULT_INTERFACE,
  endpointHost: "",
  joinCode: "",
  dns: ""
});
var HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
var INTERFACE_NAME = /^[A-Za-z0-9_=+.-]{1,15}$/;
var JOIN_CODE = /^[A-Za-z0-9_-]{0,64}$/;
function invalid(field, message) {
  throw new WireGuardError("invalid_input", message, {
    status: 400,
    details: { field }
  });
}
function integerInRange(value, field, min, max) {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    invalid(field, `${field} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}
function formatEndpointHost(host) {
  return isIP(host) === 6 ? `[${host}]` : host;
}
function normalizeEndpointHost(value) {
  let text = String(value ?? "").trim();
  if (!text) return "";
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  text = text.split("/")[0].split("?")[0].split("#")[0];
  if (text.startsWith("[")) {
    const match2 = /^\[([0-9A-Fa-f:.]+)\](?::\d{1,5})?$/.exec(text);
    if (!match2 || isIP(match2[1]) !== 6) {
      invalid("endpointHost", "Server address must be an IPv4 address, an IPv6 address, or a hostname.");
    }
    if (match2[1] === "::") invalid("endpointHost", "Server address must be a connectable IPv6 address.");
    return match2[1];
  }
  if (isIP(text) === 6) {
    if (text === "::") invalid("endpointHost", "Server address must be a connectable IPv6 address.");
    return text;
  }
  const match = /^([^:]+)(?::\d{1,5})?$/.exec(text);
  if (!match) invalid("endpointHost", "Bracket IPv6 addresses when adding a port, for example [2408:...]:51821.");
  const host = match[1].trim();
  const address = parseIpv4(host);
  if (address !== null) {
    if (address === 0 || address === 4294967295 || address >= 3758096384 && address <= 4026531839) {
      invalid("endpointHost", "Server address must be a unicast IPv4 address, an IPv6 address, or a hostname.");
    }
    return host;
  }
  if (host.length > 253) invalid("endpointHost", "Server address is too long.");
  const labels = host.split(".");
  if (labels.some((label) => !HOST_LABEL.test(label))) {
    invalid("endpointHost", "Server address must be an IPv4 address, an IPv6 address, or a valid hostname.");
  }
  return host;
}
function normalizeDeviceName(value, fallback = "device") {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const name = text || fallback;
  return Array.from(name).slice(0, 64).join("");
}
function normalizeSettings(raw, base = DEFAULT_SETTINGS) {
  const source = raw && typeof raw === "object" ? raw : {};
  const merged = { ...DEFAULT_SETTINGS, ...base, ...source };
  const cidr = parseCidr(merged.vpnCidr);
  if (!cidr) invalid("vpnCidr", "VPN subnet must be an IPv4 CIDR from /8 to /30, for example 10.66.66.0/24.");
  let serverIp = String(merged.serverIp ?? "").trim();
  if (!serverIp) serverIp = defaultServerIp(cidr);
  let serverNumber = parseIpv4(serverIp);
  if (serverNumber === null) invalid("serverIp", "Server VPN address must be a valid IPv4 address.");
  if (!isUsableHost(serverNumber, cidr)) {
    if (source.serverIp === void 0) {
      serverIp = defaultServerIp(cidr);
      serverNumber = parseIpv4(serverIp);
    }
    if (serverNumber === null || !isUsableHost(serverNumber, cidr)) {
      invalid("serverIp", `Server VPN address must be a usable host inside ${cidr.normalized}.`);
    }
  }
  const interfaceName = String(merged.interfaceName ?? DEFAULT_INTERFACE).trim();
  if (!INTERFACE_NAME.test(interfaceName) || interfaceName === "." || interfaceName === "..") {
    invalid("interfaceName", "Interface name must be 1\u201315 letters, digits, dots, underscores, plus, equals, or dashes.");
  }
  const joinCode = String(merged.joinCode ?? "").trim();
  if (!JOIN_CODE.test(joinCode)) {
    invalid("joinCode", "Join code may contain only letters, digits, underscores, and dashes (up to 64 characters).");
  }
  const dns = String(merged.dns ?? "").trim();
  if (dns) {
    for (const part of dns.split(",")) {
      const address = part.trim();
      if (parseIpv4(address) === null) invalid("dns", "DNS must be a comma-separated list of IPv4 addresses.");
    }
  }
  return {
    settings: {
      controlPort: integerInRange(merged.controlPort, "controlPort", 1024, 65535),
      listenPort: integerInRange(merged.listenPort, "listenPort", 1024, 65535),
      vpnCidr: cidr.normalized,
      serverIp,
      mtu: integerInRange(merged.mtu, "mtu", 576, 9e3),
      interfaceName,
      endpointHost: normalizeEndpointHost(merged.endpointHost),
      joinCode,
      dns
    },
    cidr
  };
}
function buildServerConfig(input) {
  const lines = [
    "# Managed by dsh-wireguard. Manual edits are overwritten.",
    "[Interface]",
    `PrivateKey = ${input.privateKey}`,
    `Address = ${input.settings.serverIp}/${input.cidr.prefix}`,
    `ListenPort = ${input.settings.listenPort}`,
    `MTU = ${input.settings.mtu}`
  ];
  for (const peer of input.peers) {
    lines.push("", "# peer", "[Peer]", `PublicKey = ${peer.publicKey}`, `AllowedIPs = ${peer.ip}/32`);
  }
  return `${lines.join("\n")}
`;
}
function buildClientConfig(input) {
  const lines = [
    "# Managed by dsh-wireguard. Manual edits are overwritten.",
    "[Interface]",
    `PrivateKey = ${input.privateKey}`,
    `Address = ${input.address}/32`,
    `MTU = ${input.settings.mtu}`
  ];
  if (input.settings.dns) lines.push(`DNS = ${input.settings.dns}`);
  lines.push(
    "",
    "[Peer]",
    `PublicKey = ${input.serverPublicKey}`,
    `Endpoint = ${input.endpoint}`,
    `AllowedIPs = ${input.vpnCidr}`,
    "PersistentKeepalive = 25"
  );
  return `${lines.join("\n")}
`;
}
function parseServerAddress(value, defaultPort = DEFAULT_CONTROL_PORT) {
  let text = String(value ?? "").trim();
  if (!text) invalid("serverAddress", "Enter the server address.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    if (isIP(text) === 6) text = `http://[${text}]`;
    else text = `http://${text}`;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    invalid("serverAddress", "Server address is not a valid host, host:port, or URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    invalid("serverAddress", "Only http and https control-panel addresses are supported.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    invalid("serverAddress", "Server address must not include a path.");
  }
  if (url.search || url.hash) invalid("serverAddress", "Server address must not include a query or fragment.");
  const host = normalizeEndpointHost(url.hostname);
  if (!host) invalid("serverAddress", "Server address is missing a host.");
  if (host === "0.0.0.0" || host === "::") invalid("serverAddress", "0.0.0.0 is not a connectable server address.");
  const port = url.port ? integerInRange(url.port, "serverAddress", 1, 65535) : defaultPort;
  const controlUrl = `${url.protocol}//${formatEndpointHost(host)}:${port}`;
  return { host, port, controlUrl, display: `${formatEndpointHost(host)}:${port}` };
}

// src/lib/control-panel.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import { createServer } from "node:http";

// src/lib/client-script.ts
var LINUX_CLIENT_SCRIPT = String.raw`#!/bin/sh
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

// src/lib/control-panel.ts
var RATE_WINDOW_MS = 6e4;
var RATE_LIMIT = 30;
var COOKIE_NAME = "dsh_wg_panel";
var SESSION_TTL_MS = 8 * 60 * 60 * 1e3;
var LOGIN_BODY_LIMIT = 4096;
function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
async function readJson2(request, limit = MAX_REQUEST_BYTES) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      throw new WireGuardError("request_too_large", "Request body is too large.", { status: 413 });
    }
    chunks.push(buffer);
  }
  if (size === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WireGuardError("invalid_json", "Request body is not valid JSON.", { status: 400 });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WireGuardError("invalid_json", "Request body must be a JSON object.", { status: 400 });
  }
  return parsed;
}
async function readForm(request, limit = LOGIN_BODY_LIMIT) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      throw new WireGuardError("request_too_large", "Request body is too large.", { status: 413 });
    }
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}
function writeJson2(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}
var ControlPanel = class {
  options;
  server;
  port;
  attempts;
  sessions;
  log;
  constructor(options) {
    this.options = options;
    this.server = null;
    this.port = null;
    this.attempts = /* @__PURE__ */ new Map();
    this.sessions = /* @__PURE__ */ new Map();
    this.log = options.log ?? (() => {
    });
  }
  async start(port, host = "0.0.0.0") {
    if (this.server) throw new WireGuardError("already_running", "The control panel is already running.", { status: 409 });
    const server = createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        this.log(`control panel request failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!response.headersSent) writeJson2(response, 500, { ok: false, error: { code: "internal_error", message: "The control panel request failed." } });
        else response.destroy();
      });
    });
    server.keepAliveTimeout = 1e4;
    server.headersTimeout = 15e3;
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        if (error.code === "EADDRINUSE") {
          reject(new WireGuardError("port_in_use", `Control-panel port ${port} is already in use.`, {
            status: 409,
            hint: "Choose another control-panel port on the Service tab and start again."
          }));
        } else {
          reject(new WireGuardError("control_error", `Could not start the control panel: ${error.message}`, { status: 500, cause: error }));
        }
      };
      server.once("error", onError);
      server.listen({ port, host, ipv6Only: false }, () => {
        server.off("error", onError);
        resolve();
      });
    });
    this.server = server;
    this.port = port;
    this.log(`control panel listening on ${host}:${port}`);
    return { port, host };
  }
  /**
   * Stop the listener and every retained connection.
   * @returns {Promise<void>}
   */
  async stop() {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) return;
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
      setTimeout(resolve, 1500).unref?.();
    });
  }
  /**
   * @param {import('node:http').IncomingMessage} request incoming request.
   * @param {import('node:http').ServerResponse} response response.
   * @returns {Promise<void>}
   */
  async handle(request, response) {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://control-panel.invalid");
    const remoteAddress = request.socket.remoteAddress ?? "unknown";
    if (!this.allow(remoteAddress)) {
      writeJson2(response, 429, { ok: false, error: { code: "rate_limited", message: "Too many requests. Try again in a minute." } });
      return;
    }
    if (this.options.extraHandler) {
      const handled = await this.options.extraHandler(request, response);
      if (handled) return;
    }
    if (method === "POST" && url.pathname === "/login") {
      await this.handleLogin(request, response);
      return;
    }
    if (method === "POST" && url.pathname === "/logout") {
      this.handleLogout(request, response);
      return;
    }
    if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      if (!this.authed(request)) {
        this.writeLogin(response);
        return;
      }
      this.writePage(response);
      return;
    }
    if (method === "GET" && url.pathname === "/health") {
      const { joinCode: _joinCode, ...publicInfo } = this.options.getServerInfo();
      writeJson2(response, 200, { ok: true, service: "dsh-wireguard", ...publicInfo });
      return;
    }
    if (method === "GET" && url.pathname === "/client.sh") {
      response.writeHead(200, {
        "content-type": "text/x-shellscript; charset=utf-8",
        "content-length": Buffer.byteLength(LINUX_CLIENT_SCRIPT),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      });
      response.end(LINUX_CLIENT_SCRIPT);
      return;
    }
    if (method === "GET" && url.pathname === "/peers") {
      try {
        if (!this.authed(request)) this.assertCode(url.searchParams.get("code") ?? "");
        writeJson2(response, 200, { ok: true, peers: this.options.getPeers() });
      } catch (error) {
        this.writeError(response, error);
      }
      return;
    }
    if (method === "POST" && url.pathname === "/join") {
      try {
        const body = await readJson2(request);
        if (!body.code && url.searchParams.get("code")) body.code = url.searchParams.get("code");
        const result = await this.options.onJoin(body, remoteAddress);
        writeJson2(response, 200, { ok: true, ...result });
      } catch (error) {
        this.writeError(response, error);
      }
      return;
    }
    if (method === "POST" && url.pathname === "/leave") {
      try {
        const body = await readJson2(request);
        const result = await this.options.onLeave(body, remoteAddress);
        writeJson2(response, 200, { ok: true, ...result });
      } catch (error) {
        this.writeError(response, error);
      }
      return;
    }
    writeJson2(response, 404, { ok: false, error: { code: "not_found", message: "Unknown control-panel endpoint." } });
  }
  /**
   * Whether the request carries a valid panel session.
   * @param {import('node:http').IncomingMessage} request incoming request.
   * @returns {boolean} whether the request is authenticated.
   */
  authed(request) {
    const code = this.options.getAccessCode();
    if (!code) return true;
    const token = this.cookieToken(request);
    if (!token) return false;
    const expires = this.sessions.get(token);
    if (expires === void 0) return false;
    if (expires <= Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }
  /**
   * Read the panel session token from the cookie header.
   * @param {import('node:http').IncomingMessage} request incoming request.
   * @returns {string} token or an empty string.
   */
  cookieToken(request) {
    const header = request.headers.cookie;
    if (typeof header !== "string") return "";
    for (const part of header.split(";")) {
      const item = part.trim();
      const separator = item.indexOf("=");
      if (separator <= 0) continue;
      if (item.slice(0, separator) === COOKIE_NAME) return item.slice(separator + 1);
    }
    return "";
  }
  /**
   * Validate the password from the login form and start a session.
   * @param {import('node:http').IncomingMessage} request incoming request.
   * @param {import('node:http').ServerResponse} response response.
   * @returns {Promise<void>}
   */
  async handleLogin(request, response) {
    const code = this.options.getAccessCode();
    if (!code) {
      response.writeHead(303, { location: "/", "cache-control": "no-store", "content-length": 0 });
      response.end();
      return;
    }
    let form;
    try {
      form = await readForm(request);
    } catch {
      this.writeLogin(response, true, 400);
      return;
    }
    if (!secretsMatch(form.get("password") ?? "", code)) {
      this.writeLogin(response, true, 401);
      return;
    }
    const token = randomBytes2(32).toString("hex");
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    if (this.sessions.size > 128) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== void 0) this.sessions.delete(oldest);
    }
    response.writeHead(303, {
      location: "/",
      "set-cookie": `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1e3)}`,
      "cache-control": "no-store",
      "content-length": 0
    });
    response.end();
  }
  /**
   * Clear the session and return to the login page.
   * @param {import('node:http').IncomingMessage} request incoming request.
   * @param {import('node:http').ServerResponse} response response.
   * @returns {void}
   */
  handleLogout(request, response) {
    const token = this.cookieToken(request);
    if (token) this.sessions.delete(token);
    response.writeHead(303, {
      location: "/",
      "set-cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      "cache-control": "no-store",
      "content-length": 0
    });
    response.end();
  }
  /**
   * Render the in-page login form. No Basic-auth challenge is sent, so browsers
   * never show their native credentials dialog.
   * @param {import('node:http').ServerResponse} response response.
   * @param {boolean} [failed] whether the last attempt failed.
   * @param {number} [status] HTTP status.
   * @returns {void}
   */
  writeLogin(response, failed = false, status = 200) {
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'">
<title>WireGuard \u63A7\u5236\u9762\u677F \xB7 \u767B\u5F55</title>
<style>
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f7fb; color: #152033; }
main { width: min(420px, calc(100vw - 40px)); margin: 40px 0; padding: 28px; border-radius: 18px; background: #fff; box-shadow: 0 18px 60px rgba(23, 44, 75, .12); }
h1 { margin: 0 0 6px; font-size: 24px; letter-spacing: -.02em; }
p { color: #5b6b82; line-height: 1.55; }
.badge { display: inline-block; padding: 3px 9px; border-radius: 999px; background: #eef3fa; color: #27456f; font-size: 12px; font-weight: 600; }
label { display: block; margin: 22px 0 8px; color: #5b6b82; font-size: 13px; }
input { width: 100%; box-sizing: border-box; padding: 11px 12px; border: 1px solid #cbd7e6; border-radius: 9px; background: #fff; color: #152033; font: inherit; }
input:focus { outline: 2px solid #2f7cff; outline-offset: 1px; border-color: transparent; }
button { width: 100%; margin-top: 14px; padding: 11px 14px; border: 0; border-radius: 9px; background: #2f7cff; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
button:hover { background: #1f6ae5; }
.error { margin: 14px 0 0; padding: 10px 12px; border-radius: 8px; background: #fff1f0; color: #b42318; font-size: 13px; }
.note { margin: 18px 0 0; font-size: 12px; color: #7a8aa0; }
@media (prefers-color-scheme: dark) { body { background: #0d1420; color: #e6edf7; } main { background: #151f2e; box-shadow: none; } p, label { color: #9babc2; } .badge { background: #17263b; color: #c1d4ef; } input { background: #0f1927; border-color: #2a3a52; color: #e6edf7; } .error { background: #3a1717; color: #ffb4ab; } .note { color: #7f90a8; } }
</style>
</head>
<body>
<main>
  <span class="badge">WIREGUARD</span>
  <h1>\u63A7\u5236\u9762\u677F\u767B\u5F55</h1>
  <p>\u8BF7\u8F93\u5165\u52A0\u5165\u7801\u3002\u52A0\u5165\u7801\u540C\u65F6\u4F5C\u4E3A\u63A7\u5236\u9762\u677F\u5BC6\u7801\u3002</p>
  <form method="post" action="/login">
    <label for="password">\u52A0\u5165\u7801 / \u63A7\u5236\u9762\u677F\u5BC6\u7801</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">\u767B\u5F55</button>
  </form>
  ${failed ? '<p class="error">\u5BC6\u7801\u9519\u8BEF\uFF0C\u8BF7\u91CD\u8BD5\u3002 / Incorrect password.</p>' : ""}
  <p class="note">The join code is also the control-panel password.</p>
</main>
</body>
</html>`;
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });
    response.end(html);
  }
  /**
   * Validate the optional join code against the live server configuration.
   * @param {string} supplied code from a request.
   * @returns {void}
   */
  assertCode(supplied) {
    const info = this.options.getServerInfo();
    const required = info.joinRequired === true;
    if (required && !secretsMatch(supplied, String(info.joinCode ?? ""))) {
      throw new WireGuardError("invalid_join_code", "The join code is missing or incorrect.", { status: 401 });
    }
  }
  /**
   * Fixed-window per-IP rate limit. LAN join traffic is tiny; this only stops
   * runaway retries and casual probing.
   * @param {string} key remote address.
   * @returns {boolean} whether the request is admitted.
   */
  allow(key) {
    const now = Date.now();
    const recent = (this.attempts.get(key) ?? []).filter((stamp) => now - stamp < RATE_WINDOW_MS);
    recent.push(now);
    this.attempts.set(key, recent);
    if (this.attempts.size > 512) {
      for (const [address, stamps] of this.attempts) {
        if (stamps.every((stamp) => now - stamp >= RATE_WINDOW_MS)) this.attempts.delete(address);
      }
    }
    return recent.length <= RATE_LIMIT;
  }
  /**
   * @param {import('node:http').ServerResponse} response response.
   * @param {unknown} error failure.
   * @returns {void}
   */
  writeError(response, error) {
    if (error instanceof WireGuardError) {
      writeJson2(response, error.status, { ok: false, error: error.toJSON() });
      return;
    }
    this.log(`control panel operation failed: ${error instanceof Error ? error.message : String(error)}`);
    writeJson2(response, 500, { ok: false, error: { code: "internal_error", message: "The control-panel operation failed." } });
  }
  /**
   * Render the status page shown when the port is opened in a browser. It is
   * password-protected when configured and never includes the join code or
   * peer identities.
   * @param {import('node:http').ServerResponse} response response.
   * @returns {void}
   */
  writePage(response) {
    const info = this.options.getServerInfo();
    const peers = this.options.getPeers();
    const protectedPage = Boolean(this.options.getAccessCode());
    const endpoint = escapeHtml(info.endpoint ?? "not available");
    const control = escapeHtml(String(info.controlUrl ?? `http://${info.endpointHost ?? "server"}:${info.controlPort ?? ""}`));
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'">
<title>WireGuard control panel</title>
<style>
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f7fb; color: #152033; }
main { width: min(640px, calc(100vw - 40px)); margin: 40px 0; padding: 28px; border-radius: 18px; background: #fff; box-shadow: 0 18px 60px rgba(23, 44, 75, .12); }
h1 { margin: 0 0 6px; font-size: 24px; letter-spacing: -.02em; }
p { color: #5b6b82; line-height: 1.55; }
.badge { display: inline-block; padding: 3px 9px; border-radius: 999px; background: #e6f7ee; color: #147a4b; font-size: 12px; font-weight: 600; }
dl { display: grid; grid-template-columns: 150px 1fr; gap: 10px 16px; margin: 22px 0; }
dt { color: #5b6b82; font-size: 13px; }
dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; overflow-wrap: anywhere; }
code { background: #eef3fa; padding: 2px 6px; border-radius: 5px; }
.note { padding: 12px 14px; border-radius: 10px; background: #f0f6ff; color: #27456f; font-size: 13px; }
.logout { margin-top: 18px; }
.logout button { border: 0; border-radius: 8px; padding: 7px 11px; background: #eef3fa; color: #27456f; font: inherit; cursor: pointer; }
@media (prefers-color-scheme: dark) { body { background: #0d1420; color: #e6edf7; } main { background: #151f2e; box-shadow: none; } p, dt { color: #9babc2; } .badge { background: #123a2a; color: #72e4ad; } .note { background: #17263b; color: #c1d4ef; } code { background: #202e42; } .logout button { background: #202e42; color: #c1d4ef; } }
</style>
</head>
<body>
<main>
  <span class="badge">RUNNING</span>
  <h1>WireGuard control panel</h1>
  <p>This machine is running a DSH WireGuard server. Open the WireGuard panel in a DSH client, choose <strong>Client</strong>, and enter this server's address.</p>
  <dl>
    <dt>Control address</dt><dd><code>${control}</code></dd>
    <dt>WireGuard endpoint</dt><dd>${endpoint}</dd>
    <dt>VPN subnet</dt><dd>${escapeHtml(info.vpnCidr ?? "")}</dd>
    <dt>Server public key</dt><dd>${escapeHtml(info.publicKey ?? "")}</dd>
    <dt>Connected peers</dt><dd>${peers.length}</dd>
    <dt>Join code / password</dt><dd>${info.joinRequired ? "required \u2014 ask the server operator" : "not required \u2014 anyone who can reach this port may join"}</dd>
    <dt>Panel access</dt><dd>${protectedPage ? "join code / password protected" : "open \u2014 no join code is set"}</dd>
  </dl>
  <div class="note">Client address example: <code>${endpoint}</code> in the Client tab. ${protectedPage ? "This page is protected by the join code, which is also the control-panel password." : "This page has no password. Set a join code in the WireGuard plugin before exposing this port."} The control panel uses plain HTTP and never exposes a private key.</div>
  ${protectedPage ? '<form method="post" action="/logout" class="logout"><button type="submit">\u9000\u51FA\u767B\u5F55 / Sign out</button></form>' : ""}
</main>
</body>
</html>`;
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });
    response.end(html);
  }
};

// src/lib/installer.ts
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path2 from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

// src/lib/platform.ts
import { execFile } from "node:child_process";
import { accessSync, constants as syncConstants } from "node:fs";
import { networkInterfaces, hostname as osHostname } from "node:os";
import path from "node:path";
var IS_WINDOWS = process.platform === "win32";
var IS_LINUX = process.platform === "linux";
var PATH_EXTENSIONS = IS_WINDOWS ? [".exe", ".cmd", ""] : [""];
var CommandError = class extends Error {
  command;
  args;
  exitCode;
  signal;
  stdout;
  stderr;
  constructor(message, details) {
    super(message);
    this.name = "CommandError";
    this.command = details.command;
    this.args = details.args;
    this.exitCode = details.exitCode;
    this.signal = details.signal;
    this.stdout = details.stdout ?? "";
    this.stderr = details.stderr ?? "";
  }
};
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        timeout: options.timeout ?? 2e4,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
        encoding: "utf8",
        cwd: options.cwd,
        env: {
          ...process.env,
          LC_ALL: "C",
          LANG: "C",
          ...options.env
        }
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
          return;
        }
        const detail = String(stderr || stdout || error.message).trim().slice(0, 800);
        reject(new CommandError(`${path.basename(command)} failed${detail ? `: ${detail}` : ""}`, {
          command,
          args,
          exitCode: error.code,
          signal: error.signal,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "")
        }));
      }
    );
    child.once("error", (error) => {
      reject(new CommandError(`${path.basename(command)} could not start: ${error.message}`, {
        command,
        args,
        exitCode: error.code
      }));
    });
  });
}
function findExecutable(name, candidates = []) {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, syncConstants.X_OK);
      return candidate;
    } catch {
    }
  }
  const directories = String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const extension of PATH_EXTENSIONS) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        accessSync(candidate, syncConstants.X_OK);
        return candidate;
      } catch {
      }
    }
  }
  return null;
}
async function detectAdmin() {
  if (IS_LINUX) return typeof process.getuid === "function" && process.getuid() === 0;
  if (!IS_WINDOWS) return false;
  try {
    await run("fltmc.exe", ["filters"], { timeout: 5e3 });
    return true;
  } catch {
    try {
      await run("net.exe", ["session"], { timeout: 5e3 });
      return true;
    } catch {
      return false;
    }
  }
}
async function detectPlatform() {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const windowsCandidates = [
    path.join(programFiles, "WireGuard"),
    path.join(programFilesX86, "WireGuard"),
    ...localAppData ? [path.join(localAppData, "Programs", "WireGuard")] : []
  ];
  const wg = IS_WINDOWS ? findExecutable("wg", windowsCandidates.map((directory) => path.join(directory, "wg.exe"))) : findExecutable("wg", ["/usr/bin/wg", "/usr/sbin/wg", "/usr/local/bin/wg"]);
  const wireguard = IS_WINDOWS ? findExecutable("wireguard", windowsCandidates.map((directory) => path.join(directory, "wireguard.exe"))) : null;
  const ip = IS_LINUX ? findExecutable("ip", ["/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip"]) : null;
  return {
    platform: process.platform,
    isWindows: IS_WINDOWS,
    isLinux: IS_LINUX,
    admin: await detectAdmin(),
    wg,
    wireguard,
    ip,
    sudo: IS_LINUX ? findExecutable("sudo", ["/usr/bin/sudo", "/bin/sudo"]) : null,
    iptables: IS_LINUX ? findExecutable("iptables", ["/usr/sbin/iptables", "/sbin/iptables"]) : null,
    nft: IS_LINUX ? findExecutable("nft", ["/usr/sbin/nft", "/usr/bin/nft"]) : null,
    sysctl: IS_LINUX ? findExecutable("sysctl", ["/usr/sbin/sysctl", "/sbin/sysctl", "/usr/bin/sysctl"]) : null
  };
}
async function runPrivileged(command, args, options) {
  const { platform } = options;
  if (platform.isWindows || platform.admin) {
    return run(command, args, { timeout: options.timeout });
  }
  const sudo = platform.sudo;
  if (!sudo) {
    throw new WireGuardError("needs_privilege", "WireGuard needs administrator rights, and sudo was not found.", {
      status: 403,
      hint: "Run Harness as root, or install sudo and allow passwordless execution for the WireGuard commands.",
      command: `sudo ${command} ${args.join(" ")}`
    });
  }
  try {
    return await run(sudo, ["-n", command, ...args], { timeout: options.timeout });
  } catch (error) {
    const text = error instanceof CommandError ? `${error.stderr}
${error.stdout}` : String(error);
    if (/password is required|a terminal is required|not allowed|permission denied/i.test(text)) {
      throw new WireGuardError("needs_privilege", "WireGuard needs administrator rights, but passwordless sudo is not available.", {
        status: 403,
        hint: "Run \u201Csudo -v\u201D in a terminal to authorize this user, then press Retry. For unattended use, run Harness as root or configure passwordless sudo for wg and ip.",
        command: `${sudo} -v`,
        details: { stderr: text.trim().slice(0, 500) }
      });
    }
    throw error;
  }
}
function detectLanAddress() {
  const candidates = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      const octets = address.address.split(".").map(Number);
      let score = 0;
      if (octets[0] === 192 && octets[1] === 168) score += 50;
      else if (octets[0] === 10) score += 40;
      else if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) score += 35;
      else if (octets[0] === 169 && octets[1] === 254) score -= 100;
      else score += 10;
      if (/(wi-?fi|wlan|ethernet|eth|en\d)/i.test(name)) score += 12;
      if (/(vEthernet|VirtualBox|VMware|Hyper-V|WSL|docker|br-|veth|tun|tap|Tailscale|ZeroTier|WireGuard)/i.test(name)) score -= 60;
      candidates.push({ address: address.address, interfaceName: name, score });
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.address.localeCompare(right.address));
  return candidates[0] ?? null;
}
function detectGlobalIpv6() {
  const candidates = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      const family = address.family === "IPv6" || address.family === 6;
      if (!family || address.internal) continue;
      const host = address.address.split("%")[0];
      if (host === "::1" || /^fe80:/i.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host)) continue;
      if (/(docker|br-|veth|tun|tap|VirtualBox|VMware|Hyper-V)/i.test(name)) continue;
      candidates.push(host);
    }
  }
  return candidates.find((host) => host.length > 0) ?? null;
}
function localHostname() {
  const value = osHostname().replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return value || "this-device";
}

// src/lib/installer.ts
var WINDOWS_INSTALLER_URL = "https://download.wireguard.com/windows-client/wireguard-installer.exe";
var WINDOWS_INSTALLER_MAX_BYTES = 128 * 1024 * 1024;
var INSTALL_TIMEOUT_MS = 18e4;
var LINUX_MANAGERS = [
  { name: "apt-get", args: ["install", "-y", "wireguard", "iproute2"], env: { DEBIAN_FRONTEND: "noninteractive" } },
  { name: "dnf", args: ["install", "-y", "wireguard-tools"] },
  { name: "yum", args: ["install", "-y", "wireguard-tools"] },
  { name: "pacman", args: ["-S", "--noconfirm", "wireguard-tools"] },
  { name: "zypper", args: ["--non-interactive", "install", "wireguard-tools"] },
  { name: "apk", args: ["add", "wireguard-tools"] }
];
async function download(url, target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INSTALL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "dsh-wireguard/0.2" }
    });
    if (!response.ok || !response.body) {
      throw new WireGuardError("download_failed", `WireGuard installer download failed with HTTP ${response.status}.`, {
        status: 502,
        hint: "Check the machine\u2019s internet access, or download the installer manually from https://www.wireguard.com/install/."
      });
    }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > WINDOWS_INSTALLER_MAX_BYTES) {
      throw new WireGuardError("download_failed", "The WireGuard installer is unexpectedly large.", { status: 502 });
    }
    await mkdir(path2.dirname(target), { recursive: true });
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target, { mode: 448 }));
  } catch (error) {
    if (error instanceof WireGuardError) throw error;
    throw new WireGuardError("download_failed", "Could not download the WireGuard installer.", {
      status: 502,
      hint: "Check internet access, proxy settings, then retry. You can also install WireGuard manually and press Recheck.",
      details: { cause: error instanceof Error ? error.message : String(error) }
    });
  } finally {
    clearTimeout(timer);
  }
}
async function waitForTools() {
  let latest = await detectPlatform();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (latest.wg && (!latest.isWindows || latest.wireguard)) return latest;
    await delay(500);
    latest = await detectPlatform();
  }
  return latest;
}
async function installWindows(platform, dataDir, log) {
  const installerPath = path2.join(dataDir, "wireguard-installer.exe");
  try {
    log(`downloading WireGuard installer to ${installerPath}`);
    await download(WINDOWS_INSTALLER_URL, installerPath);
  } catch (downloadError) {
    const winget = findExecutable("winget");
    if (!winget) throw downloadError;
    log("official installer download failed; trying winget");
    try {
      await run(winget, [
        "install",
        "--id",
        "WireGuard.WireGuard",
        "-e",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements"
      ], { timeout: INSTALL_TIMEOUT_MS });
      const installed = await waitForTools();
      if (installed.wg && installed.wireguard) {
        return { method: "winget", message: "WireGuard installed with winget." };
      }
    } catch (wingetError) {
      log(`winget fallback failed: ${wingetError instanceof Error ? wingetError.message : String(wingetError)}`);
    }
    throw downloadError;
  }
  if (platform.admin) {
    try {
      await run(installerPath, ["/S"], { timeout: INSTALL_TIMEOUT_MS });
      log("WireGuard installer completed silently");
    } catch (error) {
      throw new WireGuardError("install_failed", "The WireGuard installer exited with an error.", {
        status: 500,
        hint: "Run the downloaded installer manually, or install WireGuard from the official website and press Recheck.",
        command: `"${installerPath}" /S`,
        details: { cause: error instanceof Error ? error.message : String(error) }
      });
    }
  } else {
    const script = `$p = Start-Process -FilePath '${installerPath.replace(/'/g, "''")}' -ArgumentList '/S' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
    try {
      await run("powershell.exe", ["-NoProfile", "-Command", script], { timeout: INSTALL_TIMEOUT_MS });
      log("WireGuard installer accepted the UAC prompt");
    } catch (error) {
      throw new WireGuardError("needs_privilege", "The WireGuard installer needs administrator approval.", {
        status: 403,
        hint: "Approve the Windows UAC prompt, or close Harness and start it as administrator. The installer was downloaded and can also be run manually.",
        command: `"${installerPath}" /S`,
        details: { cause: error instanceof Error ? error.message : String(error) }
      });
    }
  }
  const latest = await waitForTools();
  if (!latest.wg || !latest.wireguard) {
    throw new WireGuardError("install_incomplete", "The WireGuard installer finished, but the tools were not detected yet.", {
      status: 503,
      hint: "Restart Harness (or press Recheck after a few seconds). The official installer is in the plugin data directory.",
      command: `"${installerPath}"`,
      details: { installerPath }
    });
  }
  return { method: "windows", message: "WireGuard for Windows installed.", installerPath };
}
async function installLinux(platform, log) {
  const managerEntry = LINUX_MANAGERS.map((candidate) => ({ candidate, executable: findExecutable(candidate.name) })).find((entry) => entry.executable);
  if (!managerEntry || !managerEntry.executable) {
    throw new WireGuardError("no_package_manager", "No supported package manager was found for automatic installation.", {
      status: 503,
      hint: "Install WireGuard manually: sudo apt install wireguard iproute2 (or the equivalent for this distribution), then press Recheck."
    });
  }
  const manager = managerEntry.candidate;
  const executable = managerEntry.executable;
  const command = `${manager.name} ${manager.args.join(" ")}`;
  log(`installing WireGuard with ${command}`);
  try {
    if (platform.admin) {
      await run(executable, manager.args, { timeout: INSTALL_TIMEOUT_MS, env: manager.env });
    } else if (platform.sudo) {
      await run(platform.sudo, ["-n", executable, ...manager.args], {
        timeout: INSTALL_TIMEOUT_MS,
        env: manager.env
      });
    } else {
      throw new WireGuardError("needs_privilege", "Installing WireGuard needs administrator rights.", {
        status: 403,
        hint: "Run the command below in a terminal, then press Recheck.",
        command: `sudo ${command}`
      });
    }
  } catch (error) {
    if (error instanceof WireGuardError && !platform.sudo) throw error;
    const text = error instanceof Error ? `${error.message}` : String(error);
    if (platform.admin || !/password|terminal|permission|not allowed|access is denied/i.test(text)) {
      throw new WireGuardError("install_failed", "The package manager could not install WireGuard.", {
        status: 500,
        hint: "Check internet access and package-manager output, or run the command below in a terminal.",
        command: `sudo ${command}`,
        details: { cause: text }
      });
    }
    const pkexec = findExecutable("pkexec", ["/usr/bin/pkexec"]);
    if (pkexec) {
      try {
        await run(pkexec, [executable, ...manager.args], { timeout: INSTALL_TIMEOUT_MS, env: manager.env });
        log("WireGuard package installation accepted by polkit");
      } catch (polkitError) {
        throw new WireGuardError("needs_privilege", "Installing WireGuard needs administrator rights.", {
          status: 403,
          hint: "Run the command below in a terminal, then press Recheck. For unattended use, run Harness as root or allow passwordless sudo for the package manager.",
          command: `sudo ${command}`,
          details: { cause: polkitError instanceof Error ? polkitError.message : String(polkitError) }
        });
      }
    } else {
      throw new WireGuardError("needs_privilege", "Installing WireGuard needs administrator rights.", {
        status: 403,
        hint: "Run the command below in a terminal, then press Recheck.",
        command: `sudo ${command}`,
        details: { cause: error instanceof Error ? error.message : String(error) }
      });
    }
  }
  const latest = await waitForTools();
  if (!latest.wg || !latest.ip) {
    throw new WireGuardError("install_incomplete", "The package manager finished, but WireGuard tools were not detected yet.", {
      status: 503,
      hint: "Install the missing package or restart Harness, then press Recheck.",
      command: `sudo ${command}`
    });
  }
  return { method: manager.name, message: `WireGuard tools installed with ${manager.name}.`, command: `sudo ${command}` };
}
async function installWireGuard(platform, dataDir, log) {
  if (platform.wg && (!platform.isWindows || platform.wireguard)) {
    return { method: "already-installed", message: "WireGuard is already installed." };
  }
  if (platform.isWindows) return installWindows(platform, dataDir, log);
  if (platform.isLinux) return installLinux(platform, log);
  throw new WireGuardError("unsupported_platform", "Automatic installation is supported on Windows and Linux only.", {
    status: 503,
    hint: `This host reports ${platform.platform}.`
  });
}

// src/lib/keys.ts
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
var KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
function base64urlToBase64(value) {
  return value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
}
var X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
function normalizeKey(value) {
  if (typeof value !== "string") return null;
  let text = value.trim();
  if (/^[A-Za-z0-9+/]{43}$/.test(text)) text += "=";
  if (!KEY_PATTERN.test(text)) return null;
  const bytes = Buffer.from(text, "base64");
  if (bytes.length !== 32) return null;
  return bytes.toString("base64");
}
function generateKeyPair() {
  const pair = generateKeyPairSync("x25519");
  const privateJwk = pair.privateKey.export({ format: "jwk" });
  const publicJwk = pair.publicKey.export({ format: "jwk" });
  return {
    privateKey: base64urlToBase64(privateJwk.d),
    publicKey: base64urlToBase64(publicJwk.x)
  };
}
function publicKeyFromPrivate(privateKey) {
  const normalized = normalizeKey(privateKey);
  if (!normalized) throw new Error("Invalid WireGuard private key");
  const raw = Buffer.from(normalized, "base64");
  const key = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: "der",
    type: "pkcs8"
  });
  const publicJwk = createPublicKey(key).export({ format: "jwk" });
  return base64urlToBase64(publicJwk.x);
}
function keyFingerprint(publicKey) {
  const normalized = normalizeKey(publicKey);
  if (!normalized) return "";
  return `${normalized.slice(0, 6)}\u2026${normalized.slice(-6)}`;
}

// src/lib/ssh.ts
var SSH_USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;
function buildSshAuthorizeCommand(user, publicKey) {
  const parts = publicKey.trim().split(/\s+/);
  const key = parts.slice(0, 2).join(" ");
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(key)) {
    throw new Error("Unexpected SSH public key format.");
  }
  return `u='${user}'; h=$(awk -F: -v u="$u" '$1==u{print $6; exit}' /etc/passwd); [ -n "$h" ] || { echo "No such user: $u" >&2; exit 1; }; S=""; [ "$(id -u)" -ne 0 ] && S="sudo"; $S sh -c 'mkdir -p "$1/.ssh" && chmod 700 "$1/.ssh" && touch "$1/.ssh/authorized_keys" && { grep -qxF "$2" "$1/.ssh/authorized_keys" || printf "%s\\n" "$2" >> "$1/.ssh/authorized_keys"; } && chown -R "$3" "$1/.ssh" && chmod 600 "$1/.ssh/authorized_keys"' sh "$h" '${key}' '${user}' && echo "SSH key installed for $u"`;
}
function buildWindowsSshAuthorizeCommand(user, publicKey) {
  const parts = publicKey.trim().split(/\s+/);
  const key = parts.slice(0, 2).join(" ");
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(key)) {
    throw new Error("Unexpected SSH public key format.");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(user)) {
    throw new Error("Unexpected Windows username.");
  }
  const quote = (value) => value.replace(/'/g, "''");
  const script = `$ErrorActionPreference = 'Stop'
$key = '${quote(key)}'
$user = '${quote(user)}'
$admin = Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'
$userFile = Join-Path (Join-Path 'C:\\Users' $user) '.ssh\\authorized_keys'
foreach ($path in @($admin, $userFile)) {
  New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
  if (-not (Test-Path $path)) { New-Item -ItemType File -Path $path | Out-Null }
  $lines = @(Get-Content $path -ErrorAction SilentlyContinue)
  if ($lines -notcontains $key) { Add-Content -Path $path -Value $key -Encoding ascii }
}
icacls $admin /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
Write-Output 'SSH public key installed for Windows user ' + $user`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

// src/lib/store.ts
import { chmod, mkdir as mkdir2, readFile, rename, rm, writeFile } from "node:fs/promises";
import path3 from "node:path";
function emptyState() {
  return {
    version: 1,
    role: "idle",
    settings: { ...DEFAULT_SETTINGS },
    server: {
      running: false,
      startedAt: null,
      publicKey: "",
      endpoint: null,
      endpointHost: null,
      controlUrl: null,
      controlPort: DEFAULT_SETTINGS.controlPort,
      listenPort: DEFAULT_SETTINGS.listenPort,
      vpnCidr: DEFAULT_SETTINGS.vpnCidr,
      interfaceName: DEFAULT_SETTINGS.interfaceName,
      mtu: DEFAULT_SETTINGS.mtu,
      dns: DEFAULT_SETTINGS.dns,
      peers: [],
      warnings: [],
      forwarding: null
    },
    client: {
      connected: false,
      pending: false,
      publicKey: null,
      name: null,
      serverUrl: null,
      serverHost: null,
      assignedIp: null,
      serverPublicKey: null,
      vpnCidr: null,
      endpoint: null,
      interfaceName: null,
      mtu: DEFAULT_SETTINGS.mtu,
      joinCode: null,
      connectedAt: null,
      lastHandshakeAt: null,
      receivedBytes: 0,
      sentBytes: 0,
      lastError: null,
      warnings: []
    },
    lastError: null,
    logs: [],
    updatedAt: null
  };
}
function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const source = (
    /** @type {Record<string, any>} */
    raw
  );
  const state = base;
  if (source.role === "server" || source.role === "client") state.role = source.role;
  if (source.settings && typeof source.settings === "object") state.settings = { ...base.settings, ...source.settings };
  if (source.server && typeof source.server === "object") {
    const server = source.server;
    state.server = {
      ...base.server,
      running: server.running === true,
      startedAt: typeof server.startedAt === "string" ? server.startedAt : null,
      publicKey: normalizeKey(server.publicKey) ?? "",
      endpoint: typeof server.endpoint === "string" ? server.endpoint : null,
      endpointHost: typeof server.endpointHost === "string" ? server.endpointHost : null,
      controlUrl: typeof server.controlUrl === "string" ? server.controlUrl : null,
      controlPort: Number.isInteger(server.controlPort) ? server.controlPort : base.server.controlPort,
      listenPort: Number.isInteger(server.listenPort) ? server.listenPort : base.server.listenPort,
      vpnCidr: typeof server.vpnCidr === "string" ? server.vpnCidr : base.server.vpnCidr,
      interfaceName: typeof server.interfaceName === "string" ? server.interfaceName : base.server.interfaceName,
      mtu: Number.isInteger(server.mtu) ? server.mtu : base.server.mtu,
      dns: typeof server.dns === "string" ? server.dns : base.server.dns,
      peers: Array.isArray(server.peers) ? server.peers.filter((peer) => peer && typeof peer === "object" && typeof peer.publicKey === "string").slice(0, 1024) : [],
      warnings: Array.isArray(server.warnings) ? server.warnings.filter((item) => typeof item === "string").slice(0, 20) : [],
      forwarding: typeof server.forwarding === "boolean" ? server.forwarding : null
    };
  }
  if (source.client && typeof source.client === "object") {
    const client = source.client;
    state.client = {
      ...base.client,
      connected: client.connected === true,
      pending: client.pending === true,
      publicKey: normalizeKey(client.publicKey) ?? null,
      name: typeof client.name === "string" ? client.name : null,
      serverUrl: typeof client.serverUrl === "string" ? client.serverUrl : null,
      serverHost: typeof client.serverHost === "string" ? client.serverHost : null,
      assignedIp: typeof client.assignedIp === "string" ? client.assignedIp : null,
      serverPublicKey: normalizeKey(client.serverPublicKey) ?? null,
      vpnCidr: typeof client.vpnCidr === "string" ? client.vpnCidr : null,
      endpoint: typeof client.endpoint === "string" ? client.endpoint : null,
      interfaceName: typeof client.interfaceName === "string" ? client.interfaceName : null,
      mtu: Number.isInteger(client.mtu) ? client.mtu : base.client.mtu,
      joinCode: typeof client.joinCode === "string" ? client.joinCode : null,
      connectedAt: typeof client.connectedAt === "string" ? client.connectedAt : null,
      lastHandshakeAt: typeof client.lastHandshakeAt === "string" ? client.lastHandshakeAt : null,
      receivedBytes: Number.isSafeInteger(client.receivedBytes) ? client.receivedBytes : 0,
      sentBytes: Number.isSafeInteger(client.sentBytes) ? client.sentBytes : 0,
      lastError: typeof client.lastError === "string" ? client.lastError : null,
      warnings: Array.isArray(client.warnings) ? client.warnings.filter((item) => typeof item === "string").slice(0, 20) : []
    };
  }
  state.lastError = typeof source.lastError === "string" ? source.lastError : null;
  state.logs = Array.isArray(source.logs) ? source.logs.filter((item) => typeof item === "string").slice(-40) : [];
  state.updatedAt = typeof source.updatedAt === "string" ? source.updatedAt : null;
  return state;
}
var Store = class {
  dataDir;
  statePath;
  state;
  existed;
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.statePath = path3.join(dataDir, "state.json");
    this.state = emptyState();
    this.existed = false;
  }
  async init() {
    await mkdir2(this.dataDir, { recursive: true, mode: 448 });
    try {
      await chmod(this.dataDir, 448);
    } catch {
    }
    this.state = await this.load();
  }
  /**
   * @returns {Promise<ReturnType<typeof emptyState>>} loaded state.
   */
  async load() {
    try {
      const text = await readFile(this.statePath, "utf8");
      const state = normalizeState(JSON.parse(text));
      this.existed = true;
      return state;
    } catch (error) {
      if (error && /** @type {NodeJS.ErrnoException} */
      error.code === "ENOENT") return emptyState();
      try {
        await rename(this.statePath, `${this.statePath}.corrupt-${Date.now()}`);
      } catch {
      }
      return emptyState();
    }
  }
  /**
   * Persist the complete non-secret state atomically.
   * @param {ReturnType<typeof emptyState>} state state to write.
   * @returns {Promise<void>}
   */
  async save(state) {
    state.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.state = state;
    const temporary = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}
`, { encoding: "utf8", mode: 384 });
    await rename(temporary, this.statePath);
    try {
      await chmod(this.statePath, 384);
    } catch {
    }
  }
  /**
   * Read a stored private key, or create and persist a new one.
   * @param {'server' | 'client'} role key owner.
   * @returns {Promise<{ privateKey: string, publicKey: string, privateKeyPath: string }>}
   */
  async ensureKey(role) {
    const privateKeyPath = path3.join(this.dataDir, `${role}.key`);
    try {
      const stored = await readFile(privateKeyPath, "utf8");
      const normalized = normalizeKey(stored);
      if (normalized) {
        try {
          await chmod(privateKeyPath, 384);
        } catch {
        }
        return { privateKey: normalized, publicKey: publicKeyFromPrivate(normalized), privateKeyPath };
      }
    } catch (error) {
      if (!error || /** @type {NodeJS.ErrnoException} */
      error.code !== "ENOENT") {
        try {
          await rename(privateKeyPath, `${privateKeyPath}.corrupt-${Date.now()}`);
        } catch {
        }
      }
    }
    const pair = generateKeyPair();
    await writeFile(privateKeyPath, `${pair.privateKey}
`, { encoding: "utf8", mode: 384 });
    try {
      await chmod(privateKeyPath, 384);
    } catch {
    }
    return { ...pair, privateKeyPath };
  }
  /**
   * Config path. Windows names the tunnel after the config file, so the file
   * must carry the requested interface name there; Linux never uses the path
   * as an interface identity.
   * @param {'server' | 'client'} role config owner.
   * @param {string | null} [interfaceName] Windows tunnel name.
   * @param {boolean} [windows] whether the host is Windows.
   * @returns {string} absolute config path.
   */
  configPath(role, interfaceName = null, windows = false) {
    if (windows && interfaceName) return path3.join(this.dataDir, `${interfaceName}.conf`);
    return path3.join(this.dataDir, `${role}.conf`);
  }
  /**
   * @param {'server' | 'client'} role config owner.
   * @param {string} text complete configuration.
   * @param {string | null} [interfaceName] Windows tunnel name.
   * @param {boolean} [windows] whether the host is Windows.
   * @returns {Promise<void>}
   */
  async writeConfig(role, text, interfaceName = null, windows = false) {
    const target = this.configPath(role, interfaceName, windows);
    await writeFile(target, text, { encoding: "utf8", mode: 384 });
    try {
      await chmod(target, 384);
    } catch {
    }
  }
  /**
   * @param {'server' | 'client'} role config owner.
   * @param {string | null} [interfaceName] Windows tunnel name.
   * @param {boolean} [windows] whether the host is Windows.
   * @returns {Promise<void>}
   */
  async removeConfig(role, interfaceName = null, windows = false) {
    try {
      await rm(this.configPath(role, interfaceName, windows), { force: true });
    } catch {
    }
  }
  /**
   * Append one bounded diagnostic line.
   * @param {ReturnType<typeof emptyState>} state state to mutate.
   * @param {string} line message.
   * @returns {void}
   */
  log(state, line) {
    const stamp = (/* @__PURE__ */ new Date()).toISOString();
    state.logs.push(`${stamp} ${line}`);
    if (state.logs.length > 40) state.logs.splice(0, state.logs.length - 40);
  }
};

// src/lib/tunnel.ts
import { setTimeout as delay2 } from "node:timers/promises";
function parseWgDump(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return { publicKey: "", listenPort: null, peers: [] };
  const header = lines[0].split("	");
  const peers = [];
  for (const line of lines.slice(1)) {
    const columns = line.split("	");
    if (columns.length < 8) continue;
    const handshakeSeconds = Number(columns[4]) || 0;
    peers.push({
      publicKey: columns[0],
      endpoint: columns[2] && columns[2] !== "(none)" ? columns[2] : null,
      allowedIps: columns[3] ?? "",
      lastHandshakeAt: handshakeSeconds > 0 ? new Date(handshakeSeconds * 1e3).toISOString() : null,
      online: handshakeSeconds > 0 && Date.now() - handshakeSeconds * 1e3 < 18e4,
      receivedBytes: Number(columns[5]) || 0,
      sentBytes: Number(columns[6]) || 0,
      persistentKeepalive: Number(columns[7]) === 0 ? null : Number(columns[7])
    });
  }
  return {
    publicKey: header[1] ?? "",
    listenPort: header[2] ? Number(header[2]) : null,
    peers
  };
}
var Tunnel = class {
  platform;
  log;
  constructor(options) {
    this.platform = options.platform;
    this.log = options.log ?? (() => {
    });
  }
  requireWg() {
    if (!this.platform.wg) {
      throw new WireGuardError("missing_wireguard", "The WireGuard command-line tool `wg` was not found.", {
        status: 503,
        hint: this.platform.isWindows ? "Install the official WireGuard client from https://www.wireguard.com/install/ and restart Harness." : "Install WireGuard tools, for example: sudo apt install wireguard iproute2"
      });
    }
  }
  /** @returns {void} */
  requireLinuxIp() {
    if (this.platform.isLinux && !this.platform.ip) {
      throw new WireGuardError("missing_tool", "The `ip` command was not found.", {
        status: 503,
        hint: "Install iproute2, for example: sudo apt install iproute2"
      });
    }
  }
  /** @returns {void} */
  requireWindowsWireGuard() {
    if (this.platform.isWindows && !this.platform.wireguard) {
      throw new WireGuardError("missing_wireguard", "The official WireGuard client was not found.", {
        status: 503,
        hint: "Install it from https://www.wireguard.com/install/ and restart Harness."
      });
    }
  }
  /**
   * Remove an interface, tolerating an absent device.
   * @param {string} interfaceName tunnel name.
   * @returns {Promise<void>}
   */
  async down(interfaceName) {
    this.requireWg();
    if (this.platform.isWindows) {
      this.requireWindowsWireGuard();
      try {
        await runPrivileged(this.platform.wireguard, ["/uninstalltunnelservice", interfaceName], { platform: this.platform, timeout: 2e4 });
      } catch (error) {
        const text = error instanceof CommandError ? `${error.message} ${error.stderr}` : String(error);
        if (/not installed|does not exist|cannot find|no such|not found|找不到|指定的服务/i.test(text)) return;
        throw error;
      }
      return;
    }
    this.requireLinuxIp();
    try {
      await runPrivileged(this.platform.ip, ["link", "delete", "dev", interfaceName], { platform: this.platform, timeout: 15e3 });
    } catch (error) {
      const text = error instanceof CommandError ? `${error.message} ${error.stderr}` : String(error);
      if (/Cannot find device|does not exist|找不到/i.test(text)) return;
      throw error;
    }
  }
  /**
   * Create and configure the server interface.
   * @param {{ interfaceName: string, privateKeyPath: string, settings: Record<string, unknown>, cidr: { prefix: number }, peers: readonly { publicKey: string, ip: string }[], configPath: string }} input
   * @returns {Promise<{ warnings: string[] }>} non-fatal forwarding warnings.
   */
  async upServer(input) {
    this.requireWg();
    this.requireLinuxIp();
    this.requireWindowsWireGuard();
    await this.down(input.interfaceName);
    const warnings = [];
    try {
      if (this.platform.isWindows) {
        await runPrivileged(this.platform.wireguard, ["/installtunnelservice", input.configPath], { platform: this.platform, timeout: 3e4 });
        await this.waitForUp(input.interfaceName);
        for (const peer of input.peers) await this.addPeer(input.interfaceName, peer);
      } else {
        await runPrivileged(this.platform.ip, ["link", "add", "dev", input.interfaceName, "type", "wireguard"], { platform: this.platform });
        await runPrivileged(this.platform.wg, ["set", input.interfaceName, "private-key", input.privateKeyPath, "listen-port", String(input.settings.listenPort)], { platform: this.platform });
        await runPrivileged(this.platform.ip, ["address", "add", `${input.settings.serverIp}/${input.cidr.prefix}`, "dev", input.interfaceName], { platform: this.platform });
        await runPrivileged(this.platform.ip, ["link", "set", "mtu", String(input.settings.mtu), "up", "dev", input.interfaceName], { platform: this.platform });
        for (const peer of input.peers) await this.addPeer(input.interfaceName, peer);
      }
      const forwarding = await this.enableForwarding(input.interfaceName);
      warnings.push(...forwarding.warnings);
    } catch (error) {
      try {
        await this.down(input.interfaceName);
      } catch {
      }
      throw this.describe(error);
    }
    return { warnings };
  }
  /**
   * Create and configure the client interface.
   * @param {{ interfaceName: string, privateKeyPath: string, address: string, settings: Record<string, unknown>, vpnCidr: string, serverPublicKey: string, endpoint: string, configPath: string }} input
   * @returns {Promise<void>}
   */
  async upClient(input) {
    this.requireWg();
    this.requireLinuxIp();
    this.requireWindowsWireGuard();
    await this.down(input.interfaceName);
    try {
      if (this.platform.isWindows) {
        await runPrivileged(this.platform.wireguard, ["/installtunnelservice", input.configPath], { platform: this.platform, timeout: 3e4 });
        await this.waitForUp(input.interfaceName);
        return;
      }
      await runPrivileged(this.platform.ip, ["link", "add", "dev", input.interfaceName, "type", "wireguard"], { platform: this.platform });
      await runPrivileged(this.platform.wg, ["set", input.interfaceName, "private-key", input.privateKeyPath], { platform: this.platform });
      await runPrivileged(this.platform.ip, ["address", "add", `${input.address}/32`, "dev", input.interfaceName], { platform: this.platform });
      await runPrivileged(this.platform.ip, ["link", "set", "mtu", String(input.settings.mtu), "up", "dev", input.interfaceName], { platform: this.platform });
      await runPrivileged(this.platform.ip, ["route", "replace", input.vpnCidr, "dev", input.interfaceName], { platform: this.platform });
      await runPrivileged(this.platform.wg, ["set", input.interfaceName, "peer", input.serverPublicKey, "allowed-ips", input.vpnCidr, "endpoint", input.endpoint, "persistent-keepalive", "25"], { platform: this.platform });
    } catch (error) {
      try {
        await this.down(input.interfaceName);
      } catch {
      }
      throw this.describe(error);
    }
  }
  /**
   * Add or update one peer on a live interface.
   * @param {string} interfaceName tunnel name.
   * @param {{ publicKey: string, ip: string }} peer peer identity.
   * @returns {Promise<void>}
   */
  async addPeer(interfaceName, peer) {
    this.requireWg();
    await runPrivileged(this.platform.wg, ["set", interfaceName, "peer", peer.publicKey, "allowed-ips", `${peer.ip}/32`], { platform: this.platform, timeout: 15e3 });
  }
  /**
   * Remove one peer from a live interface.
   * @param {string} interfaceName tunnel name.
   * @param {string} publicKey peer public key.
   * @returns {Promise<void>}
   */
  async removePeer(interfaceName, publicKey) {
    this.requireWg();
    await runPrivileged(this.platform.wg, ["set", interfaceName, "peer", publicKey, "remove"], { platform: this.platform, timeout: 15e3 });
  }
  /**
   * Read live interface state. This never throws for an absent or unauthorized
   * interface; callers surface the diagnostic instead.
   * @param {string} interfaceName tunnel name.
   * @returns {Promise<{ up: boolean, publicKey: string, listenPort: number | null, peers: Array<Record<string, unknown>>, error?: string, privilege?: boolean }>}
   */
  async status(interfaceName) {
    if (!this.platform.wg) {
      return { up: false, publicKey: "", listenPort: null, peers: [], error: "WireGuard tools are not installed." };
    }
    try {
      const { stdout } = await runPrivileged(this.platform.wg, ["show", interfaceName, "dump"], { platform: this.platform, timeout: 1e4 });
      return { up: true, ...parseWgDump(stdout) };
    } catch (error) {
      if (error instanceof WireGuardError) {
        return { up: false, publicKey: "", listenPort: null, peers: [], error: error.message, privilege: true };
      }
      const text = error instanceof CommandError ? `${error.stderr} ${error.stdout}` : String(error);
      return { up: false, publicKey: "", listenPort: null, peers: [], error: text.trim().slice(0, 400) || "Interface is not running." };
    }
  }
  /**
   * Poll briefly until the Windows tunnel service is queryable.
   * @param {string} interfaceName tunnel name.
   * @returns {Promise<void>}
   */
  async waitForUp(interfaceName) {
    if (!this.platform.isWindows) return;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const status = await this.status(interfaceName);
      if (status.up) return;
      if (status.privilege) return;
      await delay2(500);
    }
    throw new WireGuardError("interface_error", "The WireGuard tunnel service started but did not become queryable.", {
      status: 500,
      hint: "Open the WireGuard app, check its log, and retry. Windows may need a moment after the first install."
    });
  }
  /**
   * Best-effort IPv4 forwarding and peer-to-peer firewall admission.
   * @param {string} interfaceName tunnel name.
   * @returns {Promise<{ warnings: string[] }>}
   */
  async enableForwarding(interfaceName) {
    const warnings = [];
    if (this.platform.isWindows) {
      try {
        await runPrivileged("netsh.exe", ["interface", "ipv4", "set", "interface", interfaceName, "forwarding=enabled"], { platform: this.platform, timeout: 1e4 });
      } catch (error) {
        warnings.push(`Windows IP forwarding could not be enabled automatically: ${error instanceof Error ? error.message : String(error)}`);
      }
      warnings.push("Windows server mode: clients can reach the server, but client-to-client access may require Windows routing configuration. A Linux server is recommended.");
      return { warnings };
    }
    if (this.platform.sysctl) {
      try {
        await runPrivileged(this.platform.sysctl, ["-w", "net.ipv4.ip_forward=1"], { platform: this.platform, timeout: 1e4 });
      } catch (error) {
        warnings.push(`Could not enable net.ipv4.ip_forward: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (this.platform.iptables) {
      try {
        try {
          await runPrivileged(this.platform.iptables, ["-C", "FORWARD", "-i", interfaceName, "-o", interfaceName, "-j", "ACCEPT"], { platform: this.platform, timeout: 1e4 });
        } catch {
          await runPrivileged(this.platform.iptables, ["-A", "FORWARD", "-i", interfaceName, "-o", interfaceName, "-j", "ACCEPT"], { platform: this.platform, timeout: 1e4 });
        }
      } catch (error) {
        warnings.push(`Could not add a peer-to-peer FORWARD rule: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (this.platform.nft) {
      try {
        await runPrivileged(this.platform.nft, ["add", "rule", "ip", "filter", "FORWARD", "iifname", interfaceName, "oifname", interfaceName, "accept"], { platform: this.platform, timeout: 1e4 });
      } catch {
        warnings.push("nftables is present but no matching FORWARD rule could be added; client-to-client traffic may be blocked.");
      }
    }
    return { warnings };
  }
  /**
   * Turn an opaque command error into an actionable WireGuard error.
   * @param {unknown} error failure.
   * @returns {Error} normalized failure.
   */
  describe(error) {
    if (error instanceof WireGuardError) return error;
    const text = error instanceof CommandError ? `${error.message} ${error.stderr}` : String(error);
    if (/operation not permitted|permission denied|access is denied|requires elevation/i.test(text)) {
      return new WireGuardError("needs_privilege", "WireGuard needs administrator rights to change the network interface.", {
        status: 403,
        hint: this.platform.isWindows ? "Close Harness and start it again with \u201CRun as administrator\u201D, then retry." : "Run Harness as root, or configure passwordless sudo for wg and ip, then retry.",
        details: { stderr: text.trim().slice(0, 500) }
      });
    }
    if (/unknown device type|wireguard.*not found|module.*not found|protocol not supported/i.test(text)) {
      return new WireGuardError("wireguard_unavailable", "The WireGuard kernel interface is unavailable.", {
        status: 503,
        hint: this.platform.isLinux ? "Load the kernel module with `sudo modprobe wireguard`, or install a WireGuard-enabled kernel." : void 0,
        details: { stderr: text.trim().slice(0, 500) }
      });
    }
    return new WireGuardError("interface_error", "Could not configure the WireGuard interface.", {
      status: 500,
      details: { stderr: text.trim().slice(0, 500) }
    });
  }
};

// src/lib/service.ts
var execFileAsync = promisify(execFile2);
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function integerOr(value, fallback) {
  return Number.isSafeInteger(value) ? value : fallback;
}
var WireGuardService = class {
  config;
  store;
  state;
  platformFactory;
  tunnelFactory;
  fetchImpl;
  now;
  logger;
  control;
  controlExtraHandler;
  platform;
  tunnel;
  platformAt;
  lock;
  constructor(options) {
    this.config = options.config ?? {};
    this.store = new Store(options.dataDir);
    this.state = this.store.state;
    this.platformFactory = options.platformFactory ?? detectPlatform;
    this.tunnelFactory = options.tunnelFactory ?? ((platform) => new Tunnel({ platform, log: (line) => this.#log(line) }));
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.log ?? ((line) => console.log(`[dsh-wireguard] ${line}`));
    this.control = null;
    this.controlExtraHandler = null;
    this.platform = null;
    this.tunnel = null;
    this.platformAt = 0;
    this.lock = Promise.resolve();
  }
  /** Load state, resolve tools, and reconcile a tunnel left by a previous run. */
  async init() {
    await this.store.init();
    this.state = this.store.state;
    const configured = this.store.existed ? { ...this.config, ...this.state.settings } : { ...this.config };
    try {
      const { settings } = normalizeSettings(configured, this.state.settings);
      this.state.settings = settings;
    } catch (error) {
      this.#recordError(error);
      this.state.settings = { ...this.state.settings, ...emptyState().settings };
    }
    if (!this.state.settings.joinCode) {
      this.state.settings.joinCode = generateJoinCode();
      this.#log("generated a random join code for the control panel");
    }
    try {
      await this.#detect(true);
    } catch (error) {
      this.#recordError(error);
    }
    try {
      await this.#reconcile();
    } catch (error) {
      this.#recordError(error);
    }
    try {
      await this.#persist();
    } catch (error) {
      this.#log(`could not persist initial state: ${errorMessage(error)}`);
    }
  }
  /**
   * Serialize mutations; WireGuard and the control panel share one state file.
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  async #serialized(operation) {
    const previous = this.lock;
    let release;
    this.lock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
  /**
   * Re-detect tools and privilege, with a short cache for repeated panel reads.
   * @param {boolean} force
   * @returns {Promise<void>}
   */
  async #detect(force) {
    if (!force && this.platform && this.now() - this.platformAt < 15e3) return;
    const platform = await this.platformFactory();
    this.platform = platform;
    this.tunnel = this.tunnelFactory(platform);
    this.platformAt = this.now();
  }
  /** @returns {void} */
  #requirePlatform() {
    if (!this.platform) {
      throw new WireGuardError("unsupported_platform", "WireGuard is supported on Windows and Linux only.", {
        status: 503,
        hint: `This host reports ${process.platform}.`
      });
    }
  }
  /** @returns {void} */
  #requireServerTools() {
    this.#requirePlatform();
    if (!this.platform.wg) {
      throw new WireGuardError("missing_wireguard", "The WireGuard command-line tool `wg` was not found.", {
        status: 503,
        hint: missingToolHint("wg", this.platform.platform)
      });
    }
    if (this.platform.isLinux && !this.platform.ip) {
      throw new WireGuardError("missing_tool", "The `ip` command was not found.", {
        status: 503,
        hint: "Install iproute2, for example: sudo apt install iproute2"
      });
    }
    if (this.platform.isWindows && !this.platform.wireguard) {
      throw new WireGuardError("missing_wireguard", "The official WireGuard client was not found.", {
        status: 503,
        hint: missingToolHint("wireguard", this.platform.platform)
      });
    }
  }
  /** @returns {void} */
  #requireClientTools() {
    this.#requireServerTools();
  }
  /**
   * Save state and keep the in-memory instance authoritative.
   * @returns {Promise<void>}
   */
  async #persist() {
    await this.store.save(this.state);
  }
  /**
   * Append one bounded diagnostic line.
   * @param {string} line message.
   * @returns {void}
   */
  #log(line) {
    const stamped = `${(/* @__PURE__ */ new Date()).toISOString()} ${line}`;
    this.state.logs.push(stamped);
    if (this.state.logs.length > 40) this.state.logs.splice(0, this.state.logs.length - 40);
    try {
      this.logger(stamped);
    } catch {
    }
  }
  /**
   * @param {unknown} error
   * @returns {void}
   */
  #recordError(error) {
    this.state.lastError = errorMessage(error);
    this.#log(`error: ${errorMessage(error)}`);
  }
  /**
   * Start the LAN control panel for the running server.
   * @returns {Promise<void>}
   */
  async #startControl(force = false) {
    if (!force && this.config.externalControlPanel === true) {
      this.#log("control panel is owned by an external service");
      return;
    }
    if (this.control) await this.control.stop();
    const panel = new ControlPanel({
      getServerInfo: () => this.#controlInfo(),
      getPeers: () => this.#publicPeers(),
      getAccessCode: () => this.state.settings.joinCode,
      onJoin: (body, remoteAddress) => this.joinPeer(body, remoteAddress),
      onLeave: (body, remoteAddress) => this.leavePeer(body, remoteAddress),
      extraHandler: this.controlExtraHandler,
      log: (line) => this.#log(line)
    });
    await panel.start(this.state.server.controlPort, "::");
    this.control = panel;
  }
  /**
   * Install an additional HTTP handler on the control-panel listener. The
   * standalone control service uses this to serve the same panel API that the
   * DSH host API normally serves.
   * @param {((request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<boolean> | boolean) | null} handler handler.
   * @returns {void}
   */
  setControlExtraHandler(handler2) {
    this.controlExtraHandler = handler2;
  }
  /**
   * Start the control panel explicitly, even when `externalControlPanel` is
   * true. Used by the standalone control service, not by the DSH plugin.
   * @returns {Promise<Record<string, unknown>>} state snapshot.
   */
  async startControlPanel() {
    return this.#serialized(async () => {
      await this.#startControl(true);
      return this.snapshot();
    });
  }
  /**
   * Rewrite the persisted server config after a peer change so a WireGuard
   * service restart (especially on Windows) starts with the current peers.
   * @returns {Promise<void>}
   */
  async #rewriteServerConfig() {
    if (!this.state.server.publicKey) return;
    const cidr = parseCidr(this.state.server.vpnCidr);
    if (!cidr) return;
    const key = await this.store.ensureKey("server");
    if (key.publicKey !== this.state.server.publicKey) {
      throw new Error("The stored server key no longer matches the running interface; restart the service to regenerate it.");
    }
    const settings = {
      ...this.state.settings,
      serverIp: this.state.settings.serverIp,
      listenPort: this.state.server.listenPort,
      mtu: this.state.server.mtu,
      interfaceName: this.state.server.interfaceName
    };
    const text = buildServerConfig({
      privateKey: key.privateKey,
      settings,
      cidr,
      peers: this.state.server.peers
    });
    await this.store.writeConfig("server", text, this.state.server.interfaceName, this.platform?.isWindows === true);
  }
  /**
   * Best-effort variant for peer mutations: a config rewrite must not undo an
   * already-applied live peer.
   * @returns {Promise<void>}
   */
  async #safeRewriteServerConfig() {
    try {
      await this.#rewriteServerConfig();
    } catch (error) {
      this.#log(`could not rewrite the server config: ${errorMessage(error)}`);
    }
  }
  /**
   * Advertised deployment targets for IPv4 and IPv6 clients. The VPN itself
   * remains IPv4; these are only the outer control/endpoint addresses.
   * @returns {{ ipv4: Record<string, unknown>, ipv6: Record<string, unknown> }} targets.
   */
  #deploymentTargets() {
    const controlPort = this.state.server.controlPort || this.state.settings.controlPort;
    const listenPort = this.state.server.listenPort || this.state.settings.listenPort;
    const configured = String(this.state.server.endpointHost ?? "").trim();
    const family = isIP2(configured);
    const ipv4Host = configured && family !== 6 ? configured : "";
    const detectedIpv6 = detectGlobalIpv6();
    const ipv6Host = family === 6 ? configured : detectedIpv6 || (family === 0 && configured ? configured : "");
    const target = (host) => {
      if (!host) return { available: false, controlUrl: null, endpoint: null };
      return {
        available: true,
        controlUrl: `http://${formatEndpointHost(host)}:${controlPort}`,
        endpoint: `${formatEndpointHost(host)}:${listenPort}`
      };
    };
    return { ipv4: target(ipv4Host), ipv6: target(ipv6Host) };
  }
  /** @returns {Record<string, unknown>} values the control panel may expose. */
  #controlInfo() {
    return {
      version: PLUGIN_VERSION,
      hostname: localHostname(),
      endpointHost: this.state.server.endpointHost,
      endpoint: this.state.server.endpoint,
      controlUrl: this.state.server.controlUrl,
      controlPort: this.state.server.controlPort,
      listenPort: this.state.server.listenPort,
      publicKey: this.state.server.publicKey,
      vpnCidr: this.state.server.vpnCidr,
      mtu: this.state.server.mtu,
      dns: this.state.server.dns,
      joinCode: this.state.settings.joinCode,
      joinRequired: Boolean(this.state.settings.joinCode),
      peerCount: this.state.server.peers.length
    };
  }
  /** @returns {Array<Record<string, unknown>>} peer list without public keys. */
  #publicPeers() {
    return this.state.server.peers.map((peer) => ({
      name: peer.name,
      ip: peer.ip,
      online: peer.online === true,
      lastHandshakeAt: peer.lastHandshakeAt ?? null
    }));
  }
  /**
   * Keep only peers that still belong to the current subnet.
   * @param {ReturnType<typeof parseCidr>} cidr parsed subnet.
   * @param {string} serverIp server address.
   * @returns {Array<Record<string, any>>} valid peers.
   */
  #validPeers(cidr, serverIp) {
    const seen = /* @__PURE__ */ new Set();
    const peers = [];
    for (const raw of this.state.server.peers) {
      if (!raw || typeof raw !== "object") continue;
      const publicKey = normalizeKey(raw.publicKey);
      const ipNumber = parseIpv4(raw.ip);
      if (!publicKey || ipNumber === null || !isUsableHost(ipNumber, cidr)) continue;
      const ip = ipv4ToString(ipNumber);
      if (ip === serverIp || seen.has(publicKey) || seen.has(ip)) continue;
      seen.add(publicKey);
      seen.add(ip);
      peers.push({
        publicKey,
        ip,
        name: normalizeDeviceName(raw.name, "client"),
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : (/* @__PURE__ */ new Date()).toISOString(),
        applied: raw.applied !== false,
        sshUser: typeof raw.sshUser === "string" && SSH_USER_PATTERN.test(raw.sshUser) ? raw.sshUser : null
      });
    }
    return peers;
  }
  /**
   * Reconcile persisted state with the live operating system after a restart.
   * @returns {Promise<void>}
   */
  async #reconcile() {
    if (!this.platform || !this.tunnel) return;
    if (this.state.server.running) {
      const status = await this.tunnel.status(this.state.server.interfaceName);
      if (status.up) {
        this.#mergeServerStatus(status);
        try {
          await this.#rewriteServerConfig();
        } catch (error) {
          this.#log(`could not rewrite the server config while reconciling: ${errorMessage(error)}`);
        }
        try {
          await this.#startControl();
        } catch (error) {
          this.#recordError(error);
          this.state.server.running = false;
          this.state.role = "idle";
          try {
            await this.tunnel.down(this.state.server.interfaceName);
          } catch {
          }
        }
      } else if (status.privilege) {
        this.state.server.warnings = [
          ...this.state.server.warnings,
          "The WireGuard interface exists, but Harness cannot read it without administrator rights."
        ];
        try {
          await this.#startControl();
        } catch (error) {
          this.#recordError(error);
        }
      } else {
        this.state.server.running = false;
        this.state.role = "idle";
        this.#recordError(`The saved WireGuard server is not running: ${status.error ?? "interface not found"}`);
      }
    }
    if (this.state.client.connected || this.state.client.pending) {
      if (!this.state.client.interfaceName) return;
      const status = await this.tunnel.status(this.state.client.interfaceName);
      if (status.up) {
        this.#mergeClientStatus(status);
        this.state.client.connected = true;
        this.state.client.pending = false;
      } else if (!status.privilege && this.state.client.connected) {
        this.state.client.connected = false;
        this.state.client.pending = true;
        this.state.client.lastError = "The WireGuard client tunnel stopped. Retry the connection.";
        this.#recordError(this.state.client.lastError);
      }
    }
  }
  /**
   * Start server mode.
   * @param {Record<string, unknown>} input Service-tab settings.
   * @returns {Promise<Record<string, unknown>>} updated snapshot.
   */
  async startServer(input) {
    return this.#serialized(async () => {
      if (this.state.server.running) throw new WireGuardError("already_running", "The WireGuard server is already running.", { status: 409 });
      if (this.state.client.connected || this.state.client.pending) {
        throw new WireGuardError("client_active", "Disconnect the client tunnel before starting server mode.", { status: 409 });
      }
      const { settings, cidr } = normalizeSettings(input, this.state.settings);
      if (!settings.joinCode) {
        settings.joinCode = generateJoinCode();
        this.#log("generated a new random join code for the control panel");
      }
      await this.#detect(false);
      this.#requireServerTools();
      const detected = detectLanAddress();
      const endpointHost = settings.endpointHost || detected?.address || "";
      if (!endpointHost) {
        throw new WireGuardError("no_lan_address", "No non-loopback IPv4 address was found for clients to reach.", {
          status: 400,
          hint: "Enter this machine\u2019s LAN address in the \u201CAdvertised address\u201D field."
        });
      }
      const normalizedHost = normalizeEndpointHost(endpointHost);
      const key = await this.store.ensureKey("server");
      const peers = this.#validPeers(cidr, settings.serverIp);
      const warnings = [];
      if (peers.length !== this.state.server.peers.length) warnings.push("Some saved peers were outside the new VPN subnet and were removed.");
      if (/^127\./.test(normalizedHost) || normalizedHost === "localhost") warnings.push("The advertised address is a loopback address; other devices cannot reach it.");
      const configText = buildServerConfig({
        privateKey: key.privateKey,
        settings,
        cidr,
        peers
      });
      await this.store.writeConfig("server", configText, settings.interfaceName, this.platform?.isWindows === true);
      this.state.settings = settings;
      this.state.server = {
        ...this.state.server,
        running: false,
        startedAt: null,
        publicKey: key.publicKey,
        endpoint: `${formatEndpointHost(normalizedHost)}:${settings.listenPort}`,
        endpointHost: normalizedHost,
        controlUrl: `http://${formatEndpointHost(normalizedHost)}:${settings.controlPort}`,
        controlPort: settings.controlPort,
        listenPort: settings.listenPort,
        vpnCidr: cidr.normalized,
        interfaceName: settings.interfaceName,
        mtu: settings.mtu,
        dns: settings.dns,
        peers,
        warnings,
        forwarding: null
      };
      try {
        const result = await this.tunnel.upServer({
          interfaceName: settings.interfaceName,
          privateKeyPath: key.privateKeyPath,
          settings,
          cidr,
          peers,
          configPath: this.store.configPath("server", settings.interfaceName, this.platform?.isWindows === true)
        });
        this.state.server.warnings.push(...result?.warnings ?? []);
      } catch (error) {
        this.#recordError(error);
        await this.#persist();
        throw error;
      }
      try {
        await this.#startControl();
      } catch (error) {
        try {
          await this.tunnel.down(settings.interfaceName);
        } catch {
        }
        this.#recordError(error);
        await this.#persist();
        throw error;
      }
      this.state.server.running = true;
      this.state.server.startedAt = (/* @__PURE__ */ new Date()).toISOString();
      this.state.role = "server";
      this.state.lastError = null;
      this.#log(`server started on ${this.state.server.endpoint} (control ${this.state.server.controlUrl})`);
      await this.#persist();
      return this.snapshot();
    });
  }
  /**
   * Stop server mode and its control panel.
   * @returns {Promise<Record<string, unknown>>} updated snapshot.
   */
  async stopServer() {
    return this.#serialized(async () => {
      if (!this.state.server.running && !this.control) return this.snapshot();
      if (this.control && this.config.externalControlPanel !== true) {
        await this.control.stop();
        this.control = null;
      }
      const interfaceName = this.state.server.interfaceName;
      if (this.tunnel) {
        try {
          await this.tunnel.down(interfaceName);
        } catch (error) {
          this.#recordError(error);
          await this.#persist();
          throw error;
        }
      }
      this.state.server.running = false;
      this.state.server.startedAt = null;
      this.state.role = this.state.client.connected ? "client" : "idle";
      this.state.lastError = null;
      this.#log("server stopped");
      await this.#persist();
      return this.snapshot();
    });
  }
  /**
   * Add this client to a running server and bring up the local tunnel.
   * @param {{ serverAddress?: unknown, joinCode?: unknown, name?: unknown }} input Client-tab values.
   * @returns {Promise<Record<string, unknown>>} updated snapshot.
   */
  async connectClient(input) {
    return this.#serialized(async () => {
      if (this.state.server.running) {
        throw new WireGuardError("server_active", "Stop server mode before joining another server.", { status: 409 });
      }
      if (this.state.client.connected) throw new WireGuardError("already_connected", "The client is already connected.", { status: 409 });
      if (this.state.client.pending) throw new WireGuardError("pending_connection", "A pending client configuration exists. Retry or cancel it first.", { status: 409 });
      await this.#detect(false);
      this.#requireClientTools();
      const address = parseServerAddress(input.serverAddress, DEFAULT_CONTROL_PORT);
      const joinCode = String(input.joinCode ?? "").trim();
      const name = normalizeDeviceName(input.name, localHostname());
      const family = address.host.includes(":") ? "ipv6" : "ipv4";
      const health = await this.#fetchJson(`${address.controlUrl}/health`);
      if (health.service !== SERVICE_NAME) {
        throw new WireGuardError("wrong_service", "That address is not a DSH WireGuard control panel.", { status: 502 });
      }
      const serverPublicKey = normalizeKey(health.publicKey);
      if (!serverPublicKey) throw new WireGuardError("bad_server", "The server returned an invalid public key.", { status: 502 });
      const vpnCidr = parseCidr(health.vpnCidr);
      if (!vpnCidr) throw new WireGuardError("bad_server", "The server returned an invalid VPN subnet.", { status: 502 });
      const listenPort = integerOr(health.listenPort, this.state.settings.listenPort);
      if (listenPort < 1 || listenPort > 65535) throw new WireGuardError("bad_server", "The server returned an invalid WireGuard port.", { status: 502 });
      const key = await this.store.ensureKey("client");
      const join = await this.#fetchJson(`${address.controlUrl}/join`, {
        method: "POST",
        body: { name, publicKey: key.publicKey, code: joinCode, family }
      });
      const assignedIp = parseIpv4(join?.client?.ip);
      if (assignedIp === null || !isUsableHost(assignedIp, vpnCidr)) {
        throw new WireGuardError("bad_server", "The server did not assign a valid client address.", { status: 502 });
      }
      const assignedAddress = ipv4ToString(assignedIp);
      const joinedServerKey = normalizeKey(join?.server?.publicKey ?? serverPublicKey);
      if (!joinedServerKey) throw new WireGuardError("bad_server", "The server returned an invalid public key.", { status: 502 });
      const endpoint = String(join?.server?.endpoint || `${formatEndpointHost(address.host)}:${listenPort}`);
      if (!/^(?:\[[0-9A-Fa-f:.]+\]|[^:\s]+):\d{1,5}$/.test(endpoint)) throw new WireGuardError("bad_server", "The server returned an invalid WireGuard endpoint.", { status: 502 });
      const advertisedMtu = integerOr(health.mtu, this.state.settings.mtu);
      const clientSettings = {
        ...this.state.settings,
        mtu: advertisedMtu >= 576 && advertisedMtu <= 9e3 ? advertisedMtu : this.state.settings.mtu,
        dns: typeof health.dns === "string" ? health.dns : this.state.settings.dns
      };
      const configText = buildClientConfig({
        privateKey: key.privateKey,
        address: assignedAddress,
        settings: clientSettings,
        serverPublicKey: joinedServerKey,
        endpoint,
        vpnCidr: vpnCidr.normalized
      });
      await this.store.writeConfig("client", configText, this.state.settings.interfaceName, this.platform?.isWindows === true);
      this.state.client = {
        ...emptyState().client,
        pending: true,
        publicKey: key.publicKey,
        name,
        serverUrl: address.controlUrl,
        serverHost: address.host,
        assignedIp: assignedAddress,
        serverPublicKey: joinedServerKey,
        vpnCidr: vpnCidr.normalized,
        endpoint,
        interfaceName: this.state.settings.interfaceName,
        mtu: clientSettings.mtu,
        joinCode,
        lastError: null
      };
      this.state.role = "client";
      await this.#persist();
      try {
        await this.tunnel.upClient({
          interfaceName: this.state.client.interfaceName,
          privateKeyPath: key.privateKeyPath,
          address: this.state.client.assignedIp,
          settings: { ...clientSettings, interfaceName: this.state.client.interfaceName },
          vpnCidr: vpnCidr.normalized,
          serverPublicKey: joinedServerKey,
          endpoint,
          configPath: this.store.configPath("client", this.state.client.interfaceName, this.platform?.isWindows === true)
        });
      } catch (error) {
        this.state.client.pending = true;
        this.state.client.connected = false;
        this.state.client.lastError = errorMessage(error);
        this.#recordError(error);
        await this.#persist();
        throw error;
      }
      this.state.client.pending = false;
      this.state.client.connected = true;
      this.state.client.connectedAt = (/* @__PURE__ */ new Date()).toISOString();
      this.state.client.lastError = null;
      this.state.lastError = null;
      this.#log(`client connected to ${address.controlUrl} as ${this.state.client.assignedIp}`);
      await this.#persist();
      return this.snapshot();
    });
  }
  /**
   * Reapply a saved client configuration after installing tools or elevation.
   * @returns {Promise<Record<string, unknown>>} updated snapshot.
   */
  async retryClient() {
    return this.#serialized(async () => {
      const client = this.state.client;
      if (client.connected) return this.snapshot();
      if (!client.pending || !client.assignedIp || !client.endpoint || !client.serverPublicKey || !client.vpnCidr || !client.interfaceName) {
        throw new WireGuardError("nothing_to_retry", "There is no saved client configuration to retry.", { status: 409 });
      }
      await this.#detect(false);
      this.#requireClientTools();
      const key = await this.store.ensureKey("client");
      try {
        await this.tunnel.upClient({
          interfaceName: client.interfaceName,
          privateKeyPath: key.privateKeyPath,
          address: client.assignedIp,
          settings: { ...this.state.settings, mtu: client.mtu, interfaceName: client.interfaceName },
          vpnCidr: client.vpnCidr,
          serverPublicKey: client.serverPublicKey,
          endpoint: client.endpoint,
          configPath: this.store.configPath("client", client.interfaceName, this.platform?.isWindows === true)
        });
      } catch (error) {
        client.lastError = errorMessage(error);
        this.#recordError(error);
        await this.#persist();
        throw error;
      }
      client.pending = false;
      client.connected = true;
      client.connectedAt = (/* @__PURE__ */ new Date()).toISOString();
      client.lastError = null;
      this.state.lastError = null;
      await this.#persist();
      return this.snapshot();
    });
  }
  /**
   * Tear down the client tunnel, leave the server, and clear the saved profile.
   * @returns {Promise<Record<string, unknown>>} updated snapshot.
   */
  async disconnectClient() {
    return this.#serialized(async () => {
      const client = this.state.client;
      if (!client.connected && !client.pending) return this.snapshot();
      let downError = null;
      if (this.tunnel && client.interfaceName) {
        try {
          await this.tunnel.down(client.interfaceName);
        } catch (error) {
          downError = error;
        }
      }
      if (client.serverUrl && client.publicKey) {
        try {
          await this.#fetchJson(`${client.serverUrl}/leave`, {
            method: "POST",
            body: { publicKey: client.publicKey, code: client.joinCode ?? "" },
            timeout: 5e3
          });
        } catch {
        }
      }
      await this.store.removeConfig("client", client.interfaceName, this.platform?.isWindows === true);
      this.state.client = emptyState().client;
      this.state.role = this.state.server.running ? "server" : "idle";
      this.state.lastError = downError ? `The client profile was cleared, but the interface may still be up: ${errorMessage(downError)}` : null;
      if (downError) this.#log(this.state.lastError);
      await this.#persist();
      return this.snapshot();
    });
  }
  /**
   * Join called by the remote control panel.
   * @param {Record<string, unknown>} body request body.
   * @param {string} remoteAddress caller address.
   * @returns {Promise<Record<string, unknown>>} server and client connection data.
   */
  async joinPeer(body, remoteAddress = "") {
    return this.#serialized(async () => {
      if (!this.state.server.running || !this.control) {
        throw new WireGuardError("not_running", "The WireGuard server is not running.", { status: 503 });
      }
      if (this.state.settings.joinCode && !secretsMatch(String(body.code ?? ""), this.state.settings.joinCode)) {
        throw new WireGuardError("invalid_join_code", "The join code is missing or incorrect.", { status: 401 });
      }
      const publicKey = normalizeKey(body.publicKey);
      if (!publicKey) throw new WireGuardError("invalid_public_key", "A valid WireGuard public key is required.", { status: 400 });
      const name = normalizeDeviceName(body.name, "client");
      const family = body.family === "ipv6" ? "ipv6" : body.family === "ipv4" ? "ipv4" : "";
      const cidr = parseCidr(this.state.server.vpnCidr);
      if (!cidr) throw new WireGuardError("server_not_ready", "The server subnet is invalid.", { status: 500 });
      const existing = this.state.server.peers.find((peer2) => peer2.publicKey === publicKey);
      if (existing) {
        existing.name = name;
        await this.tunnel.addPeer(this.state.server.interfaceName, existing);
        existing.applied = true;
        await this.#safeRewriteServerConfig();
        await this.#persist();
        this.#log(`peer ${name} (${existing.ip}) rejoined from ${remoteAddress || "unknown"}`);
        return this.#joinResult(existing, family);
      }
      if (this.state.server.peers.length >= MAX_PEERS) {
        throw new WireGuardError("server_full", "This server has reached its peer limit.", { status: 409 });
      }
      const ip = allocatePeerIp(cidr, this.state.server.peers.map((peer2) => peer2.ip), this.state.settings.serverIp);
      if (!ip) throw new WireGuardError("server_full", "No free address remains in the VPN subnet.", { status: 409 });
      const peer = {
        publicKey,
        ip,
        name,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        applied: false,
        online: false,
        lastHandshakeAt: null,
        sshUser: null
      };
      this.state.server.peers.push(peer);
      try {
        await this.tunnel.addPeer(this.state.server.interfaceName, peer);
      } catch (error) {
        this.state.server.peers = this.state.server.peers.filter((candidate) => candidate.publicKey !== publicKey);
        this.#recordError(error);
        await this.#persist();
        throw error;
      }
      peer.applied = true;
      await this.#safeRewriteServerConfig();
      await this.#persist();
      this.#log(`peer ${name} (${ip}) joined from ${remoteAddress || "unknown"}`);
      return this.#joinResult(peer, family);
    });
  }
  /**
   * Leave called by a remote client.
   * @param {Record<string, unknown>} body request body.
   * @param {string} remoteAddress caller address.
   * @returns {Promise<Record<string, unknown>>} removal result.
   */
  async leavePeer(body, remoteAddress = "") {
    return this.#serialized(async () => {
      if (this.state.settings.joinCode && !secretsMatch(String(body.code ?? ""), this.state.settings.joinCode)) {
        throw new WireGuardError("invalid_join_code", "The join code is missing or incorrect.", { status: 401 });
      }
      const publicKey = normalizeKey(body.publicKey);
      if (!publicKey) throw new WireGuardError("invalid_public_key", "A valid WireGuard public key is required.", { status: 400 });
      const peer = this.state.server.peers.find((candidate) => candidate.publicKey === publicKey);
      if (!peer) return { removed: false };
      if (this.state.server.running && this.tunnel) {
        await this.tunnel.removePeer(this.state.server.interfaceName, publicKey);
      }
      this.state.server.peers = this.state.server.peers.filter((candidate) => candidate.publicKey !== publicKey);
      await this.#safeRewriteServerConfig();
      await this.#persist();
      this.#log(`peer ${peer.name} (${peer.ip}) left from ${remoteAddress || "unknown"}`);
      return { removed: true };
    });
  }
  /**
   * Remove a peer from the local Service tab.
   * @param {string} publicKey peer public key.
   * @returns {Promise<Record<string, unknown>>} updated snapshot.
   */
  async removePeer(publicKey) {
    return this.#serialized(async () => {
      const key = normalizeKey(publicKey);
      if (!key) throw new WireGuardError("invalid_public_key", "A valid WireGuard public key is required.", { status: 400 });
      const peer = this.state.server.peers.find((candidate) => candidate.publicKey === key);
      if (!peer) return this.snapshot();
      if (this.state.server.running && this.tunnel) {
        await this.tunnel.removePeer(this.state.server.interfaceName, key);
      }
      this.state.server.peers = this.state.server.peers.filter((candidate) => candidate.publicKey !== key);
      await this.#removeSshKey(key);
      await this.#safeRewriteServerConfig();
      await this.#persist();
      return this.snapshot();
    });
  }
  /**
   * Configure SSH access for one joined peer. The private key is generated and
   * kept under the plugin data directory; only the public-key install command
   * is returned to the caller.
   * @param {Record<string, unknown>} input peer public key and SSH username.
   * @returns {Promise<{ state: Record<string, unknown>, command: string }>} snapshot and client command.
   */
  async configurePeerSsh(input) {
    return this.#serialized(async () => {
      const publicKey = normalizeKey(input.publicKey);
      if (!publicKey) {
        throw new WireGuardError("invalid_public_key", "A valid WireGuard public key is required.", { status: 400 });
      }
      const peer = this.state.server.peers.find((candidate) => candidate.publicKey === publicKey);
      if (!peer) {
        throw new WireGuardError("peer_not_found", "That device has not joined this server.", { status: 404 });
      }
      const user = String(input.user ?? "").trim();
      if (!SSH_USER_PATTERN.test(user)) {
        throw new WireGuardError("invalid_input", "SSH username must start with a letter or underscore and contain only letters, digits, underscores, or dashes.", {
          status: 400,
          details: { field: "sshUser" }
        });
      }
      const publicSshKey = await this.#ensureSshKey(publicKey);
      peer.sshUser = user;
      await this.#persist();
      this.#log(`configured SSH access for ${peer.name} as ${user}`);
      const commands = {
        linux: buildSshAuthorizeCommand(user, publicSshKey),
        windows: buildWindowsSshAuthorizeCommand(user, publicSshKey)
      };
      return { state: this.snapshot(), command: commands.linux, commands, publicKey: publicSshKey };
    });
  }
  /**
   * @param {string} peerPublicKey peer WireGuard public key.
   * @returns {string} private-key path under the plugin data directory.
   */
  #sshKeyPath(peerPublicKey) {
    const digest = createHash2("sha256").update(peerPublicKey).digest("hex");
    return path4.join(this.store.dataDir, "ssh", `${digest}.key`);
  }
  /**
   * Reuse a peer's SSH key if present, otherwise generate a new Ed25519 key.
   * @param {string} peerPublicKey peer WireGuard public key.
   * @returns {Promise<string>} SSH public key.
   */
  async #ensureSshKey(peerPublicKey) {
    const keyPath = this.#sshKeyPath(peerPublicKey);
    const publicPath = `${keyPath}.pub`;
    const directory = path4.dirname(keyPath);
    await mkdir3(directory, { recursive: true, mode: 448 });
    try {
      await chmod2(directory, 448);
    } catch {
    }
    try {
      const existing = (await readFile2(publicPath, "utf8")).trim();
      if (existing) {
        try {
          await chmod2(keyPath, 384);
        } catch {
        }
        return existing;
      }
    } catch {
    }
    try {
      await readFile2(keyPath, "utf8");
      try {
        const derived = await execFileAsync("ssh-keygen", ["-y", "-f", keyPath]);
        const publicKey2 = String(derived.stdout ?? "").trim();
        if (publicKey2) {
          await writeFile2(publicPath, `${publicKey2}
`, { encoding: "utf8", mode: 420 });
          try {
            await chmod2(keyPath, 384);
          } catch {
          }
          return publicKey2;
        }
      } catch {
      }
    } catch {
    }
    await rm2(keyPath, { force: true }).catch(() => {
    });
    await rm2(publicPath, { force: true }).catch(() => {
    });
    try {
      await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "dsh-wireguard", "-f", keyPath]);
    } catch {
      throw new WireGuardError("ssh_keygen_failed", "Could not generate an SSH key for the client.", {
        status: 500,
        hint: "Install OpenSSH ssh-keygen on the Harness host, then retry."
      });
    }
    const publicKey = (await readFile2(publicPath, "utf8")).trim();
    if (!publicKey) {
      throw new WireGuardError("ssh_keygen_failed", "SSH key generation produced no public key.", { status: 500 });
    }
    try {
      await chmod2(keyPath, 384);
    } catch {
    }
    return publicKey;
  }
  /**
   * Remove a peer's stored SSH key when the peer is removed.
   * @param {string} peerPublicKey peer WireGuard public key.
   * @returns {Promise<void>}
   */
  async #removeSshKey(peerPublicKey) {
    const keyPath = this.#sshKeyPath(peerPublicKey);
    await rm2(keyPath, { force: true }).catch(() => {
    });
    await rm2(`${keyPath}.pub`, { force: true }).catch(() => {
    });
  }
  /**
   * Build the server data returned to a joining client.
   * @param {Record<string, any>} peer assigned peer.
   * @returns {Record<string, unknown>} join response.
   */
  #joinResult(peer, family = "") {
    const server = this.state.server;
    if (!server.publicKey || !server.endpoint) {
      throw new WireGuardError("server_not_ready", "The WireGuard server is missing its key or endpoint.", { status: 500 });
    }
    const targets = this.#deploymentTargets();
    const selected = family === "ipv6" ? targets.ipv6 : family === "ipv4" ? targets.ipv4 : null;
    if (family && !selected?.available) {
      throw new WireGuardError("family_unavailable", `No ${family} deployment address is available.`, {
        status: 503,
        hint: "Configure a reachable address for this family, or use the other deployment target."
      });
    }
    const endpoint = selected?.endpoint || server.endpoint;
    return {
      client: { ip: peer.ip, address: `${peer.ip}/32`, name: peer.name },
      server: {
        name: localHostname(),
        publicKey: server.publicKey,
        endpoint,
        endpointHost: server.endpointHost,
        vpnCidr: server.vpnCidr,
        listenPort: server.listenPort,
        controlPort: server.controlPort,
        mtu: server.mtu,
        dns: server.dns,
        version: PLUGIN_VERSION
      }
    };
  }
  /**
   * Refresh live handshakes and diagnose a tunnel that disappeared.
   * @returns {Promise<Record<string, unknown>>} updated snapshot.
   */
  async refresh(options = {}) {
    return this.#serialized(async () => {
      try {
        await this.#detect(options.force === true);
      } catch (error) {
        this.#recordError(error);
        return this.snapshot();
      }
      if (!this.platform || !this.tunnel) return this.snapshot();
      if (this.state.server.running) {
        const status = await this.tunnel.status(this.state.server.interfaceName);
        if (status.up) {
          this.#mergeServerStatus(status);
        } else if (status.privilege) {
          if (!this.state.server.warnings.some((line) => line.includes("cannot read"))) {
            this.state.server.warnings.push("Cannot read the live WireGuard interface without administrator rights.");
          }
        } else {
          this.control?.stop().catch(() => {
          });
          this.control = null;
          this.state.server.running = false;
          this.state.role = this.state.client.connected ? "client" : "idle";
          this.#recordError(`The WireGuard server stopped unexpectedly: ${status.error ?? "interface not found"}`);
          await this.#persist();
        }
      }
      if (this.state.client.connected || this.state.client.pending) {
        if (this.state.client.interfaceName) {
          const status = await this.tunnel.status(this.state.client.interfaceName);
          if (status.up) {
            this.#mergeClientStatus(status);
            if (!this.state.client.connected) {
              this.state.client.connected = true;
              this.state.client.pending = false;
              this.state.client.connectedAt = (/* @__PURE__ */ new Date()).toISOString();
              this.state.client.lastError = null;
              await this.#persist();
            }
          } else if (!status.privilege && this.state.client.connected) {
            this.state.client.connected = false;
            this.state.client.pending = true;
            this.state.client.lastError = "The WireGuard client tunnel stopped. Retry the connection.";
            this.#recordError(this.state.client.lastError);
            await this.#persist();
          }
        }
      }
      return this.snapshot();
    });
  }
  /**
   * Merge live server peers and public key into persisted state (memory only).
   * @param {{ publicKey: string, listenPort: number | null, peers: Array<Record<string, any>> }} status
   * @returns {void}
   */
  #mergeServerStatus(status) {
    if (status.publicKey) this.state.server.publicKey = status.publicKey;
    if (status.listenPort) this.state.server.listenPort = status.listenPort;
    const live = new Map(status.peers.map((peer) => [peer.publicKey, peer]));
    for (const peer of this.state.server.peers) {
      const current = live.get(peer.publicKey);
      if (!current) {
        peer.online = false;
        continue;
      }
      peer.online = current.online;
      peer.lastHandshakeAt = current.lastHandshakeAt;
      peer.endpoint = current.endpoint;
      peer.receivedBytes = current.receivedBytes;
      peer.sentBytes = current.sentBytes;
      peer.applied = true;
    }
  }
  /**
   * Merge the server peer's live counters into the client state.
   * @param {{ peers: Array<Record<string, any>> }} status
   * @returns {void}
   */
  #mergeClientStatus(status) {
    const peer = status.peers[0];
    if (!peer) return;
    this.state.client.lastHandshakeAt = peer.lastHandshakeAt ?? null;
    this.state.client.receivedBytes = integerOr(peer.receivedBytes, 0);
    this.state.client.sentBytes = integerOr(peer.sentBytes, 0);
  }
  /**
   * Download and install WireGuard for this platform. This is an explicit user
   * action; it never runs while a tunnel is active.
   * @returns {Promise<Record<string, unknown>>} updated snapshot.
   */
  async installWireGuard() {
    return this.#serialized(async () => {
      if (this.state.server.running || this.state.client.connected || this.state.client.pending) {
        throw new WireGuardError("tunnel_active", "Stop the WireGuard service or client before installing WireGuard.", { status: 409 });
      }
      await this.#detect(true);
      if (!this.platform) {
        throw new WireGuardError("unsupported_platform", "WireGuard is supported on Windows and Linux only.", { status: 503 });
      }
      try {
        const outcome = await installWireGuard(this.platform, this.store.dataDir, (line) => this.#log(line));
        await this.#detect(true);
        this.state.lastError = null;
        this.#log(outcome.message);
        if (!this.platform?.wg || this.platform.isWindows && !this.platform.wireguard) {
          throw new WireGuardError("install_incomplete", "WireGuard was installed but the tools are not visible yet.", {
            status: 503,
            hint: "Restart Harness, or press Recheck after a few seconds."
          });
        }
        await this.#persist();
        return this.snapshot();
      } catch (error) {
        this.#recordError(error);
        await this.#persist();
        throw error;
      }
    });
  }
  /**
   * Read state for the panel, refreshing live counters first.
   * @returns {Promise<Record<string, unknown>>} snapshot.
   */
  async getState(options = {}) {
    try {
      return await this.refresh(options);
    } catch (error) {
      this.#recordError(error);
      return this.snapshot();
    }
  }
  /**
   * Build the complete non-secret state consumed by the browser panel.
   * @returns {Record<string, unknown>} snapshot.
   */
  snapshot() {
    const platform = this.platform;
    const missing = [];
    if (!platform?.wg) missing.push("wg");
    if (platform?.isLinux && !platform.ip) missing.push("ip");
    if (platform?.isWindows && !platform.wireguard) missing.push("wireguard");
    const ready = missing.length === 0 && Boolean(platform);
    const installHint = missing.length === 0 ? void 0 : missingToolHint(missing[0], platform?.platform ?? process.platform);
    const { joinCode: _clientJoinCode, ...clientState } = this.state.client;
    return {
      ok: true,
      version: PLUGIN_VERSION,
      service: SERVICE_NAME,
      role: this.state.role,
      hostname: localHostname(),
      platform: {
        id: platform?.platform ?? process.platform,
        label: platform?.isWindows ? "Windows" : platform?.isLinux ? "Linux" : process.platform
      },
      tools: {
        ready,
        admin: platform?.admin === true,
        wg: Boolean(platform?.wg),
        wireguard: Boolean(platform?.wireguard),
        ip: Boolean(platform?.ip),
        missing,
        installHint
      },
      settings: { ...this.state.settings },
      deployment: this.#deploymentTargets(),
      server: {
        ...this.state.server,
        publicKeyFingerprint: keyFingerprint(this.state.server.publicKey),
        joinRequired: Boolean(this.state.settings.joinCode),
        controlAvailable: Boolean(this.control),
        peers: this.state.server.peers.map((peer) => ({
          publicKey: peer.publicKey,
          publicKeyFingerprint: keyFingerprint(peer.publicKey),
          name: peer.name,
          ip: peer.ip,
          createdAt: peer.createdAt ?? null,
          online: peer.online === true,
          lastHandshakeAt: peer.lastHandshakeAt ?? null,
          endpoint: peer.endpoint ?? null,
          receivedBytes: integerOr(peer.receivedBytes, 0),
          sentBytes: integerOr(peer.sentBytes, 0),
          applied: peer.applied !== false,
          sshConfigured: Boolean(peer.sshUser),
          sshUser: peer.sshUser ?? null
        }))
      },
      client: {
        ...clientState,
        publicKeyFingerprint: keyFingerprint(this.state.client.publicKey ?? ""),
        configured: Boolean(this.state.client.assignedIp)
      },
      lastError: this.state.lastError,
      logs: this.state.logs.slice(-20)
    };
  }
  /**
   * Fetch JSON from a remote control panel with a bounded timeout.
   * @param {string} url absolute URL.
   * @param {{ method?: string, body?: unknown, timeout?: number }} [options]
   * @returns {Promise<Record<string, any>>} decoded JSON.
   */
  async #fetchJson(url, options = {}) {
    const timeout = options.timeout ?? 8e3;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      let response;
      try {
        response = await this.fetchImpl(url, {
          method: options.method ?? "GET",
          headers: {
            accept: "application/json",
            ...options.body === void 0 ? {} : { "content-type": "application/json" }
          },
          body: options.body === void 0 ? void 0 : JSON.stringify(options.body),
          signal: controller.signal,
          redirect: "error"
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new WireGuardError("server_unreachable", "The WireGuard server did not answer in time.", {
            status: 504,
            hint: "Check the server address, that the Service tab is running, and that TCP 51821 is allowed through the firewall."
          });
        }
        throw new WireGuardError("server_unreachable", "Could not reach the WireGuard control panel.", {
          status: 502,
          hint: "Check the server address and port, and make sure both devices are on the same LAN.",
          details: { cause: errorMessage(error) }
        });
      }
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new WireGuardError("bad_response", "The WireGuard control panel returned a non-JSON response.", {
          status: 502,
          details: { status: response.status }
        });
      }
      if (!response.ok || data?.ok === false) {
        const detail = data?.error ?? {};
        throw new WireGuardError(typeof detail.code === "string" ? detail.code : `http_${response.status}`, typeof detail.message === "string" ? detail.message : "The WireGuard control panel rejected the request.", {
          status: response.status,
          hint: typeof detail.hint === "string" ? detail.hint : void 0,
          command: typeof detail.command === "string" ? detail.command : void 0,
          details: detail.details
        });
      }
      if (!data || typeof data !== "object") throw new WireGuardError("bad_response", "The WireGuard control panel returned an empty response.", { status: 502 });
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
  /** Stop the control panel; keep or tear down the tunnel according to config. */
  async dispose() {
    try {
      if (this.control) await this.control.stop();
    } catch {
    }
    this.control = null;
    if (this.config.keepTunnelOnExit !== false) {
      this.#log("keeping the WireGuard tunnel alive across Harness exit");
      return;
    }
    if (this.tunnel) {
      if (this.state.server.running) {
        try {
          await this.tunnel.down(this.state.server.interfaceName);
        } catch {
        }
      }
      if (this.state.client.connected || this.state.client.pending) {
        try {
          await this.tunnel.down(this.state.client.interfaceName);
        } catch {
        }
      }
    }
    this.state.server.running = false;
    this.state.server.startedAt = null;
    this.state.client.connected = false;
    this.state.client.pending = false;
    this.state.role = "idle";
    try {
      await this.#persist();
    } catch {
    }
  }
};

// src/control-service.ts
var home = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : path5.join(homedir(), ".dsh");
var service = new WireGuardService({
  config: {
    externalControlPanel: true,
    keepTunnelOnExit: true
  },
  dataDir: path5.join(home, "wireguard"),
  log: (line) => console.log(`[wireguard-control] ${line}`)
});
var handler = createHttpApiHandler(service);
service.setControlExtraHandler(async (request, response) => {
  await handler(request, response);
  return true;
});
await service.init();
await service.startControlPanel();
console.log("[wireguard-control] ready; control panel owns 51821");
var closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[wireguard-control] ${signal}; stopping the listener`);
  await service.dispose();
  process.exit(0);
}
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
setInterval(() => {
}, 1 << 30);
