import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { forgetKnownHosts, parseScannedHostKeys } from '../../src/wireguard/lib/known-hosts'

test('scanned host keys keep only key lines', () => {
  const keys = parseScannedHostKeys('# 10.66.66.4:22 SSH-2.0-OpenSSH_9.5\r\n10.66.66.4 ssh-ed25519 AAAA\n\n10.66.66.4 ssh-rsa BBBB\n')
  assert.deepEqual(keys, ['10.66.66.4 ssh-ed25519 AAAA', '10.66.66.4 ssh-rsa BBBB'])
})

test('forgetting an address keeps the other hosts', async (t) => {
  if (spawnSync('ssh-keygen', ['-h'], { stdio: 'ignore' }).error !== undefined) {
    t.skip('ssh-keygen is not installed')
    return
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'known-hosts-'))
  try {
    const file = path.join(dir, 'known_hosts')
    await writeFile(file, [
      '10.66.66.4 ssh-ed25519 AAAAstale',
      '10.66.66.2 ssh-ed25519 AAAAother',
      '',
    ].join('\n'))
    await forgetKnownHosts('10.66.66.4', 22, { file })
    const text = await readFile(file, 'utf8')
    assert.doesNotMatch(text, /10\.66\.66\.4/u)
    assert.match(text, /10\.66\.66\.2/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
