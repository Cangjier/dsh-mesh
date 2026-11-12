import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildSshAuthorizeCommand, buildWindowsSshAuthorizeCommand } from '../../src/wireguard/lib/ssh';

test('SSH authorize command installs only the public key for the chosen user', () => {
  const command = buildSshAuthorizeCommand('ubuntu', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest dsh-wireguard@host');
  assert.match(command, /u='ubuntu'/);
  assert.match(command, /grep -qxF/);
  assert.match(command, /ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest/);
  assert.match(command, /authorized_keys/);
  assert.doesNotMatch(command, /PRIVATE KEY/);
  assert.doesNotMatch(command, /dsh-wireguard@host/);
  // The same paste also turns on BBR + fq; cubic collapses on high-latency links.
  assert.match(command, /99-dsh-mesh-net\.conf/);
  assert.match(command, /net\.ipv4\.tcp_congestion_control=bbr/);
  assert.match(command, /net\.core\.default_qdisc=fq/);
  assert.match(command, /tcp_available_congestion_control/);

  const syntax = spawnSync('sh', ['-n'], { input: command, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('rejects a malformed SSH public key', () => {
  assert.throws(() => buildSshAuthorizeCommand('root', 'not-a-key'), /public key/);
});

test('Windows SSH command targets the administrator file and is PowerShell encoded', () => {
  const command = buildWindowsSshAuthorizeCommand('Administrator', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest dsh-wireguard@host');
  assert.match(command, /^powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand /);
  const encoded = command.split(' ').at(-1);
  assert.ok(encoded);
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.match(script, /administrators_authorized_keys/);
  assert.match(script, /C:\\Users/);
  assert.match(script, /'Administrator'/);
  assert.match(script, /ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest/);
  assert.doesNotMatch(script, /PRIVATE KEY/);
});

test('Windows SSH command rejects an invalid username', () => {
  assert.throws(
    () => buildWindowsSshAuthorizeCommand('bad user', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest dsh-wireguard@host'),
    /username/,
  );
});
