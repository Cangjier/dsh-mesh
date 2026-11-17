import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import {
  chromeForTestingPlatform,
  defaultChromeDownloadDir,
  ensureDownloadedChrome,
} from '../code/build/chrome-download.mjs'
import { extractZip } from '../code/build/zip.mjs'

/**
 * Create a temporary directory.
 * @returns {Promise<string>} directory.
 */
async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-chrome-test-'))
}

/**
 * Build a small ZIP archive in memory. CRC fields are left at zero because the
 * extractor verifies sizes and deflate integrity, not the CRC.
 * @param {Array<{name: string, data?: string|Buffer, method?: number, mode?: number}>} entries members.
 * @returns {Buffer} archive bytes.
 */
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8')
    const method = entry.method ?? 0
    const compressed = method === 8 ? deflateRawSync(data) : data
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const localRecord = Buffer.concat([local, name, compressed])
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(localRecord)
    centrals.push(Buffer.concat([central, name]))
    offset += localRecord.length
  }
  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, directory, eocd])
}

/**
 * Serve one manifest and one archive from an injected fetch.
 * @param {Buffer} archive zip bytes.
 * @param {{manifest?: object, archiveUrl?: string}} [options] fixture.
 * @returns {{fetchImpl: typeof fetch, calls: string[]}} mock fetch.
 */
function mockFetch(archive, options = {}) {
  const manifest = options.manifest ?? {
    channels: {
      Stable: {
        version: '999.0.1',
        downloads: {
          'chrome-headless-shell': [
            { platform: 'linux64', url: options.archiveUrl ?? 'https://example.test/chrome-headless-shell-linux64.zip' },
          ],
        },
      },
    },
  }
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    if (String(url).endsWith('.json')) {
      return new Response(JSON.stringify(manifest), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (String(url) === (options.archiveUrl ?? 'https://example.test/chrome-headless-shell-linux64.zip')) {
      return new Response(archive, { status: 200, headers: { 'content-length': String(archive.length) } })
    }
    return new Response('not found', { status: 404 })
  }
  return { fetchImpl, calls }
}

test('chromeForTestingPlatform maps the hosts Chrome for Testing publishes', () => {
  assert.equal(chromeForTestingPlatform('linux', 'x64'), 'linux64')
  assert.equal(chromeForTestingPlatform('linux', 'arm64'), 'linux-arm64')
  assert.equal(chromeForTestingPlatform('darwin', 'x64'), 'mac-x64')
  assert.equal(chromeForTestingPlatform('darwin', 'arm64'), 'mac-arm64')
  assert.equal(chromeForTestingPlatform('win32', 'x64'), 'win64')
  assert.equal(chromeForTestingPlatform('win32', 'ia32'), 'win32')
  assert.equal(chromeForTestingPlatform('linux', 'riscv64'), null)
  assert.equal(chromeForTestingPlatform('freebsd', 'x64'), null)
})

test('defaultChromeDownloadDir honours the cache overrides', () => {
  assert.equal(defaultChromeDownloadDir({ DSH_MESH_SMOKE_CHROME_CACHE: '/tmp/cache' }, 'linux'), '/tmp/cache')
  assert.equal(defaultChromeDownloadDir({ XDG_CACHE_HOME: '/tmp/xdg' }, 'linux'), path.join('/tmp/xdg', 'dsh-mesh', 'chrome'))
  assert.equal(
    defaultChromeDownloadDir({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32'),
    path.join('C:\\Users\\me\\AppData\\Local', 'dsh-mesh', 'chrome'),
  )
})

test('extractZip writes stored and deflated files and preserves executable bits', async () => {
  const dir = await tempDir()
  try {
    const archive = path.join(dir, 'sample.zip')
    await writeFile(archive, makeZip([
      { name: 'chrome-headless-shell-linux64/', data: '', mode: 0o040755 },
      { name: 'chrome-headless-shell-linux64/chrome-headless-shell', data: '#!/bin/sh\necho hi\n', method: 8, mode: 0o100755 },
      { name: 'chrome-headless-shell-linux64/icudtl.dat', data: 'data', method: 0, mode: 0o100644 },
    ]))
    const target = path.join(dir, 'out')
    const extracted = await extractZip(archive, target)
    assert.equal(extracted.length, 3)
    assert.equal(await readFile(path.join(target, 'chrome-headless-shell-linux64', 'chrome-headless-shell'), 'utf8'), '#!/bin/sh\necho hi\n')
    assert.equal(await readFile(path.join(target, 'chrome-headless-shell-linux64', 'icudtl.dat'), 'utf8'), 'data')
    if (process.platform !== 'win32') {
      assert.equal((await stat(path.join(target, 'chrome-headless-shell-linux64', 'chrome-headless-shell'))).mode & 0o777, 0o755)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('extractZip rejects entries that escape the destination', async () => {
  const dir = await tempDir()
  try {
    const archive = path.join(dir, 'evil.zip')
    await writeFile(archive, makeZip([{ name: '../escape.txt', data: 'no' }]))
    await assert.rejects(extractZip(archive, path.join(dir, 'out')), /escapes the destination/u)
    assert.equal(existsSync(path.join(dir, 'escape.txt')), false)
    await writeFile(archive, makeZip([{ name: '/absolute.txt', data: 'no' }]))
    await assert.rejects(extractZip(archive, path.join(dir, 'out')), /absolute path/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('extractZip rejects a corrupt archive', async () => {
  const dir = await tempDir()
  try {
    const archive = path.join(dir, 'broken.zip')
    await writeFile(archive, 'not a zip at all')
    await assert.rejects(extractZip(archive, path.join(dir, 'out')), /not a zip archive/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensureDownloadedChrome downloads, extracts, and then reuses the cache', async () => {
  const dir = await tempDir()
  try {
    const archive = makeZip([
      { name: 'chrome-headless-shell-linux64/chrome-headless-shell', data: 'fake chrome', mode: 0o100755 },
      { name: 'chrome-headless-shell-linux64/icudtl.dat', data: 'data', mode: 0o100644 },
    ])
    const { fetchImpl, calls } = mockFetch(archive)
    const cacheDir = path.join(dir, 'cache')
    const lines = []
    const result = await ensureDownloadedChrome({
      platform: 'linux',
      arch: 'x64',
      cacheDir,
      fetchImpl,
      log: line => lines.push(line),
    })
    assert.equal(result.cached, false)
    assert.equal(result.version, '999.0.1')
    assert.equal(result.platform, 'linux64')
    assert.equal(await readFile(result.binary, 'utf8'), 'fake chrome')
    assert.equal(result.binary, path.join(cacheDir, '999.0.1', 'linux64', 'chrome-headless-shell'))
    assert.deepEqual(calls, [
      'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json',
      'https://example.test/chrome-headless-shell-linux64.zip',
    ])
    assert.ok(lines.some(line => /downloading Chrome for Testing 999\.0\.1/u.test(line)))

    // The second call must not touch the network at all.
    const offline = await ensureDownloadedChrome({
      platform: 'linux',
      arch: 'x64',
      cacheDir,
      fetchImpl: async () => {
        throw new Error('network should not be used')
      },
    })
    assert.equal(offline.cached, true)
    assert.equal(offline.binary, result.binary)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensureDownloadedChrome accepts a direct archive URL for mirrors', async () => {
  const dir = await tempDir()
  try {
    const archive = makeZip([
      { name: 'chrome-headless-shell-linux64/chrome-headless-shell', data: 'mirror chrome', mode: 0o100755 },
    ])
    const { fetchImpl, calls } = mockFetch(archive, { archiveUrl: 'https://mirror.test/chrome.zip' })
    const result = await ensureDownloadedChrome({
      platform: 'linux',
      arch: 'x64',
      cacheDir: path.join(dir, 'cache'),
      archiveUrl: 'https://mirror.test/chrome.zip',
      fetchImpl,
    })
    assert.equal(result.version, 'custom')
    assert.deepEqual(calls, ['https://mirror.test/chrome.zip'])
    assert.equal(await readFile(result.binary, 'utf8'), 'mirror chrome')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensureDownloadedChrome reports when the manifest has no build', async () => {
  const dir = await tempDir()
  try {
    const { fetchImpl } = mockFetch(Buffer.from(''), {
      manifest: {
        channels: {
          Stable: {
            version: '999.0.1',
            downloads: { 'chrome-headless-shell': [{ platform: 'win64', url: 'https://example.test/win.zip' }] },
          },
        },
      },
    })
    await assert.rejects(
      ensureDownloadedChrome({ platform: 'linux', arch: 'arm64', cacheDir: path.join(dir, 'cache'), fetchImpl }),
      /no chrome-headless-shell build for linux-arm64/u,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
