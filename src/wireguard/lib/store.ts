/** Durable plugin state, private keys, and generated WireGuard config files. */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_SETTINGS } from './config';
import { generateKeyPair, normalizeKey, publicKeyFromPrivate } from './keys';

/**
 * @typedef {ReturnType<typeof emptyState>} PluginState
 */

/**
 * Fresh non-secret state.
 * @returns {{
 *   version: number,
 *   role: 'idle' | 'server' | 'client',
 *   settings: typeof DEFAULT_SETTINGS,
 *   server: { running: boolean, startedAt: string | null, publicKey: string, endpoint: string | null, endpointHost: string | null, controlUrl: string | null, controlPort: number, listenPort: number, vpnCidr: string, interfaceName: string, mtu: number, dns: string, peers: Array<Record<string, unknown>>, warnings: string[], forwarding: boolean | null },
 *   client: { connected: boolean, pending: boolean, publicKey: string | null, name: string | null, serverUrl: string | null, serverHost: string | null, assignedIp: string | null, serverPublicKey: string | null, vpnCidr: string | null, endpoint: string | null, interfaceName: string | null, mtu: number, joinCode: string | null, connectedAt: string | null, lastHandshakeAt: string | null, receivedBytes: number, sentBytes: number, lastError: string | null, warnings: string[] },
 *   lastError: string | null,
 *   logs: string[],
 *   updatedAt: string | null
 * }}
 */
export function emptyState() {
  return {
    version: 1,
    role: 'idle',
    settings: { ...DEFAULT_SETTINGS },
    server: {
      running: false,
      startedAt: null,
      publicKey: '',
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
      forwarding: null,
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
      warnings: [],
    },
    lastError: null,
    logs: [],
    updatedAt: null,
  };
}

export type PluginState = ReturnType<typeof emptyState>;

/**
 * Merge a decoded state over the current schema without trusting its shapes.
 * @param {unknown} raw decoded JSON.
 * @returns {ReturnType<typeof emptyState>} normalized state.
 */
export function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const source = /** @type {Record<string, any>} */ (raw);
  const state = base;
  if (source.role === 'server' || source.role === 'client') state.role = source.role;
  if (source.settings && typeof source.settings === 'object') state.settings = { ...base.settings, ...source.settings };
  if (source.server && typeof source.server === 'object') {
    const server = source.server;
    state.server = {
      ...base.server,
      running: server.running === true,
      startedAt: typeof server.startedAt === 'string' ? server.startedAt : null,
      publicKey: normalizeKey(server.publicKey) ?? '',
      endpoint: typeof server.endpoint === 'string' ? server.endpoint : null,
      endpointHost: typeof server.endpointHost === 'string' ? server.endpointHost : null,
      controlUrl: typeof server.controlUrl === 'string' ? server.controlUrl : null,
      controlPort: Number.isInteger(server.controlPort) ? server.controlPort : base.server.controlPort,
      listenPort: Number.isInteger(server.listenPort) ? server.listenPort : base.server.listenPort,
      vpnCidr: typeof server.vpnCidr === 'string' ? server.vpnCidr : base.server.vpnCidr,
      interfaceName: typeof server.interfaceName === 'string' ? server.interfaceName : base.server.interfaceName,
      mtu: Number.isInteger(server.mtu) ? server.mtu : base.server.mtu,
      dns: typeof server.dns === 'string' ? server.dns : base.server.dns,
      peers: Array.isArray(server.peers) ? server.peers.filter((peer) => peer && typeof peer === 'object' && typeof peer.publicKey === 'string').slice(0, 1024) : [],
      warnings: Array.isArray(server.warnings) ? server.warnings.filter((item) => typeof item === 'string').slice(0, 20) : [],
      forwarding: typeof server.forwarding === 'boolean' ? server.forwarding : null,
    };
  }
  if (source.client && typeof source.client === 'object') {
    const client = source.client;
    state.client = {
      ...base.client,
      connected: client.connected === true,
      pending: client.pending === true,
      publicKey: normalizeKey(client.publicKey) ?? null,
      name: typeof client.name === 'string' ? client.name : null,
      serverUrl: typeof client.serverUrl === 'string' ? client.serverUrl : null,
      serverHost: typeof client.serverHost === 'string' ? client.serverHost : null,
      assignedIp: typeof client.assignedIp === 'string' ? client.assignedIp : null,
      serverPublicKey: normalizeKey(client.serverPublicKey) ?? null,
      vpnCidr: typeof client.vpnCidr === 'string' ? client.vpnCidr : null,
      endpoint: typeof client.endpoint === 'string' ? client.endpoint : null,
      interfaceName: typeof client.interfaceName === 'string' ? client.interfaceName : null,
      mtu: Number.isInteger(client.mtu) ? client.mtu : base.client.mtu,
      joinCode: typeof client.joinCode === 'string' ? client.joinCode : null,
      connectedAt: typeof client.connectedAt === 'string' ? client.connectedAt : null,
      lastHandshakeAt: typeof client.lastHandshakeAt === 'string' ? client.lastHandshakeAt : null,
      receivedBytes: Number.isSafeInteger(client.receivedBytes) ? client.receivedBytes : 0,
      sentBytes: Number.isSafeInteger(client.sentBytes) ? client.sentBytes : 0,
      lastError: typeof client.lastError === 'string' ? client.lastError : null,
      warnings: Array.isArray(client.warnings) ? client.warnings.filter((item) => typeof item === 'string').slice(0, 20) : [],
    };
  }
  state.lastError = typeof source.lastError === 'string' ? source.lastError : null;
  state.logs = Array.isArray(source.logs) ? source.logs.filter((item) => typeof item === 'string').slice(-40) : [];
  state.updatedAt = typeof source.updatedAt === 'string' ? source.updatedAt : null;
  return state;
}

/** Owns everything under the plugin data directory. */
export class Store {
  readonly dataDir: string;
  readonly statePath: string;
  state: PluginState;
  existed: boolean;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.statePath = path.join(dataDir, 'state.json');
    this.state = emptyState();
    this.existed = false;
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      await chmod(this.dataDir, 0o700);
    } catch {
      // Windows ignores POSIX modes.
    }
    this.state = await this.load();
  }

  /**
   * @returns {Promise<ReturnType<typeof emptyState>>} loaded state.
   */
  async load(): Promise<PluginState> {
    try {
      const text = await readFile(this.statePath, 'utf8');
      const state = normalizeState(JSON.parse(text));
      this.existed = true;
      return state;
    } catch (error) {
      if (error && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return emptyState();
      try {
        await rename(this.statePath, `${this.statePath}.corrupt-${Date.now()}`);
      } catch {
        // The original error is more useful than a failed quarantine.
      }
      return emptyState();
    }
  }

  /**
   * Persist the complete non-secret state atomically.
   * @param {ReturnType<typeof emptyState>} state state to write.
   * @returns {Promise<void>}
   */
  async save(state: PluginState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    this.state = state;
    const temporary = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.statePath);
    try {
      await chmod(this.statePath, 0o600);
    } catch {
      // Windows ignores POSIX modes.
    }
  }

  /**
   * Read a stored private key, or create and persist a new one.
   * @param {'server' | 'client'} role key owner.
   * @returns {Promise<{ privateKey: string, publicKey: string, privateKeyPath: string }>}
   */
  async ensureKey(role: 'server' | 'client'): Promise<{ privateKey: string; publicKey: string; privateKeyPath: string }> {
    const privateKeyPath = path.join(this.dataDir, `${role}.key`);
    try {
      const stored = await readFile(privateKeyPath, 'utf8');
      const normalized = normalizeKey(stored);
      if (normalized) {
        try {
          await chmod(privateKeyPath, 0o600);
        } catch {
          // Windows ignores POSIX modes.
        }
        return { privateKey: normalized, publicKey: publicKeyFromPrivate(normalized), privateKeyPath };
      }
    } catch (error) {
      if (!error || /** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
        try {
          await rename(privateKeyPath, `${privateKeyPath}.corrupt-${Date.now()}`);
        } catch {
          // Continue by replacing the invalid key.
        }
      }
    }
    const pair = generateKeyPair();
    await writeFile(privateKeyPath, `${pair.privateKey}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      await chmod(privateKeyPath, 0o600);
    } catch {
      // Windows ignores POSIX modes.
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
  configPath(role: 'server' | 'client', interfaceName: string | null = null, windows = false): string {
    if (windows && interfaceName) return path.join(this.dataDir, `${interfaceName}.conf`);
    return path.join(this.dataDir, `${role}.conf`);
  }

  /**
   * @param {'server' | 'client'} role config owner.
   * @param {string} text complete configuration.
   * @param {string | null} [interfaceName] Windows tunnel name.
   * @param {boolean} [windows] whether the host is Windows.
   * @returns {Promise<void>}
   */
  async writeConfig(role: 'server' | 'client', text: string, interfaceName: string | null = null, windows = false): Promise<void> {
    const target = this.configPath(role, interfaceName, windows);
    await writeFile(target, text, { encoding: 'utf8', mode: 0o600 });
    try {
      await chmod(target, 0o600);
    } catch {
      // Windows ignores POSIX modes.
    }
  }

  /**
   * @param {'server' | 'client'} role config owner.
   * @param {string | null} [interfaceName] Windows tunnel name.
   * @param {boolean} [windows] whether the host is Windows.
   * @returns {Promise<void>}
   */
  async removeConfig(role: 'server' | 'client', interfaceName: string | null = null, windows = false): Promise<void> {
    try {
      await rm(this.configPath(role, interfaceName, windows), { force: true });
    } catch {
      // Best effort.
    }
  }

  /**
   * Append one bounded diagnostic line.
   * @param {ReturnType<typeof emptyState>} state state to mutate.
   * @param {string} line message.
   * @returns {void}
   */
  log(state: PluginState, line: string): void {
    const stamp = new Date().toISOString();
    state.logs.push(`${stamp} ${line}`);
    if (state.logs.length > 40) state.logs.splice(0, state.logs.length - 40);
  }
}
