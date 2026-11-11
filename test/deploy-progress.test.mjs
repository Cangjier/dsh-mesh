import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DeployManager } from '../code/deploy/engine.mjs'

/**
 * Build a manager whose runner never touches SSH.
 * @param {(plan: object) => object} factory runner factory.
 * @param {string} dataDir job directory.
 * @returns {DeployManager} manager.
 */
function managerWith(factory, dataDir) {
  return new DeployManager({
    repositoryRoot: process.cwd(),
    dataDir,
    runnerFactory: factory,
  })
}

test('a deploy job reports upload progress, steps, and the script log', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mesh-deploy-'))
  const packagePath = path.join(root, 'package.tar.gz')
  await writeFile(packagePath, 'not really a tarball')
  let release
  const gate = new Promise(resolve => { release = resolve })
  const manager = managerWith(() => ({
    async upload(_local, _remote, onProgress) {
      onProgress?.({ bytes: 5, totalBytes: 10, percent: 50, speed: 2, indeterminate: false })
      await gate
      onProgress?.({ bytes: 10, totalBytes: 10, percent: 100, speed: 2, indeterminate: false })
    },
    async script(_script, _os, onLine) {
      onLine?.('prepared release')
    },
  }), path.join(root, 'jobs'))

  try {
    const started = await manager.start({ host: '127.0.0.1', os: 'linux', package: packagePath, appRoot: '/tmp/dsh-test' })
    const id = started.job.id
    assert.equal(started.job.status, 'running')
    assert.deepEqual(started.job.steps.map(step => step.key), ['upload', 'prepare', 'activate'])

    await new Promise(resolve => setTimeout(resolve, 20))
    const live = await manager.status(id)
    assert.equal(live.progress.percent, 50, 'live progress is visible while the upload runs')
    assert.equal(live.steps[0].status, 'running')

    release()
    const final = await manager.wait(id)
    assert.equal(final.status, 'succeeded')
    assert.equal(final.phase, 'done')
    assert.deepEqual(final.steps.map(step => step.status), ['succeeded', 'succeeded', 'succeeded'])
    assert.equal(final.progress.percent, 100)
    assert.ok(final.steps[0].detail.includes('/s'), 'the upload step records size and speed')

    const log = await manager.logs(id, 100)
    assert.match(log, /prepared release/)
    assert.match(log, /deployment succeeded/)

    const jobs = await manager.list(10)
    assert.ok(jobs.some(job => job.id === id), 'the job appears in the recent list')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed step marks the job and that step as failed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mesh-deploy-'))
  const packagePath = path.join(root, 'package.tar.gz')
  await writeFile(packagePath, 'not really a tarball')
  const manager = managerWith(() => ({
    async upload(_local, _remote, onProgress) {
      onProgress?.({ bytes: 10, totalBytes: 10, percent: 100, speed: 5, indeterminate: false })
    },
    async script() {
      throw new Error('prepare exploded')
    },
  }), path.join(root, 'jobs'))

  try {
    const started = await manager.start({ host: '127.0.0.1', os: 'windows', package: packagePath, appRoot: 'C:\\dsh-mesh' })
    const final = await manager.wait(started.job.id)
    assert.equal(final.status, 'failed')
    assert.equal(final.phase, 'failed')
    assert.equal(final.error, 'prepare exploded')
    assert.equal(final.steps[0].status, 'succeeded')
    assert.equal(final.steps[1].status, 'failed')
    assert.equal(final.steps[2].status, 'pending')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
