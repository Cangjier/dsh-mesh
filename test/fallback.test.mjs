import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildDeployPlan, buildLinuxActivateScript } from '../code/deploy/engine.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const gateEntry = path.join(root, 'code', 'gate', 'server.mjs')

/** A currently free loopback port. */
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

/** A fake DSH upstream with a launch token. */
async function fakeUpstream() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><body>fake dsh</body></html>')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { server, port, close: () => new Promise(resolve => server.close(resolve)) }
}

/** Wait for the gate's listening line. */
function waitForListening(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`gate did not start:\n${output}`)), timeoutMs)
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
    child.once('exit', code => reject(new Error(`gate exited ${String(code)}:\n${output}`)))
  })
}

/** One HTTP request. */
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

/** Login and return the gate cookie. */
async function login(port, password) {
  const response = await request(port, {
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
  assert.equal(response.status, 303)
  const cookies = Array.isArray(response.headers['set-cookie'])
    ? response.headers['set-cookie']
    : [response.headers['set-cookie']]
  const gate = String(cookies.find(value => value?.startsWith('dsh_gate=')) ?? '').split(';')[0]
  assert.match(gate, /^dsh_gate=/u)
  return gate
}

/** A stub bin directory for systemctl/curl/sleep. */
async function stubBin(dir) {
  const bin = path.join(dir, 'bin')
  await mkdir(bin, { recursive: true })
  for (const name of ['systemctl', 'sleep']) {
    const file = path.join(bin, name)
    await writeFile(file, `#!/bin/sh\necho "stub ${name} $*" >> ${JSON.stringify(path.join(dir, 'commands.log'))}\nexit 0\n`, 'utf8')
    await chmod(file, 0o755)
  }
  const curl = path.join(bin, 'curl')
  // The gate health only needs exit 0; the embedded interop probe also matches
  // the capability marker. The fake member has no real DSH Web on :8765.
  await writeFile(curl, [
    '#!/bin/sh',
    'case "$*" in',
    '  *8765/healthz*) printf \'%s\\n\' \'{"ok":true,"engine":"dsh-mesh-embedded-interop-v1"}\' ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'), 'utf8')
  await chmod(curl, 0o755)
  return bin
}

test('an admitted page is redirected to the acceptance page while an upgrade is pending', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-fallback-gate-'))
  const upstream = await fakeUpstream()
  const port = await freePort()
  const password = 'fallback-password'
  const data = path.join(dir, 'data')
  await mkdir(data, { recursive: true })
  const child = spawn(process.execPath, [gateEntry], {
    cwd: root,
    env: {
      ...process.env,
      DSH_GATE_BIND: '127.0.0.1',
      DSH_GATE_PORT: String(port),
      DSH_GATE_MEMBER_PORT: String(port),
      DSH_GATE_PASSWORD: password,
      DSH_GATE_DATA_DIR: data,
      DSH_HOME: path.join(dir, 'home'),
      DSH_GATE_NO_SPAWN: '1',
      DSH_WEB_TOKEN_URL: `http://127.0.0.1:${String(upstream.port)}/?token=test-token`,
      DSH_GATE_DISCOVERY_TIMEOUT_MS: '50',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await waitForListening(child)
    const cookie = await login(port, password)
    const pending = {
      format: 1,
      status: 'pending',
      layout: 'flat',
      from: '0.2.2-rc.4',
      to: '0.2.2-rc.5',
      backup: path.join(dir, '.upgrade-backup', 'now'),
      root: dir,
      port,
      upgradedAt: '2026-11-16T00:00:00.000Z',
    }
    await writeFile(path.join(data, 'upgrade-pending.json'), `${JSON.stringify(pending)}\n`, 'utf8')

    const redirect = await request(port, { path: '/', headers: { cookie, accept: 'text/html', 'sec-fetch-mode': 'navigate' } })
    assert.equal(redirect.status, 303)
    assert.equal(redirect.headers.location, '/__gate/fallback')

    const page = await request(port, { path: '/__gate/fallback', headers: { cookie } })
    assert.equal(page.status, 200)
    assert.match(page.body, /升级待验收/u)
    assert.match(page.body, /0\.2\.2-rc\.4/u)
    assert.match(page.body, /0\.2\.2-rc\.5/u)
    assert.match(page.body, />查看</u)
    assert.match(page.body, />验收</u)
    assert.match(page.body, />回退</u)

    const view = await request(port, { path: '/__gate/fallback/view', headers: { cookie } })
    assert.equal(view.status, 303)
    assert.equal(view.headers.location, '/')
    const previewCookies = Array.isArray(view.headers['set-cookie'])
      ? view.headers['set-cookie']
      : [view.headers['set-cookie']]
    assert.ok(previewCookies.some(value => String(value).startsWith('dsh_gate_preview=1')))

    const previewed = await request(port, {
      path: '/',
      headers: { cookie: `${cookie}; dsh_gate_preview=1`, accept: 'text/html', 'sec-fetch-mode': 'navigate' },
    })
    assert.equal(previewed.status, 303)
    assert.match(String(previewed.headers.location), /^\//u)
    assert.doesNotMatch(String(previewed.headers.location), /fallback/u)

    const accepted = await request(port, {
      method: 'POST',
      path: '/__gate/fallback/accept',
      headers: {
        host: `127.0.0.1:${String(port)}`,
        origin: `http://127.0.0.1:${String(port)}`,
        'sec-fetch-site': 'same-origin',
        cookie,
      },
    })
    assert.equal(accepted.status, 303)
    assert.equal(accepted.headers.location, '/')
    await assert.rejects(readFile(path.join(data, 'upgrade-pending.json'), 'utf8'), /ENOENT/u)

    const after = await request(port, { path: '/', headers: { cookie, accept: 'text/html', 'sec-fetch-mode': 'navigate' } })
    assert.equal(after.status, 303)
    assert.doesNotMatch(String(after.headers.location), /fallback/u)
  } finally {
    child.kill('SIGKILL')
    await upstream.close()
    await rm(dir, { recursive: true, force: true })
  }
})

