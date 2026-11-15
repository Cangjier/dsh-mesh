import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MeshService } from '../src/lib/service.mjs'
import { sha256Text } from '../code/build/engine.mjs'

/**
 * Wait for a job to leave the running phase.
 * @param {MeshService} service service.
 * @param {string} id job id.
 * @returns {Promise<object>} final job.
 */
async function waitForJob(service, id) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const job = await service.job(id)
    if (job.status !== 'running' && job.status !== 'created') return job
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('job did not finish in time')
}

test('deployPackage resolves a package and queues a detached job for a member', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-deploy-package-'))
  const pkg = path.join(dir, 'dsh-mesh-0.2.2-linux-x64.tar.gz')
  const readJob = async job => {
    const file = path.join(dir, 'mesh', 'deploy', job.id, 'job.json')
    return JSON.parse(await readFile(file, 'utf8'))
  }
  const readRequest = async job => {
    const file = path.join(dir, 'mesh', 'deploy', job.id, 'request.json')
    return JSON.parse(await readFile(file, 'utf8'))
  }
  try {
    await writeFile(pkg, 'not-a-real-archive', 'utf8')
    const spawned = []
    const service = new MeshService({
      dataDir: path.join(dir, 'mesh'),
      config: {},
      log: () => {},
      // No process is started by the suite: the job directory is the contract.
      spawnRunner: async (jobDir, id) => {
        spawned.push(id)
        assert.ok(existsSync(path.join(jobDir, 'request.json')))
        return { mode: 'test', unit: null }
      },
    })
    service.members = async () => ({
      local: { id: 'local', name: 'a', ip: '10.66.66.1', kind: 'self', system: { appRoot: '/opt/a', user: 'root', platform: 'linux' } },
      members: [{ id: 'b', name: 'B', ip: '10.66.66.2', system: { appRoot: '/opt/b', user: 'deploy', platform: 'linux' } }],
    })
    service.waitDeploy = async id => ({ id, status: 'succeeded' })
    // These jobs are not really running: nothing should look "busy".
    service.deploy.list = async () => []

    const result = await service.deployPackage({ host: 'B', package: pkg })
    assert.equal(spawned.length, 1)
    assert.equal(result.member.name, 'B')
    const state = await readJob(result.job)
    assert.equal(state.status, 'queued')
    assert.equal(state.mode, 'install')
    assert.equal(state.target.host, '10.66.66.2')
    assert.equal(state.target.appRoot, '/opt/b')
    assert.equal(state.services[0], 'dsh-web-gate.service')
    // The plan travels with the job so the runner does not hash the package
    // twice, and the queued row already shows the right release.
    const request = await readRequest(result.job)
    assert.equal(request.kind, 'engine')
    assert.equal(request.options.os, 'linux')
    assert.equal(request.plan.appRoot, '/opt/b')
    assert.equal(request.plan.release, state.release)

    const upgrade = await service.upgradeMember({ member: 'b', package: pkg })
    const upgradeState = await readJob(upgrade.job)
    assert.equal(upgradeState.mode, 'upgrade')
    assert.equal(upgrade.layout, 'bluegreen')

    const raw = await service.deployPackage({ host: 'raw.example', package: pkg })
    const rawState = await readJob(raw.job)
    assert.equal(rawState.target.host, 'raw.example')
    assert.equal(rawState.target.appRoot, '/opt/dsh-mesh')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('build with jobId learns a needs-fix worktree and resumes it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-build-resume-'))
  try {
    const service = new MeshService({ dataDir: path.join(dir, 'mesh'), config: {}, log: () => {} })
    const calls = []
    service.job = async id => ({ id, status: 'needs-fix' })
    service.learn = async id => { calls.push(`learn:${id}`) }
    service.resumeBuild = async id => { calls.push(`resume:${id}`); return { id } }
    const result = await service.build({ jobId: 'job-x' })
    assert.deepEqual(calls, ['learn:job-x', 'resume:job-x'])
    assert.equal(result.id, 'job-x')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('service exposes status, recipes, members, and a plan job', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-service-'))
  const source = path.join(dir, 'source')
  try {
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ version: '9.9.9' }), 'utf8')
    const picker = '/* dsh-mesh overlay: picker */\n// picker\n'
    const account = '/* dsh-mesh overlay: login */\n// account\n'
    const overlay = 'export function openGateLoginOverlay() {}\n'
    await mkdir(path.join(source, 'packages/client/ui-directory-picker-browse/src/client'), { recursive: true })
    await mkdir(path.join(source, 'packages/client/ui-settings-account/src/client'), { recursive: true })
    await writeFile(path.join(source, 'packages/client/ui-directory-picker-browse/src/client/DirectoryBrowser.tsx'), picker, 'utf8')
    await writeFile(path.join(source, 'packages/client/ui-settings-account/src/client/index.ts'), account, 'utf8')
    await writeFile(path.join(source, 'packages/client/ui-settings-account/src/client/gate-login-overlay.ts'), overlay, 'utf8')

    const service = new MeshService({
      dataDir: path.join(dir, 'mesh'),
      config: {
        build: { source, ref: 'master', targets: ['linux-x64'] },
      },
      log: () => {},
    })
    const status = await service.status()
    assert.equal(status.ok, true)
    assert.equal(status.host.version, '0.2.0')

    const recipes = await service.recipes()
    assert.equal(recipes.steps.length, 2)

    const members = await service.members()
    assert.equal(members.self.id, 'local')
    assert.ok(Array.isArray(members.members))

    const started = await service.startBuild({ source, planOnly: true, targets: ['linux-x64'] })
    assert.ok(started.id)
    const job = await waitForJob(service, started.id)
    assert.equal(job.status, 'planned')
    assert.equal(job.phase, 'apply')
    assert.equal(job.targets[0], 'linux-x64')
    assert.ok(job.logFile.endsWith('build.log'))

    await mkdir(path.join(started.dir, 'src'), { recursive: true })
    await writeFile(path.join(started.dir, 'src', 'marker.txt'), 'x', 'utf8')
    await mkdir(path.join(started.dir, 'dist'), { recursive: true })
    await writeFile(path.join(started.dir, 'dist', 'old.tar.gz'), 'x', 'utf8')
    const finished = await service.build({ source, planOnly: true, targets: ['linux-x64'] })
    assert.equal(finished.status, 'planned')
    assert.ok(finished.logFile.endsWith('build.log'))
    assert.ok(finished.stateFile.endsWith('state.json'))

    // The second build finished, then cleaned the first job's src/, dist/,
    // but kept its log.
    assert.equal(existsSync(path.join(started.dir, 'src')), false)
    assert.equal(existsSync(path.join(started.dir, 'dist')), false)
    assert.equal(existsSync(path.join(started.dir, 'build.log')), true)

    // A completed job keeps its result until the next build, then only the
    // regeneration outputs are removed.
    await mkdir(path.join(finished.dir, 'src'), { recursive: true })
    await writeFile(path.join(finished.dir, 'src', 'marker.txt'), 'x', 'utf8')
    await mkdir(path.join(finished.dir, 'dist'), { recursive: true })
    await writeFile(path.join(finished.dir, 'dist', 'old.tar.gz'), 'x', 'utf8')
    await service.cleanupBuilds()
    assert.equal(existsSync(path.join(finished.dir, 'src')), false)
    assert.equal(existsSync(path.join(finished.dir, 'dist')), false)
    assert.equal(existsSync(path.join(finished.dir, 'build.log')), true)

    await mkdir(path.join(finished.dir, 'dist'), { recursive: true })
    await writeFile(path.join(finished.dir, 'dist', 'keep.tar.gz'), 'x', 'utf8')
    await service.cleanupBuilds({ keepDist: true })
    assert.equal(existsSync(path.join(finished.dir, 'dist', 'keep.tar.gz')), true)

    const jobs = await service.jobs()
    assert.ok(jobs.some(entry => entry.id === started.id))
    const log = await service.log(started.id, 20)
    assert.ok(Array.isArray(log))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a second job for the same target is refused while one is running', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-deploy-busy-'))
  const pkg = path.join(dir, 'dsh-mesh-0.2.2-linux-x64.tar.gz')
  try {
    await writeFile(pkg, 'not-a-real-archive', 'utf8')
    const service = new MeshService({
      dataDir: path.join(dir, 'mesh'),
      config: {},
      log: () => {},
      spawnRunner: async () => ({ mode: 'test', unit: null }),
    })
    service.members = async () => ({
      local: { id: 'local', name: 'a', ip: '10.66.66.1', kind: 'self', system: { appRoot: '/opt/a', user: 'root', platform: 'linux' } },
      members: [{ id: 'b', name: 'B', ip: '10.66.66.2', system: { appRoot: '/opt/b', user: 'root', platform: 'linux' } }],
    })
    service.deploy = {
      list: async () => [{ id: 'deploy-live', status: 'running', mode: 'upgrade', member: 'b', target: { host: '10.66.66.2' } }],
      status: async () => ({ id: 'deploy-live', status: 'running' }),
    }
    await assert.rejects(service.upgradeMember({ member: 'b', package: pkg }), /已有正在进行的升级任务/u)
    // Another target is unaffected.
    service.deploy.list = async () => [{ id: 'deploy-live', status: 'running', mode: 'upgrade', member: 'b', target: { host: '10.66.66.2' } }]
    const other = await service.deployMember({ member: '10.66.66.3', package: pkg }).catch(error => error)
    assert.ok(other instanceof Error)
    assert.match(other.message, /member not found/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('clearing finished builds deletes their job directories and keeps a running one', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-clear-builds-'))
  try {
    const service = new MeshService({ dataDir: path.join(dir, 'mesh'), config: {}, log: () => {} })
    const root = service.jobRoot
    const done = path.join(root, '2026-11-14T02-44-03-181Z-958eaf')
    const failed = path.join(root, '2026-11-14T02-37-30-036Z-235630')
    const running = path.join(root, '2026-11-15T06-00-00-000Z-runn1ng')
    for (const [jobDir, id, status] of [
      [done, '2026-11-14T02-44-03-181Z-958eaf', 'done'],
      [failed, '2026-11-14T02-37-30-036Z-235630', 'failed'],
      [running, '2026-11-15T06-00-00-000Z-runn1ng', 'running'],
    ]) {
      await mkdir(path.join(jobDir, 'src'), { recursive: true })
      await writeFile(path.join(jobDir, 'src', 'index.js'), 'x', 'utf8')
      await writeFile(path.join(jobDir, 'build.log'), 'line\n', 'utf8')
      await writeFile(path.join(jobDir, 'state.json'), JSON.stringify({ id, status }), 'utf8')
    }
    const result = await service.clearFinishedBuilds()
    assert.deepEqual(result.cleared.sort(), ['2026-11-14T02-37-30-036Z-235630', '2026-11-14T02-44-03-181Z-958eaf'])
    assert.equal(existsSync(done), false)
    assert.equal(existsSync(failed), false)
    assert.equal(existsSync(path.join(running, 'build.log')), true)
    // The panel's table keeps only the job that is still running.
    assert.deepEqual((await service.jobs()).map(job => job.id), ['2026-11-15T06-00-00-000Z-runn1ng'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a timed out probe keeps the last known install state, across a restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-probe-cache-'))
  const home = path.join(dir, 'home')
  const dataDir = path.join(home, 'mesh')
  try {
    await mkdir(path.join(home, 'wireguard'), { recursive: true })
    await writeFile(path.join(home, 'wireguard', 'state.json'), JSON.stringify({
      version: 1,
      role: 'server',
      settings: { serverIp: '10.66.66.1', listenPort: 51820 },
      server: {
        publicKey: 'server-key',
        peers: [{
          ip: '10.66.66.2',
          name: 'B',
          publicKey: 'peer-key',
          online: true,
          lastHandshakeAt: new Date().toISOString(),
        }],
      },
      client: { connected: false },
    }), 'utf8')
    let down = false
    const fetchImpl = async () => {
      if (down) throw new Error('connect ETIMEDOUT')
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, service: 'dsh-mesh', id: '10.66.66.2', name: 'B', gatePort: 80, system: { platform: 'linux', appRoot: '/opt/b' } }
        },
      }
    }
    const config = { memberPorts: [80] }
    const service = new MeshService({ dataDir, config, log: () => {}, fetchImpl })
    const online = (await service.members()).members.find(member => member.ip === '10.66.66.2')
    assert.equal(online.dsh, true)

    // The peer stops answering: the row keeps its last good answer, flagged.
    down = true
    const stale = (await service.members()).members.find(member => member.ip === '10.66.66.2')
    assert.equal(stale.dsh, true)
    assert.equal(stale.probeStale, true)

    // A panel reload (new instance, empty memory) reads the saved probe.
    const restarted = new MeshService({ dataDir, config, log: () => {}, fetchImpl })
    const restored = (await restarted.members()).members.find(member => member.ip === '10.66.66.2')
    assert.equal(restored.dsh, true)
    assert.equal(restored.probeStale, true)

    // Once that saved answer ages out, a silent peer is 未部署 again.
    service.probes.get('10.66.66.2').expiresAt = Date.now() - 1
    const expired = (await service.members()).members.find(member => member.ip === '10.66.66.2')
    assert.equal(expired.dsh, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
