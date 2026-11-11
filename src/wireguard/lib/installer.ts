/** Best-effort, user-initiated WireGuard installation for Windows and Linux. */

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { WireGuardError } from './errors';
import { detectPlatform, findExecutable, run, type PlatformInfo } from './platform';

const WINDOWS_INSTALLER_URL = 'https://download.wireguard.com/windows-client/wireguard-installer.exe';
const WINDOWS_INSTALLER_MAX_BYTES = 128 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 180_000;

export interface InstallOutcome {
  method: string;
  message: string;
  installerPath?: string;
  command?: string;
}

interface PackageManager {
  name: string;
  args: string[];
  env?: Record<string, string>;
}

const LINUX_MANAGERS: PackageManager[] = [
  { name: 'apt-get', args: ['install', '-y', 'wireguard', 'iproute2'], env: { DEBIAN_FRONTEND: 'noninteractive' } },
  { name: 'dnf', args: ['install', '-y', 'wireguard-tools'] },
  { name: 'yum', args: ['install', '-y', 'wireguard-tools'] },
  { name: 'pacman', args: ['-S', '--noconfirm', 'wireguard-tools'] },
  { name: 'zypper', args: ['--non-interactive', 'install', 'wireguard-tools'] },
  { name: 'apk', args: ['add', 'wireguard-tools'] },
];

/**
 * Download a file with a hard size limit and no shell.
 */
async function download(url: string, target: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INSTALL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'dsh-wireguard/0.2' },
    });
    if (!response.ok || !response.body) {
      throw new WireGuardError('download_failed', `WireGuard installer download failed with HTTP ${response.status}.`, {
        status: 502,
        hint: 'Check the machine’s internet access, or download the installer manually from https://www.wireguard.com/install/.',
      });
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > WINDOWS_INSTALLER_MAX_BYTES) {
      throw new WireGuardError('download_failed', 'The WireGuard installer is unexpectedly large.', { status: 502 });
    }
    await mkdir(path.dirname(target), { recursive: true });
    await pipeline(Readable.fromWeb(response.body as any), createWriteStream(target, { mode: 0o700 }));
  } catch (error) {
    if (error instanceof WireGuardError) throw error;
    throw new WireGuardError('download_failed', 'Could not download the WireGuard installer.', {
      status: 502,
      hint: 'Check internet access, proxy settings, then retry. You can also install WireGuard manually and press Recheck.',
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort tool detection after an installer exits; services and PATHs can
 * take a moment to settle.
 */
async function waitForTools(): Promise<PlatformInfo> {
  let latest = await detectPlatform();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (latest.wg && (!latest.isWindows || latest.wireguard)) return latest;
    await delay(500);
    latest = await detectPlatform();
  }
  return latest;
}

/**
 * Install the official WireGuard client on Windows. When Harness is elevated
 * the installer runs silently; otherwise it is launched through UAC so the
 * user explicitly authorizes the system change.
 */
async function installWindows(platform: PlatformInfo, dataDir: string, log: (line: string) => void): Promise<InstallOutcome> {
  const installerPath = path.join(dataDir, 'wireguard-installer.exe');
  try {
    log(`downloading WireGuard installer to ${installerPath}`);
    await download(WINDOWS_INSTALLER_URL, installerPath);
  } catch (downloadError) {
    // The official download host can be blocked on managed networks. Winget is
    // a safe fallback because Windows validates the package source.
    const winget = findExecutable('winget');
    if (!winget) throw downloadError;
    log('official installer download failed; trying winget');
    try {
      await run(winget, [
        'install', '--id', 'WireGuard.WireGuard', '-e', '--silent',
        '--accept-package-agreements', '--accept-source-agreements',
      ], { timeout: INSTALL_TIMEOUT_MS });
      const installed = await waitForTools();
      if (installed.wg && installed.wireguard) {
        return { method: 'winget', message: 'WireGuard installed with winget.' };
      }
    } catch (wingetError) {
      log(`winget fallback failed: ${wingetError instanceof Error ? wingetError.message : String(wingetError)}`);
    }
    throw downloadError;
  }
  if (platform.admin) {
    try {
      await run(installerPath, ['/S'], { timeout: INSTALL_TIMEOUT_MS });
      log('WireGuard installer completed silently');
    } catch (error) {
      throw new WireGuardError('install_failed', 'The WireGuard installer exited with an error.', {
        status: 500,
        hint: 'Run the downloaded installer manually, or install WireGuard from the official website and press Recheck.',
        command: `"${installerPath}" /S`,
        details: { cause: error instanceof Error ? error.message : String(error) },
      });
    }
  } else {
    const script = `$p = Start-Process -FilePath '${installerPath.replace(/'/g, "''")}' -ArgumentList '/S' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
    try {
      await run('powershell.exe', ['-NoProfile', '-Command', script], { timeout: INSTALL_TIMEOUT_MS });
      log('WireGuard installer accepted the UAC prompt');
    } catch (error) {
      throw new WireGuardError('needs_privilege', 'The WireGuard installer needs administrator approval.', {
        status: 403,
        hint: 'Approve the Windows UAC prompt, or close Harness and start it as administrator. The installer was downloaded and can also be run manually.',
        command: `"${installerPath}" /S`,
        details: { cause: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  const latest = await waitForTools();
  if (!latest.wg || !latest.wireguard) {
    throw new WireGuardError('install_incomplete', 'The WireGuard installer finished, but the tools were not detected yet.', {
      status: 503,
      hint: 'Restart Harness (or press Recheck after a few seconds). The official installer is in the plugin data directory.',
      command: `"${installerPath}"`,
      details: { installerPath },
    });
  }
  return { method: 'windows', message: 'WireGuard for Windows installed.', installerPath };
}

/**
 * Install WireGuard tools with the host package manager. The command is
 * explicit in the failure path so a Linux server administrator can run it once
 * with sudo.
 */
async function installLinux(platform: PlatformInfo, log: (line: string) => void): Promise<InstallOutcome> {
  const managerEntry = LINUX_MANAGERS
    .map((candidate) => ({ candidate, executable: findExecutable(candidate.name) }))
    .find((entry) => entry.executable);
  if (!managerEntry || !managerEntry.executable) {
    throw new WireGuardError('no_package_manager', 'No supported package manager was found for automatic installation.', {
      status: 503,
      hint: 'Install WireGuard manually: sudo apt install wireguard iproute2 (or the equivalent for this distribution), then press Recheck.',
    });
  }
  const manager = managerEntry.candidate;
  const executable = managerEntry.executable;
  const command = `${manager.name} ${manager.args.join(' ')}`;
  log(`installing WireGuard with ${command}`);
  try {
    if (platform.admin) {
      await run(executable, manager.args, { timeout: INSTALL_TIMEOUT_MS, env: manager.env });
    } else if (platform.sudo) {
      await run(platform.sudo, ['-n', executable, ...manager.args], {
        timeout: INSTALL_TIMEOUT_MS,
        env: manager.env,
      });
    } else {
      throw new WireGuardError('needs_privilege', 'Installing WireGuard needs administrator rights.', {
        status: 403,
        hint: 'Run the command below in a terminal, then press Recheck.',
        command: `sudo ${command}`,
      });
    }
  } catch (error) {
    if (error instanceof WireGuardError && !platform.sudo) throw error;
    const text = error instanceof Error ? `${error.message}` : String(error);
    if (platform.admin || !/password|terminal|permission|not allowed|access is denied/i.test(text)) {
      throw new WireGuardError('install_failed', 'The package manager could not install WireGuard.', {
        status: 500,
        hint: 'Check internet access and package-manager output, or run the command below in a terminal.',
        command: `sudo ${command}`,
        details: { cause: text },
      });
    }
    // sudo -n is intentionally tried first so a GUI action never hangs. A
    // desktop polkit agent can still authorize the package manager once.
    const pkexec = findExecutable('pkexec', ['/usr/bin/pkexec']);
    if (pkexec) {
      try {
        await run(pkexec, [executable, ...manager.args], { timeout: INSTALL_TIMEOUT_MS, env: manager.env });
        log('WireGuard package installation accepted by polkit');
      } catch (polkitError) {
        throw new WireGuardError('needs_privilege', 'Installing WireGuard needs administrator rights.', {
          status: 403,
          hint: 'Run the command below in a terminal, then press Recheck. For unattended use, run Harness as root or allow passwordless sudo for the package manager.',
          command: `sudo ${command}`,
          details: { cause: polkitError instanceof Error ? polkitError.message : String(polkitError) },
        });
      }
    } else {
      throw new WireGuardError('needs_privilege', 'Installing WireGuard needs administrator rights.', {
        status: 403,
        hint: 'Run the command below in a terminal, then press Recheck.',
        command: `sudo ${command}`,
        details: { cause: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  const latest = await waitForTools();
  if (!latest.wg || !latest.ip) {
    throw new WireGuardError('install_incomplete', 'The package manager finished, but WireGuard tools were not detected yet.', {
      status: 503,
      hint: 'Install the missing package or restart Harness, then press Recheck.',
      command: `sudo ${command}`,
    });
  }
  return { method: manager.name, message: `WireGuard tools installed with ${manager.name}.`, command: `sudo ${command}` };
}

/**
 * Install WireGuard for the current platform.
 * @param platform detected host facts.
 * @param dataDir durable plugin data directory.
 * @param log diagnostic sink.
 */
export async function installWireGuard(
  platform: PlatformInfo,
  dataDir: string,
  log: (line: string) => void,
): Promise<InstallOutcome> {
  if (platform.wg && (!platform.isWindows || platform.wireguard)) {
    return { method: 'already-installed', message: 'WireGuard is already installed.' };
  }
  if (platform.isWindows) return installWindows(platform, dataDir, log);
  if (platform.isLinux) return installLinux(platform, log);
  throw new WireGuardError('unsupported_platform', 'Automatic installation is supported on Windows and Linux only.', {
    status: 503,
    hint: `This host reports ${platform.platform}.`,
  });
}
