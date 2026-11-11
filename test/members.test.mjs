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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-test-'))
  const stateFile = path.join(dir, 'state.json')
  const clusterKey = 'test-cluster-key'
  const member = await listen((req, res) => {
    if (req.url === '/__gate/member') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, service: 'dsh-mesh', name: 'peer', gatePort: member.port }))
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-test-'))
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

/**
 * Build a service backed by one fake peer that answers discovery probes.
 * @param {object} options fixture options.
 * @param {(req: http.IncomingMessage, res: http.ServerResponse) => boolean} options.clusterProbe handler for `/__gate/cluster/*`.
 * @param {number} [options.checkTimeoutMs] pre-switch probe timeout.
 * @returns {Promise<{members: MemberService, gatePort: number, close: () => Promise<void>}>} fixture.
 */
async function peerFixture(options) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-test-'))
  const stateFile = path.join(dir, 'state.json')
  const peer = await listen((req, res) => {
    if (req.url === '/__gate/member') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        service: 'dsh-mesh',
        name: 'peer',
        gatePort: peer.port,
        dsh: { reachable: true },
      }))
      return
    }
    if (options.clusterProbe(req, res)) return
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await writeFile(stateFile, JSON.stringify({
    role: 'server',
    settings: { vpnCidr: '10.66.66.0/24', serverIp: '10.66.66.1' },
    server: { running: true, hostname: 'self', peers: [{ name: 'peer', ip: '127.0.0.1', online: true }] },
    client: {},
  }), 'utf8')
  const members = new MemberService({
    clusterKey: 'outer-cluster-key',
    memberPort: peer.port,
    stateFile,
    discoveryTimeoutMs: 500,
    discoveryCacheMs: 0,
    checkTimeoutMs: options.checkTimeoutMs ?? 1_000,
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
  const gate = await listen((req, res) => {
    const url = new URL(req.url ?? '/', 'http://gate.invalid')
    members.handle(req, res, url).then((handled) => {
      if (handled) return
      res.writeHead(404)
      res.end('not found')
    }).catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  return {
    members,
    gatePort: gate.port,
    close: async () => {
      await gate.close()
      await peer.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/**
 * POST one member switch through the fixture gate.
 * @param {number} gatePort gate port.
 * @param {string} id member id.
 * @returns {Promise<{status: number, headers: http.IncomingHttpHeaders, body: string}>} response.
 */
function selectMember(gatePort, id) {
  return request(gatePort, {
    method: 'POST',
    path: '/__gate/select',
    headers: {
      host: `127.0.0.1:${gatePort}`,
      origin: `http://127.0.0.1:${gatePort}`,
      'sec-fetch-site': 'same-origin',
      'x-dsh-gate': '1',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ id }),
  })
}

test('select refuses a peer whose gateway rejects the cluster signature', async () => {
  const fixture = await peerFixture({
    clusterProbe: (req, res) => {
      if (!String(req.url).startsWith('/__gate/cluster/')) return false
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'cluster_request_refused' }))
      return true
    },
  })
  try {
    const response = await selectMember(fixture.gatePort, '127.0.0.1')
    assert.equal(response.status, 409)
    const body = JSON.parse(response.body)
    assert.equal(body.ok, false)
    assert.equal(body.code, 'cluster_key_mismatch')
    assert.match(body.error, /DSH_GATE_CLUSTER_KEY/u)
    assert.equal(response.headers['set-cookie'], undefined)
  } finally {
    await fixture.close()
  }
})

test('select accepts a peer that verifies the cluster signature', async () => {
  const fixture = await peerFixture({
    clusterProbe: (req, res) => {
      if (!String(req.url).startsWith('/__gate/cluster/')) return false
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, gate: 'up' }))
      return true
    },
  })
  try {
    const response = await selectMember(fixture.gatePort, '127.0.0.1')
    assert.equal(response.status, 200)
    assert.match(String(response.headers['set-cookie']), /dsh_gate_target=127\.0\.0\.1/u)
  } finally {
    await fixture.close()
  }
})

test('select refuses a peer whose gateway does not answer the probe', async () => {
  const fixture = await peerFixture({
    checkTimeoutMs: 250,
    clusterProbe: (req) => {
      // Accept the connection but never answer the cluster probe.
      return String(req.url).startsWith('/__gate/cluster/')
    },
  })
  try {
    const response = await selectMember(fixture.gatePort, '127.0.0.1')
    assert.equal(response.status, 504)
    const body = JSON.parse(response.body)
    assert.equal(body.code, 'member_offline')
    assert.equal(response.headers['set-cookie'], undefined)
  } finally {
    await fixture.close()
  }
})

test('proxying sends the browser home when a member refuses the signature', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-test-'))
  const stateFile = path.join(dir, 'state.json')
  await writeFile(stateFile, JSON.stringify({ role: 'server', settings: {}, server: { running: true, peers: [] }, client: {} }), 'utf8')
  const peer = await listen((req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'cluster_request_refused' }))
  })
  const members = new MemberService({
    clusterKey: 'k',
    memberPort: peer.port,
    stateFile,
    log: () => {},
    isAdmitted: () => true,
    isUpstreamReady: () => true,
    forwardableHeaders: req => ({ host: req.headers.host }),
    agent: new http.Agent({ keepAlive: false }),
    page: () => '<html>unavailable</html>',
    sendHtml: (res, status, html) => {
      res.writeHead(status, { 'content-type': 'text/html' })
      res.end(html)
    },
  })
  const gate = await listen((req, res) => {
    members.proxyRemote(req, res, { id: '127.0.0.1', ip: '127.0.0.1', port: peer.port }).catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  try {
    const response = await request(gate.port, {
      path: '/conversation?x=1',
      headers: { cookie: 'dsh_gate_target=127.0.0.1' },
    })
    assert.equal(response.status, 303)
    assert.equal(response.headers.location, '/conversation?x=1')
    assert.match(String(response.headers['set-cookie']), /dsh_gate_target=; Max-Age=0/u)
  } finally {
    await gate.close()
    await peer.close()
    await rm(dir, { recursive: true, force: true })
  }
})
