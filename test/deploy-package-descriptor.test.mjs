import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDeployPlan,
  buildLinuxPrepareScript,
  buildWindowsPrepareScript,
  releaseDownloadScript,
} from '../code/deploy/engine.mjs'

const SHA = 'b'.repeat(64)
const ARCHIVE = 'dsh-mesh-0.2.2-rc.5-20261119F-linux-x64.tar.gz'

test('a release descriptor builds a plan with no local file', async () => {
  const plan = await buildDeployPlan({
    host: '10.66.66.3',
    os: 'linux',
    appRoot: '/opt/member',
    packageDescriptor: { name: ARCHIVE, bytes: 1234, sha256: SHA, local: false },
    download: { manifests: [{ provider: 'gitee', url: 'https://gitee.com/o/r/latest.json' }], proxy: null, prefer: 'gitee' },
  })
  assert.equal(plan.package.path, ARCHIVE)
  assert.equal(plan.package.archive, ARCHIVE)
  assert.equal(plan.package.bytes, 1234)
  assert.equal(plan.package.sha256, SHA)
  assert.equal(plan.package.local, false)
  assert.equal(plan.package.keep, false)
  assert.match(plan.remotePackage, /^\/tmp\/dsh-mesh-[a-f0-9]{12}\.tar\.gz$/u)
  assert.equal(plan.download.prefer, 'gitee')
})

test('the release downloader command carries the archive name and Gitee preference', async () => {
  const plan = await buildDeployPlan({
    host: '10.66.66.3',
    os: 'linux',
    appRoot: '/opt/member',
    packageDescriptor: { name: ARCHIVE, bytes: 1234, sha256: SHA, local: false },
  })
  const script = releaseDownloadScript(plan, {
    node: '/usr/bin/node',
    remoteDir: '/tmp/dsh-mesh-release-abc',
    manifests: [
      { provider: 'gitee', url: 'https://gitee.com/o/r/latest.json' },
      { provider: 'github', url: 'https://github.com/o/r/latest.json' },
    ],
    proxyUrl: null,
    prefer: 'gitee',
  })
  assert.match(script, new RegExp(`--archive '${ARCHIVE.replace(/\./gu, '\\.')}'`, 'u'))
  assert.match(script, /--prefer gitee/u)
  assert.match(script, /--manifest-gitee/u)
  assert.match(script, /--manifest-github/u)
})

test('a package picked from the member cache is kept after extraction', async () => {
  const keep = await buildDeployPlan({
    host: '10.66.66.3',
    os: 'linux',
    appRoot: '/opt/member',
    packageOnTarget: {
      path: '/root/.dsh/packages/dsh-mesh-0.2.2-20261119F-linux-x64.tar.gz',
      bytes: 1234,
      sha256: SHA,
      keep: true,
    },
  })
  assert.equal(keep.package.keep, true)
  assert.equal(buildLinuxPrepareScript(keep).includes('rm -f "$PACKAGE"'), false)
  assert.match(buildWindowsPrepareScript(keep), /\$KeepPackage = \$true/u)

  const remove = await buildDeployPlan({
    host: '10.66.66.3',
    os: 'linux',
    appRoot: '/opt/member',
    packageOnTarget: {
      path: '/root/.dsh/mesh/upgrade/job/dsh-mesh-0.2.2-20261119F-linux-x64.tar.gz',
      bytes: 1234,
      sha256: SHA,
    },
  })
  assert.equal(remove.package.keep, false)
  assert.equal(buildLinuxPrepareScript(remove).includes('rm -f "$PACKAGE"'), true)
  assert.match(buildWindowsPrepareScript(remove), /\$KeepPackage = \$false/u)
})
