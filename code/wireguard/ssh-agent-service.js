// src/wireguard/ssh-agent-service.ts
import { appendFile, mkdir, mkdtemp as mkdtemp2, readFile as readFile2, rm as rm2, writeFile as writeFile2 } from "node:fs/promises";
import { tmpdir as tmpdir2, hostname as osHostname2 } from "node:os";
import path3 from "node:path";

// src/wireguard/lib/platform.ts
import { execFile } from "node:child_process";
import { accessSync, constants as syncConstants } from "node:fs";
import path from "node:path";

// src/wireguard/lib/errors.ts
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

// src/wireguard/lib/platform.ts
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

// src/wireguard/lib/ssh-agent.ts
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir, hostname as osHostname, userInfo } from "node:os";
import path2 from "node:path";

// src/wireguard/lib/ssh.ts
var SSH_USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;

// src/wireguard/lib/ssh-agent.ts
var WINDOWS_INSTALL_DIR = "C:\\Program Files\\OpenSSH";
var WINDOWS_SSHD_CANDIDATES = [
  path2.join(WINDOWS_INSTALL_DIR, "sshd.exe"),
  "C:\\Windows\\System32\\OpenSSH\\sshd.exe"
];
function cleanUser(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/^.*\\/u, "");
  if (!name || /^(system|localsystem|nt authority)$/iu.test(name)) return null;
  return SSH_USER_PATTERN.test(name) ? name : null;
}
async function testSshBanner(port = 22, timeout = 2500) {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(timeout);
    socket.once("data", (chunk) => {
      const text = chunk.subarray(0, 64).toString("ascii");
      finish(text.startsWith("SSH-"));
    });
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}
async function windowsInteractiveUser() {
  try {
    const result = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='SilentlyContinue'; $u=(Get-CimInstance Win32_ComputerSystem).UserName; if(-not $u){$u=(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | ForEach-Object { $_.GetOwner().User } | Select-Object -First 1)}; if($u){$u.Split('\\')[-1]}`
    ], { timeout: 8e3 });
    const user = cleanUser(result.stdout);
    if (user) return user;
  } catch {
  }
  try {
    const result = await run("query.exe", ["user"], { timeout: 8e3 });
    const lines = result.stdout.split(/\r?\n/u).slice(1).filter((line) => line.trim());
    const rows = lines.map((line) => line.trim().split(/\s+/u)).filter((row) => row.length >= 4);
    const consoleRow = rows.find((row) => row[1]?.toLowerCase() === "console" && /active/iu.test(row[3] ?? ""));
    const activeRow = consoleRow ?? rows.find((row) => /active/iu.test(row[3] ?? ""));
    return cleanUser(activeRow?.[0]);
  } catch {
    return null;
  }
}
async function linuxInteractiveUser() {
  try {
    const current = cleanUser(userInfo().username);
    if (current && typeof process.getuid === "function" && process.getuid() !== 0) return current;
  } catch {
  }
  try {
    const result = await run("who", [], { timeout: 5e3 });
    for (const line of result.stdout.split(/\r?\n/u)) {
      const user = cleanUser(line.trim().split(/\s+/u)[0]);
      if (user) return user;
    }
  } catch {
  }
  try {
    const result = await run("loginctl", ["list-sessions", "--no-legend"], { timeout: 5e3 });
    for (const line of result.stdout.split(/\r?\n/u)) {
      const fields = line.trim().split(/\s+/u);
      const user = cleanUser(fields[2]);
      if (user) return user;
    }
  } catch {
  }
  return null;
}
async function detectInteractiveUser(platform) {
  if (platform.isWindows) return await windowsInteractiveUser();
  if (platform.isLinux) return await linuxInteractiveUser();
  return null;
}
async function readSshVersion(sshd) {
  try {
    const result = await run(sshd, ["-V"], { timeout: 5e3 });
    const text = `${result.stdout}
${result.stderr}`.trim();
    const line = text.split(/\r?\n/u).find((item) => item.trim()) ?? "";
    return line.trim().slice(0, 120) || null;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const match = /OpenSSH[_A-Za-z0-9.\- p]+/u.exec(text);
    return match?.[0]?.trim().slice(0, 120) ?? null;
  }
}
async function inspectSsh(platform) {
  const hostname = osHostname();
  const user = await detectInteractiveUser(platform);
  let installed = false;
  let running = false;
  let serviceRunning = false;
  let version = null;
  let sshd = null;
  if (platform.isWindows) {
    sshd = WINDOWS_SSHD_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
    installed = sshd !== null;
    try {
      const result = await run("sc.exe", ["query", "sshd"], { timeout: 5e3 });
      serviceRunning = /RUNNING/iu.test(result.stdout);
    } catch {
      serviceRunning = false;
    }
    running = serviceRunning;
  } else if (platform.isLinux) {
    sshd = findExecutable("sshd", ["/usr/sbin/sshd", "/usr/local/sbin/sshd"]);
    installed = sshd !== null;
    for (const unit of ["sshd", "ssh"]) {
      try {
        const result = await run("systemctl", ["is-active", unit], { timeout: 4e3 });
        if (result.stdout.trim() === "active") {
          running = true;
          serviceRunning = true;
          break;
        }
      } catch {
      }
    }
    if (!running) {
      try {
        const result = await run("pgrep", ["-x", "sshd"], { timeout: 4e3 });
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
  if (ready) {
    installed = true;
    running = true;
  }
  let error = null;
  if (!installed) error = "OpenSSH Server is not installed";
  else if (!running) error = "OpenSSH Server is not running";
  else if (!ready) error = "sshd is running but did not send an SSH banner";
  else if (!user) error = "Could not determine the interactive Windows/Linux user";
  return { installed, running, serviceRunning, ready, version, port: 22, user, hostname, error };
}
function quotePowerShell(value) {
  return value.replace(/'/gu, "''");
}
function windowsAuthorizeKeyScript(publicKey, user) {
  const key = quotePowerShell(publicKey);
  const account = user && SSH_USER_PATTERN.test(user) ? quotePowerShell(user) : "";
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
async function authorizeWindowsKey(platform, publicKey, user) {
  const directory = await mkdtemp(path2.join(tmpdir(), "dsh-ssh-key-"));
  const scriptPath = path2.join(directory, "authorize.ps1");
  try {
    await writeFile(scriptPath, `${windowsAuthorizeKeyScript(publicKey, user)}
`, "utf8");
    await runPrivileged("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath
    ], { platform, timeout: 3e4 });
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {
    });
  }
}
async function authorizeLinuxKey(platform, publicKey, user) {
  if (!user || !SSH_USER_PATTERN.test(user)) throw new Error("No usable Linux login user was detected.");
  const key = publicKey.trim().split(/\s+/u).slice(0, 2).join(" ");
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/u.test(key)) throw new Error("Unexpected SSH public key format.");
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
  await runPrivileged("sh", ["-c", script], { platform, timeout: 3e4 });
}
async function verifyOpenSshZip(file, manifest) {
  const data = await readFile(file);
  if (data.length !== manifest.bytes) {
    throw new Error(`OpenSSH asset size mismatch (${data.length} != ${manifest.bytes}).`);
  }
  const digest = createHash("sha256").update(data).digest("hex");
  if (digest !== manifest.sha256.toLowerCase()) {
    throw new Error("OpenSSH asset checksum mismatch.");
  }
}
function windowsInstallScript(publicKey, user) {
  const key = quotePowerShell(publicKey);
  const account = user && SSH_USER_PATTERN.test(user) ? quotePowerShell(user) : "";
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
  $sshdConfig = Join-Path $env:ProgramData 'sshsshd_config'
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
async function installWindowsOpenSsh(platform, zipPath, publicKey, user) {
  if (!platform.isWindows) throw new Error("OpenSSH auto-install is only implemented for Windows.");
  const directory = await mkdtemp(path2.join(tmpdir(), "dsh-ssh-install-"));
  const scriptPath = path2.join(directory, "install-openssh.ps1");
  try {
    await writeFile(scriptPath, `${windowsInstallScript(publicKey, user)}
`, "utf8");
    const result = await runPrivileged("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-Zip",
      zipPath
    ], { platform, timeout: 24e4 });
    return `${result.stdout}
${result.stderr}`.trim();
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {
    });
  }
}

// src/wireguard/ssh-agent-service.ts
var DEFAULT_INTERVAL = 5 * 6e4;
var INSTALL_RETRY = 15 * 6e4;
var lastInstallAttempt = 0;
function defaultConfigPath() {
  const configured = String(process.env.DSH_SSH_AGENT_CONFIG ?? "").trim();
  if (configured) return configured;
  if (process.platform === "win32") {
    return path3.join(process.env.ProgramData ?? "C:\\ProgramData", "dsh-mesh", "ssh-agent.json");
  }
  return "/etc/dsh-mesh/ssh-agent.json";
}
var configPath = defaultConfigPath();
var logPath = path3.join(path3.dirname(configPath), "ssh-agent.log");
async function log(line) {
  const text = `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
`;
  process.stdout.write(text);
  try {
    await mkdir(path3.dirname(logPath), { recursive: true });
    await appendFile(logPath, text, "utf8");
  } catch {
  }
}
async function loadConfig() {
  const raw = JSON.parse(await readFile2(configPath, "utf8"));
  const serverUrl = String(raw.serverUrl ?? "").trim().replace(/\/+$/u, "");
  const publicKey = String(raw.publicKey ?? "").trim();
  if (!/^https?:\/\/[^\s]+$/u.test(serverUrl)) throw new Error("serverUrl must be an http(s) URL");
  if (!/^[A-Za-z0-9+/=]{40,}$/u.test(publicKey)) throw new Error("publicKey is not a WireGuard key");
  return {
    serverUrl,
    publicKey,
    joinCode: typeof raw.joinCode === "string" ? raw.joinCode : void 0,
    token: typeof raw.token === "string" && raw.token ? raw.token : void 0,
    intervalMs: Number.isSafeInteger(raw.intervalMs) && raw.intervalMs >= 3e4 ? raw.intervalMs : DEFAULT_INTERVAL,
    autoInstall: raw.autoInstall !== false
  };
}
async function saveConfig(config) {
  await mkdir(path3.dirname(configPath), { recursive: true });
  await writeFile2(configPath, `${JSON.stringify(config, null, 2)}
`, { encoding: "utf8", mode: 384 });
}
async function httpJson(config, route, body, timeout = 12e3) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${config.serverUrl}${route}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error"
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = { ok: false, error: { message: text.slice(0, 300) } };
    }
    if (!response.ok || data?.ok === false) {
      const error = new Error(String(data?.error?.message ?? `HTTP ${response.status}`));
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}
async function httpGetJson(config, route, token, timeout = 12e3) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${config.serverUrl}${route}`, {
      headers: { accept: "application/json", "x-dsh-peer-token": token },
      signal: controller.signal,
      redirect: "error"
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = { ok: false, error: { message: text.slice(0, 300) } };
    }
    if (!response.ok || data?.ok === false) {
      const error = new Error(String(data?.error?.message ?? `HTTP ${response.status}`));
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}
async function ensureToken(config) {
  if (config.token) return config;
  if (!config.joinCode) throw new Error("no token and no joinCode in the agent config");
  const platform = process.platform === "win32" ? "windows" : "linux";
  const joined = await httpJson(config, "/join", {
    name: osHostname2(),
    publicKey: config.publicKey,
    code: config.joinCode,
    family: "",
    platform
  });
  const token = typeof joined.sshToken === "string" ? joined.sshToken : "";
  if (!token) throw new Error("the server did not return an SSH agent token");
  const next = { ...config, token };
  await saveConfig(next);
  await log("enrolled the SSH agent token through /join");
  return next;
}
async function fetchKey(config) {
  const data = await httpJson(config, "/ssh/key", { publicKey: config.publicKey, token: config.token });
  const publicKey = String(data.publicKey ?? "").trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/u.test(publicKey)) throw new Error("the server returned an invalid SSH public key");
  return publicKey;
}
async function fetchManifest(config) {
  const query = `publicKey=${encodeURIComponent(config.publicKey)}`;
  let data;
  try {
    data = await httpGetJson(config, `/assets/openssh?${query}`, String(config.token ?? ""));
  } catch {
    data = await httpJson(config, "/ssh/manifest", { publicKey: config.publicKey, token: config.token });
  }
  const entries = Array.isArray(data.assets) ? data.assets : [];
  const selected = entries.find((item) => item?.os === "windows" && item?.arch === "x64") ?? entries[0] ?? data;
  const manifest = {
    name: String(data.name ?? "openssh"),
    version: String(data.version ?? "unknown"),
    file: String(selected.file ?? ""),
    sha256: String(selected.sha256 ?? "").toLowerCase(),
    bytes: Number(selected.bytes)
  };
  if (!/^[A-Za-z0-9._-]+\.zip$/u.test(manifest.file) || !/^[0-9a-f]{64}$/u.test(manifest.sha256) || !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0) {
    throw new Error("the server returned an invalid OpenSSH manifest");
  }
  return manifest;
}
async function downloadAsset(config, manifest) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9e4);
  try {
    const query = `publicKey=${encodeURIComponent(config.publicKey)}`;
    const request = (url) => fetch(url, {
      headers: { accept: "application/zip", "x-dsh-peer-token": String(config.token ?? "") },
      signal: controller.signal,
      redirect: "error"
    });
    let response = await request(`${config.serverUrl}/assets/openssh/${encodeURIComponent(manifest.file)}?${query}`);
    if (response.status === 404) response = await request(`${config.serverUrl}/ssh/asset?${query}`);
    if (!response.ok) throw new Error(`the gateway refused the OpenSSH package (HTTP ${response.status})`);
    const data = Buffer.from(await response.arrayBuffer());
    const directory = await mkdtemp2(path3.join(tmpdir2(), "dsh-ssh-agent-"));
    const zipPath = path3.join(directory, manifest.file);
    await writeFile2(zipPath, data);
    await verifyOpenSshZip(zipPath, manifest);
    await log(`downloaded OpenSSH ${manifest.version} (${data.length} bytes)`);
    return zipPath;
  } finally {
    clearTimeout(timer);
  }
}
async function startFallbackDaemon() {
  const binary = "C:\\Program Files\\OpenSSH\\sshd.exe";
  const script = `if (Test-Path '${binary}') { Start-Process '${binary}' -ArgumentList '-D' -WindowStyle Hidden }`;
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 15e3 }).catch(() => void 0);
  await new Promise((resolve) => setTimeout(resolve, 2500));
}
async function report(config, status) {
  const error = status.ready ? null : status.error || "SSH is not ready";
  await httpJson(config, "/ssh/report", {
    publicKey: config.publicKey,
    token: config.token,
    user: status.user,
    platform: process.platform === "win32" ? "windows" : "linux",
    hostname: status.hostname,
    sshInstalled: status.installed,
    sshRunning: status.running,
    sshReady: status.ready,
    sshPort: status.port,
    sshVersion: status.version,
    sshError: error
  });
  await log(`reported ready=${String(status.ready)} user=${status.user ?? "-"}${error ? ` error=${error}` : ""}`);
}
async function tick(config) {
  const platform = await detectPlatform();
  let status = await inspectSsh(platform);
  const needsRepair = platform.isWindows && config.autoInstall !== false && (!status.installed || !status.ready || !status.serviceRunning);
  if (needsRepair && Date.now() - lastInstallAttempt >= INSTALL_RETRY) {
    lastInstallAttempt = Date.now();
    let zipPath = null;
    try {
      const publicKey = await fetchKey(config);
      const manifest = await fetchManifest(config);
      zipPath = await downloadAsset(config, manifest);
      await log("installing/repairing OpenSSH Server");
      await installWindowsOpenSsh(platform, zipPath, publicKey, status.user);
      status = await inspectSsh(platform);
      if (!status.ready) await startFallbackDaemon();
      status = await inspectSsh(platform);
    } catch (error) {
      status.error = `OpenSSH auto-install failed: ${error instanceof Error ? error.message : String(error)}`;
      await log(status.error);
      if (platform.isWindows) {
        await startFallbackDaemon();
        status = await inspectSsh(platform);
      }
    } finally {
      if (zipPath) {
        await rm2(path3.dirname(zipPath), { recursive: true, force: true }).catch(() => void 0);
      }
    }
  }
  if (status.ready && status.user) {
    try {
      const publicKey = await fetchKey(config);
      if (platform.isWindows) await authorizeWindowsKey(platform, publicKey, status.user);
      else await authorizeLinuxKey(platform, publicKey, status.user);
    } catch (error) {
      status.ready = false;
      status.error = `SSH key enrollment failed: ${error instanceof Error ? error.message : String(error)}`;
      await log(status.error);
    }
  }
  await report(config, status);
  return config;
}
async function main() {
  let config = null;
  while (config === null) {
    try {
      config = await loadConfig();
    } catch (error) {
      await log(`waiting for ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, 6e4));
    }
  }
  await log(`agent starting; server=${config.serverUrl} interval=${String(config.intervalMs)}ms`);
  while (true) {
    try {
      config = await ensureToken(config);
      config = await tick(config);
    } catch (error) {
      await log(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, config?.intervalMs ?? DEFAULT_INTERVAL));
  }
}
process.once("SIGTERM", () => process.exit(0));
process.once("SIGINT", () => process.exit(0));
main().catch((error) => {
  void log(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
