/** IPv4 parsing and peer-address allocation for the private WireGuard subnet. */

const IPV4_PATTERN = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * Parse a dotted IPv4 address into an unsigned 32-bit integer.
 * @param {unknown} value candidate address.
 * @returns {number | null} the address, or null when malformed.
 */
export function parseIpv4(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!IPV4_PATTERN.test(text)) return null;
  const parts = text.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Render an unsigned 32-bit integer as a dotted IPv4 address.
 * @param {number} value address bits.
 * @returns {string} dotted address.
 */
export function ipv4ToString(value) {
  const n = value >>> 0;
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

/**
 * Parse a CIDR such as `10.66.66.0/24`.
 * @param {unknown} value candidate CIDR.
 * @returns {{ network: number, prefix: number, mask: number, first: number, last: number, broadcast: number, normalized: string } | null}
 */
export function parseCidr(value) {
  if (typeof value !== 'string') return null;
  const match = /^([^/]+)\/(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const ip = parseIpv4(match[1]);
  const prefix = Number(match[2]);
  if (ip === null || !Number.isInteger(prefix) || prefix < 8 || prefix > 30) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ip & mask) >>> 0;
  const size = 2 ** (32 - prefix);
  const broadcast = (network + size - 1) >>> 0;
  return {
    network,
    prefix,
    mask,
    first: (network + 1) >>> 0,
    last: (broadcast - 1) >>> 0,
    broadcast,
    normalized: `${ipv4ToString(network)}/${prefix}`,
  };
}

/**
 * Whether an address is part of a parsed CIDR.
 * @param {number} ip address bits.
 * @param {ReturnType<typeof parseCidr>} cidr parsed CIDR.
 * @returns {boolean} membership.
 */
export function isIpInCidr(ip, cidr) {
  if (!cidr) return false;
  return ((ip & cidr.mask) >>> 0) === cidr.network;
}

/**
 * Whether an address can belong to a host inside a CIDR.
 * @param {number} ip address bits.
 * @param {ReturnType<typeof parseCidr>} cidr parsed CIDR.
 * @returns {boolean} whether the address is a usable host address.
 */
export function isUsableHost(ip, cidr) {
  return isIpInCidr(ip, cidr) && ip !== cidr.network && ip !== cidr.broadcast;
}

/**
 * Choose the conventional first host address for a subnet.
 * @param {ReturnType<typeof parseCidr>} cidr parsed CIDR.
 * @returns {string} dotted server address.
 */
export function defaultServerIp(cidr) {
  return ipv4ToString(cidr.first);
}

/**
 * Allocate the lowest free peer address. The network, broadcast, server, and
 * already-used addresses are skipped.
 * @param {ReturnType<typeof parseCidr>} cidr parsed CIDR.
 * @param {readonly string[]} used peer addresses already assigned.
 * @param {string} serverIp dotted server address.
 * @returns {string | null} a free dotted address, or null when the subnet is full.
 */
export function allocatePeerIp(cidr, used, serverIp) {
  const reserved = new Set([serverIp]);
  for (const value of used) {
    if (typeof value === 'string') reserved.add(value);
  }
  const limit = Math.min(cidr.last, cidr.network + 65535);
  for (let candidate = (cidr.network + 2) >>> 0; candidate <= limit; candidate = (candidate + 1) >>> 0) {
    if (candidate === cidr.broadcast) break;
    const text = ipv4ToString(candidate);
    if (!reserved.has(text)) return text;
  }
  return null;
}
