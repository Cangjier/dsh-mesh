/** WireGuard interface lifecycle for Linux (`ip` + `wg`) and Windows (`wireguard.exe`). */

import { setTimeout as delay } from 'node:timers/promises';
import { WireGuardError } from './errors';
import { CommandError, runPrivileged, type PlatformInfo } from './platform';

/**
 * Parse `wg show <interface> dump` without ever retaining the private key.
 * @param {string} stdout dump output.
 * @returns {{ publicKey: string, listenPort: number | null, peers: Array<Record<string, unknown>> }} status.
 */
export function parseWgDump(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) return { publicKey: '', listenPort: null, peers: [] };
  const header = lines[0].split('\t');
  const peers = [];
  for (const line of lines.slice(1)) {
    const columns = line.split('\t');
    if (columns.length < 8) continue;
    const handshakeSeconds = Number(columns[4]) || 0;
    peers.push({
      publicKey: columns[0],
      endpoint: columns[2] && columns[2] !== '(none)' ? columns[2] : null,
      allowedIps: columns[3] ?? '',
      lastHandshakeAt: handshakeSeconds > 0 ? new Date(handshakeSeconds * 1000).toISOString() : null,
      online: handshakeSeconds > 0 && Date.now() - handshakeSeconds * 1000 < 180_000,
      receivedBytes: Number(columns[5]) || 0,
      sentBytes: Number(columns[6]) || 0,
      persistentKeepalive: Number(columns[7]) === 0 ? null : Number(columns[7]),
    });
  }
  return {
    publicKey: header[1] ?? '',
    listenPort: header[2] ? Number(header[2]) : null,
    peers,
  };
}

/**
 * One platform-specific WireGuard interface.
 */
export class Tunnel {
  readonly platform: PlatformInfo;
  readonly log: (message: string) => void;

  constructor(options: { platform: PlatformInfo; log?: (message: string) => void }) {
    this.platform = options.platform;
    this.log = options.log ?? (() => {});
  }

  requireWg(): void {
    if (!this.platform.wg) {
      throw new WireGuardError('missing_wireguard', 'The WireGuard command-line tool `wg` was not found.', {
        status: 503,
        hint: this.platform.isWindows
          ? 'Install the official WireGuard client from https://www.wireguard.com/install/ and restart Harness.'
          : 'Install WireGuard tools, for example: sudo apt install wireguard iproute2',
      });
    }
  }

  /** @returns {void} */
  requireLinuxIp(): void {
    if (this.platform.isLinux && !this.platform.ip) {
      throw new WireGuardError('missing_tool', 'The `ip` command was not found.', {
        status: 503,
        hint: 'Install iproute2, for example: sudo apt install iproute2',
      });
    }
  }

  /** @returns {void} */
  requireWindowsWireGuard(): void {
    if (this.platform.isWindows && !this.platform.wireguard) {
      throw new WireGuardError('missing_wireguard', 'The official WireGuard client was not found.', {
        status: 503,
        hint: 'Install it from https://www.wireguard.com/install/ and restart Harness.',
      });
    }
  }

  /**
   * Remove an interface, tolerating an absent device.
   * @param {string} interfaceName tunnel name.
   * @returns {Promise<void>}
   */
  async down(interfaceName: string): Promise<void> {
    this.requireWg();
    if (this.platform.isWindows) {
      this.requireWindowsWireGuard();
      try {
        await runPrivileged(this.platform.wireguard, ['/uninstalltunnelservice', interfaceName], { platform: this.platform, timeout: 20000 });
      } catch (error) {
        const text = error instanceof CommandError ? `${error.message} ${error.stderr}` : String(error);
        if (/not installed|does not exist|cannot find|no such|not found|找不到|指定的服务/i.test(text)) return;
        throw error;
      }
      return;
    }
    this.requireLinuxIp();
    try {
      await runPrivileged(this.platform.ip, ['link', 'delete', 'dev', interfaceName], { platform: this.platform, timeout: 15000 });
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
  async upServer(input: any): Promise<{ warnings: string[] }> {
    this.requireWg();
    this.requireLinuxIp();
    this.requireWindowsWireGuard();
    await this.down(input.interfaceName);
    const warnings = [];
    try {
      if (this.platform.isWindows) {
        await runPrivileged(this.platform.wireguard, ['/installtunnelservice', input.configPath], { platform: this.platform, timeout: 30000 });
        await this.waitForUp(input.interfaceName);
        for (const peer of input.peers) await this.addPeer(input.interfaceName, peer);
      } else {
        await runPrivileged(this.platform.ip, ['link', 'add', 'dev', input.interfaceName, 'type', 'wireguard'], { platform: this.platform });
        await runPrivileged(this.platform.wg, ['set', input.interfaceName, 'private-key', input.privateKeyPath, 'listen-port', String(input.settings.listenPort)], { platform: this.platform });
        await runPrivileged(this.platform.ip, ['address', 'add', `${input.settings.serverIp}/${input.cidr.prefix}`, 'dev', input.interfaceName], { platform: this.platform });
        await runPrivileged(this.platform.ip, ['link', 'set', 'mtu', String(input.settings.mtu), 'up', 'dev', input.interfaceName], { platform: this.platform });
        for (const peer of input.peers) await this.addPeer(input.interfaceName, peer);
      }
      const forwarding = await this.enableForwarding(input.interfaceName);
      warnings.push(...forwarding.warnings);
    } catch (error) {
      try {
        await this.down(input.interfaceName);
      } catch {
        // Preserve the original failure.
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
  async upClient(input: any): Promise<void> {
    this.requireWg();
    this.requireLinuxIp();
    this.requireWindowsWireGuard();
    await this.down(input.interfaceName);
    try {
      if (this.platform.isWindows) {
        await runPrivileged(this.platform.wireguard, ['/installtunnelservice', input.configPath], { platform: this.platform, timeout: 30000 });
        await this.waitForUp(input.interfaceName);
        return;
      }
      await runPrivileged(this.platform.ip, ['link', 'add', 'dev', input.interfaceName, 'type', 'wireguard'], { platform: this.platform });
      await runPrivileged(this.platform.wg, ['set', input.interfaceName, 'private-key', input.privateKeyPath], { platform: this.platform });
      await runPrivileged(this.platform.ip, ['address', 'add', `${input.address}/32`, 'dev', input.interfaceName], { platform: this.platform });
      await runPrivileged(this.platform.ip, ['link', 'set', 'mtu', String(input.settings.mtu), 'up', 'dev', input.interfaceName], { platform: this.platform });
      await runPrivileged(this.platform.ip, ['route', 'replace', input.vpnCidr, 'dev', input.interfaceName], { platform: this.platform });
      await runPrivileged(this.platform.wg, ['set', input.interfaceName, 'peer', input.serverPublicKey, 'allowed-ips', input.vpnCidr, 'endpoint', input.endpoint, 'persistent-keepalive', '25'], { platform: this.platform });
    } catch (error) {
      try {
        await this.down(input.interfaceName);
      } catch {
        // Preserve the original failure.
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
  async addPeer(interfaceName: string, peer: { publicKey: string; ip: string }): Promise<void> {
    this.requireWg();
    await runPrivileged(this.platform.wg, ['set', interfaceName, 'peer', peer.publicKey, 'allowed-ips', `${peer.ip}/32`], { platform: this.platform, timeout: 15000 });
  }

  /**
   * Remove one peer from a live interface.
   * @param {string} interfaceName tunnel name.
   * @param {string} publicKey peer public key.
   * @returns {Promise<void>}
   */
  async removePeer(interfaceName: string, publicKey: string): Promise<void> {
    this.requireWg();
    await runPrivileged(this.platform.wg, ['set', interfaceName, 'peer', publicKey, 'remove'], { platform: this.platform, timeout: 15000 });
  }

  /**
   * Read live interface state. This never throws for an absent or unauthorized
   * interface; callers surface the diagnostic instead.
   * @param {string} interfaceName tunnel name.
   * @returns {Promise<{ up: boolean, publicKey: string, listenPort: number | null, peers: Array<Record<string, unknown>>, error?: string, privilege?: boolean }>}
   */
  async status(interfaceName: string): Promise<any> {
    if (!this.platform.wg) {
      return { up: false, publicKey: '', listenPort: null, peers: [], error: 'WireGuard tools are not installed.' };
    }
    try {
      const { stdout } = await runPrivileged(this.platform.wg, ['show', interfaceName, 'dump'], { platform: this.platform, timeout: 10000 });
      return { up: true, ...parseWgDump(stdout) };
    } catch (error) {
      if (error instanceof WireGuardError) {
        return { up: false, publicKey: '', listenPort: null, peers: [], error: error.message, privilege: true };
      }
      const text = error instanceof CommandError ? `${error.stderr} ${error.stdout}` : String(error);
      return { up: false, publicKey: '', listenPort: null, peers: [], error: text.trim().slice(0, 400) || 'Interface is not running.' };
    }
  }

  /**
   * Poll briefly until the Windows tunnel service is queryable.
   * @param {string} interfaceName tunnel name.
   * @returns {Promise<void>}
   */
  async waitForUp(interfaceName: string): Promise<void> {
    if (!this.platform.isWindows) return;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const status = await this.status(interfaceName);
      if (status.up) return;
      if (status.privilege) return;
      await delay(500);
    }
    throw new WireGuardError('interface_error', 'The WireGuard tunnel service started but did not become queryable.', {
      status: 500,
      hint: 'Open the WireGuard app, check its log, and retry. Windows may need a moment after the first install.',
    });
  }

  /**
   * Best-effort IPv4 forwarding and peer-to-peer firewall admission.
   * @param {string} interfaceName tunnel name.
   * @returns {Promise<{ warnings: string[] }>}
   */
  async enableForwarding(interfaceName: string): Promise<{ warnings: string[] }> {
    const warnings = [];
    if (this.platform.isWindows) {
      try {
        await runPrivileged('netsh.exe', ['interface', 'ipv4', 'set', 'interface', interfaceName, 'forwarding=enabled'], { platform: this.platform, timeout: 10000 });
      } catch (error) {
        warnings.push(`Windows IP forwarding could not be enabled automatically: ${error instanceof Error ? error.message : String(error)}`);
      }
      warnings.push('Windows server mode: clients can reach the server, but client-to-client access may require Windows routing configuration. A Linux server is recommended.');
      return { warnings };
    }
    if (this.platform.sysctl) {
      try {
        await runPrivileged(this.platform.sysctl, ['-w', 'net.ipv4.ip_forward=1'], { platform: this.platform, timeout: 10000 });
      } catch (error) {
        warnings.push(`Could not enable net.ipv4.ip_forward: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (this.platform.iptables) {
      try {
        try {
          await runPrivileged(this.platform.iptables, ['-C', 'FORWARD', '-i', interfaceName, '-o', interfaceName, '-j', 'ACCEPT'], { platform: this.platform, timeout: 10000 });
        } catch {
          await runPrivileged(this.platform.iptables, ['-A', 'FORWARD', '-i', interfaceName, '-o', interfaceName, '-j', 'ACCEPT'], { platform: this.platform, timeout: 10000 });
        }
      } catch (error) {
        warnings.push(`Could not add a peer-to-peer FORWARD rule: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (this.platform.nft) {
      try {
        await runPrivileged(this.platform.nft, ['add', 'rule', 'ip', 'filter', 'FORWARD', 'iifname', interfaceName, 'oifname', interfaceName, 'accept'], { platform: this.platform, timeout: 10000 });
      } catch {
        warnings.push('nftables is present but no matching FORWARD rule could be added; client-to-client traffic may be blocked.');
      }
    }
    return { warnings };
  }

  /**
   * Turn an opaque command error into an actionable WireGuard error.
   * @param {unknown} error failure.
   * @returns {Error} normalized failure.
   */
  describe(error: unknown): Error {
    if (error instanceof WireGuardError) return error;
    const text = error instanceof CommandError ? `${error.message} ${error.stderr}` : String(error);
    if (/operation not permitted|permission denied|access is denied|requires elevation/i.test(text)) {
      return new WireGuardError('needs_privilege', 'WireGuard needs administrator rights to change the network interface.', {
        status: 403,
        hint: this.platform.isWindows
          ? 'Close Harness and start it again with “Run as administrator”, then retry.'
          : 'Run Harness as root, or configure passwordless sudo for wg and ip, then retry.',
        details: { stderr: text.trim().slice(0, 500) },
      });
    }
    if (/unknown device type|wireguard.*not found|module.*not found|protocol not supported/i.test(text)) {
      return new WireGuardError('wireguard_unavailable', 'The WireGuard kernel interface is unavailable.', {
        status: 503,
        hint: this.platform.isLinux ? 'Load the kernel module with `sudo modprobe wireguard`, or install a WireGuard-enabled kernel.' : undefined,
        details: { stderr: text.trim().slice(0, 500) },
      });
    }
    return new WireGuardError('interface_error', 'Could not configure the WireGuard interface.', {
      status: 500,
      details: { stderr: text.trim().slice(0, 500) },
    });
  }
}
