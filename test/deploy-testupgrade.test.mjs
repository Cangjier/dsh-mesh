import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { buildLinuxRehearseScript, initialDeploySteps } from '../code/deploy/engine.mjs'
import { assertTestUpgradeTarget } from '../src/lib/service.mjs'

const run = promisify(execFile)
const here = path.dirname(new URL(import.meta.url).pathname)
const repository = path.join(here, '..')

/**
 * A PATH with `node` (the rehearsal falls back to it) and stubs for anything
 * that would touch the host.
 * @param {string} dir scratch directory.
 * @returns {Promise<string>} bin directory.
 */
async function stubBin(dir) {
  const bin = path.join(dir, 'bin')
  await mkdir(bin, { recursive: true })
  await symlink(process.execPath, path.join(bin, 'node'))
  for (const name of ['systemctl', 'curl', 'sleep']) {
    const file = path.join(bin, name)
    await writeFile(file, `#!/bin/sh\necho "stub ${name} $*" >&2\nexit 0\n`, 'utf8')
    await chmod(file, 0o755)
  }
  return bin
}

/**
 * Build a member and a deployment package to rehearse against.
 * @param {string} dir scratch directory.
 * @param {{packagedDeploy?: boolean, installedDeploy?: boolean, packagePlugins?: boolean}} [options] fixtures.
 * @returns {Promise<{app: string, plan: object, sandboxParent: string}>} layout and plan.
 */
async function memberTree(dir, options = {}) {
  const app = path.join(dir, 'app')
  const current = path.join(app, 'releases', 'old')
  const shared = path.join(app, 'shared')
  const profile = path.join(shared, 'home', 'profiles', 'web')
  const pkgDir = path.join(dir, 'pkg', 'dsh-mesh-9.9.9-linux-x64')

  // The member's current install (blue-green).
  await mkdir(path.join(current, 'plugins', 'dsh-mesh'), { recursive: true })
  await writeFile(path.join(current, 'plugins', 'dsh-mesh', 'package.json'), JSON.stringify({ name: '@local/dsh-mesh', version: '0.9.0' }), 'utf8')
  await writeFile(path.join(current, 'plugins', 'dsh-mesh', 'index.js'), '// old plugin\n', 'utf8')
  await writeFile(path.join(current, 'manifest.json'), JSON.stringify({ version: '0.9.0' }), 'utf8')
  await writeFile(path.join(current, 'start.sh'), '#!/usr/bin/env bash\n', 'utf8')
  await mkdir(path.join(current, 'gate'), { recursive: true })
  await writeFile(path.join(current, 'gate', 'server.mjs'), '// gate\n', 'utf8')
  // The installed plugin is where the gateway takes its upgrade script from.
  await mkdir(path.join(current, 'code'), { recursive: true })
  if (options.installedDeploy !== false) {
    const deploy = path.join(current, 'plugins', 'dsh-mesh', 'code', 'deploy')
    await mkdir(deploy, { recursive: true })
    await cp(path.join(repository, 'code', 'deploy', 'upgrade-local.sh'), path.join(deploy, 'upgrade-local.sh'))
    await cp(path.join(repository, 'code', 'deploy', 'wire-profile.mjs'), path.join(deploy, 'wire-profile.mjs'))
  }
  await symlink(current, path.join(app, 'current'))

  // The member's shared config and profile — the rehearsal must use these.
  await mkdir(path.join(shared, 'config'), { recursive: true })
  await writeFile(path.join(shared, 'config', 'gate.env'), 'DSH_GATE_PORT=80\nDSH_GATE_PASSWORD=member-secret\nDSH_HOME=/real/home\nDSH_TRUSTED_HOSTS=example\n', 'utf8')
  await mkdir(profile, { recursive: true })
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: { '@local/dsh-mesh': 'link:./node_modules/@local/dsh-mesh' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@local/dsh-mesh'] } },
  }, null, 2), 'utf8')
  await writeFile(path.join(profile, 'cordis.patch.yml'), '# keep\n', 'utf8')

  // The new package.
  await mkdir(path.join(pkgDir, 'plugins', 'dsh-mesh'), { recursive: true })
  await writeFile(path.join(pkgDir, 'manifest.json'), JSON.stringify({ version: '0.9.9' }), 'utf8')
  await writeFile(path.join(pkgDir, 'start.sh'), '#!/usr/bin/env bash\n', 'utf8')
  if (options.packagePlugins !== false) {
    await writeFile(path.join(pkgDir, 'plugins', 'dsh-mesh', 'package.json'), JSON.stringify({ name: '@local/dsh-mesh', version: '0.9.9' }), 'utf8')
    await writeFile(path.join(pkgDir, 'plugins', 'dsh-mesh', 'index.js'), '// new plugin\n', 'utf8')
    await mkdir(path.join(pkgDir, 'plugins', 'xl'), { recursive: true })
    await writeFile(path.join(pkgDir, 'plugins', 'xl', 'package.json'), JSON.stringify({ name: 'xl' }), 'utf8')
  }
  if (options.packagedDeploy !== false) {
    await mkdir(path.join(pkgDir, 'code', 'deploy'), { recursive: true })
    await cp(path.join(repository, 'code', 'deploy', 'upgrade-local.sh'), path.join(pkgDir, 'code', 'deploy', 'upgrade-local.sh'))
    await cp(path.join(repository, 'code', 'deploy', 'wire-profile.mjs'), path.join(pkgDir, 'code', 'deploy', 'wire-profile.mjs'))
  }
  const archive = path.join(dir, 'dsh-mesh-9.9.9-linux-x64.tar.gz')
  await run('tar', ['-czf', archive, '-C', path.join(dir, 'pkg'), path.basename(pkgDir)])
  return {
    app,
    archive,
    sandboxParent: path.join(app, '..', '.dsh-mesh-test'),
    plan: {
      host: '127.0.0.1',
      os: 'linux',
      appRoot: app,
      shared,
      releases: path.join(app, 'releases'),
      release: 'next',
      remotePackage: archive,
      services: [],
      sudo: false,
    },
  }
}

test('the rehearsal upgrades a sandbox built from the member and proves restore works', async () => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    test.skip('rehearsal needs Linux and root (the flat upgrade script requires both)')
    return
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-rehearse-'))
  try {
    const { app, plan, sandboxParent } = await memberTree(dir)
    const bin = await stubBin(dir)
    const result = await run('bash', ['-c', buildLinuxRehearseScript(plan)], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    })
    assert.match(result.stdout, /脚本来源：已安装插件/u)
    assert.match(result.stdout, /restore\(\) 已验证/u)
    assert.match(result.stdout, /演练通过/u)
    assert.equal(existsSync(sandboxParent), false)
    // The member's own install is untouched.
    assert.equal(JSON.parse(await readFile(path.join(app, 'current', 'plugins', 'dsh-mesh', 'package.json'), 'utf8')).version, '0.9.0')
    assert.match(await readFile(path.join(app, 'shared', 'config', 'gate.env'), 'utf8'), /DSH_HOME=\/real\/home/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the rehearsal falls back to the packaged script on a member installed before the fix', async () => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    test.skip('rehearsal needs Linux and root')
    return
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-rehearse-fallback-'))
  try {
    const { plan } = await memberTree(dir, { installedDeploy: false })
    const bin = await stubBin(dir)
    const result = await run('bash', ['-c', buildLinuxRehearseScript(plan)], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    })
    assert.match(result.stdout, /脚本来源：新包/u)
    assert.match(result.stdout, /演练通过/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a package that cannot do a flat upgrade fails the rehearsal and leaves the sandbox for inspection', async () => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    test.skip('rehearsal needs Linux and root')
    return
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-rehearse-bad-'))
  try {
    const { app, plan, sandboxParent } = await memberTree(dir, { packagePlugins: false })
    const bin = await stubBin(dir)
    await assert.rejects(
      run('bash', ['-c', buildLinuxRehearseScript(plan)], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      }),
      /演练失败/u,
    )
    // Kept for debugging, and the next run prunes it (asserted below).
    assert.equal(existsSync(path.join(sandboxParent, 'next')), true)
    // A good package run clears the leftover first, then succeeds.
    const goodDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-rehearse-good-'))
    const good = await memberTree(goodDir, {})
    const result = await run('bash', ['-c', buildLinuxRehearseScript(good.plan)], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    })
    assert.match(result.stdout, /演练通过/u)
    assert.equal(existsSync(good.sandboxParent), false)
    assert.equal(JSON.parse(await readFile(path.join(app, 'current', 'plugins', 'dsh-mesh', 'package.json'), 'utf8')).version, '0.9.0')
    await rm(goodDir, { recursive: true, force: true })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a test job reports the rehearsal step before prepare', () => {
  assert.deepEqual(initialDeploySteps().map(step => step.key), ['upload', 'prepare', 'activate'])
  assert.deepEqual(initialDeploySteps({ test: true }).map(step => step.key), ['upload', 'rehearse', 'prepare', 'activate'])
})

test('test upgrades are refused on this machine, on a platform mismatch, and without an install', () => {
  assert.throws(() => assertTestUpgradeTarget({ id: 'local', kind: 'self', name: 'gateway', dsh: true }, {}), /本机升级请直接用「升级」/u)
  assert.throws(() => assertTestUpgradeTarget({ id: '10.66.66.9', kind: 'peer', name: 'linux', dsh: true }, { packageOs: 'windows' }), /是 linux；换一个匹配的包/u)
  assert.throws(() => assertTestUpgradeTarget({ id: '10.66.66.4', kind: 'peer', name: 'win', dsh: true, system: { platform: 'win32' } }, { packageOs: 'linux' }), /是 windows；换一个匹配的包/u)
  assert.throws(() => assertTestUpgradeTarget({ id: '10.66.66.9', kind: 'peer', name: 'blank', dsh: false }, {}), /还没有安装 DSH/u)
  assert.equal(assertTestUpgradeTarget({ id: '10.66.66.3', kind: 'peer', name: 'ok', dsh: true }, { packageOs: 'linux' }).id, '10.66.66.3')
  // A Windows member is allowed with a Windows package; it simply has no step.
  assert.equal(assertTestUpgradeTarget({ id: '10.66.66.4', kind: 'peer', name: 'win', dsh: true, system: { platform: 'win32' } }, { packageOs: 'windows' }).id, '10.66.66.4')
})

test('a Windows test job has no rehearsal step (nothing flat to rehearse)', () => {
  assert.deepEqual(initialDeploySteps({ test: true, os: 'windows' }).map(step => step.key), ['upload', 'prepare', 'activate'])
  assert.deepEqual(initialDeploySteps({ test: true, os: 'linux' }).map(step => step.key), ['upload', 'rehearse', 'prepare', 'activate'])
})
