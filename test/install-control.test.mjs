import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'code', 'wireguard', 'install-control-service.sh')

/** A bin directory whose systemctl is a no-op. */
async function stubBin(dir) {
  const bin = path.join(dir, 'bin')
  await mkdir(bin, { recursive: true })
  const file = path.join(bin, 'systemctl')
  await writeFile(file, '#!/bin/sh\nexit 0\n', 'utf8')
  await chmod(file, 0o755)
  return bin
}

test('install-control-service survives an unset HOME when --dsh-home is given', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-control-'))
  try {
    const install = path.join(dir, 'wireguard')
    await mkdir(install, { recursive: true })
    await writeFile(path.join(install, 'start-control.sh'), '#!/bin/sh\n', 'utf8')
    const bin = await stubBin(dir)
    const unit = path.join(dir, 'dsh-wireguard-control.service')
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, DSH_WIREGUARD_UNIT_FILE: unit }
    delete env.HOME
    const result = spawnSync('bash', [script,
      '--root', install,
      '--dsh-home', path.join(dir, 'home'),
      '--node', process.execPath,
    ], { env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const envFile = await readFile(path.join(install, 'control-service.env'), 'utf8')
    assert.match(envFile, new RegExp(`DSH_HOME=${path.join(dir, 'home').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'))
    const unitText = await readFile(unit, 'utf8')
    assert.match(unitText, /WorkingDirectory=.*wireguard/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
