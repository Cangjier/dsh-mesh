export const API_PREFIX = '/api/dsh-wireguard';

export interface Settings {
  controlPort: number;
  listenPort: number;
  vpnCidr: string;
  serverIp: string;
  mtu: number;
  interfaceName: string;
  endpointHost: string;
  joinCode: string;
  dns: string;
}

export interface Peer {
  publicKey: string;
  publicKeyFingerprint: string;
  name: string;
  ip: string;
  createdAt: string | null;
  online: boolean;
  lastHandshakeAt: string | null;
  endpoint: string | null;
  receivedBytes: number;
  sentBytes: number;
  applied: boolean;
  sshConfigured: boolean;
  sshUser: string | null;
}

export interface ServerState {
  running: boolean;
  startedAt: string | null;
  publicKey: string;
  publicKeyFingerprint: string;
  endpoint: string | null;
  endpointHost: string | null;
  controlUrl: string | null;
  controlPort: number;
  listenPort: number;
  vpnCidr: string;
  interfaceName: string;
  mtu: number;
  dns: string;
  peers: Peer[];
  warnings: string[];
  forwarding: boolean | null;
  joinRequired: boolean;
  controlAvailable: boolean;
}

export interface ClientState {
  connected: boolean;
  pending: boolean;
  publicKey: string | null;
  publicKeyFingerprint: string;
  name: string | null;
  serverUrl: string | null;
  serverHost: string | null;
  assignedIp: string | null;
  serverPublicKey: string | null;
  vpnCidr: string | null;
  endpoint: string | null;
  interfaceName: string | null;
  mtu: number;
  connectedAt: string | null;
  lastHandshakeAt: string | null;
  receivedBytes: number;
  sentBytes: number;
  lastError: string | null;
  warnings: string[];
  configured: boolean;
}

export interface ToolsState {
  ready: boolean;
  admin: boolean;
  wg: boolean;
  wireguard: boolean;
  ip: boolean;
  missing: string[];
  installHint?: string;
}

export interface DeploymentTarget {
  available: boolean;
  controlUrl: string | null;
  endpoint: string | null;
}

export interface DeploymentTargets {
  ipv4: DeploymentTarget;
  ipv6: DeploymentTarget;
}

export interface Snapshot {
  ok: boolean;
  version: string;
  service: string;
  role: 'idle' | 'server' | 'client';
  hostname: string;
  platform: { id: string; label: string };
  tools: ToolsState;
  settings: Settings;
  deployment: DeploymentTargets;
  server: ServerState;
  client: ClientState;
  lastError: string | null;
  logs: string[];
}

export class ApiError extends Error {
  readonly code: string;
  readonly hint: string;
  readonly command: string;
  readonly status: number;
  readonly state?: Snapshot;

  constructor(payload: any, status: number, fallback?: string, state?: Snapshot) {
    const detail = payload && typeof payload === 'object' ? payload : {};
    super(typeof detail.message === 'string' ? detail.message : fallback || 'WireGuard request failed');
    this.name = 'ApiError';
    this.code = typeof detail.code === 'string' ? detail.code : 'unknown';
    this.hint = typeof detail.hint === 'string' ? detail.hint : '';
    this.command = typeof detail.command === 'string' ? detail.command : '';
    this.status = status;
    this.state = state ?? detail.state;
  }
}

export async function requestPayload<T = any>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-dsh-wireguard': '1' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch (error) {
    throw new ApiError(
      { code: 'backend_unavailable', message: error instanceof Error ? error.message : 'The WireGuard backend is unreachable.' },
      0,
    );
  }
  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError(
      { code: 'backend_unavailable', message: 'The WireGuard backend returned an unexpected response.' },
      response.status,
    );
  }
  if (!response.ok || !data || data.ok !== true) {
    throw new ApiError(data?.error ?? null, response.status, undefined, data?.state);
  }
  return data as T;
}

export async function request<T = Snapshot>(path: string, body?: unknown): Promise<T> {
  const data = await requestPayload<{ state: T }>(path, body);
  return data.state;
}

export const api = {
  state: () => request('/state'),
  refresh: () => request('/refresh', {}),
  install: () => request('/install', {}),
  startServer: (settings: Partial<Settings>) => request('/server/start', settings),
  // The Host API only accepts GET for reads; every mutation is a POST, so the
  // body must be an object even for actions that carry no arguments.
  stopServer: () => request('/server/stop', {}),
  removePeer: (publicKey: string) => request('/peers/remove', { publicKey }),
  configureSsh: (publicKey: string, user: string) => requestPayload<{ state: Snapshot; command: string; commands: { linux: string; windows: string }; publicKey: string }>('/peers/ssh', { publicKey, user }),
  connectClient: (values: { serverAddress: string; joinCode: string; name?: string }) => request('/client/connect', values),
  retryClient: () => request('/client/retry', {}),
  disconnectClient: () => request('/client/disconnect', {}),
};
