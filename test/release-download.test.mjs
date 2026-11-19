import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

const SCRIPT = path.resolve(import.meta.dirname, '..', 'code', 'deploy', 'release-download.mjs')

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Serve a manifest and its archive. The proxy counter lets a test prove the
 * download actually went through the proxy rather than direct.
 */
async function startFixture() {
  const archive = Buffer.alloc(2 * 1024 * 1024)
  for (let index = 0; index < archive.length; index += 1) archive[index] = index % 251
  const partSize = 700 * 1024
  const parts = []
  for (let start = 0; start < archive.length; start += partSize) {
    parts.push(archive.subarray(start, Math.min(archive.length, start + partSize)))
  }
  const digest = sha256(archive)
  const requests = []
  const server = http.createServer((request, response) => {
    requests.push(request.url)
    if (request.url === '/latest-github.json') {
      const body = JSON.stringify({
        format: 1,
        assets: {
          'linux-x64': {
            archive: 'pkg.tar.gz',
            bytes: archive.length,
            sha256: digest,
            github: { url: `http://127.0.0.1:${server.address().port}/archive`, bytes: archive.length },
            gitee: null,
          },
        },
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body)
      return
    }
    if (request.url === '/latest-gitee.json') {
      const body = JSON.stringify({
        format: 1,
        assets: {
          'linux-x64': {
            archive: 'pkg.tar.gz',
            bytes: archive.length,
            sha256: digest,
            github: null,
            gitee: {
              partBytes: partSize,
              parts: parts.map((part, index) => ({ name: `pkg.tar.gz.part${String(index + 1).padStart(3, '0')}`, bytes: part.length, sha256: sha256(part) })),
              urls: parts.map((_part, index) => `http://127.0.0.1:${server.address().port}/part${String(index + 1)}`),
            },
          },
        },
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body)
      return
    }
    if (request.url === '/archive') {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(archive.length) })
      response.end(archive)
      return
    }
    const part = /^\/part(\d+)$/u.exec(request.url)
    if (part !== null) {
      const index = Number.parseInt(part[1], 10) - 1
      const body = parts[index]
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) })
      response.end(body)
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, archive, parts, digest, requests, port: server.address().port }
}

/**
 * One HTTP forward proxy for the tests (absolute-URI form).
 */
async function startProxy() {
  let hits = 0
  const server = http.createServer((request, response) => {
    hits += 1
    const target = new URL(request.url)
    const upstream = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: request.method,
      headers: request.headers,
    }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(response)
    })
    upstream.once('error', () => {
      response.writeHead(502)
      response.end('proxy error')
    })
    request.pipe(upstream)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, hits: () => hits }
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('exit', code => resolve({ code, stdout, stderr }))
  })
}

test('release download fetches the whole archive from GitHub', async () => {
  const fixture = await startFixture()
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-release-download-'))
  try {
    const output = path.join(dir, 'pkg.tar.gz')
    const result = await run([
      '--manifest-github', `http://127.0.0.1:${fixture.port}/latest-github.json`,
      '--archive', 'pkg.tar.gz',
      '--sha256', fixture.digest,
      '--output', output,
    ])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(sha256(await readFile(output)), fixture.digest)
    assert.match(result.stdout, /DSH-MESH-DOWNLOAD-DONE/u)
  } finally {
    fixture.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('release download reassembles Gitee parts and verifies the archive', async () => {
  const fixture = await startFixture()
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-release-parts-'))
  try {
    const output = path.join(dir, 'pkg.tar.gz')
    const result = await run([
      '--manifest-gitee', `http://127.0.0.1:${fixture.port}/latest-gitee.json`,
      '--archive', 'pkg.tar.gz',
      '--sha256', fixture.digest,
      '--output', output,
    ])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(sha256(await readFile(output)), fixture.digest)
    assert.match(result.stdout, /DSH-MESH-DOWNLOAD-PART 3\/3/u)
  } finally {
    fixture.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('release download goes through the configured HTTP proxy', async () => {
  const fixture = await startFixture()
  const proxy = await startProxy()
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-release-proxy-'))
  try {
    const output = path.join(dir, 'pkg.tar.gz')
    const result = await run([
      '--manifest-github', `http://127.0.0.1:${fixture.port}/latest-github.json`,
      '--archive', 'pkg.tar.gz',
      '--sha256', fixture.digest,
      '--output', output,
      '--proxy', `http://127.0.0.1:${proxy.port}`,
    ])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(sha256(await readFile(output)), fixture.digest)
    assert.ok(proxy.hits() >= 2, `expected the manifest and archive to pass through the proxy, saw ${String(proxy.hits())}`)
  } finally {
    fixture.server.close()
    proxy.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Gitee downloads ignore the proxy even when one is configured', async () => {
  const fixture = await startFixture()
  const proxy = await startProxy()
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-release-gitee-direct-'))
  try {
    const output = path.join(dir, 'pkg.tar.gz')
    const result = await run([
      '--manifest-gitee', `http://127.0.0.1:${fixture.port}/latest-gitee.json`,
      '--archive', 'pkg.tar.gz',
      '--sha256', fixture.digest,
      '--output', output,
      '--proxy', `http://127.0.0.1:${proxy.port}`,
    ])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(sha256(await readFile(output)), fixture.digest)
    assert.equal(proxy.hits(), 0, 'Gitee must not go through the egress proxy')
  } finally {
    fixture.server.close()
    proxy.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('release download refuses a package the release does not carry', async () => {
  const fixture = await startFixture()
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-release-missing-'))
  try {
    const result = await run([
      '--manifest-github', `http://127.0.0.1:${fixture.port}/latest-github.json`,
      '--archive', 'other.tar.gz',
      '--output', path.join(dir, 'other.tar.gz'),
    ])
    assert.equal(result.code, 3)
    assert.match(result.stderr, /does not offer/u)
  } finally {
    fixture.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('release download fails verification with a wrong digest', async () => {
  const fixture = await startFixture()
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-release-badsha-'))
  try {
    const output = path.join(dir, 'pkg.tar.gz')
    const result = await run([
      '--manifest-github', `http://127.0.0.1:${fixture.port}/latest-github.json`,
      '--archive', 'pkg.tar.gz',
      '--sha256', '0'.repeat(64),
      '--output', output,
    ])
    assert.equal(result.code, 3)
  } finally {
    fixture.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('release download reuses an already verified file', async () => {
  const fixture = await startFixture()
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-release-reuse-'))
  try {
    const output = path.join(dir, 'pkg.tar.gz')
    await writeFile(output, fixture.archive)
    const result = await run([
      '--manifest-github', `http://127.0.0.1:${fixture.port}/latest-github.json`,
      '--archive', 'pkg.tar.gz',
      '--sha256', fixture.digest,
      '--output', output,
    ])
    assert.equal(result.code, 0, result.stderr)
    assert.ok(!fixture.requests.includes('/archive'), 'the archive should not be fetched again')
  } finally {
    fixture.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('release download prefers Gitee when both providers are offered', async () => {
  const fixture = await startFixture()
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-release-prefer-gitee-'))
  try {
    const output = path.join(dir, 'pkg.tar.gz')
    const result = await run([
      '--manifest-gitee', `http://127.0.0.1:${fixture.port}/latest-gitee.json`,
      '--manifest-github', `http://127.0.0.1:${fixture.port}/latest-github.json`,
      '--archive', 'pkg.tar.gz',
      '--sha256', fixture.digest,
      '--output', output,
      '--prefer', 'gitee',
    ])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(sha256(await readFile(output)), fixture.digest)
    assert.match(result.stdout, /DSH-MESH-DOWNLOAD-SOURCE gitee/u)
    assert.ok(fixture.requests.some(url => url.startsWith('/part')), 'the Gitee parts should be fetched first')
    assert.equal(fixture.requests.includes('/archive'), false, 'GitHub must not be used when Gitee works')
  } finally {
    fixture.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('release download falls back to GitHub when the preferred Gitee manifest is missing', async () => {
  const fixture = await startFixture()
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-release-prefer-fallback-'))
  try {
    const output = path.join(dir, 'pkg.tar.gz')
    const result = await run([
      '--manifest-gitee', `http://127.0.0.1:${fixture.port}/latest-missing.json`,
      '--manifest-github', `http://127.0.0.1:${fixture.port}/latest-github.json`,
      '--archive', 'pkg.tar.gz',
      '--sha256', fixture.digest,
      '--output', output,
      '--prefer', 'gitee',
    ])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(sha256(await readFile(output)), fixture.digest)
    assert.match(result.stdout, /DSH-MESH-DOWNLOAD-SOURCE github/u)
  } finally {
    fixture.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
