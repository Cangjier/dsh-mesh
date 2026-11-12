import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateKeyPair } from '../../src/wireguard/lib/keys';
import { WireGuardService } from '../../src/wireguard/lib/service';

function fakePlatform(overrides = {}) {
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
    ...overrides,
  };
}

function fakeTunnel() {
  return {
    peerAdds: [],
    peerRemoves: [],
    serverInput: null,
    clientInput: null,
    downCalls: 0,
    async upServer(input) {
      this.serverInput = input;
      return { warnings: [] };
    },
    async upClient(input) {
      this.clientInput = input;
    },
    async down() {
      this.downCalls += 1;
    },
    async addPeer(interfaceName, peer) {
      this.peerAdds.push({ interfaceName, peer });
    },
    async removePeer(interfaceName, publicKey) {
      this.peerRemoves.push({ interfaceName, publicKey });
    },
    async status() {
      return { up: true, publicKey: Buffer.alloc(32, 3).toString('base64'), listenPort: 51820, peers: [] };
    },
  };
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function withService(run, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dsh-wireguard-test-'));
  const tunnel = fakeTunnel();
  const service = new WireGuardService({
    dataDir,
    platformFactory: async () => fakePlatform(),
    tunnelFactory: () => tunnel,
    log: () => {},
    ...options,
  });
  await service.init();
  try {
    await run({ service, tunnel, dataDir });
  } finally {
    await service.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('starts a control panel, joins a peer, and never exposes the join code on health', async () => {
  await withService(async ({ service, tunnel }) => {
    const port = await freePort();
    const accessCode = 'secret-code';
    const state = await service.startServer({
      controlPort: port,
      listenPort: 51820,
      vpnCidr: '10.66.66.0/24',
      serverIp: '10.66.66.1',
      endpointHost: '192.168.1.10',
      joinCode: accessCode,
      mtu: 1420,
      interfaceName: 'dshwg0',
      dns: '',
    });
    assert.equal(state.server.running, true);
    assert.equal(state.server.controlAvailable, true);
    assert.equal(state.server.joinRequired, true);
    assert.equal(state.settings.joinCode, accessCode);
    assert.equal(tunnel.serverInput.peers.length, 0);

    const loginPage = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(loginPage.status, 200);
    assert.equal(loginPage.headers.get('www-authenticate'), null);
    const loginHtml = await loginPage.text();
    assert.match(loginHtml, /name="password"/);
    assert.match(loginHtml, /action="\/login"/);

    const badLogin = await fetch(`http://127.0.0.1:${port}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'wrong' }).toString(),
    });
    assert.equal(badLogin.status, 401);
    assert.equal(badLogin.headers.get('www-authenticate'), null);
    assert.match(await badLogin.text(), /密码错误/);

    const login = await fetch(`http://127.0.0.1:${port}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: accessCode }).toString(),
      redirect: 'manual',
    });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), '/');
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    assert.match(cookie, /^dsh_wg_panel=[0-9a-f]+$/);

    const page = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie } });
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /join code \/ password protected/);
    assert.doesNotMatch(pageHtml, new RegExp(accessCode));
    assert.match(pageHtml, /action="\/logout"/);

    const staleCookiePage = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie: 'dsh_wg_panel=deadbeef' } });
    assert.equal(staleCookiePage.status, 200);
    assert.match(await staleCookiePage.text(), /name="password"/);

    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.service, 'dsh-wireguard');
    assert.equal(health.joinRequired, true);
    assert.equal(Object.prototype.hasOwnProperty.call(health, 'joinCode'), false);

    const scriptResponse = await fetch(`http://127.0.0.1:${port}/client.sh`);
    assert.equal(scriptResponse.status, 200);
    assert.match(scriptResponse.headers.get('content-type') ?? '', /shellscript/);
    const scriptText = await scriptResponse.text();
    assert.match(scriptText, /^#!\/bin\/sh/);
    assert.match(scriptText, /CONTROL_URL=\$1/);
    assert.match(scriptText, /JOIN_CODE=\$2/);
    assert.doesNotMatch(scriptText, /secret-code/);
    assert.doesNotMatch(scriptText, /192\.168\.1\.10/);

    const wrong = await fetch(`http://127.0.0.1:${port}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'bad', publicKey: generateKeyPair().publicKey, code: 'wrong' }),
    });
    assert.equal(wrong.status, 401);

    const client = generateKeyPair();
    const joinResponse = await fetch(`http://127.0.0.1:${port}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'laptop-b', publicKey: client.publicKey, code: 'secret-code' }),
    });
    assert.equal(joinResponse.status, 200);
    const joined = await joinResponse.json();
    assert.equal(joined.client.ip, '10.66.66.2');
    assert.equal(joined.server.endpoint, '192.168.1.10:51820');
    assert.equal(tunnel.peerAdds.length, 1);

    const peersUnauthorized = await fetch(`http://127.0.0.1:${port}/peers`);
    assert.equal(peersUnauthorized.status, 401);
    assert.equal(peersUnauthorized.headers.get('www-authenticate'), null);
    const peersByCode = await fetch(`http://127.0.0.1:${port}/peers?code=secret-code`);
    assert.equal(peersByCode.status, 200);
    const peersAuthorized = await fetch(`http://127.0.0.1:${port}/peers`, { headers: { cookie } });
    assert.equal(peersAuthorized.status, 200);
    const peers = await peersAuthorized.json();
    assert.equal(peers.peers[0].name, 'laptop-b');
    assert.equal(Object.prototype.hasOwnProperty.call(peers.peers[0], 'publicKey'), false);

    const leaveResponse = await fetch(`http://127.0.0.1:${port}/leave`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicKey: client.publicKey, code: 'secret-code' }),
    });
    assert.equal(leaveResponse.status, 200);
    assert.equal((await leaveResponse.json()).removed, true);
    assert.equal(service.snapshot().server.peers.length, 0);

    const stopped = await service.stopServer();
    assert.equal(stopped.server.running, false);
    assert.ok(tunnel.downCalls >= 1);
  });
});

test('generates a random join code when empty and protects the panel with it', async () => {
  await withService(async ({ service }) => {
    const port = await freePort();
    const state = await service.startServer({
      controlPort: port,
      listenPort: 51820,
      vpnCidr: '10.66.66.0/24',
      serverIp: '10.66.66.1',
      endpointHost: '192.168.1.10',
      joinCode: '',
      mtu: 1420,
      interfaceName: 'dshwg0',
      dns: '',
    });
    const code = state.settings.joinCode;
    assert.match(code, /^[A-Za-z0-9_-]{12}$/);
    assert.equal(state.server.joinRequired, true);

    const loginPage = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(loginPage.status, 200);
    assert.equal(loginPage.headers.get('www-authenticate'), null);
    const login = await fetch(`http://127.0.0.1:${port}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: code }).toString(),
      redirect: 'manual',
    });
    assert.equal(login.status, 303);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const authorized = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie } });
    assert.equal(authorized.status, 200);
    await service.stopServer();
  });
});

test('joins a server as a client, writes a config, and disconnects cleanly', async () => {
  const serverKeys = generateKeyPair();
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/health')) {
      return new Response(JSON.stringify({
        ok: true,
        service: 'dsh-wireguard',
        publicKey: serverKeys.publicKey,
        vpnCidr: '10.66.66.0/24',
        listenPort: 51820,
        mtu: 1420,
        dns: '',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/join')) {
      return new Response(JSON.stringify({
        ok: true,
        client: { ip: '10.66.66.2', address: '10.66.66.2/32', name: 'laptop-b' },
        server: { publicKey: serverKeys.publicKey, endpoint: '192.168.1.10:51820', vpnCidr: '10.66.66.0/24' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/leave')) {
      return new Response(JSON.stringify({ ok: true, removed: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dsh-wireguard-client-test-'));
  const tunnel = fakeTunnel();
  const service = new WireGuardService({
    dataDir,
    platformFactory: async () => fakePlatform(),
    tunnelFactory: () => tunnel,
    fetchImpl,
    log: () => {},
  });
  await service.init();
  try {
    const state = await service.connectClient({ serverAddress: '192.168.1.10:51821', joinCode: 'secret' });
    assert.equal(state.client.connected, true);
    assert.equal(state.client.assignedIp, '10.66.66.2');
    assert.equal(state.client.publicKeyFingerprint.length > 0, true);
    assert.equal(Object.prototype.hasOwnProperty.call(state.client, 'joinCode'), false);
    assert.ok(tunnel.clientInput);
    assert.equal(tunnel.clientInput.endpoint, '192.168.1.10:51820');
    assert.match(tunnel.clientInput.configPath, /client\.conf$/);
    assert.equal(requests.filter((entry) => entry.url.endsWith('/join')).length, 1);

    const disconnected = await service.disconnectClient();
    assert.equal(disconnected.client.connected, false);
    assert.equal(disconnected.client.pending, false);
    assert.equal(requests.filter((entry) => entry.url.endsWith('/leave')).length, 1);
    assert.ok(tunnel.downCalls >= 1);
  } finally {
    await service.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('configures SSH access for a joined peer and removes its private key with the peer', async () => {
  await withService(async ({ service, tunnel, dataDir }) => {
    const port = await freePort();
    await service.startServer({
      controlPort: port,
      listenPort: 51820,
      vpnCidr: '10.66.66.0/24',
      serverIp: '10.66.66.1',
      endpointHost: '192.168.1.10',
      joinCode: 'secret-code',
      mtu: 1420,
      interfaceName: 'dshwg0',
      dns: '',
    });
    const client = generateKeyPair();
    await service.joinPeer({ name: 'ssh-client', publicKey: client.publicKey, code: 'secret-code' });

    const configured = await service.configurePeerSsh({ publicKey: client.publicKey, user: 'ubuntu' });
    assert.match(configured.command, /ssh-ed25519 /);
    assert.match(configured.command, /'ubuntu'/);
    assert.match(configured.commands.windows, /^powershell /);
    assert.doesNotMatch(configured.command, /PRIVATE KEY/);
    const peer = configured.state.server.peers.find((candidate) => candidate.publicKey === client.publicKey);
    assert.equal(peer.sshConfigured, true);
    assert.equal(peer.sshUser, 'ubuntu');
    assert.equal(Object.prototype.hasOwnProperty.call(peer, 'sshKeyPath'), false);

    const sshDir = path.join(dataDir, 'ssh');
    const keys = (await readdir(sshDir)).filter((name) => name.endsWith('.key'));
    assert.equal(keys.length, 1);
    const privateKey = await readFile(path.join(sshDir, keys[0]), 'utf8');
    assert.match(privateKey, /BEGIN OPENSSH PRIVATE KEY/);

    await service.removePeer(client.publicKey);
    const remaining = (await readdir(sshDir)).filter((name) => name.endsWith('.key'));
    assert.equal(remaining.length, 0);
    await service.stopServer();
    assert.ok(tunnel.downCalls >= 1);
  });
});

test('SSH authorization refreshes known hosts and peer removal forgets them', async () => {
  const calls: string[] = [];
  await withService(async ({ service }) => {
    const port = await freePort();
    await service.startServer({
      controlPort: port,
      listenPort: 51820,
      vpnCidr: '10.66.66.0/24',
      serverIp: '10.66.66.1',
      endpointHost: '192.168.1.10',
      joinCode: 'secret-code',
      mtu: 1420,
      interfaceName: 'dshwg0',
      dns: '',
    });
    const client = generateKeyPair();
    await service.joinPeer({ name: 'known-hosts-client', publicKey: client.publicKey, code: 'secret-code' });
    const configured = await service.configurePeerSsh({ publicKey: client.publicKey, user: 'ubuntu' });
    const peer = configured.state.server.peers.find((candidate) => candidate.publicKey === client.publicKey);
    assert.ok(peer);
    assert.deepEqual(calls, [`refresh ${peer.ip}`]);

    await service.removePeer(client.publicKey);
    assert.deepEqual(calls, [`refresh ${peer.ip}`, `forget ${peer.ip}`]);
    await service.stopServer();
  }, {
    knownHosts: {
      refresh: async (host: string) => {
        calls.push(`refresh ${host}`);
        return ['ssh-ed25519 AAAA'];
      },
      forget: async (host: string) => {
        calls.push(`forget ${host}`);
      },
    },
  });
});

test('a failed host-key refresh does not break SSH authorization', async () => {
  await withService(async ({ service }) => {
    const port = await freePort();
    await service.startServer({
      controlPort: port,
      listenPort: 51820,
      vpnCidr: '10.66.66.0/24',
      serverIp: '10.66.66.1',
      endpointHost: '192.168.1.10',
      joinCode: 'secret-code',
      mtu: 1420,
      interfaceName: 'dshwg0',
      dns: '',
    });
    const client = generateKeyPair();
    await service.joinPeer({ name: 'offline-client', publicKey: client.publicKey, code: 'secret-code' });
    const configured = await service.configurePeerSsh({ publicKey: client.publicKey, user: 'ubuntu' });
    assert.match(configured.command, /ssh-ed25519 /);
    await service.stopServer();
  }, {
    knownHosts: {
      refresh: async () => {
        throw new Error('ssh-keyscan timed out');
      },
      forget: async () => {},
    },
  });
});

test('advertises an IPv6 transport endpoint while keeping IPv4 VPN addressing', async () => {
  await withService(async ({ service }) => {
    const port = await freePort();
    const state = await service.startServer({
      controlPort: port,
      listenPort: 51820,
      vpnCidr: '10.66.66.0/24',
      serverIp: '10.66.66.1',
      endpointHost: '2408:400a:109:bf00::1',
      joinCode: 'secret-code',
      mtu: 1420,
      interfaceName: 'dshwg0',
      dns: '',
    });
    assert.equal(state.server.endpoint, '[2408:400a:109:bf00::1]:51820');
    assert.equal(state.server.controlUrl, `http://[2408:400a:109:bf00::1]:${port}`);
    assert.equal(state.settings.vpnCidr, '10.66.66.0/24');

    const client = generateKeyPair();
    const joined = await service.joinPeer({
      name: 'ipv6-client',
      publicKey: client.publicKey,
      code: 'secret-code',
      family: 'ipv6',
    });
    assert.equal(joined.server.endpoint, '[2408:400a:109:bf00::1]:51820');
    await service.stopServer();
  });
});


test('enables egress on the hub and member, persists it, and carries it on rejoin', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const sshCalls: Array<{ command: string; host: string; user: string }> = [];
  await withService(async ({ service }) => {
    const port = await freePort();
    await service.startServer({
      controlPort: port,
      listenPort: 51820,
      vpnCidr: '10.66.66.0/24',
      serverIp: '10.66.66.1',
      endpointHost: '192.168.1.10',
      joinCode: 'secret-code',
      mtu: 1420,
      interfaceName: 'dshwg0',
      dns: '',
    });
    const client = generateKeyPair();
    const joined = await service.joinPeer({ name: 'egress-client', publicKey: client.publicKey, code: 'secret-code', platform: 'linux' });
    assert.equal(joined.egress, false);
    assert.equal(joined.server.vpnIp, '10.66.66.1');

    const configured = await service.configurePeerSsh({ publicKey: client.publicKey, user: 'root', platform: 'linux' });
    const sshPeer = configured.state.server.peers.find((candidate) => candidate.publicKey === client.publicKey);
    assert.ok(sshPeer);
    assert.equal(sshPeer.platform, 'linux');

    const enabled = await service.setPeerEgress({ publicKey: client.publicKey, enabled: true });
    assert.equal(enabled.applied, true);
    assert.equal(enabled.egress, true);
    assert.match(enabled.manual.enable, /^sudo sh -c '/);
    assert.match(enabled.manual.enable, /10\.66\.66\.1/);
    const enabledPeer = enabled.state.server.peers.find((candidate) => candidate.publicKey === client.publicKey);
    assert.ok(enabledPeer);
    assert.equal(enabledPeer.egress, true);

    const hubCall = calls.find((call) => call.args.includes('hub') && call.args.includes('10.66.66.2'));
    assert.ok(hubCall, 'the helper script must receive the member VPN address');
    assert.equal(sshCalls.length, 1);
    assert.equal(sshCalls[0].host, '10.66.66.2');
    assert.equal(sshCalls[0].user, 'root');
    assert.match(sshCalls[0].command, /AllowedIPs = 0\.0\.0\.0\/0/);
    assert.match(sshCalls[0].command, /dsh-mesh-egress\.service/);

    const rejoined = await service.joinPeer({ name: 'egress-client', publicKey: client.publicKey, code: 'secret-code', platform: 'linux' });
    assert.equal(rejoined.egress, true);
    assert.equal(rejoined.server.vpnIp, '10.66.66.1');
    assert.ok(calls.filter((call) => call.args.includes('hub')).length >= 2);

    const disabled = await service.setPeerEgress({ publicKey: client.publicKey, enabled: false });
    assert.equal(disabled.applied, true);
    assert.equal(disabled.egress, false);
    const removeCall = calls.find((call) => call.command.endsWith('iptables') && call.args.includes('-D') && call.args.includes('10.66.66.2/32'));
    assert.ok(removeCall, 'the hub NAT rule must be deleted immediately');
    assert.ok(removeCall.args.includes('-o') && removeCall.args.includes('eth0'));
    assert.equal(sshCalls.length, 2);
    assert.match(sshCalls[1].command, /AllowedIPs = \$VPN_CIDR/);
    const disabledPeer = disabled.state.server.peers.find((candidate) => candidate.publicKey === client.publicKey);
    assert.ok(disabledPeer);
    assert.equal(disabledPeer.egress, false);
    await service.stopServer();
  }, {
    knownHosts: {
      refresh: async () => ['ssh-ed25519 AAAA'],
      forget: async () => {},
    },
    commandRunner: async (command: string, args: readonly string[]) => {
      calls.push({ command, args: [...args] });
      if (command.endsWith('ip')) {
        return { stdout: 'default via 192.168.1.1 dev eth0 proto dhcp metric 100\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
    sshRunner: async (input: { command: string; host: string; user: string }) => {
      sshCalls.push({ command: input.command, host: input.host, user: input.user });
      return { stdout: '', stderr: '' };
    },
  });
});

test('keeps the hub half and returns a manual command when the peer has no SSH', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  await withService(async ({ service }) => {
    const port = await freePort();
    await service.startServer({
      controlPort: port,
      listenPort: 51820,
      vpnCidr: '10.66.66.0/24',
      serverIp: '10.66.66.1',
      endpointHost: '192.168.1.10',
      joinCode: 'secret-code',
      mtu: 1420,
      interfaceName: 'dshwg0',
      dns: '',
    });
    const client = generateKeyPair();
    await service.joinPeer({ name: 'manual-client', publicKey: client.publicKey, code: 'secret-code', platform: 'linux' });

    const result = await service.setPeerEgress({ publicKey: client.publicKey, enabled: true });
    assert.equal(result.applied, false);
    assert.match(result.reason, /SSH/);
    assert.match(result.manual.enable, /^sudo sh -c '/);
    assert.match(result.manual.enable, /0\.0\.0\.0\/0/);
    assert.match(result.manual.disable, /10\.66\.66\.0\/24/);
    assert.ok(result.manual.enable.includes('10.66.66.1'));
    const peer = result.state.server.peers.find((candidate) => candidate.publicKey === client.publicKey);
    assert.ok(peer);
    assert.equal(peer.egress, true);
    assert.ok(calls.some((call) => call.args.includes('hub') && call.args.includes('10.66.66.2')));

    const login = await fetch(`http://127.0.0.1:${port}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'secret-code' }).toString(),
      redirect: 'manual',
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const page = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie } });
    const html = await page.text();
    assert.match(html, /通过 hub 出网/);
    assert.match(html, /data-egress-key=/);
    assert.match(html, /该成员未配置 SSH/);

    const toggle = await fetch(`http://127.0.0.1:${port}/peers/egress`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ publicKey: client.publicKey, enabled: false }),
    });
    assert.equal(toggle.status, 200);
    const toggled = await toggle.json();
    assert.equal(toggled.ok, true);
    assert.equal(toggled.applied, false);
    assert.match(toggled.manual.disable, /^sudo sh -c '/);
    await service.stopServer();
  }, {
    commandRunner: async (command: string, args: readonly string[]) => {
      calls.push({ command, args: [...args] });
      if (command.endsWith('ip')) {
        return { stdout: 'default via 192.168.1.1 dev eth0 proto dhcp metric 100\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
  });
});

test('Windows peers get a PowerShell manual command', async () => {
  await withService(async ({ service }) => {
    const port = await freePort();
    await service.startServer({
      controlPort: port,
      listenPort: 51820,
      vpnCidr: '10.66.66.0/24',
      serverIp: '10.66.66.1',
      endpointHost: '192.168.1.10',
      joinCode: 'secret-code',
      mtu: 1420,
      interfaceName: 'dshwg0',
      dns: '',
    });
    const client = generateKeyPair();
    await service.joinPeer({ name: 'windows-client', publicKey: client.publicKey, code: 'secret-code', platform: 'windows' });
    const result = await service.setPeerEgress({ publicKey: client.publicKey, enabled: true });
    assert.equal(result.applied, false);
    assert.match(result.manual.enable, /^powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand /);
    assert.match(result.manual.disable, /^powershell /);
    await service.stopServer();
  }, {
    commandRunner: async (command: string, args: readonly string[]) => {
      if (command.endsWith('ip')) {
        return { stdout: 'default via 192.168.1.1 dev eth0 proto dhcp metric 100\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
  });
});


test('a client join that carries egress writes 0.0.0.0/0 and a hub default route', async () => {
  const serverKeys = generateKeyPair();
  const fetchImpl = async (url: string) => {
    if (url.endsWith('/health')) {
      return new Response(JSON.stringify({
        ok: true,
        service: 'dsh-wireguard',
        publicKey: serverKeys.publicKey,
        vpnCidr: '10.66.66.0/24',
        listenPort: 51820,
        mtu: 1420,
        dns: '',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/join')) {
      return new Response(JSON.stringify({
        ok: true,
        egress: true,
        client: { ip: '10.66.66.2', address: '10.66.66.2/32', name: 'egress-client' },
        server: { publicKey: serverKeys.publicKey, endpoint: '192.168.1.10:51820', vpnCidr: '10.66.66.0/24', vpnIp: '10.66.66.1' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/leave')) {
      return new Response(JSON.stringify({ ok: true, removed: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dsh-wireguard-client-egress-test-'));
  const tunnel = fakeTunnel();
  const service = new WireGuardService({
    dataDir,
    platformFactory: async () => fakePlatform(),
    tunnelFactory: () => tunnel,
    fetchImpl,
    log: () => {},
  });
  await service.init();
  try {
    const state = await service.connectClient({ serverAddress: '192.168.1.10:51821', joinCode: 'secret' });
    assert.equal(state.client.egress, true);
    assert.equal(state.client.hubIp, '10.66.66.1');
    assert.equal(tunnel.clientInput.egress, true);
    assert.equal(tunnel.clientInput.hubIp, '10.66.66.1');
    const config = await readFile(path.join(dataDir, 'client.conf'), 'utf8');
    assert.match(config, /AllowedIPs = 0\.0\.0\.0\/0/);
    await service.disconnectClient();
  } finally {
    await service.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});


test('an SSH failure leaves the hub half applied and reports the member error', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  await withService(async ({ service }) => {
    const port = await freePort();
    await service.startServer({
      controlPort: port,
      listenPort: 51820,
      vpnCidr: '10.66.66.0/24',
      serverIp: '10.66.66.1',
      endpointHost: '192.168.1.10',
      joinCode: 'secret-code',
      mtu: 1420,
      interfaceName: 'dshwg0',
      dns: '',
    });
    const client = generateKeyPair();
    await service.joinPeer({ name: 'unreachable-client', publicKey: client.publicKey, code: 'secret-code', platform: 'linux' });
    await service.configurePeerSsh({ publicKey: client.publicKey, user: 'root', platform: 'linux' });

    const result = await service.setPeerEgress({ publicKey: client.publicKey, enabled: true });
    assert.equal(result.applied, false);
    assert.match(result.reason, /成员端自动配置失败/);
    assert.match(result.reason, /ssh timed out/);
    assert.match(result.manual.enable, /^sudo sh -c '/);
    const peer = result.state.server.peers.find((candidate) => candidate.publicKey === client.publicKey);
    assert.ok(peer);
    assert.equal(peer.egress, true);
    assert.ok(calls.some((call) => call.args.includes('hub') && call.args.includes('10.66.66.2')));
    await service.stopServer();
  }, {
    knownHosts: {
      refresh: async () => ['ssh-ed25519 AAAA'],
      forget: async () => {},
    },
    commandRunner: async (command: string, args: readonly string[]) => {
      calls.push({ command, args: [...args] });
      if (command.endsWith('ip')) return { stdout: 'default via 192.168.1.1 dev eth0\n', stderr: '' };
      return { stdout: '', stderr: '' };
    },
    sshRunner: async () => {
      throw new Error('ssh timed out');
    },
  });
});
