import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PackageUploads, isMeshPeer, packageName } from '../code/gate/packages.mjs'

test('packageName accepts archives and rejects paths', () => {
  assert.equal(packageName('dsh-mesh-0.2.2-linux-x64.tar.gz'), 'dsh-mesh-0.2.2-linux-x64.tar.gz')
  assert.equal(packageName('x.zip'), 'x.zip')
  assert.throws(() => packageName('../evil.zip'), /plain file name/u)
  assert.throws(() => packageName('a/b.zip'), /plain file name/u)
  assert.throws(() => packageName('notes.txt'), /end in/u)
  assert.throws(() => packageName(''), /plain file name/u)
})

test('isMeshPeer limits uploads to the VPN and loopback', () => {
  assert.equal(isMeshPeer('10.66.66.2', ['10.66.66.']), true)
  assert.equal(isMeshPeer('::ffff:10.66.66.3', ['10.66.66.']), true)
  assert.equal(isMeshPeer('127.0.0.1', ['10.66.66.']), true)
  assert.equal(isMeshPeer('8.140.245.107', ['10.66.66.']), false)
})

/**
 * Start the upload service on a loopback port.
 * @param {{password: string, packagesDir: string}} options options.
 * @returns {Promise<{url: string, close: () => Promise<void>}>} server.
 */
async function serve(options) {
  const service = new PackageUploads(options)
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://gate.invalid')
    void service.handle(request, response, url).then((handled) => {
      if (!handled) {
        response.writeHead(404)
        response.end()
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

test('upload stores an archive with its checksum', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-upload-'))
  const payload = Buffer.from('package bytes')
  const digest = createHash('sha256').update(payload).digest('hex')
  const server = await serve({ password: 'secret', packagesDir: dir })
  try {
    const response = await fetch(`${server.url}/__gate/packages/upload?name=demo-linux-x64.tar.gz&sha256=${digest}`, {
      method: 'POST',
      headers: { 'x-dsh-gate-token': 'secret', 'content-type': 'application/octet-stream' },
      body: payload,
    })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.bytes, payload.length)
    assert.equal(await readFile(path.join(dir, 'demo-linux-x64.tar.gz'), 'utf8'), 'package bytes')
    assert.match(await readFile(path.join(dir, 'demo-linux-x64.tar.gz.sha256'), 'utf8'), new RegExp(digest, 'u'))
    const listed = await fetch(`${server.url}/__gate/packages`).then(body => body.json())
    assert.equal(listed.packages[0].name, 'demo-linux-x64.tar.gz')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('upload requires the gate password and a matching checksum', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-upload-'))
  const server = await serve({ password: 'secret', packagesDir: dir })
  try {
    const unauthorized = await fetch(`${server.url}/__gate/packages/upload?name=a.zip`, { method: 'POST', body: 'x' })
    assert.equal(unauthorized.status, 401)
    const wrongHash = await fetch(`${server.url}/__gate/packages/upload?name=a.zip&sha256=${'0'.repeat(64)}`, {
      method: 'POST',
      headers: { 'x-dsh-gate-token': 'secret' },
      body: 'x',
    })
    assert.equal(wrongHash.status, 400)
    await assert.rejects(stat(path.join(dir, 'a.zip')))
    // No partial file is left behind after a failed upload.
    const leftovers = (await import('node:fs/promises')).readdir(dir)
    assert.deepEqual(await leftovers, [])
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
