import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  cancelCleanupScript,
  DeployManager,
  newJobId,
  readDeployState,
  writeDeployState,
} from '../code/deploy/engine.mjs'

/**
 * Write one job directory: state plus the request the detached runner reads.
 * @param {string} deployRoot deploy data root.
 * @param {object} state job state.
 * @param {object|null} request request.json body.
 * @returns {Promise<string>} job directory.
 */
async function seedJob(deployRoot, state, request) {
  const dir = path.join(deployRoot, state.id)
  await mkdir(dir, { recursive: true })
  await writeDeployState(dir, state)
  if (request !== null) await writeFile(path.join(dir, 'request.json'), `${JSON.stringify(request, null, 2)}\n`, 'utf8')
  return dir
}

/** A running state with the given phase and steps. */
function runningState(id, overrides = {}) {
  return {
    id,
    mode: 'upgrade',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    member: '10.66.66.3',
    target: { host: '10.66.66.3', user: 'root', port: 22, os: 'linux', appRoot: '/root/.dsh' },
    release: '20260101000000-abcdef12',
    package: 'dsh-mesh-test-linux-x64.tar.gz',
    services: ['dsh-web-gate.service'],
    status: 'running',
    phase: 'prepare',
    error: null,
    steps: [
      { key: 'upload', label: '获取安装包', status: 'succeeded', startedAt: null, finishedAt: null, detail: '' },
      { key: 'prepare', label: '解压并准备新版本', status: 'running', startedAt: null, finishedAt: null, detail: '' },
      { key: 'activate', label: '切换并重启服务', status: 'pending', startedAt: null, finishedAt: null, detail: '' },
    ],
    progress: { label: '解压安装包', percent: 40, bytes: 0, totalBytes: 0, speed: 0, indeterminate: false },
    ...overrides,
  }
}

test('cancelCleanupScript removes only the staging tree and temp files', () => {
  const sha256 = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
  const plan = {
    os: 'linux',
    release: '20260101000000-abcdef12',
    layoutRoot: '/root/.dsh',
    packageOnTarget: false,
    remotePackage: '/tmp/dsh-mesh-abcdef012345.tar.gz',
    remoteCredentials: '/tmp/dsh-mesh-abcdef012345.account',
    package: { sha256 },
  }
  const cleanup = cancelCleanupScript(plan)
  assert.equal(cleanup.os, 'linux')
  assert.match(cleanup.script, /rm -rf -- '\/root\/\.dsh\/\.staging\/20260101000000-abcdef12'/u)
  assert.match(cleanup.script, /rm -rf -- '\/tmp\/dsh-mesh-release-abcdef012345'/u)
  assert.match(cleanup.script, /rm -rf -- '\/tmp\/dsh-mesh-abcdef012345\.tar\.gz'/u)
  assert.match(cleanup.script, /rm -rf -- '\/tmp\/dsh-mesh-abcdef012345\.account'/u)
  // The install itself is never part of a cancel.
  assert.doesNotMatch(cleanup.script, /releases\//u)
  assert.doesNotMatch(cleanup.script, /current/u)
  assert.doesNotMatch(cleanup.script, /shared/u)
})

test('cancelCleanupScript keeps a package that belongs to the member', () => {
  const cleanup = cancelCleanupScript({
    os: 'windows',
    release: '20260101000000-abcdef12',
    layoutRoot: 'C:\\dsh-mesh',
    packageOnTarget: true,
    remotePackage: 'C:\\Users\\Admin\\.dsh\\packages\\dsh-mesh-test.zip',
    package: { sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' },
  })
  assert.equal(cleanup.os, 'windows')
  assert.ok(cleanup.script.includes('C:\\dsh-mesh\\.staging\\20260101000000-abcdef12'), cleanup.script)
  assert.doesNotMatch(cleanup.script, /packages/u, 'a package chosen on the member must not be deleted')
  assert.equal(cancelCleanupScript(null), null)
  assert.equal(cancelCleanupScript({ os: 'linux', release: 'x' }), null)
})

test('cancelling a running job stops it, cleans up, and records the reason', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-cancel-'))
  const layoutRoot = path.join(root, 'install')
  const staging = path.join(layoutRoot, '.staging', '20260101000000-abcdef12')
  const remotePackage = path.join(os.tmpdir(), 'dsh-mesh-cancel-package.tar.gz')
  try {
    await mkdir(staging, { recursive: true })
    await writeFile(path.join(staging, 'partial'), 'x')
    await writeFile(remotePackage, 'x')
    const manager = new DeployManager({ repositoryRoot: process.cwd(), dataDir: root })
    const id = newJobId()
    await seedJob(root, runningState(id), {
      kind: 'engine',
      options: {
        plan: {
          os: 'linux',
          local: true,
          release: '20260101000000-abcdef12',
          layoutRoot,
          packageOnTarget: false,
          remotePackage,
        },
      },
    })
    const job = await manager.cancel(id)
    assert.equal(job.status, 'cancelled')
    assert.equal(job.phase, 'cancelled')
    assert.match(String(job.error), /已取消/u)
    assert.equal(job.steps.find(step => step.key === 'prepare').status, 'cancelled')
    assert.equal(job.progress.label, '已取消')
    // The staging tree and the temp archive are gone; the job directory stays.
    await assert.rejects(stat(staging))
    await assert.rejects(stat(remotePackage))
    const stored = JSON.parse(await readFile(path.join(root, id, 'job.json'), 'utf8'))
    assert.equal(stored.status, 'cancelled')
    const log = await readFile(path.join(root, id, 'deploy.log'), 'utf8')
    assert.match(log, /cancel requested by user/u)
    assert.match(log, /cancelled by user/u)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(remotePackage, { force: true })
  }
})

test('cancelling a live runner kills it instead of letting it write afterwards', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-cancel-live-'))
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
  try {
    const manager = new DeployManager({ repositoryRoot: process.cwd(), dataDir: root })
    const id = newJobId()
    const dir = await seedJob(root, runningState(id), { kind: 'engine', options: { plan: null } })
    await writeFile(path.join(dir, 'runner.json'), JSON.stringify({
      pid: child.pid,
      ppid: 1,
      host: os.hostname(),
      unit: '',
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    }), 'utf8')
    const job = await manager.cancel(id)
    assert.equal(job.status, 'cancelled')
    // The signal is not just sent: the process is gone before the state is rewritten.
    assert.throws(() => process.kill(child.pid, 0), /ESRCH/u)
  } finally {
    try { process.kill(child.pid, 'SIGKILL') } catch { /* already gone */ }
    await rm(root, { recursive: true, force: true })
  }
})

test('cancel refuses once the services are being switched', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-cancel-activate-'))
  try {
    const manager = new DeployManager({ repositoryRoot: process.cwd(), dataDir: root })
    const id = newJobId()
    const state = runningState(id, { phase: 'activate' })
    state.steps.find(step => step.key === 'prepare').status = 'succeeded'
    state.steps.find(step => step.key === 'activate').status = 'running'
    await seedJob(root, state, { kind: 'engine', options: { plan: null } })
    await assert.rejects(manager.cancel(id), /切换并重启服务/u)
    const stored = await readDeployState(path.join(root, id))
    assert.equal(stored.status, 'running')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cancel leaves a finished job alone and returns unknown jobs as null', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-cancel-done-'))
  try {
    const manager = new DeployManager({ repositoryRoot: process.cwd(), dataDir: root })
    const id = newJobId()
    await seedJob(root, runningState(id, { status: 'succeeded', phase: 'done' }), null)
    const job = await manager.cancel(id)
    assert.equal(job.status, 'succeeded')
    assert.equal(job.error, null)
    assert.equal(await manager.cancel(newJobId()), null)
    assert.equal(await manager.cancel('not-a-job'), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
