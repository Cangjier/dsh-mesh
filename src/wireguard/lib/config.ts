/** Settings validation and deterministic WireGuard configuration rendering. */

import { isIP } from 'node:net';
import { DEFAULT_CONTROL_PORT, DEFAULT_INTERFACE, DEFAULT_LISTEN_PORT, DEFAULT_MTU, DEFAULT_SERVER_IP, DEFAULT_VPN_CIDR } from './constants';
import { WireGuardError } from './errors';
import { defaultServerIp, isUsableHost, parseCidr, parseIpv4 } from './ip';

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

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  controlPort: DEFAULT_CONTROL_PORT,
  listenPort: DEFAULT_LISTEN_PORT,
  vpnCidr: DEFAULT_VPN_CIDR,
  serverIp: DEFAULT_SERVER_IP,
  mtu: DEFAULT_MTU,
  interfaceName: DEFAULT_INTERFACE,
  endpointHost: '',
  joinCode: '',
  dns: '',
});

const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const INTERFACE_NAME = /^[A-Za-z0-9_=+.-]{1,15}$/;
const JOIN_CODE = /^[A-Za-z0-9_-]{0,64}$/;

/**
 * Throw a field-scoped validation failure.
 * @param {string} field input field name.
 * @param {string} message explanation.
 * @returns {never}
 */
function invalid(field, message): never {
  throw new WireGuardError('invalid_input', message, {
    status: 400,
    details: { field },
  });
}

/**
 * Coerce a value to an integer inside a range.
 * @param {unknown} value raw value.
 * @param {string} field field name.
 * @param {number} min minimum inclusive.
 * @param {number} max maximum inclusive.
 * @returns {number} validated integer.
 */
function integerInRange(value, field, min, max) {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    invalid(field, `${field} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

/**
 * Format a normalized host for a URL or WireGuard endpoint. IPv6 literals need
 * square brackets before a port.
 * @param {string} host IPv4, IPv6, or hostname.
 * @returns {string} bracketed IPv6 or unchanged host.
 */
export function formatEndpointHost(host) {
  return isIP(host) === 6 ? `[${host}]` : host;
}

/**
 * Normalize an IPv4, IPv6, or hostname endpoint (an optional port is discarded).
 * Bare IPv6 addresses are accepted; when a port is present, IPv6 must use
 * brackets: `[2408:...]:51821`.
 * @param {unknown} value raw host.
 * @returns {string} normalized host without brackets, or an empty string.
 */
export function normalizeEndpointHost(value) {
  let text = String(value ?? '').trim();
  if (!text) return '';
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  text = text.split('/')[0].split('?')[0].split('#')[0];
  if (text.startsWith('[')) {
    const match = /^\[([0-9A-Fa-f:.]+)\](?::\d{1,5})?$/.exec(text);
    if (!match || isIP(match[1]) !== 6) {
      invalid('endpointHost', 'Server address must be an IPv4 address, an IPv6 address, or a hostname.');
    }
    if (match[1] === '::') invalid('endpointHost', 'Server address must be a connectable IPv6 address.');
    return match[1];
  }
  if (isIP(text) === 6) {
    if (text === '::') invalid('endpointHost', 'Server address must be a connectable IPv6 address.');
    return text;
  }
  const match = /^([^:]+)(?::\d{1,5})?$/.exec(text);
  if (!match) invalid('endpointHost', 'Bracket IPv6 addresses when adding a port, for example [2408:...]:51821.');
  const host = match[1].trim();
  const address = parseIpv4(host);
  if (address !== null) {
    if (address === 0 || address === 0xffffffff || (address >= 0xe0000000 && address <= 0xefffffff)) {
      invalid('endpointHost', 'Server address must be a unicast IPv4 address, an IPv6 address, or a hostname.');
    }
    return host;
  }
  if (host.length > 253) invalid('endpointHost', 'Server address is too long.');
  const labels = host.split('.');
  if (labels.some((label) => !HOST_LABEL.test(label))) {
    invalid('endpointHost', 'Server address must be an IPv4 address, an IPv6 address, or a valid hostname.');
  }
  return host;
}

/**
 * Normalize a peer or device name for display and persistence.
 * @param {unknown} value raw name.
 * @param {string} fallback fallback name.
 * @returns {string} safe display name.
 */
export function normalizeDeviceName(value, fallback = 'device') {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const name = text || fallback;
  return Array.from(name).slice(0, 64).join('');
}

/**
 * Merge raw settings over defaults and validate the complete result.
 * @param {Record<string, unknown>} raw patch or UI payload.
 * @param {Record<string, unknown>} [base] previous settings.
 * @returns {{ settings: typeof DEFAULT_SETTINGS, cidr: NonNullable<ReturnType<typeof parseCidr>> }} validated settings and parsed CIDR.
 */
export function normalizeSettings(
  raw: Record<string, unknown> | null | undefined,
  base: Partial<Settings> = DEFAULT_SETTINGS,
): { settings: Settings; cidr: NonNullable<ReturnType<typeof parseCidr>> } {
  const source = raw && typeof raw === 'object' ? raw : {};
  const merged = { ...DEFAULT_SETTINGS, ...base, ...source };
  const cidr = parseCidr(merged.vpnCidr);
  if (!cidr) invalid('vpnCidr', 'VPN subnet must be an IPv4 CIDR from /8 to /30, for example 10.66.66.0/24.');

  let serverIp = String(merged.serverIp ?? '').trim();
  if (!serverIp) serverIp = defaultServerIp(cidr);
  let serverNumber = parseIpv4(serverIp);
  if (serverNumber === null) invalid('serverIp', 'Server VPN address must be a valid IPv4 address.');
  if (!isUsableHost(serverNumber, cidr)) {
    // A subnet change without an explicit server address should follow the new
    // subnet instead of failing on the old default.
    if (source.serverIp === undefined) {
      serverIp = defaultServerIp(cidr);
      serverNumber = parseIpv4(serverIp);
    }
    if (serverNumber === null || !isUsableHost(serverNumber, cidr)) {
      invalid('serverIp', `Server VPN address must be a usable host inside ${cidr.normalized}.`);
    }
  }

  const interfaceName = String(merged.interfaceName ?? DEFAULT_INTERFACE).trim();
  if (!INTERFACE_NAME.test(interfaceName) || interfaceName === '.' || interfaceName === '..') {
    invalid('interfaceName', 'Interface name must be 1–15 letters, digits, dots, underscores, plus, equals, or dashes.');
  }

  const joinCode = String(merged.joinCode ?? '').trim();
  if (!JOIN_CODE.test(joinCode)) {
    invalid('joinCode', 'Join code may contain only letters, digits, underscores, and dashes (up to 64 characters).');
  }

  const dns = String(merged.dns ?? '').trim();
  if (dns) {
    for (const part of dns.split(',')) {
      const address = part.trim();
      if (parseIpv4(address) === null) invalid('dns', 'DNS must be a comma-separated list of IPv4 addresses.');
    }
  }

  return {
    settings: {
      controlPort: integerInRange(merged.controlPort, 'controlPort', 1024, 65535),
      listenPort: integerInRange(merged.listenPort, 'listenPort', 1024, 65535),
      vpnCidr: cidr.normalized,
      serverIp,
      mtu: integerInRange(merged.mtu, 'mtu', 576, 9000),
      interfaceName,
      endpointHost: normalizeEndpointHost(merged.endpointHost),
      joinCode,
      dns,
    },
    cidr,
  };
}

/**
 * Render the server's persistent WireGuard configuration.
 * @param {{ privateKey: string, settings: typeof DEFAULT_SETTINGS, cidr: NonNullable<ReturnType<typeof parseCidr>>, peers: readonly { publicKey: string, ip: string }[] }} input
 * @returns {string} configuration text.
 */
export function buildServerConfig(input) {
  const lines = [
    '# Managed by dsh-wireguard. Manual edits are overwritten.',
    '[Interface]',
    `PrivateKey = ${input.privateKey}`,
    `Address = ${input.settings.serverIp}/${input.cidr.prefix}`,
    `ListenPort = ${input.settings.listenPort}`,
    `MTU = ${input.settings.mtu}`,
  ];
  for (const peer of input.peers) {
    lines.push('', '# peer', '[Peer]', `PublicKey = ${peer.publicKey}`, `AllowedIPs = ${peer.ip}/32`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Render a client's WireGuard configuration.
 * @param {{ privateKey: string, address: string, settings: typeof DEFAULT_SETTINGS, serverPublicKey: string, endpoint: string, vpnCidr: string }} input
 * @returns {string} configuration text.
 */
export function buildClientConfig(input) {
  const lines = [
    '# Managed by dsh-wireguard. Manual edits are overwritten.',
    '[Interface]',
    `PrivateKey = ${input.privateKey}`,
    `Address = ${input.address}/32`,
    `MTU = ${input.settings.mtu}`,
  ];
  if (input.settings.dns) lines.push(`DNS = ${input.settings.dns}`);
  lines.push(
    '',
    '[Peer]',
    `PublicKey = ${input.serverPublicKey}`,
    `Endpoint = ${input.endpoint}`,
    `AllowedIPs = ${input.vpnCidr}`,
    'PersistentKeepalive = 25',
  );
  return `${lines.join('\n')}\n`;
}

/**
 * Parse the address typed on the Client tab.
 * @param {unknown} value server address, optional port, or http(s) URL.
 * @param {number} defaultPort control-panel port used when omitted.
 * @returns {{ host: string, port: number, controlUrl: string, display: string }} normalized endpoint.
 */
export function parseServerAddress(value, defaultPort = DEFAULT_CONTROL_PORT) {
  let text = String(value ?? '').trim();
  if (!text) invalid('serverAddress', 'Enter the server address.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    if (isIP(text) === 6) text = `http://[${text}]`;
    else text = `http://${text}`;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    invalid('serverAddress', 'Server address is not a valid host, host:port, or URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    invalid('serverAddress', 'Only http and https control-panel addresses are supported.');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    invalid('serverAddress', 'Server address must not include a path.');
  }
  if (url.search || url.hash) invalid('serverAddress', 'Server address must not include a query or fragment.');
  const host = normalizeEndpointHost(url.hostname);
  if (!host) invalid('serverAddress', 'Server address is missing a host.');
  if (host === '0.0.0.0' || host === '::') invalid('serverAddress', '0.0.0.0 is not a connectable server address.');
  const port = url.port ? integerInRange(url.port, 'serverAddress', 1, 65535) : defaultPort;
  const controlUrl = `${url.protocol}//${formatEndpointHost(host)}:${port}`;
  return { host, port, controlUrl, display: `${formatEndpointHost(host)}:${port}` };
}
