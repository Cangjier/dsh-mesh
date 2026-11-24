import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MeshService } from '../src/lib/service.mjs'

const SHA = 'c'.repeat(64)
const ARCHIVE = 'dsh-mesh-0.2.2-rc.5-20261119F-linux-x64.tar.gz'
const SEVEN = 'dsh-mesh-0.2.2-rc.5-20261120A-win-x64.7z'

/**
 * A service whose member table and release manifest are fixtures.
 * @param {string} dir test directory.
 * @returns {MeshService} service.
 */
function fixtureService(dir) {
  const service = new MeshService({
    dataDir: path.join(dir, 'mesh'),
    config: {},
    log: () => {},
    spawnRunner: async () => ({ mode: 'test', unit: null }),
  })
  service.members = async () => ({
    local: {
      id: 'local',
      kind: 'self',
      name: 'gateway',
      ip: '10.66.66.1',
      online: true,
      dsh: true,
      system: { platform: 'linux', arch: 'x64', home: '/root', appRoot: '/opt/gateway', user: 'root' },
    },
    members: [{
      id: 'b',
      kind: 'peer',
      name: 'B',
      ip: '10.66.66.2',
      online: true,
      dsh: true,
      system: { platform: 'linux', arch: 'x64', home: '/root', appRoot: '/opt/b', user: 'root' },
    }],
  })
  service.latestRelease = async () => ({
    ok: true,
    configured: true,
    assets: [{ target: 'linux-x64', os: 'linux', arch: 'x64', name: ARCHIVE, bytes: 4321, sha256: SHA, providers: ['gitee', 'github'] }],
    manifestUrls: [
      'https://gitee.com/o/r/releases/download/latest/latest.json',
      'https://github.com/o/r/releases/download/latest/latest.json',
    ],
    manifests: [
      { provider: 'gitee', url: 'https://gitee.com/o/r/releases/download/latest/latest.json' },
      { provider: 'github', url: 'https://github.com/o/r/releases/download/latest/latest.json' },
    ],
  })
  return service
}

test('a latest-tag upgrade builds a release-only plan and prefers Gitee', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-service-latest-'))
  try {
    const service = fixtureService(dir)
    const result = await service.startDeploy({ member: 'b', release: { target: 'linux-x64' }, mode: 'upgrade' })
    assert.equal(result.job.package, ARCHIVE)
    assert.equal(result.job.progress.totalBytes, 4321)
    const request = JSON.parse(await readFile(path.join(dir, 'mesh', 'deploy', result.job.id, 'request.json'), 'utf8'))
    assert.equal(request.plan.package.local, false)
    assert.equal(request.plan.package.sha256, SHA)
    assert.equal(request.plan.download.prefer, 'gitee')
    assert.deepEqual(request.plan.download.manifests.map(entry => entry.provider), ['gitee', 'github'])
    assert.equal(request.options.packageDescriptor.name, ARCHIVE)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a target package outside the member roots is rejected before any SSH', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-service-target-reject-'))
  try {
    const service = fixtureService(dir)
    await assert.rejects(
      service.startDeploy({
        member: 'b',
        targetPackage: { path: '/etc/dsh-mesh-0.2.2-20261119F-linux-x64.tar.gz' },
        mode: 'upgrade',
      }),
      /不在该成员/u,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the local member lists its package cache and build staging', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-service-member-packages-'))
  try {
    const service = new MeshService({
      dataDir: path.join(dir, 'mesh'),
      config: {},
      log: () => {},
      spawnRunner: async () => ({ mode: 'test', unit: null }),
    })
    service.members = async () => ({
      local: { id: 'local', kind: 'self', name: 'gateway', ip: '10.66.66.1', online: true, dsh: true, system: { platform: 'linux', arch: 'x64', home: '/root', appRoot: '/opt/gateway' } },
      members: [],
    })
    const packagesDir = path.join(dir, 'packages')
    const staging = path.join(dir, 'mesh', 'upgrade', 'job-1')
    await mkdir(packagesDir, { recursive: true })
    await mkdir(staging, { recursive: true })
    await writeFile(path.join(packagesDir, ARCHIVE), 'archive')
    await writeFile(path.join(packagesDir, `${ARCHIVE}.sha256`), `${SHA}  ${ARCHIVE}\n`)
    await writeFile(path.join(packagesDir, SEVEN), 'archive')
    await writeFile(path.join(staging, 'dsh-mesh-0.2.2-20261118F-linux-x64.tar.gz'), 'old')
    service.packagesDir = packagesDir
    const result = await service.memberPackages('local')
    assert.equal(result.ok, true)
    assert.equal(result.packages.length, 3)
    assert.equal(result.packages.find(item => item.name === SEVEN)?.target, 'win-x64')
    const latest = result.packages.find(item => item.name === ARCHIVE)
    assert.equal(latest.sha256, SHA)
    assert.equal(latest.target, 'linux-x64')
    assert.ok(result.packages.some(item => item.name.includes('20261118F')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('only deployable dsh-mesh archives are listed and accepted by name', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-service-packages-'))
  try {
    const service = fixtureService(dir)
    const packagesDir = path.join(dir, 'packages')
    await mkdir(packagesDir, { recursive: true })
    const plugin = 'dsh-mesh-plugin-0.2.0-20261123-1735.tgz'
    await writeFile(path.join(packagesDir, ARCHIVE), 'archive')
    await writeFile(path.join(packagesDir, plugin), 'plugin bytes')
    await writeFile(path.join(packagesDir, 'notes.txt'), 'text')
    service.packagesDir = packagesDir
    const listed = await service.packages()
    assert.deepEqual(listed.packages.map(item => item.name), [ARCHIVE])
    assert.equal(listed.packages[0].target, 'linux')
    await assert.rejects(
      service.startDeploy({ member: 'b', package: plugin, mode: 'upgrade' }),
      /不是 dsh-mesh 部署包/u,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('removePackage accepts a 7z archive and refuses other files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-service-remove-package-'))
  try {
    const service = new MeshService({
      dataDir: path.join(dir, 'mesh'),
      config: {},
      log: () => {},
      spawnRunner: async () => ({ mode: 'test', unit: null }),
    })
    const packagesDir = path.join(dir, 'packages')
    await mkdir(packagesDir, { recursive: true })
    service.packagesDir = packagesDir
    await writeFile(path.join(packagesDir, SEVEN), 'archive')
    await writeFile(path.join(packagesDir, 'notes.txt'), 'text')
    const result = await service.removePackage({ name: SEVEN })
    assert.equal(result.ok, true)
    await assert.rejects(readFile(path.join(packagesDir, SEVEN)))
    await assert.rejects(service.removePackage({ name: 'notes.txt' }), /not a package name/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a latest-tag upgrade of the local gateway queues an in-place acquire job', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-service-latest-local-'))
  try {
    const root = path.join(dir, 'root')
    const release = path.join(root, 'releases', 'r1')
    const plugin = path.join(release, 'plugins', 'dsh-mesh')
    await mkdir(plugin, { recursive: true })
    await mkdir(path.join(root, 'config'), { recursive: true })
    await writeFile(path.join(root, 'dsh-mesh.json'), JSON.stringify({ format: 1, layout: 'pointer', active: 'releases/r1' }))
    await writeFile(path.join(root, 'config', 'gate.env'), 'DSH_GATE_PASSWORD=x\n')
    const service = fixtureService(dir)
    service.repositoryRoot = plugin
    service.packagesDir = path.join(dir, 'packages')
    const result = await service.startDeploy({ member: 'local', release: { target: 'linux-x64' }, mode: 'upgrade' })
    const request = JSON.parse(await readFile(path.join(dir, 'mesh', 'deploy', result.job.id, 'request.json'), 'utf8'))
    assert.equal(result.layout, 'pointer')
    assert.equal(request.inplace.package, path.join(dir, 'packages', ARCHIVE))
    assert.equal(request.inplace.acquire.name, ARCHIVE)
    assert.equal(request.inplace.acquire.sha256, SHA)
    assert.equal(request.inplace.acquire.prefer, 'gitee')
    assert.deepEqual(request.inplace.acquire.manifests.map(entry => entry.provider), ['gitee', 'github'])
    assert.equal(result.job.release, ARCHIVE)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
