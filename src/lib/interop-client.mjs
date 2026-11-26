/**
 * The client side of a member's interop service.
 *
 * One place answers the three questions every caller has: which port, which
 * base URL, and which bearer token. `member-tasks` uses it for the delivery
 * API; the scheduled upgrade uses it to ask a member to stop its conversations
 * before the restart. Keeping the token fallbacks here means a new caller does
 * not have to repeat the `config` → environment → `gate.env` chain.
 *
 * @module @local/dsh-mesh/interop-client
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** The interop port every install uses unless its config says otherwise. */
export const DEFAULT_INTEROP_PORT = 8765

/**
 * Read one `KEY=value` file into a flat object.
 * @param {string} file env file path.
 * @returns {Record<string, string>} values; empty when the file is absent.
 */
export function readEnvFile(file) {
  const values = {}
  if (!existsSync(file)) return values
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return values
}

/**
 * The interop port this install listens on and calls out to.
 * @param {object} service mesh service.
 * @returns {number} TCP port.
 */
export function interopPortOf(service) {
  const configured = service?.config?.interopPort
  if (Number.isSafeInteger(configured) && configured > 0 && configured < 65_536) return configured
  return DEFAULT_INTEROP_PORT
}

/**
 * The interop base URL of one member address.
 * @param {string} address member VPN address, IPv6 literal, or `http(s)://` URL.
 * @param {number} [port] interop port for a bare address.
 * @returns {string} base URL without a trailing slash.
 */
export function interopBaseUrl(address, port = DEFAULT_INTEROP_PORT) {
  const raw = String(address ?? '')
  if (/^https?:\/\//iu.test(raw)) return raw.replace(/\/+$/u, '')
  const host = raw.includes(':') && !raw.startsWith('[') ? `[${raw}]` : raw
  return `http://${host}:${String(port)}`
}

/**
 * The bearer token to present to a member's interop service.
 *
 * Explicit config wins, then the environment, then the gate password when the
 * install shares it (the default), searched next to the repository and next to
 * the plugin data directory.
 * @param {object} service mesh service.
 * @returns {string} token.
 * @throws {Error} when no token can be resolved.
 */
export function resolveInteropToken(service) {
  const configured = service?.config?.interopToken
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  if (process.env.DSH_INTEROP_TOKEN) return process.env.DSH_INTEROP_TOKEN
  if (service?.config?.interopUseGatePassword !== false) {
    if (process.env.DSH_GATE_PASSWORD) return process.env.DSH_GATE_PASSWORD
    const root = typeof service?.repositoryRoot === 'string' ? service.repositoryRoot : ''
    const dataDir = typeof service?.dataDir === 'string' ? service.dataDir : ''
    const candidates = [
      root === '' ? '' : path.join(root, '..', 'config', 'gate.env'),
      root === '' ? '' : path.join(root, 'config', 'gate.env'),
      dataDir === '' ? '' : path.join(dataDir, '..', '..', 'config', 'gate.env'),
    ].filter(candidate => candidate !== '')
    for (const file of candidates) {
      const password = readEnvFile(file).DSH_GATE_PASSWORD
      if (typeof password === 'string' && password !== '') return password
    }
  }
  throw new Error('no interop token: set interopToken, DSH_INTEROP_TOKEN, or DSH_GATE_PASSWORD')
}

/**
 * Call one member's interop service.
 *
 * The response body is parsed when it is JSON; an unknown endpoint is reported
 * as `unsupported` instead of throwing, so a caller can degrade to "this
 * member's release is too old" without parsing HTTP codes itself.
 * @param {object} service mesh service.
 * @param {{address: string, path: string, method?: string, body?: unknown, timeoutMs?: number, signal?: AbortSignal, token?: string}} request call input.
 * @returns {Promise<{ok: boolean, status: number, unsupported: boolean, data: any, text: string}>} response.
 */
export async function memberInteropRequest(service, request) {
  const token = typeof request.token === 'string' && request.token !== '' ? request.token : resolveInteropToken(service)
  const url = `${interopBaseUrl(request.address, interopPortOf(service))}${request.path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 15_000)
  timer.unref?.()
  const onAbort = () => controller.abort()
  request.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(url, {
      method: request.method ?? 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: controller.signal,
    })
    const text = await response.text()
    let data = null
    try { data = text === '' ? null : JSON.parse(text) } catch { data = null }
    const code = data?.error?.code
    const unsupported = response.status === 404 || response.status === 501
      || code === 'not_found'
      || code === 'unknown_endpoint'
      || code === 'unsupported'
    return { ok: response.ok && data?.ok !== false, status: response.status, unsupported, data, text }
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', onAbort)
  }
}
