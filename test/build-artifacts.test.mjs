import assert from 'node:assert/strict'
import test from 'node:test'
import { memberBuildTarget, pickArtifactForMember } from '../src/lib/build-artifacts.mjs'

const artifacts = [
  { target: 'linux-x64', archive: '/root/.dsh/mesh/build/job/dist/dsh-mesh-linux-x64.tar.gz' },
  { target: 'win-x64', archive: 'C:\\Users\\Admin\\.dsh\\mesh\\build\\job\\dist\\dsh-mesh-win-x64.zip' },
]

test('a member build target is derived from platform and arch', () => {
  assert.equal(memberBuildTarget({ system: { platform: 'linux', arch: 'x64' } }), 'linux-x64')
  assert.equal(memberBuildTarget({ system: { platform: 'linux', arch: 'arm64' } }), 'linux-arm64')
  assert.equal(memberBuildTarget({ system: { platform: 'win32', arch: 'x64' } }), 'win-x64')
  assert.equal(memberBuildTarget({ system: { platform: 'win32', arch: 'arm64' } }), 'win-arm64')
  assert.equal(memberBuildTarget({ system: { platform: 'darwin', arch: 'arm64' } }), null)
  assert.equal(memberBuildTarget({ system: { platform: 'linux', arch: '' } }), null)
  assert.equal(memberBuildTarget(null), null)
})

test('the auto-upgrade uses the archive built for the build host', () => {
  assert.equal(pickArtifactForMember(artifacts, { system: { platform: 'linux', arch: 'x64' } }), artifacts[0])
  assert.equal(pickArtifactForMember(artifacts, { system: { platform: 'win32', arch: 'x64' } }), artifacts[1])
  // A cross-target build has no package the host itself can run.
  assert.equal(pickArtifactForMember([artifacts[1]], { system: { platform: 'linux', arch: 'x64' } }), null)
  assert.equal(pickArtifactForMember(null, { system: { platform: 'linux', arch: 'x64' } }), null)
})
