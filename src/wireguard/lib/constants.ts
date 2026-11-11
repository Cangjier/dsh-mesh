/** Stable identifiers shared by the Host and browser halves. */
export const PLUGIN_VERSION = '0.2.0';
export const SERVICE_NAME = 'dsh-wireguard';
export const API_PREFIX = '/api/dsh-wireguard';
export const DEFAULT_CONTROL_PORT = 51821;
export const DEFAULT_LISTEN_PORT = 51820;
export const DEFAULT_VPN_CIDR = '10.66.66.0/24';
export const DEFAULT_SERVER_IP = '10.66.66.1';
export const DEFAULT_INTERFACE = 'dshwg0';
export const DEFAULT_MTU = 1420;
export const MAX_PEERS = 1024;
export const MAX_STATE_BYTES = 2 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 64 * 1024;
