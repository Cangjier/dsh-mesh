import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  describePlan,
  normalizeServices,
} from '../code/deploy/engine.mjs'

test('normalizeServices orders control, dsh and the gateway last', () => {
  const services = normalizeServices([
    { name: 'dsh-web-gate.service', role: 'gate', command: 'start.sh' },
    { name: 'dsh-wg-control.service', role: 'control', command: 'start-control.sh' },
    { name: 'dsh-web-app.service', role: 'dsh', command: 'start-dsh.sh' },
  ], 'linux')
  assert.deepEqual(services.map(service => service.role), ['control', 'dsh', 'gate'])
  assert.equal(services[2].command, 'start.sh')
})

test('default service manifest is the split DSH/gate pair', () => {
  const linux = normalizeServices(undefined, 'linux')
  assert.deepEqual(linux.map(service => service.role), ['dsh', 'gate'])
  assert.equal(linux[0].name, 'dsh-web-app.service')
  assert.equal(linux[1].name, 'dsh-web-gate.service')
  const windows = normalizeServices(undefined, 'windows')
  assert.deepEqual(windows.map(service => service.role), ['dsh', 'gate'])
  assert.equal(windows[1].name, 'DSH-Person-Web')
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

test('plan separates prepare from activation and starts the gateway last', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-deploy-test-'))
  try {
    const packagePath = path.join(dir, 'dsh-person-web-test-linux-x64.tar.gz')
    await writeFile(packagePath, 'fake package')
    const plan = await buildDeployPlan({
      host: '10.66.66.3',
      user: 'root',
      os: 'linux',
      package: packagePath,
      appRoot: '/opt/dsh-person-web',
      repositoryRoot: dir,
      services: [
        { name: 'dsh-web-gate.service', role: 'gate', command: 'start.sh' },
        { name: 'dsh-web-app.service', role: 'dsh', command: 'start-dsh.sh' },
      ],
      release: '20261110-test',
    })
    assert.equal(plan.release, '20261110-test')
    assert.equal(plan.services.at(-1).role, 'gate')
    assert.equal(plan.shared, '/opt/dsh-person-web/shared')
    const summary = describePlan(plan)
    assert.ok(summary.steps.some(step => step.includes('no service switch')))
    assert.ok(summary.steps.some(step => step.includes('newest 3 releases')))
    assert.ok(summary.steps.at(-1).includes('previous'))
    assert.equal(summary.steps.at(-3), 'health check http://127.0.0.1:80/__gate/health')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Linux prepare extracts and prepares but never restarts a service', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-deploy-test-'))
  try {
    const packagePath = path.join(dir, 'pkg.tar.gz')
    await writeFile(packagePath, 'fake')
    const plan = await buildDeployPlan({
      host: 'example', os: 'linux', package: packagePath, repositoryRoot: dir,
      release: 'r1x',
      services: [
        { name: 'dsh-wg-control.service', role: 'control' },
        { name: 'dsh-web-app.service', role: 'dsh' },
        { name: 'dsh-web-gate.service', role: 'gate' },
      ],
    })
    const script = buildLinuxPrepareScript(plan)
    assert.match(script, /tar -xzf/)
    assert.match(script, /ln -s "\$SHARED\/\$dir"/)
    assert.match(script, /systemctl daemon-reload/)
    assert.doesNotMatch(script, /systemctl restart/)
    assert.ok(script.indexOf('dsh-wg-control.service') < script.indexOf('dsh-web-app.service'))
    assert.ok(script.indexOf('dsh-web-app.service') < script.indexOf('dsh-web-gate.service'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deploy keeps a per-user install under that user and chowns it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-deploy-test-'))
  try {
    const packagePath = path.join(dir, 'pkg.tar.gz')
    await writeFile(packagePath, 'fake')
    const plan = await buildDeployPlan({
      host: 'example', os: 'linux', package: packagePath, repositoryRoot: dir,
      release: 'home1', appRoot: '/home/ubuntu/.dsh/dsh-person-web', serviceUser: 'ubuntu',
      services: [
        { name: 'dsh-web-app.service', role: 'dsh' },
        { name: 'dsh-web-gate.service', role: 'gate' },
      ],
    })
    assert.equal(plan.appRoot, '/home/ubuntu/.dsh/dsh-person-web')
    assert.equal(plan.serviceUser, 'ubuntu')
    assert.equal(plan.shared, '/home/ubuntu/.dsh/dsh-person-web/shared')
    const script = buildLinuxPrepareScript(plan)
    assert.match(script, /APP_ROOT='\/home\/ubuntu\/\.dsh\/dsh-person-web'/)
    assert.match(script, /chown -R 'ubuntu:' "\$APP_ROOT"/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Linux activation restarts services in order, health-checks and rolls back', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-deploy-test-'))
  try {
    const packagePath = path.join(dir, 'pkg.tar.gz')
    await writeFile(packagePath, 'fake')
    const plan = await buildDeployPlan({
      host: 'example', os: 'linux', package: packagePath, repositoryRoot: dir,
      release: 'r2x',
      services: [
        { name: 'dsh-web-app.service', role: 'dsh' },
        { name: 'dsh-wg-control.service', role: 'control' },
        { name: 'dsh-web-gate.service', role: 'gate' },
      ],
    })
    const script = buildLinuxActivateScript(plan)
    const control = script.indexOf('systemctl restart \'dsh-wg-control.service\'')
    const dsh = script.indexOf('systemctl restart \'dsh-web-app.service\'')
    const gate = script.indexOf('systemctl restart \'dsh-web-gate.service\'')
    assert.ok(control >= 0 && dsh > control && gate > dsh)
    assert.match(script, /__gate\/health/)
    assert.match(script, /rolling back/)
    assert.match(script, /ln -sfn "\$OLD" "\$CURRENT"/)
    assert.match(script, /mapfile -t RELEASES/)
    assert.match(script, /rm -rf "\$old"/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Windows scripts use a junction and sc.exe config without early restarts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-deploy-test-'))
  try {
    const packagePath = path.join(dir, 'pkg.zip')
    await writeFile(packagePath, 'fake')
    const plan = await buildDeployPlan({
      host: 'win.example', os: 'windows', package: packagePath, repositoryRoot: dir,
      release: 'r3x',
      services: [
        { name: 'DSH-Web-App', role: 'dsh', command: 'dsh-person-web-service.exe' },
        { name: 'DSH-Person-Web', role: 'gate', command: 'dsh-person-web-service.exe' },
      ],
    })
    const prepare = buildWindowsPrepareScript(plan)
    assert.match(prepare, /Expand-Archive/)
    assert.match(prepare, /mklink \/J/)
    assert.match(prepare, /sc\.exe config/)
    assert.doesNotMatch(prepare, /Restart-Service/)
    const activate = buildWindowsActivateScript(plan)
    assert.ok(activate.indexOf('Restart-Service -Name \'DSH-Web-App\'') < activate.indexOf('Restart-Service -Name \'DSH-Person-Web\''))
    assert.match(activate, /__gate\/health/)
    assert.match(activate, /Select-Object -Skip \$keep/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rollback needs no package and switches current back to previous', async () => {
  const plan = await buildDeployPlan({
    host: 'example', os: 'linux', skipPackage: true,
    release: 'rollback',
    appRoot: '/opt/dsh-person-web',
    services: [{ name: 'dsh-web.service', role: 'gate', command: 'start.sh' }],
  })
  assert.equal(plan.package.path, '')
  const script = buildLinuxRollbackScript(plan)
  assert.match(script, /readlink -f "\$PREVIOUS"/)
  assert.match(script, /ln -sfn "\$OLD" "\$CURRENT"/)
  assert.match(script, /systemctl restart 'dsh-web\.service'/)
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

