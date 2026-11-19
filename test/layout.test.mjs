/**
 * Pointer layout + stable launcher tests.
 *
 * These run entirely in a temporary directory: no systemd unit is written and
 * no service is touched (`--no-units`), so a broken test cannot disturb the
 * machine it runs on.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LAYOUT = path.join(REPO, 'code', 'install', 'layout.mjs')
const LAUNCHER = path.join(REPO, 'dsh-mesh.mjs')

/** Run a node script, returning {code, stdout, stderr}. */
function runNode(script, args, options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_MESH_NODE: process.execPath, ...options.env },
    ...options,
  })
}

/** Run layout.mjs and fail on a non-zero exit. */
function layout(args, env = {}) {
  const result = runNode(LAYOUT, args, { env })
  assert.equal(result.status, 0, `layout ${args.join(' ')} failed:\n${result.stderr}\n${result.stdout}`)
  return JSON.parse(result.stdout)
}

/** Write a fake but complete release tree. */
function makeRelease(root, id, options = {}) {
  const dir = path.join(root, 'releases', id)
  mkdirSync(path.join(dir, 'gate'), { recursive: true })
  mkdirSync(path.join(dir, 'plugins', 'dsh-mesh'), { recursive: true })
  mkdirSync(path.join(dir, 'plugins', 'xl'), { recursive: true })
  mkdirSync(path.join(dir, 'runtime', 'node', 'bin'), { recursive: true })
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({
    version: options.version ?? '0.2.2-rc.4',
    buildStamp: options.buildStamp ?? id,
  }, null, 2)}\n`)
  // A gate that reports the environment the launcher handed it, then exits.
  writeFileSync(path.join(dir, 'gate', 'server.mjs'), `
import process from 'node:process'
process.stdout.write(JSON.stringify({
  release: process.env.DSH_PACKAGE_ROOT,
  installRoot: process.env.DSH_INSTALL_ROOT,
  home: process.env.DSH_HOME,
  workdir: process.env.DSH_WORKDIR,
  data: process.env.DSH_GATE_DATA_DIR,
  config: process.env.DSH_GATE_CONFIG_DIR,
  interopConfig: process.env.DSH_INTEROP_CONFIG,
  cwd: process.cwd(),
}) + '\\n')
`)
  writeFileSync(path.join(dir, 'plugins', 'dsh-mesh', 'package.json'), `${JSON.stringify({
    name: '@local/dsh-mesh',
    version: '0.2.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2)}\n`)
  writeFileSync(path.join(dir, 'plugins', 'dsh-mesh', 'index.js'), '// plugin\n')
  writeFileSync(path.join(dir, 'plugins', 'xl', 'package.json'), `${JSON.stringify({
    name: 'xl',
    version: '0.0.1',
    dsh: { bundle: {} },
  }, null, 2)}\n`)
  writeFileSync(path.join(dir, 'plugins', 'xl', 'index.js'), '// plugin\n')
  // The launcher copy carried by the package. Tests may alter it to prove the
  // .bak rule; the real file is the source of truth.
  const source = readFileSync(LAUNCHER, 'utf8')
  writeFileSync(path.join(dir, 'dsh-mesh.mjs'), `${source}${options.launcherExtra ?? ''}`, { mode: 0o755 })
  // A placeholder is enough: stableNode only checks that the file exists.
  writeFileSync(path.join(dir, 'runtime', 'node', 'bin', 'node'), '')
  return dir
}

test('prepare creates shared state, launcher and stable runtime without links', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-layout-'))
  try {
    makeRelease(root, '20261118D-aaaaaaaa')
    const summary = layout(['prepare', '--root', root, '--release', '20261118D-aaaaaaaa', '--no-units'])
    assert.equal(summary.ok, true)
    assert.equal(summary.launcher, 'written')
    assert.equal(summary.runtime, 'installed')

    // A release is immutable and owns no data: everything mutable lives in
    // shared/ and is named through the environment, never through a link.
    for (const dir of ['config', 'data', 'workspace']) {
      const releasePath = path.join(root, 'releases', '20261118D-aaaaaaaa', dir)
      assert.equal(existsSync(releasePath), false, `${dir} must not be linked into the release`)
      assert.ok(existsSync(path.join(root, 'shared', dir)), `${dir} lives in shared/`)
    }
    const env = readFileSync(path.join(root, 'shared', 'config', 'gate.env'), 'utf8')
    assert.match(env, /^DSH_WORKDIR=.*shared[/\\]workspace$/mu)
    assert.match(env, /^DSH_GATE_DATA_DIR=.*shared[/\\]data$/mu)
    assert.match(env, /^DSH_GATE_CONFIG_DIR=.*shared[/\\]config$/mu)
    assert.ok(existsSync(path.join(root, 'shared', 'home')))
    assert.ok(existsSync(path.join(root, 'dsh-mesh.mjs')))
    // The profile gets copies of both packaged plugins and their bundles.
    const profile = JSON.parse(readFileSync(path.join(root, 'shared', 'home', 'profiles', 'web', 'package.json'), 'utf8'))
    assert.ok(profile.dsh.profile.bundles.includes('@local/dsh-mesh'))
    assert.ok(profile.dsh.profile.bundles.includes('xl'))
    assert.equal(profile.dependencies['@local/dsh-mesh'], 'link:./node_modules/@local/dsh-mesh')
    assert.ok(existsSync(path.join(root, 'shared', 'home', 'profiles', 'web', 'node_modules', '@local', 'dsh-mesh', 'index.js')))
    assert.ok(existsSync(path.join(root, 'shared', 'home', 'profiles', 'web', 'node_modules', 'xl', 'index.js')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('activate writes the pointer and the launcher starts the active release', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-layout-'))
  try {
    makeRelease(root, '20261118D-aaaaaaaa')
    layout(['prepare', '--root', root, '--release', '20261118D-aaaaaaaa', '--no-units'])
    const state = layout(['activate', '--root', root, '--release', '20261118D-aaaaaaaa'])
    assert.equal(state.active, 'releases/20261118D-aaaaaaaa')
    assert.equal(state.previous, null)
    const pointer = JSON.parse(readFileSync(path.join(root, 'dsh-mesh.json'), 'utf8'))
    assert.equal(pointer.active, 'releases/20261118D-aaaaaaaa')

    const status = runNode(LAUNCHER, ['--root', root, '--status'])
    assert.equal(status.status, 0, status.stderr)
    const parsed = JSON.parse(status.stdout)
    assert.equal(parsed.active, 'releases/20261118D-aaaaaaaa')
    assert.equal(parsed.version, '0.2.2-rc.4')

    const gate = runNode(LAUNCHER, ['--root', root, '--role', 'gate'])
    assert.equal(gate.status, 0, gate.stderr)
    const report = JSON.parse(gate.stdout)
    assert.equal(report.release, path.join(root, 'releases', '20261118D-aaaaaaaa'))
    assert.equal(report.installRoot, root)
    assert.equal(report.home, path.join(root, 'shared', 'home'))
    assert.equal(report.workdir, path.join(root, 'shared', 'workspace'))
    assert.equal(report.data, path.join(root, 'shared', 'data'))
    assert.equal(report.config, path.join(root, 'shared', 'config'))
    assert.equal(report.interopConfig, path.join(root, 'shared', 'config', 'interop.env'))
    assert.equal(report.cwd, path.join(root, 'releases', '20261118D-aaaaaaaa'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('upgrade replaces the launcher but keeps the previous one as .bak', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-layout-'))
  try {
    makeRelease(root, '20261118D-aaaaaaaa')
    layout(['prepare', '--root', root, '--release', '20261118D-aaaaaaaa', '--no-units'])
    layout(['activate', '--root', root, '--release', '20261118D-aaaaaaaa'])
    const first = readFileSync(path.join(root, 'dsh-mesh.mjs'), 'utf8')

    makeRelease(root, '20261120A-bbbbbbbb', { launcherExtra: '\n// second build\n' })
    const summary = layout(['prepare', '--root', root, '--release', '20261120A-bbbbbbbb', '--no-units'])
    assert.match(summary.launcher, /\.bak/)
    assert.equal(readFileSync(path.join(root, 'dsh-mesh.mjs.bak'), 'utf8'), first)
    assert.match(readFileSync(path.join(root, 'dsh-mesh.mjs'), 'utf8'), /second build/)

    // A release that ships the identical launcher must not churn the .bak.
    makeRelease(root, '20261120C-cccccccc', { launcherExtra: '\n// second build\n' })
    const unchanged = layout(['prepare', '--root', root, '--release', '20261120C-cccccccc', '--no-units'])
    assert.equal(unchanged.launcher, 'unchanged')

    layout(['activate', '--root', root, '--release', '20261120A-bbbbbbbb'])
    const pointer = JSON.parse(readFileSync(path.join(root, 'dsh-mesh.json'), 'utf8'))
    assert.equal(pointer.active, 'releases/20261120A-bbbbbbbb')
    assert.equal(pointer.previous, 'releases/20261118D-aaaaaaaa')
    // The acceptance marker names both releases and the shared home.
    const marker = JSON.parse(readFileSync(path.join(root, 'shared', 'data', 'upgrade-pending.json'), 'utf8'))
    assert.equal(marker.layout, 'pointer')
    assert.equal(marker.previous, path.join(root, 'releases', '20261118D-aaaaaaaa'))
    assert.equal(marker.to, '0.2.2-rc.4')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rollback flips the pointer back and clears the acceptance marker', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-layout-'))
  try {
    makeRelease(root, '20261118D-aaaaaaaa', { version: '0.2.2-rc.3' })
    layout(['prepare', '--root', root, '--release', '20261118D-aaaaaaaa', '--no-units'])
    layout(['activate', '--root', root, '--release', '20261118D-aaaaaaaa'])
    makeRelease(root, '20261120A-bbbbbbbb', { version: '0.2.2-rc.4' })
    layout(['prepare', '--root', root, '--release', '20261120A-bbbbbbbb', '--no-units'])
    layout(['activate', '--root', root, '--release', '20261120A-bbbbbbbb'])

    const state = layout(['rollback', '--root', root])
    assert.equal(state.active, 'releases/20261118D-aaaaaaaa')
    assert.equal(state.previous, 'releases/20261120A-bbbbbbbb')
    assert.equal(existsSync(path.join(root, 'shared', 'data', 'upgrade-pending.json')), false)
    const status = JSON.parse(runNode(LAUNCHER, ['--root', root, '--status']).stdout)
    assert.equal(status.version, '0.2.2-rc.3')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a missing pointer fails with a clear message instead of guessing', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-layout-'))
  try {
    const result = runNode(LAUNCHER, ['--root', root, '--role', 'gate'])
    assert.equal(result.status, 2)
    assert.match(result.stderr, /dsh-mesh\.json/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--release overrides the pointer for a manual start', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-layout-'))
  try {
    makeRelease(root, '20261118D-aaaaaaaa')
    layout(['prepare', '--root', root, '--release', '20261118D-aaaaaaaa', '--no-units'])
    layout(['activate', '--root', root, '--release', '20261118D-aaaaaaaa'])
    makeRelease(root, '20261120A-bbbbbbbb')
    layout(['prepare', '--root', root, '--release', '20261120A-bbbbbbbb', '--no-units'])
    const gate = runNode(LAUNCHER, ['--root', root, '--role', 'gate', '--release', 'releases/20261120A-bbbbbbbb'])
    assert.equal(gate.status, 0, gate.stderr)
    assert.equal(JSON.parse(gate.stdout).release, path.join(root, 'releases', '20261120A-bbbbbbbb'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the launcher propagates the child exit code', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-layout-'))
  try {
    const dir = makeRelease(root, '20261118D-aaaaaaaa')
    writeFileSync(path.join(dir, 'gate', 'server.mjs'), 'process.exit(7)\n')
    layout(['prepare', '--root', root, '--release', '20261118D-aaaaaaaa', '--no-units'])
    layout(['activate', '--root', root, '--release', '20261118D-aaaaaaaa'])
    const gate = runNode(LAUNCHER, ['--root', root, '--role', 'gate'])
    assert.equal(gate.status, 7)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an incomplete release is refused before anything is switched', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-layout-'))
  try {
    mkdirSync(path.join(root, 'releases', '20261118D-aaaaaaaa'), { recursive: true })
    const result = runNode(LAYOUT, ['prepare', '--root', root, '--release', '20261118D-aaaaaaaa', '--no-units'])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /incomplete/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the Windows start shim frees stale stack ports before it hands over', () => {
  // The shim is written only on win32, which this Linux CI cannot enter. The
  // port sweep used to live in the package start.ps1; the pointer layout
  // replaced that script with the shim, and without the sweep an upgrade
  // starts a gate that cannot bind while the old release still answers health.
  const source = readFileSync(LAYOUT, 'utf8')
  assert.match(source, /\$OwnedPorts = @\(80, 8765, 31280\)/u)
  assert.match(source, /taskkill \/PID \$Owner \/T \/F/u)
})
