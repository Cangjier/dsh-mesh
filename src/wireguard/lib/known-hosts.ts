/**
 * known_hosts maintenance for WireGuard peers.
 *
 * The WireGuard panel only installs the server's login key on the peer. The
 * peer's own sshd host key is a different thing: it is regenerated whenever the
 * machine is reinstalled, and a freed VPN address can later belong to another
 * machine. Both cases make the old known_hosts entry stale, so authorization
 * also refreshes the host key that SSH will trust.
 */

import { execFile } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Where the current user keeps its SSH host keys. */
export function knownHostsPath(): string {
  return path.join(homedir(), '.ssh', 'known_hosts');
}

/**
 * Keep only host-key lines from ssh-keyscan output.
 * @param {string} output ssh-keyscan stdout.
 * @returns {string[]} one entry per offered host key.
 */
export function parseScannedHostKeys(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * Replace the known_hosts entries of one address with the keys the host
 * currently offers. `ssh-keygen -R` removes both plain and hashed entries.
 * @param {string} host address to scan.
 * @param {number} [port] SSH port.
 * @param {{ file?: string }} [options] known_hosts override for tests.
 * @returns {Promise<string[]>} the keys that were trusted.
 */
export async function refreshKnownHosts(host: string, port = 22, options: { file?: string } = {}): Promise<string[]> {
  const scan = await execFileAsync('ssh-keyscan', ['-T', '8', '-p', String(port), host], {
    timeout: 20_000,
    windowsHide: true,
  });
  const keys = parseScannedHostKeys(String(scan.stdout ?? ''));
  if (keys.length === 0) throw new Error('ssh-keyscan returned no host keys');
  const file = options.file ?? knownHostsPath();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const target = port === 22 ? host : `[${host}]:${port}`;
  try {
    await execFileAsync('ssh-keygen', ['-R', target, '-f', file], { timeout: 10_000, windowsHide: true });
  } catch {
    // A missing known_hosts file is fine; the append recreates it.
  }
  await appendFile(file, `${keys.join('\n')}\n`, { mode: 0o600 });
  return keys;
}

/**
 * Drop the known_hosts entries of one address, so a reused VPN address cannot
 * match the old machine's keys.
 * @param {string} host address to forget.
 * @param {number} [port] SSH port.
 * @param {{ file?: string }} [options] known_hosts override for tests.
 * @returns {Promise<void>}
 */
export async function forgetKnownHosts(host: string, port = 22, options: { file?: string } = {}): Promise<void> {
  const file = options.file ?? knownHostsPath();
  const target = port === 22 ? host : `[${host}]:${port}`;
  try {
    await execFileAsync('ssh-keygen', ['-R', target, '-f', file], { timeout: 10_000, windowsHide: true });
  } catch {
    // Nothing to remove, or no known_hosts file yet.
  }
}
