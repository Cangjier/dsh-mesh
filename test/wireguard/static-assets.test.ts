import assert from 'node:assert/strict';
import test from 'node:test';
import { AssetStore } from '../../src/wireguard/lib/static-assets';

test('the package exposes hysteria2, OpenSSH, and WireGuard through one asset store', async () => {
  const store = new AssetStore();
  const index = await store.index();
  const names = index.map(item => item.name);
  assert.ok(names.includes('hysteria2'));
  assert.ok(names.includes('openssh'));
  assert.ok(names.includes('wireguard'));

  const manifest = await store.manifest('wireguard');
  assert.equal(manifest.name, 'wireguard');
  assert.equal(manifest.version, '0.5.3');
  const asset = await store.first('wireguard', 'windows', 'x64');
  assert.equal(asset.file, 'wireguard-amd64-0.5.3.msi');
  assert.equal(asset.kind, 'installer');
  assert.match(asset.sha256, /^[0-9a-f]{64}$/u);

  const file = await store.file('wireguard', asset.file);
  assert.equal(file.size, asset.bytes);
  assert.ok(file.path.endsWith('wireguard-amd64-0.5.3.msi'));
  assert.equal(file.contentType, 'application/x-msi');
});

test('asset names and file names cannot escape the asset directory', async () => {
  const store = new AssetStore();
  await assert.rejects(() => store.manifest('../wireguard'), /Invalid asset name/u);
  await assert.rejects(() => store.file('wireguard', '../manifest.json'), /Invalid asset file/u);
  await assert.rejects(() => store.file('wireguard', 'missing.msi'), /Unknown file/u);
});
