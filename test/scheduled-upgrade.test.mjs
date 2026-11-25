import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MeshService } from '../src/lib/service.mjs'

/** One normalized `latest` release asset. */
function releaseAsset(name) {
  const windows = /win/iu.test(name)
  return {
    target: windows ? 'win-x64' : 'linux-x64',
    os: windows ? 'windows' : 'linux',
    arch: 'x64',
    name,
    bytes: 1024,
    sha256: 'a'.repeat(64),
    providers: ['gitee', 'github'],
  }
}

/** The release the last real build published (both platforms). */
function release(assets = ['dsh-mesh-0.2.3-alpha.2-20261125A-linux-x64.7z']) {
  return { ok: true, assets: assets.map(releaseAsset) }
}

/** One member row with the fields the scheduled upgrade reads. */
function memberRow(id, options = {}) {
  return {
    id,
    name: options.name ?? id,
    ip: options.ip ?? '10.66.66.2',
    online: options.online ?? true,
    kind: options.kind ?? (id === 'local' ? 'self' : 'peer'),
    system: { platform: options.platform ?? 'linux', arch: 'x64', appRoot: '/opt/dsh', user: 'root' },
    deployment: options.deployment ?? { version: '0.2.3-alpha.2', buildStamp: '20261124A', target: { os: 'linux' } },
  }
}

/**
 * Build a service with the member snapshot and release stubbed.
 * @param {string} dir temp directory.
 * @param {{packages?: object[], release?: object|null, throws?: boolean}} options stubs.
 * @returns {Promise<{service: MeshService, calls: object[], log: string[]}>} prepared service.
 */
async function fixture(dir, options = {}) {
  const log = []
  const service = new MeshService({ dataDir: path.join(dir, 'mesh'), config: {}, log: line => log.push(line) })
  service.members = async () => ({
    local: memberRow('local', { name: 'gateway', kind: 'self', ip: '10.66.66.1' }),
    members: [memberRow('10.66.66.2', { name: 'VM-0-2-ubuntu' })],
  })
  service.deployJobs = async () => []
  service.packages = async () => ({ ok: true, dir: '/tmp/packages', packages: options.packages ?? [] })
  service.latestRelease = async () => {
    if (options.throws === true) throw new Error('manifest unreachable')
    return options.release === undefined ? release() : options.release
  }
  const calls = []
  service.upgradeMember = async (request) => {
    calls.push(request)
    return { ok: true, job: { id: 'deploy-test1' }, member: null, layout: 'pointer', packagesDir: '/tmp/packages' }
  }
  return { service, calls, log }
}

test('a member with no cached package upgrades from the latest release', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-scheduled-upgrade-'))
  const { service, calls, log } = await fixture(dir)
  try {
    const result = await service.scheduledUpgradeMember('10.66.66.2')
    assert.equal(result.status, 'started')
    assert.equal(result.source, 'release')
    assert.equal(result.package, 'dsh-mesh-0.2.3-alpha.2-20261125A-linux-x64.7z')
    assert.equal(result.jobId, 'deploy-test1')
    // The release path carries only the target: the service resolves the
    // manifest URLs and the SHA-256 again when it starts the job.
    assert.deepEqual(calls, [{ member: '10.66.66.2', release: { target: 'linux-x64', refresh: true } }])
    assert.ok(log.some(line => line.includes('via latest')))
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a newer cached package is used without downloading the release', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-scheduled-upgrade-'))
  const local = { name: 'dsh-mesh-0.2.3-alpha.2-20261126A-linux-x64.7z', mtime: '2026-11-26T04:00:00Z', target: 'linux' }
  const { service, calls } = await fixture(dir, { packages: [local] })
  try {
    const result = await service.scheduledUpgradeMember('10.66.66.2')
    assert.equal(result.status, 'started')
    assert.equal(result.source, 'local')
    assert.deepEqual(calls, [{ member: '10.66.66.2', package: local.name }])
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the scheduled upgrade stays skipped when neither source has the platform', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-scheduled-upgrade-'))
  const { service, calls } = await fixture(dir, { release: release(['dsh-mesh-0.2.3-alpha.2-20261125A-win-x64.7z']) })
  try {
    const result = await service.scheduledUpgradeMember('10.66.66.2')
    assert.equal(result.status, 'skipped')
    assert.equal(result.reason, '没有 Linux 部署包')
    assert.equal(calls.length, 0)
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unreadable release falls back to the cached packages without failing the tick', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-scheduled-upgrade-'))
  const local = { name: 'dsh-mesh-0.2.3-alpha.2-20261126A-linux-x64.7z', mtime: '2026-11-26T04:00:00Z', target: 'linux' }
  const { service, calls } = await fixture(dir, { packages: [local], throws: true })
  try {
    const result = await service.scheduledUpgradeMember('10.66.66.2')
    assert.equal(result.status, 'started')
    assert.equal(result.source, 'local')
    assert.equal(calls.length, 1)
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
