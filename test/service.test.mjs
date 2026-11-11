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

test('deployPackage resolves a package and uses discovered member metadata', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-deploy-package-'))
  const pkg = path.join(dir, 'dsh-mesh-0.2.2-linux-x64.tar.gz')
  try {
    await writeFile(pkg, 'not-a-real-archive', 'utf8')
    const service = new MeshService({
      dataDir: path.join(dir, 'mesh'),
      config: {},
      log: () => {},
    })
    service.members = async () => ({
      local: { id: 'local', name: 'a', ip: '10.66.66.1', system: { appRoot: '/opt/a', user: 'root', platform: 'linux' } },
      members: [{ id: 'b', name: 'B', ip: '10.66.66.2', system: { appRoot: '/opt/b', user: 'deploy', platform: 'linux' } }],
    })
    const calls = []
    service.deploy = {
      start: async request => {
        calls.push(request)
        return { job: { id: `deploy-${String(calls.length)}`, status: 'running' } }
      },
      wait: async id => ({ id, status: 'succeeded' }),
      logs: async () => '',
    }

    const result = await service.deployPackage({ host: 'B', package: pkg })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].host, '10.66.66.2')
    assert.equal(calls[0].appRoot, '/opt/b')
    assert.equal(calls[0].os, 'linux')
    assert.equal(result.member.name, 'B')

    await service.deployPackage({ host: 'raw.example', package: pkg })
    assert.equal(calls[1].host, 'raw.example')
    assert.equal(calls[1].appRoot, '/opt/dsh-mesh')
    assert.equal(calls[1].os, 'linux')
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
