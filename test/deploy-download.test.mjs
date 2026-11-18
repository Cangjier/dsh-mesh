import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildDeployPlan, DeployManager } from '../code/deploy/engine.mjs'

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function startFixture(archive, archiveName) {
  const server = http.createServer((request, response) => {
    if (request.url === '/latest.json') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        format: 1,
        assets: {
          'linux-x64': {
            archive: archiveName,
            bytes: archive.length,
            sha256: sha256(archive),
            github: { url: `http://127.0.0.1:${server.address().port}/archive` },
            gitee: null,
          },
        },
      }))
      return
    }
    if (request.url === '/archive') {
      response.writeHead(200, { 'content-length': String(archive.length) })
      response.end(archive)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

/**
 * A runner that pretends the member downloaded the package. It exercises the
 * real engine code paths around the download (node probe, uploads, markers,
 * size check) without an SSH server.
 */
function fakeRunner(plan, options) {
  return {
    plan,
    uploaded: [],
    downloadFailed: options.downloadFailed === true,
    sshOptions: () => [],
    target: () => 'fake',
    async remoteSize(remote) {
      if (remote !== plan.remotePackage) return null
      return (await stat(remote).catch(() => null))?.size ?? null
    },
    async remoteFreeBytes() {
      return 10 * 1024 * 1024 * 1024
    },
    async discardStalePackages() {
      return false
    },
    async upload(local, remote, onProgress) {
      this.uploaded.push(remote)
      if (remote === plan.remotePackage) await copyFile(local, remote)
      onProgress?.({ bytes: 1, totalBytes: 1, percent: 100, speed: 0 })
    },
    async runProcess() {
      if (this.downloadFailed) throw new Error('simulated ssh failure')
      return { stdout: '', stderr: '' }
    },
    async script(script, os, onLine) {
      if (script.includes('DSH-MESH-NODE=')) {
        onLine?.('DSH-MESH-NODE=/usr/bin/node')
        return
      }
      if (script.includes('release-download.mjs')) {
        if (this.downloadFailed) throw new Error('release download failed: simulated')
        await copyFile(options.source, plan.remotePackage)
        onLine?.('DSH-MESH-DOWNLOAD-MANIFEST https://github.com/o/r/releases/download/latest/latest.json')
        onLine?.(`DSH-MESH-DOWNLOAD-PLAN ${String(plan.package.bytes)}`)
        onLine?.(`DSH-MESH-DOWNLOAD ${String(plan.package.bytes)} ${String(plan.package.bytes)}`)
        onLine?.('DSH-MESH-DOWNLOAD-DONE 0 0')
        return
      }
      return
    },
  }
}

test('the deploy engine downloads the package from the release and skips the upload', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-deploy-download-'))
  const local = path.join(dir, 'source.tar.gz')
  const remote = path.join(dir, 'remote.tar.gz')
  let fixture = null
  try {
    const archive = Buffer.alloc(8192, 7)
    await writeFile(local, archive)
    fixture = await startFixture(archive, 'pkg.tar.gz')
    const plan = await buildDeployPlan({
      host: '10.66.66.3',
      package: local,
      os: 'linux',
      appRoot: '/opt/member',
      download: { manifestUrls: [`http://127.0.0.1:${fixture.port}/latest.json`], proxy: null },
    })
    plan.remotePackage = remote
    const runner = fakeRunner(plan, { source: local })
    const manager = new DeployManager({
      repositoryRoot: path.resolve(import.meta.dirname, '..'),
      dataDir: path.join(dir, 'jobs'),
      runnerFactory: () => runner,
    })
    const started = await manager.start({ plan })
    const final = await manager.wait(started.job.id)
    assert.equal(final.status, 'succeeded', JSON.stringify(final))
    assert.equal(runner.uploaded.includes(remote), false, 'the gateway must not upload the archive')
    const step = final.steps.find(item => item.key === 'upload')
    assert.match(step.detail, /下载/u)
    assert.match(step.detail, /GitHub Release/u)
    assert.equal((await readFile(remote)).length, archive.length)
  } finally {
    fixture?.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed release download falls back to the gateway upload', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-deploy-download-fallback-'))
  const local = path.join(dir, 'source.tar.gz')
  const remote = path.join(dir, 'remote.tar.gz')
  let fixture = null
  try {
    const archive = Buffer.alloc(4096, 3)
    await writeFile(local, archive)
    fixture = await startFixture(archive, 'pkg.tar.gz')
    const plan = await buildDeployPlan({
      host: '10.66.66.3',
      package: local,
      os: 'linux',
      appRoot: '/opt/member',
      download: { manifestUrls: [`http://127.0.0.1:${fixture.port}/latest.json`], proxy: null },
    })
    plan.remotePackage = remote
    const runner = fakeRunner(plan, { source: local, downloadFailed: true })
    const manager = new DeployManager({
      repositoryRoot: path.resolve(import.meta.dirname, '..'),
      dataDir: path.join(dir, 'jobs'),
      runnerFactory: () => runner,
    })
    const started = await manager.start({ plan })
    const final = await manager.wait(started.job.id)
    assert.equal(final.status, 'succeeded', JSON.stringify(final))
    assert.ok(runner.uploaded.includes(remote), 'the fallback must upload the archive')
    const step = final.steps.find(item => item.key === 'upload')
    assert.match(step.detail, /上传|\/s/u)
  } finally {
    fixture?.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
