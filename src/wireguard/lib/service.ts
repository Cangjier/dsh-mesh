/** WireGuard server/client orchestration shared by the panel and control API. */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { generateJoinCode, secretsMatch } from './access';
import { DEFAULT_CONTROL_PORT, MAX_PEERS, PLUGIN_VERSION, SERVICE_NAME } from './constants';
import { buildClientConfig, buildServerConfig, formatEndpointHost, normalizeDeviceName, normalizeEndpointHost, normalizeSettings, parseServerAddress } from './config';
import { ControlPanel } from './control-panel';
import { WireGuardError, missingToolHint } from './errors';
import { installWireGuard as installPlatformWireGuard } from './installer';
import { allocatePeerIp, ipv4ToString, isUsableHost, parseCidr, parseIpv4 } from './ip';
import { keyFingerprint, normalizeKey } from './keys';
import { detectGlobalIpv6, detectLanAddress, detectPlatform, localHostname, type PlatformInfo } from './platform';
import { buildSshAuthorizeCommand, buildWindowsSshAuthorizeCommand, SSH_USER_PATTERN } from './ssh';
import { emptyState, Store, type PluginState } from './store';
import { Tunnel } from './tunnel';

const execFileAsync = promisify(execFile);

export interface WireGuardServiceOptions {
  config?: Record<string, unknown>;
  dataDir: string;
  platformFactory?: () => Promise<PlatformInfo>;
  tunnelFactory?: (platform: PlatformInfo) => any;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function integerOr(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) ? (value as number) : fallback;
}

/** One Host-side WireGuard service per plugin instance. */
export class WireGuardService {
  config: Record<string, unknown>;
  readonly store: Store;
  state: PluginState;
  readonly platformFactory: () => Promise<PlatformInfo>;
  readonly tunnelFactory: (platform: PlatformInfo) => any;
  readonly fetchImpl: typeof fetch;
  readonly now: () => number;
  readonly logger: (line: string) => void;
  control: ControlPanel | null;
  controlExtraHandler: ((request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<boolean> | boolean) | null;
  platform: PlatformInfo | null;
  tunnel: any;
  platformAt: number;
  lock: Promise<void>;

  constructor(options: WireGuardServiceOptions) {
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
      this.#log('generated a random join code for the control panel');
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
  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
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
    if (!force && this.platform && this.now() - this.platformAt < 15_000) return;
    const platform = await this.platformFactory();
    this.platform = platform;
    this.tunnel = this.tunnelFactory(platform);
    this.platformAt = this.now();
  }

  /** @returns {void} */
  #requirePlatform() {
    if (!this.platform) {
      throw new WireGuardError('unsupported_platform', 'WireGuard is supported on Windows and Linux only.', {
        status: 503,
        hint: `This host reports ${process.platform}.`,
      });
    }
  }

  /** @returns {void} */
  #requireServerTools() {
    this.#requirePlatform();
    if (!this.platform.wg) {
      throw new WireGuardError('missing_wireguard', 'The WireGuard command-line tool `wg` was not found.', {
        status: 503,
        hint: missingToolHint('wg', this.platform.platform),
      });
    }
    if (this.platform.isLinux && !this.platform.ip) {
      throw new WireGuardError('missing_tool', 'The `ip` command was not found.', {
        status: 503,
        hint: 'Install iproute2, for example: sudo apt install iproute2',
      });
    }
    if (this.platform.isWindows && !this.platform.wireguard) {
      throw new WireGuardError('missing_wireguard', 'The official WireGuard client was not found.', {
        status: 503,
        hint: missingToolHint('wireguard', this.platform.platform),
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
    const stamped = `${new Date().toISOString()} ${line}`;
    this.state.logs.push(stamped);
    if (this.state.logs.length > 40) this.state.logs.splice(0, this.state.logs.length - 40);
    try {
      this.logger(stamped);
    } catch {
      // Logging must never break the operation.
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
      this.#log('control panel is owned by an external service');
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
      log: (line) => this.#log(line),
    });
    await panel.start(this.state.server.controlPort, '::');
    this.control = panel;
  }

  /**
   * Install an additional HTTP handler on the control-panel listener. The
   * standalone control service uses this to serve the same panel API that the
   * DSH host API normally serves.
   * @param {((request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<boolean> | boolean) | null} handler handler.
   * @returns {void}
   */
  setControlExtraHandler(handler: ((request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<boolean> | boolean) | null) {
    this.controlExtraHandler = handler;
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
    const key = await this.store.ensureKey('server');
    if (key.publicKey !== this.state.server.publicKey) {
      throw new Error('The stored server key no longer matches the running interface; restart the service to regenerate it.');
    }
    const settings = {
      ...this.state.settings,
      serverIp: this.state.settings.serverIp,
      listenPort: this.state.server.listenPort,
      mtu: this.state.server.mtu,
      interfaceName: this.state.server.interfaceName,
    };
    const text = buildServerConfig({
      privateKey: key.privateKey,
      settings,
      cidr,
      peers: this.state.server.peers,
    });
    await this.store.writeConfig('server', text, this.state.server.interfaceName, this.platform?.isWindows === true);
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
    const configured = String(this.state.server.endpointHost ?? '').trim();
    const family = isIP(configured);
    const ipv4Host = configured && family !== 6 ? configured : '';
    const detectedIpv6 = detectGlobalIpv6();
    const ipv6Host = family === 6 ? configured : (detectedIpv6 || (family === 0 && configured ? configured : ''));
    const target = (host) => {
      if (!host) return { available: false, controlUrl: null, endpoint: null };
      return {
        available: true,
        controlUrl: `http://${formatEndpointHost(host)}:${controlPort}`,
        endpoint: `${formatEndpointHost(host)}:${listenPort}`,
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
      peerCount: this.state.server.peers.length,
    };
  }

  /** @returns {Array<Record<string, unknown>>} peer list without public keys. */
  #publicPeers() {
    return this.state.server.peers.map((peer) => ({
      name: peer.name,
      ip: peer.ip,
      online: peer.online === true,
      lastHandshakeAt: peer.lastHandshakeAt ?? null,
    }));
  }

  /**
   * Keep only peers that still belong to the current subnet.
   * @param {ReturnType<typeof parseCidr>} cidr parsed subnet.
   * @param {string} serverIp server address.
   * @returns {Array<Record<string, any>>} valid peers.
   */
  #validPeers(cidr, serverIp) {
    const seen = new Set();
    const peers = [];
    for (const raw of this.state.server.peers) {
      if (!raw || typeof raw !== 'object') continue;
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
        name: normalizeDeviceName(raw.name, 'client'),
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
        applied: raw.applied !== false,
        sshUser: typeof raw.sshUser === 'string' && SSH_USER_PATTERN.test(raw.sshUser) ? raw.sshUser : null,
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
          this.state.role = 'idle';
          try {
            await this.tunnel.down(this.state.server.interfaceName);
          } catch {
            // Preserve the original control-panel failure.
          }
        }
      } else if (status.privilege) {
        this.state.server.warnings = [
          ...this.state.server.warnings,
          'The WireGuard interface exists, but Harness cannot read it without administrator rights.',
        ];
        try {
          await this.#startControl();
        } catch (error) {
          this.#recordError(error);
        }
      } else {
        this.state.server.running = false;
        this.state.role = 'idle';
        this.#recordError(`The saved WireGuard server is not running: ${status.error ?? 'interface not found'}`);
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
        this.state.client.lastError = 'The WireGuard client tunnel stopped. Retry the connection.';
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
      if (this.state.server.running) throw new WireGuardError('already_running', 'The WireGuard server is already running.', { status: 409 });
      if (this.state.client.connected || this.state.client.pending) {
        throw new WireGuardError('client_active', 'Disconnect the client tunnel before starting server mode.', { status: 409 });
      }
      const { settings, cidr } = normalizeSettings(input, this.state.settings);
      if (!settings.joinCode) {
        settings.joinCode = generateJoinCode();
        this.#log('generated a new random join code for the control panel');
      }
      await this.#detect(false);
      this.#requireServerTools();
      const detected = detectLanAddress();
      const endpointHost = settings.endpointHost || detected?.address || '';
      if (!endpointHost) {
        throw new WireGuardError('no_lan_address', 'No non-loopback IPv4 address was found for clients to reach.', {
          status: 400,
          hint: 'Enter this machine’s LAN address in the “Advertised address” field.',
        });
      }
      const normalizedHost = normalizeEndpointHost(endpointHost);
      const key = await this.store.ensureKey('server');
      const peers = this.#validPeers(cidr, settings.serverIp);
      const warnings = [];
      if (peers.length !== this.state.server.peers.length) warnings.push('Some saved peers were outside the new VPN subnet and were removed.');
      if (/^127\./.test(normalizedHost) || normalizedHost === 'localhost') warnings.push('The advertised address is a loopback address; other devices cannot reach it.');
      const configText = buildServerConfig({
        privateKey: key.privateKey,
        settings,
        cidr,
        peers,
      });
      await this.store.writeConfig('server', configText, settings.interfaceName, this.platform?.isWindows === true);
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
        forwarding: null,
      };
      try {
        const result = await this.tunnel.upServer({
          interfaceName: settings.interfaceName,
          privateKeyPath: key.privateKeyPath,
          settings,
          cidr,
          peers,
          configPath: this.store.configPath('server', settings.interfaceName, this.platform?.isWindows === true),
        });
        this.state.server.warnings.push(...(result?.warnings ?? []));
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
          // Preserve the control-panel failure.
        }
        this.#recordError(error);
        await this.#persist();
        throw error;
      }
      this.state.server.running = true;
      this.state.server.startedAt = new Date().toISOString();
      this.state.role = 'server';
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
      this.state.role = this.state.client.connected ? 'client' : 'idle';
      this.state.lastError = null;
      this.#log('server stopped');
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
        throw new WireGuardError('server_active', 'Stop server mode before joining another server.', { status: 409 });
      }
      if (this.state.client.connected) throw new WireGuardError('already_connected', 'The client is already connected.', { status: 409 });
      if (this.state.client.pending) throw new WireGuardError('pending_connection', 'A pending client configuration exists. Retry or cancel it first.', { status: 409 });
      await this.#detect(false);
      this.#requireClientTools();
      const address = parseServerAddress(input.serverAddress, DEFAULT_CONTROL_PORT);
      const joinCode = String(input.joinCode ?? '').trim();
      const name = normalizeDeviceName(input.name, localHostname());
      const family = address.host.includes(':') ? 'ipv6' : 'ipv4';
      const health = await this.#fetchJson(`${address.controlUrl}/health`);
      if (health.service !== SERVICE_NAME) {
        throw new WireGuardError('wrong_service', 'That address is not a DSH WireGuard control panel.', { status: 502 });
      }
      const serverPublicKey = normalizeKey(health.publicKey);
      if (!serverPublicKey) throw new WireGuardError('bad_server', 'The server returned an invalid public key.', { status: 502 });
      const vpnCidr = parseCidr(health.vpnCidr);
      if (!vpnCidr) throw new WireGuardError('bad_server', 'The server returned an invalid VPN subnet.', { status: 502 });
      const listenPort = integerOr(health.listenPort, this.state.settings.listenPort);
      if (listenPort < 1 || listenPort > 65535) throw new WireGuardError('bad_server', 'The server returned an invalid WireGuard port.', { status: 502 });
      const key = await this.store.ensureKey('client');
      const join = await this.#fetchJson(`${address.controlUrl}/join`, {
        method: 'POST',
        body: { name, publicKey: key.publicKey, code: joinCode, family },
      });
      const assignedIp = parseIpv4(join?.client?.ip);
      if (assignedIp === null || !isUsableHost(assignedIp, vpnCidr)) {
        throw new WireGuardError('bad_server', 'The server did not assign a valid client address.', { status: 502 });
      }
      const assignedAddress = ipv4ToString(assignedIp);
      const joinedServerKey = normalizeKey(join?.server?.publicKey ?? serverPublicKey);
      if (!joinedServerKey) throw new WireGuardError('bad_server', 'The server returned an invalid public key.', { status: 502 });
      const endpoint = String(join?.server?.endpoint || `${formatEndpointHost(address.host)}:${listenPort}`);
      if (!/^(?:\[[0-9A-Fa-f:.]+\]|[^:\s]+):\d{1,5}$/.test(endpoint)) throw new WireGuardError('bad_server', 'The server returned an invalid WireGuard endpoint.', { status: 502 });
      const advertisedMtu = integerOr(health.mtu, this.state.settings.mtu);
      const clientSettings = {
        ...this.state.settings,
        mtu: advertisedMtu >= 576 && advertisedMtu <= 9000 ? advertisedMtu : this.state.settings.mtu,
        dns: typeof health.dns === 'string' ? health.dns : this.state.settings.dns,
      };
      const configText = buildClientConfig({
        privateKey: key.privateKey,
        address: assignedAddress,
        settings: clientSettings,
        serverPublicKey: joinedServerKey,
        endpoint,
        vpnCidr: vpnCidr.normalized,
      });
      await this.store.writeConfig('client', configText, this.state.settings.interfaceName, this.platform?.isWindows === true);
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
        lastError: null,
      };
      this.state.role = 'client';
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
          configPath: this.store.configPath('client', this.state.client.interfaceName, this.platform?.isWindows === true),
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
      this.state.client.connectedAt = new Date().toISOString();
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
        throw new WireGuardError('nothing_to_retry', 'There is no saved client configuration to retry.', { status: 409 });
      }
      await this.#detect(false);
      this.#requireClientTools();
      const key = await this.store.ensureKey('client');
      try {
        await this.tunnel.upClient({
          interfaceName: client.interfaceName,
          privateKeyPath: key.privateKeyPath,
          address: client.assignedIp,
          settings: { ...this.state.settings, mtu: client.mtu, interfaceName: client.interfaceName },
          vpnCidr: client.vpnCidr,
          serverPublicKey: client.serverPublicKey,
          endpoint: client.endpoint,
          configPath: this.store.configPath('client', client.interfaceName, this.platform?.isWindows === true),
        });
      } catch (error) {
        client.lastError = errorMessage(error);
        this.#recordError(error);
        await this.#persist();
        throw error;
      }
      client.pending = false;
      client.connected = true;
      client.connectedAt = new Date().toISOString();
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
            method: 'POST',
            body: { publicKey: client.publicKey, code: client.joinCode ?? '' },
            timeout: 5000,
          });
        } catch {
          // A server that is already gone must not block local teardown.
        }
      }
      await this.store.removeConfig('client', client.interfaceName, this.platform?.isWindows === true);
      this.state.client = emptyState().client;
      this.state.role = this.state.server.running ? 'server' : 'idle';
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
  async joinPeer(body, remoteAddress = '') {
    return this.#serialized(async () => {
      if (!this.state.server.running || !this.control) {
        throw new WireGuardError('not_running', 'The WireGuard server is not running.', { status: 503 });
      }
      if (this.state.settings.joinCode && !secretsMatch(String(body.code ?? ''), this.state.settings.joinCode)) {
        throw new WireGuardError('invalid_join_code', 'The join code is missing or incorrect.', { status: 401 });
      }
      const publicKey = normalizeKey(body.publicKey);
      if (!publicKey) throw new WireGuardError('invalid_public_key', 'A valid WireGuard public key is required.', { status: 400 });
      const name = normalizeDeviceName(body.name, 'client');
      const family = body.family === 'ipv6' ? 'ipv6' : body.family === 'ipv4' ? 'ipv4' : '';
      const cidr = parseCidr(this.state.server.vpnCidr);
      if (!cidr) throw new WireGuardError('server_not_ready', 'The server subnet is invalid.', { status: 500 });
      const existing = this.state.server.peers.find((peer) => peer.publicKey === publicKey);
      if (existing) {
        existing.name = name;
        await this.tunnel.addPeer(this.state.server.interfaceName, existing);
        existing.applied = true;
        await this.#safeRewriteServerConfig();
        await this.#persist();
        this.#log(`peer ${name} (${existing.ip}) rejoined from ${remoteAddress || 'unknown'}`);
        return this.#joinResult(existing, family);
      }
      if (this.state.server.peers.length >= MAX_PEERS) {
        throw new WireGuardError('server_full', 'This server has reached its peer limit.', { status: 409 });
      }
      const ip = allocatePeerIp(cidr, this.state.server.peers.map((peer) => peer.ip), this.state.settings.serverIp);
      if (!ip) throw new WireGuardError('server_full', 'No free address remains in the VPN subnet.', { status: 409 });
      const peer = {
        publicKey,
        ip,
        name,
        createdAt: new Date().toISOString(),
        applied: false,
        online: false,
        lastHandshakeAt: null,
        sshUser: null,
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
      this.#log(`peer ${name} (${ip}) joined from ${remoteAddress || 'unknown'}`);
      return this.#joinResult(peer, family);
    });
  }

  /**
   * Leave called by a remote client.
   * @param {Record<string, unknown>} body request body.
   * @param {string} remoteAddress caller address.
   * @returns {Promise<Record<string, unknown>>} removal result.
   */
  async leavePeer(body, remoteAddress = '') {
    return this.#serialized(async () => {
      if (this.state.settings.joinCode && !secretsMatch(String(body.code ?? ''), this.state.settings.joinCode)) {
        throw new WireGuardError('invalid_join_code', 'The join code is missing or incorrect.', { status: 401 });
      }
      const publicKey = normalizeKey(body.publicKey);
      if (!publicKey) throw new WireGuardError('invalid_public_key', 'A valid WireGuard public key is required.', { status: 400 });
      const peer = this.state.server.peers.find((candidate) => candidate.publicKey === publicKey);
      if (!peer) return { removed: false };
      if (this.state.server.running && this.tunnel) {
        await this.tunnel.removePeer(this.state.server.interfaceName, publicKey);
      }
      this.state.server.peers = this.state.server.peers.filter((candidate) => candidate.publicKey !== publicKey);
      await this.#safeRewriteServerConfig();
      await this.#persist();
      this.#log(`peer ${peer.name} (${peer.ip}) left from ${remoteAddress || 'unknown'}`);
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
      if (!key) throw new WireGuardError('invalid_public_key', 'A valid WireGuard public key is required.', { status: 400 });
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
        throw new WireGuardError('invalid_public_key', 'A valid WireGuard public key is required.', { status: 400 });
      }
      const peer = this.state.server.peers.find((candidate) => candidate.publicKey === publicKey);
      if (!peer) {
        throw new WireGuardError('peer_not_found', 'That device has not joined this server.', { status: 404 });
      }
      const user = String(input.user ?? '').trim();
      if (!SSH_USER_PATTERN.test(user)) {
        throw new WireGuardError('invalid_input', 'SSH username must start with a letter or underscore and contain only letters, digits, underscores, or dashes.', {
          status: 400,
          details: { field: 'sshUser' },
        });
      }
      const publicSshKey = await this.#ensureSshKey(publicKey);
      peer.sshUser = user;
      await this.#persist();
      this.#log(`configured SSH access for ${peer.name} as ${user}`);
      const commands = {
        linux: buildSshAuthorizeCommand(user, publicSshKey),
        windows: buildWindowsSshAuthorizeCommand(user, publicSshKey),
      };
      return { state: this.snapshot(), command: commands.linux, commands, publicKey: publicSshKey };
    });
  }

  /**
   * @param {string} peerPublicKey peer WireGuard public key.
   * @returns {string} private-key path under the plugin data directory.
   */
  #sshKeyPath(peerPublicKey) {
    const digest = createHash('sha256').update(peerPublicKey).digest('hex');
    return path.join(this.store.dataDir, 'ssh', `${digest}.key`);
  }

  /**
   * Reuse a peer's SSH key if present, otherwise generate a new Ed25519 key.
   * @param {string} peerPublicKey peer WireGuard public key.
   * @returns {Promise<string>} SSH public key.
   */
  async #ensureSshKey(peerPublicKey) {
    const keyPath = this.#sshKeyPath(peerPublicKey);
    const publicPath = `${keyPath}.pub`;
    const directory = path.dirname(keyPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await chmod(directory, 0o700);
    } catch {
      // Windows ignores POSIX modes.
    }
    try {
      const existing = (await readFile(publicPath, 'utf8')).trim();
      if (existing) {
        try {
          await chmod(keyPath, 0o600);
        } catch {
          // Windows ignores POSIX modes.
        }
        return existing;
      }
    } catch {
      // Generate below.
    }
    try {
      await readFile(keyPath, 'utf8');
      try {
        const derived = await execFileAsync('ssh-keygen', ['-y', '-f', keyPath]);
        const publicKey = String(derived.stdout ?? '').trim();
        if (publicKey) {
          await writeFile(publicPath, `${publicKey}\n`, { encoding: 'utf8', mode: 0o644 });
          try {
            await chmod(keyPath, 0o600);
          } catch {
            // Windows ignores POSIX modes.
          }
          return publicKey;
        }
      } catch {
        // Replace an unreadable private key below.
      }
    } catch {
      // No private key yet.
    }
    await rm(keyPath, { force: true }).catch(() => {});
    await rm(publicPath, { force: true }).catch(() => {});
    try {
      await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'dsh-wireguard', '-f', keyPath]);
    } catch {
      throw new WireGuardError('ssh_keygen_failed', 'Could not generate an SSH key for the client.', {
        status: 500,
        hint: 'Install OpenSSH ssh-keygen on the Harness host, then retry.',
      });
    }
    const publicKey = (await readFile(publicPath, 'utf8')).trim();
    if (!publicKey) {
      throw new WireGuardError('ssh_keygen_failed', 'SSH key generation produced no public key.', { status: 500 });
    }
    try {
      await chmod(keyPath, 0o600);
    } catch {
      // Windows ignores POSIX modes.
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
    await rm(keyPath, { force: true }).catch(() => {});
    await rm(`${keyPath}.pub`, { force: true }).catch(() => {});
  }

  /**
   * Build the server data returned to a joining client.
   * @param {Record<string, any>} peer assigned peer.
   * @returns {Record<string, unknown>} join response.
   */
  #joinResult(peer, family = '') {
    const server = this.state.server;
    if (!server.publicKey || !server.endpoint) {
      throw new WireGuardError('server_not_ready', 'The WireGuard server is missing its key or endpoint.', { status: 500 });
    }
    const targets = this.#deploymentTargets();
    const selected = family === 'ipv6' ? targets.ipv6 : family === 'ipv4' ? targets.ipv4 : null;
    if (family && !selected?.available) {
      throw new WireGuardError('family_unavailable', `No ${family} deployment address is available.`, {
        status: 503,
        hint: 'Configure a reachable address for this family, or use the other deployment target.',
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
        version: PLUGIN_VERSION,
      },
    };
  }

  /**
   * Refresh live handshakes and diagnose a tunnel that disappeared.
   * @returns {Promise<Record<string, unknown>>} updated snapshot.
   */
  async refresh(options: { force?: boolean } = {}) {
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
          if (!this.state.server.warnings.some((line) => line.includes('cannot read'))) {
            this.state.server.warnings.push('Cannot read the live WireGuard interface without administrator rights.');
          }
        } else {
          this.control?.stop().catch(() => {});
          this.control = null;
          this.state.server.running = false;
          this.state.role = this.state.client.connected ? 'client' : 'idle';
          this.#recordError(`The WireGuard server stopped unexpectedly: ${status.error ?? 'interface not found'}`);
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
              this.state.client.connectedAt = new Date().toISOString();
              this.state.client.lastError = null;
              await this.#persist();
            }
          } else if (!status.privilege && this.state.client.connected) {
            this.state.client.connected = false;
            this.state.client.pending = true;
            this.state.client.lastError = 'The WireGuard client tunnel stopped. Retry the connection.';
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
  #mergeServerStatus(status: any): void {
    if (status.publicKey) this.state.server.publicKey = status.publicKey;
    if (status.listenPort) this.state.server.listenPort = status.listenPort;
    const live = new Map<string, any>(status.peers.map((peer: any) => [peer.publicKey, peer] as [string, any]));
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
  #mergeClientStatus(status: any): void {
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
  async installWireGuard(): Promise<Record<string, unknown>> {
    return this.#serialized(async () => {
      if (this.state.server.running || this.state.client.connected || this.state.client.pending) {
        throw new WireGuardError('tunnel_active', 'Stop the WireGuard service or client before installing WireGuard.', { status: 409 });
      }
      await this.#detect(true);
      if (!this.platform) {
        throw new WireGuardError('unsupported_platform', 'WireGuard is supported on Windows and Linux only.', { status: 503 });
      }
      try {
        const outcome = await installPlatformWireGuard(this.platform, this.store.dataDir, (line) => this.#log(line));
        await this.#detect(true);
        this.state.lastError = null;
        this.#log(outcome.message);
        if (!this.platform?.wg || (this.platform.isWindows && !this.platform.wireguard)) {
          throw new WireGuardError('install_incomplete', 'WireGuard was installed but the tools are not visible yet.', {
            status: 503,
            hint: 'Restart Harness, or press Recheck after a few seconds.',
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
  async getState(options: { force?: boolean } = {}) {
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
    if (!platform?.wg) missing.push('wg');
    if (platform?.isLinux && !platform.ip) missing.push('ip');
    if (platform?.isWindows && !platform.wireguard) missing.push('wireguard');
    const ready = missing.length === 0 && Boolean(platform);
    const installHint = missing.length === 0
      ? undefined
      : missingToolHint(missing[0], platform?.platform ?? process.platform);
    const { joinCode: _clientJoinCode, ...clientState } = this.state.client;
    return {
      ok: true,
      version: PLUGIN_VERSION,
      service: SERVICE_NAME,
      role: this.state.role,
      hostname: localHostname(),
      platform: {
        id: platform?.platform ?? process.platform,
        label: platform?.isWindows ? 'Windows' : platform?.isLinux ? 'Linux' : process.platform,
      },
      tools: {
        ready,
        admin: platform?.admin === true,
        wg: Boolean(platform?.wg),
        wireguard: Boolean(platform?.wireguard),
        ip: Boolean(platform?.ip),
        missing,
        installHint,
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
          sshUser: peer.sshUser ?? null,
        })),
      },
      client: {
        ...clientState,
        publicKeyFingerprint: keyFingerprint(this.state.client.publicKey ?? ''),
        configured: Boolean(this.state.client.assignedIp),
      },
      lastError: this.state.lastError,
      logs: this.state.logs.slice(-20),
    };
  }

  /**
   * Fetch JSON from a remote control panel with a bounded timeout.
   * @param {string} url absolute URL.
   * @param {{ method?: string, body?: unknown, timeout?: number }} [options]
   * @returns {Promise<Record<string, any>>} decoded JSON.
   */
  async #fetchJson(url: string, options: { method?: string; body?: unknown; timeout?: number } = {}): Promise<Record<string, any>> {
    const timeout = options.timeout ?? 8000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      let response;
      try {
        response = await this.fetchImpl(url, {
          method: options.method ?? 'GET',
          headers: {
            accept: 'application/json',
            ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new WireGuardError('server_unreachable', 'The WireGuard server did not answer in time.', {
            status: 504,
            hint: 'Check the server address, that the Service tab is running, and that TCP 51821 is allowed through the firewall.',
          });
        }
        throw new WireGuardError('server_unreachable', 'Could not reach the WireGuard control panel.', {
          status: 502,
          hint: 'Check the server address and port, and make sure both devices are on the same LAN.',
          details: { cause: errorMessage(error) },
        });
      }
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new WireGuardError('bad_response', 'The WireGuard control panel returned a non-JSON response.', {
          status: 502,
          details: { status: response.status },
        });
      }
      if (!response.ok || data?.ok === false) {
        const detail = data?.error ?? {};
        throw new WireGuardError(typeof detail.code === 'string' ? detail.code : `http_${response.status}`, typeof detail.message === 'string' ? detail.message : 'The WireGuard control panel rejected the request.', {
          status: response.status,
          hint: typeof detail.hint === 'string' ? detail.hint : undefined,
          command: typeof detail.command === 'string' ? detail.command : undefined,
          details: detail.details,
        });
      }
      if (!data || typeof data !== 'object') throw new WireGuardError('bad_response', 'The WireGuard control panel returned an empty response.', { status: 502 });
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
      // Shutdown is best effort.
    }
    this.control = null;
    // A mesh should not lose a peer because Harness was restarted. By default
    // the interface/tunnel service is OS-level state: keep it, keep the state
    // file saying it is connected, and let the next init() adopt it through
    // #reconcile(). Set keepTunnelOnExit: false to restore the old teardown.
    if (this.config.keepTunnelOnExit !== false) {
      this.#log('keeping the WireGuard tunnel alive across Harness exit');
      return;
    }
    if (this.tunnel) {
      if (this.state.server.running) {
        try {
          await this.tunnel.down(this.state.server.interfaceName);
        } catch {
          // Shutdown is best effort.
        }
      }
      if (this.state.client.connected || this.state.client.pending) {
        try {
          await this.tunnel.down(this.state.client.interfaceName);
        } catch {
          // Shutdown is best effort.
        }
      }
    }
    this.state.server.running = false;
    this.state.server.startedAt = null;
    this.state.client.connected = false;
    this.state.client.pending = false;
    this.state.role = 'idle';
    try {
      await this.#persist();
    } catch {
      // Shutdown is best effort.
    }
  }
}
