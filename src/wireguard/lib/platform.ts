/** Host platform detection, command execution, and the one privilege boundary. */

import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { accessSync, constants as syncConstants } from 'node:fs';
import { networkInterfaces, hostname as osHostname } from 'node:os';
import path from 'node:path';
import { WireGuardError } from './errors';

const IS_WINDOWS = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const PATH_EXTENSIONS = IS_WINDOWS ? ['.exe', '.cmd', ''] : [''];

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeout?: number;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export interface CommandDetails {
  command: string;
  args: readonly string[];
  exitCode?: number | string;
  signal?: string;
  stdout?: string;
  stderr?: string;
}

/** A failed child process, retaining the exact command for diagnostics. */
export class CommandError extends Error {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode?: number | string;
  readonly signal?: string;
  readonly stdout: string;
  readonly stderr: string;

  constructor(message: string, details: CommandDetails) {
    super(message);
    this.name = 'CommandError';
    this.command = details.command;
    this.args = details.args;
    this.exitCode = details.exitCode;
    this.signal = details.signal;
    this.stdout = details.stdout ?? '';
    this.stderr = details.stderr ?? '';
  }
}

/**
 * Execute one program without a shell.
 */
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        timeout: options.timeout ?? 20000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8',
        cwd: options.cwd,
        env: {
          ...process.env,
          LC_ALL: 'C',
          LANG: 'C',
          ...options.env,
        },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
          return;
        }
        const detail = String(stderr || stdout || error.message).trim().slice(0, 800);
        reject(new CommandError(`${path.basename(command)} failed${detail ? `: ${detail}` : ''}`, {
          command,
          args,
          exitCode: error.code,
          signal: error.signal,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        }));
      },
    );
    child.once('error', (error: NodeJS.ErrnoException) => {
      reject(new CommandError(`${path.basename(command)} could not start: ${error.message}`, {
        command,
        args,
        exitCode: error.code,
      }));
    });
  });
}

/**
 * Find a program in the declared locations or PATH.
 * @param {string} name executable basename without extension.
 * @param {readonly string[]} candidates absolute candidates checked first.
 * @returns {string | null} absolute or PATH-resolved executable, or null.
 */
export function findExecutable(name: string, candidates: readonly string[] = []): string | null {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, syncConstants.X_OK);
      return candidate;
    } catch {
      // Try the next location.
    }
  }
  const directories = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const extension of PATH_EXTENSIONS) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        accessSync(candidate, syncConstants.X_OK);
        return candidate;
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  return null;
}

/**
 * Whether a path is executable (or exists on Windows).
 * @param {string} candidate absolute path.
 * @returns {Promise<boolean>} availability.
 */
export async function executableExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, IS_WINDOWS ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect whether this process can change the WireGuard interface.
 * @returns {Promise<boolean>} effective privilege.
 */
export async function detectAdmin(): Promise<boolean> {
  if (IS_LINUX) return typeof process.getuid === 'function' && process.getuid() === 0;
  if (!IS_WINDOWS) return false;
  try {
    await run('fltmc.exe', ['filters'], { timeout: 5000 });
    return true;
  } catch {
    try {
      await run('net.exe', ['session'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}

export interface PlatformInfo {
  platform: string;
  isWindows: boolean;
  isLinux: boolean;
  admin: boolean;
  wg: string | null;
  wireguard: string | null;
  ip: string | null;
  sudo: string | null;
  iptables: string | null;
  nft: string | null;
  sysctl: string | null;
}

/**
 * Discover the executables this plugin needs on the current OS.
 */
export async function detectPlatform(): Promise<PlatformInfo> {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const windowsCandidates = [
    path.join(programFiles, 'WireGuard'),
    path.join(programFilesX86, 'WireGuard'),
    ...(localAppData ? [path.join(localAppData, 'Programs', 'WireGuard')] : []),
  ];
  const wg = IS_WINDOWS
    ? findExecutable('wg', windowsCandidates.map((directory) => path.join(directory, 'wg.exe')))
    : findExecutable('wg', ['/usr/bin/wg', '/usr/sbin/wg', '/usr/local/bin/wg']);
  const wireguard = IS_WINDOWS
    ? findExecutable('wireguard', windowsCandidates.map((directory) => path.join(directory, 'wireguard.exe')))
    : null;
  const ip = IS_LINUX ? findExecutable('ip', ['/usr/sbin/ip', '/sbin/ip', '/usr/bin/ip']) : null;
  return {
    platform: process.platform,
    isWindows: IS_WINDOWS,
    isLinux: IS_LINUX,
    admin: await detectAdmin(),
    wg,
    wireguard,
    ip,
    sudo: IS_LINUX ? findExecutable('sudo', ['/usr/bin/sudo', '/bin/sudo']) : null,
    iptables: IS_LINUX ? findExecutable('iptables', ['/usr/sbin/iptables', '/sbin/iptables']) : null,
    nft: IS_LINUX ? findExecutable('nft', ['/usr/sbin/nft', '/usr/bin/nft']) : null,
    sysctl: IS_LINUX ? findExecutable('sysctl', ['/usr/sbin/sysctl', '/sbin/sysctl', '/usr/bin/sysctl']) : null,
  };
}

/**
 * Run a command with root or administrator rights, or fail with a concrete
 * privilege error. Linux uses non-interactive sudo so a GUI action never hangs.
 * @param {string} command executable path.
 * @param {readonly string[]} args arguments.
 * @param {{ platform: Awaited<ReturnType<typeof detectPlatform>>, timeout?: number }} options
 * @returns {Promise<{ stdout: string, stderr: string }>} captured output.
 */
export async function runPrivileged(
  command: string,
  args: readonly string[],
  options: { platform: PlatformInfo; timeout?: number },
): Promise<CommandResult> {
  const { platform } = options;
  if (platform.isWindows || platform.admin) {
    return run(command, args, { timeout: options.timeout });
  }
  const sudo = platform.sudo;
  if (!sudo) {
    throw new WireGuardError('needs_privilege', 'WireGuard needs administrator rights, and sudo was not found.', {
      status: 403,
      hint: 'Run Harness as root, or install sudo and allow passwordless execution for the WireGuard commands.',
      command: `sudo ${command} ${args.join(' ')}`,
    });
  }
  try {
    return await run(sudo, ['-n', command, ...args], { timeout: options.timeout });
  } catch (error) {
    const text = error instanceof CommandError ? `${error.stderr}\n${error.stdout}` : String(error);
    if (/password is required|a terminal is required|not allowed|permission denied/i.test(text)) {
      throw new WireGuardError('needs_privilege', 'WireGuard needs administrator rights, but passwordless sudo is not available.', {
        status: 403,
        hint: 'Run “sudo -v” in a terminal to authorize this user, then press Retry. For unattended use, run Harness as root or configure passwordless sudo for wg and ip.',
        command: `${sudo} -v`,
        details: { stderr: text.trim().slice(0, 500) },
      });
    }
    throw error;
  }
}

/**
 * Pick the most likely LAN address clients can reach.
 * @returns {{ address: string, interfaceName: string } | null} preferred address.
 */
export function detectLanAddress(): { address: string; interfaceName: string } | null {
  const candidates = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      const octets = address.address.split('.').map(Number);
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

/**
 * Pick a global IPv6 address for IPv6 deployment targets.
 * @returns {string | null} global IPv6 address without a zone.
 */
export function detectGlobalIpv6(): string | null {
  const candidates: string[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      const family = address.family === 'IPv6' || (address.family as unknown) === 6;
      if (!family || address.internal) continue;
      const host = address.address.split('%')[0];
      if (host === '::1' || /^fe80:/i.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host)) continue;
      if (/(docker|br-|veth|tun|tap|VirtualBox|VMware|Hyper-V)/i.test(name)) continue;
      candidates.push(host);
    }
  }
  return candidates.find((host) => host.length > 0) ?? null;
}

/**
 * This machine's display name, safe for a peer record.
 * @returns {string} hostname or `this-device`.
 */
export function localHostname(): string {
  const value = osHostname().replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return value || 'this-device';
}

/**
 * Quote one argument for a copyable shell command.
 * @param {string} value argument.
 * @returns {string} shell-safe-ish display text.
 */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+@%^,-]+$/.test(value)) return value;
  if (IS_WINDOWS) return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
