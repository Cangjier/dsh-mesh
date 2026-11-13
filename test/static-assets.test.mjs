import assert from 'node:assert/strict'
import test from 'node:test'
import { StaticAssets } from '../code/gate/static-assets.mjs'

test('the gate lists every packaged asset from one index', async () => {
  const assets = new StaticAssets()
  const index = await assets.index()
  const names = index.map(entry => entry.name)
  assert.deepEqual(names, ['hysteria2', 'openssh', 'wireguard'])
  for (const entry of index) {
    assert.match(entry.manifest, /^\/__gate\/assets\//u)
    assert.ok(entry.assets.length > 0)
  }
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
