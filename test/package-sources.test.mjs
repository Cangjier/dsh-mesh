import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isAllowedPackagePath,
  listPackagesScript,
  normalizeLatestManifest,
  packagePlatformFromName,
  packageTargetFromName,
  parseTargetPackageList,
  selectLatestAsset,
} from '../src/lib/package-sources.mjs'

const SHA = 'a'.repeat(64)

const manifest = {
  format: 1,
  version: '0.2.2-rc.5',
  buildStamp: '20261119F',
  publishedAt: '2026-11-19T07:39:46.984Z',
  assets: {
    'linux-x64': {
      archive: 'dsh-mesh-0.2.2-rc.5-20261119F-linux-x64.tar.gz',
      bytes: 318912868,
      sha256: SHA,
      github: { url: 'https://github.com/o/r/releases/download/latest/a.tar.gz' },
      gitee: { parts: [{ name: 'a.tar.gz.part001', bytes: 1 }], urls: ['https://gitee.com/o/r/releases/download/latest/a.tar.gz.part001'] },
    },
    'win-x64': {
      archive: 'dsh-mesh-0.2.2-rc.5-20261119F-win-x64.zip',
      bytes: 442020272,
      sha256: SHA,
      github: { url: 'https://github.com/o/r/releases/download/latest/a.zip' },
      gitee: null,
    },
    'bad-target': {
      archive: 'dsh-mesh-0.2.2-rc.5-20261119F-linux-x64.tar.gz',
      bytes: 1,
      sha256: SHA,
      github: { url: 'https://example.invalid/a' },
    },
    'linux-arm64': {
      archive: 'dsh-mesh-0.2.2-rc.5-20261119F-linux-x64.tar.gz',
      bytes: 1,
      sha256: 'not-a-digest',
      github: { url: 'https://example.invalid/a' },
    },
  },
}

test('archive names carry version, build stamp, OS and target', () => {
  const parsed = packageTargetFromName('dsh-mesh-0.2.2-rc.5-20261119F-win-x64.zip')
  assert.deepEqual(parsed, {
    version: '0.2.2-rc.5',
    buildStamp: '20261119F',
    os: 'windows',
    arch: 'x64',
    target: 'win-x64',
  })
  assert.equal(packageTargetFromName('dsh-mesh-unknown.zip'), null)
  assert.equal(packageTargetFromName('dsh-mesh-0.2.2-20261119F-linux-arm64.tgz')?.target, 'linux-arm64')
})

test('a platform suffix marks a deployment archive; a plugin bundle is not one', () => {
  assert.deepEqual(packagePlatformFromName('dsh-mesh-0.2.2-linux-x64.tar.gz'), {
    version: '0.2.2',
    os: 'linux',
    arch: 'x64',
    target: 'linux-x64',
  })
  assert.equal(packagePlatformFromName('dsh-mesh-0.2.2-rc.5-20261119F-win-x64.7z')?.os, 'windows')
  assert.equal(packagePlatformFromName('dsh-mesh-plugin-0.2.0-20261123-1735.tgz'), null)
  assert.equal(packagePlatformFromName('dsh-mesh-plugin-linux-x64.tgz'), null)
  assert.equal(packagePlatformFromName('notes.txt'), null)
})

test('latest.json normalization keeps valid targets and provider availability', () => {
  const release = normalizeLatestManifest(manifest, {
    provider: 'gitee',
    manifestUrls: ['https://gitee.com/o/r/latest.json', 'https://github.com/o/r/latest.json'],
  })
  assert.equal(release.ok, true)
  assert.equal(release.provider, 'gitee')
  assert.equal(release.version, '0.2.2-rc.5')
  assert.deepEqual(release.assets.map(asset => asset.target), ['linux-x64', 'win-x64'])
  assert.deepEqual(release.assets[0].providers, ['github', 'gitee'])
  assert.deepEqual(release.assets[1].providers, ['github'])
  assert.equal(release.manifestUrls.length, 2)
})

test('latest asset selection matches the member target and accepts windows- alias', () => {
  const release = normalizeLatestManifest(manifest)
  assert.equal(selectLatestAsset(release, 'win-x64')?.name, 'dsh-mesh-0.2.2-rc.5-20261119F-win-x64.zip')
  assert.equal(selectLatestAsset(release, 'windows-x64')?.target, 'win-x64')
  assert.equal(selectLatestAsset(release, 'linux-arm64'), null)
})

test('target package paths are limited to the member package roots', () => {
  const linux = '/root/.dsh/packages/dsh-mesh-0.2.2-20261119F-linux-x64.tar.gz'
  assert.equal(isAllowedPackagePath(linux, '/root', 'linux'), true)
  assert.equal(isAllowedPackagePath('/root/.dsh/mesh/upgrade/job/dsh-mesh-0.2.2-20261119F-linux-x64.tar.gz', '/root', 'linux'), true)
  assert.equal(isAllowedPackagePath('/root/other/dsh-mesh-0.2.2-20261119F-linux-x64.tar.gz', '/root', 'linux'), false)
  assert.equal(isAllowedPackagePath('/root/.dsh/packages/../../etc/dsh-mesh-0.2.2-20261119F-linux-x64.tar.gz', '/root', 'linux'), false)
  assert.equal(isAllowedPackagePath('/root/.dsh/packages/not-a-package.tar.gz', '/root', 'linux'), false)

  const windows = 'C:\\Users\\Admin\\.dsh\\mesh\\upgrade\\job\\dsh-mesh-0.2.2-20261119F-win-x64.zip'
  assert.equal(isAllowedPackagePath(windows, 'C:\\Users\\Admin', 'windows'), true)
  assert.equal(isAllowedPackagePath('C:\\Users\\Admin\\Downloads\\dsh-mesh-0.2.2-20261119F-win-x64.zip', 'C:\\Users\\Admin', 'windows'), false)
})

test('the member list line protocol parses Linux and Windows timestamps', () => {
  const stdout = [
    '/root/.dsh/packages/dsh-mesh-0.2.2-20261119F-linux-x64.tar.gz\t318912868\t1795073986\t' + SHA,
    '/root/.dsh/mesh/upgrade/job/dsh-mesh-0.2.2-20261118F-linux-x64.tar.gz\t12\t2026-11-18T07:39:46.0000000Z\t',
  ].join('\n')
  const packages = parseTargetPackageList(stdout)
  assert.equal(packages.length, 2)
  assert.equal(packages[0].name, 'dsh-mesh-0.2.2-20261119F-linux-x64.tar.gz')
  assert.equal(packages[0].sha256, SHA)
  assert.equal(packages[0].buildStamp, '20261119F')
  assert.equal(packages[1].buildStamp, '20261118F')
  assert.equal(packages[1].sha256, null)
  assert.ok(packages[0].mtime > packages[1].mtime)
})

test('the listing scripts scan both the package cache and build staging', () => {
  assert.match(listPackagesScript('linux'), /\.dsh\/packages/u)
  assert.match(listPackagesScript('linux'), /\.dsh\/mesh\/upgrade/u)
  assert.match(listPackagesScript('windows'), /\.dsh\\packages/u)
  assert.match(listPackagesScript('windows'), /dsh-mesh-/u)
  assert.match(listPackagesScript('linux', '/home/deploy'), /BASE='\/home\/deploy'/u)
  assert.match(listPackagesScript('windows', 'C:\\Users\\deploy'), /'C:\\Users\\deploy'/u)
})
