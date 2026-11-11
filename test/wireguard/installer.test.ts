import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installWireGuard } from '../../src/wireguard/lib/installer';
import type { PlatformInfo } from '../../src/wireguard/lib/platform';

function platform(overrides: Partial<PlatformInfo>): PlatformInfo {
  return {
    platform: 'linux',
    isWindows: false,
    isLinux: true,
    admin: true,
    wg: null,
    wireguard: null,
    ip: '/usr/sbin/ip',
    sudo: null,
    iptables: null,
    nft: null,
    sysctl: null,
    ...overrides,
  };
}

test('installation is a no-op when WireGuard is already present', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-wireguard-install-'));
  try {
    const outcome = await installWireGuard(platform({ wg: '/usr/bin/wg' }), dir, () => {});
    assert.equal(outcome.method, 'already-installed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installation reports an unsupported platform', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-wireguard-install-'));
  try {
    await assert.rejects(
      installWireGuard(platform({ platform: 'darwin', isLinux: false, wg: null }), dir, () => {}),
      (error: any) => error.code === 'unsupported_platform',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
