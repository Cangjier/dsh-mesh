/**
 * Member discovery, selection, and the remote half of the gateway proxy.
 *
 * The public browser talks to exactly one gate. That gate owns the password
 * cookie and a target cookie (`dsh_gate_target`). A target of `local` proxies
 * to the DSH this gate supervises; any other target is a WireGuard peer, and
 * the request is signed and forwarded to that peer's gate under
 * `/__gate/cluster/...`.
 *
 * Nothing here decides whether a browser may enter: `isAdmitted` is supplied by
 * the gate and already answers that. This module only answers "which member"
 * and "how do I reach it".
 *
 * @module dsh-mesh/gate/members
 */

import http from 'node:http'
import os from 'node:os'
import {
  CLUSTER_HEADER,
  ClusterReplayCache,
  signClusterRequest,
  verifyClusterRequest,
} from '../shared/cluster.mjs'
import {
  cookieValue,
  namespaceSetCookie,
  rewriteCookieHeader,
} from '../shared/cookies.mjs'
import {
  LOCAL_MEMBER_ID,
  TARGET_COOKIE,
  discoverMembers,
  isValidMemberId,
  normalizeAddress,
  parseTargetCookie,
  readWireGuardState,
  wireGuardIdentity,
} from '../shared/wireguard.mjs'
import { quickSystemInfo } from '../shared/system-info.mjs'

/** Path prefix that carries one proxied request to a member gate. */
export const CLUSTER_PREFIX = '/__gate/cluster'

/** Default discovery cache lifetime. */
const DEFAULT_CACHE_MS = 10_000

/** Hop-by-hop headers a proxy must not copy from an upstream response. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * One gate's member service.
 */
export class MemberService {
  /**
   * @param {object} options service dependencies.
   * @param {string} options.clusterKey shared cluster secret; empty disables clustering.
   * @param {number} options.memberPort port peers use to reach this gate.
   * @param {string} options.stateFile `$DSH_HOME/wireguard/state.json`.
   * @param {number} [options.discoveryTimeoutMs] per-probe timeout.
   * @param {number} [options.discoveryCacheMs] discovery cache lifetime.
   * @param {string[]} [options.clusterAllow] extra exact source addresses allowed to call the cluster endpoint.
   * @param {boolean} [options.memberPublic] expose `/__gate/member` to non-private sources.
   * @param {string} [options.version] plugin version reported in member info.
   * @param {typeof fetch} [options.fetchImpl] fetch implementation (tests).
   * @param {(line: string) => void} options.log logger.
   * @param {(req: import('node:http').IncomingMessage) => boolean} options.isAdmitted gate admission check.
   * @param {() => boolean} options.isUpstreamReady local DSH readiness.
   * @param {(req: import('node:http').IncomingMessage) => Record<string, string|string[]>} options.forwardableHeaders request headers for the member.
   * @param {import('node:http').Agent} options.agent keep-alive agent.
   * @param {(spec: {title: string, heading: string, body: string}) => string} options.page branded HTML page.
   * @param {(res: import('node:http').ServerResponse, status: number, html: string) => void} options.sendHtml HTML responder.
   * @param {() => number} [options.now] clock (tests).
   */
  constructor(options) {
    this.clusterKey = typeof options.clusterKey === 'string' ? options.clusterKey : ''
    this.memberPort = Number.isInteger(options.memberPort) ? options.memberPort : 80
    this.discoveryPorts = [...new Set((options.discoveryPorts ?? []).filter(port => Number.isInteger(port) && port > 0))]
    this.stateFile = options.stateFile
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? 800
    this.discoveryCacheMs = options.discoveryCacheMs ?? DEFAULT_CACHE_MS
    this.clusterAllow = new Set((options.clusterAllow ?? []).map(normalizeAddress).filter(Boolean))
    this.memberPublic = options.memberPublic === true
    this.version = options.version ?? '0.0.0'
    this.fetchImpl = options.fetchImpl ?? fetch
    this.log = options.log
    this.isAdmitted = options.isAdmitted
    this.isUpstreamReady = options.isUpstreamReady
    this.forwardableHeaders = options.forwardableHeaders
    this.agent = options.agent
    this.page = options.page
    this.sendHtml = options.sendHtml
    this.now = options.now ?? Date.now
    this.replay = new ClusterReplayCache()
    /** @type {{value: object, expiresAt: number}|null} */
    this.cache = null
    /** @type {Promise<object>|null} */
    this.inflight = null
  }

  /**
   * The member endpoint every peer probes.
   * @returns {Promise<object>} public member info.
   */
  async memberInfo() {
    const { state } = await readWireGuardState({ file: this.stateFile })
    const identity = state === null ? null : wireGuardIdentity(state)
    const name = identity?.selfName ?? os.hostname()
    const vpnIp = identity?.selfIp ?? ''
    return {
      ok: true,
      service: 'dsh-mesh',
      version: this.version,
      id: vpnIp !== '' ? vpnIp : os.hostname(),
      name,
      hostname: os.hostname(),
      vpnIp,
      gatePort: this.memberPort,
      platform: process.platform,
      arch: process.arch,
      dsh: { reachable: this.isUpstreamReady() },
      cluster: { configured: this.clusterKey !== '' },
      system: quickSystemInfo(),
      updatedAt: new Date().toISOString(),
    }
  }

  /**
   * Discover every member and cache the result briefly.
   * @param {{force?: boolean}} [options] cache control.
   * @returns {Promise<object>} discovery snapshot.
   */
  async snapshot(options = {}) {
    const now = this.now()
    if (options.force !== true && this.cache !== null && this.cache.expiresAt > now) return this.cache.value
    if (this.inflight !== null) return this.inflight
    this.inflight = this._discover().finally(() => { this.inflight = null })
    return this.inflight
  }

  /** Run one discovery pass. */
  async _discover() {
    const { state, error } = await readWireGuardState({ file: this.stateFile })
    const self = await this.memberInfo()
    const snapshot = await discoverMembers({
      state,
      stateError: error,
      self: { ...self, port: this.memberPort, gate: self },
      ports: [...this.discoveryPorts, this.memberPort],
      timeoutMs: this.discoveryTimeoutMs,
      fetchImpl: this.fetchImpl,
    })
    snapshot.cluster = {
      configured: this.clusterKey !== '',
      memberPort: this.memberPort,
    }
    snapshot.target = LOCAL_MEMBER_ID
    this.cache = { value: snapshot, expiresAt: this.now() + this.discoveryCacheMs }
    return snapshot
  }

  /**
   * Resolve the target cookie to a route.
   * @param {import('node:http').IncomingMessage} req request.
   * @returns {Promise<{kind: 'local'} | {kind: 'remote', member: object} | {kind: 'unavailable', id: string, reason: string}>} route.
   */
  async resolveTarget(req) {
    if (req.__dshCluster === true) return { kind: 'local' }
    const id = this.currentTarget(req)
    if (id === LOCAL_MEMBER_ID) return { kind: 'local' }
    if (this.clusterKey === '') {
      return { kind: 'unavailable', id, reason: '本机没有配置 DSH_GATE_CLUSTER_KEY，无法代理到其他成员。' }
    }
    const snapshot = await this.snapshot()
    const member = snapshot.members.find(candidate => candidate.id === id)
    if (member === undefined) {
      return { kind: 'unavailable', id, reason: '这个成员不在当前 WireGuard 成员列表里。' }
    }
    if (member.dsh !== true || member.port === null) {
      return { kind: 'unavailable', id, reason: member.error ?? '这个成员没有运行可访问的 DSH 网关。' }
    }
    return { kind: 'remote', member }
  }

  /**
   * Read the current target id from the cookie.
   * @param {import('node:http').IncomingMessage} req request.
   * @returns {string} member id (`local` when absent).
   */
  currentTarget(req) {
    return parseTargetCookie(cookieValue(req.headers.cookie, TARGET_COOKIE)) ?? LOCAL_MEMBER_ID
  }

  /**
   * Handle one `/__gate/*` member route.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {import('node:http').ServerResponse} res response.
   * @param {URL} url parsed URL.
   * @returns {Promise<boolean>} true when the route was handled.
   */
  async handle(req, res, url) {
    const pathname = url.pathname
    if (pathname === '/__gate/member') {
      if (req.method !== 'GET') {
        this._json(res, 405, { ok: false, error: 'method_not_allowed' })
        return true
      }
      if (!this.memberPublic && !this._isPrivateSource(req)) {
        this._json(res, 404, { ok: false, error: 'not_found' })
        return true
      }
      this._json(res, 200, await this.memberInfo())
      return true
    }
    if (pathname === '/__gate/members' || pathname === '/__gate/status') {
      if (req.method !== 'GET') {
        this._json(res, 405, { ok: false, error: 'method_not_allowed' })
        return true
      }
      if (!this.isAdmitted(req)) {
        this._json(res, 401, { ok: false, error: 'authentication_required' })
        return true
      }
      const snapshot = await this.snapshot()
      this._json(res, 200, {
        ...snapshot,
        target: this.currentTarget(req),
        local: snapshot.self,
        cluster: { configured: this.clusterKey !== '', memberPort: this.memberPort },
      })
      return true
    }
    if (pathname === '/__gate/select') {
      await this._select(req, res)
      return true
    }
    if (pathname === '/__gate/reset') {
      if (!this.isAdmitted(req)) {
        this._json(res, 401, { ok: false, error: 'authentication_required' })
        return true
      }
      res.writeHead(303, {
        'cache-control': 'no-store',
        location: '/',
        'set-cookie': this._expiredTargetCookie(req),
      })
      res.end()
      return true
    }
    return false
  }

  /**
   * POST /__gate/select: validate the member and set the routing cookie.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {import('node:http').ServerResponse} res response.
   */
  async _select(req, res) {
    if (req.method !== 'POST') {
      this._json(res, 405, { ok: false, error: 'method_not_allowed' })
      return
    }
    if (!this.isAdmitted(req)) {
      this._json(res, 401, { ok: false, error: 'authentication_required' })
      return
    }
    if (!this._sameOrigin(req)) {
      this._json(res, 403, { ok: false, error: 'cross_origin_request' })
      return
    }
    let body
    try {
      body = await this._readJson(req)
    } catch (error) {
      this._json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    const id = body.id
    if (!isValidMemberId(id)) {
      this._json(res, 400, { ok: false, error: 'invalid_member_id' })
      return
    }
    if (id !== LOCAL_MEMBER_ID) {
      const snapshot = await this.snapshot()
      if (!snapshot.members.some(member => member.id === id)) {
        this._json(res, 404, { ok: false, error: 'unknown_member' })
        return
      }
    }
    const secure = req.socket.encrypted === true
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': `${TARGET_COOKIE}=${encodeURIComponent(id)}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
    })
    res.end(JSON.stringify({ ok: true, target: id }))
    this.log(`member target set to ${id}`)
  }

  /**
   * Verify and dispatch one cluster request to the local DSH.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {import('node:http').ServerResponse} res response.
   * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} dispatchLocal local dispatcher.
   * @returns {Promise<void>}
   */
  async handleCluster(req, res, dispatchLocal) {
    const verdict = this._verifyCluster(req)
    if (!verdict.ok) {
      this.log(`refused cluster request from ${req.socket.remoteAddress ?? 'unknown'}: ${verdict.reason}`)
      this._json(res, 403, { ok: false, error: 'cluster_request_refused' })
      return
    }
    const stripped = stripClusterPrefix(req.url ?? '/')
    if (stripped === null) {
      this._json(res, 400, { ok: false, error: 'bad_cluster_path' })
      return
    }
    delete req.headers[CLUSTER_HEADER]
    req.url = stripped
    req.__dshCluster = true
    await dispatchLocal(req, res)
  }

  /**
   * Verify and dispatch one cluster WebSocket upgrade to the local DSH.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {import('node:stream').Duplex} socket client socket.
   * @param {Buffer} head first bytes.
   * @param {(req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void} upgradeLocal local upgrade handler.
   * @returns {void}
   */
  handleClusterUpgrade(req, socket, head, upgradeLocal) {
    const verdict = this._verifyCluster(req)
    if (!verdict.ok) {
      this.log(`refused cluster upgrade from ${socket.remoteAddress ?? 'unknown'}: ${verdict.reason}`)
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const stripped = stripClusterPrefix(req.url ?? '/')
    if (stripped === null) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    delete req.headers[CLUSTER_HEADER]
    req.url = stripped
    req.__dshCluster = true
    upgradeLocal(req, socket, head)
  }

  /**
   * Proxy one HTTP request to a member gate.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {import('node:http').ServerResponse} res response.
   * @param {object} member discovered member.
   * @returns {Promise<void>}
   */
  async proxyRemote(req, res, member) {
    const headers = this._forwardHeaders(req, member.id)
    const path = `${CLUSTER_PREFIX}${req.url ?? '/'}`
    const startedAt = this.now()
    const upstream = http.request({
      host: member.ip,
      port: member.port,
      method: req.method,
      path,
      headers,
      agent: this.agent,
    }, (upstreamRes) => {
      const responseHeaders = this._responseHeaders(upstreamRes.headers, member.id)
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders)
      upstreamRes.pipe(res)
      upstreamRes.on('end', () => {
        if (res.writableFinished) return
        this.log(`${req.method ?? 'GET'} ${req.url ?? '/'} -> ${member.id} ${String(upstreamRes.statusCode)} ${String(this.now() - startedAt)}ms`)
      })
    })
    upstream.setTimeout(20_000, () => {
      upstream.destroy(new Error('member proxy timed out'))
    })
    upstream.on('error', (error) => {
      this.log(`member proxy error for ${req.method ?? 'GET'} ${req.url ?? '/'} -> ${member.id}: ${error.message}`)
      if (res.headersSent) {
        res.destroy()
        return
      }
      this.sendUnavailable(res, member.id, '连接成员网关失败，成员可能已经离线。')
    })
    req.pipe(upstream)
  }

  /**
   * Proxy one WebSocket upgrade to a member gate.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {import('node:stream').Duplex} socket client socket.
   * @param {Buffer} head first bytes.
   * @param {object} member discovered member.
   * @returns {void}
   */
  proxyRemoteUpgrade(req, socket, head, member) {
    const headers = this._forwardHeaders(req, member.id)
    // `forwardableHeaders` drops hop-by-hop headers, but an upgrade needs these
    // two to reach the member gate.
    headers.upgrade = req.headers.upgrade ?? 'websocket'
    headers.connection = 'Upgrade'
    const path = `${CLUSTER_PREFIX}${req.url ?? '/'}`
    const upstream = http.request({
      host: member.ip,
      port: member.port,
      method: req.method ?? 'GET',
      path,
      headers,
      agent: false,
    })
    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${String(upstreamRes.statusCode ?? 101)} ${upstreamRes.statusMessage ?? 'Switching Protocols'}`]
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined) continue
        if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`)
        else lines.push(`${name}: ${String(value)}`)
      }
      lines.push('', '')
      socket.write(lines.join('\r\n'))
      if (upstreamHead.length > 0) socket.write(upstreamHead)
      if (head.length > 0) upstreamSocket.write(head)
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
      upstreamSocket.on('error', () => socket.destroy())
      socket.on('error', () => upstreamSocket.destroy())
      upstreamSocket.on('close', () => socket.destroy())
      socket.on('close', () => upstreamSocket.destroy())
    })
    upstream.on('response', (upstreamRes) => {
      socket.end(`HTTP/1.1 ${String(upstreamRes.statusCode ?? 502)} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    })
    upstream.on('error', () => {
      if (socket.writable) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      else socket.destroy()
    })
    upstream.end()
  }

  /**
   * Send the branded "member unavailable" page with a way back.
   * @param {import('node:http').ServerResponse} res response.
   * @param {string} id member id.
   * @param {string} reason human-readable reason.
   * @returns {void}
   */
  sendUnavailable(res, id, reason) {
    const html = this.page({
      title: '成员暂时不可用',
      heading: '成员暂时不可用',
      rawBody: `无法切换到成员 <code>${escapeHtml(id)}</code>：${escapeHtml(reason)}<br><br>`
        + '可以检查 WireGuard 连接与成员上的网关服务，或者返回本机继续工作。'
        + '<br><br><a href="/__gate/reset">返回本机</a>',
    })
    this.sendHtml(res, 502, html)
  }

  /**
   * Build forwarded headers for one member request.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {string} id member id.
   * @returns {Record<string, string|string[]>} headers.
   */
  _forwardHeaders(req, id) {
    const headers = { ...this.forwardableHeaders(req) }
    const cookie = rewriteCookieHeader(id, req.headers.cookie)
    if (cookie === '') delete headers.cookie
    else headers.cookie = cookie
    headers[CLUSTER_HEADER] = signClusterRequest(this.clusterKey, {
      method: req.method ?? 'GET',
      path: `${CLUSTER_PREFIX}${req.url ?? '/'}`,
    })
    return headers
  }

  /**
   * Copy response headers and namespace cookie jars.
   * @param {import('node:http').IncomingHttpHeaders} headers upstream headers.
   * @param {string} id member id.
   * @returns {Record<string, string|string[]>} response headers.
   */
  _responseHeaders(headers, id) {
    const result = {}
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue
      if (HOP_BY_HOP.has(name.toLowerCase())) continue
      if (name.toLowerCase() === 'set-cookie') {
        const list = Array.isArray(value) ? value : [value]
        result[name] = list.map(header => namespaceSetCookie(id, header))
        continue
      }
      result[name] = value
    }
    result['x-dsh-gate-member'] = id
    return result
  }

  /**
   * Verify one cluster assertion.
   * @param {import('node:http').IncomingMessage} req request.
   * @returns {{ok: true} | {ok: false, reason: string}} verdict.
   */
  _verifyCluster(req) {
    if (!this._isClusterSource(req)) return { ok: false, reason: 'source is not on the trusted network' }
    const verdict = verifyClusterRequest(this.clusterKey, req.headers[CLUSTER_HEADER], {
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      now: this.now(),
      replay: this.replay,
    })
    return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason }
  }

  /**
   * Whether the source address may call the cluster endpoint.
   * @param {import('node:http').IncomingMessage} req request.
   * @returns {boolean} allowed.
   */
  _isClusterSource(req) {
    const address = normalizeAddress(req.socket.remoteAddress)
    if (address === '') return false
    if (this.clusterAllow.has(address)) return true
    return isPrivateAddress(address)
  }

  /**
   * Whether the source address may read public member info.
   * @param {import('node:http').IncomingMessage} req request.
   * @returns {boolean} allowed.
   */
  _isPrivateSource(req) {
    const address = normalizeAddress(req.socket.remoteAddress)
    return address !== '' && isPrivateAddress(address)
  }

  /**
   * Reject a state-changing request that a third-party page could have made.
   * @param {import('node:http').IncomingMessage} req request.
   * @returns {boolean} same-origin.
   */
  _sameOrigin(req) {
    if (req.headers['x-dsh-gate'] !== '1') return false
    const site = req.headers['sec-fetch-site']
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
    const origin = req.headers.origin
    if (typeof origin !== 'string' || origin === 'null') return site === 'same-origin' || site === 'none'
    try {
      return new URL(origin).host === req.headers.host
    } catch {
      return false
    }
  }

  /**
   * Read a small JSON body.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {number} [limit] maximum bytes.
   * @returns {Promise<Record<string, unknown>>} parsed object.
   */
  async _readJson(req, limit = 4096) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > limit) throw new Error('request body is too large')
      chunks.push(buffer)
    }
    if (size === 0) return {}
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request body must be a JSON object')
    return parsed
  }

  /**
   * Write a JSON response.
   * @param {import('node:http').ServerResponse} res response.
   * @param {number} status status code.
   * @param {unknown} value body.
   * @returns {void}
   */
  _json(res, status, value) {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
  }

  /**
   * Expired target cookie.
   * @param {import('node:http').IncomingMessage} req request.
   * @returns {string} Set-Cookie value.
   */
  _expiredTargetCookie(req) {
    const secure = req.socket.encrypted === true ? '; Secure' : ''
    return `${TARGET_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`
  }
}

/**
 * Strip the cluster prefix, leaving a same-origin path.
 * @param {string} url request target.
 * @returns {string|null} stripped path, or null when it is not a valid cluster path.
 */
export function stripClusterPrefix(url) {
  if (!url.startsWith(`${CLUSTER_PREFIX}/`) && url !== CLUSTER_PREFIX) return null
  const stripped = url.slice(CLUSTER_PREFIX.length)
  if (stripped === '' || stripped === '/') return '/'
  return stripped.startsWith('/') ? stripped : `/${stripped}`
}

/**
 * Whether an address is loopback, RFC1918, CGNAT, or IPv6 ULA/link-local.
 * The WireGuard subnet is RFC1918 in the default configuration, so this covers
 * both the VPN path and a gate probing localhost.
 * @param {string} address normalized address.
 * @returns {boolean} private.
 */
export function isPrivateAddress(address) {
  if (address === '127.0.0.1' || address === '::1') return true
  if (address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd')) return true
  const parts = address.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map(part => Number(part))
  if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  if (octets[0] === 10) return true
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true
  if (octets[0] === 192 && octets[1] === 168) return true
  if (octets[0] === 169 && octets[1] === 254) return true
  if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true
  return false
}

/**
 * Escape text placed into the small unavailable page.
 * @param {string} text raw text.
 * @returns {string} escaped text.
 */
function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}
