import assert from 'node:assert/strict'
import test from 'node:test'
import { phaseFromLine, remoteBuildScript } from '../src/lib/remote-build.mjs'

test('phaseFromLine follows the engine markers', () => {
  assert.deepEqual(phaseFromLine('job created'), { phase: 'prepare', percent: 4 })
  assert.deepEqual(phaseFromLine('extracting 4f2c.tar.gz to /tmp/x/src'), { phase: 'prepare', percent: 4 })
  assert.equal(phaseFromLine('applied account-login: packages/client/x.ts')?.phase, 'apply')
  assert.deepEqual(phaseFromLine('needs-fix: 1 overlay(s) no longer match'), {
    phase: 'apply',
    percent: 15,
    status: 'needs-fix',
  })
  assert.equal(phaseFromLine('$ pnpm install --frozen-lockfile')?.phase, 'build')
  assert.equal(phaseFromLine('$ pnpm run build:web')?.percent, 45)
  assert.equal(phaseFromLine('packaged linux-x64: /tmp/x/dist/a.tar.gz')?.phase, 'package')
  assert.deepEqual(phaseFromLine('build complete'), { phase: 'done', percent: 100 })
  assert.deepEqual(phaseFromLine('failed: download failed'), { phase: 'failed', percent: 100, status: 'failed' })
  assert.equal(phaseFromLine('something unrelated'), null)
})

test('remoteBuildScript pins the ref, targets, and proxy', () => {
  const script = remoteBuildScript({
    jobId: 'job-1',
    ref: '4f2c9d3',
    targets: ['linux-x64', 'win-x64'],
    proxyUrl: 'http://10.66.66.2:8888',
    repoUrl: 'https://github.com/example/mesh.git',
  })
  assert.match(script, /git clone --depth 1 --branch main 'https:\/\/github\.com\/example\/mesh\.git'/u)
  assert.match(script, /git -C "\$HOME\/\.dsh\/mesh\/build-src" fetch --depth 1 origin main/u)
  assert.match(script, /--ref '4f2c9d3' --targets 'linux-x64,win-x64' --proxy 'http:\/\/10\.66\.66\.2:8888'/u)
  assert.match(script, /NODE_OPTIONS="--max-old-space-size=2048"/u)
  assert.match(script, /npm_config_https_proxy='http:\/\/10\.66\.66\.2:8888'/u)
})

test('remoteBuildScript escapes quotes in values', () => {
  const script = remoteBuildScript({ jobId: 'job-2', ref: "ma'in", targets: ['linux-x64'], proxyUrl: null })
  assert.match(script, /--ref 'ma'\\''in'/u)
  assert.doesNotMatch(script, /--proxy/u)
  assert.match(script, /corepack enable/u)
})
