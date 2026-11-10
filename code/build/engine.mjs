/**
 * Deterministic build engine for the modified DSH web edition.
 *
 * The engine never calls a model. It prepares a source tree, applies pinned
 * overlays, runs the web build, and packages the result. When an overlay no
 * longer matches upstream it stops and writes a work order for the calling DSH
 * to hand to a subagent; `learn` turns the corrected worktree back into an
 * overlay for the next run.
 *
 * @module dsh-person-web/build/engine
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, cp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { gzipSync, gunzipSync } from 'node:zlib'
import os from 'node:os'
import path from 'node:path'

/** Fixed upstream repository. */
export const DEFAULT_SOURCE = 'https://github.com/deepseek-ai/deepseek-harness'

/** Default branch of the upstream repository. */
export const DEFAULT_REF = 'master'

/** Default target matrix. */
export const DEFAULT_TARGETS = Object.freeze(['linux-x64', 'win-x64'])

/**
 * SHA-256 of one file.
 * @param {string} file path.
 * @returns {Promise<string>} hex digest.
 */
export async function sha256File(file) {
  const hash = createHash('sha256')
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

/**
 * SHA-256 of a string.
 * @param {string} text input.
 * @returns {string} hex digest.
 */
export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Human-readable target descriptor.
 * @param {string} target `linux-x64`, `win-x64`, `darwin-arm64`.
 * @returns {{os: string, arch: string, libc: string}} parsed target.
 */
export function parseTarget(target) {
  const [os, arch] = String(target).split('-')
  if (!['linux', 'win', 'darwin'].includes(os)) throw new Error(`unsupported target OS: ${target}`)
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`unsupported target architecture: ${target}`)
  return { os, arch, libc: os === 'linux' ? 'glibc' : '' }
}

/**
 * Normalize the fixed GitHub source URL.
 * @param {string} source repository URL or a local directory.
 * @returns {{kind: 'local', dir: string} | {kind: 'github', owner: string, repo: string}} source kind.
 */
export function classifySource(source) {
  const value = String(source).trim().replace(/^git\+/u, '').replace(/\.git$/u, '').replace(/\/+$/u, '')
  if (existsSync(value)) return { kind: 'local', dir: path.resolve(value) }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`source is neither a local directory nor a URL: ${source}`)
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
    throw new Error(`source must be a github.com repository or a local directory: ${source}`)
  }
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 2) throw new Error(`cannot read owner/repository from ${source}`)
  return { kind: 'github', owner: parts[0], repo: parts[1] }
}

/**
 * Candidate tarball URLs for one ref. A full commit is unambiguous; a branch
 * or tag is tried in that order because codeload distinguishes them.
 * @param {{owner: string, repo: string}} repo source.
 * @param {string} ref branch, tag, or commit.
 * @returns {string[]} URLs to try.
 */
export function tarballUrls(repo, ref) {
  const base = `https://codeload.github.com/${repo.owner}/${repo.repo}/tar.gz`
  if (/^[0-9a-f]{40}$/iu.test(ref)) return [`${base}/${ref}`]
  return [`${base}/refs/heads/${encodeURIComponent(ref)}`, `${base}/refs/tags/${encodeURIComponent(ref)}`]
}

/**
 * Download one URL to a file. Returns false for a 404 so a branch fallback can
 * try the next candidate.
 * @param {string} url source.
 * @param {string} file destination.
 * @param {{fetchImpl?: typeof fetch, log?: (line: string) => void}} [options] dependencies.
 * @returns {Promise<boolean>} true when the file is present.
 */
export async function download(url, file, options = {}) {
  if (existsSync(file) && (await stat(file)).size > 0) return true
  const fetchImpl = options.fetchImpl ?? fetch
  const log = options.log ?? (() => {})
  log(`GET ${url}`)
  const response = await fetchImpl(url, { redirect: 'follow' })
  if (response.status === 404) return false
  if (!response.ok || response.body === null) throw new Error(`download failed: ${url} -> HTTP ${String(response.status)}`)
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.part`
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary))
  await rename(temporary, file)
  return true
}

/**
 * Run a command, streaming both outputs into a log and keeping a tail.
 * @param {string} command executable.
 * @param {string[]} args arguments.
 * @param {{cwd?: string, log?: (line: string) => void, timeoutMs?: number, shell?: boolean, env?: NodeJS.ProcessEnv}} [options] run options.
 * @returns {Promise<{ok: boolean, code: number|null, signal: string|null, tail: string[], error?: Error}>} result.
 */
export function runCommand(command, args, options = {}) {
  const log = options.log ?? (() => {})
  const tail = []
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: options.shell === true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, code: null, signal: null, tail, error: error instanceof Error ? error : new Error(String(error)) })
      return
    }
    const onData = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/u)) {
        if (line === '') continue
        tail.push(line)
        if (tail.length > 240) tail.shift()
        log(line)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    let timer
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        log(`timed out after ${String(options.timeoutMs)}ms; terminating ${command}`)
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
      }, options.timeoutMs)
      timer.unref()
    }
    child.on('error', (error) => {
      if (timer !== undefined) clearTimeout(timer)
      resolve({ ok: false, code: null, signal: null, tail, error })
    })
    child.on('close', (code, signal) => {
      if (timer !== undefined) clearTimeout(timer)
      resolve({ ok: code === 0, code, signal, tail })
    })
  })
}

/**
 * Extract a tarball into a directory, stripping the single top-level folder.
 * @param {string} archive archive path.
 * @param {string} destination empty directory.
 * @param {{log?: (line: string) => void}} [options] dependencies.
 * @returns {Promise<void>}
 */
export async function extractTarball(archive, destination, options = {}) {
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  if (archive.toLowerCase().endsWith('.zip') && process.platform !== 'win32') {
    // GNU tar does not read zip; a Linux build host needs `unzip`.
    const temporary = `${destination}.zip-tmp`
    await rm(temporary, { recursive: true, force: true })
    await mkdir(temporary, { recursive: true })
    const unzipped = await runCommand('unzip', ['-q', archive, '-d', temporary], { log: options.log })
    if (!unzipped.ok) {
      throw new Error(`cannot extract ${archive}: ${unzipped.error?.message ?? `unzip exited with ${String(unzipped.code)}`}\n${unzipped.tail.join('\n')}`)
    }
    const entries = await readdir(temporary)
    const first = entries[0]
    const wrapped = entries.length === 1 && first !== undefined && (await stat(path.join(temporary, first))).isDirectory()
    const content = wrapped ? path.join(temporary, first) : temporary
    await rm(destination, { recursive: true, force: true })
    await cp(content, destination, { recursive: true })
    await rm(temporary, { recursive: true, force: true })
    return
  }
  const result = await runCommand('tar', ['-xf', archive, '--strip-components=1', '-C', destination], {
    log: options.log,
  })
  if (!result.ok) {
    throw new Error(`cannot extract ${archive}: ${result.error?.message ?? `tar exited with ${String(result.code)}`}\n${result.tail.join('\n')}`)
  }
}

/**
 * Prepare a source worktree: reuse a local directory or download and extract a
 * GitHub tarball into `workDir/src`.
 * @param {{source?: string, ref?: string, cacheDir?: string, workDir: string, fetchImpl?: typeof fetch, log?: (line: string) => void, maxCacheAgeMs?: number}} options preparation input.
 * @returns {Promise<{dir: string, source: string, ref: string, local: boolean, archive?: string, archiveSha256?: string}>} prepared tree.
 */
export async function prepareSource(options) {
  const source = options.source ?? DEFAULT_SOURCE
  const ref = options.ref ?? DEFAULT_REF
  const log = options.log ?? (() => {})
  const classified = classifySource(source)
  if (classified.kind === 'local') {
    log(`using local source ${classified.dir}`)
    return { dir: classified.dir, source, ref, local: true }
  }
  const cacheDir = options.cacheDir ?? path.join(os.homedir(), '.dsh', 'person-web', 'cache')
  const urls = tarballUrls(classified, ref)
  const archive = path.join(cacheDir, 'sources', `${sha256Text(`${classified.owner}/${classified.repo}@${ref}`).slice(0, 16)}.tar.gz`)
  // A branch or tag can move. Keep the download for a while, but do not reuse
  // a months-old `master` forever; an explicit commit is immutable.
  const immutable = /^[0-9a-f]{40}$/iu.test(ref)
  if (!immutable && existsSync(archive)) {
    const age = Date.now() - (await stat(archive)).mtimeMs
    if (age > (options.maxCacheAgeMs ?? 6 * 60 * 60_000)) {
      log(`refreshing cached tarball for ${ref} (older than the cache window)`)
      await rm(archive, { force: true })
    }
  }
  let downloaded = false
  for (const url of urls) {
    downloaded = await download(url, archive, { fetchImpl: options.fetchImpl, log })
    if (downloaded) break
  }
  if (!downloaded) throw new Error(`cannot find ref "${ref}" in ${classified.owner}/${classified.repo}`)
  const archiveSha256 = await sha256File(archive)
  const dir = path.join(options.workDir, 'src')
  log(`extracting ${path.basename(archive)} to ${dir}`)
  await extractTarball(archive, dir, { log })
  return { dir, source, ref, local: false, archive, archiveSha256 }
}

/**
 * Read the recipe manifest.
 * @param {string} file manifest path.
 * @returns {Promise<object>} manifest.
 */
export async function loadRecipes(file) {
  const parsed = JSON.parse(await readFile(file, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.steps)) {
    throw new Error(`${file} is not a recipe manifest`)
  }
  return parsed
}

/**
 * Apply every overlay. The operation is idempotent: a file that already carries
 * the marker is skipped, and a base hash mismatch becomes a work order item.
 * @param {{dir: string, recipes: object, overlayRoot: string, log?: (line: string) => void}} options apply input.
 * @returns {Promise<{ok: boolean, applied: object[], skipped: object[], mismatches: object[]}>} outcome.
 */
export async function applyRecipes(options) {
  const log = options.log ?? (() => {})
  const applied = []
  const skipped = []
  const mismatches = []
  for (const step of options.recipes.steps) {
    for (const entry of step.files ?? []) {
      const target = path.join(options.dir, entry.path)
      const overlay = path.join(options.overlayRoot, entry.overlay)
      const label = { step: step.id, title: step.title, doc: step.doc, path: entry.path }
      if (!existsSync(overlay)) {
        mismatches.push({ ...label, reason: 'overlay file is missing', expected: entry.baseSha256 ?? null, actual: null })
        continue
      }
      let current = null
      try {
        current = await readFile(target, 'utf8')
      } catch (error) {
        if (entry.baseSha256 !== null) {
          mismatches.push({ ...label, reason: 'upstream file is missing', expected: entry.baseSha256, actual: null })
          continue
        }
      }
      if (current !== null && current.includes(entry.marker)) {
        skipped.push(label)
        continue
      }
      if (entry.baseSha256 === null) {
        if (current !== null) {
          mismatches.push({ ...label, reason: 'new file already exists without the overlay marker', expected: null, actual: sha256Text(current) })
          continue
        }
      } else {
        const actual = current === null ? null : sha256Text(current)
        if (actual !== entry.baseSha256) {
          mismatches.push({ ...label, reason: 'upstream file changed since the overlay was recorded', expected: entry.baseSha256, actual })
          continue
        }
      }
      await mkdir(path.dirname(target), { recursive: true })
      await cp(overlay, target)
      const written = await readFile(target, 'utf8')
      if (!written.includes(entry.marker)) {
        mismatches.push({ ...label, reason: 'overlay was written but its marker is missing', expected: entry.baseSha256 ?? null, actual: sha256Text(written) })
        continue
      }
      applied.push(label)
      log(`applied ${step.id}: ${entry.path}`)
    }
  }
  return { ok: mismatches.length === 0, applied, skipped, mismatches }
}

/**
 * Write the work order a calling DSH can hand to a subagent.
 * @param {{dir: string, source: string, ref: string, recipes: object, result: object, worktree?: string}} options work order input.
 * @returns {Promise<{json: string, markdown: string, prompt: string}>} written paths and the suggested prompt.
 */
export async function writeWorkOrder(options) {
  await mkdir(options.dir, { recursive: true })
  const jobDir = options.jobDir ?? options.dir
  const jsonPath = path.join(options.dir, 'work-order.json')
  const markdownPath = path.join(options.dir, 'work-order.md')
  const promptPath = path.join(options.dir, 'subagent-prompt.txt')
  const prompt = [
    `你在为 dsh-person-web 构建 ${options.source}@${options.ref} 的修改版 Web 包。`,
    '确定性构建在应用源码覆盖层时失败。请只修复工作树里的源码，不要放宽覆盖层校验。',
    '先读 work-order.md 与对应的 Step 文档，再修改下列文件，使每个文件的覆盖层 marker 存在，并让 pnpm run build:web 通过。',
    `修完后运行 \`node code/build/cli.mjs learn --job ${jobDir}\` 把修改收成新的覆盖层，然后 \`node code/build/cli.mjs build --job ${jobDir} --resume\`。`,
    '',
    ...options.result.mismatches.map(item => `- ${item.path}（${item.step}；${item.doc}）：${item.reason}`),
  ].join('\n')
  const markdown = [
    `# 构建工作单：${options.source}@${options.ref}`,
    '',
    `- 源码树：\`${options.worktree ?? path.join(jobDir, 'src')}\``,
    `- 任务目录：\`${jobDir}\``,
    `- 生成时间：${new Date().toISOString()}`,
    `- 失败项：${String(options.result.mismatches.length)}`,
    '',
    '## 失败项',
    '',
    '| Step | 文件 | 期望 base SHA-256 | 实际 SHA-256 | 原因 | 文档 |',
    '|---|---|---|---|---|---|',
    ...options.result.mismatches.map(item => `| ${item.step} | \`${item.path}\` | ${item.expected ?? '—'} | ${item.actual ?? '—'} | ${item.reason} | \`${item.doc}\` |`),
    '',
    '## 修复方式',
    '',
    '1. 打开源码树里的目标文件，按对应 Step 文档把界面改好。',
    '2. 保持覆盖层 marker 注释存在：picker 是 `dsh-person-web overlay: picker`，login 是 `dsh-person-web overlay: login`。',
    `3. 运行 \`node code/build/cli.mjs learn --job ${jobDir}\`；它会把改好的文件写回 \`build/overlays/\`。`,
    `4. 运行 \`node code/build/cli.mjs build --job ${jobDir} --resume\`；下一次同一 ref 会先应用这份新覆盖层。`,
    '',
    '## 建议的子代理提示词',
    '',
    '```text',
    prompt,
    '```',
  ].join('\n')
  await writeFile(jsonPath, JSON.stringify({
    source: options.source,
    ref: options.ref,
    generatedAt: new Date().toISOString(),
    jobDir,
    worktree: options.worktree ?? path.join(jobDir, 'src'),
    mismatches: options.result.mismatches,
  }, null, 2), 'utf8')
  await writeFile(markdownPath, markdown, 'utf8')
  await writeFile(promptPath, prompt, 'utf8')
  return { json: jsonPath, markdown: markdownPath, prompt: promptPath }
}

/**
 * Turn the current worktree files into new overlays. The base hashes stay
 * unchanged: they describe the pristine input the overlay is written against.
 * @param {{worktree: string, recipes: object, overlayRoot: string, mismatches?: object[]}} options learn input.
 * @returns {Promise<{ok: true, learned: object[], recipes: object}>} learned files and updated manifest.
 */
export async function learnOverlays(options) {
  const learned = []
  const actualByPath = new Map(
    (options.mismatches ?? [])
      .filter(item => typeof item.actual === 'string' && /^[0-9a-f]{64}$/u.test(item.actual))
      .map(item => [item.path, item.actual]),
  )
  for (const step of options.recipes.steps) {
    for (const entry of step.files ?? []) {
      const source = path.join(options.worktree, entry.path)
      let text
      try {
        text = await readFile(source, 'utf8')
      } catch {
        throw new Error(`cannot learn ${entry.path}: the file is missing from the worktree`)
      }
      if (!text.includes(entry.marker)) {
        throw new Error(`cannot learn ${entry.path}: the overlay marker "${entry.marker}" is missing`)
      }
      const target = path.join(options.overlayRoot, entry.overlay)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, text, 'utf8')
      // The learned overlay is written against the pristine file that actually
      // caused the mismatch, not the old revision. Without this the next fresh
      // checkout would report the same mismatch forever.
      const actual = actualByPath.get(entry.path)
      if (actual !== undefined && entry.baseSha256 !== null) entry.baseSha256 = actual
      learned.push({ step: step.id, path: entry.path, overlay: entry.overlay })
    }
  }
  return { ok: true, learned, recipes: options.recipes }
}

/**
 * Run the web build.
 * @param {{dir: string, log?: (line: string) => void, install?: string[]|null, build?: string[]}} options build input.
 * @returns {Promise<{ok: boolean, dist: string|null, error?: string}>} outcome.
 */
export async function runWebBuild(options) {
  const log = options.log ?? (() => {})
  // Windows package managers are `.cmd` shims; `shell: true` is how Node runs
  // them. A plain executable such as `node` must not go through the shell, or
  // a path containing spaces loses its quoting.
  const needsShell = command => process.platform === 'win32' && /^(pnpm|npm|npx|yarn|corepack)(\.cmd)?$/iu.test(command)
  const install = options.install === undefined ? ['pnpm', 'install', '--frozen-lockfile'] : options.install
  const build = options.build ?? ['pnpm', 'run', 'build:web']
  if (install !== null && install.length > 0) {
    log(`$ ${install.join(' ')}`)
    const installed = await runCommand(install[0], install.slice(1), {
      cwd: options.dir,
      log,
      shell: needsShell(install[0]),
      timeoutMs: 30 * 60_000,
    })
    if (!installed.ok) {
      return { ok: false, dist: null, error: `dependency installation failed (exit ${String(installed.code)})\n${installed.tail.join('\n')}` }
    }
  }
  log(`$ ${build.join(' ')}`)
  const built = await runCommand(build[0], build.slice(1), {
    cwd: options.dir,
    log,
    shell: needsShell(build[0]),
    timeoutMs: 30 * 60_000,
  })
  if (!built.ok) {
    return { ok: false, dist: null, error: `web build failed (exit ${String(built.code)})\n${built.tail.join('\n')}` }
  }
  const candidates = [
    path.join(options.dir, 'apps', 'web', 'dist'),
    path.join(options.dir, 'dist'),
  ]
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'index.html'))) return { ok: true, dist: candidate }
  }
  return { ok: false, dist: null, error: 'the build finished but no dist/index.html was found' }
}

/**
 * Copy a directory if it exists.
 * @param {string} from source.
 * @param {string} to destination.
 * @returns {Promise<void>}
 */
export async function copyIfExists(from, to) {
  if (!existsSync(from)) return
  await mkdir(path.dirname(to), { recursive: true })
  await cp(from, to, { recursive: true })
}

/**
 * List files under a directory relative to it.
 * @param {string} dir root.
 * @returns {Promise<string[]>} relative paths.
 */
export async function listFiles(dir) {
  const out = []
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) out.push(path.relative(dir, full))
    }
  }
  if (existsSync(dir)) await walk(dir)
  return out
}

/**
 * Assemble one target package without downloading runtimes yet. This is the
 * deterministic half of packaging; the runtime/app layer is added by
 * `assembleRuntimePackage`.
 * @param {{dist: string, target: string, outputDir: string, version: string, repositoryRoot: string, log?: (line: string) => void}} options package input.
 * @returns {Promise<{packageDir: string, manifest: object}>} package directory and manifest.
 */
export async function assembleWebPackage(options) {
  const { os: targetOs, arch, libc } = parseTarget(options.target)
  const packageDir = path.join(options.outputDir, `dsh-person-web-${options.version}-${targetOs}-${arch}`)
  await rm(packageDir, { recursive: true, force: true })
  await mkdir(path.join(packageDir, 'web'), { recursive: true })
  await cp(options.dist, path.join(packageDir, 'web'), { recursive: true })
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'gate'), path.join(packageDir, 'gate'))
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'shared'), path.join(packageDir, 'shared'))
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'config'), path.join(packageDir, 'config'))
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'windows-service'), path.join(packageDir, 'code', 'windows-service'))
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'interop-service'), path.join(packageDir, 'code', 'interop-service'))
  await copyIfExists(path.join(options.repositoryRoot, 'docs'), path.join(packageDir, 'docs'))
  for (const file of ['install.sh', 'start.sh', 'stop.sh', 'status.sh', 'doctor.sh', 'install.ps1', 'start.ps1', 'stop.ps1', 'start.cmd', 'stop.cmd', 'VERSION']) {
    await copyIfExists(path.join(options.repositoryRoot, 'code', file), path.join(packageDir, file))
  }
  for (const file of ['start-interop.sh', 'install-interop-service.sh', 'uninstall-interop-service.sh']) {
    await copyIfExists(path.join(options.repositoryRoot, file), path.join(packageDir, file))
  }
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'package.json']) {
    await copyIfExists(path.join(options.repositoryRoot, file), path.join(packageDir, 'plugins', 'dsh-person-web', file))
  }
  await copyIfExists(path.join(options.repositoryRoot, 'locale'), path.join(packageDir, 'plugins', 'dsh-person-web', 'locale'))
  // The packaged plugin must be able to run `build_learn`/`build_resume` on a
  // deployed member, so its recipes, overlays, and build modules travel with it.
  await copyIfExists(path.join(options.repositoryRoot, 'build'), path.join(packageDir, 'plugins', 'dsh-person-web', 'build'))
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'build'), path.join(packageDir, 'plugins', 'dsh-person-web', 'code', 'build'))
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'shared'), path.join(packageDir, 'plugins', 'dsh-person-web', 'code', 'shared'))
  const manifest = {
    format: 1,
    name: 'dsh-person-web',
    version: options.version,
    target: { os: targetOs, arch, libc },
    builtAt: new Date().toISOString(),
    source: options.source ?? null,
    ref: options.ref ?? null,
    tree: options.tree ?? null,
    files: (await listFiles(packageDir)).length,
  }
  await writeFile(path.join(packageDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return { packageDir, manifest }
}

/**
 * Windows' bsdtar writes every entry with mode 0666. A Linux package built on
 * Windows therefore loses the executable bit on `install.sh` and
 * `runtime/node/bin/node`. Rewrite the tar headers to 0755 before re-gzipping.
 * This runs only when a non-Windows target is archived from Windows.
 * @param {string} archive `.tar.gz` path, rewritten in place.
 * @returns {Promise<void>}
 */
export async function fixTarExecutableModes(archive) {
  const raw = gunzipSync(await readFile(archive))
  let offset = 0
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const type = String.fromCharCode(header[156] || 0)
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim()
    const size = sizeText === '' ? 0 : Number.parseInt(sizeText, 8)
    if (type === '0' || type === '\0' || type === '5' || type === '2') {
      header.write('0000755\0', 100, 8, 'ascii')
    }
    header.fill(0x20, 148, 156)
    let checksum = 0
    for (const byte of header) checksum += byte
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    offset += 512 + (Number.isFinite(size) ? Math.ceil(size / 512) * 512 : 0)
  }
  await writeFile(archive, gzipSync(raw, { level: 9 }))
}

/**
 * Create a `.tar.gz` for Linux or a `.zip` for Windows.
 * @param {string} packageDir directory to archive.
 * @param {string} target target descriptor.
 * @param {{log?: (line: string) => void}} [options] dependencies.
 * @returns {Promise<string>} archive path.
 */
export async function archivePackage(packageDir, target, options = {}) {
  const { os: targetOs } = parseTarget(target)
  const archive = targetOs === 'win'
    ? `${packageDir}.zip`
    : `${packageDir}.tar.gz`
  await rm(archive, { force: true })
  let result
  if (targetOs === 'win' && process.platform !== 'win32') {
    // GNU tar cannot create a zip; a Linux build host needs the `zip` tool.
    result = await runCommand('zip', ['-qr', archive, path.basename(packageDir)], {
      cwd: path.dirname(packageDir),
      log: options.log,
    })
  } else {
    const args = targetOs === 'win'
      ? ['-a', '-c', '-f', archive, '-C', path.dirname(packageDir), path.basename(packageDir)]
      : ['-czf', archive, '-C', path.dirname(packageDir), path.basename(packageDir)]
    result = await runCommand('tar', args, { log: options.log })
  }
  if (!result.ok) throw new Error(`cannot archive ${packageDir}: ${result.tail.join('\n')}`)
  if (targetOs !== 'win' && process.platform === 'win32') await fixTarExecutableModes(archive)
  return archive
}

/**
 * Node binary archive name for one target.
 * @param {string} version Node version without the `v`.
 * @param {{os: string, arch: string}} target target.
 * @returns {string} archive filename.
 */
export function nodeArchiveName(version, target) {
  if (target.os === 'win') return `node-v${version}-win-${target.arch}.zip`
  // Use the gzip archive on Unix too: Windows' bsdtar cannot reliably read
  // Node's .tar.xz, and the .tar.gz variant avoids depending on an `xz` tool.
  return `node-v${version}-${target.os === 'darwin' ? 'darwin' : 'linux'}-${target.arch}.tar.gz`
}

/**
 * Download and verify a Node runtime, then extract it under `runtime/node`.
 * @param {{version: string, target: string, cacheDir: string, destination: string, fetchImpl?: typeof fetch, log?: (line: string) => void}} options runtime input.
 * @returns {Promise<{directory: string, archive: string, sha256: string}>} extracted runtime.
 */
export async function installNodeRuntime(options) {
  const parsed = parseTarget(options.target)
  const log = options.log ?? (() => {})
  const archiveName = nodeArchiveName(options.version, parsed)
  const base = `https://nodejs.org/dist/v${options.version}`
  const archive = path.join(options.cacheDir, 'node', archiveName)
  const downloaded = await download(`${base}/${archiveName}`, archive, { fetchImpl: options.fetchImpl, log })
  if (!downloaded) throw new Error(`Node ${options.version} has no ${parsed.os}-${parsed.arch} archive`)
  const sums = await fetch(`${base}/SHASUMS256.txt`, { redirect: 'follow' })
  if (!sums.ok) throw new Error(`cannot read Node SHASUMS256.txt: HTTP ${String(sums.status)}`)
  const text = await sums.text()
  const line = text.split(/\r?\n/u).find(entry => entry.endsWith(` ${archiveName}`))
  if (line === undefined) throw new Error(`Node SHASUMS256.txt has no entry for ${archiveName}`)
  const expected = line.split(/\s+/u)[0]
  const actual = await sha256File(archive)
  if (actual !== expected) throw new Error(`Node archive checksum mismatch for ${archiveName}`)
  await extractTarball(archive, options.destination, { log })
  if (parsed.os === 'win') {
    if (!existsSync(path.join(options.destination, 'node.exe'))) throw new Error('Node archive did not contain node.exe')
  } else {
    const node = path.join(options.destination, 'bin', 'node')
    if (!existsSync(node)) throw new Error('Node archive did not contain bin/node')
    await chmod(node, 0o755)
  }
  return { directory: options.destination, archive, sha256: actual }
}

/**
 * Install the DSH npm package for one target into `app/`.
 * @param {{appDir: string, version: string, target: string, log?: (line: string) => void}} options install input.
 * @returns {Promise<{appDir: string, nodeModules: string}>} installed app.
 */
export async function installAppDependencies(options) {
  const parsed = parseTarget(options.target)
  const log = options.log ?? (() => {})
  await mkdir(options.appDir, { recursive: true })
  await writeFile(path.join(options.appDir, 'package.json'), JSON.stringify({
    name: 'dsh-web-offline',
    private: true,
    version: '1.0.0',
  }, null, 2), 'utf8')
  const args = [
    'install',
    `@deepseek-ai/dsh@${options.version}`,
    `--os=${parsed.os === 'win' ? 'win32' : parsed.os}`,
    `--cpu=${parsed.arch}`,
    ...(parsed.libc === '' ? [] : [`--libc=${parsed.libc}`]),
    '--ignore-scripts',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
  ]
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  log(`$ npm ${args.join(' ')}`)
  const result = await runCommand(command, args, {
    cwd: options.appDir,
    log,
    shell: process.platform === 'win32',
    timeoutMs: 45 * 60_000,
  })
  if (!result.ok) {
    throw new Error(`npm install @deepseek-ai/dsh@${options.version} failed (exit ${String(result.code)})\n${result.tail.join('\n')}`)
  }
  return { appDir: options.appDir, nodeModules: path.join(options.appDir, 'node_modules') }
}

/**
 * Replace the installed web frontend with the freshly built one.
 * @param {{appDir: string, dist: string, log?: (line: string) => void}} options overlay input.
 * @returns {Promise<string>} the replaced dist directory.
 */
export async function overlayFrontend(options) {
  const log = options.log ?? (() => {})
  const frontend = path.join(options.appDir, 'node_modules', '@deepseek-ai', 'dsh-web-frontend')
  const packageFile = path.join(frontend, 'package.json')
  if (!existsSync(packageFile)) {
    throw new Error(`cannot find @deepseek-ai/dsh-web-frontend under ${options.appDir}`)
  }
  const target = path.join(frontend, 'dist')
  await rm(target, { recursive: true, force: true })
  await cp(options.dist, target, { recursive: true })
  if (!existsSync(path.join(target, 'index.html'))) {
    throw new Error('the built web frontend has no index.html after the copy')
  }
  log(`frontend installed at ${target}`)
  return target
}

/**
 * Apply the shipped-bundle patches to the client plugin packages inside an
 * installed app.
 *
 * `pnpm run build:web` builds the web shell (`apps/web`), while the directory
 * picker and account menu are separate client plugin bundles. The repository's
 * `code/gate/patch-picker.mjs` / `patch-login.mjs` are the authoritative
 * built-bundle equivalents of the source overlays; applying them here means a
 * package carries the UI even when only the shell was rebuilt from source.
 *
 * @param {{appDir: string, repositoryRoot: string, log?: (line: string) => void}} options patch input.
 * @returns {Promise<{picker: string, login: string}>} patched files.
 */
export async function patchInstalledClient(options) {
  const log = options.log ?? (() => {})
  const picker = path.join(
    options.appDir,
    'node_modules',
    '@deepseek-ai',
    'dsh-client-ui-directory-picker-browse',
    'lib',
    'client.js',
  )
  const login = path.join(
    options.appDir,
    'node_modules',
    '@deepseek-ai',
    'dsh-client-ui-settings-account',
    'lib',
    'client.js',
  )
  for (const file of [picker, login]) {
    if (!existsSync(file)) throw new Error(`installed client bundle is missing: ${file}`)
  }
  const steps = [
    { file: picker, script: path.join(options.repositoryRoot, 'code', 'gate', 'patch-picker.mjs'), marker: 'dsh-picker-patched' },
    { file: login, script: path.join(options.repositoryRoot, 'code', 'gate', 'patch-login.mjs'), marker: 'dsh-gate-account-login' },
  ]
  for (const step of steps) {
    log(`patching ${path.basename(path.dirname(path.dirname(step.file)))} client bundle`)
    const result = await runCommand(process.execPath, [step.script, step.file], {
      cwd: options.repositoryRoot,
      log,
      timeoutMs: 120_000,
    })
    if (!result.ok) throw new Error(`client bundle patch failed: ${step.script}\n${result.tail.join('\n')}`)
    const text = await readFile(step.file, 'utf8')
    if (!text.includes(step.marker)) throw new Error(`client bundle patch did not leave its marker: ${step.file}`)
    await rm(`${step.file}.orig`, { force: true })
  }
  return { picker, login }
}

/**
 * Full target package: web payload, gate, plugin, npm app, and Node runtime.
 * This is the package the install scripts expect.
 * @param {{dist: string, target: string, outputDir: string, version: string, dshVersion: string, repositoryRoot: string, source: string, ref: string, tree: string|null, nodeVersion: string, cacheDir: string, fetchImpl?: typeof fetch, log?: (line: string) => void}} options package input.
 * @returns {Promise<{packageDir: string, manifest: object}>} package.
 */
export async function assembleRuntimePackage(options) {
  const log = options.log ?? (() => {})
  const { packageDir, manifest } = await assembleWebPackage(options)
  const appDir = path.join(packageDir, 'app')
  await mkdir(appDir, { recursive: true })
  await installAppDependencies({
    appDir,
    version: options.dshVersion,
    target: options.target,
    log,
  })
  await patchInstalledClient({ appDir, repositoryRoot: options.repositoryRoot, log })
  await overlayFrontend({ appDir, dist: options.dist, log })
  await installNodeRuntime({
    version: options.nodeVersion,
    target: options.target,
    cacheDir: options.cacheDir,
    destination: path.join(packageDir, 'runtime', 'node'),
    fetchImpl: options.fetchImpl,
    log,
  })
  for (const file of ['install.ps1', 'start.ps1', 'stop.ps1', 'start.cmd', 'stop.cmd']) {
    await copyIfExists(path.join(options.repositoryRoot, 'code', file), path.join(packageDir, file))
  }
  await writeFile(path.join(packageDir, '.offline-payload'), 'dsh-person-web\n', 'utf8')
  await writeFile(path.join(packageDir, 'VERSION'), `${options.dshVersion}\n`, 'utf8')
  const updated = {
    ...manifest,
    kind: 'offline-runtime',
    dshVersion: options.dshVersion,
    nodeVersion: options.nodeVersion,
    files: (await listFiles(packageDir)).length,
  }
  await writeFile(path.join(packageDir, 'manifest.json'), JSON.stringify(updated, null, 2), 'utf8')
  return { packageDir, manifest: updated }
}
