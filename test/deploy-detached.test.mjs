import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import {
  buildDeployPlan,
  DeployManager,
  jobPaths,
  LocalRunner,
  newJobId,
  normalizeInstallRoot,
  readDeployState,
  runnerStatus,
  writeDeployState,
} from '../code/deploy/engine.mjs'

const run = promisify(execFile)
const here = path.dirname(new URL(import.meta.url).pathname)

/** A deploy job directory with a state file and no live runner. */
async function seedJob(dir, state) {
  await mkdir(dir, { recursive: true })
  await writeDeployState(dir, state)
  return state
}

test('runnerStatus follows the runner pid, then the heartbeat', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-runner-status-'))
  try {
    // No runner file yet: the panel must not call that dead by itself.
    assert.equal((await runnerStatus(dir)).alive, false)
    // Our own pid is alive on this host.
    await writeFile(path.join(dir, 'runner.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), heartbeatAt: new Date().toISOString() }), 'utf8')
    assert.equal((await runnerStatus(dir)).alive, true)
    // A pid that cannot exist on this host is dead, even with a fresh beat.
    await writeFile(path.join(dir, 'runner.json'), JSON.stringify({ pid: 4_194_303, host: os.hostname(), heartbeatAt: new Date().toISOString() }), 'utf8')
    assert.equal((await runnerStatus(dir)).alive, false)
    // Another host is judged by its heartbeat: a job directory may be copied.
    await writeFile(path.join(dir, 'runner.json'), JSON.stringify({ pid: 4_194_303, host: 'other-host', heartbeatAt: new Date().toISOString() }), 'utf8')
    assert.equal((await runnerStatus(dir)).alive, true)
    await writeFile(path.join(dir, 'runner.json'), JSON.stringify({ pid: 4_194_303, host: 'other-host', heartbeatAt: new Date(Date.now() - 600_000).toISOString() }), 'utf8')
    assert.equal((await runnerStatus(dir)).alive, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a running job with a live detached runner is not settled as failed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-runner-settle-'))
  const dataDir = path.join(dir, 'deploy')
  const id = newJobId()
  try {
    const manager = new DeployManager({ repositoryRoot: process.cwd(), dataDir, runnerFactory: () => ({}) })
    await seedJob(path.join(dataDir, id), {
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'running',
      phase: 'prepare',
      steps: [],
    })
    await writeFile(path.join(dataDir, id, 'runner.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), heartbeatAt: new Date().toISOString() }), 'utf8')
    const live = await manager.status(id)
    assert.equal(live.status, 'running')

    // The runner exits without writing a final state: only now is the job an
    // interrupted one.
    await writeFile(path.join(dataDir, id, 'runner.json'), JSON.stringify({ pid: 4_194_303, host: os.hostname(), heartbeatAt: new Date().toISOString() }), 'utf8')
    const dead = await manager.status(id)
    assert.equal(dead.status, 'failed')
    assert.match(dead.error, /interrupted/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a queued job survives the moment before its runner reports in', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-runner-queued-'))
  const dataDir = path.join(dir, 'deploy')
  const id = newJobId()
  try {
    const manager = new DeployManager({ repositoryRoot: process.cwd(), dataDir, runnerFactory: () => ({}) })
    await seedJob(path.join(dataDir, id), {
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'queued',
      phase: 'starting',
      steps: [],
    })
    const fresh = await manager.status(id)
    assert.equal(fresh.status, 'queued')

    // A queue entry whose runner never appeared is an interrupted job.
    const stale = await readDeployState(path.join(dataDir, id))
    stale.createdAt = new Date(Date.now() - 10 * 60_000).toISOString()
    await writeDeployState(path.join(dataDir, id), stale)
    const failed = await manager.status(id)
    assert.equal(failed.status, 'failed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeDeployState swaps the state file atomically', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-runner-atomic-'))
  try {
    await writeDeployState(dir, { id: 'deploy-a', status: 'running' })
    await writeDeployState(dir, { id: 'deploy-a', status: 'succeeded' })
    const parsed = JSON.parse(await readFile(path.join(dir, 'job.json'), 'utf8'))
    assert.equal(parsed.status, 'succeeded')
    // No temp file is left behind for the next reader to trip over.
    const entries = await readdir(dir)
    assert.deepEqual(entries.filter(name => name.endsWith('.tmp')), [])
    assert.equal((await readDeployState(path.join(dir, 'missing'))), null)
    assert.equal(path.basename(jobPaths(dir).state), 'job.json')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('LocalRunner copies the package and runs its script in place', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-local-runner-'))
  try {
    const source = path.join(dir, 'package.tar.gz')
    await writeFile(source, 'payload', 'utf8')
    const runner = new LocalRunner({ host: '127.0.0.1', local: true, sudo: false })
    const target = path.join(dir, 'stage', 'package.tar.gz')
    const progress = []
    await runner.upload(source, target, value => progress.push(value))
    assert.equal(await readFile(target, 'utf8'), 'payload')
    assert.equal(progress.at(-1).percent, 100)
    assert.equal(await runner.remoteSize(target), 7)
    assert.equal(await runner.remoteSize(path.join(dir, 'nope')), null)

    const lines = []
    await runner.script('echo hello; echo oops >&2; echo $((1 + 1))', 'linux', line => lines.push(line))
    // stdout and stderr arrive as they are written, so only membership is
    // guaranteed, not the relative order of the two streams.
    assert.deepEqual([...lines].sort(), ['2', 'hello', 'oops'])
    await assert.rejects(runner.script('exit 7', 'linux', () => {}), /exited with 7/u)
    await assert.rejects(runner.script('echo hi', 'windows', () => {}), /Linux/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a release path is reduced to the stable install root', async () => {
  assert.equal(normalizeInstallRoot('/root/.dsh/dsh-mesh/current'), '/root/.dsh/dsh-mesh')
  assert.equal(normalizeInstallRoot('C:\\Users\\Admin\\.dsh\\dsh-mesh\\current'), 'C:\\Users\\Admin\\.dsh\\dsh-mesh')
  assert.equal(normalizeInstallRoot('/opt/dsh-mesh/'), '/opt/dsh-mesh')
  assert.equal(normalizeInstallRoot(''), '')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-root-'))
  try {
    const pkg = path.join(dir, 'pkg.tar.gz')
    await writeFile(pkg, 'x', 'utf8')
    const plan = await buildDeployPlan({
      host: '10.66.66.2',
      package: pkg,
      appRoot: '/root/.dsh/dsh-mesh/current',
      os: 'linux',
      repositoryRoot: process.cwd(),
    })
    assert.equal(plan.appRoot, '/root/.dsh/dsh-mesh')
    assert.equal(plan.current, '/root/.dsh/dsh-mesh/current')
    assert.equal(plan.releases, '/root/.dsh/dsh-mesh/releases')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a local plan keeps the runner off the network', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-local-plan-'))
  try {
    const pkg = path.join(dir, 'pkg.tar.gz')
    await writeFile(pkg, 'x', 'utf8')
    const plan = await buildDeployPlan({
      host: '127.0.0.1',
      local: true,
      package: pkg,
      appRoot: '/opt/dsh-mesh',
      os: 'linux',
      repositoryRoot: process.cwd(),
    })
    assert.equal(plan.local, true)
    assert.equal(plan.host, '127.0.0.1')
    assert.match(plan.remotePackage, /^\/tmp\/dsh-mesh-/u)
    assert.equal(plan.current, '/opt/dsh-mesh/current')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wire-profile rewrites gate.env and links the profile to the install', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-wire-profile-'))
  const root = path.join(dir, 'app')
  const profile = path.join(dir, 'home', 'profiles', 'web')
  try {
    await mkdir(path.join(root, 'plugins', 'dsh-mesh'), { recursive: true })
    await mkdir(profile, { recursive: true })
    const envFile = path.join(root, 'config', 'gate.env')
    await mkdir(path.dirname(envFile), { recursive: true })
    await writeFile(envFile, '# keep me\nDSH_GATE_PORT=8080\nDSH_GATE_PASSWORD=secret\nDSH_HOME=/old/home\n', 'utf8')
    await writeFile(path.join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      dependencies: { '@local/dsh-wireguard': 'link:/old/wireguard' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }), 'utf8')

    await run(process.execPath, [
      path.join(here, '..', 'code', 'deploy', 'wire-profile.mjs'),
      '--root', root,
      '--profile', profile,
      '--env', envFile,
      '--dsh-home', path.join(dir, 'home'),
      '--workdir', path.join(dir, 'work'),
      '--token', 'interop-token-1',
    ])

    const env = await readFile(envFile, 'utf8')
    assert.match(env, /# keep me/u)
    assert.match(env, /DSH_GATE_PORT=8080/u)
    assert.match(env, /DSH_GATE_PASSWORD=secret/u)
    assert.match(env, new RegExp(`DSH_HOME=${path.join(dir, 'home').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'))
    assert.match(env, /DSH_GATE_NO_SPAWN=1/u)
    assert.match(env, new RegExp(`DSH_WEB_TOKEN_FILE=${path.join(root, 'data', 'dsh-web.json').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'))

    const manifest = JSON.parse(await readFile(path.join(profile, 'package.json'), 'utf8'))
    assert.equal(manifest.dependencies['@local/dsh-mesh'], `link:${path.join(root, 'plugins', 'dsh-mesh')}`)
    assert.equal(manifest.dependencies['@local/dsh-wireguard'], undefined)
    assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@local/dsh-mesh'])
    assert.equal(existsSync(path.join(profile, 'node_modules', '@local', 'dsh-mesh')), true)

    const patch = await readFile(path.join(profile, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /# BEGIN dsh-mesh deploy/u)
    assert.match(patch, /interopToken: interop-token-1/u)
    assert.match(patch, /# END dsh-mesh deploy/u)

    // Running it again is idempotent: no second block, token unchanged.
    await run(process.execPath, [
      path.join(here, '..', 'code', 'deploy', 'wire-profile.mjs'),
      '--root', root, '--profile', profile, '--env', envFile, '--token', 'interop-token-1',
    ])
    const again = await readFile(path.join(profile, 'cordis.patch.yml'), 'utf8')
    assert.equal(again.match(/# BEGIN dsh-mesh deploy/gu).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('upgrade-local.sh replaces files, keeps config and stops before the restart', async () => {
  if (process.platform !== 'linux') return
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-upgrade-local-'))
  const root = path.join(dir, 'app')
  const stage = path.join(dir, 'package')
  const profile = path.join(dir, 'home', 'profiles', 'web')
  const repository = path.join(here, '..')
  try {
    // The existing install: a flat tree with a config that must survive.
    await mkdir(path.join(root, 'config'), { recursive: true })
    await mkdir(path.join(root, 'plugins', 'dsh-mesh'), { recursive: true })
    await mkdir(path.join(root, 'code', 'deploy'), { recursive: true })
    await writeFile(path.join(root, 'config', 'gate.env'), 'DSH_GATE_PORT=8080\nDSH_GATE_PASSWORD=secret\nDSH_HOME=' + path.join(dir, 'home') + '\n', 'utf8')
    await writeFile(path.join(root, 'plugins', 'dsh-mesh', 'package.json'), JSON.stringify({ version: '0.0.1-old' }), 'utf8')
    await cp(path.join(repository, 'code', 'deploy', 'wire-profile.mjs'), path.join(root, 'code', 'deploy', 'wire-profile.mjs'))

    // The new package: the same files plus a marker version and the upgrade
    // script itself.
    await mkdir(path.join(stage, 'plugins', 'dsh-mesh'), { recursive: true })
    await mkdir(path.join(stage, 'code', 'deploy'), { recursive: true })
    await writeFile(path.join(stage, 'manifest.json'), JSON.stringify({ version: '0.0.2-new' }), 'utf8')
    await writeFile(path.join(stage, 'start.sh'), '#!/usr/bin/env bash\n', 'utf8')
    await chmod(path.join(stage, 'start.sh'), 0o755)
    await writeFile(path.join(stage, 'plugins', 'dsh-mesh', 'package.json'), JSON.stringify({ version: '0.0.2-new' }), 'utf8')
    await cp(path.join(repository, 'code', 'deploy', 'upgrade-local.sh'), path.join(stage, 'code', 'deploy', 'upgrade-local.sh'))
    await cp(path.join(repository, 'code', 'deploy', 'wire-profile.mjs'), path.join(stage, 'code', 'deploy', 'wire-profile.mjs'))

    const result = await run('bash', [
      path.join(stage, 'code', 'deploy', 'upgrade-local.sh'),
      '--app-root', root,
      '--dsh-home', path.join(dir, 'home'),
      '--no-restart',
    ])
    assert.match(result.stdout, /--no-restart/u)
    // New file arrived, config stayed.
    assert.equal(JSON.parse(await readFile(path.join(root, 'plugins', 'dsh-mesh', 'package.json'), 'utf8')).version, '0.0.2-new')
    assert.equal(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')).version, '0.0.2-new')
    const env = await readFile(path.join(root, 'config', 'gate.env'), 'utf8')
    assert.match(env, /DSH_GATE_PASSWORD=secret/u)
    assert.match(env, /DSH_GATE_NO_SPAWN=1/u)
    // A backup of the old tree exists.
    const backups = await readdir(path.join(root, '.upgrade-backup'))
    assert.equal(backups.length, 1)
    assert.equal(existsSync(path.join(root, '.upgrade-backup', backups[0], 'plugins', 'dsh-mesh', 'package.json')), true)
    // The profile points at the install.
    const manifest = JSON.parse(await readFile(path.join(profile, 'package.json'), 'utf8'))
    assert.equal(manifest.dependencies['@local/dsh-mesh'], `link:${path.join(root, 'plugins', 'dsh-mesh')}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the detached runner drives an in-place upgrade and settles the job', async () => {
  if (process.platform !== 'linux') return
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-runner-inplace-'))
  const root = path.join(dir, 'app')
  const packageDir = path.join(dir, 'pkg')
  const jobDir = path.join(dir, 'deploy', 'deploy-inplace-1')
  const repository = path.join(here, '..')
  try {
    // The package that the runner extracts and hands to upgrade-local.sh.
    await mkdir(path.join(packageDir, 'code', 'deploy'), { recursive: true })
    await mkdir(path.join(packageDir, 'plugins', 'dsh-mesh'), { recursive: true })
    await writeFile(path.join(packageDir, 'manifest.json'), JSON.stringify({ version: '9.9.9' }), 'utf8')
    await writeFile(path.join(packageDir, 'start.sh'), '#!/usr/bin/env bash\n', 'utf8')
    await chmod(path.join(packageDir, 'start.sh'), 0o755)
    await writeFile(path.join(packageDir, 'plugins', 'dsh-mesh', 'package.json'), JSON.stringify({ version: '9.9.9' }), 'utf8')
    await cp(path.join(repository, 'code', 'deploy', 'upgrade-local.sh'), path.join(packageDir, 'code', 'deploy', 'upgrade-local.sh'))
    await cp(path.join(repository, 'code', 'deploy', 'wire-profile.mjs'), path.join(packageDir, 'code', 'deploy', 'wire-profile.mjs'))
    const archive = path.join(dir, 'dsh-mesh-9.9.9-linux-x64.tar.gz')
    await run('tar', ['-czf', archive, '-C', packageDir, '.'])

    // The flat install it upgrades.
    await mkdir(path.join(root, 'config'), { recursive: true })
    await mkdir(path.join(root, 'plugins', 'dsh-mesh'), { recursive: true })
    await writeFile(path.join(root, 'config', 'gate.env'), `DSH_GATE_PORT=8080\nDSH_HOME=${path.join(dir, 'home')}\n`, 'utf8')
    await writeFile(path.join(root, 'plugins', 'dsh-mesh', 'package.json'), JSON.stringify({ version: '0.0.1' }), 'utf8')

    await mkdir(jobDir, { recursive: true })
    const id = 'deploy-inplace-1'
    await writeDeployState(jobDir, {
      id,
      mode: 'upgrade',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      member: 'local',
      target: { host: '127.0.0.1', user: 'root', port: null, os: 'linux', appRoot: root },
      release: 'local',
      status: 'queued',
      phase: 'starting',
      error: null,
      steps: [
        { key: 'upload', label: '上传安装包', status: 'pending', startedAt: null, finishedAt: null, detail: '', progress: null },
        { key: 'prepare', label: '解压并准备新版本', status: 'pending', startedAt: null, finishedAt: null, detail: '', progress: null },
        { key: 'activate', label: '切换并重启服务', status: 'pending', startedAt: null, finishedAt: null, detail: '', progress: null },
      ],
      progress: {},
    })
    await writeFile(path.join(jobDir, 'request.json'), JSON.stringify({
      kind: 'inplace',
      id,
      member: 'local',
      inplace: { package: archive, appRoot: root },
    }), 'utf8')

    await run(process.execPath, [path.join(repository, 'code', 'deploy', 'runner.mjs'), '--job', jobDir], {
      env: { ...process.env, DSH_MESH_UPGRADE_NO_RESTART: '1' },
    })

    const state = JSON.parse(await readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(state.status, 'succeeded')
    assert.deepEqual(state.steps.map(step => step.status), ['succeeded', 'succeeded', 'succeeded'])
    assert.equal(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')).version, '9.9.9')
    const runner = JSON.parse(await readFile(path.join(jobDir, 'runner.json'), 'utf8'))
    assert.equal(runner.exitCode, 0)
    assert.ok(runner.finishedAt !== undefined)
    assert.match(await readFile(path.join(jobDir, 'deploy.log'), 'utf8'), /deployment succeeded/u)
    // The extracted staging tree is removed once the job is done.
    assert.equal(existsSync(path.join(jobDir, 'stage')), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
