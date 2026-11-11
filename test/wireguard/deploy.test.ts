import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { Snapshot } from '../../src/client/wireguard/api';
import { buildLinuxClientCommand, buildLinuxClientSimpleCommand, LINUX_CLIENT_RESTART_COMMAND } from '../../src/client/wireguard/deploy';
import { LINUX_CLIENT_SCRIPT } from '../../src/wireguard/lib/client-script';

function runningState(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    ok: true,
    version: '0.2.0',
    service: 'dsh-wireguard',
    role: 'server',
    hostname: 'server',
    platform: { id: 'linux', label: 'Linux' },
    tools: { ready: true, admin: true, wg: true, wireguard: false, ip: true, missing: [] },
    settings: {
      controlPort: 51821,
      listenPort: 51820,
      vpnCidr: '10.66.66.0/24',
      serverIp: '10.66.66.1',
      mtu: 1420,
      interfaceName: 'dshwg0',
      endpointHost: 'vpn.example.com',
      joinCode: 'secret-code',
      dns: '',
    },
    server: {
      running: true,
      startedAt: null,
      publicKey: 'server-key',
      publicKeyFingerprint: 'server-key',
      endpoint: 'vpn.example.com:51820',
      endpointHost: 'vpn.example.com',
      controlUrl: 'http://vpn.example.com:51821',
      controlPort: 51821,
      listenPort: 51820,
      vpnCidr: '10.66.66.0/24',
      interfaceName: 'dshwg0',
      mtu: 1420,
      dns: '',
      peers: [],
      warnings: [],
      forwarding: null,
      joinRequired: true,
      controlAvailable: true,
    },
    deployment: {
      ipv4: { available: true, controlUrl: 'http://vpn.example.com:51821', endpoint: 'vpn.example.com:51820' },
      ipv6: { available: true, controlUrl: 'http://[2408:400a:109:bf00::1]:51821', endpoint: '[2408:400a:109:bf00::1]:51820' },
    },
    client: {
      connected: false,
      pending: false,
      publicKey: null,
      publicKeyFingerprint: '',
      name: null,
      serverUrl: null,
      serverHost: null,
      assignedIp: null,
      serverPublicKey: null,
      vpnCidr: null,
      endpoint: null,
      interfaceName: null,
      mtu: 1420,
      connectedAt: null,
      lastHandshakeAt: null,
      receivedBytes: 0,
      sentBytes: 0,
      lastError: null,
      warnings: [],
      configured: false,
    },
    lastError: null,
    logs: [],
    ...overrides,
  };
}

test('static client script is portable, parameterized, and contains no secrets', () => {
  assert.match(LINUX_CLIENT_SCRIPT, /^#!\/bin\/sh\n/);
  assert.match(LINUX_CLIENT_SCRIPT, /set -eu/);
  assert.match(LINUX_CLIENT_SCRIPT, /CONTROL_URL=\$1/);
  assert.match(LINUX_CLIENT_SCRIPT, /JOIN_CODE=\$2/);
  assert.match(LINUX_CLIENT_SCRIPT, /Usage: \$0 <control-url> <join-code>/);
  assert.match(LINUX_CLIENT_SCRIPT, /Run this script as root/);
  assert.doesNotMatch(LINUX_CLIENT_SCRIPT, /exec sudo sh/);
  for (const manager of ['apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'apk']) {
    assert.match(LINUX_CLIENT_SCRIPT, new RegExp(manager));
  }
  assert.match(LINUX_CLIENT_SCRIPT, /Unknown package manager/);
  assert.match(LINUX_CLIENT_SCRIPT, /wg-quick up "\$IFACE"/);
  assert.match(LINUX_CLIENT_SCRIPT, /AllowedIPs = \$VPN_CIDR/);
  assert.match(LINUX_CLIENT_SCRIPT, /PersistentKeepalive = 25/);
  assert.doesNotMatch(LINUX_CLIENT_SCRIPT, /secret-code|vpn\.example\.com/);
  assert.doesNotMatch(LINUX_CLIENT_SCRIPT, /\$\{/);

  const syntax = spawnSync('sh', ['-n'], { input: LINUX_CLIENT_SCRIPT, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('one-line command downloads, chmods, runs, and removes the static script', () => {
  const state = runningState();
  const command = buildLinuxClientCommand(state);
  assert.equal(command.includes('\n'), false);
  assert.match(command, /curl -fsSL --connect-timeout 10 --max-time 30 'http:\/\/vpn\.example\.com:51821\/client\.sh' -o "\$f"/);
  assert.match(command, /wget -qO "\$f" -T 20/);
  assert.match(command, /mktemp \/tmp\/dsh-wg-client\.XXXXXX/);
  assert.match(command, /chmod 700 "\$f" && \$S sh "\$f"/);
  assert.match(command, /'http:\/\/vpn\.example\.com:51821' 'secret-code' 'ipv4'/);
  assert.match(command, /rm -f "\$f"/);

  const syntax = spawnSync('sh', ['-n'], { input: command, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('falls back to the advertised host when controlUrl is missing', () => {
  const base = runningState();
  const command = buildLinuxClientCommand({
    ...base,
    server: { ...base.server, controlUrl: null },
  });
  assert.match(command, /curl -fsSL --connect-timeout 10 --max-time 30 'http:\/\/vpn\.example\.com:51821\/client\.sh'/);
  assert.match(command, /'http:\/\/vpn\.example\.com:51821' 'secret-code' 'ipv4'/);
});

test('simple command uses curl and sudo, then chmods and runs the script', () => {
  const command = buildLinuxClientSimpleCommand(runningState());
  assert.equal(command.includes('\n'), false);
  assert.match(command, /^S=""; \[ "\$\(id -u\)" -ne 0 \] && S="sudo"; curl -fsSL --connect-timeout 10 --max-time 30 'http:\/\/vpn\.example\.com:51821\/client\.sh' -o \/tmp\/dsh-wg-client\.sh/);
  assert.match(command, /chmod 700 \/tmp\/dsh-wg-client\.sh && \$S sh \/tmp\/dsh-wg-client\.sh/);
  assert.match(command, /'http:\/\/vpn\.example\.com:51821' 'secret-code' 'ipv4'/);
  assert.doesNotMatch(command, /wget|mktemp/);

  const syntax = spawnSync('sh', ['-n'], { input: command, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('client reconnect command restarts the tunnel and shows status', () => {
  assert.match(LINUX_CLIENT_RESTART_COMMAND, /sudo wg-quick down dshwg0/);
  assert.match(LINUX_CLIENT_RESTART_COMMAND, /sudo wg-quick up dshwg0/);
  assert.match(LINUX_CLIENT_RESTART_COMMAND, /sudo wg show dshwg0/);
  const syntax = spawnSync('sh', ['-n'], { input: LINUX_CLIENT_RESTART_COMMAND, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('keeps bracketed IPv6 endpoints intact in the deployment command', () => {
  const base = runningState();
  const command = buildLinuxClientCommand({
    ...base,
    server: {
      ...base.server,
      controlUrl: 'http://[2408:400a:109:bf00::1]:51821',
      endpointHost: '2408:400a:109:bf00::1',
    },
  });
  assert.match(command, /'http:\/\/\[2408:400a:109:bf00::1\]:51821\/client\.sh'/);
  assert.match(command, /'http:\/\/\[2408:400a:109:bf00::1\]:51821' 'secret-code'/);
});
