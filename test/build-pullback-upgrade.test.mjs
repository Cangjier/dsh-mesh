import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MeshService } from '../src/lib/service.mjs'
import { updateState } from '../code/build/job.mjs'

const SHA = 'b'.repeat(64)

/**
 * A member-shaped row for the build host.
 * @param {object} [overrides] patches.
 * @returns {object} member.
 */
function member(overrides = {}) {
  return {
    id: 'b',
    kind: 'peer',
    name: 'B',
    ip: '10.66.66.2',
    online: true,
    dsh: true,
    port: 80,
    latencyMs: 5,
    gate: {},
    error: null,
    system: { platform: 'linux', arch: 'x64', appRoot: '/opt/b', user: 'root' },
    ...overrides,
  }
}

/**
 * A service whose discovery and SSH build are stubbed at the seam the tests
 * care about: everything above the remote builder is the real code.
 * @param {object} options fixture input.
 * @returns {object} fixture.
 */
async function fixture(options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-auto-upgrade-'))
  const service = new MeshService({
    dataDir: path.join(dir, 'mesh'),
    config: options.config ?? {},
    log: () => {},
    spawnRunner: async () => ({ mode: 'test', unit: null }),
  })
  const local = {
    id: 'local',
    kind: 'self',
    name: 'A',
    ip: '10.66.66.1',
    online: true,
    dsh: true,
    system: { platform: 'linux', arch: 'x64', appRoot: '/opt/a', user: 'root' },
  }
  service.members = async () => ({ local, members: [member(options.member)] })
  let buildOptions = null
  service.remoteBuilder.run = async (jobDir, runOptions) => {
    buildOptions = runOptions
    const staged = '/root/.dsh/mesh/upgrade/job-1/dsh-mesh-1.0-20261118A-linux-x64.tar.gz'
    const state = await updateState(jobDir, {
      status: 'done',
      phase: 'done',
      percent: 100,
      artifacts: [{
        target: 'linux-x64',
        archive: staged,
        remoteArchive: staged,
        stagedArchive: staged,
        pulled: false,
        bytes: 1234,
        sha256: SHA,
        manifest: { name: 'dsh-mesh' },
        smoke: { status: 'passed', screenshots: ['smoke/linux-x64/mesh.png'] },
      }],
      pulledBack: runOptions.pullBack === true,
    })
    return state
  }
  const deploys = []
  if (options.stubDeploy !== false) {
    service.startDeploy = async request => {
      deploys.push(request)
      return { ok: true, job: { id: 'deploy-auto-1', release: '20261118A' }, member: { id: 'b' }, layout: 'pointer' }
    }
  }
  return {
    dir,
    service,
    deploys,
    buildOptions: () => buildOptions,
    async cleanup() {
      await service.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('a member build keeps its package and upgrades the member that built it', async () => {
  const f = await fixture({ config: { build: { pullBack: false, autoUpgrade: true, full: true } } })
  try {
    const started = await f.service.startBuild({
      member: 'b',
      ref: 'main',
      targets: ['linux-x64'],
      source: 'https://github.com/deepseek-ai/deepseek-harness',
    })
    await f.service.running.get(started.id)
    const final = await f.service.job(started.id)
    assert.equal(final.status, 'done', JSON.stringify(final))
    assert.equal(final.pullBack, false)
    assert.equal(final.pulledBack, false)
    const runOptions = f.buildOptions()
    assert.equal(runOptions.pullBack, false)
    assert.equal(runOptions.stageTarget, 'linux-x64')
    assert.equal(runOptions.full, true)
    // The upgrade points at the archive already on the build host; no upload.
    assert.equal(f.deploys.length, 1)
    assert.equal(f.deploys[0].member, 'b')
    assert.equal(f.deploys[0].mode, 'upgrade')
    assert.equal(f.deploys[0].packageOnTarget.path, '/root/.dsh/mesh/upgrade/job-1/dsh-mesh-1.0-20261118A-linux-x64.tar.gz')
    assert.equal(f.deploys[0].packageOnTarget.bytes, 1234)
    assert.equal(f.deploys[0].packageOnTarget.sha256, SHA)
    assert.equal(final.autoUpgradeResult.status, 'started')
    assert.equal(final.autoUpgradeResult.jobId, 'deploy-auto-1')
    assert.match((await f.service.log(started.id, 200)).join('\n'), /auto-upgrade started/u)
  } finally {
    await f.cleanup()
  }
})

test('one build can request pull-back and disable the automatic upgrade', async () => {
  const f = await fixture({ config: { build: { pullBack: false, autoUpgrade: true } } })
  try {
    const started = await f.service.startBuild({
      member: 'b',
      ref: 'main',
      targets: ['linux-x64'],
      source: 'https://github.com/deepseek-ai/deepseek-harness',
      pullBack: true,
      autoUpgrade: false,
    })
    await f.service.running.get(started.id)
    const final = await f.service.job(started.id)
    assert.equal(final.status, 'done', JSON.stringify(final))
    assert.equal(final.pullBack, true)
    assert.equal(final.autoUpgrade, false)
    assert.equal(f.buildOptions().pullBack, true)
    // Nothing is staged for an upgrade that will not run, and no job starts.
    assert.equal(f.buildOptions().stageTarget, null)
    assert.equal(f.deploys.length, 0)
    assert.equal(final.autoUpgradeResult, undefined)
  } finally {
    await f.cleanup()
  }
})

test('a cross-target build skips the automatic upgrade instead of failing', async () => {
  const f = await fixture({ config: { build: { autoUpgrade: true } }, member: { system: { platform: 'linux', arch: 'x64', appRoot: '/opt/b', user: 'root' } } })
  try {
    // The stub advertises a linux-x64 artifact, but this job only built win-x64.
    f.service.remoteBuilder.run = async (jobDir, runOptions) => {
      const state = await updateState(jobDir, {
        status: 'done',
        phase: 'done',
        percent: 100,
        artifacts: [{ target: 'win-x64', archive: 'C:\\pkg.zip', pulled: false, bytes: 10, manifest: {}, smoke: { status: 'passed' } }],
        pulledBack: false,
      })
      return state
    }
    const started = await f.service.startBuild({
      member: 'b',
      ref: 'main',
      targets: ['win-x64'],
      source: 'https://github.com/deepseek-ai/deepseek-harness',
    })
    await f.service.running.get(started.id)
    const final = await f.service.job(started.id)
    assert.equal(final.status, 'done', JSON.stringify(final))
    assert.equal(f.deploys.length, 0)
    assert.equal(final.autoUpgradeResult.status, 'skipped')
    assert.match(final.autoUpgradeResult.reason, /linux-x64|目标平台/u)
  } finally {
    await f.cleanup()
  }
})

test('startDeploy plans an archive that already sits on the target', async () => {
  const f = await fixture({ config: {}, stubDeploy: false })
  try {
    const remote = '/root/.dsh/mesh/upgrade/job-9/dsh-mesh-1.0-20261118A-linux-x64.tar.gz'
    const result = await f.service.startDeploy({
      member: 'b',
      mode: 'upgrade',
      packageOnTarget: { path: remote, bytes: 4321, sha256: SHA },
    })
    assert.equal(result.ok, true)
    assert.equal(result.layout, 'pointer')
    assert.equal(result.job.packageOnTarget, true)
    const requestFile = path.join(f.dir, 'mesh', 'deploy', result.job.id, 'request.json')
    const request = JSON.parse(await readFile(requestFile, 'utf8'))
    assert.equal(request.plan.packageOnTarget, true)
    assert.equal(request.plan.package.path, remote)
    assert.equal(request.plan.remotePackage, remote)
    assert.equal(request.plan.package.bytes, 4321)
    assert.equal(request.plan.package.sha256, SHA)
    assert.equal(request.plan.download, null)
  } finally {
    await f.cleanup()
  }
})
