import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateKeyPair } from '../../src/wireguard/lib/keys';
import { WireGuardService } from '../../src/wireguard/lib/service';

async function makeServer() {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-ssh-agent-test-'));
  const serverKeys = generateKeyPair();
  const service = new WireGuardService({
    dataDir: dir,
    platformFactory: async () => ({
      platform: 'linux', isWindows: false, isLinux: true, admin: true,
      wg: '/usr/bin/wg', wireguard: null, ip: '/usr/sbin/ip', sudo: null,
      iptables: null, nft: null, sysctl: null,
    }),
    tunnelFactory: () => ({
      addPeer: async () => undefined,
      removePeer: async () => undefined,
      down: async () => undefined,
    }),
    knownHosts: { refresh: async () => [], forget: async () => undefined },
  });
  await service.store.init();
  service.control = {} as any;
  service.tunnel = {
    addPeer: async () => undefined,
    removePeer: async () => undefined,
    down: async () => undefined,
  };
  service.state.settings.joinCode = 'test-join-code';
  service.state.server = {
    ...service.state.server,
    running: true,
    publicKey: serverKeys.publicKey,
    endpoint: '127.0.0.1:51820',
    endpointHost: '127.0.0.1',
    controlUrl: 'http://127.0.0.1:51821',
    controlPort: 51821,
    listenPort: 51820,
    vpnCidr: '10.66.66.0/24',
    interfaceName: 'dshwg0',
    mtu: 1420,
    dns: '',
    peers: [],
  };
  service.state.settings.serverIp = '10.66.66.1';
  return service;
}

test('joining a peer issues a private agent token and reports the real SSH user', async () => {
  const service = await makeServer();
  try {
    const client = generateKeyPair();
    const joined = await service.joinPeer({
      name: 'DESKTOP-TEST',
      publicKey: client.publicKey,
      code: 'test-join-code',
      family: '',
      platform: 'windows',
    }, '10.66.66.4');
    assert.match(String(joined.sshToken), /^[A-Za-z0-9_-]{40,}$/u);
    const peer = service.state.server.peers[0];
    assert.equal(peer.sshToken, joined.sshToken);
    assert.equal(peer.sshUser, null);

    const report = await service.reportPeerSsh({
      publicKey: client.publicKey,
      token: joined.sshToken,
      user: 'Admin',
      platform: 'windows',
      hostname: 'DESKTOP-TEST',
      sshInstalled: true,
      sshRunning: true,
      sshReady: true,
      sshPort: 22,
      sshVersion: 'OpenSSH_for_Windows_10.4',
      sshError: null,
    }, '10.66.66.4');
    assert.equal(peer.sshUser, 'Admin');
    assert.equal(peer.platform, 'windows');
    assert.equal(peer.sshReady, true);
    assert.equal(peer.sshInstalled, true);
    assert.ok(report.peer);
    assert.equal((report.peer as any).user, 'Admin');

    await assert.rejects(
      () => service.reportPeerSsh({ publicKey: client.publicKey, token: 'wrong-token', user: 'Admin' }),
      /member agent token/i,
    );
  } finally {
    await service.dispose();
  }
});

test('a rejoin returns the same token and the package can serve the OpenSSH asset', async () => {
  const service = await makeServer();
  try {
    const client = generateKeyPair();
    const first = await service.joinPeer({ name: 'member', publicKey: client.publicKey, code: 'test-join-code', platform: 'windows' });
    const second = await service.joinPeer({ name: 'member', publicKey: client.publicKey, code: 'test-join-code', platform: 'windows' });
    assert.equal(first.sshToken, second.sshToken);
    const manifest = await service.getOpenSshManifest({ publicKey: client.publicKey, token: first.sshToken });
    assert.equal(manifest.file, 'OpenSSH-Win64.zip');
    assert.match(manifest.sha256, /^[0-9a-f]{64}$/u);
    const asset = await service.getOpenSshAsset({ publicKey: client.publicKey, token: first.sshToken });
    assert.ok(asset.path.endsWith('OpenSSH-Win64.zip'));
    assert.equal(asset.name, 'OpenSSH-Win64.zip');
    assert.ok(asset.size > 0);
  } finally {
    await service.dispose();
  }
});
