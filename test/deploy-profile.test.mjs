import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PROFILE_WIRE_SCRIPT, buildLinuxPrepareScript, buildWindowsPrepareScript } from '../code/deploy/engine.mjs'

/** Minimal plan covering the fields the prepare scripts read. */
function plan(os) {
  const windows = os === 'windows'
  const root = windows ? 'C:\\dsh-mesh' : '/opt/dsh-mesh'
  const join = name => (windows ? `${root}\\${name}` : `${root}/${name}`)
  return {
    host: '127.0.0.1',
    user: windows ? 'Administrator' : 'root',
    port: 22,
    os,
    appRoot: root,
    shared: join('shared'),
    current: join('current'),
    releases: join('releases'),
    release: 'r1',
    package: { path: windows ? 'C:\\tmp\\p.zip' : '/tmp/p.tgz', bytes: 1, sha256: 'a'.repeat(64) },
    remotePackage: windows ? 'C:\\Windows\\Temp\\p.zip' : '/tmp/p.tgz',
    services: [
      { name: windows ? 'DSH-Web-App' : 'dsh-web-app.service', role: 'dsh', command: 'start.sh' },
      { name: windows ? 'DSH-Mesh' : 'dsh-web-gate.service', role: 'gate', command: 'start.sh' },
    ],
    scope: 'all',
    gatePort: '80',
    retention: 3,
    sudo: !windows,
    serviceUser: windows ? undefined : 'root',
    gatePassword: 'shared-pw',
    preExtracted: windows,
  }
}

test('prepare scripts wire the packaged plugin into the DSH profile', () => {
  const linux = buildLinuxPrepareScript(plan('linux'))
  const windows = buildWindowsPrepareScript(plan('windows'))
  assert.match(linux, /profiles\/web.*plugins\/dsh-mesh/su)
  assert.match(linux, /DSH_MESH_PROFILE_WIRE/)
  assert.ok(windows.includes('profiles\\web'), 'windows prepare wires the web profile')
  assert.ok(windows.includes('dsh-mesh-profile-wire.mjs'), 'windows prepare runs the wire script')
})

test('the profile wire script copies the plugin and appends the bundle', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-wire-'))
  try {
    const plugin = path.join(dir, 'release', 'plugins', 'dsh-mesh')
    mkdirSync(plugin, { recursive: true })
    writeFileSync(path.join(plugin, 'package.json'), '{"name":"@local/dsh-mesh"}')
    const profile = path.join(dir, 'home', 'profiles', 'web')
    mkdirSync(profile, { recursive: true })
    writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }, null, 2) + '\n')
    const run = () => execFileSync(process.execPath, ['-', profile, plugin], { input: PROFILE_WIRE_SCRIPT, encoding: 'utf8' })
    run()
    run()
    const manifest = JSON.parse(readFileSync(path.join(profile, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@local/dsh-mesh',
    ])
    assert.equal(manifest.dependencies['@local/dsh-mesh'], 'link:./node_modules/@local/dsh-mesh')
    assert.equal(readFileSync(path.join(profile, 'node_modules', '@local', 'dsh-mesh', 'package.json'), 'utf8'), '{"name":"@local/dsh-mesh"}')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the profile wire script creates a profile DSH has not initialized yet', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-wire-'))
  try {
    const plugin = path.join(dir, 'release', 'plugins', 'dsh-mesh')
    mkdirSync(plugin, { recursive: true })
    writeFileSync(path.join(plugin, 'package.json'), '{"name":"@local/dsh-mesh"}')
    const profile = path.join(dir, 'home', 'profiles', 'web')
    execFileSync(process.execPath, ['-', profile, plugin], { input: PROFILE_WIRE_SCRIPT, encoding: 'utf8' })
    const manifest = JSON.parse(readFileSync(path.join(profile, 'package.json'), 'utf8'))
    assert.equal(manifest.name, 'dsh-profile-web')
    assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@local/dsh-mesh'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
