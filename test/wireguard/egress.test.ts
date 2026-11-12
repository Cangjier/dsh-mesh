import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  buildLinuxEgressCommand,
  buildLinuxEgressScript,
  buildManualEgressCommands,
  buildWindowsEgressCommand,
  buildWindowsEgressScript,
} from '../../src/wireguard/lib/egress';

const base = {
  enabled: true,
  interfaceName: 'dshwg0',
  hubIp: '10.66.66.1',
  hubKey: 'kZ6v+5cJm8kA0h1T2X3y4Z5a6B7c8D9e0F1g2H3i4J=',
  vpnCidr: '10.66.66.0/24',
} as const;

test('Linux egress command is a single copy-paste line with the real hub values', () => {
  const command = buildLinuxEgressCommand({ ...base, platform: 'linux' });
  assert.equal(command.includes('\n'), false);
  assert.match(command, /^sudo sh -c '/);
  assert.match(command, /CONF=\/etc\/wireguard\/dshwg0\.conf/);
  assert.match(command, /HUB_IP=10\.66\.66\.1/);
  assert.ok(command.includes(base.hubKey));
  assert.match(command, /AllowedIPs = 0\.0\.0\.0\/0/);
  assert.match(command, /wg set "\$IF" peer "\$HUB_KEY" allowed-ips 0\.0\.0\.0\/0/);
  assert.match(command, /ip route replace default via "\$HUB_IP" dev "\$IF" metric 50/);
  assert.match(command, /\/etc\/systemd\/system\/dsh-mesh-egress\.service/);
  assert.match(command, /systemctl enable --now dsh-mesh-egress\.service/);
  const syntax = spawnSync('sh', ['-n'], { input: command, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('Linux disable command restores the VPN subnet and removes the unit', () => {
  const command = buildLinuxEgressCommand({ ...base, enabled: false, platform: 'linux' });
  assert.equal(command.includes('\n'), false);
  assert.match(command, /AllowedIPs = \$VPN_CIDR/);
  assert.match(command, /wg set "\$IF" peer "\$HUB_KEY" allowed-ips "\$VPN_CIDR"/);
  assert.match(command, /ip route del default via "\$HUB_IP" dev "\$IF"/);
  assert.match(command, /systemctl disable --now dsh-mesh-egress\.service/);
  assert.match(command, /rm -f "\$UNIT"/);
  const syntax = spawnSync('sh', ['-n'], { input: command, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('Linux script leaves the unit file exactly like egress-via-hub.sh member', () => {
  const script = buildLinuxEgressScript({ ...base, platform: 'linux' });
  assert.equal(script.includes("'"), false, 'the body must stay single-quote free for the SSH/manual wrapper');
  assert.match(script, /ExecStart=\/bin\/sh -c \\047wg set dshwg0 peer/);
  assert.match(script, /ExecStop=\/bin\/sh -c \\047ip route del default via 10\.66\.66\.1/);
  assert.match(script, /WantedBy=multi-user\.target/);
});

test('Windows egress command encodes a PowerShell script with the Windows paths', () => {
  const command = buildWindowsEgressCommand({ ...base, platform: 'windows' });
  assert.equal(command.includes('\n'), false);
  assert.match(command, /^powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/);
  const encoded = command.split(' ').pop() ?? '';
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.match(script, /C:\\ProgramData\\WireGuard\\dshwg0\.conf/);
  assert.match(script, /C:\\Program Files\\WireGuard\\wg\.exe/);
  assert.match(script, /wireguard\.exe/);
  assert.match(script, /AllowedIPs = 0\.0\.0\.0\/0/);
  assert.ok(script.includes(base.hubKey));
  assert.match(script, /\/installtunnelservice \$conf/);

  const disabled = buildWindowsEgressScript({ ...base, enabled: false, platform: 'windows' });
  assert.match(disabled, /AllowedIPs = 10\.66\.66\.0\/24/);
});

test('manual fallback picks the peer platform', () => {
  const linux = buildManualEgressCommands({ ...base, platform: 'linux' });
  assert.match(linux.enable, /^sudo sh -c '/);
  assert.match(linux.disable, /^sudo sh -c '/);
  const windows = buildManualEgressCommands({ ...base, platform: 'windows' });
  assert.match(windows.enable, /^powershell /);
  assert.match(windows.disable, /^powershell /);
});
