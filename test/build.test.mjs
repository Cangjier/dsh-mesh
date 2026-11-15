import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  applyRecipes,
  assembleWebPackage,
  classifySource,
  learnOverlays,
  nodeArchiveName,
  overlayFrontend,
  prepareSource,
  readExtraPlugins,
  runCommand,
  runWebBuild,
  sha256Text,
  tarballUrls,
  writeWorkOrder,
} from '../code/build/engine.mjs'
import { createJob, learnJob, readState, resumeJob, writeState } from '../code/build/job.mjs'
import { buildWebWorkerPackages } from '../code/build/engine.mjs'

/**
 * Create a temporary directory.
 * @returns {Promise<string>} directory.
 */
async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-build-'))
}

/**
 * Write a file, creating parent directories.
 * @param {string} file path.
 * @param {string} content content.
 * @returns {Promise<void>}
 */
async function write(file, content) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content, 'utf8')
}

test('tarballUrls distinguishes branches, tags, and commits', () => {
  assert.deepEqual(tarballUrls({ owner: 'a', repo: 'b' }, 'master'), [
    'https://codeload.github.com/a/b/tar.gz/refs/heads/master',
    'https://codeload.github.com/a/b/tar.gz/refs/tags/master',
  ])
  assert.deepEqual(tarballUrls({ owner: 'a', repo: 'b' }, '0123456789abcdef0123456789abcdef01234567'), [
    'https://codeload.github.com/a/b/tar.gz/0123456789abcdef0123456789abcdef01234567',
  ])
})

test('classifySource accepts the fixed GitHub URL and local directories', async () => {
  const dir = await tempDir()
  try {
    const local = classifySource(dir)
    assert.equal(local.kind, 'local')
    const remote = classifySource('https://github.com/deepseek-ai/deepseek-harness.git')
    assert.deepEqual(remote, { kind: 'github', owner: 'deepseek-ai', repo: 'deepseek-harness' })
    assert.throws(() => classifySource('https://example.com/a/b'), /github\.com/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('prepareSource reuses a local directory', async () => {
  const dir = await tempDir()
  try {
    const prepared = await prepareSource({ source: dir, workDir: path.join(dir, 'work') })
    assert.equal(prepared.local, true)
    assert.equal(prepared.dir, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('applyRecipes is idempotent and reports a changed upstream as a work order', async () => {
  const dir = await tempDir()
  try {
    const source = path.join(dir, 'src')
    const overlayRoot = path.join(dir, 'overlays')
    const base = 'export const value = 1\n'
    const overlay = '/* marker-a */\nexport const value = 2\n'
    await write(path.join(source, 'a.ts'), base)
    await write(path.join(overlayRoot, 'a.ts'), overlay)
    const recipes = {
      steps: [{
        id: 'step-a',
        title: 'A',
        doc: 'docs/Step 003.md',
        files: [{ path: 'a.ts', baseSha256: sha256Text(base), overlay: 'a.ts', marker: 'marker-a' }],
      }],
    }
    const first = await applyRecipes({ dir: source, recipes, overlayRoot })
    assert.equal(first.ok, true)
    assert.equal(first.applied.length, 1)
    assert.equal(await readFile(path.join(source, 'a.ts'), 'utf8'), overlay)

    const second = await applyRecipes({ dir: source, recipes, overlayRoot })
    assert.equal(second.ok, true)
    assert.equal(second.applied.length, 0)
    assert.equal(second.skipped.length, 1)

    await write(path.join(source, 'a.ts'), 'export const value = 3\n')
    const mismatch = await applyRecipes({ dir: source, recipes, overlayRoot })
    assert.equal(mismatch.ok, false)
    assert.equal(mismatch.mismatches.length, 1)
    assert.match(mismatch.mismatches[0].reason, /changed/u)

    const order = await writeWorkOrder({
      dir: path.join(dir, 'job'),
      source: 'https://github.com/deepseek-ai/deepseek-harness',
      ref: 'master',
      recipes,
      result: mismatch,
      worktree: source,
    })
    assert.match(await readFile(order.markdown, 'utf8'), /构建工作单/u)
    assert.match(await readFile(order.prompt, 'utf8'), /覆盖层/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('learnOverlays turns the corrected worktree into a reusable overlay', async () => {
  const dir = await tempDir()
  try {
    const source = path.join(dir, 'src')
    const overlayRoot = path.join(dir, 'overlays')
    const base = 'export const value = 1\n'
    await write(path.join(source, 'a.ts'), '/* marker-a */\nexport const value = 4\n')
    const recipes = {
      steps: [{
        id: 'step-a',
        title: 'A',
        doc: 'docs/Step 003.md',
        files: [{ path: 'a.ts', baseSha256: sha256Text(base), overlay: 'a.ts', marker: 'marker-a' }],
      }],
    }
    const learned = await learnOverlays({
      worktree: source,
      recipes,
      overlayRoot,
      mismatches: [{ path: 'a.ts', actual: sha256Text('new pristine base') }],
    })
    assert.equal(learned.learned.length, 1)
    assert.equal(learned.recipes.steps[0].files[0].baseSha256, sha256Text('new pristine base'))
    assert.match(await readFile(path.join(overlayRoot, 'a.ts'), 'utf8'), /value = 4/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runCommand captures output and a non-zero exit', async () => {
  const dir = await tempDir()
  try {
    const script = path.join(dir, 'say.mjs')
    await writeFile(script, "console.log('hello'); process.exit(3)\n", 'utf8')
    const result = await runCommand(process.execPath, [script], { cwd: dir })
    assert.equal(result.ok, false)
    assert.equal(result.code, 3)
    assert.ok(result.tail.some(line => line.includes('hello')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runWebBuild finds the built web directory', async () => {
  const dir = await tempDir()
  try {
    await writeFile(path.join(dir, 'make.mjs'), [
      "import { mkdirSync, writeFileSync } from 'node:fs'",
      "mkdirSync('apps/web/dist', { recursive: true })",
      "writeFileSync('apps/web/dist/index.html', '<!doctype html>')",
    ].join('\n'), 'utf8')
    const result = await runWebBuild({
      dir,
      install: null,
      build: [process.execPath, 'make.mjs'],
    })
    assert.equal(result.ok, true)
    assert.equal(result.dist, path.join(dir, 'apps', 'web', 'dist'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('nodeArchiveName matches the official Node distribution names', () => {
  assert.equal(nodeArchiveName('24.21.0', { os: 'linux', arch: 'x64' }), 'node-v24.21.0-linux-x64.tar.gz')
  assert.equal(nodeArchiveName('24.21.0', { os: 'win', arch: 'x64' }), 'node-v24.21.0-win-x64.zip')
  assert.equal(nodeArchiveName('24.21.0', { os: 'darwin', arch: 'arm64' }), 'node-v24.21.0-darwin-arm64.tar.gz')
})

test('overlayFrontend replaces the installed frontend dist', async () => {
  const dir = await tempDir()
  try {
    const appDir = path.join(dir, 'app')
    const packageDir = path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh-web-frontend')
    await write(path.join(packageDir, 'package.json'), '{"name":"@deepseek-ai/dsh-web-frontend"}')
    await write(path.join(packageDir, 'dist', 'index.html'), '<!doctype html><title>old</title>')
    const built = path.join(dir, 'built')
    await write(path.join(built, 'index.html'), '<!doctype html><title>new</title>')
    const target = await overlayFrontend({ appDir, dist: built })
    assert.match(await readFile(path.join(target, 'index.html'), 'utf8'), /new/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('assembleWebPackage copies the web payload, gate, and plugin', async () => {
  const dir = await tempDir()
  try {
    const repo = path.join(dir, 'repo')
    const dist = path.join(dir, 'dist')
    await write(path.join(dist, 'index.html'), '<!doctype html>')
    await write(path.join(dist, 'assets', 'index.js'), 'console.log(1)')
    await write(path.join(repo, 'code', 'gate', 'server.mjs'), '// gate')
    await write(path.join(repo, 'code', 'shared', 'wireguard.mjs'), '// shared')
    await write(path.join(repo, 'code', 'shared', 'chrome.mjs'), '// cdp')
    await write(path.join(repo, 'code', 'build', 'smoke.mjs'), '// smoke')
    await write(path.join(repo, 'code', 'build', 'smoke-cli.mjs'), '// smoke cli')
    await write(path.join(repo, 'code', 'config', 'patch.yml'), '[]')
    await write(path.join(repo, 'docs', 'Step.md'), '# step')
    await write(path.join(repo, 'code', 'install.sh'), '#!/bin/sh')
    await write(path.join(repo, 'code', 'dsh-service', 'install-split.sh'), '#!/bin/sh')
    await write(path.join(repo, 'code', 'deploy', 'upgrade-local.sh'), '#!/usr/bin/env bash')
    await write(path.join(repo, 'code', 'deploy', 'rollback-local.sh'), '#!/usr/bin/env bash')
    await write(path.join(repo, 'code', 'deploy', 'wire-profile.mjs'), '// wire')
    await write(path.join(repo, 'start-dsh.sh'), '#!/bin/sh')
    await write(path.join(repo, 'index.js'), '// host')
    await write(path.join(repo, 'client.js'), '// client')
    await write(path.join(repo, 'cordis.patch.yml'), '[]')
    await write(path.join(repo, 'package.json'), '{}')
    await write(path.join(repo, 'locale', 'zh.json'), '{}')
    const result = await assembleWebPackage({
      dist,
      target: 'linux-x64',
      outputDir: path.join(dir, 'out'),
      version: '1.2.3',
      repositoryRoot: repo,
      source: 'https://github.com/deepseek-ai/deepseek-harness',
      ref: 'master',
    })
    assert.match(result.packageDir, /dsh-mesh-1\.2\.3-linux-x64$/u)
    assert.match(await readFile(path.join(result.packageDir, 'manifest.json'), 'utf8'), /linux/u)
    assert.match(await readFile(path.join(result.packageDir, 'web', 'index.html'), 'utf8'), /doctype/u)
    assert.match(await readFile(path.join(result.packageDir, 'gate', 'server.mjs'), 'utf8'), /gate/u)
    assert.match(await readFile(path.join(result.packageDir, 'plugins', 'dsh-mesh', 'client.js'), 'utf8'), /client/u)
    // A flat install rebuilds its units and rewires its profile from the
    // package, so the supervisor, the upgrade script, and start-dsh.sh must
    // travel with it.
    assert.match(await readFile(path.join(result.packageDir, 'code', 'dsh-service', 'install-split.sh'), 'utf8'), /sh/u)
    assert.match(await readFile(path.join(result.packageDir, 'code', 'deploy', 'upgrade-local.sh'), 'utf8'), /bash/u)
    assert.match(await readFile(path.join(result.packageDir, 'code', 'deploy', 'wire-profile.mjs'), 'utf8'), /wire/u)
    assert.match(await readFile(path.join(result.packageDir, 'code', 'deploy', 'rollback-local.sh'), 'utf8'), /bash/u)
    assert.match(await readFile(path.join(result.packageDir, 'start-dsh.sh'), 'utf8'), /sh/u)
    // ...and the plugin keeps its own copy for a member that upgrades itself.
    assert.match(await readFile(path.join(result.packageDir, 'plugins', 'dsh-mesh', 'code', 'deploy', 'upgrade-local.sh'), 'utf8'), /bash/u)
    assert.match(await readFile(path.join(result.packageDir, 'plugins', 'dsh-mesh', 'code', 'deploy', 'rollback-local.sh'), 'utf8'), /bash/u)
    // The post-build / test-upgrade smoke script and its CDP driver must be
    // inside the plugin, because that is what runs on the upgraded sandbox.
    assert.match(await readFile(path.join(result.packageDir, 'plugins', 'dsh-mesh', 'code', 'build', 'smoke.mjs'), 'utf8'), /smoke/u)
    assert.match(await readFile(path.join(result.packageDir, 'plugins', 'dsh-mesh', 'code', 'build', 'smoke-cli.mjs'), 'utf8'), /smoke cli/u)
    assert.match(await readFile(path.join(result.packageDir, 'plugins', 'dsh-mesh', 'code', 'shared', 'chrome.mjs'), 'utf8'), /cdp/u)
    assert.match(await readFile(path.join(result.packageDir, 'shared', 'chrome.mjs'), 'utf8'), /cdp/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('learn marks a needs-fix job learned so the CLI can resume it', async () => {
  const root = await tempDir()
  const overlayRoot = path.join(root, 'build', 'overlays')
  const target = 'packages/client/login/src/client/index.ts'
  const marker = 'dsh-mesh overlay: login'
  const overlay = `// ${marker}\nexport const login = true\n`
  await write(path.join(overlayRoot, target), overlay)
  await write(path.join(root, 'build', 'recipes.json'), JSON.stringify({
    format: 1,
    source: 'https://github.com/example/dsh',
    ref: 'master',
    tree: null,
    steps: [{
      id: 'account-login',
      title: '登录',
      doc: 'docs/step.md',
      files: [{ path: target, baseSha256: 'a'.repeat(64), overlay: target, marker }],
    }],
  }, null, 2))
  const job = await createJob({ root: path.join(root, 'jobs'), source: 'https://github.com/example/dsh', ref: 'master', targets: ['linux-x64'] })
  const worktree = path.join(job.dir, 'src')
  await write(path.join(worktree, target), overlay)
  await writeState(job.dir, {
    ...(await readState(job.dir)),
    status: 'needs-fix',
    phase: 'apply',
    worktree,
    mismatches: [{ path: target, actual: null }],
  })
  await assert.rejects(resumeJob(job.dir, { repositoryRoot: root }), /learn first/u)
  const learned = await learnJob(job.dir, { repositoryRoot: root })
  assert.equal(learned.status, 'learned')
  assert.ok(learned.learnedAt)
  // Resume now gets past the guard and fails later in the pipeline (there is
  // no web build here), which is the behaviour the CLI documents.
  const resumed = await resumeJob(job.dir, {
    repositoryRoot: root,
    install: null,
    build: ['node', '-e', 'process.exit(0)'],
  })
  assert.equal(resumed.status, 'build-failed')
})

test('webworker prebuild runs tsdown only for packages that exist', async (t) => {
  if (process.platform === 'win32') {
    t.skip('the fixture uses a shell script as a pnpm shim')
    return
  }
  const root = await tempDir()
  const bin = path.join(root, 'bin')
  const calls = path.join(root, 'calls.txt')
  await write(path.join(bin, 'pnpm'), `#!/bin/sh\necho "$@" >> ${calls}\nexit 0\n`)
  await (await import('node:fs/promises')).chmod(path.join(bin, 'pnpm'), 0o755)
  // Only the runtime package is present: the packer must be skipped, not fail.
  await mkdir(path.join(root, 'packages/experimental/webworker-runtime'), { recursive: true })
  const previous = process.env.PATH
  process.env.PATH = `${bin}:${previous ?? ''}`
  try {
    const result = await buildWebWorkerPackages({ dir: root, log: () => {} })
    assert.equal(result.ok, true)
    assert.deepEqual(result.built, ['@deepseek-ai/dsh-experimental-webworker-runtime'])
    const invoked = await readFile(calls, 'utf8')
    assert.match(invoked, /--filter @deepseek-ai\/dsh-experimental-webworker-runtime exec tsdown/u)
    assert.doesNotMatch(invoked, /webworker-packer/u)
  } finally {
    process.env.PATH = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('recipe prepare steps run before the web build', async () => {
  const root = await tempDir()
  const marker = path.join(root, 'prepared.txt')
  const dist = path.join(root, 'apps', 'web', 'dist')
  await write(path.join(dist, 'index.html'), '<html></html>')
  await write(path.join(root, 'build', 'recipes.json'), JSON.stringify({
    format: 1,
    source: 'https://github.com/example/dsh',
    ref: 'master',
    tree: null,
    prepare: [['node', '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`]],
    steps: [],
  }, null, 2))
  const result = await runWebBuild({
    dir: root,
    prepare: [['node', '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`]],
    install: null,
    prebuild: false,
    build: ['node', '-e', 'process.exit(0)'],
    log: () => {},
  })
  assert.equal(result.ok, true)
  assert.equal(await readFile(marker, 'utf8'), 'ok')
  await rm(root, { recursive: true, force: true })
})

test('assembleWebPackage appends the daily stamp without changing the DSH version', async () => {
  const dir = await tempDir()
  try {
    const repo = path.join(dir, 'repo')
    const dist = path.join(dir, 'dist')
    await write(path.join(dist, 'index.html'), '<!doctype html>')
    await write(path.join(repo, 'index.js'), '// host')
    await write(path.join(repo, 'package.json'), '{"name":"@local/dsh-mesh","version":"0.2.2-rc.3"}')
    const result = await assembleWebPackage({
      dist,
      target: 'linux-x64',
      outputDir: path.join(dir, 'out'),
      version: '0.2.2-rc.3',
      buildStamp: '20261115A',
      repositoryRoot: repo,
      source: 'https://github.com/deepseek-ai/deepseek-harness',
      ref: 'dsh-v0.2.2-rc.3',
    })
    assert.match(result.packageDir, /dsh-mesh-0\.2\.2-rc\.3-20261115A-linux-x64$/u)
    const manifest = JSON.parse(await readFile(path.join(result.packageDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.version, '0.2.2-rc.3')
    assert.equal(manifest.buildStamp, '20261115A')
    assert.equal(manifest.ref, 'dsh-v0.2.2-rc.3')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('assembleWebPackage carries the plugins listed in build/plugins.json', async () => {
  const dir = await tempDir()
  try {
    const repo = path.join(dir, 'repo')
    const dist = path.join(dir, 'dist')
    await write(path.join(dist, 'index.html'), '<!doctype html>')
    await write(path.join(repo, 'index.js'), '// host')
    await write(path.join(repo, 'package.json'), '{}')
    await write(path.join(repo, 'build', 'plugins.json'), JSON.stringify({
      format: 1,
      plugins: [{ name: 'xl', dir: 'plugins/xl', repo: 'https://github.com/Cangjier/xl', ref: 'main' }],
    }))
    const parsed = await readExtraPlugins(repo)
    assert.deepEqual(parsed, [{ name: 'xl', dir: 'plugins/xl', repo: 'https://github.com/Cangjier/xl', ref: 'main' }])

    // A real tarball, served by a fake fetch: the copy path and the recorded
    // hash are what make a package traceable back to the plugin commit.
    const source = path.join(dir, 'src', 'xl-main')
    await write(path.join(source, 'package.json'), '{"name":"xl"}')
    await write(path.join(source, 'cordis.patch.yml'), '[]')
    const archive = path.join(dir, 'xl.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', path.join(dir, 'src'), 'xl-main'])
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      body: Readable.toWeb(createReadStream(archive)),
    })
    const result = await assembleWebPackage({
      dist,
      target: 'linux-x64',
      outputDir: path.join(dir, 'out'),
      version: '1.2.3',
      repositoryRoot: repo,
      source: 'https://github.com/deepseek-ai/deepseek-harness',
      ref: 'master',
      cacheDir: path.join(dir, 'cache'),
      fetchImpl,
    })
    assert.match(await readFile(path.join(result.packageDir, 'plugins', 'xl', 'package.json'), 'utf8'), /"xl"/u)
    assert.match(await readFile(path.join(result.packageDir, 'plugins', 'xl', 'cordis.patch.yml'), 'utf8'), /\[\]/u)
    const manifest = JSON.parse(await readFile(path.join(result.packageDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.extraPlugins.length, 1)
    assert.equal(manifest.extraPlugins[0].name, 'xl')
    assert.equal(manifest.extraPlugins[0].ref, 'main')
    assert.equal(manifest.extraPlugins[0].archiveSha256.length, 64)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
