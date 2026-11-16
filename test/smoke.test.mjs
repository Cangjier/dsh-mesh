import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import {
  chromeCandidates,
  findChrome,
  isNativeTarget,
  runInstallSmoke,
  runPackageSmoke,
  targetOs,
} from '../code/build/smoke.mjs'

const run = promisify(execFile)
const here = path.dirname(new URL(import.meta.url).pathname)
const repository = path.join(here, '..')

/**
 * Create a temporary directory.
 * @returns {Promise<string>} directory.
 */
async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-smoke-test-'))
}

test('findChrome prefers an explicit executable', async () => {
  const dir = await tempDir()
  try {
    const binary = path.join(dir, 'chrome')
    await writeFile(binary, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(binary, 0o755)
    assert.equal(findChrome({ DSH_MESH_SMOKE_CHROME: binary }), binary)
    const candidates = chromeCandidates({ DSH_MESH_SMOKE_CHROME: binary })
    assert.equal(candidates[0], binary)
    assert.ok(candidates.length > 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('findChrome skips a path that is not executable', () => {
  const missing = path.join(os.tmpdir(), 'dsh-mesh-no-such-chrome')
  const candidates = chromeCandidates({ DSH_MESH_SMOKE_CHROME: missing })
  assert.equal(candidates[0], missing)
  // Either a real browser is installed or the probe returns null; in both
  // cases the missing explicit path must not be selected.
  assert.notEqual(findChrome({ DSH_MESH_SMOKE_CHROME: missing }), missing)
})

test('isNativeTarget only accepts the package that runs on this host', () => {
  assert.equal(targetOs('linux'), 'linux')
  assert.equal(targetOs('win32'), 'win')
  assert.equal(targetOs('darwin'), 'darwin')
  assert.equal(isNativeTarget(`${targetOs()}-${process.arch}`), true)
  assert.equal(isNativeTarget('win-x64'), process.platform === 'win32' && process.arch === 'x64')
  assert.equal(isNativeTarget('linux-arm64'), process.platform === 'linux' && process.arch === 'arm64')
})

test('runPackageSmoke skips a cross-target package without needing Chrome', async () => {
  const dir = await tempDir()
  try {
    const foreign = process.platform === 'win32' ? 'linux-x64' : 'win-x64'
    const result = await runPackageSmoke({ packageRoot: dir, target: foreign, chrome: null })
    assert.equal(result.status, 'skipped')
    assert.match(result.reason, /cannot run on/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runPackageSmoke skips a native package when no Chrome is installed', async () => {
  const dir = await tempDir()
  try {
    const target = `${targetOs()}-${process.arch}`
    const result = await runPackageSmoke({ packageRoot: dir, target, chrome: null })
    assert.equal(result.status, 'skipped')
    assert.match(result.reason, /no Chrome/u)
    // `required` is how a release build can refuse to ship unverified.
    const required = await runPackageSmoke({ packageRoot: dir, target, chrome: null, required: true })
    assert.equal(required.status, 'failed')
    assert.match(required.error, /no Chrome/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runPackageSmoke reports an incomplete package instead of hanging', async () => {
  const dir = await tempDir()
  try {
    const target = `${targetOs()}-${process.arch}`
    const result = await runPackageSmoke({
      packageRoot: dir,
      target,
      chrome: process.execPath,
      workDir: path.join(dir, 'work'),
    })
    assert.equal(result.status, 'failed')
    assert.match(result.error, /package is missing app\//u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runInstallSmoke rejects a directory that is not an install', async () => {
  const dir = await tempDir()
  try {
    const target = `${targetOs()}-${process.arch}`
    const result = await runInstallSmoke({
      root: dir,
      target,
      chrome: process.execPath,
      workDir: path.join(dir, 'work'),
    })
    assert.equal(result.status, 'failed')
    assert.match(result.error, /not a complete dsh-mesh install/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wire-profile replaces the empty patch placeholder instead of appending to it', async () => {
  const dir = await tempDir()
  try {
    const root = path.join(dir, 'install')
    const home = path.join(root, 'home')
    const profile = path.join(home, 'profiles', 'web')
    await mkdir(path.join(root, 'plugins', 'dsh-mesh'), { recursive: true })
    await mkdir(profile, { recursive: true })
    await writeFile(path.join(root, 'plugins', 'dsh-mesh', 'package.json'), '{"name":"@local/dsh-mesh"}\n', 'utf8')
    await mkdir(path.join(root, 'config'), { recursive: true })
    await writeFile(path.join(root, 'config', 'gate.env'), 'DSH_GATE_PORT=80\n', 'utf8')
    const patch = path.join(profile, 'cordis.patch.yml')
    await writeFile(patch, [
      '# Your patch layer for this dsh profile.',
      '# overrides, disables, and insert lists are allowed.',
      '[]',
      '',
    ].join('\n'), 'utf8')
    const node = process.execPath
    const script = path.join(repository, 'code', 'deploy', 'wire-profile.mjs')
    const args = [
      script,
      '--root', root,
      '--profile', profile,
      '--env', path.join(root, 'config', 'gate.env'),
      '--dsh-home', home,
      '--workdir', path.join(root, 'workspace'),
      '--port', '18080',
      '--token', 'test-token',
    ]
    await run(node, args, { cwd: root })
    const first = await readFile(patch, 'utf8')
    assert.doesNotMatch(first, /^\[\]\s*$/mu)
    assert.match(first, /- id: dsh-mesh/u)
    assert.equal(first.match(/# BEGIN dsh-mesh deploy/gu)?.length, 1)

    // A second run must be a no-op on the block, not append a duplicate.
    await run(node, args, { cwd: root })
    const second = await readFile(patch, 'utf8')
    assert.equal(second, first)
    assert.equal(second.match(/# BEGIN dsh-mesh deploy/gu)?.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('chromeCandidates detects Edge on Windows, including x86 and per-user installs', async () => {
  const dir = await tempDir()
  try {
    const programFiles = path.join(dir, 'PF')
    const programFilesX86 = path.join(dir, 'PF86')
    const localAppData = path.join(dir, 'Local')
    const machineWide = path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    const perUser = path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    for (const file of [machineWide, perUser]) {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, '', 'utf8')
    }
    const env = { ProgramFiles: programFiles, 'ProgramFiles(x86)': programFilesX86, LOCALAPPDATA: localAppData }
    const candidates = chromeCandidates(env, 'win32')
    assert.ok(candidates.includes(machineWide))
    assert.ok(candidates.includes(perUser))
    // No Chrome in this environment: Edge is the answer, not "no browser".
    assert.equal(findChrome(env, 'win32'), machineWide)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('chromeCandidates offers Edge on Linux and keeps the explicit override first', () => {
  const linux = chromeCandidates({}, 'linux')
  assert.ok(linux.includes('/usr/bin/microsoft-edge'))
  assert.ok(linux.includes('/usr/bin/microsoft-edge-stable'))
  const configured = chromeCandidates({ DSH_MESH_SMOKE_CHROME: 'C:\\edge\\msedge.exe' }, 'win32')
  assert.equal(configured[0], 'C:\\edge\\msedge.exe')
})

test('chromeCandidates looks on PATH for Chrome and Edge', () => {
  const env = { PATH: ['C:\\one', 'C:\\two'].join(';') }
  const candidates = chromeCandidates(env, 'win32')
  assert.ok(candidates.includes(path.join('C:\\one', 'msedge.exe')))
  assert.ok(candidates.includes(path.join('C:\\two', 'chrome.exe')))
})
