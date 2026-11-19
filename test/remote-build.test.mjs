import assert from 'node:assert/strict'
import test from 'node:test'
import { RM_TREE_SCRIPT, decodeWindowsState, phaseFromLine, powershellCommand, remoteBuildScript, windowsBuildScript, windowsCleanupScript } from '../src/lib/remote-build.mjs'

test('phaseFromLine follows the engine markers', () => {
  assert.deepEqual(phaseFromLine('job created'), { phase: 'prepare', percent: 2 })
  assert.deepEqual(phaseFromLine('extracting 4f2c.tar.gz to /tmp/x/src'), { phase: 'prepare', percent: 6 })
  assert.equal(phaseFromLine('applied account-login: packages/client/x.ts')?.phase, 'apply')
  assert.deepEqual(phaseFromLine('needs-fix: 1 overlay(s) no longer match'), {
    phase: 'apply',
    percent: 14,
    status: 'needs-fix',
  })
  assert.equal(phaseFromLine('$ pnpm install --frozen-lockfile')?.phase, 'build')
  assert.equal(phaseFromLine('$ pnpm run build:web')?.percent, 50)
  assert.equal(phaseFromLine('packaged linux-x64: /tmp/x/dist/a.tar.gz')?.phase, 'package')
  assert.deepEqual(phaseFromLine('smoke linux-x64: starting the packaged DSH under headless Chrome'), { phase: 'smoke', percent: 82, currentTarget: 'linux-x64' })
  assert.deepEqual(phaseFromLine('smoke linux-x64: passed (/job/smoke/linux-x64/mesh.png)'), { phase: 'smoke', percent: 95, currentTarget: 'linux-x64' })
  assert.deepEqual(phaseFromLine('smoke linux-x64: failed (mesh-sidebar: 0)'), { phase: 'smoke', percent: 95, currentTarget: 'linux-x64', status: 'smoke-failed' })
  assert.deepEqual(phaseFromLine('build complete'), { phase: 'fetch', percent: 96 })
  assert.deepEqual(phaseFromLine('failed: download failed'), { phase: 'failed', status: 'failed' })
  assert.equal(phaseFromLine('something unrelated'), null)
})

test('phaseFromLine gives each target its own slice', () => {
  const targets = ['linux-x64', 'win-x64']
  // The packaging share (65 → 95) is split in half, so the second target keeps
  // the bar moving instead of stalling at the first target's smoke percentage.
  assert.equal(phaseFromLine('packaged linux-x64: /tmp/a.tar.gz', targets)?.percent, 80)
  assert.equal(phaseFromLine('smoke linux-x64: starting the packaged DSH', targets)?.percent, 73)
  assert.equal(phaseFromLine('packaged win-x64: /tmp/b.zip', targets)?.percent, 95)
  assert.equal(phaseFromLine('smoke win-x64: starting the packaged DSH', targets)?.percent, 88)
  assert.equal(phaseFromLine('smoke win-x64: passed (/tmp/x.png)', targets)?.percent, 95)
  assert.equal(phaseFromLine('packaged win-x64: /tmp/b.zip', targets)?.currentTarget, 'win-x64')
})

test('phaseFromLine keeps the long silent steps moving', () => {
  const targets = ['linux-x64', 'win-x64']
  // pnpm prints these while it links 1400+ packages; without a rule the bar
  // stayed at 18% for the whole install.
  assert.deepEqual(phaseFromLine('Progress: resolved 1437, reused 1430, added 50'), { phase: 'build', percent: 30 })
  // The prepare recipes are two silent runs of 1-2 minutes each; they used to
  // match nothing, so the panel sat at 18% for seven minutes.
  assert.deepEqual(phaseFromLine('$ pnpm exec tsx scripts/compile-referenced-projects.ts client'), { phase: 'build', percent: 44 })
  assert.deepEqual(phaseFromLine('$ pnpm exec tsdown --config-loader native --env.DSH_BUILD_FACE client'), { phase: 'build', percent: 44 })
  // A target announces itself before its three-minute npm install.
  assert.deepEqual(phaseFromLine('packaging win-x64', targets), { phase: 'package', percent: 80, currentTarget: 'win-x64' })
  assert.deepEqual(phaseFromLine('packaging linux-x64', targets), { phase: 'package', percent: 65, currentTarget: 'linux-x64' })
  // The install line belongs to the target the engine last announced, not to
  // the first target of the job.
  assert.deepEqual(phaseFromLine('$ npm install @deepseek-ai/dsh@0.2.2-rc.5 --os=win32 --cpu=x64', targets, { currentTarget: 'win-x64' }), {
    phase: 'package',
    percent: 82,
    currentTarget: 'win-x64',
  })
  assert.equal(phaseFromLine('patching dsh-client-ui-chat client bundle', targets, { currentTarget: 'win-x64' })?.currentTarget, 'win-x64')
  // Runtime extraction and compression are the other long silent steps.
  assert.deepEqual(phaseFromLine('node runtime win-x64', targets), { phase: 'package', percent: 93, currentTarget: 'win-x64' })
  assert.deepEqual(phaseFromLine('archiving linux-x64', targets), { phase: 'package', percent: 78, currentTarget: 'linux-x64' })
  assert.deepEqual(phaseFromLine('archiving win-x64', targets), { phase: 'package', percent: 93, currentTarget: 'win-x64' })
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
  // Old job dirs are removed, then the free-space floor is checked before the
  // download starts, so a full member disk fails fast with a readable reason.
  assert.match(script, /find "\$HOME\/\.dsh\/mesh\/build" -mindepth 1 -maxdepth 1 -type d ! -name 'job-1' -exec rm -rf/u)
  // Archives staged for an older automatic upgrade are pruned too.
  assert.match(script, /find "\$HOME\/\.dsh\/mesh\/upgrade" -mindepth 1 -maxdepth 1 -type d ! -name 'job-1' -exec rm -rf/u)
  assert.match(script, /free_kb=\$\(df -Pk "\$HOME"/u)
  assert.match(script, /not enough free space on the build host/u)
})

test('remote build scripts pass the daily build stamp to the engine', () => {
  const linux = remoteBuildScript({
    jobId: 'job-stamp',
    ref: 'dsh-v0.2.2-rc.3',
    targets: ['linux-x64'],
    buildStamp: '20261115A',
  })
  assert.match(linux, /--build-stamp '20261115A'/u)
  const windows = windowsBuildScript({
    jobId: 'job-stamp-win',
    ref: 'dsh-v0.2.2-rc.3',
    targets: ['linux-x64'],
    buildStamp: '20261115A',
    appRoot: 'C:\\Users\\Admin\\.dsh\\dsh-mesh\\current',
  })
  assert.match(windows, /--build-stamp '20261115A'/u)
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
  // Remove-Item cannot delete node_modules paths past MAX_PATH; the cleanup
  // goes through Node, and the free-space check runs after it.
  assert.match(script, /fs\.rmSync/u)
  assert.match(script, /not enough free space on the build host/u)
})

test('windowsBuildScript retries the checkout download before failing', () => {
  const script = windowsBuildScript({
    jobId: 'job-retry',
    ref: 'main',
    targets: ['win-x64'],
    proxyUrl: 'http://10.66.66.2:8888',
  })
  // One reset on the tunnel must not fail the whole build: a real observed
  // failure (curl 56 after 49 ms) only needed a second attempt.
  assert.match(script, /\$attempts = 4/u)
  assert.match(script, /for \(\$attempt = 1; \$attempt -le \$attempts; \$attempt\+\+\)/u)
  assert.match(script, /download attempt \{0\}\/\{1\} failed \(\{2\}\)/u)
  assert.match(script, /Start-Sleep -Seconds \(3 \* \$attempt\)/u)
  // Each attempt starts clean, so a truncated archive is never extracted.
  assert.match(script, /Remove-Item -Force \$archive/u)
  assert.match(script, /throw "mesh download failed \(\$downloadCode\)"/u)
  assert.match(script, /--connect-timeout 20/u)
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

test('windowsBuildScript prunes leftovers in the background', () => {
  const script = windowsBuildScript({ jobId: 'job-bg', ref: 'main', targets: ['win-x64'] })
  // Deleting a 1.9 GiB / 112k-file tree synchronously cost ~80 s in front of
  // every build; it now overlaps the checkout download.
  assert.match(script, /Start-Process -FilePath \(Join-Path \$nodeDir 'node\.exe'\)/u)
  assert.match(script, /rm-tree\.cjs/u)
  assert.match(script, /WaitForExit\(600000\)/u)
  assert.doesNotMatch(script, /ForEach-Object \{ & \(Join-Path \$nodeDir 'node\.exe'\) -e \$rmScript/u)
  // The free-space guard still means something on a full disk.
  assert.match(script, /not enough free space on the build host/u)
  assert.match(script, /fs\.rmSync/u)
  assert.match(script, /\$rmScript = @'/u)
  assert.match(script, /^'@$/mu)
})

test('windowsCleanupScript resolves node like the build and reports leftovers', () => {
  const script = windowsCleanupScript({ jobId: 'job-x', appRoot: 'C:\\Users\\Admin\\.dsh' })
  // The pointer layout keeps node at <appRoot>\runtime\node; the old cleanup
  // only looked inside .dsh-mesh\current and fell back to Remove-Item.
  assert.match(script, /'C:\\Users\\Admin\\\.dsh\\runtime\\node'/u)
  assert.match(script, /\.dsh\\runtime\\node/u)
  assert.match(script, /rm-tree\.cjs/u)
  assert.match(script, /DSH-MESH-REMOVED=/u)
  assert.match(script, /DSH-MESH-LEFTOVER=/u)
  // The staged upgrade archive for this job must survive the cleanup: the
  // automatic upgrade reads it right after the job settles.
  assert.doesNotMatch(script, /upgrade/u)
  assert.match(RM_TREE_SCRIPT, /fs\.rmSync/u)
})

test('decodeWindowsState survives noise and non-ASCII state', () => {
  const state = { id: 'job-9', status: 'needs-fix', mismatches: [{ doc: 'docs/Step 005 账号登录前端补丁.md' }] }
  const encoded = Buffer.from(JSON.stringify(state, null, 2), 'utf8').toString('base64')
  const decoded = decodeWindowsState(`#< CLIXML\r\n${encoded}\r\n`)
  assert.equal(decoded.id, 'job-9')
  assert.equal(decoded.mismatches[0].doc, 'docs/Step 005 账号登录前端补丁.md')
})

test('remote build scripts pass the published release config, or disable publishing', () => {
  const linux = remoteBuildScript({
    jobId: 'job-release',
    ref: 'main',
    targets: ['linux-x64'],
    releaseConfigRemote: '/tmp/dsh-mesh-release-job-release.json',
    publish: true,
  })
  assert.match(linux, /--release-config '\/tmp\/dsh-mesh-release-job-release\.json'/u)
  const windows = windowsBuildScript({
    jobId: 'job-release',
    ref: 'main',
    targets: ['win-x64'],
    releaseConfigRemote: 'C:\\Users\\Admin\\AppData\\Local\\Temp\\dsh-mesh-release-job-release.json',
    publish: true,
  })
  assert.match(windows, /--release-config 'C:\\Users\\Admin\\AppData\\Local\\Temp\\dsh-mesh-release-job-release\.json'/u)
  const disabled = remoteBuildScript({ jobId: 'job-release', ref: 'main', targets: ['linux-x64'], publish: false })
  assert.match(disabled, /--no-publish/u)
  // No config path means the member must not fall back to a stale local file.
  const noPath = remoteBuildScript({ jobId: 'job-release', ref: 'main', targets: ['linux-x64'] })
  assert.match(noPath, /--no-publish/u)
})

test('remote build scripts carry the web-only switch', () => {
  const linux = remoteBuildScript({ jobId: 'job-web', ref: 'main', targets: ['linux-x64'], full: false })
  assert.match(linux, /--web-only/u)
  const windows = windowsBuildScript({ jobId: 'job-web-win', ref: 'main', targets: ['win-x64'], full: false })
  assert.match(windows, /--web-only/u)
  // A full build (the default) must not silently become a web-only one.
  assert.doesNotMatch(remoteBuildScript({ jobId: 'job-full', ref: 'main', targets: ['linux-x64'] }), /--web-only/u)
})
