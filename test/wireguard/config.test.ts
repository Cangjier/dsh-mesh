import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClientConfig, buildServerConfig, formatEndpointHost, normalizeEndpointHost, normalizeSettings, parseServerAddress } from '../../src/wireguard/lib/config';
import { parseCidr } from '../../src/wireguard/lib/ip';

test('normalizes a complete server configuration', () => {
  const { settings, cidr } = normalizeSettings({
    controlPort: '51821',
    listenPort: '51820',
    vpnCidr: '10.20.0.0/24',
    serverIp: '10.20.0.1',
    mtu: '1380',
    interfaceName: 'wgmesh0',
    endpointHost: 'http://192.168.1.10:51821',
    joinCode: 'home-vpn',
    dns: '1.1.1.1, 8.8.8.8',
  });
  assert.equal(settings.controlPort, 51821);
  assert.equal(settings.listenPort, 51820);
  assert.equal(settings.endpointHost, '192.168.1.10');
  assert.equal(cidr.normalized, '10.20.0.0/24');
});

test('rejects out-of-subnet server addresses and invalid ports', () => {
  assert.throws(() => normalizeSettings({ vpnCidr: '10.20.0.0/24', serverIp: '10.21.0.1' }), /usable host/);
  assert.throws(() => normalizeSettings({ controlPort: 80 }), /controlPort/);
  assert.throws(() => normalizeSettings({ vpnCidr: '10.20.0.0/31' }), /CIDR/);
});

test('renders a server config with a peer and no private-key leakage into command lines', () => {
  const { settings, cidr } = normalizeSettings({ endpointHost: '192.168.1.10' });
  const text = buildServerConfig({
    privateKey: Buffer.alloc(32, 7).toString('base64'),
    settings,
    cidr,
    peers: [{ publicKey: Buffer.alloc(32, 9).toString('base64'), ip: '10.66.66.2' }],
  });
  assert.match(text, /\[Interface\]/);
  assert.match(text, /Address = 10\.66\.66\.1\/24/);
  assert.match(text, /AllowedIPs = 10\.66\.66\.2\/32/);
});

test('renders a client config that only routes the VPN subnet', () => {
  const { settings } = normalizeSettings({ endpointHost: '192.168.1.10', dns: '1.1.1.1' });
  const text = buildClientConfig({
    privateKey: Buffer.alloc(32, 5).toString('base64'),
    address: '10.66.66.2',
    settings,
    serverPublicKey: Buffer.alloc(32, 6).toString('base64'),
    endpoint: '192.168.1.10:51820',
    vpnCidr: '10.66.66.0/24',
  });
  assert.match(text, /Address = 10\.66\.66\.2\/32/);
  assert.match(text, /AllowedIPs = 10\.66\.66\.0\/24/);
  assert.match(text, /PersistentKeepalive = 25/);
  assert.doesNotMatch(text, /0\.0\.0\.0\/0/);
});

test('parses bare hosts, ports, and control URLs', () => {
  assert.deepEqual(parseServerAddress('192.168.1.10'), {
    host: '192.168.1.10', port: 51821, controlUrl: 'http://192.168.1.10:51821', display: '192.168.1.10:51821',
  });
  assert.equal(parseServerAddress('192.168.1.10:6000').controlUrl, 'http://192.168.1.10:6000');
  assert.equal(parseServerAddress('http://vpn-box.lan:51821/').host, 'vpn-box.lan');
  assert.throws(() => parseServerAddress('http://192.168.1.10/path'), /path/);
});

test('server address parsing uses the selected default port', () => {
  assert.equal(parseServerAddress('192.168.1.10', 6000).port, 6000);
});

test('accepts IPv6 transport endpoints while keeping the VPN subnet IPv4', () => {
  assert.equal(normalizeEndpointHost('[2408:400a:109:bf00::1]:51821'), '2408:400a:109:bf00::1');
  assert.equal(normalizeEndpointHost('2408:400a:109:bf00::1'), '2408:400a:109:bf00::1');
  assert.equal(formatEndpointHost('2408:400a:109:bf00::1'), '[2408:400a:109:bf00::1]');

  assert.deepEqual(parseServerAddress('[2408:400a:109:bf00::1]:51821'), {
    host: '2408:400a:109:bf00::1',
    port: 51821,
    controlUrl: 'http://[2408:400a:109:bf00::1]:51821',
    display: '[2408:400a:109:bf00::1]:51821',
  });
  assert.equal(parseServerAddress('2408:400a:109:bf00::1', 6000).controlUrl, 'http://[2408:400a:109:bf00::1]:6000');

  const { settings } = normalizeSettings({
    vpnCidr: '10.66.66.0/24',
    endpointHost: '[2408:400a:109:bf00::1]:51821',
  });
  assert.equal(settings.endpointHost, '2408:400a:109:bf00::1');
  assert.equal(settings.vpnCidr, '10.66.66.0/24');
});
