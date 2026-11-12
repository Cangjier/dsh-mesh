/** Per-peer IPv4 egress through the hub, for Linux and Windows members. */

/**
 * The hub side of the feature lives in `code/wireguard/egress-via-hub.sh`: it
 * owns the systemd unit and the exact iptables/route dialect. This module only
 * builds the member side, which must match the `member` role of that script.
 */
export interface EgressTarget {
  enabled: boolean;
  interfaceName: string;
  hubIp: string;
  hubKey: string;
  vpnCidr: string;
  platform: 'linux' | 'windows';
}

/** Persistence unit name, shared with egress-via-hub.sh. */
export const LINUX_EGRESS_UNIT = '/etc/systemd/system/dsh-mesh-egress.service';

/** WireGuard for Windows keeps every tunnel config under this directory. */
export const WINDOWS_WIREGUARD_DIR = 'C:\\ProgramData\\WireGuard';

/** POSIX single-quote quoting; the generated scripts contain no single quote. */
export function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The unit body is written with `printf`, so it must stay one shell word: the
 * literal `\n` separators and `\047` (octal single quote) are what make a
 * copy-paste one-liner possible without a heredoc.
 */
function linuxUnitFormat(target: EgressTarget): string {
  const { interfaceName, hubIp, hubKey } = target;
  const lines = [
    '[Unit]',
    `Description=dsh-mesh: route IPv4 egress through the hub (${hubIp})`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    '# 0.0.0.0/0 has to be in the peer AllowedIPs or the tunnel silently drops',
    '# every packet that the default route sends into it.',
    `ExecStart=/bin/sh -c \\047wg set ${interfaceName} peer ${hubKey} allowed-ips 0.0.0.0/0; ip route replace default via ${hubIp} dev ${interfaceName} metric 50\\047`,
    `ExecStop=/bin/sh -c \\047ip route del default via ${hubIp} dev ${interfaceName} 2>/dev/null || true\\047`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ];
  // The returned string still carries the backslash escapes; printf turns them
  // into newlines and quotes when the operator (or SSH) runs the script.
  return lines.join('\\n');
}

/**
 * Build the POSIX shell body that installs or removes the member half on Linux.
 * It mirrors `egress-via-hub.sh member` command for command and keeps the
 * tunnel config authoritative, because only the live `wg set` would be lost on
 * the next reboot.
 * @param {EgressTarget} target member values.
 * @returns {string} one-line shell body without single quotes.
 */
export function buildLinuxEgressScript(target: EgressTarget): string {
  const { enabled, interfaceName, hubIp, hubKey, vpnCidr } = target;
  const parts = [
    'set -e',
    `CONF=/etc/wireguard/${interfaceName}.conf`,
    `UNIT=${LINUX_EGRESS_UNIT}`,
    `HUB_IP=${hubIp}`,
    `HUB_KEY=${hubKey}`,
    `IF=${interfaceName}`,
    `VPN_CIDR=${vpnCidr}`,
    '[ -f "$CONF" ] || { echo "missing $CONF" >&2; exit 1; }',
  ];
  if (enabled) {
    parts.push(
      'sed -i "s|^AllowedIPs *=.*|AllowedIPs = 0.0.0.0/0|" "$CONF"',
      'wg set "$IF" peer "$HUB_KEY" allowed-ips 0.0.0.0/0',
      'ip route replace default via "$HUB_IP" dev "$IF" metric 50',
      `printf "${linuxUnitFormat(target)}" > "$UNIT"`,
      'systemctl daemon-reload',
      'systemctl enable --now dsh-mesh-egress.service >/dev/null',
      'echo "dsh-mesh: IPv4 egress via $HUB_IP enabled"',
    );
  } else {
    parts.push(
      'sed -i "s|^AllowedIPs *=.*|AllowedIPs = $VPN_CIDR|" "$CONF"',
      'wg set "$IF" peer "$HUB_KEY" allowed-ips "$VPN_CIDR"',
      'ip route del default via "$HUB_IP" dev "$IF" 2>/dev/null || true',
      'systemctl disable --now dsh-mesh-egress.service 2>/dev/null || true',
      'rm -f "$UNIT"',
      'systemctl daemon-reload',
      'echo "dsh-mesh: IPv4 egress via $HUB_IP disabled"',
    );
  }
  return parts.join('; ');
}

/**
 * Copy-paste command for a Linux member that the hub could not reach over SSH.
 * @param {EgressTarget} target member values.
 * @returns {string} single-line `sudo sh -c '...'` command.
 */
export function buildLinuxEgressCommand(target: EgressTarget): string {
  return `sudo sh -c ${quotePosix(buildLinuxEgressScript(target))}`;
}

/**
 * Remote command for the hub's SSH invocation. Peers are normally configured
 * with a root login or a passwordless-sudo user, matching the SSH setup
 * command the panel already generates.
 * @param {EgressTarget} target member values.
 * @param {string} user SSH username.
 * @returns {string} command to run through `ssh`.
 */
export function buildLinuxEgressSshCommand(target: EgressTarget, user: string): string {
  const sudo = user === 'root' ? '' : 'sudo -n ';
  return `${sudo}sh -c ${quotePosix(buildLinuxEgressScript(target))}`;
}

/** PowerShell needs UTF-16LE base64 for `-EncodedCommand`. */
export function encodeWindowsCommand(script: string): string {
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

/**
 * Build the PowerShell body for a Windows member. Windows keeps every tunnel
 * config under `C:\ProgramData\WireGuard`, runs `wg.exe` and `wireguard.exe`
 * from Program Files, and reloads a tunnel through `/installtunnelservice`.
 *
 * WireGuard for Windows derives its routes from AllowedIPs itself, so
 * `0.0.0.0/0` becomes the default route while the tunnel service is up; there
 * is no separate `ip route` equivalent to install. The config file is the
 * persistence layer here, which is why the service is reinstalled after the
 * edit.
 * @param {EgressTarget} target member values.
 * @returns {string} PowerShell script.
 */
export function buildWindowsEgressScript(target: EgressTarget): string {
  const { enabled, interfaceName, hubIp, hubKey, vpnCidr } = target;
  const allowed = enabled ? '0.0.0.0/0' : vpnCidr;
  const conf = `${WINDOWS_WIREGUARD_DIR}\\${interfaceName}.conf`;
  const verb = enabled ? 'enabled' : 'disabled';
  return `$ErrorActionPreference = 'Stop'
$conf = '${conf.replace(/'/g, "''")}'
$wg = 'C:\\Program Files\\WireGuard\\wg.exe'
$wireguard = 'C:\\Program Files\\WireGuard\\wireguard.exe'
if (-not (Test-Path -LiteralPath $conf)) { throw "missing $conf" }
$lines = @(Get-Content -LiteralPath $conf)
$index = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '^\\s*AllowedIPs\\s*=') { $index = $i; break }
}
if ($index -lt 0) { throw 'the tunnel configuration has no AllowedIPs line' }
$lines[$index] = 'AllowedIPs = ${allowed}'
Set-Content -LiteralPath $conf -Value $lines -Encoding ascii
& $wireguard /uninstalltunnelservice ${interfaceName} 2>$null
& $wireguard /installtunnelservice $conf
& $wg set ${interfaceName} peer '${hubKey}' allowed-ips '${allowed}' 2>$null
Write-Output 'dsh-mesh: IPv4 egress via ${hubIp} ${verb}'
`;
}

/**
 * Copy-paste command for a Windows member when SSH is unavailable.
 * @param {EgressTarget} target member values.
 * @returns {string} single-line PowerShell command.
 */
export function buildWindowsEgressCommand(target: EgressTarget): string {
  return encodeWindowsCommand(buildWindowsEgressScript(target));
}

/**
 * Both directions for the panel's manual fallback, so the operator can undo a
 * half-applied toggle without generating a new one.
 * @param {Omit<EgressTarget, 'enabled'>} target member values.
 * @returns {{ enable: string, disable: string }} copy-paste commands.
 */
export function buildManualEgressCommands(target: Omit<EgressTarget, 'enabled'>): { enable: string; disable: string } {
  const enable = { ...target, enabled: true };
  const disable = { ...target, enabled: false };
  if (target.platform === 'windows') {
    return { enable: buildWindowsEgressCommand(enable), disable: buildWindowsEgressCommand(disable) };
  }
  return { enable: buildLinuxEgressCommand(enable), disable: buildLinuxEgressCommand(disable) };
}
