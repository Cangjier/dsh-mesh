/**
 * Small streaming HTTP client with explicit HTTP-proxy support.
 *
 * Two very different places need exactly this: the build host publishing a
 * release (large uploads, a 100 MB API body limit on Gitee, redirects) and a
 * member downloading that release (a 300–420 MB archive through the egress
 * member's CONNECT proxy). `fetch` is not enough for either: it buffers
 * request bodies, ignores `HTTPS_PROXY`, and cannot report byte progress.
 *
 * The module only imports Node built-ins, so a member can run it from the
 * runtime it already has, with no npm install and no DSH host.
 *
 * @module dsh-mesh/shared/http-client
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { rm, rename, stat } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { PassThrough, Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import tls from 'node:tls'

/** Redirects one request follows before it gives up. */
export const MAX_REDIRECTS = 10
/** Bytes of an error response kept for the message. */
const MAX_ERROR_BODY = 64 * 1024

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
 * Normalize a headers object into lower-case names.
 * @param {Record<string, unknown>|undefined} input headers.
 * @returns {Record<string,string>} headers.
 */
export function normalizeHeaders(input) {
  const headers = {}
  if (input === undefined || input === null) return headers
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue
    headers[String(name).toLowerCase()] = String(value)
  }
  return headers
}

/**
 * Open a CONNECT tunnel to one origin.
 * @param {ReturnType<typeof parseProxyUrl>} proxy proxy.
 * @param {string} host target host.
 * @param {number} port target port.
 * @param {number} timeoutMs connect timeout.
 * @returns {Promise<import('node:net').Socket>} established socket.
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
      resolve(socket)
    })
    request.once('timeout', () => request.destroy(new Error(`proxy CONNECT ${authority} timed out after ${String(timeoutMs)}ms`)))
    request.once('error', reject)
    request.end()
  })
}

/**
 * Attach a request body to an outgoing request.
 * @param {import('node:http').ClientRequest} request outgoing request.
 * @param {{body?: Buffer|string|Readable, length?: number, headers: Record<string,string>}} options body.
 * @returns {void}
 */
function writeBody(request, options) {
  const body = options.body
  if (body === undefined || body === null) {
    request.end()
    return
  }
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body)
    if (options.headers['content-length'] === undefined) options.headers['content-length'] = String(buffer.length)
    request.end(buffer)
    return
  }
  if (typeof body.pipe === 'function') {
    if (options.length !== undefined && options.headers['content-length'] === undefined) {
      options.headers['content-length'] = String(options.length)
    }
    body.once('error', error => request.destroy(error))
    body.pipe(request)
    return
  }
  throw new Error('unsupported request body type')
}

/**
 * One HTTP request, no redirect handling.
 * @param {string} href absolute URL.
 * @param {{method?: string, headers?: Record<string,string>, body?: Buffer|string|Readable, length?: number, proxy?: ReturnType<typeof parseProxyUrl>|null, timeoutMs?: number, idleTimeoutMs?: number}} options request.
 * @returns {Promise<{statusCode: number, statusMessage: string, headers: Record<string,string>, stream: import('node:stream').Readable, url: string}>} response.
 */
function requestOnce(href, options) {
  const target = new URL(href)
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return Promise.reject(new Error(`unsupported URL protocol: ${target.protocol}`))
  }
  const httpsTarget = target.protocol === 'https:'
  const port = target.port === '' ? (httpsTarget ? 443 : 80) : Number.parseInt(target.port, 10)
  const headers = { host: target.host, 'user-agent': 'dsh-mesh-release/1', ...normalizeHeaders(options.headers) }
  const proxy = options.proxy ?? null
  const connectTimeoutMs = options.timeoutMs ?? 60_000
  const idleTimeoutMs = options.idleTimeoutMs ?? connectTimeoutMs

  const finish = (response, agent = null) => {
    const result = {
      statusCode: response.statusCode ?? 0,
      statusMessage: response.statusMessage ?? '',
      headers: normalizeHeaders(response.headers),
      stream: response,
      url: href,
    }
    if (agent !== null) response.once('end', () => agent.destroy())
    return result
  }

  return new Promise((resolve, reject) => {
    const common = {
      method: options.method ?? 'GET',
      headers,
      timeout: idleTimeoutMs,
    }
    const attach = (request, agent) => {
      request.once('response', response => resolve(finish(response, agent)))
      request.once('timeout', () => request.destroy(new Error(`request to ${href} was idle for ${String(idleTimeoutMs)}ms`)))
      request.once('error', reject)
      try {
        writeBody(request, { ...options, headers })
      } catch (error) {
        request.destroy(error)
      }
    }

    if (!httpsTarget) {
      if (proxy !== null) {
        const request = http.request({
          host: proxy.hostname,
          port: proxy.port,
          method: common.method,
          path: target.href,
          headers: {
            ...headers,
            ...(proxy.auth === null ? {} : { 'proxy-authorization': `Basic ${Buffer.from(proxy.auth).toString('base64')}` }),
          },
          timeout: idleTimeoutMs,
        })
        attach(request, null)
        return
      }
      attach(http.request({
        hostname: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        ...common,
      }), null)
      return
    }

    if (proxy === null) {
      attach(https.request({
        hostname: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        ...common,
      }), null)
      return
    }

    connectTunnel(proxy, target.hostname, port, connectTimeoutMs).then((socket) => {
      const secure = tls.connect({ socket, servername: target.hostname })
      secure.once('error', reject)
      secure.once('secureConnect', () => {
        const agent = new https.Agent({ keepAlive: false, maxSockets: 1 })
        agent.createConnection = (_options, callback) => {
          callback(null, secure)
          return secure
        }
        attach(https.request({
          hostname: target.hostname,
          port,
          path: `${target.pathname}${target.search}`,
          ...common,
          agent,
        }), agent)
      })
    }).catch(reject)
  })
}

/**
 * Read a stream as text, bounded.
 * @param {import('node:stream').Readable} stream response body.
 * @param {number} [limit] max bytes.
 * @returns {Promise<string>} text.
 */
export async function readText(stream, limit = MAX_ERROR_BODY) {
  const chunks = []
  let bytes = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > limit) {
      stream.destroy()
      break
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Drain a redirect or error body so the socket can close.
 * @param {import('node:stream').Readable} stream body.
 * @returns {Promise<void>} done.
 */
async function drain(stream) {
  try {
    for await (const _chunk of stream) {
      // Reading to the end is the point.
    }
  } catch {
    // A broken redirect body does not matter; the next request starts fresh.
  }
}

/** Status codes that carry a Location header. */
const REDIRECTS = new Set([301, 302, 303, 307, 308])

/**
 * Open one response, following redirects for GET/HEAD.
 *
 * POST/PUT redirects are not followed: an upload that answers 307 would need
 * the body replayed, and silently turning it into a GET is worse than the
 * error. Callers that do need it can pass `followRedirects: true`.
 * @param {string} href absolute URL.
 * @param {{method?: string, headers?: Record<string,string|number|undefined>, body?: Buffer|string|Readable, length?: number, proxy?: string|ReturnType<typeof parseProxyUrl>|null, timeoutMs?: number, idleTimeoutMs?: number, maxRedirects?: number, followRedirects?: boolean}} [options] request.
 * @returns {Promise<{statusCode: number, statusMessage: string, headers: Record<string,string>, stream: import('node:stream').Readable, url: string}>} response.
 */
export async function openResponse(href, options = {}) {
  const proxy = typeof options.proxy === 'string'
    ? (options.proxy.trim() === '' ? null : parseProxyUrl(options.proxy))
    : (options.proxy ?? null)
  const method = String(options.method ?? 'GET').toUpperCase()
  const follow = options.followRedirects ?? (method === 'GET' || method === 'HEAD')
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS
  let current = href
  let headers = normalizeHeaders(options.headers)
  // Node reads the headers object when the request is constructed, so the
  // length has to be known before `requestOnce` runs, not when the body is
  // piped later.
  if (options.body !== undefined && options.body !== null && headers['content-length'] === undefined) {
    if (typeof options.body === 'string' || Buffer.isBuffer(options.body)) {
      headers['content-length'] = String(Buffer.byteLength(options.body))
    } else if (typeof options.length === 'number') {
      headers['content-length'] = String(options.length)
    }
  }
  for (let redirect = 0; ; redirect += 1) {
    const response = await requestOnce(current, {
      method,
      headers,
      body: options.body,
      length: options.length,
      proxy,
      timeoutMs: options.timeoutMs,
      idleTimeoutMs: options.idleTimeoutMs,
    })
    const location = response.headers.location
    if (!follow || !REDIRECTS.has(response.statusCode) || location === undefined) {
      return { ...response, url: current }
    }
    if (redirect >= maxRedirects) {
      await drain(response.stream)
      throw new Error(`too many redirects for ${href}`)
    }
    await drain(response.stream)
    const next = new URL(location, current)
    // A signed asset URL lives on another host; the API token must not follow.
    if (next.origin !== new URL(current).origin) {
      delete headers.authorization
      delete headers.cookie
      delete headers['proxy-authorization']
    }
    current = next.href
  }
}

/**
 * One JSON API call.
 * @param {string} url absolute URL.
 * @param {{method?: string, headers?: Record<string,string|number|undefined>, json?: unknown, proxy?: string|ReturnType<typeof parseProxyUrl>|null, timeoutMs?: number, idleTimeoutMs?: number, followRedirects?: boolean}} [options] request.
 * @returns {Promise<{status: number, headers: Record<string,string>, text: string, json: any}>} response.
 */
export async function requestJson(url, options = {}) {
  const headers = { ...normalizeHeaders(options.headers) }
  let body
  if (options.json !== undefined) {
    body = Buffer.from(JSON.stringify(options.json))
    headers['content-type'] ??= 'application/json'
    headers['content-length'] = String(body.length)
  }
  const response = await openResponse(url, {
    method: options.method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    body,
    proxy: options.proxy,
    timeoutMs: options.timeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
    followRedirects: options.followRedirects,
  })
  const text = await readText(response.stream, 1024 * 1024)
  let json
  try {
    json = text === '' ? null : JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.statusCode, headers: response.headers, text, json }
}

/**
 * Feed progress at most a few times per second.
 * @param {(progress: {bytes:number,totalBytes:number,percent:number,speed:number}) => void} callback sink.
 * @param {number} totalBytes total.
 * @returns {(bytes:number, force?:boolean) => void} reporter.
 */
function progressReporter(callback, totalBytes) {
  let lastAt = 0
  let lastBytes = 0
  let lastTime = Date.now()
  return (bytes, force = false) => {
    const now = Date.now()
    if (!force && now - lastAt < 250) return
    const seconds = Math.max(0.001, (now - lastTime) / 1000)
    const speed = bytes >= lastBytes ? (bytes - lastBytes) / seconds : 0
    lastAt = now
    lastTime = now
    lastBytes = bytes
    callback({
      bytes,
      totalBytes,
      percent: totalBytes > 0 ? Math.min(100, Math.round((bytes / totalBytes) * 100)) : 0,
      speed,
    })
  }
}

/**
 * Download one URL into a file, verifying its SHA-256.
 *
 * The bytes land in `<target>.part` and are renamed only after the digest
 * matches, so a killed download never leaves a plausible-looking archive that
 * a later deploy would try to extract.
 * @param {string} url absolute URL.
 * @param {string} target destination path.
 * @param {{proxy?: string|ReturnType<typeof parseProxyUrl>|null, headers?: Record<string,string>, sha256?: string, timeoutMs?: number, idleTimeoutMs?: number, onProgress?: (progress: object) => void, log?: (line:string)=>void}} [options] download.
 * @returns {Promise<{bytes: number, sha256: string, url: string}>} result.
 */
export async function downloadToFile(url, target, options = {}) {
  const log = options.log ?? (() => {})
  const temporary = `${target}.part`
  await rm(temporary, { force: true })
  const response = await openResponse(url, {
    headers: options.headers,
    proxy: options.proxy,
    timeoutMs: options.timeoutMs ?? 60_000,
    idleTimeoutMs: options.idleTimeoutMs ?? 120_000,
  })
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const text = await readText(response.stream)
    throw new Error(`download ${url} failed: HTTP ${String(response.statusCode)} ${response.statusMessage} ${text.trim().slice(0, 300)}`)
  }
  const totalBytes = Number.parseInt(response.headers['content-length'] ?? '0', 10) || 0
  const reporter = progressReporter(options.onProgress ?? (() => {}), totalBytes)
  const hash = createHash('sha256')
  let bytes = 0
  const output = createWriteStream(temporary)
  try {
    for await (const chunk of response.stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      hash.update(buffer)
      if (!output.write(buffer)) await new Promise(resolve => output.once('drain', resolve))
      reporter(bytes)
    }
    output.end()
    await finished(output)
    const digest = hash.digest('hex')
    if (options.sha256 !== undefined && options.sha256 !== '' && digest !== options.sha256) {
      throw new Error(`checksum mismatch for ${url}: expected ${options.sha256}, got ${digest}`)
    }
    await rm(target, { force: true })
    await rename(temporary, target)
    reporter(bytes, true)
    return { bytes, sha256: digest, url: response.url }
  } catch (error) {
    output.destroy()
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Upload one file with a streaming request body.
 *
 * The request is retried on transport errors and 5xx/429 answers; every
 * attempt opens a fresh read stream, because a consumed stream cannot be
 * replayed.
 * @param {string} url absolute URL.
 * @param {{method?: string, headers?: Record<string,string|number|undefined>, file: string, proxy?: string|ReturnType<typeof parseProxyUrl>|null, timeoutMs?: number, idleTimeoutMs?: number, onProgress?: (progress: object) => void, retries?: number, log?: (line:string)=>void}} options upload.
 * @returns {Promise<{status: number, headers: Record<string,string>, text: string, json: any, bytes: number}>} response.
 */
export async function uploadFile(url, options) {
  const log = options.log ?? (() => {})
  const info = await stat(options.file)
  const retries = Number.isSafeInteger(options.retries) ? Math.max(0, options.retries) : 2
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      const delay = 1000 * 2 ** (attempt - 1)
      log(`upload retry ${String(attempt)}/${String(retries)} in ${String(delay)}ms: ${lastError === null ? '' : lastError.message}`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
    const stream = createReadStream(options.file)
    const started = Date.now()
    let sent = 0
    // One progress event per chunk would flood an SSH mirror with thousands of
    // log lines; report at most four times a second.
    let lastReport = 0
    let lastSent = 0
    stream.on('data', chunk => {
      sent += chunk.length
      const now = Date.now()
      if (now - lastReport < 250) return
      const speed = (sent - lastSent) / Math.max(0.001, (now - lastReport) / 1000)
      lastReport = now
      lastSent = sent
      options.onProgress?.({
        bytes: sent,
        totalBytes: info.size,
        percent: info.size > 0 ? Math.min(100, Math.round((sent / info.size) * 100)) : 0,
        speed,
      })
    })
    try {
      const response = await openResponse(url, {
        method: options.method ?? 'POST',
        headers: options.headers,
        body: stream,
        length: info.size,
        proxy: options.proxy,
        timeoutMs: options.timeoutMs ?? 60_000,
        idleTimeoutMs: options.idleTimeoutMs ?? 300_000,
        followRedirects: false,
      })
      const text = await readText(response.stream, 1024 * 1024)
      let json = null
      try {
        json = text === '' ? null : JSON.parse(text)
      } catch {
        json = null
      }
      if (response.statusCode === 429 || response.statusCode >= 500) {
        lastError = new Error(`upload ${url} answered HTTP ${String(response.statusCode)}: ${text.trim().slice(0, 300)}`)
        if (attempt < retries) continue
        throw lastError
      }
      return { status: response.statusCode, headers: response.headers, text, json, bytes: info.size }
    } catch (error) {
      stream.destroy()
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt >= retries) throw lastError
    }
  }
  throw lastError ?? new Error(`upload ${url} failed`)
}

/**
 * Build a streaming multipart/form-data body for one file.
 *
 * Gitee's attachment endpoint wants `multipart/form-data` with a `file` part.
 * Returning the length lets the caller send a Content-Length instead of a
 * chunked request, which Gitee (and every reverse proxy in front of it) prefers.
 * @param {{name: string, file: string, type?: string, fields?: Record<string,string>}} options form.
 * @returns {Promise<{body: import('node:stream').Readable, length: number, contentType: string}>} form body.
 */
export async function multipartFileBody(options) {
  const boundary = `----dsh-mesh-${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
  const info = await stat(options.file)
  const fields = options.fields ?? {}
  const chunks = []
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${options.name}"\r\nContent-Type: ${options.type ?? 'application/octet-stream'}\r\n\r\n`))
  const head = Buffer.concat(chunks)
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  const length = head.length + info.size + tail.length
  const body = new PassThrough()
  body.write(head)
  const file = createReadStream(options.file)
  file.once('error', error => body.destroy(error))
  file.pipe(body, { end: false })
  file.once('end', () => {
    body.end(tail)
  })
  return { body, length, contentType: `multipart/form-data; boundary=${boundary}` }
}

/**
 * Whether a response status means success.
 * @param {number} status HTTP status.
 * @returns {boolean} 2xx.
 */
export function isSuccess(status) {
  return status >= 200 && status < 300
}

/** Re-export for callers that only need a byte stream. */
export { Readable }
