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
const rollbackScript = path.join(root, 'code', 'deploy', 'rollback-local.sh')

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
  await writeFile(curl, '#!/bin/sh\nexit 0\n', 'utf8')
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

test('a successful flat upgrade arms the acceptance page with version and backup details', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-upgrade-marker-'))
  try {
    const install = path.join(dir, 'install')
    const stage = path.join(dir, 'stage')
    const home = path.join(dir, 'home')
    const bin = await stubBin(dir)
    await mkdir(path.join(install, 'config'), { recursive: true })
    await mkdir(path.join(install, 'plugins', 'dsh-mesh'), { recursive: true })
    await mkdir(path.join(install, 'gate'), { recursive: true })
    await mkdir(path.join(install, 'code', 'dsh-service'), { recursive: true })
    await mkdir(home, { recursive: true })
    await writeFile(path.join(install, 'config', 'gate.env'), `DSH_GATE_PORT=18099\nDSH_GATE_PASSWORD=test\nDSH_HOME=${home}\n`, 'utf8')
    await writeFile(path.join(install, 'plugins', 'dsh-mesh', 'package.json'), '{"version":"0.0.1"}\n', 'utf8')
    await writeFile(path.join(install, 'manifest.json'), '{"version":"0.0.1"}\n', 'utf8')
    await writeFile(path.join(install, 'gate', 'server.mjs'), '// old gate\n', 'utf8')

    await mkdir(path.join(stage, 'plugins', 'dsh-mesh'), { recursive: true })
    await mkdir(path.join(stage, 'gate'), { recursive: true })
    await mkdir(path.join(stage, 'code', 'dsh-service'), { recursive: true })
    await mkdir(path.join(stage, 'code', 'wireguard'), { recursive: true })
    await mkdir(path.join(stage, 'runtime', 'node', 'bin'), { recursive: true })
    await symlink(process.execPath, path.join(stage, 'runtime', 'node', 'bin', 'node'))
    await writeFile(path.join(stage, 'manifest.json'), '{"version":"0.0.2"}\n', 'utf8')
    await writeFile(path.join(stage, 'start.sh'), '#!/usr/bin/env bash\n', 'utf8')
    await writeFile(path.join(stage, 'plugins', 'dsh-mesh', 'package.json'), '{"version":"0.0.2"}\n', 'utf8')
    // The new gateway advertises the acceptance route; the upgrade script uses
    // this marker to decide whether the package understands the pending file.
    await writeFile(path.join(stage, 'gate', 'server.mjs'), '// __gate/fallback\n', 'utf8')
    for (const [file, body] of [
      ['code/dsh-service/install-split.sh', '#!/bin/sh\nexit 0\n'],
      ['code/wireguard/install-control-service.sh', '#!/bin/sh\nexit 0\n'],
      ['install-interop-service.sh', '#!/bin/sh\nexit 0\n'],
    ]) {
      await writeFile(path.join(stage, file), body, 'utf8')
      await chmod(path.join(stage, file), 0o755)
    }
    await mkdir(path.join(stage, 'code', 'deploy'), { recursive: true })
    await cp(path.join(root, 'code', 'deploy', 'wire-profile.mjs'), path.join(stage, 'code', 'deploy', 'wire-profile.mjs'))

    const { spawnSync } = await import('node:child_process')
    const result = spawnSync('bash', [path.join(root, 'code', 'deploy', 'upgrade-local.sh'),
      '--app-root', install,
      '--stage', stage,
      '--dsh-home', home,
      '--port', '18099',
    ], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const marker = JSON.parse(await readFile(path.join(install, 'data', 'upgrade-pending.json'), 'utf8'))
    assert.equal(marker.status, 'pending')
    assert.equal(marker.layout, 'flat')
    assert.equal(marker.from, '0.0.1')
    assert.equal(marker.to, '0.0.2')
    assert.equal(marker.root, install)
    assert.equal(marker.dshHome, home)
    assert.match(marker.backup, /\.upgrade-backup\//u)
    assert.equal(marker.port, 18099)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the flat rollback script restores the backup, restarts, and clears the marker', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-rollback-flat-'))
  try {
    const install = path.join(dir, 'install')
    const home = path.join(install, 'home')
    const data = path.join(install, 'data')
    const backup = path.join(install, '.upgrade-backup', '20261116-000000')
    const bin = await stubBin(dir)
    await mkdir(path.join(install, 'gate'), { recursive: true })
    await mkdir(path.join(install, 'plugins', 'dsh-mesh'), { recursive: true })
    await mkdir(path.join(install, 'config'), { recursive: true })
    await mkdir(path.join(install, 'runtime', 'node', 'bin'), { recursive: true })
    await mkdir(data, { recursive: true })
    await mkdir(home, { recursive: true })
    await symlink(process.execPath, path.join(install, 'runtime', 'node', 'bin', 'node'))
    await writeFile(path.join(install, 'gate', 'server.mjs'), '// new gate\n', 'utf8')
    await writeFile(path.join(install, 'plugins', 'dsh-mesh', 'index.js'), '// new plugin\n', 'utf8')
    await writeFile(path.join(install, 'config', 'gate.env'), 'DSH_GATE_PORT=18099\nDSH_HOME=/new/home\n', 'utf8')
    await writeFile(path.join(install, 'manifest.json'), '{"version":"0.2.2-rc.5"}\n', 'utf8')

    await mkdir(path.join(backup, 'gate'), { recursive: true })
    await mkdir(path.join(backup, 'plugins', 'dsh-mesh'), { recursive: true })
    await mkdir(path.join(backup, 'config'), { recursive: true })
    await writeFile(path.join(backup, 'gate', 'server.mjs'), '// old gate\n', 'utf8')
    await writeFile(path.join(backup, 'plugins', 'dsh-mesh', 'index.js'), '// old plugin\n', 'utf8')
    await writeFile(path.join(backup, 'config', 'gate.env'), 'DSH_GATE_PORT=18099\nDSH_HOME=/old/home\n', 'utf8')
    await writeFile(path.join(backup, 'manifest.json'), '{"version":"0.2.2-rc.4"}\n', 'utf8')
    await writeFile(path.join(backup, 'profile-package.json'), '{"old":true}\n', 'utf8')
    await writeFile(path.join(backup, 'profile-cordis.patch.yml'), '# old patch\n', 'utf8')

    await writeFile(path.join(data, 'upgrade-pending.json'), `${JSON.stringify({
      format: 1,
      status: 'pending',
      layout: 'flat',
      root: install,
      backup,
      previous: null,
      from: '0.2.2-rc.4',
      to: '0.2.2-rc.5',
      port: 18099,
      dshHome: home,
    })}\n`, 'utf8')

    const { spawnSync } = await import('node:child_process')
    const result = spawnSync('bash', [rollbackScript, '--root', install], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(await readFile(path.join(install, 'gate', 'server.mjs'), 'utf8'), '// old gate\n')
    assert.equal(await readFile(path.join(install, 'plugins', 'dsh-mesh', 'index.js'), 'utf8'), '// old plugin\n')
    assert.equal(await readFile(path.join(home, 'profiles', 'web', 'package.json'), 'utf8'), '{"old":true}\n')
    await assert.rejects(readFile(path.join(data, 'upgrade-pending.json'), 'utf8'), /ENOENT/u)
    const log = await readFile(path.join(data, 'upgrade-rollback.log'), 'utf8')
    assert.match(log, /回退完成/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a successful blue-green activation arms the acceptance page for the new release', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-upgrade-bg-'))
  try {
    const root = path.join(dir, 'app')
    const oldRelease = path.join(root, 'releases', 'r1')
    // `skipPackage` uses the fixed release name `rollback`; the activate
    // script's NEW path must be that real directory, not an arbitrary one.
    const newRelease = path.join(root, 'releases', 'rollback')
    const shared = path.join(root, 'shared')
    const bin = await stubBin(dir)
    await mkdir(path.join(newRelease, 'gate'), { recursive: true })
    await mkdir(path.join(newRelease, 'runtime', 'node', 'bin'), { recursive: true })
    await mkdir(path.join(shared, 'config'), { recursive: true })
    await mkdir(path.join(shared, 'data'), { recursive: true })
    await mkdir(path.join(shared, 'home'), { recursive: true })
    await mkdir(oldRelease, { recursive: true })
    await symlink(process.execPath, path.join(newRelease, 'runtime', 'node', 'bin', 'node'))
    await symlink(oldRelease, path.join(root, 'current'))
    await writeFile(path.join(shared, 'config', 'gate.env'), 'DSH_GATE_PORT=18099\n', 'utf8')
    await writeFile(path.join(oldRelease, 'manifest.json'), '{"version":"0.2.2-rc.4"}\n', 'utf8')
    await writeFile(path.join(newRelease, 'manifest.json'), '{"version":"0.2.2-rc.5"}\n', 'utf8')
    await writeFile(path.join(newRelease, 'gate', 'server.mjs'), '// __gate/fallback\n', 'utf8')

    const plan = await buildDeployPlan({
      host: 'example', os: 'linux', skipPackage: true, release: 'rollback', appRoot: root,
      services: [
        { name: 'dsh-web-app.service', role: 'dsh' },
        { name: 'dsh-web-gate.service', role: 'gate' },
      ],
    })
    const script = path.join(dir, 'activate.sh')
    await writeFile(script, buildLinuxActivateScript(plan))
    const { spawnSync } = await import('node:child_process')
    const result = spawnSync('bash', [script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const marker = JSON.parse(await readFile(path.join(shared, 'data', 'upgrade-pending.json'), 'utf8'))
    assert.equal(marker.status, 'pending')
    assert.equal(marker.layout, 'bluegreen')
    assert.equal(marker.previous, oldRelease)
    assert.equal(marker.release, newRelease)
    assert.equal(marker.from, '0.2.2-rc.4')
    assert.equal(marker.to, '0.2.2-rc.5')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the blue-green rollback script switches current back and clears the marker', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-rollback-bg-'))
  try {
    const install = path.join(dir, 'install')
    const oldRelease = path.join(install, 'releases', 'old')
    const newRelease = path.join(install, 'releases', 'new')
    const shared = path.join(install, 'shared')
    const bin = await stubBin(dir)
    await mkdir(path.join(newRelease, 'runtime', 'node', 'bin'), { recursive: true })
    await mkdir(path.join(shared, 'config'), { recursive: true })
    await mkdir(path.join(shared, 'data'), { recursive: true })
    await mkdir(path.join(oldRelease), { recursive: true })
    await symlink(process.execPath, path.join(newRelease, 'runtime', 'node', 'bin', 'node'))
    await symlink(newRelease, path.join(install, 'current'))
    await writeFile(path.join(shared, 'config', 'gate.env'), 'DSH_GATE_PORT=18099\nDSH_HOME=/old/home\n', 'utf8')
    await writeFile(path.join(oldRelease, 'manifest.json'), '{"version":"0.2.2-rc.4"}\n', 'utf8')
    await writeFile(path.join(shared, 'data', 'upgrade-pending.json'), `${JSON.stringify({
      format: 1,
      status: 'pending',
      layout: 'bluegreen',
      root: install,
      release: newRelease,
      previous: oldRelease,
      from: '0.2.2-rc.4',
      to: '0.2.2-rc.5',
      port: 18099,
      dshHome: path.join(shared, 'home'),
    })}\n`, 'utf8')

    const { spawnSync } = await import('node:child_process')
    const result = spawnSync('bash', [rollbackScript, '--root', install], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(await readFile(path.join(install, 'current', 'manifest.json'), 'utf8'), '{"version":"0.2.2-rc.4"}\n')
    await assert.rejects(readFile(path.join(shared, 'data', 'upgrade-pending.json'), 'utf8'), /ENOENT/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
