/** Member-side OpenSSH discovery, installation, and key enrollment. */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir, hostname as osHostname, userInfo } from 'node:os';
import path from 'node:path';
import { findExecutable, run, runPrivileged, type PlatformInfo } from './platform';
import { SSH_USER_PATTERN } from './ssh';

export interface SshAgentStatus {
  installed: boolean;
  running: boolean;
  serviceRunning: boolean;
  ready: boolean;
  version: string | null;
  port: number;
  user: string | null;
  hostname: string;
  error: string | null;
}

export interface OpenSshAssetManifest {
  name: string;
  version: string;
  file: string;
  sha256: string;
  bytes: number;
}

const WINDOWS_INSTALL_DIR = 'C:\\Program Files\\OpenSSH';
const WINDOWS_SSHD_CANDIDATES = [
  path.join(WINDOWS_INSTALL_DIR, 'sshd.exe'),
  'C:\\Windows\\System32\\OpenSSH\\sshd.exe',
];

function cleanUser(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/^.*\\/u, '');
  if (!name || /^(system|localsystem|nt authority)$/iu.test(name)) return null;
  return SSH_USER_PATTERN.test(name) ? name : null;
}

/** Read the SSH identification banner from a local listener. */
export async function testSshBanner(port = 22, timeout = 2500): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(timeout);
    socket.once('data', (chunk) => {
      const text = chunk.subarray(0, 64).toString('ascii');
      finish(text.startsWith('SSH-'));
    });
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

/** Best-effort Windows console user, falling back to the active session list. */
async function windowsInteractiveUser(): Promise<string | null> {
  try {
    const result = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference='SilentlyContinue'; $u=(Get-CimInstance Win32_ComputerSystem).UserName; if(-not $u){$u=(Get-CimInstance Win32_Process -Filter \"Name='explorer.exe'\" | ForEach-Object { $_.GetOwner().User } | Select-Object -First 1)}; if($u){$u.Split('\\')[-1]}",
    ], { timeout: 8000 });
    const user = cleanUser(result.stdout);
    if (user) return user;
  } catch {
    // Fall through to query user.
  }
  try {
    const result = await run('query.exe', ['user'], { timeout: 8000 });
    const lines = result.stdout.split(/\r?\n/u).slice(1).filter((line) => line.trim());
    const rows = lines.map((line) => line.trim().split(/\s+/u)).filter((row) => row.length >= 4);
    const consoleRow = rows.find((row) => row[1]?.toLowerCase() === 'console' && /active/iu.test(row[3] ?? ''));
    const activeRow = consoleRow ?? rows.find((row) => /active/iu.test(row[3] ?? ''));
    return cleanUser(activeRow?.[0]);
  } catch {
    return null;
  }
}

/** Best-effort Linux interactive user; root itself is not a useful SSH login. */
async function linuxInteractiveUser(): Promise<string | null> {
  try {
    const current = cleanUser(userInfo().username);
    if (current && typeof process.getuid === 'function' && process.getuid() !== 0) return current;
  } catch {
    // Ignore and inspect sessions.
  }
  try {
    const result = await run('who', [], { timeout: 5000 });
    for (const line of result.stdout.split(/\r?\n/u)) {
      const user = cleanUser(line.trim().split(/\s+/u)[0]);
      if (user) return user;
    }
  } catch {
    // Fall through.
  }
  try {
    const result = await run('loginctl', ['list-sessions', '--no-legend'], { timeout: 5000 });
    for (const line of result.stdout.split(/\r?\n/u)) {
      const fields = line.trim().split(/\s+/u);
      const user = cleanUser(fields[2]);
      if (user) return user;
    }
  } catch {
    // No interactive session.
  }
  return null;
}

/** Resolve the account that a remote SSH login should use. */
export async function detectInteractiveUser(platform: PlatformInfo): Promise<string | null> {
  if (platform.isWindows) return await windowsInteractiveUser();
  if (platform.isLinux) return await linuxInteractiveUser();
  return null;
}

async function readSshVersion(sshd: string): Promise<string | null> {
  try {
    const result = await run(sshd, ['-V'], { timeout: 5000 });
    const text = `${result.stdout}\n${result.stderr}`.trim();
    const line = text.split(/\r?\n/u).find((item) => item.trim()) ?? '';
    return line.trim().slice(0, 120) || null;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const match = /OpenSSH[_A-Za-z0-9.\- p]+/u.exec(text);
    return match?.[0]?.trim().slice(0, 120) ?? null;
  }
}

/** Inspect the local OpenSSH server and prove it really answers SSH. */
export async function inspectSsh(platform: PlatformInfo): Promise<SshAgentStatus> {
  const hostname = osHostname();
  const user = await detectInteractiveUser(platform);
  let installed = false;
  let running = false;
  let serviceRunning = false;
  let version: string | null = null;
  let sshd: string | null = null;
  if (platform.isWindows) {
    sshd = WINDOWS_SSHD_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
    installed = sshd !== null;
    try {
      const result = await run('sc.exe', ['query', 'sshd'], { timeout: 5000 });
      serviceRunning = /RUNNING/iu.test(result.stdout);
    } catch {
      serviceRunning = false;
    }
    running = serviceRunning;
  } else if (platform.isLinux) {
    sshd = findExecutable('sshd', ['/usr/sbin/sshd', '/usr/local/sbin/sshd']);
    installed = sshd !== null;
    for (const unit of ['sshd', 'ssh']) {
      try {
        const result = await run('systemctl', ['is-active', unit], { timeout: 4000 });
        if (result.stdout.trim() === 'active') {
          running = true;
          serviceRunning = true;
          break;
        }
      } catch {
        // Try the next unit.
      }
    }
    if (!running) {
      try {
        const result = await run('pgrep', ['-x', 'sshd'], { timeout: 4000 });
        running = result.stdout.trim().length > 0;
        serviceRunning = running;
      } catch {
        running = false;
        serviceRunning = false;
      }
    }
  }
  if (sshd) version = await readSshVersion(sshd);
  const ready = await testSshBanner(22);
  // A live banner is the real service check: on Windows a hand-started
  // `sshd -D` can answer while the disabled service still reports STOPPED.
  if (ready) {
    installed = true;
    running = true;
  }
  let error: string | null = null;
  if (!installed) error = 'OpenSSH Server is not installed';
  else if (!running) error = 'OpenSSH Server is not running';
  else if (!ready) error = 'sshd is running but did not send an SSH banner';
  else if (!user) error = 'Could not determine the interactive Windows/Linux user';
  return { installed, running, serviceRunning, ready, version, port: 22, user, hostname, error };
}

function quotePowerShell(value: string): string {
  return value.replace(/'/gu, "''");
}

/** Write the server public key to the Windows admin and per-user files. */
export function windowsAuthorizeKeyScript(publicKey: string, user: string | null): string {
  const key = quotePowerShell(publicKey);
  const account = user && SSH_USER_PATTERN.test(user) ? quotePowerShell(user) : '';
  return `$ErrorActionPreference = 'Stop'
$key = '${key}'
$user = '${account}'
$admin = Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'
$files = @($admin)
if ($user) { $files += Join-Path (Join-Path 'C:\\Users' $user) '.ssh\\authorized_keys' }
foreach ($file in $files) {
  New-Item -ItemType Directory -Force (Split-Path $file) | Out-Null
  if (-not (Test-Path $file)) { New-Item -ItemType File -Path $file | Out-Null }
  $lines = @(Get-Content $file -ErrorAction SilentlyContinue)
  if ($lines -notcontains $key) { Add-Content -Path $file -Value $key -Encoding ascii }
}
icacls $admin /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
Write-Output 'authorized key installed'`;
}

/** Install a server public key for a Windows account. */
export async function authorizeWindowsKey(
  platform: PlatformInfo,
  publicKey: string,
  user: string | null,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-ssh-key-'));
  const scriptPath = path.join(directory, 'authorize.ps1');
  try {
    await writeFile(scriptPath, `${windowsAuthorizeKeyScript(publicKey, user)}\n`, 'utf8');
    await runPrivileged('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
    ], { platform, timeout: 30000 });
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/** Install a server public key for a Linux account. */
export async function authorizeLinuxKey(
  platform: PlatformInfo,
  publicKey: string,
  user: string | null,
): Promise<void> {
  if (!user || !SSH_USER_PATTERN.test(user)) throw new Error('No usable Linux login user was detected.');
  const key = publicKey.trim().split(/\s+/u).slice(0, 2).join(' ');
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/u.test(key)) throw new Error('Unexpected SSH public key format.');
  const account = user.replace(/'/gu, "'\\''");
  const payload = key.replace(/'/gu, "'\\''");
  const script = `set -eu
u='${account}'
h=$(getent passwd "$u" | cut -d: -f6)
[ -n "$h" ] || { echo "No home directory for $u" >&2; exit 1; }
install -d -m 700 -o "$u" -g "$(id -gn "$u")" "$h/.ssh"
touch "$h/.ssh/authorized_keys"
chown "$u":"$(id -gn "$u")" "$h/.ssh/authorized_keys"
chmod 600 "$h/.ssh/authorized_keys"
grep -qxF '${payload}' "$h/.ssh/authorized_keys" || printf '%s\\n' '${payload}' >> "$h/.ssh/authorized_keys"
echo 'authorized key installed'`;
  await runPrivileged('sh', ['-c', script], { platform, timeout: 30000 });
}

/** Validate the cached OpenSSH zip before it is handed to PowerShell. */
export async function verifyOpenSshZip(file: string, manifest: OpenSshAssetManifest): Promise<void> {
  const data = await readFile(file);
  if (data.length !== manifest.bytes) {
    throw new Error(`OpenSSH asset size mismatch (${data.length} != ${manifest.bytes}).`);
  }
  const digest = createHash('sha256').update(data).digest('hex');
  if (digest !== manifest.sha256.toLowerCase()) {
    throw new Error('OpenSSH asset checksum mismatch.');
  }
}

/** PowerShell that replaces/reinstalls OpenSSH Server and enrolls the key. */
export function windowsInstallScript(
  publicKey: string,
  user: string | null,
): string {
  const key = quotePowerShell(publicKey);
  const account = user && SSH_USER_PATTERN.test(user) ? quotePowerShell(user) : '';
  return `param([string]$Zip)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$dest = 'C:\\Program Files\\OpenSSH'
$key = '${key}'
$user = '${account}'
$zip = $Zip
if (-not (Test-Path $zip)) { throw "OpenSSH zip not found: $zip" }
$tmp = Join-Path $env:TEMP ('dsh-openssh-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
  $root = Get-ChildItem $tmp -Directory | Select-Object -First 1
  $source = if ($root) { $root.FullName } else { $tmp }
  Get-Process sshd,sshd-session,sshd-auth,ssh-shellhost -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Stop-Service sshd -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $dest | Out-Null
  Copy-Item -Path (Join-Path $source '*') -Destination $dest -Recurse -Force
  $installer = Join-Path $dest 'install-sshd.ps1'
  if (Test-Path $installer) {
    Push-Location $dest
    try { & $installer } finally { Pop-Location }
  }
  $sshKeygen = Join-Path $dest 'ssh-keygen.exe'
  $sshdConfig = Join-Path $env:ProgramData 'ssh\sshd_config'
  $defaultConfig = Join-Path $dest 'sshd_config_default'
  if (-not (Test-Path $sshdConfig) -and (Test-Path $defaultConfig)) {
    New-Item -ItemType Directory -Force (Split-Path $sshdConfig) | Out-Null
    Copy-Item $defaultConfig $sshdConfig -Force
  }
  foreach ($kind in @('rsa', 'ecdsa', 'ed25519')) {
    $hostKey = Join-Path $env:ProgramData ('ssh\\ssh_host_' + $kind + '_key')
    if ((Test-Path $sshKeygen) -and -not (Test-Path $hostKey)) {
      & $sshKeygen -q -t $kind -N '' -f $hostKey
    }
  }
  if (Test-Path (Join-Path $env:ProgramData 'ssh')) {
    Get-ChildItem (Join-Path $env:ProgramData 'ssh') -Filter 'ssh_host_*_key' -File -ErrorAction SilentlyContinue |
      ForEach-Object { icacls $_.FullName /inheritance:r /grant 'SYSTEM:F' /grant 'Administrators:F' | Out-Null }
  }
  $service = Get-Service sshd -ErrorAction SilentlyContinue
  if (-not $service) {
    New-Service -Name sshd -BinaryPathName "\`"$dest\\sshd.exe\`"" -StartupType Automatic -DisplayName 'OpenSSH SSH Server' | Out-Null
  } else {
    Set-Service -Name sshd -StartupType Automatic
  }
  if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH SSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
  }
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  if (($machinePath -split ';') -notcontains $dest) {
    [Environment]::SetEnvironmentVariable('Path', $machinePath.TrimEnd(';') + ';' + $dest, 'Machine')
  }
  $admin = Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'
  $files = @($admin)
  if ($user) { $files += Join-Path (Join-Path 'C:\\Users' $user) '.ssh\\authorized_keys' }
  foreach ($file in $files) {
    New-Item -ItemType Directory -Force (Split-Path $file) | Out-Null
    if (-not (Test-Path $file)) { New-Item -ItemType File -Path $file | Out-Null }
    $lines = @(Get-Content $file -ErrorAction SilentlyContinue)
    if ($lines -notcontains $key) { Add-Content -Path $file -Value $key -Encoding ascii }
  }
  icacls $admin /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
  Set-Service sshd -StartupType Automatic
  Start-Service sshd
  Start-Sleep -Seconds 2
  Get-Service sshd | Select-Object Status, Name | ConvertTo-Json -Compress
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}`;
}

/** Run the Windows OpenSSH installer with the cached asset. */
export async function installWindowsOpenSsh(
  platform: PlatformInfo,
  zipPath: string,
  publicKey: string,
  user: string | null,
): Promise<string> {
  if (!platform.isWindows) throw new Error('OpenSSH auto-install is only implemented for Windows.');
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-ssh-install-'));
  const scriptPath = path.join(directory, 'install-openssh.ps1');
  try {
    await writeFile(scriptPath, `${windowsInstallScript(publicKey, user)}\n`, 'utf8');
    const result = await runPrivileged('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-Zip',
      zipPath,
    ], { platform, timeout: 240000 });
    return `${result.stdout}\n${result.stderr}`.trim();
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
