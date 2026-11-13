/**
 * Outbound proxy support for the build engine.
 *
 * A build downloads three kinds of things: the DSH source tarball, the Node
 * runtime, and npm packages. The first two go through `fetch`, which ignores
 * `HTTPS_PROXY` unless an undici dispatcher is installed; the last goes through
 * npm/pnpm, which do honour proxy configuration. So one proxy URL has to feed
 * both halves:
 *
 *   - `createProxyFetch(url)` is a fetch-shaped function that tunnels every
 *     request through an HTTP `CONNECT` proxy (`https://` targets) or uses it as
 *     an absolute-URI forward proxy (`http://` targets).
 *   - `proxyEnv(url)` adds the environment npm, pnpm, git, and curl read.
 *
 * The proxy is an ordinary HTTP proxy without TLS interception, which is what
 * `ssh -D`-style helpers and tinyproxy expose. SOCKS is deliberately out of
 * scope: the gateway runs a small HTTP proxy on the egress member instead.
 *
 * @module dsh-mesh/build/proxy
 */

import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { Readable } from 'node:stream'

/** How many redirects one fetch follows before giving up. */
const MAX_REDIRECTS = 10

/**
 * Parse and validate a proxy URL.
 * @param {string} value `http://host:port`, `host:port`, or `https://host:port`.
 * @returns {{href: string, protocol: 'http:'|'https:', hostname: string, port: number, auth: string|null}} proxy.
 */
export function parseProxyUrl(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') throw new Error('proxy URL is empty')
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `http://${raw}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(`proxy is not a URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`proxy must be http or https, got ${url.protocol}`)
  }
  if (url.hostname === '') throw new Error(`proxy has no host: ${value}`)
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number.parseInt(url.port, 10)
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new Error(`proxy has no valid port: ${value}`)
  const auth = url.username === ''
    ? null
    : `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
  return { href: `${url.protocol}//${url.host}`, protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/gu, ''), port, auth }
}

/**
 * Environment variables that make npm, pnpm, git, and curl use one proxy.
 * `NO_PROXY` keeps the mesh itself and loopback direct: a build must still be
 * able to reach the member that hosts the proxy.
 * @param {string} proxyUrl proxy URL.
 * @param {NodeJS.ProcessEnv} [base] environment to extend.
 * @returns {NodeJS.ProcessEnv} environment.
 */
export function proxyEnv(proxyUrl, base = process.env) {
  const proxy = parseProxyUrl(proxyUrl)
  const noProxy = ['localhost', '127.0.0.1', '::1', '10.66.66.0/24', '*.local', base.NO_PROXY, base.no_proxy]
    .filter(value => typeof value === 'string' && value !== '')
    .join(',')
  return {
    ...base,
    HTTP_PROXY: proxy.href,
    HTTPS_PROXY: proxy.href,
    ALL_PROXY: proxy.href,
    http_proxy: proxy.href,
    https_proxy: proxy.href,
    all_proxy: proxy.href,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    // npm and pnpm read configuration from npm_config_* environment variables;
    // they do not honour HTTPS_PROXY on their own.
    npm_config_proxy: proxy.href,
    npm_config_https_proxy: proxy.href,
    npm_config_noproxy: noProxy,
  }
}

/**
 * Open a CONNECT tunnel to one origin.
 * @param {ReturnType<typeof parseProxyUrl>} proxy proxy.
 * @param {string} host target host.
 * @param {number} port target port.
 * @param {number} timeoutMs connect timeout.
 * @returns {Promise<{socket: import('node:net').Socket, status: number}>} plain socket after CONNECT.
 */
function connectTunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const authority = `${host}:${String(port)}`
    const request = (proxy.protocol === 'https:' ? https : http).request({
      host: proxy.hostname,
      port: proxy.port,
      method: 'CONNECT',
      path: authority,
      headers: {
        host: authority,
        ...(proxy.auth === null ? {} : { 'proxy-authorization': `Basic ${Buffer.from(proxy.auth).toString('base64')}` }),
      },
      timeout: timeoutMs,
    })
    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`proxy refused CONNECT ${authority}: HTTP ${String(response.statusCode)}`))
        return
      }
      socket.setTimeout(0)
      resolve({ socket, status: response.statusCode })
    })
    request.once('timeout', () => request.destroy(new Error(`proxy CONNECT ${authority} timed out`)))
    request.once('error', reject)
    request.end()
  })
}

/**
 * Read the status line and headers of one HTTP response from a raw socket.
 * @param {import('node:stream').Duplex} socket socket.
 * @returns {Promise<{status: number, headers: Record<string,string>, rest: Buffer}>} response head.
 */
/**
 * One request through the proxy, without redirect handling.
 *
 * HTTPS targets get a CONNECT tunnel and an `https.Agent` that hands Node the
 * already-established TLS socket; Node then parses status, chunking, and
 * trailers exactly as it does for a direct request. Plain-HTTP targets use the
 * proxy in its forward form (an absolute URI in the request line).
 * @param {string} href absolute URL.
 * @param {{proxy: ReturnType<typeof parseProxyUrl>, method: string, headers: Record<string,string>, timeoutMs: number}} options request.
 * @returns {Promise<Response>} response.
 */
function requestOnce(href, options) {
  const target = new URL(href)
  const httpsTarget = target.protocol === 'https:'
  const port = target.port === '' ? (httpsTarget ? 443 : 80) : Number.parseInt(target.port, 10)
  const headers = { host: target.host, ...options.headers }
  if (!httpsTarget) {
    return new Promise((resolve, reject) => {
      const outgoing = http.request({
        host: options.proxy.hostname,
        port: options.proxy.port,
        method: options.method,
        path: target.href,
        headers: {
          ...headers,
          ...(options.proxy.auth === null ? {} : { 'proxy-authorization': `Basic ${Buffer.from(options.proxy.auth).toString('base64')}` }),
        },
        timeout: options.timeoutMs,
      }, (response) => resolve(toResponse(response)))
      outgoing.once('timeout', () => outgoing.destroy(new Error(`proxy request to ${href} timed out`)))
      outgoing.once('error', reject)
      outgoing.end()
    })
  }
  return new Promise((resolve, reject) => {
    connectTunnel(options.proxy, target.hostname, port, options.timeoutMs).then(({ socket }) => {
      const secure = tls.connect({ socket, servername: target.hostname })
      secure.once('error', reject)
      secure.once('secureConnect', () => {
        const agent = new https.Agent({ keepAlive: false, maxSockets: 1 })
        agent.createConnection = (_options, callback) => {
          callback(null, secure)
          return secure
        }
        const outgoing = https.request({
          host: target.hostname,
          port,
          path: `${target.pathname}${target.search}`,
          method: options.method,
          headers,
          agent,
          timeout: options.timeoutMs,
        }, (response) => {
          response.once('end', () => agent.destroy())
          resolve(toResponse(response))
        })
        outgoing.once('timeout', () => outgoing.destroy(new Error(`proxy request to ${href} timed out`)))
        outgoing.once('error', reject)
        outgoing.end()
      })
    }).catch(reject)
  })
}

/**
 * Wrap one response with a fetch-shaped API.
 * @param {import('node:http').IncomingMessage} response response.
 * @returns {Response} fetch-shaped response.
 */
function toResponse(response) {
  const headers = {}
  for (const [name, value] of Object.entries(response.headers)) {
    if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  const status = response.statusCode ?? 0
  // `Readable.toWeb` starts draining the response as soon as it is created, so
  // the body is built on first access: a caller that reads `text()` or
  // `arrayBuffer()` (the engine does) must not find an already-consumed stream.
  let webBody
  return {
    get body() {
      webBody ??= Readable.toWeb(response)
      return webBody
    },
    ok: status >= 200 && status < 300,
    status,
    statusText: response.statusMessage ?? '',
    headers: {
      get: (name) => headers[String(name).toLowerCase()] ?? null,
      has: (name) => Object.hasOwn(headers, String(name).toLowerCase()),
      forEach: (callback) => {
        for (const [name, value] of Object.entries(headers)) callback(value, name)
      },
    },
    async text() {
      const chunks = []
      for await (const chunk of response) chunks.push(Buffer.from(chunk))
      return Buffer.concat(chunks).toString('utf8')
    },
    async arrayBuffer() {
      const chunks = []
      for await (const chunk of response) chunks.push(Buffer.from(chunk))
      const buffer = Buffer.concat(chunks)
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    },
  }
}

/**
 * Read a redirect body to the end so the connection can be reused or closed.
 * @param {Response} response redirect response.
 * @returns {Promise<void>} done.
 */
async function drain(response) {
  try {
    await response.text()
  } catch {
    // A broken redirect body is irrelevant; the next request starts fresh.
  }
}

/**
 * fetch-compatible function bound to one proxy.
 * @param {string} proxyUrl proxy URL.
 * @param {{timeoutMs?: number}} [options] options.
 * @returns {typeof fetch} fetch-like function.
 */
export function createProxyFetch(proxyUrl, options = {}) {
  const proxy = parseProxyUrl(proxyUrl)
  return async function proxiedFetch(input, init = {}) {
    let href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let method = init.method ?? (typeof input === 'string' || input instanceof URL ? 'GET' : input.method ?? 'GET')
    const headers = {}
    const rawHeaders = init.headers ?? (typeof input === 'object' && !(input instanceof URL) ? input.headers : undefined)
    if (rawHeaders !== undefined) {
      if (typeof rawHeaders.forEach === 'function' && !Array.isArray(rawHeaders)) {
        rawHeaders.forEach((value, name) => { headers[String(name).toLowerCase()] = String(value) })
      } else if (Array.isArray(rawHeaders)) {
        for (const [name, value] of rawHeaders) headers[String(name).toLowerCase()] = String(value)
      } else {
        for (const [name, value] of Object.entries(rawHeaders)) headers[String(name).toLowerCase()] = String(value)
      }
    }
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const response = await requestOnce(href, { proxy, method, headers, timeoutMs: options.timeoutMs ?? 60_000 })
      const location = response.headers.get('location')
      if (![301, 302, 303, 307, 308].includes(response.status) || location === null) return response
      await drain(response)
      href = new URL(location, href).href
      if (response.status === 303) method = 'GET'
    }
    throw new Error(`too many redirects for ${href}`)
  }
}
