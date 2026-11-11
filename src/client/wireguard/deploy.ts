import type { DeploymentTarget, Snapshot } from './api';

interface CommandTarget {
  controlUrl: string;
  scriptUrl: string;
  joinCode: string;
  family: 'ipv4' | 'ipv6';
}

function bracketHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function targetOf(state: Snapshot, target?: DeploymentTarget): CommandTarget {
  const fallbackHost = bracketHost(state.server.endpointHost ?? '127.0.0.1');
  const controlUrl = (target?.controlUrl
    || state.server.controlUrl
    || `http://${fallbackHost}:${state.server.controlPort}`).replace(/\/+$/, '');
  const family = /^https?:\/\/\[/i.test(controlUrl) || controlUrl.includes('://[') ? 'ipv6' : 'ipv4';
  return {
    controlUrl,
    scriptUrl: `${controlUrl}/client.sh`,
    joinCode: state.settings.joinCode,
    family,
  };
}

/**
 * Minimal command: download the static script with curl, chmod it, and run it
 * with sudo when needed. No downloader fallback, validation, or cleanup.
 * @param {Snapshot} state running server snapshot.
 * @param {DeploymentTarget} [target] selected IPv4 or IPv6 target.
 * @returns {string} one-line shell command.
 */
export function buildLinuxClientSimpleCommand(state: Snapshot, target?: DeploymentTarget): string {
  const { controlUrl, scriptUrl, joinCode, family } = targetOf(state, target);
  return `S=""; [ "$(id -u)" -ne 0 ] && S="sudo"; curl -fsSL --connect-timeout 10 --max-time 30 '${scriptUrl}' -o /tmp/dsh-wg-client.sh && chmod 700 /tmp/dsh-wg-client.sh && $S sh /tmp/dsh-wg-client.sh '${controlUrl}' '${joinCode}' '${family}'`;
}

/**
 * Full command: detect root/sudo and curl/wget, validate the download, chmod the
 * script, run it with the server address and join code, then remove the file.
 * @param {Snapshot} state running server snapshot.
 * @param {DeploymentTarget} [target] selected IPv4 or IPv6 target.
 * @returns {string} one-line shell command.
 */
export function buildLinuxClientCommand(state: Snapshot, target?: DeploymentTarget): string {
  const { controlUrl, scriptUrl, joinCode, family } = targetOf(state, target);
  return `S=""; [ "$(id -u)" -ne 0 ] && { command -v sudo >/dev/null 2>&1 && S="sudo" || { echo "Run as root" >&2; exit 1; }; }; f=$(mktemp /tmp/dsh-wg-client.XXXXXX) || exit 1; if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 10 --max-time 30 '${scriptUrl}' -o "$f"; elif command -v wget >/dev/null 2>&1; then wget -qO "$f" -T 20 '${scriptUrl}'; elif command -v busybox >/dev/null 2>&1; then busybox wget -qO "$f" -T 20 '${scriptUrl}'; else echo "Install curl or wget" >&2; rm -f "$f"; exit 1; fi; grep -q '^#!/bin/sh' "$f" || { echo "Download failed" >&2; rm -f "$f"; exit 1; }; chmod 700 "$f" && $S sh "$f" '${controlUrl}' '${joinCode}' '${family}'; rc=$?; rm -f "$f"; exit $rc`;
}

/**
 * Windows client command. The PowerShell body joins the server, writes a
 * WireGuard tunnel config, and installs it as a Windows service. It is encoded
 * as UTF-16LE because that is what `powershell -EncodedCommand` expects.
 * @param {Snapshot} state running server snapshot.
 * @param {DeploymentTarget} [target] selected IPv4 or IPv6 target.
 * @returns {string} one-line PowerShell command.
 */
export function buildWindowsClientCommand(state: Snapshot, target?: DeploymentTarget): string {
  const { controlUrl, joinCode, family } = targetOf(state, target);
  const quote = (value: string) => value.replace(/'/g, "''");
  const script = `$ErrorActionPreference = 'Stop'
$control = '${quote(controlUrl)}'
$code = '${quote(joinCode)}'
$family = '${quote(family)}'
$wg = Join-Path $env:ProgramFiles 'WireGuard\\wg.exe'
if (-not (Test-Path $wg)) { throw 'Install WireGuard for Windows first: https://www.wireguard.com/install/' }
$key = (& $wg genkey).Trim()
$pub = ($key | & $wg pubkey).Trim()
$payload = @{ name = $env:COMPUTERNAME; publicKey = $pub; code = $code; family = $family } | ConvertTo-Json -Compress
$join = Invoke-RestMethod -Method Post -Uri "$control/join" -ContentType 'application/json' -Body $payload
if (-not $join.ok) { throw 'Join failed' }
$conf = Join-Path $env:ProgramData 'WireGuard\\dshwg0.conf'
New-Item -ItemType Directory -Force (Split-Path $conf) | Out-Null
$lines = @('[Interface]', "PrivateKey = $key", "Address = $($join.client.address)", "MTU = $($join.server.mtu)")
if ($join.server.dns) { $lines += "DNS = $($join.server.dns)" }
$lines += '', '[Peer]', "PublicKey = $($join.server.publicKey)", "Endpoint = $($join.server.endpoint)", "AllowedIPs = $($join.server.vpnCidr)", 'PersistentKeepalive = 25'
Set-Content -Path $conf -Value $lines -Encoding ascii
& (Join-Path $env:ProgramFiles 'WireGuard\\wireguard.exe') /installtunnelservice $conf`;
  let binary = '';
  for (let index = 0; index < script.length; index += 1) {
    const code = script.charCodeAt(index);
    binary += String.fromCharCode(code & 0xff, code >>> 8);
  }
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${btoa(binary)}`;
}

/**
 * Command to run on the client to bring its tunnel down and up again. This
 * triggers a fresh WireGuard handshake without rejoining or changing keys.
 */
export const LINUX_CLIENT_RESTART_COMMAND = 'sudo wg-quick down dshwg0 2>/dev/null || sudo ip link delete dshwg0 2>/dev/null || true; sudo wg-quick up dshwg0 && sudo wg show dshwg0';
