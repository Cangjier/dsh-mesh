import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  formatAuthorizedKeyLine,
  gatewaySshConfigBlock,
  mergeKnownHosts,
  mergeManagedBlock,
  parseSshPublicKey,
  removeAuthorizedKeyTag,
  sshKeyFingerprint,
  upsertAuthorizedKey,
} from '../../src/wireguard/lib/member-ssh';
import { WireGuardService } from '../../src/wireguard/lib/service';
import { generateKeyPair } from '../../src/wireguard/lib/keys';
import { ensureMemberKey, memberSshPaths } from '../../src/wireguard/lib/ssh-agent';

/**
 * Generate a real Ed25519 SSH key without leaving key material in the repo.
 * @returns `{ publicKey, privateKey }` OpenSSH text.
 */
function makeSshKey(): { publicKey: string; privateKey: string } {
  const directory = execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim();
  try {
    const keyPath = path.join(directory, 'id_ed25519');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'dsh-mesh@test', '-f', keyPath], { stdio: 'ignore' });
    return {
      publicKey: execFileSync('cat', [`${keyPath}.pub`], { encoding: 'utf8' }).trim(),
      privateKey: execFileSync('cat', [keyPath], { encoding: 'utf8' }),
    };
  } finally {
    execFileSync('rm', ['-rf', directory]);
  }
}

function haveSshKeygen(): boolean {
  // ssh-keygen -h exits non-zero on purpose; only a spawn error means missing.
  return spawnSync('ssh-keygen', ['-h'], { stdio: 'ignore' }).error === undefined;
}

/** Reserve and release a port so startServer accepts it. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test('parses only real OpenSSH public keys', () => {
  const key = makeSshKey();
  const parsed = parseSshPublicKey(key.publicKey);
  assert.ok(parsed);
  assert.equal(parsed.type, 'ssh-ed25519');
  assert.equal(parsed.comment, 'dsh-mesh@test');
  assert.equal(parsed.text, `ssh-ed25519 ${parsed.base64}`);

  // Multi-line input would smuggle a second authorized_keys entry.
  assert.equal(parseSshPublicKey(`${key.publicKey}\nssh-ed25519 AAAA`), null);
  assert.equal(parseSshPublicKey('ssh-ed25519'), null);
  assert.equal(parseSshPublicKey('ssh-unknown AAAA'), null);
  assert.equal(parseSshPublicKey(''), null);
  assert.equal(parseSshPublicKey(null), null);
});

test('fingerprints match ssh-keygen -lf', async () => {
  const key = makeSshKey();
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-fp-'));
  try {
    const file = path.join(directory, 'key.pub');
    await writeFile(file, `${key.publicKey}\n`, 'utf8');
    const expected = execFileSync('ssh-keygen', ['-lf', file], { encoding: 'utf8' }).trim().split(/\s+/u)[1];
    assert.equal(sshKeyFingerprint(key.publicKey), expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('authorized_keys lines are pinned to the member address and replaced in place', () => {
  const first = makeSshKey();
  const second = makeSshKey();
  const existing = 'ssh-ed25519 AAAAexisting someone@else\n';
  const line = formatAuthorizedKeyLine({ key: first.publicKey, from: '10.66.66.4', tag: '10.66.66.4', comment: 'dsh-mesh@test' });
  assert.match(line, /^from="10\.66\.66\.4" ssh-ed25519 [A-Za-z0-9+/=]+ dsh-mesh:10\.66\.66\.4 dsh-mesh@test$/u);

  const once = upsertAuthorizedKey(existing, line, '10.66.66.4');
  assert.match(once, /AAAAexisting/u);
  assert.equal(once.split('\n').filter((item) => item.includes('dsh-mesh:10.66.66.4')).length, 1);

  // A rotated key for the same peer must not leave the old line behind.
  const rotated = formatAuthorizedKeyLine({ key: second.publicKey, from: '10.66.66.4', tag: '10.66.66.4', comment: 'dsh-mesh@test' });
  const twice = upsertAuthorizedKey(once, rotated, '10.66.66.4');
  assert.equal(twice.split('\n').filter((item) => item.includes('dsh-mesh:10.66.66.4')).length, 1);
  assert.ok(twice.includes(parseSshPublicKey(second.publicKey)!.base64));
  assert.equal(twice.includes(parseSshPublicKey(first.publicKey)!.base64), false);

  assert.equal(removeAuthorizedKeyTag(twice, '10.66.66.4'), existing);
  assert.doesNotMatch(removeAuthorizedKeyTag(twice, '10.66.66.4'), /dsh-mesh:10\.66\.66\.4/u);
});

test('the managed config block is replaced, never duplicated', () => {
  const block = gatewaySshConfigBlock({ host: '10.66.66.1', user: 'root', port: 22 });
  assert.match(block, /^# >>> dsh-mesh:gateway >>>$/mu);
  assert.match(block, /^Host dsh-gateway 10\.66\.66\.1$/mu);
  assert.match(block, /IdentityFile ~\/\.ssh\/id_ed25519_dsh_mesh/u);

  const userText = 'Host my-nas\n  HostName 192.168.1.9\n  User admin\n';
  const once = mergeManagedBlock(userText, 'dsh-mesh:gateway', block);
  assert.match(once, /Host my-nas/u);
  assert.equal(once.split('# >>> dsh-mesh:gateway >>>').length, 2);

  const twice = mergeManagedBlock(once, 'dsh-mesh:gateway', gatewaySshConfigBlock({ host: '10.66.66.1', user: 'ubuntu', port: 2222 }));
  assert.equal(twice.split('# >>> dsh-mesh:gateway >>>').length, 2);
  assert.match(twice, /User ubuntu/u);
  assert.doesNotMatch(twice, /User root/u);
  assert.match(twice, /Host my-nas/u);
});

test('known_hosts keeps one entry per gateway and drops stale keys', () => {
  const oldKey = `ssh-ed25519 ${Buffer.alloc(51, 7).toString('base64')}`;
  const newKey = `ssh-ed25519 ${Buffer.alloc(51, 9).toString('base64')}`;
  const text = `10.66.66.1 ${oldKey}\nother.example ssh-ed25519 AAAA\n`;
  const merged = mergeKnownHosts(text, '10.66.66.1', 22, [newKey]);
  assert.equal(merged.split('\n').filter((line) => line.startsWith('10.66.66.1 ')).length, 1);
  assert.match(merged, /other\.example/u);
  assert.doesNotMatch(merged, /BwcHBwcHBw/u);

  const nonDefaultPort = mergeKnownHosts('', '10.66.66.1', 2222, [newKey]);
  assert.match(nonDefaultPort, /^\[10\.66\.66\.1\]:2222 ssh-ed25519 /mu);
});

test('member paths follow the account, not the service profile', () => {
  const windows = { platform: 'win32', isWindows: true, isLinux: false } as any;
  const linux = { platform: 'linux', isWindows: false, isLinux: true } as any;
  const windowsPaths = memberSshPaths(windows, 'Admin');
  assert.equal(windowsPaths.privateKey, 'C:\\Users\\Admin\\.ssh\\id_ed25519_dsh_mesh');
  assert.equal(windowsPaths.config, 'C:\\Users\\Admin\\.ssh\\config');
  const linuxPaths = memberSshPaths(linux, 'root');
  assert.match(linuxPaths.privateKey, /\/\.ssh\/id_ed25519_dsh_mesh$/u);
});

test('ensureMemberKey generates exactly once and reuses the identity', async (t) => {
  if (!haveSshKeygen()) {
    t.skip('ssh-keygen is not installed');
    return;
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-member-key-'));
  const linux = { platform: 'linux', isWindows: false, isLinux: true } as any;
  const paths = {
    dir: path.join(directory, '.ssh'),
    privateKey: path.join(directory, '.ssh', 'id_ed25519_dsh_mesh'),
    publicKey: path.join(directory, '.ssh', 'id_ed25519_dsh_mesh.pub'),
    config: path.join(directory, '.ssh', 'config'),
    knownHosts: path.join(directory, '.ssh', 'known_hosts'),
  };
  try {
    const first = await ensureMemberKey(linux, paths, { comment: 'dsh-mesh@test', user: null });
    assert.equal(first.created, true);
    assert.match(first.publicKey, /^ssh-ed25519 /u);
    const before = await readFile(paths.privateKey, 'utf8');
    const second = await ensureMemberKey(linux, paths, { comment: 'dsh-mesh@test', user: null });
    assert.equal(second.created, false);
    assert.equal(second.publicKey, first.publicKey);
    assert.equal(await readFile(paths.privateKey, 'utf8'), before);

    // A lost .pub is rebuilt from the private key instead of a new identity.
    await rm(paths.publicKey);
    const third = await ensureMemberKey(linux, paths, { comment: 'dsh-mesh@test', user: null });
    assert.equal(third.publicKey, first.publicKey);
    assert.ok(existsSync(paths.publicKey));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function fakePlatform() {
  return {
    platform: 'linux',
    isWindows: false,
    isLinux: true,
    admin: true,
    wg: '/usr/bin/wg',
    wireguard: null,
    ip: '/usr/sbin/ip',
    sudo: null,
    iptables: '/usr/sbin/iptables',
    nft: null,
    sysctl: null,
  };
}

function fakeTunnel() {
  return {
    async upServer() { return { warnings: [] }; },
    async upClient() {},
    async down() {},
    async addPeer() {},
    async removePeer() {},
    async status() { return { up: true, publicKey: Buffer.alloc(32, 3).toString('base64'), listenPort: 51820, peers: [] }; },
  };
}

test('a member key is authorized from=, rotated, and revoked with the peer', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dsh-wg-reverse-'));
  const authorizedKeysPath = path.join(dataDir, 'authorized_keys');
  const service = new WireGuardService({
    dataDir,
    authorizedKeysPath,
    platformFactory: async () => fakePlatform(),
    tunnelFactory: () => fakeTunnel(),
    log: () => {},
  });
  await service.init();
  try {
    await service.startServer({
      controlPort: await freePort(),
      listenPort: 51820,
      vpnCidr: '10.66.66.0/24',
      serverIp: '10.66.66.1',
      endpointHost: '192.168.1.10',
      joinCode: 'join',
      mtu: 1420,
      interfaceName: 'dshwg0',
      dns: '',
    });
    const wg = generateKeyPair();
    const joined = await service.joinPeer({ name: 'member', publicKey: wg.publicKey, code: 'join' });
    const token = joined.sshToken;
    assert.equal(typeof token, 'string');

    const first = makeSshKey();
    const result = await service.authorizeMemberKey({ publicKey: wg.publicKey, token, sshPublicKey: first.publicKey });
    assert.equal(result.authorized, true);
    assert.equal(result.host, '10.66.66.1');
    assert.equal(result.from, '10.66.66.2');
    assert.match(String(result.fingerprint), /^SHA256:/u);
    assert.match(String(result.sshConfigB64), /^[A-Za-z0-9+/=]+$/u);

    const stored = await readFile(authorizedKeysPath, 'utf8');
    assert.match(stored, /^from="10\.66\.66\.2" ssh-ed25519 /mu);
    assert.match(stored, /dsh-mesh:10\.66\.66\.2/u);

    // Rotation replaces the previous line instead of appending a second one.
    const second = makeSshKey();
    await service.authorizeMemberKey({ publicKey: wg.publicKey, token, sshPublicKey: second.publicKey });
    const rotated = await readFile(authorizedKeysPath, 'utf8');
    assert.equal(rotated.split('\n').filter((line) => line.includes('dsh-mesh:10.66.66.2')).length, 1);

    // A wrong token cannot enroll anything.
    await assert.rejects(
      () => service.authorizeMemberKey({ publicKey: wg.publicKey, token: 'nope', sshPublicKey: first.publicKey }),
      /token/u,
    );

    const snapshot = service.snapshot();
    const peer = snapshot.server.peers.find((item: any) => item.publicKey === wg.publicKey) as any;
    assert.equal(peer.reverse.ready, true);
    assert.equal(peer.reverse.user, 'root');
    assert.equal(peer.reverse.command, 'ssh -i ~/.ssh/id_ed25519_dsh_mesh root@10.66.66.1');

    await service.removePeer(wg.publicKey);
    assert.equal((await readFile(authorizedKeysPath, 'utf8')).includes('dsh-mesh:10.66.66.2'), false);
  } finally {
    await service.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('the panel can authorize or revoke a pasted member key', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dsh-wg-reverse-panel-'));
  const authorizedKeysPath = path.join(dataDir, 'authorized_keys');
  const service = new WireGuardService({
    dataDir,
    authorizedKeysPath,
    platformFactory: async () => fakePlatform(),
    tunnelFactory: () => fakeTunnel(),
    log: () => {},
  });
  await service.init();
  try {
    await service.startServer({
      controlPort: await freePort(),
      listenPort: 51820,
      vpnCidr: '10.66.66.0/24',
      serverIp: '10.66.66.1',
      endpointHost: '192.168.1.10',
      joinCode: 'join',
      mtu: 1420,
      interfaceName: 'dshwg0',
      dns: '',
    });
    const wg = generateKeyPair();
    await service.joinPeer({ name: 'member', publicKey: wg.publicKey, code: 'join' });
    const key = makeSshKey();
    const installed = await service.setPeerReverseKey({ publicKey: wg.publicKey, sshPublicKey: key.publicKey });
    assert.equal(installed.reverse.ready, true);
    assert.match(await readFile(authorizedKeysPath, 'utf8'), /from="10\.66\.66\.2"/u);

    const revoked = await service.setPeerReverseKey({ publicKey: wg.publicKey, sshPublicKey: '' });
    assert.equal(revoked.reverse.ready, false);
    assert.doesNotMatch(await readFile(authorizedKeysPath, 'utf8'), /10\.66\.66\.2/u);

    await assert.rejects(
      () => service.setPeerReverseKey({ publicKey: wg.publicKey, sshPublicKey: 'not a key' }),
      /OpenSSH/u,
    );
  } finally {
    await service.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('the control panel exposes /ssh/authorize', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dsh-wg-reverse-http-'));
  const authorizedKeysPath = path.join(dataDir, 'authorized_keys');
  const service = new WireGuardService({
    dataDir,
    authorizedKeysPath,
    platformFactory: async () => fakePlatform(),
    tunnelFactory: () => fakeTunnel(),
    log: () => {},
  });
  await service.init();
  try {
    const port = await freePort();
    await service.startServer({
      controlPort: port,
      listenPort: 51820,
      vpnCidr: '10.66.66.0/24',
      serverIp: '10.66.66.1',
      endpointHost: '192.168.1.10',
      joinCode: 'join',
      mtu: 1420,
      interfaceName: 'dshwg0',
      dns: '',
    });
    const wg = generateKeyPair();
    const joined = await service.joinPeer({ name: 'member', publicKey: wg.publicKey, code: 'join' });
    const key = makeSshKey();
    const response = await fetch(`http://127.0.0.1:${port}/ssh/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicKey: wg.publicKey, token: joined.sshToken, sshPublicKey: key.publicKey }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.ok, true);
    assert.equal(body.from, '10.66.66.2');
    assert.equal(body.user, 'root');
    // This gateway has real /etc/ssh host keys, so known_hosts is pre-seeded.
    const knownHosts = Buffer.from(String(body.knownHostsB64), 'base64').toString('utf8');
    assert.match(knownHosts, /^10\.66\.66\.1 ssh-/mu);
    // The member must never receive this gateway's full snapshot.
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'state'), false);
  } finally {
    await service.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('host keys are advertised when sshd host .pub files exist', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dsh-wg-hostkeys-'));
  const hostKeyFile = path.join(dataDir, 'ssh_host_ed25519_key.pub');
  const { publicKey } = generateKeyPairSync('ed25519');
  // A raw ed25519 public key is not an OpenSSH blob; build one by hand.
  const type = Buffer.from('ssh-ed25519');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(type.length);
  const blob = Buffer.concat([length, type, Buffer.from(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32))]);
  const sshKey = `ssh-ed25519 ${blob.toString('base64')} root@gateway`;
  await writeFile(hostKeyFile, `${sshKey}\n`, 'utf8');
  const service = new WireGuardService({
    dataDir,
    authorizedKeysPath: path.join(dataDir, 'authorized_keys'),
    hostKeyFiles: [hostKeyFile],
    platformFactory: async () => fakePlatform(),
    tunnelFactory: () => fakeTunnel(),
    log: () => {},
  });
  await service.init();
  try {
    await service.startServer({
      controlPort: await freePort(),
      listenPort: 51820,
      vpnCidr: '10.66.66.0/24',
      serverIp: '10.66.66.1',
      endpointHost: '192.168.1.10',
      joinCode: 'join',
      mtu: 1420,
      interfaceName: 'dshwg0',
      dns: '',
    });
    const wg = generateKeyPair();
    const joined = await service.joinPeer({ name: 'member', publicKey: wg.publicKey, code: 'join' });
    const key = makeSshKey();
    const result = await service.authorizeMemberKey({ publicKey: wg.publicKey, token: joined.sshToken, sshPublicKey: key.publicKey });
    assert.deepEqual(result.hostKeys, [`ssh-ed25519 ${blob.toString('base64')}`]);
    const knownHosts = Buffer.from(String(result.knownHostsB64), 'base64').toString('utf8');
    assert.match(knownHosts, /^10\.66\.66\.1 ssh-ed25519 /mu);
  } finally {
    await service.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});
