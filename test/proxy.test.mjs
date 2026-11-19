import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createProxyFetch, parseProxyUrl, proxyEnv } from '../code/build/proxy.mjs'
import { uploadFile } from '../code/shared/http-client.mjs'

const PROXY_SCRIPT = path.resolve(import.meta.dirname, '..', 'code', 'shared', 'egress-proxy.mjs')

test('parseProxyUrl accepts host:port and rejects other schemes', () => {
  assert.deepEqual(parseProxyUrl('10.66.66.2:8888'), {
    href: 'http://10.66.66.2:8888',
    protocol: 'http:',
    hostname: '10.66.66.2',
    port: 8888,
    auth: null,
  })
  assert.equal(parseProxyUrl('http://user:pass@proxy.local:3128').auth, 'user:pass')
  assert.equal(parseProxyUrl('https://proxy.local').port, 443)
  assert.throws(() => parseProxyUrl('socks5://10.66.66.2:1080'), /http or https/u)
  assert.throws(() => parseProxyUrl(''), /empty/u)
})

test('proxyEnv configures npm and keeps the mesh direct', () => {
  const env = proxyEnv('http://10.66.66.2:8888', { PATH: '/bin', NO_PROXY: 'example.test' })
  assert.equal(env.HTTPS_PROXY, 'http://10.66.66.2:8888')
  assert.equal(env.npm_config_proxy, 'http://10.66.66.2:8888')
  assert.equal(env.npm_config_https_proxy, 'http://10.66.66.2:8888')
  assert.equal(env.PATH, '/bin')
  // The proxy member itself lives in the VPN range, so it must stay direct.
  assert.match(env.NO_PROXY, /10\.66\.66\.0\/24/u)
  assert.match(env.NO_PROXY, /example\.test/u)
})

/**
 * Generate a throwaway certificate so the CONNECT path can be tested without a
 * network or a real PKI. OpenSSL ships with the platforms this repo targets;
 * the TLS test is skipped where it is missing.
 * @returns {Promise<{key: string, cert: string}|null>} files, or null when unavailable.
 */
async function certificate() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
  } catch {
    return null
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-tls-'))
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', path.join(dir, 'key.pem'),
    '-out', path.join(dir, 'cert.pem'),
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' })
  return {
    key: await readFile(path.join(dir, 'key.pem'), 'utf8'),
    cert: await readFile(path.join(dir, 'cert.pem'), 'utf8'),
    dir,
  }
}

/**
 * Start the real egress proxy the gateway ships, bound to loopback.
 * @returns {Promise<{url: string, child: import('node:child_process').ChildProcess}>} proxy.
 */
async function startEgressProxy() {
  const child = spawn(process.execPath, [PROXY_SCRIPT, '127.0.0.1', '0'], { stdio: ['pipe', 'pipe', 'inherit'] })
  const port = await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('egress proxy did not report a port')), 10_000)
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk)
      const match = /LISTEN (\d+)/u.exec(buffer)
      if (match === null) return
      clearTimeout(timer)
      resolve(Number(match[1]))
    })
    child.once('exit', code => reject(new Error(`egress proxy exited with ${String(code)}`)))
  })
  return { url: `http://127.0.0.1:${port}`, child }
}

/**
 * An HTTP proxy that accepts CONNECT but waits before opening the tunnel.
 *
 * The delay is what exposes the upload bug: a file stream that starts flowing
 * during CONNECT is drained before the request is ready for it, so the origin
 * never receives a body.
 * @param {number} delayMs milliseconds to wait before dialling the target.
 * @returns {Promise<{url: string, close: () => Promise<void>}>} proxy.
 */
function startDelayedProxy(delayMs) {
  return new Promise((resolve) => {
    const sockets = new Set()
    const server = http.createServer((request, response) => {
      response.writeHead(405)
      response.end()
    })
    server.on('connect', (request, socket, head) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      const value = String(request.url ?? '')
      const index = value.lastIndexOf(':')
      const host = value.slice(0, index)
      const port = Number.parseInt(value.slice(index + 1), 10)
      const timer = setTimeout(() => {
        const upstream = net.connect({ host, port })
        sockets.add(upstream)
        upstream.once('close', () => sockets.delete(upstream))
        upstream.once('connect', () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head !== undefined && head.length > 0) upstream.write(head)
          socket.pipe(upstream)
          upstream.pipe(socket)
        })
        upstream.once('error', () => socket.destroy())
        socket.once('error', () => upstream.destroy())
      }, delayMs)
      socket.once('close', () => clearTimeout(timer))
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy()
          server.close(() => done())
        }),
      })
    })
  })
}

/**
 * Start one HTTP origin.
 * @param {(request: http.IncomingMessage, response: http.ServerResponse) => void} handler request handler.
 * @returns {Promise<{port: number, close: () => Promise<void>}>} server.
 */
function startHttp(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        port: typeof address === 'object' && address !== null ? address.port : 0,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

test('proxied fetch forwards plain HTTP through the egress proxy', async () => {
  const origin = await startHttp((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain', 'x-path': request.url ?? '' })
    response.end('hello over http')
  })
  const proxy = await startEgressProxy()
  try {
    const fetchThrough = createProxyFetch(proxy.url)
    const response = await fetchThrough(`http://127.0.0.1:${origin.port}/hello?a=1`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'hello over http')
  } finally {
    proxy.child.kill()
    await origin.close()
  }
})

test('proxied fetch tunnels HTTPS through CONNECT', async (t) => {
  const tlsFiles = await certificate()
  if (tlsFiles === null) {
    t.skip('openssl is not available')
    return
  }
  // The origin is a throwaway certificate; production proxies do not intercept
  // TLS, so only the tunnel itself is under test here.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  const server = https.createServer({ key: tlsFiles.key, cert: tlsFiles.cert }, (request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(`secure ${String(request.url)}`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const proxy = await startEgressProxy()
  try {
    const fetchThrough = createProxyFetch(proxy.url)
    const response = await fetchThrough(`https://127.0.0.1:${String(port)}/tunnel`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'secure /tunnel')
  } finally {
    proxy.child.kill()
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    await new Promise(resolve => server.close(resolve))
    await rm(tlsFiles.dir, { recursive: true, force: true })
  }
})

test('proxied fetch follows redirects and surfaces proxy errors', async () => {
  const origin = await startHttp((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/final' })
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('final body')
  })
  const proxy = await startEgressProxy()
  try {
    const fetchThrough = createProxyFetch(proxy.url)
    const response = await fetchThrough(`http://127.0.0.1:${origin.port}/redirect`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'final body')
    const broken = createProxyFetch('http://127.0.0.1:9')
    await assert.rejects(broken(`http://127.0.0.1:${origin.port}/`), /ECONNREFUSED|proxy/u)
  } finally {
    proxy.child.kill()
    await origin.close()
  }
})

test('uploadFile streams the whole body through a slow CONNECT tunnel', async (t) => {
  const tlsFiles = await certificate()
  if (tlsFiles === null) {
    t.skip('openssl is not available')
    return
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-upload-'))
  const file = path.join(dir, 'archive.bin')
  const payload = Buffer.alloc(4 * 1024 * 1024, 0x5a)
  await writeFile(file, payload)
  const expected = createHash('sha256').update(payload).digest('hex')
  let received = null
  const server = https.createServer({ key: tlsFiles.key, cert: tlsFiles.cert }, (request, response) => {
    const hash = createHash('sha256')
    request.on('data', chunk => hash.update(chunk))
    request.once('end', () => {
      received = hash.digest('hex')
      response.writeHead(201, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  // CONNECT takes 600 ms; the old code drained the 4 MiB file in that window
  // and then uploaded nothing, which GitHub reports as a 408.
  const proxy = await startDelayedProxy(600)
  const env = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  const progress = []
  try {
    const result = await uploadFile(`https://127.0.0.1:${String(port)}/upload`, {
      file,
      proxy: proxy.url,
      headers: { 'content-type': 'application/octet-stream' },
      onProgress: event => progress.push(event.percent),
      timeoutMs: 15_000,
      idleTimeoutMs: 5000,
      // One attempt: a regression should fail the test in five seconds, not
      // spend twenty on the retry ladder.
      retries: 0,
    })
    assert.equal(result.status, 201)
    assert.equal(received, expected)
    assert.equal(progress.at(-1), 100)
  } finally {
    if (env === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = env
    await proxy.close()
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
