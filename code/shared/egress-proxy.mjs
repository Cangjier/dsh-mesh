/**
 * A one-purpose HTTP forward proxy, run on a member that has good internet
 * access so another machine's build can borrow that access.
 *
 * The gateway starts it over SSH with the member's Node runtime, bound to the
 * member's WireGuard address, and stops it when the build ends:
 *
 *   node egress-proxy.mjs 10.66.66.2 0
 *
 * It handles the two shapes a proxy client uses: `CONNECT host:port` for
 * HTTPS and an absolute-URI request line for plain HTTP. There is no
 * authentication because the listener only binds the private VPN address, and
 * the gateway picks a fresh port for every build.
 *
 * It writes a one-byte heartbeat to stdout every few seconds. The SSH channel
 * carries that stdout back to the gateway, so a channel that goes away turns
 * the next heartbeat into EPIPE and the proxy exits instead of lingering.
 *
 * @module dsh-mesh/shared/egress-proxy
 */

import http from 'node:http'
import net from 'node:net'

const bind = process.argv[2] ?? '127.0.0.1'
const port = Number.parseInt(process.argv[3] ?? '0', 10)

/**
 * Log one line on stdout; the gateway watches for the LISTEN marker.
 * @param {string} line text.
 * @returns {void}
 */
function say(line) {
  process.stdout.write(`${line}\n`)
}

/**
 * Copy bytes both ways until either side ends.
 * @param {import('node:stream').Duplex} left socket.
 * @param {import('node:stream').Duplex} right socket.
 * @returns {void}
 */
function bridge(left, right) {
  left.pipe(right)
  right.pipe(left)
  const close = () => {
    left.destroy()
    right.destroy()
  }
  left.once('error', close)
  right.once('error', close)
  left.once('close', close)
  right.once('close', close)
}

const server = http.createServer((request, response) => {
  // Plain HTTP through the proxy arrives as an absolute URI.
  let target
  try {
    target = new URL(request.url ?? '')
  } catch {
    response.writeHead(400, { 'content-type': 'text/plain' })
    response.end('expected an absolute URI\n')
    return
  }
  if (target.protocol !== 'http:') {
    response.writeHead(400, { 'content-type': 'text/plain' })
    response.end(`unsupported protocol ${target.protocol}\n`)
    return
  }
  // Let Node build the origin-form request; writing raw bytes into the
  // ServerResponse would re-frame them and corrupt the payload.
  const outgoing = http.request({
    host: target.hostname,
    port: target.port === '' ? 80 : Number.parseInt(target.port, 10),
    method: request.method ?? 'GET',
    path: `${target.pathname}${target.search}`,
    headers: Object.fromEntries(Object.entries(request.headers).filter(([name]) => name !== 'proxy-connection' && name !== 'proxy-authorization')),
  }, (upstream) => {
    response.writeHead(upstream.statusCode ?? 502, upstream.headers)
    upstream.pipe(response)
  })
  outgoing.once('error', (error) => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' })
    response.end(`upstream failed: ${error.message}\n`)
  })
  request.pipe(outgoing)
})

server.on('connect', (request, socket, head) => {
  const value = String(request.url ?? '')
  const index = value.lastIndexOf(':')
  if (index <= 0) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    return
  }
  const host = value.slice(0, index).replace(/^\[|\]$/gu, '')
  const portNumber = Number.parseInt(value.slice(index + 1), 10)
  if (!Number.isSafeInteger(portNumber) || portNumber <= 0 || portNumber > 65_535) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    return
  }
  const upstream = net.connect({ host, port: portNumber })
  upstream.once('connect', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head !== undefined && head.length > 0) upstream.write(head)
    bridge(socket, upstream)
  })
  upstream.once('error', () => {
    if (socket.writable) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    else socket.destroy()
  })
  socket.once('error', () => upstream.destroy())
})

server.on('error', (error) => {
  process.stderr.write(`egress proxy failed: ${error.message}\n`)
  process.exit(1)
})

server.listen(port, bind, () => {
  const address = server.address()
  say(`LISTEN ${address.port}`)
})

/**
 * Stop the listener and exit.
 * @param {number} code exit code.
 * @returns {void}
 */
function shutdown(code) {
  server.close(() => process.exit(code))
  // A half-open tunnel can keep the server from closing; do not wait for it.
  setTimeout(() => process.exit(code), 2_000).unref()
}

// The SSH channel owns this process. When the gateway disappears the channel
// closes and the next heartbeat write fails; without a heartbeat the proxy
// would stay reachable on the VPN long after the build ended.
process.stdout.on('error', () => shutdown(0))
setInterval(() => {
  process.stdout.write('.')
}, 5_000).unref()
