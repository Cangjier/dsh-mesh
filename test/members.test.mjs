import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MemberService, isPrivateAddress, stripClusterPrefix } from '../code/gate/members.mjs'
import { signClusterRequest } from '../code/shared/cluster.mjs'

/**
 * Start an HTTP server on an ephemeral loopback port.
 * @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} handler request handler.
 * @returns {Promise<{server: http.Server, port: number, close: () => Promise<void>}>} server handle.
 */
async function listen(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    server,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * Make one HTTP request and read the whole body.
 * @param {number} port target port.
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
    if (options.body !== undefined) req.end(options.body)
    else req.end()
  })
}

test('stripClusterPrefix keeps the exact path and query', () => {
  assert.equal(stripClusterPrefix('/__gate/cluster'), '/')
  assert.equal(stripClusterPrefix('/__gate/cluster/'), '/')
  assert.equal(stripClusterPrefix('/__gate/cluster/api/status?x=1'), '/api/status?x=1')
  assert.equal(stripClusterPrefix('/api/status'), null)
})

test('isPrivateAddress covers loopback, RFC1918, CGNAT, and IPv6 local ranges', () => {
  for (const address of ['127.0.0.1', '10.66.66.2', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateAddress(address), true, address)
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888']) {
    assert.equal(isPrivateAddress(address), false, address)
  }
})

test('member service discovers a peer, proxies headers, and handles cluster requests', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-person-web-test-'))
  const stateFile = path.join(dir, 'state.json')
  const clusterKey = 'test-cluster-key'
  const member = await listen((req, res) => {
    if (req.url === '/__gate/member') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, service: 'dsh-person-web', name: 'peer', gatePort: member.port }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'dsh_gate=inner; Path=/; HttpOnly' })
    res.end(JSON.stringify({
      url: req.url,
      host: req.headers.host,
      cookie: req.headers.cookie ?? '',
      cluster: req.headers['x-dsh-cluster'] !== undefined,
    }))
  })
  await writeFile(stateFile, JSON.stringify({
    role: 'server',
    settings: { vpnCidr: '10.66.66.0/24', serverIp: '10.66.66.1' },
    server: {
      running: true,
      hostname: 'self',
      peers: [{ name: 'peer', ip: '127.0.0.1', online: true }],
    },
    client: {},
  }), 'utf8')
  const members = new MemberService({
    clusterKey,
    memberPort: member.port,
    stateFile,
    discoveryTimeoutMs: 300,
    discoveryCacheMs: 1_000,
    version: 'test',
    fetchImpl: fetch,
    log: () => {},
    isAdmitted: () => true,
    isUpstreamReady: () => true,
    forwardableHeaders: req => ({ host: req.headers.host, cookie: req.headers.cookie }),
    agent: new http.Agent({ keepAlive: false }),
    page: () => '<html>unavailable</html>',
    sendHtml: (res, status, html) => {
      res.writeHead(status, { 'content-type': 'text/html' })
      res.end(html)
    },
  })
  try {
    const snapshot = await members.snapshot({ force: true })
    const peer = snapshot.members.find(candidate => candidate.id === '127.0.0.1')
    assert.ok(peer)
    assert.equal(peer.dsh, true)
    assert.equal(peer.port, member.port)

    const headers = members._forwardHeaders({
      method: 'GET',
      url: '/api/status?x=1',
      headers: {
        host: 'public.example',
        cookie: 'dsh_gate=outer; dsh_m_127.0.0.1_dsh_gate=inner; dsh_gate_target=127.0.0.1',
      },
    }, '127.0.0.1')
    assert.equal(headers.host, 'public.example')
    assert.equal(headers.cookie, 'dsh_gate=inner')
    assert.ok(headers['x-dsh-cluster'])

    const responseHeaders = members._responseHeaders({ 'set-cookie': ['dsh_gate=inner; Path=/; HttpOnly'] }, '127.0.0.1')
    assert.deepEqual(responseHeaders['set-cookie'], ['dsh_m_127.0.0.1_dsh_gate=inner; Path=/; HttpOnly'])
    assert.equal(responseHeaders['x-dsh-gate-member'], '127.0.0.1')

    const signed = signClusterRequest(clusterKey, { method: 'GET', path: '/__gate/cluster/hello?x=1' })
    const local = await listen((req, res) => {
      members.handleCluster(req, res, (innerReq, innerRes) => {
        innerRes.writeHead(200, { 'content-type': 'application/json' })
        innerRes.end(JSON.stringify({ url: innerReq.url, cluster: innerReq.__dshCluster === true }))
      }).catch((error) => {
        res.writeHead(500)
        res.end(String(error))
      })
    })
    try {
      const accepted = await request(local.port, {
        path: '/__gate/cluster/hello?x=1',
        headers: { 'x-dsh-cluster': signed },
      })
      assert.equal(accepted.status, 200)
      assert.deepEqual(JSON.parse(accepted.body), { url: '/hello?x=1', cluster: true })

      const rejected = await request(local.port, {
        path: '/__gate/cluster/hello?x=1',
        headers: { 'x-dsh-cluster': 'v1.1.2.3' },
      })
      assert.equal(rejected.status, 403)
    } finally {
      await local.close()
    }
  } finally {
    await member.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('select sets the target cookie and status reports it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-person-web-test-'))
  const stateFile = path.join(dir, 'state.json')
  await writeFile(stateFile, JSON.stringify({
    role: 'server',
    settings: { vpnCidr: '10.66.66.0/24', serverIp: '10.66.66.1' },
    server: { running: true, hostname: 'self', peers: [] },
    client: {},
  }), 'utf8')
  const members = new MemberService({
    clusterKey: 'test-cluster-key',
    memberPort: 80,
    stateFile,
    discoveryTimeoutMs: 100,
    version: 'test',
    log: () => {},
    isAdmitted: () => true,
    isUpstreamReady: () => true,
    forwardableHeaders: req => ({ host: req.headers.host, cookie: req.headers.cookie }),
    agent: new http.Agent({ keepAlive: false }),
    page: () => '<html>unavailable</html>',
    sendHtml: (res, status, html) => {
      res.writeHead(status, { 'content-type': 'text/html' })
      res.end(html)
    },
  })
  const gate = await listen((req, res) => {
    const url = new URL(req.url ?? '/', 'http://gate.invalid')
    members.handle(req, res, url).then((handled) => {
      if (!handled) {
        res.writeHead(404)
        res.end('not found')
      }
    }).catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  try {
    const selected = await request(gate.port, {
      method: 'POST',
      path: '/__gate/select',
      headers: {
        host: `127.0.0.1:${gate.port}`,
        origin: `http://127.0.0.1:${gate.port}`,
        'sec-fetch-site': 'same-origin',
        'x-dsh-gate': '1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 'local' }),
    })
    assert.equal(selected.status, 200)
    assert.match(String(selected.headers['set-cookie']), /dsh_gate_target=local/u)

    const status = await request(gate.port, {
      path: '/__gate/status',
      headers: { cookie: 'dsh_gate_target=local' },
    })
    assert.equal(status.status, 200)
    assert.equal(JSON.parse(status.body).target, 'local')

    const reset = await request(gate.port, {
      path: '/__gate/reset',
      headers: { cookie: 'dsh_gate_target=local' },
    })
    assert.equal(reset.status, 303)
    assert.match(String(reset.headers['set-cookie']), /dsh_gate_target=; Max-Age=0/u)
  } finally {
    await gate.close()
    await rm(dir, { recursive: true, force: true })
  }
})
