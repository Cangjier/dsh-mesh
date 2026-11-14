import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeWindowsState, phaseFromLine, powershellCommand, remoteBuildScript, windowsBuildScript } from '../src/lib/remote-build.mjs'

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

test('windowsBuildScript avoids git and uses the bundled node runtime', () => {
  const script = windowsBuildScript({
    jobId: 'job-3',
    ref: 'abc1234',
    targets: ['linux-x64', 'win-x64'],
    proxyUrl: 'http://10.66.66.2:8888',
    appRoot: 'C:\\Users\\Admin\\.dsh\\dsh-mesh\\current',
  })
  assert.match(script, /codeload\.github\.com\/Cangjier\/dsh-mesh\/zip\/refs\/heads\/main/u)
  assert.match(script, /Expand-Archive/u)
  assert.doesNotMatch(script, /tar\.exe -xzf/u)
  assert.doesNotMatch(script, /git clone|git -C/u)
  assert.match(script, /'C:\\Users\\Admin\\.dsh\\dsh-mesh\\current\\runtime\\node'/u)
  assert.match(script, /corepack\.cmd' \) enable|corepack\.cmd/u)
  assert.match(script, /--ref 'abc1234' --targets 'linux-x64,win-x64' --proxy 'http:\/\/10\.66\.66\.2:8888'/u)
  assert.match(script, /HTTP_PROXY/u)
  assert.match(script, /--max-old-space-size=4096/u)
})

test('windowsBuildScript escapes single quotes and omits an unset proxy', () => {
  const script = windowsBuildScript({ jobId: 'job-4', ref: "ma'in", targets: ['win-x64'], proxyUrl: null })
  assert.match(script, /--ref 'ma''in'/u)
  assert.doesNotMatch(script, /HTTP_PROXY/u)
  assert.doesNotMatch(script, / -Proxy /u)
})

test('powershellCommand encodes the snippet as UTF-16LE base64', () => {
  const command = powershellCommand("Write-Output 'hi'")
  const encoded = command.split(' ').pop() ?? ''
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), "Write-Output 'hi'")
  assert.match(command, /^powershell\.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand /u)
})

test('resolveEgressScript finds the script in source and bundled layouts', async () => {
  const { mkdir, writeFile, rm } = await import('node:fs/promises')
  const os = await import('node:os')
  const nodePath = await import('node:path')
  const { resolveEgressScript } = await import('../src/lib/egress.mjs')
  const root = await mkdir(nodePath.join(os.tmpdir(), `dsh-egress-${String(Date.now())}`), { recursive: true })
  const sourceLayout = nodePath.join(root, 'src', 'lib')
  const bundledLayout = nodePath.join(root, 'plugins', 'dsh-mesh')
  for (const dir of [nodePath.join(root, 'code', 'shared'), nodePath.join(bundledLayout, 'code', 'shared')]) {
    await mkdir(dir, { recursive: true })
    await writeFile(nodePath.join(dir, 'egress-proxy.mjs'), '// proxy\n', 'utf8')
  }
  try {
    assert.equal(resolveEgressScript(sourceLayout), nodePath.join(root, 'code', 'shared', 'egress-proxy.mjs'))
    assert.equal(resolveEgressScript(bundledLayout), nodePath.join(bundledLayout, 'code', 'shared', 'egress-proxy.mjs'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('decodeWindowsState survives noise and non-ASCII state', () => {
  const state = { id: 'job-9', status: 'needs-fix', mismatches: [{ doc: 'docs/Step 005 账号登录前端补丁.md' }] }
  const encoded = Buffer.from(JSON.stringify(state, null, 2), 'utf8').toString('base64')
  const decoded = decodeWindowsState(`#< CLIXML\r\n${encoded}\r\n`)
  assert.equal(decoded.id, 'job-9')
  assert.equal(decoded.mismatches[0].doc, 'docs/Step 005 账号登录前端补丁.md')
})
