import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const gateEntry = path.join(root, 'code', 'gate', 'server.mjs')

/**
 * Ask the OS for a currently free TCP port.
 * @returns {Promise<number>} free port.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/**
 * Start a fake DSH upstream.
 * @returns {Promise<{server: http.Server, port: number, close: () => Promise<void>}>} handle.
 */
async function fakeUpstream() {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/status') === true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, upstream: true }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><body>fake dsh</body></html>')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { server, port, close: () => new Promise((resolve) => server.close(resolve)) }
}

/**
 * Wait until the gate prints its listening line.
 * @param {import('node:child_process').ChildProcess} child gate process.
 * @param {number} timeoutMs timeout.
 * @returns {Promise<string>} captured output.
 */
function waitForListening(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      reject(new Error(`gate did not start in time:\n${output}`))
    }, timeoutMs)
    const onData = (chunk) => {
      output += String(chunk)
      if (output.toLowerCase().includes('listening on')) {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        child.stderr.off('data', onData)
        resolve(output)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`gate exited with ${String(code)}:\n${output}`))
    })
  })
}

/**
 * Make one HTTP request.
 * @param {number} port gate port.
 * @param {{method?: string, path?: string, headers?: Record<string, string>, body?: string}} options request.
 * @returns {Promise<{status: number, headers: http.IncomingHttpHeaders, body: string}>} response.
 */
function request(port, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path: options.path ?? '/',
      headers: options.headers,
    }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

test('the gate serves member discovery and selection end to end', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-gate-'))
  const upstream = await fakeUpstream()
  const port = await freePort()
  const password = 'test-password-123'
  const child = spawn(process.execPath, [gateEntry], {
    cwd: root,
    env: {
      ...process.env,
      DSH_GATE_BIND: '127.0.0.1',
      DSH_GATE_PORT: String(port),
      DSH_GATE_MEMBER_PORT: String(port),
      DSH_GATE_PASSWORD: password,
      DSH_GATE_DATA_DIR: path.join(dir, 'data'),
      DSH_HOME: path.join(dir, 'home'),
      DSH_GATE_NO_SPAWN: '1',
      DSH_WEB_TOKEN_URL: `http://127.0.0.1:${String(upstream.port)}/?token=test-token`,
      DSH_GATE_CLUSTER_KEY: 'test-cluster-key',
      DSH_GATE_DISCOVERY_TIMEOUT_MS: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await waitForListening(child)

    const health = await request(port, { path: '/__gate/health' })
    assert.equal(health.status, 200)
    assert.equal(JSON.parse(health.body).gate, 'up')

    const member = await request(port, { path: '/__gate/member' })
    assert.equal(member.status, 200)
    const memberInfo = JSON.parse(member.body)
    assert.equal(memberInfo.service, 'dsh-mesh')
    assert.equal(memberInfo.cluster.configured, true)

    const login = await request(port, {
      method: 'POST',
      path: '/__gate/login',
      headers: {
        host: `127.0.0.1:${String(port)}`,
        origin: `http://127.0.0.1:${String(port)}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `password=${encodeURIComponent(password)}&next=%2F`,
    })
    assert.equal(login.status, 303)
    const setCookie = Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'] : [login.headers['set-cookie']]
    const gateCookie = String(setCookie.find(value => value?.startsWith('dsh_gate=')) ?? '').split(';')[0]
    assert.match(gateCookie, /^dsh_gate=/u)

    const members = await request(port, {
      path: '/__gate/members',
      headers: { cookie: gateCookie },
    })
    assert.equal(members.status, 200)
    const snapshot = JSON.parse(members.body)
    assert.equal(snapshot.target, 'local')
    assert.equal(snapshot.local.id, 'local')
    assert.ok(Array.isArray(snapshot.members))

    const selected = await request(port, {
      method: 'POST',
      path: '/__gate/select',
      headers: {
        host: `127.0.0.1:${String(port)}`,
        origin: `http://127.0.0.1:${String(port)}`,
        'sec-fetch-site': 'same-origin',
        'x-dsh-gate': '1',
        'content-type': 'application/json',
        cookie: gateCookie,
      },
      body: JSON.stringify({ id: 'local' }),
    })
    assert.equal(selected.status, 200)
    assert.match(String(selected.headers['set-cookie']), /dsh_gate_target=local/u)

    const status = await request(port, {
      path: '/__gate/status',
      headers: { cookie: `${gateCookie}; dsh_gate_target=local` },
    })
    assert.equal(status.status, 200)
    assert.equal(JSON.parse(status.body).target, 'local')

    const reset = await request(port, {
      path: '/__gate/reset',
      headers: { cookie: `${gateCookie}; dsh_gate_target=local` },
    })
    assert.equal(reset.status, 303)
    assert.match(String(reset.headers['set-cookie']), /dsh_gate_target=; Max-Age=0/u)
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve()
      else {
        child.once('exit', resolve)
        setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3_000).unref()
      }
    })
    await upstream.close()
    await rm(dir, { recursive: true, force: true })
  }
})
