/**
 * Standalone member SSH agent.
 *
 * The DSH-Mesh service already runs on every member as root/LocalSystem. This
 * small companion reads a server URL, the member's WireGuard public key and a
 * one-time join code, then keeps the member's OpenSSH installation and the
 * server's authorized key in sync. It works when the member never ran the
 * full WireGuard control service and when sshd is missing entirely.
 */

import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname as osHostname } from 'node:os';
import path from 'node:path';
import { detectPlatform, run } from './lib/platform';
import { gatewaySshConfigBlock } from './lib/member-ssh';
import {
  authorizeLinuxKey,
  authorizeWindowsKey,
  ensureMemberKey,
  inspectSsh,
  installGatewaySshAccess,
  installWindowsOpenSsh,
  memberSshPaths,
  verifyOpenSshZip,
  type OpenSshAssetManifest,
  type SshAgentStatus,
} from './lib/ssh-agent';

interface AgentConfig {
  serverUrl: string;
  publicKey: string;
  joinCode?: string;
  token?: string;
  intervalMs?: number;
  autoInstall?: boolean;
}

const DEFAULT_INTERVAL = 5 * 60_000;
const INSTALL_RETRY = 15 * 60_000;
let lastInstallAttempt = 0;

function defaultConfigPath(): string {
  const configured = String(process.env.DSH_SSH_AGENT_CONFIG ?? '').trim();
  if (configured) return configured;
  if (process.platform === 'win32') {
    return path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'dsh-mesh', 'ssh-agent.json');
  }
  return '/etc/dsh-mesh/ssh-agent.json';
}

const configPath = defaultConfigPath();
const logPath = path.join(path.dirname(configPath), 'ssh-agent.log');

async function log(line: string): Promise<void> {
  const text = `${new Date().toISOString()} ${line}\n`;
  process.stdout.write(text);
  try {
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(logPath, text, 'utf8');
  } catch {
    // Logging must not stop the agent.
  }
}

async function loadConfig(): Promise<AgentConfig> {
  const raw = JSON.parse(await readFile(configPath, 'utf8'));
  const serverUrl = String(raw.serverUrl ?? '').trim().replace(/\/+$/u, '');
  const publicKey = String(raw.publicKey ?? '').trim();
  if (!/^https?:\/\/[^\s]+$/u.test(serverUrl)) throw new Error('serverUrl must be an http(s) URL');
  if (!/^[A-Za-z0-9+/=]{40,}$/u.test(publicKey)) throw new Error('publicKey is not a WireGuard key');
  return {
    serverUrl,
    publicKey,
    joinCode: typeof raw.joinCode === 'string' ? raw.joinCode : undefined,
    token: typeof raw.token === 'string' && raw.token ? raw.token : undefined,
    intervalMs: Number.isSafeInteger(raw.intervalMs) && raw.intervalMs >= 30_000 ? raw.intervalMs : DEFAULT_INTERVAL,
    autoInstall: raw.autoInstall !== false,
  };
}

async function saveConfig(config: AgentConfig): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function httpJson(config: AgentConfig, route: string, body: Record<string, unknown>, timeout = 12000): Promise<Record<string, any>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${config.serverUrl}${route}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
    });
    const text = await response.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { data = { ok: false, error: { message: text.slice(0, 300) } }; }
    if (!response.ok || data?.ok === false) {
      const error = new Error(String(data?.error?.message ?? `HTTP ${response.status}`));
      (error as any).status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function httpGetJson(config: AgentConfig, route: string, token: string, timeout = 12000): Promise<Record<string, any>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${config.serverUrl}${route}`, {
      headers: { accept: 'application/json', 'x-dsh-peer-token': token },
      signal: controller.signal,
      redirect: 'error',
    });
    const text = await response.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { data = { ok: false, error: { message: text.slice(0, 300) } }; }
    if (!response.ok || data?.ok === false) {
      const error = new Error(String(data?.error?.message ?? `HTTP ${response.status}`));
      (error as any).status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureToken(config: AgentConfig): Promise<AgentConfig> {
  if (config.token) return config;
  if (!config.joinCode) throw new Error('no token and no joinCode in the agent config');
  const platform = process.platform === 'win32' ? 'windows' : 'linux';
  const joined = await httpJson(config, '/join', {
    name: osHostname(),
    publicKey: config.publicKey,
    code: config.joinCode,
    family: '',
    platform,
  });
  const token = typeof joined.sshToken === 'string' ? joined.sshToken : '';
  if (!token) throw new Error('the server did not return an SSH agent token');
  const next = { ...config, token };
  await saveConfig(next);
  await log('enrolled the SSH agent token through /join');
  return next;
}

async function fetchKey(config: AgentConfig): Promise<string> {
  const data = await httpJson(config, '/ssh/key', { publicKey: config.publicKey, token: config.token });
  const publicKey = String(data.publicKey ?? '').trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/u.test(publicKey)) throw new Error('the server returned an invalid SSH public key');
  return publicKey;
}

async function fetchManifest(config: AgentConfig): Promise<OpenSshAssetManifest> {
  const query = `publicKey=${encodeURIComponent(config.publicKey)}`;
  let data: Record<string, any>;
  try {
    data = await httpGetJson(config, `/assets/openssh?${query}`, String(config.token ?? ''));
  } catch {
    // Older control services only expose the /ssh aliases.
    data = await httpJson(config, '/ssh/manifest', { publicKey: config.publicKey, token: config.token });
  }
  const entries = Array.isArray(data.assets) ? data.assets : [];
  const selected = entries.find((item: any) => item?.os === 'windows' && item?.arch === 'x64') ?? entries[0] ?? data;
  const manifest = {
    name: String(data.name ?? 'openssh'),
    version: String(data.version ?? 'unknown'),
    file: String(selected.file ?? ''),
    sha256: String(selected.sha256 ?? '').toLowerCase(),
    bytes: Number(selected.bytes),
  };
  if (!/^[A-Za-z0-9._-]+\.zip$/u.test(manifest.file)
    || !/^[0-9a-f]{64}$/u.test(manifest.sha256)
    || !Number.isSafeInteger(manifest.bytes)
    || manifest.bytes <= 0) {
    throw new Error('the server returned an invalid OpenSSH manifest');
  }
  return manifest;
}

async function downloadAsset(config: AgentConfig, manifest: OpenSshAssetManifest): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const query = `publicKey=${encodeURIComponent(config.publicKey)}`;
    const request = (url: string) => fetch(url, {
      headers: { accept: 'application/zip', 'x-dsh-peer-token': String(config.token ?? '') },
      signal: controller.signal,
      redirect: 'error',
    });
    let response = await request(`${config.serverUrl}/assets/openssh/${encodeURIComponent(manifest.file)}?${query}`);
    if (response.status === 404) response = await request(`${config.serverUrl}/ssh/asset?${query}`);
    if (!response.ok) throw new Error(`the gateway refused the OpenSSH package (HTTP ${response.status})`);
    const data = Buffer.from(await response.arrayBuffer());
    const directory = await mkdtemp(path.join(tmpdir(), 'dsh-ssh-agent-'));
    const zipPath = path.join(directory, manifest.file);
    await writeFile(zipPath, data);
    await verifyOpenSshZip(zipPath, manifest);
    await log(`downloaded OpenSSH ${manifest.version} (${data.length} bytes)`);
    return zipPath;
  } finally {
    clearTimeout(timer);
  }
}

async function startFallbackDaemon(): Promise<void> {
  // If a fresh install cannot start the service, keep a foreground sshd alive
  // so the member does not lose remote access while the service is repaired.
  const binary = 'C:\\Program Files\\OpenSSH\\sshd.exe';
  const script = `if (Test-Path '${binary}') { Start-Process '${binary}' -ArgumentList '-D' -WindowStyle Hidden }`;
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000 }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 2500));
}

async function report(config: AgentConfig, status: SshAgentStatus): Promise<void> {
  const error = status.ready ? null : (status.error || 'SSH is not ready');
  await httpJson(config, '/ssh/report', {
    publicKey: config.publicKey,
    token: config.token,
    user: status.user,
    platform: process.platform === 'win32' ? 'windows' : 'linux',
    hostname: status.hostname,
    sshInstalled: status.installed,
    sshRunning: status.running,
    sshReady: status.ready,
    sshPort: status.port,
    sshVersion: status.version,
    sshError: error,
  });
  await log(`reported ready=${String(status.ready)} user=${status.user ?? '-'}${error ? ` error=${error}` : ''}`);
}

/**
 * Install this member's own key on the gateway so `ssh dsh-gateway` works from
 * here too. Independent of the member's sshd, so it runs even when that fails.
 * @param config agent configuration with a valid token.
 * @param platform resolved platform.
 * @param status last inspection result, for the account to write files as.
 * @returns nothing; failures are logged and retried on the next tick.
 */
async function enrollReverse(config: AgentConfig, platform: Awaited<ReturnType<typeof detectPlatform>>, status: SshAgentStatus): Promise<void> {
  try {
    const paths = memberSshPaths(platform, status.user);
    const identity = await ensureMemberKey(platform, paths, { comment: `dsh-mesh@${status.hostname}`, user: status.user });
    const data = await httpJson(config, '/ssh/authorize', {
      publicKey: config.publicKey,
      token: config.token,
      sshPublicKey: identity.publicKey,
    });
    const host = String(data.host ?? '').trim();
    if (!host) throw new Error('the gateway did not report its VPN address');
    const user = String(data.user ?? 'root').trim() || 'root';
    const port = Number.isSafeInteger(data.port) && data.port > 0 ? data.port : 22;
    const hostKeys = Array.isArray(data.hostKeys) ? data.hostKeys.filter((item: unknown) => typeof item === 'string') : [];
    const configText = typeof data.sshConfig === 'string' && data.sshConfig.trim()
      ? data.sshConfig
      : gatewaySshConfigBlock({ host, user, port });
    const knownHostsText = typeof data.knownHostsB64 === 'string' && data.knownHostsB64
      ? Buffer.from(data.knownHostsB64, 'base64').toString('utf8')
      : hostKeys.map((item: string) => `${host} ${item}`).join('\n') + (hostKeys.length ? '\n' : '');
    await installGatewaySshAccess(platform, paths, { host, user, port, configText, knownHostsText }, { user: status.user });
    await log(`reverse SSH ready: ${user}@${host}:${port} (key ${paths.privateKey})`);
  } catch (error) {
    await log(`reverse SSH enrollment failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function tick(config: AgentConfig): Promise<AgentConfig> {
  const platform = await detectPlatform();
  let status = await inspectSsh(platform);
  const needsRepair = platform.isWindows && config.autoInstall !== false && (!status.installed || !status.ready || !status.serviceRunning);
  if (needsRepair && Date.now() - lastInstallAttempt >= INSTALL_RETRY) {
    lastInstallAttempt = Date.now();
    let zipPath: string | null = null;
    try {
      const publicKey = await fetchKey(config);
      const manifest = await fetchManifest(config);
      zipPath = await downloadAsset(config, manifest);
      await log('installing/repairing OpenSSH Server');
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
        await rm(path.dirname(zipPath), { recursive: true, force: true }).catch(() => undefined);
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
  await enrollReverse(config, platform, status);
  await report(config, status);
  return config;
}

async function main(): Promise<void> {
  let config: AgentConfig | null = null;
  while (config === null) {
    try {
      config = await loadConfig();
    } catch (error) {
      await log(`waiting for ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, 60_000));
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

process.once('SIGTERM', () => process.exit(0));
process.once('SIGINT', () => process.exit(0));
main().catch((error) => {
  void log(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
