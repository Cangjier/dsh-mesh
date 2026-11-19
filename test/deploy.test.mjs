import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildDeployPlan,
  buildLinuxActivateScript,
  buildLinuxPrepareScript,
  buildLinuxRollbackScript,
  buildWindowsActivateScript,
  buildWindowsPrepareScript,
  DeployManager,
  deployerModelRoute,
  describePlan,
  PROFILE_WIRE_SCRIPT,
  normalizeServices,
} from '../code/deploy/engine.mjs'

test('normalizeServices orders control, dsh and the gateway last', () => {
  const services = normalizeServices([
    { name: 'dsh-web-gate.service', role: 'gate' },
    { name: 'dsh-wg-control.service', role: 'control' },
    { name: 'dsh-web-app.service', role: 'dsh' },
  ], 'linux')
  assert.deepEqual(services.map(service => service.role), ['control', 'dsh', 'gate'])
  // The unit always runs the stable launcher; no per-role start script is part
  // of the plan any more.
  assert.equal('command' in services[2], false)
})

test('default service manifest matches the package layout', () => {
  // Every member carries the control panel; the package gate runs last because
  // it spawns the private DSH.
  const linux = normalizeServices(undefined, 'linux')
  assert.deepEqual(linux.map(service => service.role), ['control', 'gate'])
  assert.equal(linux[0].name, 'dsh-wireguard-control.service')
  assert.equal(linux[1].name, 'dsh-web-gate.service')
  // Windows runs one supervisor service that owns gate + interop, plus the
  // separate control-panel service so restarting the gateway leaves 51821 up.
  const windows = normalizeServices(undefined, 'windows')
  assert.deepEqual(windows.map(service => service.role), ['control', 'gate'])
  assert.equal(windows[0].name, 'DSH-WireGuard-Control')
  assert.equal(windows[1].name, 'DSH-Mesh')
})

test('normalizeServices refuses a manifest without a gateway', () => {
  assert.throws(() => normalizeServices([{ name: 'dsh-web-app.service', role: 'dsh' }], 'linux'), /gateway/)
})

test('normalizeServices refuses two gateways', () => {
  assert.throws(() => normalizeServices([
    { name: 'gate-a.service', role: 'gate' },
    { name: 'gate-b.service', role: 'gate' },
  ], 'linux'), /exactly one gateway/)
})

test('a default plan carries and health-checks the control panel', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-deploy-control-'))
  try {
    const packagePath = path.join(dir, 'dsh-mesh-test-windows-x64.zip')
    await writeFile(packagePath, 'fake package')
    const plan = await buildDeployPlan({
      host: '10.66.66.4',
      os: 'windows',
      package: packagePath,
      appRoot: 'C:\\Users\\Admin\\.dsh\\dsh-mesh',
      repositoryRoot: dir,
      release: 'control-panel',
    })
    // No explicit manifest: the default is what a plain member deploy uses.
    assert.deepEqual(plan.services.map(service => service.role), ['control', 'gate'])
    assert.equal(plan.services[0].name, 'DSH-WireGuard-Control')
    const script = buildWindowsActivateScript(plan)
    assert.match(script, /install-control-service\.ps1/u)
    assert.match(script, /51821\/api\/dsh-wireguard\/health/u)
    const summary = describePlan(plan)
    assert.ok(summary.steps.some(step => step.includes('51821')))
    assert.ok(summary.steps.some(step => step.includes('restart DSH-WireGuard-Control (control)')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('plan separates prepare from activation and starts the gateway last', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-deploy-test-'))
  try {
    const packagePath = path.join(dir, 'dsh-mesh-test-linux-x64.tar.gz')
    await writeFile(packagePath, 'fake package')
    const plan = await buildDeployPlan({
      host: '10.66.66.3',
      user: 'root',
      os: 'linux',
      package: packagePath,
      appRoot: '/opt/dsh-mesh',
      repositoryRoot: dir,
      services: [
        { name: 'dsh-web-gate.service', role: 'gate' },
        { name: 'dsh-web-app.service', role: 'dsh' },
      ],
      release: '20261110-test',
    })
    assert.equal(plan.release, '20261110-test')
    assert.equal(plan.services.at(-1).role, 'gate')
    const summary = describePlan(plan)
    assert.ok(summary.steps.some(step => step.includes('no service switch')))
    assert.ok(summary.steps.some(step => step.includes('newest 2 releases')))
    assert.ok(summary.steps.at(-1).includes('previous'))
    assert.equal(summary.steps.at(-3), 'health check http://127.0.0.1:80/__gate/health')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the profile wire points the member at the deployer provider route', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-deploy-wire-'))
  try {
    const profile = path.join(dir, 'profiles', 'web')
    const plugin = path.join(dir, 'plugin')
    await mkdir(profile, { recursive: true })
    await mkdir(plugin, { recursive: true })
    await writeFile(path.join(plugin, 'package.json'), '{"name":"@local/dsh-mesh"}')
    await writeFile(path.join(profile, 'cordis.patch.yml'), '- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n')
    const script = path.join(dir, 'wire.mjs')
    await writeFile(script, PROFILE_WIRE_SCRIPT)
    const run = promisify(execFile)
    await run(process.execPath, [script, profile, plugin, 'deepseek-account', 'deepseek-flash', 'high'])
    const first = await readFile(path.join(profile, 'cordis.patch.yml'), 'utf8')
    assert.match(first, /- id: agent-default-model/u)
    assert.match(first, /provider: deepseek-account/u)
    assert.match(first, /model: deepseek-flash/u)
    assert.match(first, /reasoningEffort: high/u)
    // A second deploy must not stack duplicate entries.
    await run(process.execPath, [script, profile, plugin, 'deepseek-account', 'deepseek-flash', 'high'])
    assert.equal(await readFile(path.join(profile, 'cordis.patch.yml'), 'utf8'), first)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('network tuning can be switched off for a member that tunes itself', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-deploy-test-'))
  try {
    const packagePath = path.join(dir, 'pkg.tar.gz')
    await writeFile(packagePath, 'fake')
    const plan = await buildDeployPlan({
      host: 'example', os: 'linux', package: packagePath, repositoryRoot: dir,
      release: 'notune', tuneNetwork: false,
      services: [{ name: 'dsh-web-gate.service', role: 'gate' }],
    })
    assert.equal(plan.tuneNetwork, false)
    assert.doesNotMatch(buildLinuxPrepareScript(plan), /99-dsh-mesh-net/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a host name is not exposed: interop binds the wildcard address', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-deploy-test-'))
  try {
    const packagePath = path.join(dir, 'pkg.tar.gz')
    await writeFile(packagePath, 'fake')
    const plan = await buildDeployPlan({
      host: 'member.example', os: 'linux', package: packagePath, repositoryRoot: dir,
      release: 'interop2',
      services: [{ name: 'dsh-web-gate.service', role: 'gate' }],
    })
    assert.equal(plan.interop.bind, '0.0.0.0')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the interop step can be skipped for a member that runs it itself', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-deploy-test-'))
  try {
    const packagePath = path.join(dir, 'pkg.tar.gz')
    await writeFile(packagePath, 'fake')
    const plan = await buildDeployPlan({
      host: '10.66.66.9', os: 'linux', package: packagePath, repositoryRoot: dir,
      release: 'interop3', interop: false,
      services: [{ name: 'dsh-web-gate.service', role: 'gate' }],
    })
    assert.equal(plan.interop, null)
    assert.doesNotMatch(buildLinuxPrepareScript(plan), /dsh-interop/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scope=dsh leaves the gateway out of the restart list', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-deploy-test-'))
  try {
    const packagePath = path.join(dir, 'pkg.tar.gz')
    await writeFile(packagePath, 'fake')
    const plan = await buildDeployPlan({
      host: 'example', os: 'linux', package: packagePath, repositoryRoot: dir,
      release: 'r4x', scope: 'dsh',
      services: [
        { name: 'dsh-web-app.service', role: 'dsh' },
        { name: 'dsh-web-gate.service', role: 'gate' },
      ],
    })
    const script = buildLinuxActivateScript(plan)
    assert.match(script, /dsh-web-app\.service/)
    assert.doesNotMatch(script, /systemctl restart 'dsh-web-gate\.service'/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


test('DeployManager.wait settles a deployment and leaves a log', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-deploy-wait-'))
  const pkg = path.join(dir, 'package.tar.gz')
  await writeFile(pkg, 'not-a-real-archive')
  const manager = new DeployManager({
    repositoryRoot: process.cwd(),
    dataDir: path.join(dir, 'deploy'),
    runnerFactory: () => ({
      upload: async () => {},
      script: async () => {},
    }),
  })
  try {
    const started = await manager.start({
      host: '127.0.0.1',
      package: pkg,
      appRoot: path.join(dir, 'app'),
      os: 'linux',
      services: [{ name: 'dsh-web-gate.service', role: 'gate' }],
      gatePort: '80',
    })
    const job = await manager.wait(started.job.id)
    assert.equal(job.status, 'succeeded')
    assert.match(await manager.logs(started.job.id, 20), /deployment succeeded/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a deploy plan carries the release download spec unchanged', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-plan-download-'))
  const pkg = path.join(dir, 'dsh-mesh-1.0-linux-x64.tar.gz')
  try {
    await writeFile(pkg, 'archive-bytes', 'utf8')
    const download = {
      manifestUrls: ['https://github.com/o/r/releases/download/latest/latest.json'],
      proxy: { host: '10.66.66.2', user: 'root', port: 22, name: 'C', appRoot: '/opt/c' },
    }
    const plan = await buildDeployPlan({ host: '10.66.66.3', package: pkg, os: 'linux', download })
    assert.deepEqual(plan.download, download)
    const noDownload = await buildDeployPlan({ host: '10.66.66.3', package: pkg, os: 'linux' })
    assert.equal(noDownload.download, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the first deploy step is "获取安装包", covering download and upload', async () => {
  const { initialDeploySteps } = await import('../code/deploy/engine.mjs')
  assert.deepEqual(initialDeploySteps().map(step => step.key), ['upload', 'prepare', 'activate'])
  assert.equal(initialDeploySteps()[0].label, '获取安装包')
})

test('release download scripts pass the manifest, digest, output and proxy', async () => {
  const { linuxNodeProbeScript, releaseDownloadScript, windowsNodeProbeScript } = await import('../code/deploy/engine.mjs')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-download-script-'))
  const pkg = path.join(dir, 'dsh-mesh-1.0-linux-x64.tar.gz')
  try {
    await writeFile(pkg, 'archive-bytes', 'utf8')
    const plan = await buildDeployPlan({ host: '10.66.66.3', package: pkg, os: 'linux', appRoot: '/opt/member' })
    const linux = releaseDownloadScript(plan, {
      node: '/opt/member/runtime/node/bin/node',
      remoteDir: '/tmp/dsh-mesh-release-deadbeef',
      manifests: [
        { provider: 'github', url: 'https://github.com/o/r/releases/download/latest/latest.json' },
        { provider: 'gitee', url: 'https://gitee.com/o/r/releases/download/latest/latest.json' },
      ],
      proxyUrl: 'http://10.66.66.2:41234',
    })
    assert.match(linux, /release-download\.mjs/u)
    assert.match(linux, /--manifest-github 'https:\/\/github\.com/u)
    assert.match(linux, /--manifest-gitee 'https:\/\/gitee\.com/u)
    assert.match(linux, /--archive 'dsh-mesh-1\.0-linux-x64\.tar\.gz'/u)
    assert.match(linux, /--output '\/tmp\/dsh-mesh-/u)
    assert.match(linux, /--proxy 'http:\/\/10\.66\.66\.2:41234'/u)
    assert.match(linux, /exit \$\?/u)

    const windowsPlan = await buildDeployPlan({ host: '10.66.66.4', package: pkg, os: 'windows', appRoot: 'C:\\dsh-mesh' })
    const windows = releaseDownloadScript(windowsPlan, {
      node: 'C:\\dsh-mesh\\runtime\\node\\node.exe',
      remoteDir: 'C:\\Windows\\Temp\\dsh-mesh-release-deadbeef',
      manifests: [{ provider: 'github', url: 'https://github.com/o/r/releases/download/latest/latest.json' }],
      proxyUrl: null,
    })
    assert.match(windows, /release-download\.mjs/u)
    assert.match(windows, /\$LASTEXITCODE/u)
    assert.doesNotMatch(windows, /--proxy/u)

    assert.match(linuxNodeProbeScript('/opt/member'), /\/opt\/member\/runtime\/node\/bin\/node/u)
    assert.ok(windowsNodeProbeScript('C:\\dsh-mesh').includes("'C:\\dsh-mesh\\runtime\\node\\node.exe'"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
