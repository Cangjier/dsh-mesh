/**
 * Read the dsh-wireguard state and turn its peer registry into a candidate list
 * of DSH members.
 *
 * The module is deliberately dependency-free and transport-only: it never
 * starts a tunnel and never mutates the WireGuard state. The gate and the DSH
 * Host plugin both call it so that "who is on the VPN" is answered in one
 * place.
 *
 * @module dsh-mesh/shared/wireguard
 */

import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import os from 'node:os'
import path from 'node:path'

/** Default member gate ports, in probe order. 80 is Linux; 8080 is the Windows default. */
export const DEFAULT_MEMBER_PORTS = Object.freeze([80, 8080])

/** Service marker returned by `GET /__gate/member`. */
export const MEMBER_SERVICE = 'dsh-mesh'

/**
 * Resolve the DSH home the same way the installed harness does.
 * @param {NodeJS.ProcessEnv} [env] environment.
 * @returns {string} absolute DSH home.
 */
export function dshHome(env = process.env) {
  const configured = env.DSH_HOME?.trim()
  return configured && configured.length > 0 ? configured : path.join(os.homedir(), '.dsh')
}

/**
 * Read `$DSH_HOME/wireguard/state.json` without throwing when it is absent.
 * @param {{home?: string, file?: string}} [options] location override.
 * @returns {Promise<{path: string, state: object|null, error: string|null}>} parsed state or a reason.
 */
export async function readWireGuardState(options = {}) {
  const file = options.file ?? path.join(options.home ?? dshHome(), 'wireguard', 'state.json')
  try {
    const text = await readFile(file, 'utf8')
    const state = JSON.parse(text)
    if (state === null || typeof state !== 'object' || Array.isArray(state)) {
      return { path: file, state: null, error: 'wireguard state.json is not an object' }
    }
    return { path: file, state, error: null }
  } catch (error) {
    return {
      path: file,
      state: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Normalize one address so peer entries, probe targets, and member ids compare.
 * @param {unknown} value raw address.
 * @returns {string} bare IPv4/IPv6 address, or an empty string.
 */
export function normalizeAddress(value) {
  if (typeof value !== 'string') return ''
  let text = value.trim()
  if (text.startsWith('[') && text.includes(']')) text = text.slice(1, text.indexOf(']'))
  if (text.toLowerCase().startsWith('::ffff:')) text = text.slice(7)
  const zone = text.indexOf('%')
  if (zone > 0) text = text.slice(0, zone)
  return isIP(text) > 0 ? text : ''
}

/**
 * Derive the local identity and the pieces needed to ask the WireGuard server
 * for its peer list.
 * @param {object|null} state parsed `state.json`.
 * @returns {object} a normalized identity.
 */
export function wireGuardIdentity(state) {
  const source = state !== null && typeof state === 'object' ? state : {}
  const settings = source.settings !== null && typeof source.settings === 'object' ? source.settings : {}
  const server = source.server !== null && typeof source.server === 'object' ? source.server : {}
  const client = source.client !== null && typeof source.client === 'object' ? source.client : {}
  const role = source.role === 'server' ? 'server' : 'client'
  const vpnCidr = typeof settings.vpnCidr === 'string' && settings.vpnCidr !== ''
    ? settings.vpnCidr
    : typeof server.vpnCidr === 'string' && server.vpnCidr !== ''
      ? server.vpnCidr
      : typeof client.vpnCidr === 'string' && client.vpnCidr !== ''
        ? client.vpnCidr
        : '10.66.66.0/24'
  const serverIp = normalizeAddress(settings.serverIp) || normalizeAddress(server.serverIp) || '10.66.66.1'
  const selfIp = role === 'server'
    ? normalizeAddress(serverIp) || normalizeAddress(server.endpointHost) || ''
    : normalizeAddress(client.assignedIp)
  const selfName = String(
    role === 'server'
      ? server.hostname ?? os.hostname()
      : client.name ?? os.hostname(),
  )
  const serverUrl = String(client.serverUrl ?? server.controlUrl ?? '').replace(/\/+$/u, '')
  const joinCode = String(
    client.joinCode ?? settings.joinCode ?? server.joinCode ?? '',
  )
  const connected = role === 'server' ? server.running === true : client.connected === true
  const warnings = Array.isArray(role === 'server' ? server.warnings : client.warnings)
    ? (role === 'server' ? server.warnings : client.warnings).filter(value => typeof value === 'string')
    : []
  return {
    role,
    vpnCidr,
    serverIp,
    serverUrl,
    joinCode,
    selfIp,
    selfName,
    connected,
    lastHandshakeAt: typeof client.lastHandshakeAt === 'string' ? client.lastHandshakeAt : null,
    warnings,
  }
}

/**
 * Normalize one peer record from the control-panel response.
 * @param {unknown} value raw peer.
 * @returns {{name: string, ip: string, online: boolean, lastHandshakeAt: string|null}|null} peer or null.
 */
export function normalizePeer(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const peer = /** @type {Record<string, unknown>} */ (value)
  const ip = normalizeAddress(peer.ip)
  if (ip === '') return null
  return {
    name: typeof peer.name === 'string' && peer.name.trim() !== '' ? peer.name.trim() : `peer-${ip}`,
    ip,
    online: peer.online !== false,
    lastHandshakeAt: typeof peer.lastHandshakeAt === 'string' ? peer.lastHandshakeAt : null,
  }
}

/**
 * Read the live peer list from the server control service. `state.json` is a
 * snapshot written when the server starts; peer handshakes and online flags
 * change continuously, so the control service is the authoritative source.
 * @param {object|null} state parsed state.
 * @param {{fetchImpl?: typeof fetch}} options fetch options.
 * @param {number} timeoutMs request timeout.
 * @param {typeof fetch} fetchImpl fetch implementation.
 * @returns {Promise<object[]|null>} normalized peers, or null when unavailable.
 */
async function fetchServerControlPeers(state, options, timeoutMs, fetchImpl) {
  const settings = state?.settings !== null && typeof state?.settings === 'object' ? state.settings : {}
  const server = state?.server !== null && typeof state?.server === 'object' ? state.server : {}
  const rawPort = settings.controlPort ?? server.controlPort
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65_535 ? rawPort : 0
  if (port === 0) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`http://127.0.0.1:${String(port)}/api/dsh-wireguard/state`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return null
    const payload = await response.json()
    const peers = payload?.state?.server?.peers ?? payload?.server?.peers
    if (!Array.isArray(peers)) return null
    return peers.map(normalizePeer).filter(peer => peer !== null)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ask the WireGuard server for its peers. In client mode this is the only way
 * to see the other clients: a client's own tunnel config contains just the
 * server.
 * @param {object|null} state parsed `state.json`.
 * @param {{timeoutMs?: number, fetchImpl?: typeof fetch}} [options] request options.
 * @returns {Promise<{peers: object[], source: string, error: string|null}>} normalized peers.
 */
export async function fetchPeers(state, options = {}) {
  const identity = wireGuardIdentity(state)
  const timeoutMs = options.timeoutMs ?? 3_000
  const fetchImpl = options.fetchImpl ?? fetch
  if (identity.role === 'server') {
    const live = await fetchServerControlPeers(state, options, timeoutMs, fetchImpl)
    if (live !== null) return { peers: live, source: 'server-control-panel', error: null }
    const raw = state?.server?.peers
    if (!Array.isArray(raw)) {
      return { peers: [], source: 'server-state', error: 'wireguard server state has no peer list' }
    }
    const peers = raw.map(normalizePeer).filter(peer => peer !== null)
    return { peers, source: 'server-state', error: null }
  }
  if (identity.serverUrl === '' || identity.joinCode === '') {
    return {
      peers: [],
      source: 'client-control-panel',
      error: 'wireguard client state has no control-panel URL or join code',
    }
  }
  const endpoint = new URL('/peers', `${identity.serverUrl}/`)
  endpoint.searchParams.set('code', identity.joinCode)
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(endpoint, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
      if (!response.ok) {
        return {
          peers: [],
          source: 'client-control-panel',
          error: `wireguard control panel answered ${String(response.status)}`,
        }
      }
      const payload = await response.json()
      const raw = payload !== null && typeof payload === 'object' ? payload.peers : null
      if (!Array.isArray(raw)) {
        return { peers: [], source: 'client-control-panel', error: 'wireguard control panel returned no peer list' }
      }
      const peers = raw.map(normalizePeer).filter(peer => peer !== null)
      return { peers, source: 'client-control-panel', error: null }
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    return {
      peers: [],
      source: 'client-control-panel',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Probe one peer for the member endpoint.
 * @param {string} ip peer address.
 * @param {{ports?: number[], timeoutMs?: number, fetchImpl?: typeof fetch}} [options] probe options.
 * @returns {Promise<{ok: boolean, port: number|null, info: object|null, latencyMs: number, error: string|null}>} probe result.
 */
export async function probeMember(ip, options = {}) {
  const address = normalizeAddress(ip)
  if (address === '') {
    return { ok: false, port: null, info: null, latencyMs: 0, error: 'not an IP address' }
  }
  const ports = [...new Set((options.ports ?? DEFAULT_MEMBER_PORTS).filter(port => Number.isInteger(port) && port > 0 && port <= 65_535))]
  const timeoutMs = options.timeoutMs ?? 2_500
  const fetchImpl = options.fetchImpl ?? fetch
  let lastError = 'no member port answered'
  for (const port of ports) {
    const started = Date.now()
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetchImpl(new URL(`http://${formatHost(address)}:${String(port)}/__gate/member`), {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        })
        if (!response.ok) {
          lastError = `member endpoint answered ${String(response.status)} on port ${String(port)}`
          continue
        }
        const info = await response.json()
        if (info === null || typeof info !== 'object' || info.service !== MEMBER_SERVICE) {
          lastError = `port ${String(port)} is HTTP but not ${MEMBER_SERVICE}`
          continue
        }
        return { ok: true, port, info, latencyMs: Date.now() - started, error: null }
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  return { ok: false, port: null, info: null, latencyMs: 0, error: lastError }
}

/**
 * Format an IPv6 literal for a URL authority.
 * @param {string} address bare address.
 * @returns {string} address with brackets when needed.
 */
function formatHost(address) {
  return isIP(address) === 6 ? `[${address}]` : address
}

/**
 * Build the member list the panel renders: the local DSH plus every WireGuard
 * peer, with its DSH/gate probe result.
 * @param {{state: object|null, stateError?: string|null, self?: object, ports?: number[], timeoutMs?: number, fetchImpl?: typeof fetch}} options discovery input.
 * @returns {Promise<object>} discovery snapshot.
 */
export async function discoverMembers(options) {
  const state = options.state ?? null
  const identity = wireGuardIdentity(state)
  const ports = [...new Set([...(options.ports ?? []), ...DEFAULT_MEMBER_PORTS])]
  const peerResult = state === null
    ? { peers: [], source: 'none', error: options.stateError ?? 'wireguard state.json is unavailable' }
    : await fetchPeers(state, { timeoutMs: options.timeoutMs, fetchImpl: options.fetchImpl })
  // The control-panel peer list includes this client itself. The panel renders
  // the local machine separately as `local`, so drop the duplicate.
  const peers = peerResult.peers.filter(peer => identity.selfIp === '' || peer.ip !== identity.selfIp)
  if (identity.role === 'client' && identity.serverIp !== '' && !peers.some(peer => peer.ip === identity.serverIp)) {
    peers.unshift({
      name: 'wireguard-server',
      ip: identity.serverIp,
      online: true,
      lastHandshakeAt: null,
    })
  }
  const probes = await Promise.all(peers.map(async peer => ({
    peer,
    probe: await probeMember(peer.ip, {
      ports,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    }),
  })))
  const members = probes.map(({ peer, probe }) => ({
    id: peer.ip,
    kind: 'peer',
    name: peer.name,
    ip: peer.ip,
    online: peer.online,
    lastHandshakeAt: peer.lastHandshakeAt,
    dsh: probe.ok,
    port: probe.port,
    latencyMs: probe.latencyMs,
    gate: probe.info,
    system: probe.info?.system ?? null,
    error: probe.error,
  }))
  const self = {
    id: 'local',
    kind: 'self',
    name: options.self?.name ?? identity.selfName ?? os.hostname(),
    ip: options.self?.ip ?? identity.selfIp ?? '',
    online: options.self?.online ?? true,
    lastHandshakeAt: options.self?.lastHandshakeAt ?? identity.lastHandshakeAt,
    dsh: options.self?.dsh ?? true,
    port: options.self?.port ?? null,
    latencyMs: 0,
    gate: options.self?.gate ?? null,
    system: options.self?.system ?? null,
    error: options.self?.error ?? null,
  }
  const warnings = []
  if (state === null) warnings.push(peerResult.error ?? 'wireguard state.json is unavailable')
  else if (peerResult.error !== null) warnings.push(peerResult.error)
  if (identity.role === 'client' && !identity.connected) warnings.push('the WireGuard client reports it is not connected')
  if (identity.role === 'server' && !identity.connected) warnings.push('the WireGuard server reports it is not running')
  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    source: {
      role: identity.role,
      vpnCidr: identity.vpnCidr,
      serverIp: identity.serverIp,
      serverUrl: identity.serverUrl,
      peerSource: peerResult.source,
    },
    self,
    members,
    warnings,
  }
}

/**
 * Validate a member id: `local`, or an IPv4/IPv6 address.
 * @param {unknown} value candidate.
 * @returns {boolean} whether it can be a member id.
 */
export function isValidMemberId(value) {
  return value === 'local' || (typeof value === 'string' && isIP(value) > 0)
}

/**
 * Read a member id out of the target cookie value. The cookie is the only
 * routing input: there is no URL fragment and no client-side bootstrap.
 * @param {unknown} value cookie value.
 * @returns {string|null} a valid member id, or null when absent/invalid.
 */
export function parseTargetCookie(value) {
  if (typeof value !== 'string' || value === '') return null
  let decoded = value
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return null
  }
  return isValidMemberId(decoded) ? decoded : null
}

/** Cookie that carries the selected member id. */
export const TARGET_COOKIE = 'dsh_gate_target'

/** Member id that always resolves to the local upstream. */
export const LOCAL_MEMBER_ID = 'local'
