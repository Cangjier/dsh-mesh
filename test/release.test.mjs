import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildLatestManifest,
  detectReleaseOwner,
  latestManifestUrls,
  loadReleaseConfig,
  publishRelease,
  sanitizeReleaseConfig,
  saveReleaseConfig,
  splitArchive,
} from '../code/shared/release.mjs'

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.once('end', () => resolve(Buffer.concat(chunks)))
    request.once('error', reject)
  })
}

/**
 * A fake GitHub + Gitee API that stores releases and attachments in memory.
 * `events` records the order of uploads and deletions so the test can prove
 * "new assets first, old assets afterwards" and "latest.json last".
 */
async function startFakeProviders() {
  const releases = new Map()
  const events = []
  // Repositories that already exist. The publish path now checks (and, when
  // missing, creates) the repository before it touches a release.
  // Gitee's create endpoint makes new repositories private even when the body
  // says `private: false` (verified against the v5 API), so the fake does the
  // same: only the explicit PATCH can make a fresh repository public.
  const repos = new Map([['github:o/r', { private: false }], ['gitee:o/r', { private: false }]])
  let nextId = 1
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://local.invalid')
    const body = await readBody(request)
    const json = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    const keyOf = (provider, tag) => `${provider}:${tag}`
    // --- GitHub ---
    let match = /^\/github\/api\/user$/u.exec(url.pathname)
    if (match !== null && request.method === 'GET') return json(200, { login: 'tester' })
    match = /^\/github\/api\/repos\/([^/]+)\/([^/]+)$/u.exec(url.pathname)
    if (match !== null && request.method === 'GET') {
      const repo = repos.get(`github:${match[1]}/${match[2]}`)
      return repo === undefined
        ? json(404, { message: 'Not Found' })
        : json(200, { full_name: `${match[1]}/${match[2]}`, private: repo.private, default_branch: 'main' })
    }
    match = /^\/github\/api\/user\/repos$/u.exec(url.pathname)
    if (match !== null && request.method === 'POST') {
      const input = JSON.parse(body.toString('utf8'))
      repos.set(`github:tester/${input.name}`, { private: input.private === true })
      events.push(`github:repo:create:${input.name}`)
      return json(201, { name: input.name, full_name: `tester/${input.name}` })
    }
    match = /^\/github\/api\/orgs\/([^/]+)\/repos$/u.exec(url.pathname)
    if (match !== null && request.method === 'POST') {
      const input = JSON.parse(body.toString('utf8'))
      repos.set(`github:${match[1]}/${input.name}`, { private: input.private === true })
      events.push(`github:repo:create:${match[1]}/${input.name}`)
      return json(201, { name: input.name, full_name: `${match[1]}/${input.name}` })
    }
    match = /^\/github\/api\/repos\/([^/]+)\/([^/]+)\/releases\/tags\/([^/]+)$/u.exec(url.pathname)
    if (match !== null && request.method === 'GET') {
      const release = releases.get(keyOf('github', match[3]))
      if (release === undefined) return json(404, { message: 'Not Found' })
      return json(200, { id: release.id, tag_name: release.tag, assets: release.assets.map(asset => ({ id: asset.id, name: asset.name, size: asset.bytes, browser_download_url: `${base}/github/web/${asset.name}` })) })
    }
    match = /^\/github\/api\/repos\/([^/]+)\/([^/]+)\/releases$/u.exec(url.pathname)
    if (match !== null && request.method === 'POST') {
      const input = JSON.parse(body.toString('utf8'))
      const release = { id: nextId++, tag: input.tag_name, assets: [] }
      releases.set(keyOf('github', input.tag_name), release)
      events.push(`github:create:${input.tag_name}`)
      return json(201, { id: release.id, tag_name: release.tag, assets: [] })
    }
    match = /^\/github\/api\/repos\/([^/]+)\/([^/]+)\/releases\/(\d+)\/assets$/u.exec(url.pathname)
    if (match !== null && request.method === 'GET') {
      const release = [...releases.values()].find(candidate => String(candidate.id) === match[3])
      return json(200, release === undefined ? [] : release.assets.map(asset => ({ id: asset.id, name: asset.name, size: asset.bytes, browser_download_url: `${base}/github/web/${asset.name}` })))
    }
    match = /^\/github\/upload\/repos\/([^/]+)\/([^/]+)\/releases\/(\d+)\/assets$/u.exec(url.pathname)
    if (match !== null && request.method === 'POST') {
      const release = [...releases.values()].find(candidate => String(candidate.id) === match[3])
      const name = url.searchParams.get('name')
      const asset = { id: nextId++, name, bytes: body.length, data: body }
      // An upload of the same name replaces the old asset.
      release.assets = release.assets.filter(candidate => candidate.name !== name)
      release.assets.push(asset)
      events.push(`github:upload:${name}`)
      return json(201, { id: asset.id, name, size: asset.bytes })
    }
    match = /^\/github\/api\/repos\/([^/]+)\/([^/]+)\/releases\/assets\/(\d+)$/u.exec(url.pathname)
    if (match !== null && request.method === 'DELETE') {
      for (const release of releases.values()) {
        const asset = release.assets.find(candidate => String(candidate.id) === match[3])
        if (asset !== undefined) {
          release.assets = release.assets.filter(candidate => candidate !== asset)
          events.push(`github:delete:${asset.name}`)
          response.writeHead(204)
          return response.end()
        }
      }
      response.writeHead(404)
      return response.end()
    }
    // --- Gitee ---
    match = /^\/gitee\/api\/user$/u.exec(url.pathname)
    if (match !== null && request.method === 'GET') return json(200, { login: 'tester' })
    match = /^\/gitee\/api\/repos\/([^/]+)\/([^/]+)$/u.exec(url.pathname)
    if (match !== null && request.method === 'GET') {
      const repo = repos.get(`gitee:${match[1]}/${match[2]}`)
      return repo === undefined
        ? json(404, { message: 'Not Found' })
        : json(200, { full_name: `${match[1]}/${match[2]}`, private: repo.private, default_branch: 'master' })
    }
    if (match !== null && request.method === 'PATCH') {
      const repo = repos.get(`gitee:${match[1]}/${match[2]}`)
      if (repo === undefined) return json(404, { message: 'Not Found' })
      const input = JSON.parse(body.toString('utf8'))
      // Real Gitee rejects a PATCH without a name.
      if (typeof input.name !== 'string' || input.name === '') return json(400, { messages: ['name is missing'] })
      if (typeof input.private === 'boolean') repo.private = input.private
      events.push(`gitee:repo:patch:${match[2]}:${repo.private ? 'private' : 'public'}`)
      return json(200, { full_name: `${match[1]}/${match[2]}`, private: repo.private })
    }
    match = /^\/gitee\/api\/user\/repos$/u.exec(url.pathname)
    if (match !== null && request.method === 'POST') {
      const input = JSON.parse(body.toString('utf8'))
      // Like Gitee: the create endpoint ignores private:false.
      repos.set(`gitee:tester/${input.name}`, { private: true })
      events.push(`gitee:repo:create:${input.name}`)
      return json(201, { full_name: `tester/${input.name}`, private: true, default_branch: 'master' })
    }
    match = /^\/gitee\/api\/repos\/([^/]+)\/([^/]+)\/releases\/tags\/([^/]+)$/u.exec(url.pathname)
    if (match !== null && request.method === 'GET') {
      const release = releases.get(keyOf('gitee', match[3]))
      // Real Gitee answers a missing tag with HTTP 200 and a literal `null`
      // body (verified against openplugin/dsh-web-release). The first publish
      // to a fresh repository has to treat that as "create it", not an error.
      if (release === undefined) return json(200, null)
      return json(200, { id: release.id, tag_name: release.tag, html_url: `${base}/gitee/web/tag/${release.tag}` })
    }
    match = /^\/gitee\/api\/repos\/([^/]+)\/([^/]+)\/releases$/u.exec(url.pathname)
    if (match !== null && request.method === 'POST') {
      const input = JSON.parse(body.toString('utf8'))
      // Like Gitee: a tag can only point at a branch that exists.
      if (input.target_commitish !== 'master') return json(400, { message: `branch ${input.target_commitish} not found` })
      const release = { id: nextId++, tag: input.tag_name, assets: [] }
      releases.set(keyOf('gitee', input.tag_name), release)
      events.push(`gitee:create:${input.tag_name}@${input.target_commitish}`)
      return json(201, { id: release.id, tag_name: release.tag, html_url: `${base}/gitee/web/tag/${release.tag}` })
    }
    match = /^\/gitee\/api\/repos\/([^/]+)\/([^/]+)\/releases\/(\d+)\/attach_files$/u.exec(url.pathname)
    if (match !== null && request.method === 'GET') {
      const release = [...releases.values()].find(candidate => String(candidate.id) === match[3])
      return json(200, release === undefined ? [] : release.assets.map(asset => ({ id: asset.id, name: asset.name, size: asset.bytes, browser_download_url: `${base}/gitee/web/${asset.name}` })))
    }
    if (match !== null && request.method === 'POST') {
      const release = [...releases.values()].find(candidate => String(candidate.id) === match[3])
      const text = body.toString('binary')
      const name = /filename="([^"]+)"/u.exec(text)?.[1] ?? 'unknown'
      const start = text.indexOf('\r\n\r\n') + 4
      const end = text.lastIndexOf('\r\n--')
      const data = body.subarray(start, end)
      const asset = { id: nextId++, name, bytes: data.length, data }
      release.assets = release.assets.filter(candidate => candidate.name !== name)
      release.assets.push(asset)
      events.push(`gitee:upload:${name}`)
      return json(201, { id: asset.id, name, browser_download_url: `${base}/gitee/web/${name}` })
    }
    match = /^\/gitee\/api\/repos\/([^/]+)\/([^/]+)\/releases\/(\d+)\/attach_files\/(\d+)$/u.exec(url.pathname)
    if (match !== null && request.method === 'DELETE') {
      for (const release of releases.values()) {
        const asset = release.assets.find(candidate => String(candidate.id) === match[4])
        if (asset !== undefined) {
          release.assets = release.assets.filter(candidate => candidate !== asset)
          events.push(`gitee:delete:${asset.name}`)
          response.writeHead(204)
          return response.end()
        }
      }
      response.writeHead(404)
      return response.end()
    }
    response.writeHead(404)
    response.end('not found')
  })
  let base = ''
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  return { server, releases, repos, events, base }
}

test('splitArchive produces byte ranges that concatenate to the original', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-release-split-'))
  try {
    const archive = Buffer.alloc(3 * 1024 * 1024 + 7)
    for (let index = 0; index < archive.length; index += 1) archive[index] = index % 251
    const file = path.join(dir, 'pkg.tar.gz')
    await writeFile(file, archive)
    const split = await splitArchive(file, { partBytes: 1024 * 1024, dir: path.join(dir, 'parts') })
    assert.equal(split.parts.length, 4)
    const joined = Buffer.concat(await Promise.all(split.parts.map(part => readFile(part.path))))
    assert.equal(sha256(joined), sha256(archive))
    assert.equal(split.parts[0].name, 'pkg.tar.gz.part001')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('latest manifest carries GitHub and Gitee download information', async () => {
  const artifacts = [{
    target: 'linux-x64',
    archive: '/tmp/dsh-mesh-1.0-linux-x64.tar.gz',
    bytes: 200,
    sha256: 'a'.repeat(64),
    manifest: { version: '1.0', buildStamp: '20261118A', source: 'src', ref: 'main', builtAt: '2026-11-18T00:00:00.000Z' },
  }]
  const config = {
    enabled: true,
    tag: 'latest',
    partBytes: 90,
    github: { owner: 'o', repo: 'r', enabled: true, token: 't' },
    gitee: { owner: 'o', repo: 'r', enabled: true, token: 't' },
  }
  const partResults = {
    'linux-x64': [{ name: 'dsh-mesh-1.0-linux-x64.tar.gz.part001', bytes: 100, sha256: 'b'.repeat(64), url: 'https://gitee.example/part001' }],
  }
  const manifest = buildLatestManifest({ artifacts, config, partResults, publishedAt: '2026-11-18T01:00:00.000Z' })
  assert.equal(manifest.version, '1.0')
  assert.equal(manifest.assets['linux-x64'].github.url, 'https://github.com/o/r/releases/download/latest/dsh-mesh-1.0-linux-x64.tar.gz')
  assert.deepEqual(manifest.assets['linux-x64'].gitee.urls, ['https://gitee.example/part001'])
  assert.deepEqual(latestManifestUrls(config), [
    'https://github.com/o/r/releases/download/latest/latest.json',
    'https://gitee.com/o/r/releases/download/latest/latest.json',
  ])
})

test('release config round-trips tokens without exposing them', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-release-config-'))
  try {
    const file = path.join(dir, 'release.json')
    const saved = await saveReleaseConfig({
      file,
      input: {
        enabled: true,
        tag: 'latest',
        partBytes: 80 * 1024 * 1024,
        github: { owner: 'o', repo: 'r', token: 'gh-token' },
        gitee: { owner: 'o', repo: 'r', token: 'gitee-token', branch: 'main' },
      },
    })
    assert.equal(saved.github.enabled, true)
    assert.equal(saved.gitee.enabled, true)
    const sanitized = sanitizeReleaseConfig(saved)
    assert.equal(sanitized.github.hasToken, true)
    assert.equal('token' in sanitized.github, false)
    const mode = (await import('node:fs/promises')).stat(file).then(info => info.mode & 0o777)
    assert.equal(await mode, 0o600)
    // An empty token keeps the stored one.
    const again = await saveReleaseConfig({ file, input: { github: { owner: 'o2', repo: 'r2', token: '' } } })
    assert.equal(again.github.token, 'gh-token')
    assert.equal(again.github.owner, 'o2')
    const loaded = await loadReleaseConfig({ file, env: {} })
    assert.equal(loaded.gitee.token, 'gitee-token')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/** A tiny forwarding HTTP proxy; records every absolute URI it sees. */
async function startProxy() {
  const seen = []
  const server = http.createServer((request, response) => {
    seen.push(request.url)
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
  return { server, port: server.address().port, seen }
}

test('publishing proxies GitHub only, never Gitee', async () => {
  const fake = await startFakeProviders()
  const proxy = await startProxy()
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-release-proxy-publish-'))
  try {
    const archive = path.join(dir, 'dsh-mesh-1.0-20261118A-linux-x64.tar.gz')
    await writeFile(archive, Buffer.alloc(1024 * 1024 + 11, 9))
    const config = {
      enabled: true,
      tag: 'latest',
      partBytes: 1024 * 1024,
      github: {
        owner: 'o', repo: 'r', token: 'gh', enabled: true,
        apiBase: `${fake.base}/github/api`, uploadBase: `${fake.base}/github/upload`, webBase: `${fake.base}/github/web`,
      },
      gitee: {
        owner: 'o', repo: 'r', token: 'gt', enabled: true, branch: 'main',
        apiBase: `${fake.base}/gitee/api`, webBase: `${fake.base}/gitee/web`,
      },
    }
    const result = await publishRelease({
      artifacts: [{ target: 'linux-x64', archive, manifest: { version: '1.0', buildStamp: '20261118A' } }],
      config,
      proxy: `http://127.0.0.1:${proxy.port}`,
      log: () => {},
    })
    assert.equal(result.status, 'done', JSON.stringify(result))
    const proxied = proxy.seen.map(url => new URL(url).pathname)
    assert.ok(proxied.some(path => path.startsWith('/github/')), `GitHub requests must use the proxy, saw ${proxied.join(', ')}`)
    assert.equal(proxied.some(path => path.startsWith('/gitee/')), false, `Gitee requests must bypass the proxy, saw ${proxied.join(', ')}`)
  } finally {
    fake.server.close()
    proxy.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('publishRelease writes the newest assets and removes the previous revision', async () => {
  const fake = await startFakeProviders()
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-release-publish-'))
  try {
    const first = path.join(dir, 'dsh-mesh-1.0-20261118A-linux-x64.tar.gz')
    const second = path.join(dir, 'dsh-mesh-1.0-20261118A-win-x64.zip')
    await writeFile(first, Buffer.alloc(2 * 1024 * 1024 + 3, 1))
    await writeFile(second, Buffer.alloc(2 * 1024 * 1024 + 5, 2))
    const artifacts = [
      { target: 'linux-x64', archive: first, manifest: { version: '1.0', buildStamp: '20261118A' } },
      { target: 'win-x64', archive: second, manifest: { version: '1.0', buildStamp: '20261118A' } },
    ]
    const config = {
      enabled: true,
      tag: 'latest',
      partBytes: 1024 * 1024,
      github: {
        owner: 'o', repo: 'r', token: 'gh', enabled: true,
        apiBase: `${fake.base}/github/api`, uploadBase: `${fake.base}/github/upload`, webBase: `${fake.base}/github/web`,
      },
      gitee: {
        owner: 'o', repo: 'r', token: 'gt', enabled: true, branch: 'main',
        apiBase: `${fake.base}/gitee/api`, webBase: `${fake.base}/gitee/web`,
      },
    }
    // Seed old assets so the cleanup has something to delete.
    const githubRelease = { id: 100, tag: 'latest', assets: [{ id: 101, name: 'old.tar.gz', bytes: 1, data: Buffer.alloc(1) }] }
    const giteeRelease = { id: 200, tag: 'latest', assets: [{ id: 201, name: 'old.tar.gz.part001', bytes: 1, data: Buffer.alloc(1) }, { id: 202, name: 'latest.json', bytes: 1, data: Buffer.alloc(1) }] }
    fake.releases.set('github:latest', githubRelease)
    fake.releases.set('gitee:latest', giteeRelease)

    const result = await publishRelease({ artifacts, config, log: () => {} })
    assert.equal(result.status, 'done', JSON.stringify(result))
    assert.equal(result.github.status, 'done')
    assert.equal(result.gitee.status, 'done')

    const github = fake.releases.get('github:latest')
    const gitee = fake.releases.get('gitee:latest')
    const githubNames = github.assets.map(asset => asset.name).sort()
    const giteeNames = gitee.assets.map(asset => asset.name).sort()
    assert.deepEqual(githubNames, [
      'dsh-mesh-1.0-20261118A-linux-x64.tar.gz',
      'dsh-mesh-1.0-20261118A-win-x64.zip',
      'latest.json',
    ])
    assert.ok(giteeNames.includes('dsh-mesh-1.0-20261118A-linux-x64.tar.gz.part001'))
    assert.ok(giteeNames.includes('dsh-mesh-1.0-20261118A-win-x64.zip.part001'))
    assert.ok(giteeNames.includes('latest.json'))
    assert.ok(!giteeNames.includes('old.tar.gz.part001'))
    assert.ok(!githubNames.includes('old.tar.gz'))

    const manifest = JSON.parse(github.assets.find(asset => asset.name === 'latest.json').data.toString('utf8'))
    assert.equal(manifest.version, '1.0')
    assert.equal(manifest.assets['linux-x64'].github.url, `${fake.base}/github/web/o/r/releases/download/latest/dsh-mesh-1.0-20261118A-linux-x64.tar.gz`)
    assert.equal(manifest.assets['linux-x64'].gitee.parts.length, 3)
    assert.match(manifest.assets['linux-x64'].gitee.urls[0], /\/gitee\/web\//u)
    // The manifest is uploaded after the parts it names.
    assert.ok(fake.events.lastIndexOf('gitee:upload:latest.json') > fake.events.lastIndexOf('gitee:upload:dsh-mesh-1.0-20261118A-linux-x64.tar.gz.part003'))
    assert.ok(fake.events.indexOf('gitee:delete:old.tar.gz.part001') < fake.events.lastIndexOf('gitee:upload:dsh-mesh-1.0-20261118A-linux-x64.tar.gz.part001'))
    // Gitee parts carry the same bytes as the original archive.
    const parts = manifest.assets['linux-x64'].gitee
    const rebuilt = Buffer.concat(parts.parts.map(part => gitee.assets.find(asset => asset.name === part.name).data))
    assert.equal(sha256(rebuilt), sha256(await readFile(first)))
  } finally {
    fake.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a token-only config defaults to repo dsh-web-release and Gitee branch master', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-release-defaults-'))
  try {
    const file = path.join(dir, 'release.json')
    const fresh = await loadReleaseConfig({ file, env: {} })
    assert.equal(fresh.github.repo, 'dsh-web-release')
    assert.equal(fresh.gitee.repo, 'dsh-web-release')
    assert.equal(fresh.gitee.branch, 'master')
    assert.equal(fresh.github.enabled, false)
    assert.equal(fresh.gitee.enabled, false)

    const saved = await saveReleaseConfig({ file, input: { github: { token: 'ght' }, gitee: { token: 'gt' } } })
    assert.equal(saved.github.repo, 'dsh-web-release')
    assert.equal(saved.gitee.repo, 'dsh-web-release')
    assert.equal(saved.gitee.branch, 'master')
    // The owner stays empty until a token can name the account.
    assert.equal(saved.github.owner, '')
    assert.equal(saved.github.enabled, true)
    assert.equal(saved.gitee.enabled, true)
    assert.equal(saved.gitee.branch, 'master')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('publishing with a token only creates the missing repository and release', async () => {
  const fake = await startFakeProviders()
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-release-autorepo-'))
  try {
    const archive = path.join(dir, 'dsh-mesh-1.0-20261118A-linux-x64.tar.gz')
    await writeFile(archive, Buffer.alloc(64 * 1024 + 3, 7))
    const config = {
      enabled: true,
      tag: 'latest',
      partBytes: 1024 * 1024,
      github: {
        owner: '', repo: 'dsh-web-release', token: 'gh', enabled: true,
        apiBase: `${fake.base}/github/api`, uploadBase: `${fake.base}/github/upload`, webBase: `${fake.base}/github/web`,
      },
      gitee: {
        owner: '', repo: 'dsh-web-release', token: 'gt', enabled: true, branch: 'master',
        apiBase: `${fake.base}/gitee/api`, webBase: `${fake.base}/gitee/web`,
      },
    }
    const artifacts = [{ target: 'linux-x64', archive, manifest: { version: '1.0', buildStamp: '20261118A' } }]
    const result = await publishRelease({ artifacts, config, log: () => {} })
    assert.equal(result.status, 'done', JSON.stringify(result))
    assert.equal(result.github.created, true)
    assert.equal(result.gitee.created, true)
    // The owner came from the token, on both providers.
    assert.equal(config.github.owner, 'tester')
    assert.equal(config.gitee.owner, 'tester')
    assert.ok(fake.repos.has('github:tester/dsh-web-release'))
    assert.ok(fake.repos.has('gitee:tester/dsh-web-release'))
    // The create call leaves a fresh Gitee repository private; the publisher
    // must flip it explicitly or members cannot download the release.
    assert.equal(fake.repos.get('gitee:tester/dsh-web-release').private, false)
    assert.ok(
      fake.events.indexOf('gitee:repo:create:dsh-web-release') < fake.events.indexOf('gitee:repo:patch:dsh-web-release:public')
      && fake.events.indexOf('gitee:repo:patch:dsh-web-release:public') < fake.events.indexOf('gitee:create:latest@master'),
      'the repository is made public before the release is published',
    )
    // The repository exists before the release that lives in it.
    assert.ok(fake.events.indexOf('github:repo:create:dsh-web-release') < fake.events.indexOf('github:create:latest'))
    assert.ok(fake.events.indexOf('gitee:repo:create:dsh-web-release') < fake.events.indexOf('gitee:create:latest@master'))
    // The stored branch was `master`, so the tag used it directly.
    assert.equal(fake.events.filter(event => event === 'gitee:create:latest@master').length, 1)
    const manifest = JSON.parse(fake.releases.get('github:latest').assets.find(asset => asset.name === 'latest.json').data.toString('utf8'))
    assert.equal(
      manifest.assets['linux-x64'].github.url,
      `${fake.base}/github/web/tester/dsh-web-release/releases/download/latest/dsh-mesh-1.0-20261118A-linux-x64.tar.gz`,
    )

    // A second publish finds the repository and must not create it again.
    const again = await publishRelease({ artifacts, config, log: () => {} })
    assert.equal(again.status, 'done', JSON.stringify(again))
    assert.equal(again.github.created, false)
    assert.equal(again.gitee.created, false)
    assert.equal(fake.events.filter(event => event.startsWith('github:repo:create:')).length, 1)
    assert.equal(fake.events.filter(event => event.startsWith('gitee:repo:create:')).length, 1)
  } finally {
    fake.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a Gitee repository under another account is reported, never created', async () => {
  const fake = await startFakeProviders()
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-release-gitee-owner-'))
  try {
    const archive = path.join(dir, 'dsh-mesh-1.0-20261118A-linux-x64.tar.gz')
    await writeFile(archive, Buffer.alloc(4096, 3))
    const config = {
      enabled: true,
      tag: 'latest',
      partBytes: 1024 * 1024,
      github: { owner: '', repo: 'dsh-web-release', token: '', enabled: false },
      gitee: {
        owner: 'somebody', repo: 'dsh-web-release', token: 'gt', enabled: true, branch: 'master',
        apiBase: `${fake.base}/gitee/api`, webBase: `${fake.base}/gitee/web`,
      },
    }
    const result = await publishRelease({
      artifacts: [{ target: 'linux-x64', archive, manifest: { version: '1.0', buildStamp: '20261118A' } }],
      config,
      log: () => {},
    })
    assert.equal(result.status, 'failed')
    assert.equal(result.gitee.status, 'failed')
    assert.match(result.gitee.error, /不存在且自动创建失败/u)
    assert.match(result.gitee.error, /token 属于 tester/u)
    assert.equal(fake.events.some(event => event.startsWith('gitee:repo:create:')), false)
  } finally {
    fake.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('detectReleaseOwner names the account behind a token', async () => {
  const fake = await startFakeProviders()
  try {
    assert.equal(await detectReleaseOwner('github', { token: 't', apiBase: `${fake.base}/github/api` }), 'tester')
    assert.equal(await detectReleaseOwner('gitee', { token: 't', apiBase: `${fake.base}/gitee/api` }), 'tester')
    await assert.rejects(
      () => detectReleaseOwner('github', { token: 't', apiBase: `${fake.base}/github/missing` }),
      /无法用 token 识别账号/u,
    )
  } finally {
    fake.server.close()
  }
})

test('a stale Gitee branch falls back to the branch the repository reports', async () => {
  const fake = await startFakeProviders()
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-release-gitee-branch-'))
  try {
    const archive = path.join(dir, 'dsh-mesh-1.0-20261118A-linux-x64.tar.gz')
    await writeFile(archive, Buffer.alloc(4096, 5))
    const config = {
      enabled: true,
      tag: 'latest',
      partBytes: 1024 * 1024,
      github: { owner: '', repo: 'dsh-web-release', token: '', enabled: false },
      gitee: {
        owner: 'tester', repo: 'dsh-web-release', token: 'gt', enabled: true, branch: 'main',
        apiBase: `${fake.base}/gitee/api`, webBase: `${fake.base}/gitee/web`,
      },
    }
    const result = await publishRelease({
      artifacts: [{ target: 'linux-x64', archive, manifest: { version: '1.0', buildStamp: '20261118A' } }],
      config,
      log: () => {},
    })
    assert.equal(result.status, 'done', JSON.stringify(result))
    // The tag landed on the branch the repository actually reports.
    assert.ok(fake.events.includes('gitee:create:latest@master'))
  } finally {
    fake.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
