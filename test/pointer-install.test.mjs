/**
 * End-to-end tests for the pointer-layout upgrade and rollback orchestrators.
 *
 * Everything runs in a temporary layout root with `--no-restart` and
 * `DSH_MESH_NO_UNITS=1`: no systemd unit is written and no service is touched.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UPGRADE = path.join(REPO, 'code', 'deploy', 'upgrade-local.mjs')
const ROLLBACK = path.join(REPO, 'code', 'deploy', 'rollback-local.mjs')

/** Build an extracted package tree. */
function makeStage(base, name, options = {}) {
  const stage = path.join(base, name)
  mkdirSync(path.join(stage, 'gate'), { recursive: true })
  mkdirSync(path.join(stage, 'plugins', 'dsh-mesh'), { recursive: true })
  mkdirSync(path.join(stage, 'code', 'install'), { recursive: true })
  mkdirSync(path.join(stage, 'code', 'deploy'), { recursive: true })
  mkdirSync(path.join(stage, 'runtime', 'node', 'bin'), { recursive: true })
  writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify({
    version: options.version ?? '0.2.2-rc.4',
    buildStamp: options.buildStamp ?? '20261118D',
  }, null, 2)}\n`)
  writeFileSync(path.join(stage, 'gate', 'server.mjs'), 'console.log("stub")\n')
  writeFileSync(path.join(stage, 'plugins', 'dsh-mesh', 'package.json'), `${JSON.stringify({ name: '@local/dsh-mesh', version: '0.2.0', dsh: { bundle: {} } })}\n`)
  writeFileSync(path.join(stage, 'dsh-mesh.mjs'), `${readFileSync(path.join(REPO, 'dsh-mesh.mjs'), 'utf8')}${options.launcherExtra ?? ''}`)
  for (const file of ['layout.mjs']) {
    writeFileSync(path.join(stage, 'code', 'install', file), readFileSync(path.join(REPO, 'code', 'install', file)))
  }
  for (const file of ['upgrade-local.mjs', 'rollback-local.mjs']) {
    writeFileSync(path.join(stage, 'code', 'deploy', file), readFileSync(path.join(REPO, 'code', 'deploy', file)))
  }
  // The release's node: a symlink keeps the test fast and proves the launcher
  // prefers the release runtime when present.
  spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'ln', process.platform === 'win32'
    ? ['/c', 'mklink', path.join(stage, 'runtime', 'node', 'bin', 'node'), process.execPath]
    : ['-s', process.execPath, path.join(stage, 'runtime', 'node', 'bin', 'node')])
  return stage
}

/** Run the upgrade orchestrator. */
function upgrade(stage, root, extra = []) {
  return spawnSync(process.execPath, [UPGRADE, '--stage', stage, '--layout-root', root, '--no-restart', ...extra], {
    encoding: 'utf8',
    env: { ...process.env, DSH_MESH_NO_UNITS: '1', DSH_MESH_NODE: process.execPath },
  })
}

test('first upgrade converts a legacy install into the pointer layout', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'dsh-upgrade-'))
  const root = path.join(base, 'root')
  const old = path.join(base, 'old')
  const oldHome = path.join(base, 'old-home')
  try {
    mkdirSync(path.join(old, 'config'), { recursive: true })
    mkdirSync(path.join(old, 'data'), { recursive: true })
    mkdirSync(path.join(old, 'workspace'), { recursive: true })
    mkdirSync(path.join(oldHome, 'sessions'), { recursive: true })
    writeFileSync(path.join(old, 'config', 'gate.env'), `DSH_GATE_PORT=8080\nDSH_HOME=${oldHome}\n`)
    writeFileSync(path.join(old, 'data', 'secret'), 's\n')
    writeFileSync(path.join(oldHome, 'sessions', 'a.json'), '{}\n')

    const stage = makeStage(base, 'stage-a')
    const result = upgrade(stage, root, ['--app-root', old, '--dsh-home', oldHome])
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)

    const pointer = JSON.parse(readFileSync(path.join(root, 'dsh-mesh.json'), 'utf8'))
    assert.match(pointer.active, /^releases\/20261118D-[0-9a-f]{8}$/u)
    assert.ok(existsSync(path.join(root, 'dsh-mesh.mjs')))
    assert.ok(existsSync(path.join(root, 'rollback-local.mjs')))
    assert.equal(readFileSync(path.join(root, 'shared', 'data', 'secret'), 'utf8'), 's\n')
    assert.equal(readFileSync(path.join(root, 'shared', 'home', 'sessions', 'a.json'), 'utf8'), '{}\n')
    // Copied, not moved: the old tree is still complete.
    assert.equal(readFileSync(path.join(old, 'data', 'secret'), 'utf8'), 's\n')
    // The adopted gate.env keeps the operator's values except the layout paths.
    const env = readFileSync(path.join(root, 'shared', 'config', 'gate.env'), 'utf8')
    assert.match(env, /^DSH_GATE_PORT=8080$/mu)
    assert.match(env, new RegExp(`^DSH_HOME=${root}/shared/home$`, 'mu'))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a second upgrade flips the pointer and keeps the previous release', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'dsh-upgrade-'))
  const root = path.join(base, 'root')
  try {
    const first = makeStage(base, 'stage-a', { buildStamp: '20261118D' })
    assert.equal(upgrade(first, root).status, 0)
    const firstActive = JSON.parse(readFileSync(path.join(root, 'dsh-mesh.json'), 'utf8')).active

    const second = makeStage(base, 'stage-b', { version: '0.2.2-rc.5', buildStamp: '20261120A', launcherExtra: '\n// second\n' })
    const result = upgrade(second, root)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const pointer = JSON.parse(readFileSync(path.join(root, 'dsh-mesh.json'), 'utf8'))
    assert.notEqual(pointer.active, firstActive)
    assert.equal(pointer.previous, firstActive)
    assert.match(readFileSync(path.join(root, 'dsh-mesh.mjs'), 'utf8'), /second/)
    assert.match(readFileSync(path.join(root, 'dsh-mesh.mjs.bak'), 'utf8'), /dsh-mesh stable launcher/)
    // The acceptance marker points at both releases.
    const marker = JSON.parse(readFileSync(path.join(root, 'shared', 'data', 'upgrade-pending.json'), 'utf8'))
    assert.equal(marker.layout, 'pointer')
    assert.equal(marker.previous, path.join(root, firstActive))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a pointer install is never adopted as its own legacy source', () => {
  // The 2026-11-19 member upgrade died here. The runner reports the release the
  // machine currently runs from as --app-root; on the pointer layout that
  // release has `workspace -> ../../shared/workspace`, so adoption picked a
  // symlink that resolved to the empty target itself. cpSync copied nothing
  // (the filter drops symlinks), the target was removed, and the rename of a
  // partial that never existed failed with ENOENT.
  const base = mkdtempSync(path.join(tmpdir(), 'dsh-upgrade-'))
  const root = path.join(base, 'root')
  try {
    const first = makeStage(base, 'stage-a', { buildStamp: '20261118D' })
    assert.equal(upgrade(first, root).status, 0)
    const active = JSON.parse(readFileSync(path.join(root, 'dsh-mesh.json'), 'utf8')).active
    // The layout prepare of the first upgrade linked the release's data dirs
    // into shared/; the workspace is still empty, which is what made adoption
    // enter the copy path at all.
    assert.equal(readlinkSync(path.join(root, active, 'workspace')), path.join('..', '..', 'shared', 'workspace'))
    assert.equal(readdirSync(path.join(root, 'shared', 'workspace')).length, 0)

    const second = makeStage(base, 'stage-b', { buildStamp: '20261120A' })
    const result = upgrade(second, root, ['--app-root', path.join(root, active)])
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.doesNotMatch(result.stderr, /ENOENT/u)
    const pointer = JSON.parse(readFileSync(path.join(root, 'dsh-mesh.json'), 'utf8'))
    assert.notEqual(pointer.active, active)
    assert.equal(pointer.previous, active)
    assert.ok(existsSync(path.join(root, 'shared', 'workspace')))
    assert.equal(readdirSync(path.join(root, 'shared', 'workspace')).length, 0)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a third upgrade keeps exactly the current and previous releases', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'dsh-upgrade-'))
  const root = path.join(base, 'root')
  try {
    const first = makeStage(base, 'stage-a', { buildStamp: '20261118D' })
    assert.equal(upgrade(first, root).status, 0)
    const second = makeStage(base, 'stage-b', { buildStamp: '20261120A' })
    assert.equal(upgrade(second, root).status, 0)
    const secondActive = JSON.parse(readFileSync(path.join(root, 'dsh-mesh.json'), 'utf8')).active
    const third = makeStage(base, 'stage-c', { buildStamp: '20261121A' })
    const result = upgrade(third, root)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)

    const pointer = JSON.parse(readFileSync(path.join(root, 'dsh-mesh.json'), 'utf8'))
    const expected = [pointer.active, pointer.previous].map(relative => path.basename(relative)).sort()
    const releases = readdirSync(path.join(root, 'releases')).sort()
    assert.deepEqual(releases, expected)
    assert.equal(pointer.previous, secondActive)
    assert.equal(releases.length, 2)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('rollback flips the pointer, restores the launcher and clears the marker', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'dsh-upgrade-'))
  const root = path.join(base, 'root')
  try {
    const first = makeStage(base, 'stage-a', { buildStamp: '20261118D' })
    assert.equal(upgrade(first, root).status, 0)
    const firstActive = JSON.parse(readFileSync(path.join(root, 'dsh-mesh.json'), 'utf8')).active
    const firstLauncher = readFileSync(path.join(root, 'dsh-mesh.mjs'), 'utf8')
    const second = makeStage(base, 'stage-b', { buildStamp: '20261120A', launcherExtra: '\n// broken\n' })
    assert.equal(upgrade(second, root).status, 0)

    const result = spawnSync(process.execPath, [ROLLBACK, '--root', root, '--no-restart'], { encoding: 'utf8' })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const pointer = JSON.parse(readFileSync(path.join(root, 'dsh-mesh.json'), 'utf8'))
    assert.equal(pointer.active, firstActive)
    // The previous launcher came back from .bak, so a broken launcher is
    // recoverable even when the manifest still points at the failed release.
    assert.equal(readFileSync(path.join(root, 'dsh-mesh.mjs'), 'utf8'), firstLauncher)
    assert.equal(existsSync(path.join(root, 'dsh-mesh.mjs.bak')), false)
    assert.equal(existsSync(path.join(root, 'shared', 'data', 'upgrade-pending.json')), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('an upgrade stage without a launcher is refused before anything changes', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'dsh-upgrade-'))
  const root = path.join(base, 'root')
  try {
    const stage = makeStage(base, 'stage-a')
    rmSync(path.join(stage, 'dsh-mesh.mjs'))
    const result = upgrade(stage, root)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /dsh-mesh\.mjs/u)
    assert.equal(existsSync(path.join(root, 'dsh-mesh.json')), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
