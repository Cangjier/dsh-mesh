import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { buildLinuxRehearseScript, initialDeploySteps } from '../code/deploy/engine.mjs'

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
 * A member tree: `app/current` is the version being upgraded, `app/releases/next`
 * is the extracted new package.
 * @param {string} dir scratch directory.
 * @param {{withDeploy?: boolean}} [options] fixtures to include.
 * @returns {Promise<{app: string, plan: object}>} layout and plan.
 */
async function memberTree(dir, options = {}) {
  const app = path.join(dir, 'app')
  const current = path.join(app, 'releases', 'old')
  const next = path.join(app, 'releases', 'next')
  await mkdir(path.join(current, 'plugins', 'dsh-mesh'), { recursive: true })
  await writeFile(path.join(current, 'plugins', 'dsh-mesh', 'package.json'), JSON.stringify({ name: '@local/dsh-mesh', version: '0.9.0' }), 'utf8')
  await writeFile(path.join(current, 'plugins', 'dsh-mesh', 'index.js'), '// old\n', 'utf8')
  await symlink(current, path.join(app, 'current'))

  await mkdir(path.join(next, 'plugins', 'dsh-mesh'), { recursive: true })
  await mkdir(path.join(next, 'plugins', 'xl'), { recursive: true })
  await writeFile(path.join(next, 'plugins', 'dsh-mesh', 'package.json'), JSON.stringify({ name: '@local/dsh-mesh', version: '0.9.9' }), 'utf8')
  await writeFile(path.join(next, 'plugins', 'dsh-mesh', 'index.js'), '// new\n', 'utf8')
  await writeFile(path.join(next, 'plugins', 'xl', 'package.json'), JSON.stringify({ name: 'xl' }), 'utf8')
  await writeFile(path.join(next, 'manifest.json'), JSON.stringify({ version: '0.9.9' }), 'utf8')
  await writeFile(path.join(next, 'start.sh'), '#!/usr/bin/env bash\n', 'utf8')
  if (options.withDeploy !== false) {
    await mkdir(path.join(next, 'code', 'deploy'), { recursive: true })
    await cp(path.join(repository, 'code', 'deploy', 'upgrade-local.sh'), path.join(next, 'code', 'deploy', 'upgrade-local.sh'))
    await cp(path.join(repository, 'code', 'deploy', 'wire-profile.mjs'), path.join(next, 'code', 'deploy', 'wire-profile.mjs'))
  }
  return {
    app,
    plan: {
      host: '127.0.0.1',
      os: 'linux',
      appRoot: app,
      releases: path.join(app, 'releases'),
      release: 'next',
      services: [],
      sudo: false,
    },
  }
}

test('the rehearsal runs the flat upgrade against a sandbox built from the current version', async () => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) return
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-rehearse-'))
  try {
    const { app, plan } = await memberTree(dir)
    const bin = await stubBin(dir)
    const result = await run('bash', ['-c', buildLinuxRehearseScript(plan)], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    })
    assert.match(result.stdout, /演练通过/u)
    // The backup holds the pre-upgrade file and the sandbox was removed.
    assert.match(result.stdout, /备份与覆盖都按升级前的状态逐字节核对过/u)
    assert.equal(existsSync(path.join(app, '..', '.dsh-mesh-test', 'next')), false)
    // The member's own install is untouched.
    assert.equal(JSON.parse(await readFile(path.join(app, 'current', 'plugins', 'dsh-mesh', 'package.json'), 'utf8')).version, '0.9.0')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the rehearsal fails before touching anything when the package has no flat upgrade script', async () => {
  if (process.platform !== 'linux') return
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-rehearse-nofix-'))
  try {
    const { app, plan } = await memberTree(dir, { withDeploy: false })
    const bin = await stubBin(dir)
    await assert.rejects(
      run('bash', ['-c', buildLinuxRehearseScript(plan)], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      }),
      /没有 code\/deploy\/upgrade-local\.sh/u,
    )
    assert.equal(existsSync(path.join(app, '..', '.dsh-mesh-test', 'next')), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a test job reports the rehearsal step between prepare and activate', () => {
  assert.deepEqual(initialDeploySteps().map(step => step.key), ['upload', 'prepare', 'activate'])
  assert.deepEqual(initialDeploySteps({ test: true }).map(step => step.key), ['upload', 'prepare', 'rehearse', 'activate'])
})
