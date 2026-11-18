import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildDeployPlan, DeployManager, describePlan } from '../code/deploy/engine.mjs'

const SHA = 'a'.repeat(64)

/**
 * A runner for an archive the build host already has.
 * @param {object} plan deploy plan.
 * @param {{present?: boolean}} [options] fixture switches.
 * @returns {object} runner.
 */
function targetRunner(plan, options = {}) {
  const present = options.present !== false
  return {
    plan,
    uploaded: [],
    sshOptions: () => [],
    target: () => 'fake',
    async remoteSize(remote) {
      return remote === plan.remotePackage && present ? plan.package.bytes : null
    },
    async remoteFreeBytes() {
      return 10 * 1024 * 1024 * 1024
    },
    async discardStalePackages() {
      return false
    },
    async upload(_local, remote) {
      this.uploaded.push(remote)
    },
    async runProcess() {
      return { stdout: '', stderr: '' }
    },
    async script() {},
  }
}

test('a build-host archive needs no upload and no release download', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-deploy-on-target-'))
  try {
    const remote = '/root/.dsh/mesh/upgrade/job-1/dsh-mesh-1.0-20261118A-linux-x64.tar.gz'
    const plan = await buildDeployPlan({
      host: '10.66.66.3',
      os: 'linux',
      appRoot: '/opt/member',
      packageOnTarget: { path: remote, bytes: 4321, sha256: SHA },
      release: '20261118-on-target',
    })
    assert.equal(plan.packageOnTarget, true)
    assert.equal(plan.package.path, remote)
    assert.equal(plan.package.bytes, 4321)
    assert.equal(plan.package.sha256, SHA)
    assert.equal(plan.package.onTarget, true)
    assert.equal(plan.remotePackage, remote)
    assert.match(describePlan(plan).steps[0], /already on the target/u)
    const runner = targetRunner(plan)
    const manager = new DeployManager({
      repositoryRoot: path.resolve(import.meta.dirname, '..'),
      dataDir: path.join(dir, 'jobs'),
      runnerFactory: () => runner,
    })
    const started = await manager.start({ plan })
    const final = await manager.wait(started.job.id)
    assert.equal(final.status, 'succeeded', JSON.stringify(final))
    assert.equal(final.packageOnTarget, true)
    assert.equal(runner.uploaded.includes(remote), false, 'the build-host archive must not be uploaded again')
    const step = final.steps.find(item => item.key === 'upload')
    assert.match(step.detail, /本地包/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing build-host archive fails before prepare', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-deploy-on-target-missing-'))
  try {
    const remote = '/root/.dsh/mesh/upgrade/job-2/dsh-mesh-1.0-20261118A-linux-x64.tar.gz'
    const plan = await buildDeployPlan({
      host: '10.66.66.3',
      os: 'linux',
      appRoot: '/opt/member',
      packageOnTarget: { path: remote, bytes: 4321, sha256: SHA },
      release: '20261118-on-target',
    })
    const manager = new DeployManager({
      repositoryRoot: path.resolve(import.meta.dirname, '..'),
      dataDir: path.join(dir, 'jobs'),
      runnerFactory: () => targetRunner(plan, { present: false }),
    })
    const started = await manager.start({ plan })
    const final = await manager.wait(started.job.id)
    assert.equal(final.status, 'failed')
    assert.match(final.error, /安装包不可用/u)
    const prepare = final.steps.find(item => item.key === 'prepare')
    assert.notEqual(prepare.status, 'succeeded')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
