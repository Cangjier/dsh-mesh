import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const repository = path.join(path.dirname(new URL(import.meta.url).pathname), '..')

/**
 * Write a file after creating its parent directory.
 * @param {string} file destination.
 * @param {string} content content.
 * @returns {Promise<void>}
 */
async function write(file, content) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content, 'utf8')
}

/**
 * A flat install plus the new package that replaces it.
 *
 * The three runtime layers (`app`, `runtime`, `web`) are the point: before
 * 2026-11-17 the upgrade did not back them up, so a rollback restored old
 * tooling on top of the new runtime and the page stayed broken.
 * @param {string} dir scratch directory.
 * @returns {Promise<{root: string, stage: string, home: string}>} fixture paths.
 */
async function flatInstall(dir) {
  const root = path.join(dir, 'root')
  const stage = path.join(dir, 'stage')
  const home = path.join(dir, 'home')

  await write(path.join(home, 'profiles', 'web', 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2))
  await write(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), '# old profile\n')

  // The installed version.
  await write(path.join(root, 'config', 'gate.env'), `DSH_GATE_PORT=18080\nDSH_GATE_PASSWORD=test\nDSH_HOME=${home}\n`)
  await write(path.join(root, 'plugins', 'dsh-mesh', 'package.json'), JSON.stringify({ name: '@local/dsh-mesh', version: '1.0.0' }))
  await write(path.join(root, 'plugins', 'dsh-mesh', 'index.js'), '// old plugin\n')
  await write(path.join(root, 'app', 'release.txt'), 'old app\n')
  await write(path.join(root, 'web', 'release.txt'), 'old web\n')
  await write(path.join(root, 'manifest.json'), JSON.stringify({ version: '1.0.0' }))
  await write(path.join(root, 'VERSION'), '1.0.0\n')
  await write(path.join(root, 'start.sh'), '#!/usr/bin/env bash\nexit 0\n')
  await mkdir(path.join(root, 'runtime', 'node', 'bin'), { recursive: true })
  await symlink(process.execPath, path.join(root, 'runtime', 'node', 'bin', 'node'))

  // The package that replaces it.
  await write(path.join(stage, 'manifest.json'), JSON.stringify({ version: '2.0.0' }))
  await write(path.join(stage, 'VERSION'), '2.0.0\n')
  await write(path.join(stage, 'start.sh'), '#!/usr/bin/env bash\nexit 0\n')
  await write(path.join(stage, 'plugins', 'dsh-mesh', 'package.json'), JSON.stringify({ name: '@local/dsh-mesh', version: '2.0.0' }))
  await write(path.join(stage, 'plugins', 'dsh-mesh', 'index.js'), '// new plugin\n')
  await write(path.join(stage, 'app', 'release.txt'), 'new app\n')
  await write(path.join(stage, 'web', 'release.txt'), 'new web\n')
  await mkdir(path.join(stage, 'runtime', 'node', 'bin'), { recursive: true })
  await symlink(process.execPath, path.join(stage, 'runtime', 'node', 'bin', 'node'))
  return { root, stage, home }
}

/**
 * PATH entries that keep the rollback from touching the host.
 * @param {string} dir scratch directory.
 * @returns {Promise<string>} bin directory.
 */
async function stubBin(dir) {
  const bin = path.join(dir, 'bin')
  await mkdir(bin, { recursive: true })
  for (const name of ['systemctl', 'curl', 'sleep']) {
    const file = path.join(bin, name)
    await writeFile(file, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(file, 0o755)
  }
  return bin
}

test('flat rollback restores app, runtime and web, not just the tooling', async (t) => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    t.skip('the flat upgrade script needs Linux and root')
    return
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-flat-rollback-'))
  try {
    const { root, stage, home } = await flatInstall(dir)
    const upgraded = await run('bash', [
      path.join(repository, 'code', 'deploy', 'upgrade-local.sh'),
      '--app-root', root,
      '--stage', stage,
      '--dsh-home', home,
      '--port', '18080',
      '--no-restart',
    ])
    assert.match(upgraded.stdout, /升级完成|--no-restart/u)
    assert.equal(await readFile(path.join(root, 'app', 'release.txt'), 'utf8'), 'new app\n')
    assert.equal(await readFile(path.join(root, 'web', 'release.txt'), 'utf8'), 'new web\n')

    const backups = await readdir(path.join(root, '.upgrade-backup'))
    assert.equal(backups.length, 1)
    const backup = path.join(root, '.upgrade-backup', backups[0])
    // The backup has to carry every layer the overlay replaced.
    for (const layer of ['app', 'runtime', 'web', 'plugins']) {
      assert.equal(existsSync(path.join(backup, layer)), true, `backup is missing ${layer}`)
    }
    assert.equal(await readFile(path.join(backup, 'app', 'release.txt'), 'utf8'), 'old app\n')
    assert.equal(await readFile(path.join(backup, 'web', 'release.txt'), 'utf8'), 'old web\n')

    // The real upgrade writes this marker right before restarting; --no-restart
    // skips that, so write the same shape by hand for the rollback half.
    await write(path.join(root, 'data', 'upgrade-pending.json'), JSON.stringify({
      format: 1,
      status: 'pending',
      layout: 'flat',
      root,
      backup,
      from: '1.0.0',
      to: '2.0.0',
      port: 18080,
      dshHome: home,
    }, null, 2))

    const bin = await stubBin(dir)
    await run('bash', [path.join(repository, 'code', 'deploy', 'rollback-local.sh'), '--root', root], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    })

    assert.equal(await readFile(path.join(root, 'app', 'release.txt'), 'utf8'), 'old app\n')
    assert.equal(await readFile(path.join(root, 'web', 'release.txt'), 'utf8'), 'old web\n')
    assert.equal(await readFile(path.join(root, 'VERSION'), 'utf8'), '1.0.0\n')
    assert.equal(existsSync(path.join(root, 'runtime', 'node', 'bin', 'node')), true)
    assert.equal(existsSync(path.join(root, 'data', 'upgrade-pending.json')), false)
    assert.match(await readFile(path.join(root, 'data', 'upgrade-rollback.log'), 'utf8'), /rolled back to 1\.0\.0/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rollback warns when the backup predates the runtime layers', async (t) => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    t.skip('the flat upgrade script needs Linux and root')
    return
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-flat-old-backup-'))
  try {
    const { root, home } = await flatInstall(dir)
    const backup = path.join(root, '.upgrade-backup', '20260101-000000')
    // The pre-fix backup shape: tooling only.
    await write(path.join(backup, 'manifest.json'), JSON.stringify({ version: '1.0.0' }))
    await write(path.join(backup, 'config', 'gate.env'), `DSH_GATE_PORT=18080\nDSH_GATE_PASSWORD=test\nDSH_HOME=${home}\n`)
    await write(path.join(root, 'data', 'upgrade-pending.json'), JSON.stringify({
      status: 'pending',
      layout: 'flat',
      root,
      backup,
      from: '1.0.0',
      to: '2.0.0',
      port: 18080,
      dshHome: home,
    }, null, 2))
    const bin = await stubBin(dir)
    await run('bash', [path.join(repository, 'code', 'deploy', 'rollback-local.sh'), '--root', root], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    })
    const log = await readFile(path.join(root, 'data', 'upgrade-rollback.log'), 'utf8')
    assert.match(log, /备份缺少 app/u)
    assert.match(log, /运行时仍是新版本/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
