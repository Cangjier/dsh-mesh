/** WireGuard server/client orchestration shared by the panel and control API. */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { generateJoinCode, secretsMatch } from './access';
import { DEFAULT_CONTROL_PORT, MAX_PEERS, PLUGIN_VERSION, SERVICE_NAME } from './constants';
import { buildClientConfig, buildServerConfig, formatEndpointHost, normalizeDeviceName, normalizeEndpointHost, normalizeSettings, parseServerAddress } from './config';
import { ControlPanel } from './control-panel';
import { WireGuardError, missingToolHint } from './errors';
import {
  buildLinuxEgressSshCommand,
  buildManualEgressCommands,
  buildWindowsEgressScript,
  encodeWindowsCommand,
  type EgressTarget,
} from './egress';
import { installWireGuard as installPlatformWireGuard } from './installer';
import { allocatePeerIp, ipv4ToString, isUsableHost, parseCidr, parseIpv4 } from './ip';
import { keyFingerprint, normalizeKey } from './keys';
import { forgetKnownHosts, refreshKnownHosts } from './known-hosts';
import {
  encodeText,
  formatAuthorizedKeyLine,
  gatewaySshConfigBlock,
  parseSshPublicKey,
  removeAuthorizedKeyTag,
  sshKeyFingerprint,
  upsertAuthorizedKey,
} from './member-ssh';
import { detectGlobalIpv6, detectLanAddress, detectPlatform, findExecutable, localHostname, runPrivileged, type PlatformInfo } from './platform';
import { buildSshAuthorizeCommand, buildWindowsSshAuthorizeCommand, SSH_USER_PATTERN } from './ssh';
import {
  authorizeLinuxKey,
  authorizeWindowsKey,
  ensureMemberKey,
  gatewaySshCommand,
  inspectSsh,
  installGatewaySshAccess,
  installWindowsOpenSsh,
  memberSshPaths,
  verifyOpenSshZip,
  type OpenSshAssetManifest,
  type SshAgentStatus,
} from './ssh-agent';
import { AssetStore } from './static-assets';
import { emptyState, Store, type PluginState } from './store';
import { Tunnel } from './tunnel';

const execFileAsync = promisify(execFile);

const SSH_AGENT_INTERVAL_MS = 5 * 60_000;
const SSH_INSTALL_RETRY_MS = 15 * 60_000;

export interface WireGuardServiceOptions {
  config?: Record<string, unknown>;
  dataDir: string;
  platformFactory?: () => Promise<PlatformInfo>;
  tunnelFactory?: (platform: PlatformInfo) => any;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
  /** Known-hosts maintenance, overridable in tests. */
  knownHosts?: {
    refresh?: (host: string) => Promise<unknown>;
    forget?: (host: string) => Promise<void>;
  };
  /** Privileged command execution for the hub half, overridable in tests. */
  commandRunner?: (command: string, args: readonly string[], options: { platform: PlatformInfo; timeout?: number }) => Promise<{ stdout: string; stderr: string }>;
  /** SSH execution for the member half, overridable in tests. */
  sshRunner?: (input: { host: string; user: string; keyPath: string; command: string; timeout: number }) => Promise<{ stdout: string; stderr: string }>;
  /** authorized_keys the gateway accepts member logins in, overridable in tests. */
  authorizedKeysPath?: string;
  /** sshd host-key `.pub` files to advertise, overridable in tests. */
  hostKeyFiles?: string[];
  /** Account a member logs in as on the gateway. Defaults to root. */
  reverseSshUser?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function integerOr(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) ? (value as number) : fallback;
}

/**
 * Where a member login lands on the gateway. Windows OpenSSH reads the
 * Administrators file for admin accounts and ignores `~/.ssh/authorized_keys`,
 * so the two platforms must be distinguished here rather than at call sites.
 * @returns absolute authorized_keys path.
 */
function defaultAuthorizedKeysPath(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'ssh', 'administrators_authorized_keys');
  }
  return path.join(homedir(), '.ssh', 'authorized_keys');
}

/** Directories that hold sshd host-key `.pub` files on each platform. */
function defaultHostKeyDirectories(): string[] {
  if (process.platform === 'win32') {
    return [path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'ssh')];
  }
  return ['/etc/ssh'];
}

/** One Host-side WireGuard service per plugin instance. */
export class WireGuardService {
  config: Record<string, unknown>;
  readonly store: Store;
  readonly assets: AssetStore;
  state: PluginState;
  readonly platformFactory: () => Promise<PlatformInfo>;
  readonly tunnelFactory: (platform: PlatformInfo) => any;
  readonly fetchImpl: typeof fetch;
  readonly now: () => number;
  readonly logger: (line: string) => void;
  control: ControlPanel | null;
  controlExtraHandler: ((request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<boolean> | boolean) | null;
  knownHosts: { refresh: (host: string) => Promise<unknown>; forget: (host: string) => Promise<void> };
  readonly commandRunner: NonNullable<WireGuardServiceOptions['commandRunner']>;
  readonly sshRunner: NonNullable<WireGuardServiceOptions['sshRunner']>;
  /** authorized_keys that accepts member logins on the gateway. */
  readonly authorizedKeysPath: string;
  /** sshd host-key files whose public halves are advertised to members. */
  readonly hostKeyFiles: string[];
  /** Account members log in as on the gateway. */
  readonly reverseSshUser: string;
  platform: PlatformInfo | null;
  tunnel: any;
  platformAt: number;
  lock: Promise<void>;
  sshAgentTimer: ReturnType<typeof setInterval> | null;
  sshAgentBusy: boolean;
  sshAgentLastAttempt: number;

  constructor(options: WireGuardServiceOptions) {
    this.config = options.config ?? {};
    this.store = new Store(options.dataDir);
    this.assets = new AssetStore();
    this.state = this.store.state;
    this.platformFactory = options.platformFactory ?? detectPlatform;
    this.tunnelFactory = options.tunnelFactory ?? ((platform) => new Tunnel({ platform, log: (line) => this.#log(line) }));
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.log ?? ((line) => console.log(`[dsh-wireguard] ${line}`));
    this.control = null;
    this.controlExtraHandler = null;
    this.knownHosts = {
      refresh: options.knownHosts?.refresh ?? ((host: string) => refreshKnownHosts(host)),
      forget: options.knownHosts?.forget ?? ((host: string) => forgetKnownHosts(host)),
    };
    this.commandRunner = options.commandRunner ?? ((command, args, commandOptions) => (
      runPrivileged(command, args, { platform: commandOptions.platform, timeout: commandOptions.timeout })
    ));
    this.sshRunner = options.sshRunner ?? (async (input) => {
      const result = await execFileAsync('ssh', [
        '-i', input.keyPath,
        '-o', 'BatchMode=yes',
        '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', 'ConnectTimeout=8',
        `${input.user}@${input.host}`,
        input.command,
      ], { timeout: input.timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
    });
    this.platform = null;
    this.tunnel = null;
    this.platformAt = 0;
    this.lock = Promise.resolve();
    this.authorizedKeysPath = options.authorizedKeysPath ?? defaultAuthorizedKeysPath();
    this.hostKeyFiles = options.hostKeyFiles ?? [];
    const configuredUser = typeof options.reverseSshUser === 'string' ? options.reverseSshUser.trim() : '';
    this.reverseSshUser = SSH_USER_PATTERN.test(configuredUser) ? configuredUser : 'root';
    this.sshAgentTimer = null;
    this.sshAgentBusy = false;
    this.sshAgentLastAttempt = 0;
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
    if (this.state.client.serverUrl && (this.state.client.connected || this.state.client.pending)) {
      this.#startSshAgent();
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
      getPeerRows: () => this.#panelPeers(),
      getAccessCode: () => this.state.settings.joinCode,
      onJoin: (body, remoteAddress) => this.joinPeer(body, remoteAddress),
      onLeave: (body, remoteAddress) => this.leavePeer(body, remoteAddress),
      onSetPeerEgress: (publicKey, enabled) => this.setPeerEgress({ publicKey, enabled }),
      onSshReport: (body, remoteAddress) => this.reportPeerSsh(body, remoteAddress),
      getPeerSshKey: (body) => this.getPeerSshKey(body),
      onAuthorizeMemberKey: (body, remoteAddress) => this.authorizeMemberKey(body, remoteAddress),
      getOpenSshManifest: (body) => this.getOpenSshManifest(body),
      getOpenSshAsset: (body) => this.getOpenSshAsset(body),
      getAssetIndex: (body) => this.getAssetIndex(body),
      getAssetManifest: (body) => this.getAssetManifest(body),
      getAssetFile: (body) => this.getAssetFile(body),
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
      egress: peer.egress === true,
    }));
  }

  /**
   * Peer rows for the server-rendered control panel. Unlike `/peers` this list
   * carries the public key, because the panel's egress toggle needs to address
   * one peer; the page is only rendered after the join-code login.
   * @returns {Array<Record<string, unknown>>} panel rows.
   */
  #panelPeers() {
    return this.state.server.peers.map((peer) => ({
      publicKey: peer.publicKey,
      name: peer.name,
      ip: peer.ip,
      online: peer.online === true,
      egress: peer.egress === true,
      sshConfigured: typeof peer.sshUser === 'string' && peer.sshUser !== '',
      reverseReady: Boolean(peer.reverseKey && peer.reverseKey.fingerprint),
      platform: peer.platform === 'windows' ? 'windows' : peer.platform === 'linux' ? 'linux' : null,
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
        // Keep every field the state file carries (SSH report, egress,
        // reverse key); only the address-bearing fields are normalized here.
        ...raw,
        publicKey,
        ip,
        name: normalizeDeviceName(raw.name, 'client'),
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
        applied: raw.applied !== false,
        egress: raw.egress === true,
        sshUser: typeof raw.sshUser === 'string' && SSH_USER_PATTERN.test(raw.sshUser) ? raw.sshUser : null,
        platform: raw.platform === 'windows' ? 'windows' : raw.platform === 'linux' ? 'linux' : null,
      });
    }
    return peers;
  }

  /**
   * The absolute path of `egress-via-hub.sh`. The bundle can sit next to the
   * script (control-service.js in code/wireguard), one level down (index.js at
   * the package root), or in the source tree during development.
   * @returns {Promise<string>} script path.
   */
  async #egressScriptPath() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const configured = typeof this.config.egressScript === 'string'
      ? this.config.egressScript.trim()
      : String(process.env.DSH_MESH_EGRESS_SCRIPT ?? '').trim();
    const candidates = [
      ...(configured ? [configured] : []),
      path.join(here, 'egress-via-hub.sh'),
      path.join(here, 'code', 'wireguard', 'egress-via-hub.sh'),
      path.resolve(here, '..', '..', '..', 'code', 'wireguard', 'egress-via-hub.sh'),
    ];
    for (const candidate of candidates) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Try the next layout.
      }
    }
    throw new WireGuardError('egress_script_missing', 'The egress helper script egress-via-hub.sh was not found.', {
      status: 500,
      hint: 'Reinstall the plugin package so code/wireguard/egress-via-hub.sh is present next to the control service.',
    });
  }

  /**
   * Run one hub-side command behind the privilege boundary.
   * @param {string} command executable.
   * @param {readonly string[]} args arguments.
   * @returns {Promise<{ stdout: string, stderr: string }>} output.
   */
  async #runHubCommand(command, args) {
    this.#requirePlatform();
    return this.commandRunner(command, args, { platform: this.platform, timeout: 30000 });
  }

  /**
   * Regenerate the hub systemd unit for every peer that currently has egress.
   * Delegating to egress-via-hub.sh keeps the iptables and unit dialect in one
   * place; the script is idempotent, so it is also safe to call on every toggle.
   * @returns {Promise<void>}
   */
  async #syncHubEgress() {
    this.#requirePlatform();
    if (this.platform?.isWindows) {
      throw new WireGuardError('unsupported_platform', 'Egress via the hub needs a Linux hub with iptables.', {
        status: 503,
        hint: 'Run the WireGuard hub on Linux to NAT members through it.',
      });
    }
    const script = await this.#egressScriptPath();
    const bash = findExecutable('bash', ['/bin/bash', '/usr/bin/bash']) ?? 'bash';
    const ips = this.state.server.peers
      .filter((peer) => peer.egress === true)
      .map((peer) => String(peer.ip ?? ''))
      .filter((ip) => ip !== '');
    if (ips.length === 0) await this.#runHubCommand(bash, [script, '--remove']);
    else await this.#runHubCommand(bash, [script, 'hub', ...ips]);
  }

  /**
   * Find the interface used by the default route, so a removed NAT rule matches
   * the rule the helper script added.
   * @returns {Promise<string | null>} WAN interface name.
   */
  async #wanInterface() {
    const ip = this.platform?.ip ?? findExecutable('ip', ['/usr/sbin/ip', '/sbin/ip', '/usr/bin/ip']);
    if (!ip) return null;
    const result = await this.#runHubCommand(ip, ['-4', 'route', 'show', 'default']);
    const match = /\bdev\s+(\S+)/.exec(result.stdout);
    return match?.[1] ?? null;
  }

  /**
   * Remove one member's MASQUERADE rule immediately. The rule is scoped to the
   * member's /32 and the WAN interface, exactly like the helper script.
   * @param {string} ip member VPN address.
   * @returns {Promise<void>}
   */
  async #removeHubNat(ip) {
    if (!this.platform || this.platform.isWindows) return;
    const iptables = this.platform.iptables
      ?? findExecutable('iptables', ['/usr/sbin/iptables', '/sbin/iptables', '/usr/bin/iptables']);
    if (!iptables) {
      this.#log(`could not remove the hub NAT rule for ${ip}: iptables was not found`);
      return;
    }
    let wan = null;
    try {
      wan = await this.#wanInterface();
    } catch (error) {
      this.#log(`could not determine the WAN interface to remove the NAT rule for ${ip}: ${errorMessage(error)}`);
      return;
    }
    if (!wan) {
      this.#log(`could not remove the hub NAT rule for ${ip}: no default route was found`);
      return;
    }
    try {
      await this.#runHubCommand(iptables, ['-t', 'nat', '-D', 'POSTROUTING', '-s', `${ip}/32`, '-o', wan, '-j', 'MASQUERADE']);
      this.#log(`removed the hub NAT rule for ${ip}/32 on ${wan}`);
    } catch (error) {
      // The rule may already be gone after a reboot; that is the desired state.
      this.#log(`no hub NAT rule to remove for ${ip}/32 on ${wan}: ${errorMessage(error)}`);
    }
  }

  /**
   * Best-effort cleanup when an egress peer leaves: drop its NAT rule and
   * rewrite the unit without it. A leftover rule would be harmless but stale.
   * @param {Record<string, any>} peer removed peer.
   * @returns {Promise<void>}
   */
  async #cleanupPeerEgress(peer) {
    try {
      await this.#removeHubNat(String(peer.ip ?? ''));
    } catch (error) {
      this.#log(`could not remove the NAT rule of the leaving peer ${peer.ip}: ${errorMessage(error)}`);
    }
    try {
      await this.#syncHubEgress();
    } catch (error) {
      this.#log(`could not refresh the hub egress unit after ${peer.name} left: ${errorMessage(error)}`);
    }
  }

  /**
   * Values shared by the automatic and manual member halves. The peer record
   * does not always know the OS (older peers joined before the client scripts
   * sent it), so Linux is the documented default; configuring SSH in the panel
   * records the platform explicitly.
   * @param {Record<string, any>} peer peer record.
   * @param {boolean} enabled whether egress should be on.
   * @returns {EgressTarget} member values.
   */
  #egressTarget(peer, enabled): EgressTarget {
    const hubKey = normalizeKey(this.state.server.publicKey);
    const hubIp = String(this.state.settings.serverIp ?? '').trim();
    const vpnCidr = parseCidr(this.state.server.vpnCidr || this.state.settings.vpnCidr);
    if (!hubKey || !vpnCidr || parseIpv4(hubIp) === null) {
      throw new WireGuardError('server_not_ready', 'The WireGuard server is missing its key or VPN address.', { status: 500 });
    }
    return {
      enabled,
      // Both sides default to dshwg0; the hub has no separate record of the
      // member tunnel name, so it reuses the interface the join script created.
      interfaceName: this.state.server.interfaceName || this.state.settings.interfaceName,
      hubIp,
      hubKey,
      vpnCidr: vpnCidr.normalized,
      platform: peer.platform === 'windows' ? 'windows' : 'linux',
    };
  }

  /**
   * Copy-paste commands for the member half.
   * @param {Record<string, any>} peer peer record.
   * @returns {{ enable: string, disable: string }} both directions.
   */
  #manualEgressCommands(peer) {
    const target = this.#egressTarget(peer, true);
    const base = { ...target };
    delete base.enabled;
    return buildManualEgressCommands(base);
  }

  /**
   * Apply the member half over SSH. The remote script is the same one the panel
   * shows for copy-paste, so success and failure stay in one dialect.
   * @param {Record<string, any>} peer peer record.
   * @param {boolean} enabled whether egress should be on.
   * @returns {Promise<void>}
   */
  async #runMemberEgress(peer, enabled) {
    if (typeof peer.sshUser !== 'string' || peer.sshUser === '') throw new Error('该成员未配置 SSH');
    const keyPath = this.#sshKeyPath(peer.publicKey);
    try {
      await access(keyPath);
    } catch {
      throw new Error('该成员的 SSH 私钥不存在，请重新配置 SSH');
    }
    const target = this.#egressTarget(peer, enabled);
    const command = target.platform === 'windows'
      ? encodeWindowsCommand(buildWindowsEgressScript(target))
      : buildLinuxEgressSshCommand(target, peer.sshUser);
    await this.sshRunner({
      host: peer.ip,
      user: peer.sshUser,
      keyPath,
      command,
      timeout: 40000,
    });
  }

  /**
   * Toggle IPv4 egress through the hub for one peer.
   *
   * The hub half is applied first and a failure there is fatal, because a
   * member-side default route without NAT blackholes the member's internet.
   * The member half is best effort: when SSH is missing or unreachable the
   * toggle still persists so a rejoin writes `AllowedIPs = 0.0.0.0/0`, and the
   * response carries copy-paste commands for the operator.
   * @param {Record<string, unknown>} input peer public key and desired state.
   * @returns {Promise<Record<string, unknown>>} applied flag, optional manual commands, snapshot.
   */
  async setPeerEgress(input) {
    return this.#serialized(async () => {
      await this.#detect(false);
      this.#requirePlatform();
      const publicKey = normalizeKey(input?.publicKey);
      if (!publicKey) {
        throw new WireGuardError('invalid_public_key', 'A valid WireGuard public key is required.', { status: 400 });
      }
      const enabled = input?.enabled === true || input?.egress === true;
      const peer = this.state.server.peers.find((candidate) => candidate.publicKey === publicKey);
      if (!peer) {
        throw new WireGuardError('peer_not_found', 'That device has not joined this server.', { status: 404 });
      }
      if (!this.state.server.running || !this.state.server.publicKey) {
        throw new WireGuardError('not_running', 'The WireGuard server is not running.', { status: 503 });
      }
      if (this.platform?.isWindows) {
        throw new WireGuardError('unsupported_platform', 'Egress via the hub needs a Linux hub with iptables.', {
          status: 503,
          hint: 'Run the WireGuard hub on Linux to NAT members through it.',
        });
      }
      const previous = peer.egress === true;
      peer.egress = enabled;
      try {
        // The unit lists exactly the enabled peers; removing this peer's NAT
        // rule happens after the rewrite so a failed rewrite cannot leave the
        // member's default route pointing at a hub that no longer NATs it.
        await this.#syncHubEgress();
        if (!enabled) await this.#removeHubNat(String(peer.ip ?? ''));
      } catch (error) {
        peer.egress = previous;
        throw new WireGuardError('egress_failed', `Could not update the hub NAT rule: ${errorMessage(error)}`, {
          status: 500,
          hint: 'Check that the control service runs as root and that iptables, bash and systemd are available on the hub.',
          details: { stderr: errorMessage(error).slice(0, 800) },
        });
      }
      await this.#persist();
      const manual = this.#manualEgressCommands(peer);
      const result = {
        egress: enabled,
        applied: false,
        state: this.snapshot(),
        manual,
        reason: '',
      };
      if (typeof peer.sshUser !== 'string' || peer.sshUser === '') {
        result.reason = '该成员未配置 SSH，无法自动应用到成员端。';
        this.#log(`egress ${enabled ? 'enabled' : 'disabled'} on the hub for ${peer.name}; the member half needs manual work (no SSH)`);
        return result;
      }
      try {
        await this.#runMemberEgress(peer, enabled);
        this.#log(`egress ${enabled ? 'enabled' : 'disabled'} for ${peer.name} (${peer.ip}) on both sides`);
        return { egress: enabled, applied: true, state: this.snapshot(), manual };
      } catch (error) {
        const reason = `成员端自动配置失败：${errorMessage(error)}`;
        this.#log(`could not apply egress on ${peer.name} over SSH: ${errorMessage(error)}`);
        return { ...result, reason };
      }
    });
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
      if (peers.some((peer) => peer.egress === true)) {
        // Recreate the NAT unit after a reinstall or a state restore. A failure
        // is a warning, not a reason to stop the tunnel the operator just paid
        // for with a restart.
        try {
          await this.#syncHubEgress();
        } catch (error) {
          this.state.server.warnings.push(`Could not restore hub NAT egress: ${errorMessage(error)}`);
          this.#log(`could not restore hub NAT egress: ${errorMessage(error)}`);
        }
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
        body: { name, publicKey: key.publicKey, code: joinCode, family, platform: this.platform?.isWindows ? 'windows' : 'linux' },
      });
      const assignedIp = parseIpv4(join?.client?.ip);
      if (assignedIp === null || !isUsableHost(assignedIp, vpnCidr)) {
        throw new WireGuardError('bad_server', 'The server did not assign a valid client address.', { status: 502 });
      }
      const assignedAddress = ipv4ToString(assignedIp);
      const joinedServerKey = normalizeKey(join?.server?.publicKey ?? serverPublicKey);
      if (!joinedServerKey) throw new WireGuardError('bad_server', 'The server returned an invalid public key.', { status: 502 });
      // A server that enables egress for this peer answers with `egress:true`
      // and its own VPN address, which the member uses as the default gateway.
      const egress = join?.egress === true;
      const hubIpNumber = parseIpv4(join?.server?.vpnIp);
      if (egress && hubIpNumber === null) {
        throw new WireGuardError('bad_server', 'The server enabled egress but did not return its VPN address.', { status: 502 });
      }
      const hubIp = egress ? ipv4ToString(hubIpNumber) : null;
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
        egress,
      });
      await this.store.writeConfig('client', configText, this.state.settings.interfaceName, this.platform?.isWindows === true);
      const agentToken = typeof join?.sshToken === 'string' && join.sshToken ? join.sshToken : null;
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
        egress,
        hubIp,
        joinCode,
        sshToken: agentToken,
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
          egress,
          hubIp,
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
      if (this.state.client.sshToken) this.#startSshAgent();
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
          egress: client.egress === true,
          hubIp: client.hubIp ?? null,
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
      if (this.state.client.sshToken) this.#startSshAgent();
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
      this.#stopSshAgent();
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
        const platform = body.platform === 'windows' ? 'windows' : body.platform === 'linux' ? 'linux' : null;
        if (platform) existing.platform = platform;
        this.#ensurePeerSshToken(existing);
        await this.tunnel.addPeer(this.state.server.interfaceName, existing);
        existing.applied = true;
        if (existing.egress === true) {
          // A rejoin writes AllowedIPs from the response, so the hub NAT rule
          // has to be present before the member starts sending internet traffic.
          try {
            await this.#syncHubEgress();
          } catch (error) {
            this.#log(`could not apply hub NAT egress for ${name} on rejoin: ${errorMessage(error)}`);
          }
        }
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
        sshToken: null,
        sshInstalled: false,
        sshRunning: false,
        sshReady: false,
        sshVersion: null,
        sshPort: 22,
        sshLastReportAt: null,
        sshError: null,
        egress: false,
        platform: body.platform === 'windows' ? 'windows' : body.platform === 'linux' ? 'linux' : null,
      };
      this.#ensurePeerSshToken(peer);
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
      await this.#removeReverseKey(peer);
      if (peer.egress === true) await this.#cleanupPeerEgress(peer);
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
      await this.#removeReverseKey(peer);
      if (peer.egress === true) await this.#cleanupPeerEgress(peer);
      try {
        await this.knownHosts.forget(peer.ip);
      } catch {
        // Best effort: an absent entry is already the desired state.
      }
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
      // The egress automation needs the member OS to choose between the POSIX
      // and PowerShell halves; record the tab the operator generated for.
      if (input.platform === 'windows' || input.platform === 'linux') peer.platform = input.platform;
      await this.#persist();
      this.#log(`configured SSH access for ${peer.name} as ${user}`);
      // The peer's sshd host key may be newer than the stale entry left by a
      // reinstall or by another machine that used this VPN address.
      try {
        const keys = await this.knownHosts.refresh(peer.ip);
        this.#log(`refreshed the SSH host key for ${peer.name} (${Array.isArray(keys) ? keys.length : 0} key(s))`);
      } catch (error) {
        this.#log(`could not refresh the SSH host key for ${peer.name}: ${errorMessage(error)}`);
      }
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

  /** Create and persist the member agent token on first use. */
  #ensurePeerSshToken(peer) {
    if (typeof peer.sshToken !== 'string' || !peer.sshToken) {
      peer.sshToken = randomBytes(32).toString('base64url');
    }
    return peer.sshToken;
  }

  /** Resolve one peer from its WireGuard key and per-peer agent token. */
  #peerByToken(publicKey, token) {
    const key = normalizeKey(publicKey);
    if (!key) {
      throw new WireGuardError('invalid_public_key', 'A valid WireGuard public key is required.', { status: 400 });
    }
    const peer = this.state.server.peers.find((candidate) => candidate.publicKey === key);
    const expected = peer && typeof peer.sshToken === 'string' ? peer.sshToken : '';
    if (!peer || !secretsMatch(String(token ?? ''), expected)) {
      throw new WireGuardError('invalid_peer_token', 'The member agent token is missing or invalid.', { status: 401 });
    }
    return peer;
  }

  /** Public view of one peer's SSH state; never includes the agent token. */
  #peerSshView(peer) {
    return {
      publicKey: peer.publicKey,
      name: peer.name,
      ip: peer.ip,
      platform: peer.platform === 'windows' ? 'windows' : peer.platform === 'linux' ? 'linux' : null,
      user: peer.sshUser ?? null,
      installed: peer.sshInstalled === true,
      running: peer.sshRunning === true,
      ready: peer.sshReady === true,
      version: typeof peer.sshVersion === 'string' ? peer.sshVersion : null,
      port: integerOr(peer.sshPort, 22),
      error: typeof peer.sshError === 'string' ? peer.sshError : null,
      lastReportAt: typeof peer.sshLastReportAt === 'string' ? peer.sshLastReportAt : null,
      // The other direction: the member logging in to this gateway.
      reverse: this.#reverseSshView(peer),
    };
  }

  /**
   * Record what the member agent found and installed. This is the only writer
   * of peer.sshUser, so a Windows host no longer has to guess "Administrator".
   * @param {Record<string, unknown>} body report payload.
   * @param {string} remoteAddress caller address.
   * @returns {Promise<Record<string, unknown>>} updated public peer fields.
   */
  async reportPeerSsh(body, remoteAddress = '') {
    return this.#serialized(async () => {
      const peer = this.#peerByToken(body.publicKey, body.token);
      const wasReady = peer.sshReady === true;
      const previousUser = typeof peer.sshUser === 'string' ? peer.sshUser : null;
      const platform = body.platform === 'windows' ? 'windows' : body.platform === 'linux' ? 'linux' : peer.platform;
      if (platform) peer.platform = platform;
      if (typeof body.user === 'string' && body.user.trim()) {
        const user = body.user.trim();
        if (!SSH_USER_PATTERN.test(user)) {
          throw new WireGuardError('invalid_ssh_user', 'The reported SSH username is invalid.', { status: 400 });
        }
        peer.sshUser = user;
      }
      peer.sshInstalled = body.sshInstalled === true;
      peer.sshRunning = body.sshRunning === true;
      const port = integerOr(body.sshPort, 22);
      peer.sshPort = port >= 1 && port <= 65535 ? port : 22;
      peer.sshVersion = typeof body.sshVersion === 'string' ? body.sshVersion.trim().slice(0, 120) : null;
      const reportedError = typeof body.sshError === 'string' ? body.sshError.trim().slice(0, 500) : '';
      const ready = body.sshReady === true
        && peer.sshInstalled === true
        && peer.sshRunning === true
        && typeof peer.sshUser === 'string'
        && peer.sshUser !== '';
      peer.sshReady = ready;
      peer.sshError = ready ? null : (reportedError || 'SSH is not ready');
      peer.sshLastReportAt = new Date().toISOString();
      await this.#persist();
      const userChanged = previousUser !== (peer.sshUser ?? null);
      this.#log(`SSH report from ${peer.name} (${peer.ip}) via ${remoteAddress || 'member'}: user=${peer.sshUser ?? '-'} ready=${ready}`);
      if (ready && (!wasReady || userChanged)) {
        try {
          const keys = await this.knownHosts.refresh(peer.ip);
          this.#log(`refreshed the SSH host key for ${peer.name} (${Array.isArray(keys) ? keys.length : 0} key(s))`);
        } catch (error) {
          this.#log(`could not refresh the SSH host key for ${peer.name}: ${errorMessage(error)}`);
        }
      }
      return { peer: this.#peerSshView(peer) };
    });
  }

  /**
   * Return the server's SSH public key for one peer. The member agent installs
   * this key locally; the private key never leaves the server.
   * @param {Record<string, unknown>} body public key and agent token.
   * @returns {Promise<Record<string, unknown>>} public key and target user.
   */
  async getPeerSshKey(body) {
    return this.#serialized(async () => {
      const peer = this.#peerByToken(body.publicKey, body.token);
      const publicKey = await this.#ensureSshKey(peer.publicKey);
      return { publicKey, user: peer.sshUser ?? null, host: peer.ip };
    });
  }

  /**
   * Accept a member's own public key so it can log in to the gateway. This is
   * the mirror image of {@link getPeerSshKey}: the member owns the private key,
   * and only the public half ever crosses the wire. The entry is pinned to the
   * member's VPN address with `from=`.
   * @param {Record<string, unknown>} body peer public key, agent token, and ssh public key.
   * @param {string} remoteAddress caller address, for the audit log.
   * @returns {Promise<Record<string, unknown>>} gateway coordinates and host keys.
   */
  async authorizeMemberKey(body, remoteAddress = '') {
    return this.#serialized(async () => {
      const peer = this.#peerByToken(body.publicKey, body.token);
      const key = parseSshPublicKey(body.sshPublicKey ?? body.memberPublicKey);
      if (!key) {
        throw new WireGuardError('invalid_ssh_key', 'The member SSH public key is invalid.', {
          status: 400,
          hint: 'Send an OpenSSH public key such as "ssh-ed25519 AAAA...".',
        });
      }
      // The member has no business receiving this gateway's whole snapshot.
      const { state: _state, ...result } = await this.#installMemberKey(peer, key, `member ${remoteAddress || ''}`.trim());
      return result;
    });
  }

  /**
   * Panel variant of {@link authorizeMemberKey}: the operator pastes the public
   * key that a member generated locally. Passing an empty key revokes the
   * member's login instead.
   * @param {Record<string, unknown>} input peer public key and optional ssh public key.
   * @returns {Promise<Record<string, unknown>>} snapshot and the reverse view.
   */
  async setPeerReverseKey(input) {
    return this.#serialized(async () => {
      const publicKey = normalizeKey(input.publicKey);
      if (!publicKey) {
        throw new WireGuardError('invalid_public_key', 'A valid WireGuard public key is required.', { status: 400 });
      }
      const peer = this.state.server.peers.find((candidate) => candidate.publicKey === publicKey);
      if (!peer) {
        throw new WireGuardError('peer_not_found', 'That device has not joined this server.', { status: 404 });
      }
      const raw = typeof input.sshPublicKey === 'string' ? input.sshPublicKey.trim() : '';
      if (!raw) {
        await this.#removeReverseKey(peer);
        await this.#persist();
        this.#log(`revoked the member SSH key for ${peer.name} (${peer.ip})`);
        return { state: this.snapshot(), reverse: this.#reverseSshView(peer) };
      }
      const key = parseSshPublicKey(raw);
      if (!key) {
        throw new WireGuardError('invalid_ssh_key', 'That is not an OpenSSH public key.', {
          status: 400,
          hint: 'Paste the contents of ~/.ssh/id_ed25519_dsh_mesh.pub, starting with "ssh-ed25519".',
        });
      }
      const result = await this.#installMemberKey(peer, key, 'panel');
      return { state: result.state, reverse: result.reverse };
    });
  }

  /**
   * Write one member's public key into authorized_keys, restricted to its VPN
   * address, and record the result on the peer.
   * @param {Record<string, any>} peer target peer.
   * @param {import('./member-ssh').SshPublicKey} key parsed member key.
   * @param {string} source audit label.
   * @returns {Promise<Record<string, unknown>>} install result for the member.
   */
  async #installMemberKey(peer, key, source) {
    const host = this.state.settings.serverIp;
    const port = 22;
    const user = this.reverseSshUser;
    const entry = formatAuthorizedKeyLine({ key, from: peer.ip, tag: peer.ip, comment: key.comment });
    await this.#writeAuthorizedKeys((current) => upsertAuthorizedKey(current, entry, peer.ip));
    const reverse = {
      publicKey: key.text,
      fingerprint: sshKeyFingerprint(key),
      from: peer.ip,
      user,
      port,
      host,
      installedAt: new Date().toISOString(),
      comment: key.comment || null,
    };
    peer.reverseKey = reverse;
    await this.#persist();
    this.#log(`authorized the member SSH key for ${peer.name} (${peer.ip}) from ${source || 'member'}`);
    const hostKeys = await this.#ownHostKeys();
    const knownHostsText = hostKeys.map((item) => `${host} ${item}`).join('\n');
    return {
      state: this.snapshot(),
      reverse: this.#reverseSshView(peer),
      authorized: true,
      host,
      user,
      port,
      from: peer.ip,
      fingerprint: reverse.fingerprint,
      hostKeys,
      command: gatewaySshCommand({ host, user, port }),
      sshConfig: gatewaySshConfigBlock({ host, user, port }),
      sshConfigB64: encodeText(`${gatewaySshConfigBlock({ host, user, port })}\n`),
      knownHostsB64: encodeText(knownHostsText ? `${knownHostsText}\n` : ''),
    };
  }

  /**
   * Replace the managed authorized_keys file contents. The rewrite is atomic so
   * a crash cannot leave the gateway without its own login keys.
   * @param {(text: string) => string} change receives the current text.
   * @returns {Promise<void>}
   */
  async #writeAuthorizedKeys(change) {
    const file = this.authorizedKeysPath;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    let current = '';
    try {
      current = await readFile(file, 'utf8');
    } catch {
      // A missing file simply starts empty.
    }
    const next = change(current);
    if (next === current) return;
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, next, { encoding: 'utf8', mode: 0o600 });
    try {
      await chmod(temporary, 0o600);
    } catch {
      // Windows ignores POSIX modes.
    }
    await rename(temporary, file);
  }

  /**
   * Revoke a peer's reverse login when the peer leaves or is removed.
   * @param {Record<string, any>} peer peer being removed.
   * @returns {Promise<void>}
   */
  async #removeReverseKey(peer) {
    if (!peer?.reverseKey) return;
    try {
      await this.#writeAuthorizedKeys((current) => removeAuthorizedKeyTag(current, peer.ip));
    } catch (error) {
      this.#log(`could not revoke the SSH login of ${peer.name} (${peer.ip}): ${errorMessage(error)}`);
    }
    peer.reverseKey = null;
  }

  /**
   * The host keys the gateway offers, so a member can pin known_hosts during
   * enrollment instead of answering a trust prompt.
   * @returns {Promise<string[]>} `type base64` lines, ed25519 first.
   */
  async #ownHostKeys() {
    let files = this.hostKeyFiles.filter((file) => typeof file === 'string' && file !== '');
    if (files.length === 0) {
      for (const directory of defaultHostKeyDirectories()) {
        let names: string[] = [];
        try {
          names = await readdir(directory);
        } catch {
          continue;
        }
        for (const name of names) {
          if (/^ssh_host_.*_key\.pub$/u.test(name)) files.push(path.join(directory, name));
        }
      }
    }
    files = files.sort((left, right) => Number(!left.includes('ed25519')) - Number(!right.includes('ed25519')));
    const keys: string[] = [];
    for (const file of files) {
      try {
        const line = (await readFile(file, 'utf8')).split(/\r?\n/u).find((item) => item.trim() !== '');
        const parsed = parseSshPublicKey(line ?? '');
        if (parsed) keys.push(parsed.text);
      } catch {
        // Fall through to the live scan below.
      }
    }
    if (keys.length > 0) return keys;
    try {
      const scan = await execFileAsync('ssh-keyscan', ['-T', '5', '-p', '22', '127.0.0.1'], { timeout: 15_000, windowsHide: true });
      const scanned = [];
      for (const line of String(scan.stdout ?? '').split(/\r?\n/u)) {
        const parsed = parseSshPublicKey(line);
        if (parsed) scanned.push(parsed.text);
      }
      return scanned;
    } catch {
      return [];
    }
  }

  /** Public view of one peer's member-to-gateway login. */
  #reverseSshView(peer) {
    const reverse = peer.reverseKey && typeof peer.reverseKey === 'object' ? peer.reverseKey : null;
    const host = this.state.settings.serverIp;
    const user = typeof reverse?.user === 'string' && SSH_USER_PATTERN.test(reverse.user) ? reverse.user : this.reverseSshUser;
    const port = integerOr(reverse?.port, 22);
    return {
      ready: typeof reverse?.fingerprint === 'string' && reverse.fingerprint !== '',
      host,
      user,
      port,
      from: typeof reverse?.from === 'string' ? reverse.from : peer.ip,
      fingerprint: typeof reverse?.fingerprint === 'string' ? reverse.fingerprint : null,
      installedAt: typeof reverse?.installedAt === 'string' ? reverse.installedAt : null,
      command: gatewaySshCommand({ host, user, port }),
    };
  }

  /** List the gateway's static assets for an authenticated member. */
  async getAssetIndex(body) {
    this.#peerByToken(body.publicKey, body.token);
    return { assets: await this.assets.index() };
  }

  /** Describe one static asset for an authenticated member. */
  async getAssetManifest(body) {
    this.#peerByToken(body.publicKey, body.token);
    return { ...(await this.assets.manifest(String(body.name ?? ''))) } as Record<string, unknown>;
  }

  /** Resolve one static asset file for an authenticated member. */
  async getAssetFile(body) {
    this.#peerByToken(body.publicKey, body.token);
    return this.assets.file(String(body.name ?? ''), String(body.file ?? ''));
  }

  /**
   * Legacy shape for older agents: describe the Windows OpenSSH package.
   * @param {Record<string, unknown>} body public key and agent token.
   * @returns {Promise<OpenSshAssetManifest>} package manifest.
   */
  async getOpenSshManifest(body) {
    this.#peerByToken(body.publicKey, body.token);
    const manifest = await this.assets.manifest('openssh');
    const asset = manifest.assets.find(item => item.os === 'windows' && item.arch === 'x64') ?? manifest.assets[0];
    return {
      name: manifest.name,
      version: manifest.version,
      file: asset.file,
      sha256: asset.sha256,
      bytes: asset.bytes,
    };
  }

  /**
   * Legacy shape for older agents: resolve the Windows OpenSSH zip.
   * @param {Record<string, unknown>} body public key and agent token.
   * @returns {Promise<{ path: string, name: string, size: number, contentType: string, sha256: string }>} package file.
   */
  async getOpenSshAsset(body) {
    this.#peerByToken(body.publicKey, body.token);
    const asset = await this.assets.first('openssh', 'windows', 'x64');
    return this.assets.file('openssh', asset.file);
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
      // Per-peer secret used by the member agent for its SSH status/key
      // reports. It is only returned to the joining peer.
      sshToken: typeof peer.sshToken === 'string' ? peer.sshToken : null,
      // The member scripts switch AllowedIPs to 0.0.0.0/0 only when this is
      // true; keeping the flag out of `server` makes that switch explicit.
      egress: peer.egress === true,
      server: {
        name: localHostname(),
        publicKey: server.publicKey,
        endpoint,
        endpointHost: server.endpointHost,
        vpnCidr: server.vpnCidr,
        // The default route needs a next hop inside the tunnel.
        vpnIp: this.state.settings.serverIp,
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
          egress: peer.egress === true,
          sshConfigured: Boolean(peer.sshUser),
          sshUser: peer.sshUser ?? null,
          sshInstalled: peer.sshInstalled === true,
          sshRunning: peer.sshRunning === true,
          sshReady: peer.sshReady === true,
          sshVersion: typeof peer.sshVersion === 'string' ? peer.sshVersion : null,
          sshPort: integerOr(peer.sshPort, 22),
          sshLastReportAt: typeof peer.sshLastReportAt === 'string' ? peer.sshLastReportAt : null,
          sshError: typeof peer.sshError === 'string' ? peer.sshError : null,
          reverse: this.#reverseSshView(peer),
          platform: peer.platform === 'windows' ? 'windows' : peer.platform === 'linux' ? 'linux' : null,
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
  async #fetchJson(url: string, options: { method?: string; body?: unknown; timeout?: number; headers?: Record<string, string> } = {}): Promise<Record<string, any>> {
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
            ...(options.headers ?? {}),
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

  /** Start the periodic member SSH agent. Safe to call repeatedly. */
  #startSshAgent() {
    if (this.sshAgentTimer) return;
    this.#log('SSH agent started');
    void this.#runSshAgent();
    this.sshAgentTimer = setInterval(() => { void this.#runSshAgent(); }, SSH_AGENT_INTERVAL_MS);
    this.sshAgentTimer.unref?.();
  }

  /** Stop the periodic member SSH agent. */
  #stopSshAgent() {
    if (!this.sshAgentTimer) return;
    clearInterval(this.sshAgentTimer);
    this.sshAgentTimer = null;
    this.#log('SSH agent stopped');
  }

  /** One guarded agent pass; failures are logged and retried on the next tick. */
  async #runSshAgent() {
    if (this.sshAgentBusy) return;
    this.sshAgentBusy = true;
    try {
      await this.#sshAgentTick();
    } catch (error) {
      this.#log(`SSH agent: ${errorMessage(error)}`);
    } finally {
      this.sshAgentBusy = false;
    }
  }

  /** Inspect, auto-install, enroll the key, and report the local SSH state. */
  async #sshAgentTick() {
    const client = this.state.client;
    if (!client.connected || !client.serverUrl || !client.publicKey) return;
    await this.#detect(false);
    const platform = this.platform;
    if (!platform) return;
    await this.#ensureAgentToken();
    const token = this.state.client.sshToken;
    if (!token) throw new Error('the server did not issue an SSH agent token');
    let status = await inspectSsh(platform);
    const needsRepair = platform.isWindows && (!status.installed || !status.ready);
    if (needsRepair && this.now() - this.sshAgentLastAttempt >= SSH_INSTALL_RETRY_MS) {
      this.sshAgentLastAttempt = this.now();
      let zipPath = null;
      try {
        const serverKey = await this.#fetchPeerSshKey(token);
        const manifest = await this.#fetchOpenSshManifest(token);
        zipPath = await this.#downloadOpenSshAsset(token, manifest);
        await installWindowsOpenSsh(platform, zipPath, serverKey, status.user);
        status = await inspectSsh(platform);
      } catch (error) {
        status.error = `OpenSSH auto-install failed: ${errorMessage(error)}`;
        this.#log(`SSH agent: ${status.error}`);
      } finally {
        if (zipPath) await rm(path.dirname(zipPath), { recursive: true, force: true }).catch(() => {});
      }
    }
    if (status.ready && status.user) {
      try {
        const serverKey = await this.#fetchPeerSshKey(token);
        if (platform.isWindows) await authorizeWindowsKey(platform, serverKey, status.user);
        else await authorizeLinuxKey(platform, serverKey, status.user);
      } catch (error) {
        status.ready = false;
        status.error = `SSH key enrollment failed: ${errorMessage(error)}`;
        this.#log(`SSH agent: ${status.error}`);
      }
    }
    // The reverse direction does not depend on this member's sshd: it is the
    // member logging in to the gateway, so it runs even when sshd is broken.
    try {
      const reverse = await this.#enrollReverseSsh(token, platform, status.user);
      this.#setClientReverse(reverse);
    } catch (error) {
      const message = errorMessage(error);
      this.#log(`SSH agent: reverse enrollment failed: ${message}`);
      this.#setClientReverse({ ...(this.state.client.reverseSsh ?? {}), ready: false, error: message });
    }
    await this.#postSshReport(token, platform, status);
  }

  /**
   * Persist the member's gateway login state, but only when it changed so the
   * five-minute agent does not rewrite state.json on every tick.
   * @param {Record<string, any>} reverse local reverse-SSH view.
   * @returns {void}
   */
  #setClientReverse(reverse) {
    const next = { ...reverse, updatedAt: new Date().toISOString() };
    const previous = this.state.client.reverseSsh;
    const strip = (value) => {
      if (!value) return '';
      const { updatedAt: _updatedAt, ...rest } = value;
      return JSON.stringify(rest);
    };
    this.state.client.reverseSsh = next;
    if (strip(previous) === strip(next)) return;
    void this.#persist().catch((error) => this.#log(`could not persist the reverse SSH state: ${errorMessage(error)}`));
  }

  /**
   * Enroll this member's own key with the gateway so `ssh dsh-gateway` works
   * from here. Idempotent: the gateway replaces the line tagged with our VPN
   * address, and an existing local key is reused.
   * @param {string} token per-peer agent token.
   * @param {PlatformInfo} platform resolved platform.
   * @param {string | null} user account that should own the local files.
   * @returns {Promise<Record<string, any>>} what was installed.
   */
  async #enrollReverseSsh(token, platform, user) {
    const client = this.state.client;
    if (!client.serverUrl || !client.publicKey) throw new Error('the client is not connected to a server');
    const paths = memberSshPaths(platform, user);
    const identity = await ensureMemberKey(platform, paths, { comment: `dsh-mesh@${localHostname()}`, user });
    const result = await this.#fetchJson(`${client.serverUrl}/ssh/authorize`, {
      method: 'POST',
      body: { publicKey: client.publicKey, token, sshPublicKey: identity.publicKey },
      timeout: 15000,
    });
    const host = String(result.host ?? '').trim();
    if (!host) throw new Error('the gateway did not report its VPN address');
    const loginUser = String(result.user ?? 'root').trim() || 'root';
    const port = integerOr(result.port, 22);
    const hostKeys = Array.isArray(result.hostKeys) ? result.hostKeys.filter((item) => typeof item === 'string') : [];
    const configText = typeof result.sshConfig === 'string' && result.sshConfig.trim()
      ? result.sshConfig
      : gatewaySshConfigBlock({ host, user: loginUser, port });
    let knownHostsText = '';
    if (typeof result.knownHostsB64 === 'string' && result.knownHostsB64) {
      knownHostsText = Buffer.from(result.knownHostsB64, 'base64').toString('utf8');
    }
    if (!knownHostsText.trim() && hostKeys.length > 0) {
      knownHostsText = `${hostKeys.map((item) => `${host} ${item}`).join('\n')}\n`;
    }
    await installGatewaySshAccess(platform, paths, { host, user: loginUser, port, configText, knownHostsText }, { user });
    const fingerprint = typeof result.fingerprint === 'string' ? result.fingerprint : sshKeyFingerprint(identity.publicKey);
    this.#log(`reverse SSH ready: ${loginUser}@${host}:${port} via ${paths.privateKey}`);
    return {
      ready: true,
      host,
      user: loginUser,
      port,
      from: typeof result.from === 'string' ? result.from : null,
      fingerprint,
      keyPath: paths.privateKey,
      configPath: paths.config,
      command: gatewaySshCommand({ host, user: loginUser, port }),
      installedAt: new Date().toISOString(),
      error: null,
    };
  }

  /** Bootstrap the per-peer token through /join for members that predate it. */
  async #ensureAgentToken() {
    const client = this.state.client;
    if (typeof client.sshToken === 'string' && client.sshToken) return;
    if (!client.serverUrl || !client.publicKey) throw new Error('the client is not connected to a server');
    if (!client.joinCode) throw new Error('the saved client has no join code; reconnect to the server to enroll SSH');
    const platform = this.platform?.isWindows ? 'windows' : 'linux';
    const join = await this.#fetchJson(`${client.serverUrl}/join`, {
      method: 'POST',
      body: {
        name: client.name ?? localHostname(),
        publicKey: client.publicKey,
        code: client.joinCode,
        family: '',
        platform,
      },
      timeout: 10000,
    });
    const token = typeof join.sshToken === 'string' ? join.sshToken : '';
    if (!token) throw new Error('the server did not return an SSH agent token');
    await this.#serialized(async () => {
      if (!this.state.client.sshToken) {
        this.state.client.sshToken = token;
        await this.#persist();
      }
    });
    this.#log('SSH agent token enrolled');
  }

  /** Ask the server for this peer's SSH public key. */
  async #fetchPeerSshKey(token: string): Promise<string> {
    const client = this.state.client;
    if (!client.serverUrl || !client.publicKey) throw new Error('the client is not connected to a server');
    const result = await this.#fetchJson(`${client.serverUrl}/ssh/key`, {
      method: 'POST',
      body: { publicKey: client.publicKey, token },
      timeout: 12000,
    });
    const publicKey = String(result.publicKey ?? '').trim();
    if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/u.test(publicKey)) {
      throw new Error('the server returned an unexpected SSH public key');
    }
    return publicKey;
  }

  /** Ask the server for the Windows OpenSSH package manifest. */
  async #fetchOpenSshManifest(token: string): Promise<OpenSshAssetManifest> {
    const client = this.state.client;
    if (!client.serverUrl || !client.publicKey) throw new Error('the client is not connected to a server');
    const query = `publicKey=${encodeURIComponent(client.publicKey)}`;
    let result: Record<string, any>;
    try {
      result = await this.#fetchJson(`${client.serverUrl}/assets/openssh?${query}`, {
        headers: { 'x-dsh-peer-token': token },
        timeout: 12000,
      });
    } catch {
      // Older control services only expose the /ssh aliases.
      result = await this.#fetchJson(`${client.serverUrl}/ssh/manifest`, {
        method: 'POST',
        body: { publicKey: client.publicKey, token },
        timeout: 12000,
      });
    }
    const entries = Array.isArray(result.assets) ? result.assets : [];
    const selected = entries.find((item: any) => item?.os === 'windows' && item?.arch === 'x64') ?? entries[0] ?? result;
    const manifest = {
      name: String(result.name ?? 'openssh'),
      version: String(result.version ?? 'unknown'),
      file: String(selected.file ?? ''),
      sha256: String(selected.sha256 ?? '').toLowerCase(),
      bytes: Number(selected.bytes),
    };
    if (!/^[A-Za-z0-9._-]+\.zip$/u.test(manifest.file)
      || !/^[0-9a-f]{64}$/u.test(manifest.sha256)
      || !Number.isSafeInteger(manifest.bytes)
      || manifest.bytes <= 0) {
      throw new Error('the server returned an invalid OpenSSH package manifest');
    }
    return manifest;
  }

  /** Download the OpenSSH zip from the control panel and verify its checksum. */
  async #downloadOpenSshAsset(token: string, manifest: OpenSshAssetManifest): Promise<string> {
    const client = this.state.client;
    if (!client.serverUrl || !client.publicKey) throw new Error('the client is not connected to a server');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const query = `publicKey=${encodeURIComponent(client.publicKey)}`;
      const generic = `${client.serverUrl}/assets/openssh/${encodeURIComponent(manifest.file)}?${query}`;
      const legacy = `${client.serverUrl}/ssh/asset?${query}`;
      const request = (url: string) => this.fetchImpl(url, {
        headers: { accept: 'application/zip', 'x-dsh-peer-token': token },
        signal: controller.signal,
        redirect: 'error',
      });
      let response = await request(generic);
      if (response.status === 404) response = await request(legacy);
      if (!response.ok) {
        throw new Error(`the gateway refused the OpenSSH package (HTTP ${response.status})`);
      }
      const data = Buffer.from(await response.arrayBuffer());
      const directory = await mkdtemp(path.join(tmpdir(), 'dsh-openssh-'));
      const zipPath = path.join(directory, manifest.file);
      await writeFile(zipPath, data);
      await verifyOpenSshZip(zipPath, manifest);
      this.#log(`downloaded OpenSSH ${manifest.version} (${data.length} bytes)`);
      return zipPath;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Publish the final SSH state to the server. */
  async #postSshReport(token: string, platform: PlatformInfo, status: SshAgentStatus): Promise<void> {
    const client = this.state.client;
    if (!client.serverUrl || !client.publicKey) return;
    const error = status.ready ? null : (status.error || 'SSH is not ready');
    await this.#fetchJson(`${client.serverUrl}/ssh/report`, {
      method: 'POST',
      body: {
        publicKey: client.publicKey,
        token,
        user: status.user,
        platform: platform.isWindows ? 'windows' : 'linux',
        hostname: status.hostname,
        sshInstalled: status.installed,
        sshRunning: status.running,
        sshReady: status.ready,
        sshPort: status.port,
        sshVersion: status.version,
        sshError: error,
      },
      timeout: 15000,
    });
    this.#log(`SSH agent reported ready=${status.ready} user=${status.user ?? '-'}${error ? ` (${error})` : ''}`);
  }

  /** Stop the control panel; keep or tear down the tunnel according to config. */
  async dispose() {
    this.#stopSshAgent();
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
