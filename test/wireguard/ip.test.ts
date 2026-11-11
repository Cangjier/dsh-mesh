import assert from 'node:assert/strict';
import test from 'node:test';
import { allocatePeerIp, defaultServerIp, ipv4ToString, isUsableHost, parseCidr, parseIpv4 } from '../../src/wireguard/lib/ip';

test('parses and normalizes IPv4 CIDR input', () => {
  const cidr = parseCidr('10.66.66.99/24');
  assert.ok(cidr);
  assert.equal(cidr.normalized, '10.66.66.0/24');
  assert.equal(ipv4ToString(cidr.network), '10.66.66.0');
  assert.equal(ipv4ToString(cidr.broadcast), '10.66.66.255');
  assert.equal(defaultServerIp(cidr), '10.66.66.1');
});

test('rejects malformed or too-small subnets', () => {
  assert.equal(parseCidr('10.0.0.0/31'), null);
  assert.equal(parseCidr('10.0.0.256/24'), null);
  assert.equal(parseCidr('not-a-subnet'), null);
  assert.equal(parseIpv4('192.168.1.1'), 3232235777);
  assert.equal(parseIpv4('192.168.1.999'), null);
});

test('allocates the lowest free usable address and skips the server', () => {
  const cidr = parseCidr('10.66.66.0/29');
  assert.ok(cidr);
  assert.ok(isUsableHost(parseIpv4('10.66.66.2'), cidr));
  assert.equal(allocatePeerIp(cidr, [], '10.66.66.1'), '10.66.66.2');
  assert.equal(allocatePeerIp(cidr, ['10.66.66.2', '10.66.66.3'], '10.66.66.1'), '10.66.66.4');
  assert.equal(allocatePeerIp(cidr, ['10.66.66.2', '10.66.66.3', '10.66.66.4', '10.66.66.5', '10.66.66.6'], '10.66.66.1'), null);
});

test('does not allocate the network or broadcast address', () => {
  const cidr = parseCidr('192.168.50.0/30');
  assert.ok(cidr);
  assert.equal(allocatePeerIp(cidr, [], '192.168.50.1'), '192.168.50.2');
  assert.equal(allocatePeerIp(cidr, ['192.168.50.2'], '192.168.50.1'), null);
});
