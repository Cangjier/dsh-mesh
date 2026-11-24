/**
 * The egress probe a delegated member runs, and the one-line result.
 *
 * `call_member` SSHes into the target before it creates the conversation and
 * pipes this ES module into the target's Node (`--input-type=module -`). The
 * probe tries the two loopback listeners the mesh's hysteria2 client always
 * exposes — HTTP on 127.0.0.1:8080 and SOCKS5 on 127.0.0.1:1080 — and, through
 * the first one that works, measures a real download. Only this measured
 * result is injected into the conversation: no guessed proxy, no fallback
 * claims.
 *
 * The script is a string on purpose: the initiator ships it over SSH instead
 * of assuming any path inside the target's install. It prints exactly one
 * JSON line on stdout.
 *
 * @module @local/dsh-mesh/egress-probe
 */

/** ES module run by the target's Node; prints one JSON line. */
export const EGRESS_PROBE_SOURCE = String.raw`
import http from 'node:http'
import tls from 'node:tls'

const port = Number(process.argv[2])
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.log(JSON.stringify({ ok: false, error: 'no proxy port' }))
  process.exit(1)
}

const targets = [
  { host: 'speed.cloudflare.com', path: '/__down?bytes=2000000', bandwidth: true },
  { host: 'api.github.com', path: '/', bandwidth: false },
]

function httpConnect(host) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: port, method: 'CONNECT', path: host + ':443' })
    request.once('connect', (response, socket) => {
      if (response.statusCode === 200) resolve(socket)
      else { socket.destroy(); reject(new Error('CONNECT ' + response.statusCode)) }
    })
    request.once('error', reject)
    request.end()
  })
}

function measure(socket, host, path) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket: socket, servername: host })
    let started = 0
    let first = 0
    let bytes = 0
    let head = Buffer.alloc(0)
    let done = false
    const finish = (error) => {
      if (done) return
      done = true
      try { secure.destroy() } catch {}
      if (error) reject(error)
      else resolve({ latencyMs: Math.max(0, first - started), bytes: bytes, ms: Math.max(1, Date.now() - started), head: head.toString('latin1') })
    }
    const timer = setTimeout(() => finish(new Error('timeout')), 12000)
    timer.unref()
    secure.once('error', finish)
    secure.once('secureConnect', () => {
      started = Date.now()
      secure.write('GET ' + path + ' HTTP/1.1\r\nHost: ' + host + '\r\nUser-Agent: dsh-mesh-egress-probe\r\nAccept: */*\r\nConnection: close\r\n\r\n')
    })
    secure.on('data', (chunk) => {
      if (first === 0) first = Date.now()
      bytes += chunk.length
      if (head.length < 256) head = Buffer.concat([head, chunk.subarray(0, 256 - head.length)])
    })
    secure.once('end', () => finish())
  })
}

let lastError = 'proxy unavailable'
for (const target of targets) {
  let socket = null
  try {
    socket = await httpConnect(target.host)
    const result = await measure(socket, target.host, target.path)
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(result.head)
    if (!status || Number(status[1]) >= 400) {
      lastError = 'HTTP ' + (status ? status[1] : '?')
      continue
    }
    const mbps = target.bandwidth ? Math.round((result.bytes * 8 / (result.ms / 1000) / 1e6) * 10) / 10 : null
    console.log(JSON.stringify({ ok: true, port: port, host: target.host, latencyMs: result.latencyMs, downMbps: mbps }))
    process.exit(0)
  } catch (error) {
    lastError = error && error.message ? error.message : String(error)
  } finally {
    try { if (socket) socket.destroy() } catch {}
  }
}
console.log(JSON.stringify({ ok: false, error: String(lastError).slice(0, 160) }))
process.exit(1)
`

/**
 * The one sentence the conversation receives about egress.
 * @param {{proxyPort?: number|null, egress?: {ok?: boolean, latencyMs?: number|null, downMbps?: number|null, error?: string|null}}} mesh egress facts.
 * @returns {string} one line.
 */
export function formatEgressLine(mesh) {
  const port = Number.isInteger(mesh?.proxyPort) ? mesh.proxyPort : null
  const egress = mesh?.egress !== null && typeof mesh?.egress === 'object' ? mesh.egress : {}
  const where = port === null ? '本机没有检测到代理端口' : `本机代理端口 ${port}`
  if (egress.ok === true) {
    const latency = Number.isFinite(egress.latencyMs) ? Math.max(0, Math.round(egress.latencyMs)) : null
    const down = Number.isFinite(egress.downMbps) ? egress.downMbps : null
    const perf = latency === null
      ? '出网实测通过'
      : down === null ? `延迟 ${latency} ms（带宽未测）` : `延迟 ${latency} ms，下行 ${down} Mbps`
    return `${where}；经代理出网实测：${perf}。`
  }
  const reason = String(egress.error ?? '').trim()
  return `${where}；经代理出网实测失败${reason === '' ? '' : `：${reason}`}。`
}

/**
 * Build the runtime context a target conversation receives: its identity and
 * work scope (when set), one egress line, and the git tokens. An older caller
 * sends no `profile` field, and must read exactly as before.
 * @param {{link?: boolean, proxyPort?: number|null, egress?: object, tokens?: {github?: string|null, gitee?: string|null}, profile?: {name?: string|null, identity?: string|null, scope?: string|null}|null}} [mesh] mesh facts from the initiator.
 * @returns {string} context text, or '' when there is nothing to say.
 */
export function formatMemberMesh(mesh) {
  if (mesh === null || typeof mesh !== 'object') return ''
  const lines = []
  const profile = mesh.profile !== null && typeof mesh.profile === 'object' ? mesh.profile : null
  if (profile !== null) {
    const identity = typeof profile.identity === 'string' && profile.identity.trim() !== '' ? profile.identity.trim() : null
    const scope = typeof profile.scope === 'string' && profile.scope.trim() !== '' ? profile.scope.trim() : null
    if (identity !== null || scope !== null) {
      const name = typeof profile.name === 'string' ? profile.name.trim() : ''
      const parts = []
      if (name !== '') parts.push(`你是成员 ${name}`)
      if (identity !== null) parts.push(`身份：${identity}`)
      if (scope !== null) parts.push(`负责范围：${scope}`)
      lines.push(`${parts.join('；')}。`)
    }
  }
  // No direct link in the mesh networking config means there is no proxy to
  // report: say nothing about egress rather than inventing a route.
  if (mesh.link === true && Number.isInteger(mesh.proxyPort)) lines.push(formatEgressLine(mesh))
  const tokens = mesh.tokens !== null && typeof mesh.tokens === 'object' ? mesh.tokens : {}
  if (typeof tokens.github === 'string' && tokens.github.trim() !== '') lines.push(`GitHub token: ${tokens.github.trim()}`)
  if (typeof tokens.gitee === 'string' && tokens.gitee.trim() !== '') lines.push(`Gitee token: ${tokens.gitee.trim()}`)
  return lines.join('\n')
}
