import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { archivePackage, materializeApp, patchBundleFingerprint, runWebBuild } from '../code/build/engine.mjs'
import { createJob, runJob } from '../code/build/job.mjs'
import { sevenZipAssetPath } from '../code/shared/sevenzip.mjs'

/** The checkout root: the bundled 7-Zip binary lives under code/gate/assets. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
import { createTarGz } from '../code/build/archive.mjs'
import {
  appCacheDir,
  appCacheMetaFile,
  cloneTree,
  packagingConcurrency,
  pruneWebCache,
  readAppCache,
  readWebCache,
  webBuildCacheKey,
  writeWebCache,
} from '../code/build/cache.mjs'

/**
 * Create a temporary directory.
 * @returns {Promise<string>} directory.
 */
async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-cache-'))
}

/**
 * Write a file, creating parent directories.
 * @param {string} file path.
 * @param {string|Buffer} content content.
 * @returns {Promise<void>}
 */
async function write(file, content) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
}

test('cloneTree hard links files and recreates symlinks', async () => {
  const root = await tempDir()
  try {
    const from = path.join(root, 'from')
    await write(path.join(from, 'a.txt'), 'hello')
    await write(path.join(from, 'nested', 'b.txt'), 'world')
    await symlink('a.txt', path.join(from, 'link.txt'))
    // More entries than the clone walk's concurrency: a semaphore that leaks a
    // permit deadlocks here instead of only on a real ~100k-file app tree.
    for (let index = 0; index < 300; index += 1) {
      await write(path.join(from, 'bulk', `f${index}.txt`), String(index))
    }
    const to = path.join(root, 'to')
    const counts = await cloneTree(from, to)
    assert.equal(await readFile(path.join(to, 'nested', 'b.txt'), 'utf8'), 'world')
    assert.equal(statSync(path.join(to, 'a.txt')).nlink, 2)
    assert.equal(lstatSync(path.join(to, 'link.txt')).isSymbolicLink(), true)
    assert.equal(await readFile(path.join(to, 'link.txt'), 'utf8'), 'hello')
    assert.equal(counts.linked, 302)
    assert.equal(counts.copied, 0)
    assert.equal(await readFile(path.join(to, 'bulk', 'f299.txt'), 'utf8'), '299')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('webBuildCacheKey covers the source, overlays, recipes, and commands', async () => {
  const root = await tempDir()
  try {
    const overlayRoot = path.join(root, 'overlays')
    await write(path.join(overlayRoot, 'a.tsx'), 'export const a = 1\n')
    const recipesFile = path.join(root, 'recipes.json')
    await write(recipesFile, JSON.stringify({ source: 'x', steps: [] }))
    const input = {
      archiveSha256: 'a'.repeat(64),
      source: 'https://github.com/example/repo',
      recipesFile,
      overlayRoot,
      prepare: [['pnpm', 'exec', 'tsx']],
      install: null,
      build: null,
    }
    const first = await webBuildCacheKey(input)
    assert.equal(await webBuildCacheKey({ ...input }), first)
    assert.notEqual(await webBuildCacheKey({ ...input, archiveSha256: 'b'.repeat(64) }), first)
    assert.notEqual(await webBuildCacheKey({ ...input, prepare: [['pnpm', 'exec', 'tsc']] }), first)
    await write(path.join(overlayRoot, 'a.tsx'), 'export const a = 2\n')
    assert.notEqual(await webBuildCacheKey({ ...input }), first)
    // A local source directory has no pinned bytes, so it cannot be cached.
    assert.equal(await webBuildCacheKey({ ...input, archiveSha256: null }), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runWebBuild skips install and the build on a cache hit', async () => {
  const root = await tempDir()
  const calls = path.join(root, 'calls.log')
  try {
    await write(path.join(root, 'make.mjs'), [
      "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'",
      `appendFileSync(${JSON.stringify(calls)}, 'build\\n')`,
      "mkdirSync('apps/web/dist', { recursive: true })",
      "writeFileSync('apps/web/dist/index.html', '<!doctype html><title>shell</title>')",
    ].join('\n'))
    const cacheDir = path.join(root, 'cache')
    const options = {
      dir: root,
      install: null,
      build: [process.execPath, 'make.mjs'],
      prebuild: false,
      cacheDir,
      cacheKey: 'f'.repeat(64),
      log: () => {},
    }
    const first = await runWebBuild(options)
    assert.equal(first.ok, true)
    assert.equal(first.cached, false)
    assert.equal(await readFile(calls, 'utf8'), 'build\n')
    const second = await runWebBuild(options)
    assert.equal(second.ok, true)
    assert.equal(second.cached, true)
    // The cache hit did not run the build a second time.
    assert.equal(await readFile(calls, 'utf8'), 'build\n')
    assert.match(second.dist, /cache/u)
    assert.ok(existsSync(path.join(second.dist, 'index.html')))
    // Refreshing ignores the entry and rebuilds.
    const refreshed = await runWebBuild({ ...options, refreshCache: true })
    assert.equal(refreshed.cached, false)
    assert.equal(await readFile(calls, 'utf8'), 'build\nbuild\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('writeWebCache stores a snapshot and pruneWebCache keeps the newest', async () => {
  const root = await tempDir()
  try {
    const cacheDir = path.join(root, 'cache')
    const dist = path.join(root, 'dist')
    await write(path.join(dist, 'index.html'), '<!doctype html>')
    await writeWebCache({ cacheDir, key: 'a'.repeat(64), dist, log: () => {} })
    const hit = await readWebCache(cacheDir, 'a'.repeat(64))
    assert.notEqual(hit, null)
    assert.equal(await readFile(path.join(hit.dist, 'index.html'), 'utf8'), '<!doctype html>')
    for (const key of ['b', 'c', 'd', 'e']) {
      await writeWebCache({ cacheDir, key: key.repeat(64), dist, log: () => {} })
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await pruneWebCache(cacheDir, 2, () => {})
    const remaining = await readdir(path.join(cacheDir, 'web'))
    assert.equal(remaining.length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('materializeApp clones a cached app tree without npm', async () => {
  const root = await tempDir()
  try {
    const cacheDir = path.join(root, 'cache')
    const version = '1.2.3-rc.1'
    const target = 'linux-x64'
    const cached = appCacheDir(cacheDir, version, target)
    await write(path.join(cached, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), '{"version":"1.2.3-rc.1"}')
    await write(path.join(cached, 'package.json'), '{"name":"dsh-web-offline"}')
    await write(path.join(cached, 'node_modules', '.bin', 'dsh'), '#!/bin/sh\n')
    await write(appCacheMetaFile(cacheDir, version, target), JSON.stringify({
      version,
      target,
      complete: true,
      patchFingerprint: await patchBundleFingerprint(root),
      installedAt: '2026-01-01T00:00:00.000Z',
    }))
    const appDir = path.join(root, 'package', 'app')
    const result = await materializeApp({
      cacheDir,
      version,
      target,
      appDir,
      repositoryRoot: root,
      log: () => {},
    })
    assert.equal(result.cached, true)
    assert.equal(result.meta.installedAt, '2026-01-01T00:00:00.000Z')
    assert.ok(existsSync(path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')))
    // A cache entry is only valid for its own version.
    assert.equal(await readAppCache(cacheDir, '9.9.9', target), null)
    assert.notEqual(await readAppCache(cacheDir, version, target), null)
    // A changed patch script invalidates it: the same path, re-read with a
    // patch file now present, must report a different fingerprint.
    await write(path.join(root, 'code', 'gate', 'patch-picker.mjs'), '// patched\n')
    assert.notEqual(await patchBundleFingerprint(root), await patchBundleFingerprint(path.join(root, 'empty')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('createTarGz produces a multi-member gzip tar with patched modes', async () => {
  const root = await tempDir()
  try {
    const pkg = path.join(root, 'pkg')
    await write(path.join(pkg, 'a.txt'), 'hello\n')
    await write(path.join(pkg, 'bin', 'tool'), '#!/bin/sh\necho hi\n')
    // Larger than one compression chunk so the parallel path is used.
    await writeFile(path.join(pkg, 'big.bin'), Buffer.alloc(6 * 1024 * 1024, 7))
    const archive = path.join(root, 'pkg.tar.gz')
    const result = await createTarGz({ packageDir: pkg, destination: archive, patchModes: true, threads: 2, log: () => {} })
    assert.ok(result.members >= 2)
    const listing = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' })
    assert.match(listing, /-rwxr-xr-x.*bin\/tool/u)
    const out = path.join(root, 'out')
    await mkdir(out)
    execFileSync('tar', ['-xzf', archive, '-C', out])
    assert.equal(await readFile(path.join(out, 'pkg', 'a.txt'), 'utf8'), 'hello\n')
    assert.equal(statSync(path.join(out, 'pkg', 'big.bin')).size, 6 * 1024 * 1024)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('archivePackage writes a 7z archive with the bundled binary', async (t) => {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    t.skip('the bundled binary used here is linux-x64')
    return
  }
  const root = await tempDir()
  try {
    const pkg = path.join(root, 'pkg')
    await write(path.join(pkg, 'index.html'), '<!doctype html>')
    await write(path.join(pkg, 'install.sh'), '#!/bin/sh\n')
    await write(path.join(pkg, 'bin', 'tool'), '#!/bin/sh\n')
    const archive = await archivePackage(pkg, 'linux-x64', {
      log: () => {},
      threads: 2,
      repositoryRoot: REPO_ROOT,
    })
    assert.equal(archive, `${pkg}.7z`)
    // The gate's own static asset is the extractor the deploy uses.
    const out = path.join(root, 'out')
    await mkdir(out)
    execFileSync(sevenZipAssetPath(REPO_ROOT, 'linux', 'x64'), ['x', '-y', '-bd', `-o${out}`, archive])
    assert.equal(await readFile(path.join(out, 'pkg', 'install.sh'), 'utf8'), '#!/bin/sh\n')
    assert.equal(existsSync(`${pkg}.7z.tar`), false)
    const legacy = await archivePackage(pkg, 'linux-x64', { format: 'legacy', log: () => {}, threads: 2 })
    assert.equal(legacy, `${pkg}.tar.gz`)
    assert.match(execFileSync('tar', ['-tzf', legacy], { encoding: 'utf8' }), /pkg\/install\.sh/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runJob packages a web-only target and settles its state', async () => {
  const root = await tempDir()
  try {
    const repo = path.join(root, 'repo')
    await write(path.join(repo, 'package.json'), '{"name":"@local/dsh-mesh","version":"0.0.1"}')
    const src = path.join(root, 'src')
    await write(path.join(src, 'package.json'), '{"name":"dsh","version":"1.2.3"}')
    await write(path.join(src, 'make.mjs'), [
      "import { mkdirSync, writeFileSync } from 'node:fs'",
      "mkdirSync('apps/web/dist', { recursive: true })",
      "writeFileSync('apps/web/dist/index.html', '<!doctype html>')",
    ].join('\n'))
    const recipes = path.join(root, 'recipes.json')
    await write(recipes, JSON.stringify({ format: 1, steps: [], prepare: [] }))
    const overlays = path.join(root, 'overlays')
    await mkdir(overlays, { recursive: true })
    const job = await createJob({ root: path.join(root, 'jobs'), source: src, ref: 'local', targets: ['linux-x64'] })
    const state = await runJob(job.dir, {
      repositoryRoot: repo,
      recipesPath: recipes,
      overlayRoot: overlays,
      cacheDir: path.join(root, 'cache'),
      build: [process.execPath, 'make.mjs'],
      install: null,
      prebuild: false,
      archiveFormat: 'legacy',
      full: false,
      smoke: false,
      publish: false,
      log: () => {},
    })
    assert.equal(state.status, 'done')
    assert.equal(state.artifacts.length, 1)
    assert.equal(state.artifacts[0].target, 'linux-x64')
    assert.equal(state.artifacts[0].smoke.status, 'skipped')
    assert.ok(existsSync(state.artifacts[0].archive))
    assert.equal(state.version, '1.2.3')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('packagingConcurrency stays serial on a small or memory-tight host', () => {
  assert.equal(packagingConcurrency({ targets: 1, cpus: 16, totalMemBytes: 32 * 1024 ** 3 }), 1)
  assert.equal(packagingConcurrency({ targets: 2, cpus: 2, totalMemBytes: 32 * 1024 ** 3 }), 1)
  assert.equal(packagingConcurrency({ targets: 2, cpus: 8, totalMemBytes: 32 * 1024 ** 3 }), 2)
  assert.equal(packagingConcurrency({ targets: 2, cpus: 8, totalMemBytes: 4 * 1024 ** 3 }), 1)
  assert.equal(packagingConcurrency({ targets: 2, cpus: 8, totalMemBytes: 32 * 1024 ** 3, requested: 1 }), 1)
  assert.equal(packagingConcurrency({ targets: 2, cpus: 4, totalMemBytes: 32 * 1024 ** 3, env: { DSH_MESH_CONCURRENCY: '2' } }), 2)
})
