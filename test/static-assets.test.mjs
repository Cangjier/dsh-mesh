import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { StaticAssets } from '../code/gate/static-assets.mjs'
import { collectStaticAssets } from '../code/build/static-assets.mjs'

test('the gate lists every packaged asset from one index', async () => {
  const assets = new StaticAssets()
  const index = await assets.index()
  const names = index.map(entry => entry.name)
  assert.deepEqual(names, ['7z', 'hysteria2', 'openssh', 'wireguard'])
  for (const entry of index) {
    assert.match(entry.manifest, /^\/__gate\/assets\//u)
    assert.ok(entry.assets.length > 0)
  }
})

test('the bundled 7-Zip assets match their manifest', async () => {
  const assets = new StaticAssets()
  const manifest = await assets.manifest('7z')
  assert.equal(manifest.version, '25.01')
  assert.deepEqual(manifest.assets.map(asset => `${asset.os}-${asset.arch}`), ['linux-x64', 'linux-arm64', 'windows-x64'])
  for (const asset of manifest.assets) {
    const file = await assets.file('7z', asset.file)
    const digest = createHash('sha256').update(await readFile(file.path)).digest('hex')
    assert.equal(digest, asset.sha256)
  }
})

test('a package manifest carries the bundled 7-Zip asset', async () => {
  const collected = await collectStaticAssets(fileURLToPath(new URL('../code/gate', import.meta.url)))
  const seven = collected.find(entry => entry.name === '7z')
  assert.notEqual(seven, undefined)
  assert.equal(seven.assets.length, 3)
  assert.ok(seven.manifest.endsWith('gate/assets/7z/manifest.json'))
})

test('the gate resolves and verifies the WireGuard MSI', async () => {
  const assets = new StaticAssets()
  const manifest = await assets.manifest('wireguard')
  assert.equal(manifest.assets[0].file, 'wireguard-amd64-0.5.3.msi')
  assert.equal(manifest.assets[0].contentType, 'application/x-msi')
  const file = await assets.file('wireguard', 'wireguard-amd64-0.5.3.msi')
  assert.equal(file.size, 2842624)
  assert.equal(file.sha256, '76fcec042c5989c5b816cd32eaed1e5b1c3b998a4b1c9eca55f299e3314ef7e4')
})
