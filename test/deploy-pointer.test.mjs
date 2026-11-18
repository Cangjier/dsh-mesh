/**
 * The Linux deploy scripts are thin wrappers around the pointer layout: the
 * only thing they must get right is where the package is staged and that every
 * switch goes through `upgrade-local.mjs` / `rollback-local.mjs`.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildLinuxActivateScript, buildLinuxPrepareScript, buildLinuxRehearseScript, buildLinuxRollbackScript, layoutRootFor } from '../code/deploy/engine.mjs'
import { quickSystemInfo } from '../code/shared/system-info.mjs'
import { readDeployment } from '../code/shared/deployment.mjs'

/** A normalized plan, shaped like buildDeployPlan()'s output. */
const plan = {
  release: '20261118D-8f78f35a',
  appRoot: '/root/.dsh/dsh-mesh',
  remotePackage: '/tmp/dsh-mesh-abc.tar.gz',
  gatePort: '80',
  gatePassword: 'secret',
  services: [
    { name: 'dsh-wireguard-control.service', role: 'control', command: 'start.sh' },
    { name: 'dsh-web-app.service', role: 'dsh', command: 'start-dsh.sh' },
    { name: 'dsh-web-gate.service', role: 'gate', command: 'start.sh' },
  ],
  interop: { bind: '10.66.66.2', port: 8765, provider: 'deepseek-account', model: 'deepseek-flash' },
  remoteCredentials: '/tmp/dsh-mesh-abc.account',
  tuneNetwork: false,
}

test('prepare only stages the package and never touches a service', () => {
  const script = buildLinuxPrepareScript(plan)
  assert.match(script, /\.staging\/20261118D-8f78f35a/u)
  assert.match(script, /tar -xzf/u)
  assert.doesNotMatch(script, /systemctl restart/u)
  assert.doesNotMatch(script, /current/u)
  // Progress markers the job parser understands.
  assert.match(script, /DSH-MESH-EXTRACT-TOTAL/u)
})

test('activate hands the staged tree to the single upgrade implementation', () => {
  const script = buildLinuxActivateScript(plan)
  assert.match(script, /code\/deploy\/upgrade-local\.mjs/u)
  assert.match(script, /--stage "\$STAGE"/u)
  assert.match(script, /--layout-root "\$LAYOUT_ROOT"/u)
  assert.match(script, /dsh-web-gate\.service=gate/u)
  assert.match(script, /dsh-web-app\.service=dsh/u)
  assert.match(script, /dsh-wireguard-control\.service=control/u)
  assert.match(script, /--interop-bind '10\.66\.66\.2'/u)
  assert.match(script, /--credentials '\/tmp\/dsh-mesh-abc\.account'/u)
  assert.doesNotMatch(script, /ln -sfn/u)
})

test('rollback delegates to the stable rollback orchestrator', () => {
  const script = buildLinuxRollbackScript(plan)
  assert.match(script, /rollback-local\.mjs" --root "\$LAYOUT_ROOT"/u)
  assert.doesNotMatch(script, /current/u)
})

test('test upgrades are retired, not silently faked', () => {
  const script = buildLinuxRehearseScript(plan)
  assert.match(script, /exit 3/u)
  assert.match(script, /retired/u)
})

test('readDeployment resolves the pointer layout from the root and from a release', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'dsh-deploy-'))
  try {
    const release = path.join(base, 'releases', '20261118D-aaaaaaaa')
    mkdirSync(release, { recursive: true })
    writeFileSync(path.join(release, 'manifest.json'), JSON.stringify({ version: '1.2.3', buildStamp: '20261118D' }))
    writeFileSync(path.join(base, 'dsh-mesh.json'), JSON.stringify({ format: 1, active: 'releases/20261118D-aaaaaaaa' }))
    const fromRoot = readDeployment(base)
    assert.equal(fromRoot.layout, 'pointer')
    assert.equal(fromRoot.version, '1.2.3')
    assert.equal(fromRoot.release, '20261118D-aaaaaaaa')
    // The gate runs with DSH_PACKAGE_ROOT=<release>; the grandparent's pointer
    // must still resolve, otherwise the panel reports the wrong version.
    const fromRelease = readDeployment(release)
    assert.equal(fromRelease.layout, 'pointer')
    assert.equal(fromRelease.version, '1.2.3')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('Windows prepare stages the package and never registers a service', async () => {
  const { buildWindowsPrepareScript } = await import('../code/deploy/engine.mjs')
  const script = buildWindowsPrepareScript({ ...plan, layoutRoot: 'C:\\Users\\Admin\\.dsh', appRoot: 'C:\\Users\\Admin\\.dsh\\dsh-mesh', remotePackage: 'C:\\Windows\\Temp\\pkg.zip' })
  assert.match(script, /\.staging\\20261118D-8f78f35a/u)
  assert.match(script, /dsh-mesh\.mjs/u)
  assert.doesNotMatch(script, /sc\.exe create/u)
  assert.doesNotMatch(script, /current/u)
})

test('Windows activate switches the pointer, then installs the service against the root', async () => {
  const { buildWindowsActivateScript } = await import('../code/deploy/engine.mjs')
  const script = buildWindowsActivateScript({ ...plan, layoutRoot: 'C:\\Users\\Admin\\.dsh', appRoot: 'C:\\Users\\Admin\\.dsh\\dsh-mesh', services: [{ name: 'DSH-Mesh', role: 'gate', command: 'dsh-mesh-service.exe' }] })
  assert.match(script, /upgrade-local\.mjs/u)
  assert.match(script, /--services 'DSH-Mesh=gate'/u)
  assert.match(script, /--no-restart/u)
  assert.match(script, /install-service\.ps1[\s\S]*-Root \$LayoutRoot/u)
  assert.match(script, /__gate\/health/u)
  assert.doesNotMatch(script, /mklink/u)
})

test('Windows rollback delegates to the stable rollback orchestrator', async () => {
  const { buildWindowsRollbackScript } = await import('../code/deploy/engine.mjs')
  const script = buildWindowsRollbackScript({ ...plan, layoutRoot: 'C:\\Users\\Admin\\.dsh' })
  assert.match(script, /rollback-local\.mjs/u)
  assert.doesNotMatch(script, /current/u)
})

test('the layout root is derived from whatever the member reports', () => {
  // A member may report its release directory or a legacy `current` link; both
  // must plan against the stable `.dsh` root, never nest one release in another.
  assert.equal(layoutRootFor('/root/.dsh', 'linux'), '/root/.dsh')
  assert.equal(layoutRootFor('/root/.dsh/releases/20261118074449-bd82d5cb', 'linux'), '/root/.dsh')
  assert.equal(layoutRootFor('/root/.dsh/dsh-mesh', 'linux'), '/root/.dsh')
  assert.equal(layoutRootFor('C:\\Users\\Admin\\.dsh\\releases\\20261118071638-d90f0bcc', 'windows'), 'C:\\Users\\Admin\\.dsh')
  assert.equal(layoutRootFor('C:\\Users\\Admin\\.dsh\\releases\\20261118071638-d90f0bcc\\current', 'windows'), 'C:\\Users\\Admin\\.dsh')
  assert.equal(layoutRootFor('C:\\Users\\Admin\\.dsh\\dsh-mesh', 'windows'), 'C:\\Users\\Admin\\.dsh')
  assert.equal(layoutRootFor('C:\\Users\\Admin\\.dsh', 'windows'), 'C:\\Users\\Admin\\.dsh')
})

test('the member reports the install root, not the release it runs from', () => {
  const previous = { install: process.env.DSH_INSTALL_ROOT, package: process.env.DSH_PACKAGE_ROOT }
  process.env.DSH_INSTALL_ROOT = 'C:\\Users\\Admin\\.dsh'
  process.env.DSH_PACKAGE_ROOT = 'C:\\Users\\Admin\\.dsh\\releases\\20261118071638-d90f0bcc'
  try {
    assert.equal(quickSystemInfo().appRoot, 'C:\\Users\\Admin\\.dsh')
    delete process.env.DSH_INSTALL_ROOT
    // Without the launcher (an old blue-green install) the release is the best
    // answer available, and layoutRootFor() still finds the stable root.
    assert.equal(quickSystemInfo().appRoot, 'C:\\Users\\Admin\\.dsh\\releases\\20261118071638-d90f0bcc')
  } finally {
    if (previous.install === undefined) delete process.env.DSH_INSTALL_ROOT
    else process.env.DSH_INSTALL_ROOT = previous.install
    if (previous.package === undefined) delete process.env.DSH_PACKAGE_ROOT
    else process.env.DSH_PACKAGE_ROOT = previous.package
  }
})
