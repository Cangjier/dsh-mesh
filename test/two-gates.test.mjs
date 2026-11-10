import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const gateEntry = path.join(root, 'code', 'gate', 'server.mjs')

/**
 * Ask for a free port on one loopback address.
 * @param {string} host bind address.
 * @returns {Promise<number>} port.
 */
function freePort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/**
 * Start a fake DSH upstream that names itself in the page body.
 * @param {string} label body label.
 * @param {boolean} [setCookie] whether to set a DSH-looking cookie.
 * @returns {Promise<{server: http.Server, port: number, close: () => Promise<void>}>} handle.
 */
async function fakeUpstream(label, setCookie = false) {
  const server = http.createServer((req, res) => {
    const headers = { 'content-type': 'text/html; charset=utf-8' }
    if (setCookie) headers['set-cookie'] = 'dsh-auth-test=1; Path=/; HttpOnly'
    res.writeHead(200, headers)
    res.end(`<!doctype html><html><body>upstream ${label}; url=${req.url}; cookie=${req.headers.cookie ?? ''}</body></html>`)
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
 * Wait until a gate prints its listening line.
 * @param {import('node:child_process').ChildProcess} child gate process.
 * @param {string} label process label.
 * @returns {Promise<void>}
 */
function waitForListening(child, label) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`${label} did not start:\n${output}`)), 10_000)
    const onData = (chunk) => {
      output += String(chunk)
      if (output.toLowerCase().includes('listening on')) {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        child.stderr.off('data', onData)
        resolve()
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`${label} exited with ${String(code)}:\n${output}`))
    })
  })
}

/**
 * Make one HTTP request.
 * @param {{host: string, port: number}} target target.
 * @param {{method?: string, path?: string, headers?: Record<string, string>, body?: string}} options request.
 * @returns {Promise<{status: number, headers: http.IncomingHttpHeaders, body: string}>} response.
 */
function request(target, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: target.host,
      port: target.port,
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

/**
 * Extract the gate cookie pair from a login response.
 * @param {http.IncomingHttpHeaders} headers response headers.
 * @returns {string} cookie pair.
 */
function gateCookie(headers) {
  const list = Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : [headers['set-cookie']]
  return String(list.find(value => value?.startsWith('dsh_gate=')) ?? '').split(';')[0]
}

/**
 * Start one gate.
 * @param {object} options gate options.
 * @returns {Promise<import('node:child_process').ChildProcess>} child.
 */
async function startGate(options) {
  const child = spawn(process.execPath, [gateEntry], {
    cwd: root,
    env: {
      ...process.env,
      DSH_GATE_BIND: options.bind,
      DSH_GATE_PORT: String(options.port),
      DSH_GATE_MEMBER_PORT: String(options.memberPort ?? options.port),
      DSH_GATE_MEMBER_PORTS: (options.memberPorts ?? []).map(String).join(','),
      DSH_GATE_PASSWORD: options.password,
      DSH_GATE_DATA_DIR: path.join(options.dir, 'data'),
      DSH_HOME: path.join(options.dir, 'home'),
      DSH_GATE_NO_SPAWN: '1',
      DSH_WEB_TOKEN_URL: `http://127.0.0.1:${String(options.upstreamPort)}/?token=${options.token}`,
      DSH_GATE_CLUSTER_KEY: 'two-gate-secret',
      DSH_GATE_DISCOVERY_TIMEOUT_MS: '500',
      DSH_GATE_DISCOVERY_CACHE_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await waitForListening(child, options.label)
  return child
}

test('two gates: discover, select by cookie, proxy, namespace cookies, and return local', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-person-web-two-gates-'))
  const upstreamA = await fakeUpstream('A')
  const upstreamB = await fakeUpstream('B', true)
  const portA = await freePort('127.0.0.1')
  const portB = await freePort('127.0.0.2')
  const password = 'two-gate-password'
  const dirA = path.join(dir, 'gate-a')
  const dirB = path.join(dir, 'gate-b')
  await mkdir(path.join(dirA, 'home', 'wireguard'), { recursive: true })
  await mkdir(path.join(dirB, 'home', 'wireguard'), { recursive: true })
  await writeFile(path.join(dirA, 'home', 'wireguard', 'state.json'), JSON.stringify({
    role: 'server',
    settings: { vpnCidr: '10.66.66.0/24', serverIp: '127.0.0.1' },
    server: {
      running: true,
      hostname: 'gate-a',
      peers: [{ name: 'gate-b', ip: '127.0.0.2', online: true }],
    },
    client: {},
  }), 'utf8')
  await writeFile(path.join(dirB, 'home', 'wireguard', 'state.json'), JSON.stringify({
    role: 'server',
    settings: { vpnCidr: '10.66.66.0/24', serverIp: '127.0.0.2' },
    server: { running: true, hostname: 'gate-b', peers: [] },
    client: {},
  }), 'utf8')
  let childA
  let childB
  try {
    childB = await startGate({
      bind: '127.0.0.2',
      port: portB,
      dir: dirB,
      upstreamPort: upstreamB.port,
      token: 'token-B',
      password,
      label: 'gate B',
      memberPort: portB,
    })
    childA = await startGate({
      bind: '127.0.0.1',
      port: portA,
      dir: dirA,
      upstreamPort: upstreamA.port,
      token: 'token-A',
      password,
      label: 'gate A',
      memberPort: portA,
      memberPorts: [portB],
    })

    const login = await request({ host: '127.0.0.1', port: portA }, {
      method: 'POST',
      path: '/__gate/login',
      headers: {
        host: `127.0.0.1:${String(portA)}`,
        origin: `http://127.0.0.1:${String(portA)}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `password=${encodeURIComponent(password)}&next=%2F`,
    })
    assert.equal(login.status, 303)
    const cookieA = gateCookie(login.headers)
    assert.match(cookieA, /^dsh_gate=/u)

    const members = await request({ host: '127.0.0.1', port: portA }, {
      path: '/__gate/members',
      headers: { cookie: cookieA },
    })
    assert.equal(members.status, 200)
    const snapshot = JSON.parse(members.body)
    const peerB = snapshot.members.find(member => member.id === '127.0.0.2')
    assert.ok(peerB, members.body)
    assert.equal(peerB.dsh, true)
    assert.equal(peerB.port, portB)

    const select = await request({ host: '127.0.0.1', port: portA }, {
      method: 'POST',
      path: '/__gate/select',
      headers: {
        host: `127.0.0.1:${String(portA)}`,
        origin: `http://127.0.0.1:${String(portA)}`,
        'sec-fetch-site': 'same-origin',
        'x-dsh-gate': '1',
        'content-type': 'application/json',
        cookie: cookieA,
      },
      body: JSON.stringify({ id: '127.0.0.2' }),
    })
    assert.equal(select.status, 200)
    const targetCookie = String(select.headers['set-cookie']).includes('dsh_gate_target=127.0.0.2')
      ? 'dsh_gate_target=127.0.0.2'
      : ''
    assert.equal(targetCookie, 'dsh_gate_target=127.0.0.2')
    const cookiesB = `${cookieA}; ${targetCookie}`

    const first = await request({ host: '127.0.0.1', port: portA }, {
      path: '/',
      headers: { cookie: cookiesB },
    })
    assert.equal(first.status, 303, first.body)
    assert.match(String(first.headers.location), /token=token-B/u)

    const page = await request({ host: '127.0.0.1', port: portA }, {
      path: String(first.headers.location),
      headers: { cookie: cookiesB },
    })
    assert.equal(page.status, 200, page.body)
    assert.match(page.body, /upstream B/u)
    assert.match(String(page.headers['x-dsh-gate-member']), /127\.0\.0\.2/u)
    const setCookies = Array.isArray(page.headers['set-cookie']) ? page.headers['set-cookie'] : [page.headers['set-cookie']]
    assert.ok(setCookies.some(value => value?.startsWith('dsh_m_127.0.0.2_dsh-auth-test=')), String(setCookies))

    const withMemberCookie = `${cookiesB}; dsh_m_127.0.0.2_dsh-auth-test=1`
    const pageWithCookie = await request({ host: '127.0.0.1', port: portA }, {
      path: String(first.headers.location),
      headers: { cookie: withMemberCookie },
    })
    assert.equal(pageWithCookie.status, 200)
    assert.match(pageWithCookie.body, /cookie=dsh-auth-test=1/u)

    // Return to local: the same browser now asks for the local upstream.
    const localSelect = await request({ host: '127.0.0.1', port: portA }, {
      method: 'POST',
      path: '/__gate/select',
      headers: {
        host: `127.0.0.1:${String(portA)}`,
        origin: `http://127.0.0.1:${String(portA)}`,
        'sec-fetch-site': 'same-origin',
        'x-dsh-gate': '1',
        'content-type': 'application/json',
        cookie: cookiesB,
      },
      body: JSON.stringify({ id: 'local' }),
    })
    assert.equal(localSelect.status, 200)
    const localCookie = 'dsh_gate_target=local'
    const localFirst = await request({ host: '127.0.0.1', port: portA }, {
      path: '/',
      headers: { cookie: `${cookieA}; ${localCookie}` },
    })
    assert.equal(localFirst.status, 303)
    assert.match(String(localFirst.headers.location), /token=token-A/u)
    const localPage = await request({ host: '127.0.0.1', port: portA }, {
      path: String(localFirst.headers.location),
      headers: { cookie: `${cookieA}; ${localCookie}` },
    })
    assert.equal(localPage.status, 200)
    assert.match(localPage.body, /upstream A/u)
  } finally {
    for (const child of [childA, childB]) {
      if (child === undefined) continue
      child.kill('SIGTERM')
      await new Promise((resolve) => {
        if (child.exitCode !== null) resolve()
        else {
          child.once('exit', resolve)
          setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3_000).unref()
        }
      })
    }
    await upstreamA.close()
    await upstreamB.close()
    await rm(dir, { recursive: true, force: true })
  }
})
