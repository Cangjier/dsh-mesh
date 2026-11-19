import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

const RUNNER = path.resolve(import.meta.dirname, '..', 'code', 'deploy', 'runner.mjs')

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

function runRunner(jobDir, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, '--job', jobDir], {
      env: { ...process.env, DSH_MESH_UPGRADE_NO_RESTART: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('exit', code => resolve({ code, stdout, stderr }))
  })
}

test('a local latest-tag upgrade downloads, verifies, and runs the package upgrade', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-local-acquire-'))
  let fixture = null
  try {
    // A package only needs the upgrade entry point for this test: the runner
    // downloads and extracts it, then the no-op script stands in for the real
    // in-place upgrade.
    const pack = path.join(dir, 'pack', 'dsh-mesh-test')
    await mkdir(path.join(pack, 'code', 'deploy'), { recursive: true })
    await writeFile(
      path.join(pack, 'code', 'deploy', 'upgrade-local.mjs'),
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.DSH_TEST_MARKER, 'ran')\n`,
    )
    const archive = path.join(dir, 'dsh-mesh-test-linux-x64.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', path.dirname(pack), path.basename(pack)])

    fixture = await startFixture(await readFile(archive), 'dsh-mesh-test-linux-x64.tar.gz')
    const jobDir = path.join(dir, 'job')
    const output = path.join(dir, 'packages', 'dsh-mesh-test-linux-x64.tar.gz')
    const marker = path.join(dir, 'marker.txt')
    await mkdir(jobDir, { recursive: true })
    await writeFile(path.join(jobDir, 'request.json'), JSON.stringify({
      kind: 'inplace',
      id: 'deploy-test',
      member: 'local',
      inplace: {
        package: output,
        appRoot: path.join(dir, 'fake-root'),
        acquire: {
          name: 'dsh-mesh-test-linux-x64.tar.gz',
          bytes: (await readFile(archive)).length,
          sha256: sha256(await readFile(archive)),
          manifests: [{ provider: 'github', url: `http://127.0.0.1:${fixture.port}/latest.json` }],
          prefer: 'gitee',
        },
      },
    }))
    const result = await runRunner(jobDir, { DSH_TEST_MARKER: marker })
    assert.equal(result.code, 0, result.stderr)
    const state = JSON.parse(await readFile(path.join(jobDir, 'job.json'), 'utf8'))
    assert.equal(state.status, 'succeeded', JSON.stringify(state))
    assert.equal(await readFile(output, 'utf8').then(text => text.length > 0), true)
    const upload = state.steps.find(step => step.key === 'upload')
    assert.match(upload.detail, /下载/u)
    // The no-op package script ran; it writes to this environment variable.
    assert.equal(await readFile(marker, 'utf8').catch(() => ''), 'ran')
  } finally {
    fixture?.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
