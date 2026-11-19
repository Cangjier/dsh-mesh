/**
 * Deterministic build engine for the modified DSH web edition.
 *
 * The engine never calls a model. It prepares a source tree, applies pinned
 * overlays, runs the web build, and packages the result. When an overlay no
 * longer matches upstream it stops and writes a work order for the calling DSH
 * to hand to a subagent; `learn` turns the corrected worktree back into an
 * overlay for the next run.
 *
 * @module dsh-mesh/build/engine
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, cp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import os from 'node:os'
import path from 'node:path'
import { archiveThreads, createTarGz } from './archive.mjs'
import {
  appCacheDir,
  appCacheMetaFile,
  cloneTree,
  readAppCache,
  writeAppCacheMeta,
  readWebCache,
  writeWebCache,
} from './cache.mjs'
import { collectStaticAssets } from './static-assets.mjs'
import { createProxyFetch, proxyEnv } from './proxy.mjs'

/** Fixed upstream repository. */
export const DEFAULT_SOURCE = 'https://github.com/deepseek-ai/deepseek-harness'

/** Default branch of the upstream repository. */
export const DEFAULT_REF = 'master'

/** Default target matrix. */
export const DEFAULT_TARGETS = Object.freeze(['linux-x64', 'win-x64'])

/**
 * Where build downloads and caches live when a caller names no directory.
 * `job.mjs` exports the same layout; the engine keeps its own copy so the two
 * modules do not have to import each other.
 * @returns {string} absolute directory.
 */
function defaultCacheDir() {
  return path.join(os.homedir(), '.dsh', 'mesh', 'cache')
}

/**
 * The fetch and environment a build needs for one outbound proxy.
 *
 * Both halves matter: `fetchImpl` carries the source tarball and the Node
 * runtime, while `env` carries npm and pnpm. A caller that omits `proxy` gets
 * the global fetch and an unchanged environment.
 * @param {{proxy?: string|null, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch}} options build options.
 * @returns {{fetchImpl: typeof fetch|undefined, env: NodeJS.ProcessEnv|undefined, proxy: string|null}} resolved pieces.
 */
export function proxyFor(options = {}) {
  const proxy = typeof options.proxy === 'string' && options.proxy.trim() !== '' ? options.proxy.trim() : null
  if (proxy === null) return { fetchImpl: options.fetchImpl, env: options.env, proxy: null }
  return {
    fetchImpl: options.fetchImpl ?? createProxyFetch(proxy),
    env: proxyEnv(proxy, options.env ?? process.env),
    proxy,
  }
}

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
 * The ETag of the tarball a branch/tag currently points at.
 *
 * A HEAD to codeload is the cheap, authentication-free update check: it uses
 * the same host and URL candidates as the real download, and the ETag changes
 * whenever the branch content does. A 40-hex commit is immutable, so its ETag
 * is only informational.
 * @param {string} source repository URL or local directory.
 * @param {string} ref branch, tag, or commit.
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, log?: (line: string) => void}} [options] request options.
 * @returns {Promise<string|null>} ETag without quotes, or null when unavailable.
 */
export async function remoteRevision(source, ref, options = {}) {
  let classified
  try {
    classified = classifySource(source)
  } catch {
    return null
  }
  if (classified.kind !== 'github') return null
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    for (const url of tarballUrls(classified, ref)) {
      try {
        const response = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal })
        if (response.status === 404) continue
        if (!response.ok) return null
        const etag = typeof response.headers?.get === 'function' ? response.headers.get('etag') : null
        if (typeof etag === 'string' && etag.trim() !== '') return etag.replace(/^W\//u, '').replaceAll('"', '').trim()
        return null
      } catch {
        return null
      }
    }
    return null
  } finally {
    clearTimeout(timer)
  }
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
  const cacheDir = options.cacheDir ?? path.join(os.homedir(), '.dsh', 'mesh', 'cache')
  const urls = tarballUrls(classified, ref)
  const archive = path.join(cacheDir, 'sources', `${sha256Text(`${classified.owner}/${classified.repo}@${ref}`).slice(0, 16)}.tar.gz`)
  const etagFile = `${archive}.etag`
  const immutable = /^[0-9a-f]{40}$/iu.test(ref)
  // A branch or tag can move. Compare the cached tarball's recorded ETag with
  // the branch's current one, so a scheduled build forced by an update never
  // reuses yesterday's source. An explicit commit is immutable.
  const remoteEtag = immutable ? null : await remoteRevision(source, ref, { fetchImpl: options.fetchImpl, log })
  let cachedEtag = ''
  if (!immutable && existsSync(etagFile)) {
    try {
      cachedEtag = (await readFile(etagFile, 'utf8')).trim()
    } catch {
      cachedEtag = ''
    }
  }
  if (!immutable && existsSync(archive)) {
    const age = Date.now() - (await stat(archive)).mtimeMs
    const staleContent = remoteEtag !== null && cachedEtag !== remoteEtag
    if (staleContent || age > (options.maxCacheAgeMs ?? 6 * 60 * 60_000)) {
      log(staleContent
        ? `refreshing cached tarball for ${ref} (remote content changed)`
        : `refreshing cached tarball for ${ref} (older than the cache window)`)
      await rm(archive, { force: true })
    }
  }
  let downloaded = false
  for (const url of urls) {
    downloaded = await download(url, archive, { fetchImpl: options.fetchImpl, log })
    if (downloaded) break
  }
  if (!downloaded) throw new Error(`cannot find ref "${ref}" in ${classified.owner}/${classified.repo}`)
  if (remoteEtag !== null) {
    try {
      await writeFile(etagFile, `${remoteEtag}\n`, 'utf8')
    } catch {
      // A cache hint that cannot be written only costs one extra download.
    }
  }
  const archiveSha256 = await sha256File(archive)
  const dir = path.join(options.workDir, 'src')
  log(`extracting ${path.basename(archive)} to ${dir}`)
  await extractTarball(archive, dir, { log })
  return { dir, source, ref, local: false, archive, archiveSha256, archiveEtag: remoteEtag }
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
    `你在为 dsh-mesh 构建 ${options.source}@${options.ref} 的修改版 Web 包。`,
    '确定性构建在应用源码覆盖层时失败。请只修复工作树里的源码，不要放宽覆盖层校验。',
    '先读 work-order.md 与对应的 Step 文档，再修改下列文件，使每个文件的覆盖层 marker 存在，并让 pnpm run build:web 通过。',
    `修完后调用 dsh-mesh 的 build 工具，并传 jobId="${path.basename(jobDir)}"；它会自动把修改固化成覆盖层并继续同一个 job。`,
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
    '2. 保持覆盖层 marker 注释存在：picker 是 `dsh-mesh overlay: picker`，login 是 `dsh-mesh overlay: login`。',
    `3. 调用 build 工具，参数 \`jobId="${path.basename(jobDir)}"\`；它会把改好的文件写回 \`build/overlays/\`。`,
    '4. 同一次 build 调用会复用工作树继续 install/build/package；下一次同一 ref 会直接应用新覆盖层。',
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
 * Whether a command must go through the shell.
 *
 * Windows package managers are `.cmd` shims, and Node can only run those
 * through the shell. A plain executable such as `node` must not, or a path
 * containing spaces loses its quoting.
 * @param {string} command executable name.
 * @returns {boolean} true when spawn should use a shell.
 */
function needsShell(command) {
  return process.platform === 'win32' && /^(pnpm|npm|npx|yarn|corepack)(\.cmd)?$/iu.test(command)
}

/**
 * Build the workspace packages the web frontend imports as build output.
 *
 * `apps/web` now imports `@deepseek-ai/dsh-experimental-webworker-runtime/worker`,
 * whose `exports` point at `lib/*.js` — files produced by that package's own
 * `tsdown` run, not by `vite build`. Upstream's `build:web` script does not
 * build them, so a clean source tree fails with "Rollup failed to resolve
 * import ... /worker?worker". The fix upstream itself uses in `build:preview`
 * is to run `tsdown` in those packages first; this does the same, and skips a
 * package that does not exist in older refs.
 * @param {{dir: string, log?: (line: string) => void, env?: NodeJS.ProcessEnv}} options input.
 * @returns {Promise<{ok: boolean, error?: string, built: string[]}>} outcome.
 */
export async function buildWebWorkerPackages(options) {
  const log = options.log ?? (() => {})
  const built = []
  for (const name of ['@deepseek-ai/dsh-experimental-webworker-runtime', '@deepseek-ai/dsh-experimental-webworker-packer']) {
    const packageDir = path.join(options.dir, 'packages', 'experimental', name.replace('@deepseek-ai/dsh-experimental-', ''))
    if (!existsSync(packageDir)) {
      log(`skipping ${name}: not in this revision`)
      continue
    }
    log(`$ pnpm --filter ${name} exec tsdown`)
    const result = await runCommand('pnpm', ['--filter', name, 'exec', 'tsdown'], {
      cwd: options.dir,
      log,
      env: options.env,
      shell: needsShell('pnpm'),
      timeoutMs: 10 * 60_000,
    })
    if (!result.ok) {
      return { ok: false, built, error: `building ${name} failed (exit ${String(result.code)})\n${result.tail.join('\n')}` }
    }
    built.push(name)
  }
  return { ok: true, built }
}

/**
 * Run the web build.
 *
 * A source revision builds the same shell every time, and a rebuild of the same
 * commit is the normal case. With `cacheDir` and `cacheKey` (built by `cache.mjs`) a previously built `apps/web/dist` is reused and the
 * whole `pnpm install` + TypeScript project builds + `vite build` chain is
 * skipped. The cache key covers the source bytes, the overlays, the recipe
 * commands, and the platform, so a changed input cannot hit a stale shell.
 * @param {{dir: string, log?: (line: string) => void, install?: string[]|null, build?: string[], prepare?: string[][]|null, env?: NodeJS.ProcessEnv, prebuild?: boolean, cacheDir?: string|null, cacheKey?: string|null, cacheMeta?: object, refreshCache?: boolean, onProgress?: (update: {phase: string, percent: number}) => void|Promise<void>}} options build input.
 * @returns {Promise<{ok: boolean, dist: string|null, cached?: boolean, error?: string}>} outcome.
 */
export async function runWebBuild(options) {
  const log = options.log ?? (() => {})
  const progress = async (phase, percent) => { await options.onProgress?.({ phase, percent }) }
  const install = options.install === undefined ? ['pnpm', 'install', '--frozen-lockfile'] : options.install
  const build = options.build ?? ['pnpm', 'run', 'build:web']
  const cacheDir = typeof options.cacheDir === 'string' && options.cacheDir !== '' ? options.cacheDir : null
  const cacheKey = typeof options.cacheKey === 'string' && options.cacheKey !== '' ? options.cacheKey : null
  if (cacheDir !== null && cacheKey !== null && options.refreshCache !== true) {
    const cached = await readWebCache(cacheDir, cacheKey)
    if (cached !== null) {
      log(`web build cache hit ${cacheKey.slice(0, 12)}: skipping pnpm install and the web build`)
      await progress('build', 62)
      return { ok: true, dist: cached.dist, cached: true }
    }
  }
  if (install !== null && install.length > 0) {
    await progress('build', 16)
    log(`$ ${install.join(' ')}`)
    const installed = await runCommand(install[0], install.slice(1), {
      cwd: options.dir,
      log,
      env: options.env,
      shell: needsShell(install[0]),
      timeoutMs: 30 * 60_000,
    })
    if (!installed.ok) {
      return { ok: false, dist: null, error: `dependency installation failed (exit ${String(installed.code)})\n${installed.tail.join('\n')}` }
    }
    await progress('build', 40)
  }
  // A recipe can name commands that must run before the web build (a clean
  // upstream tree needs its client packages compiled first, for example).
  //
  // Those commands also build the webworker packages, so the targeted prebuild
  // is only the fallback for a recipe without a prepare step: run it first, and
  // its tsdown would look for lib/types/*.js that nothing has compiled yet.
  const prepareCommands = options.prepare ?? []
  if (options.prebuild !== false && prepareCommands.length === 0) {
    const prepared = await buildWebWorkerPackages({ dir: options.dir, log, env: options.env })
    if (!prepared.ok) return { ok: false, dist: null, error: prepared.error ?? 'webworker prebuild failed' }
  }
  for (const command of prepareCommands) {
    if (command.length === 0) continue
    log(`$ ${command.join(' ')}`)
    const prepared = await runCommand(command[0], command.slice(1), {
      cwd: options.dir,
      log,
      env: options.env,
      shell: needsShell(command[0]),
      timeoutMs: 60 * 60_000,
    })
    if (!prepared.ok) {
      return { ok: false, dist: null, error: `prepare step failed (exit ${String(prepared.code)}): ${command.join(' ')}\n${prepared.tail.join('\n')}` }
    }
  }
  await progress('build', 50)
  log(`$ ${build.join(' ')}`)
  const built = await runCommand(build[0], build.slice(1), {
    cwd: options.dir,
    log,
    env: options.env,
    shell: needsShell(build[0]),
    timeoutMs: 30 * 60_000,
  })
  if (!built.ok) {
    return { ok: false, dist: null, error: `web build failed (exit ${String(built.code)})\n${built.tail.join('\n')}` }
  }
  await progress('build', 62)
  const candidates = [
    path.join(options.dir, 'apps', 'web', 'dist'),
    path.join(options.dir, 'dist'),
  ]
  for (const candidate of candidates) {
    if (!existsSync(path.join(candidate, 'index.html'))) continue
    if (cacheDir !== null && cacheKey !== null) {
      // A cache write is an optimisation: it must never fail a good build.
      await writeWebCache({
        cacheDir,
        key: cacheKey,
        dist: candidate,
        meta: options.cacheMeta ?? {},
        log,
      })
    }
    return { ok: true, dist: candidate, cached: false }
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

/** Files and directories that make one dsh-mesh build (plugin + package payload). */
const PLUGIN_FINGERPRINT_FILES = [
  'package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'VERSION',
  'start-interop.sh', 'install-interop-service.sh', 'uninstall-interop-service.sh',
  'install.sh', 'install.ps1',
  // The stable launcher and its pointer live at the layout root; a package
  // that lacks them cannot be installed in the pointer layout.
  'dsh-mesh.mjs',
]
const PLUGIN_FINGERPRINT_DIRS = ['locale', 'build', 'docs', 'code']

/**
 * Content hash of the dsh-mesh plugin that a build would copy.
 *
 * The scheduled build compares this with the fingerprint recorded in the last
 * successful package; a rebuilt client or a changed build recipe therefore
 * counts as a dsh-mesh update even when package.json's version did not move.
 * @param {string} repositoryRoot plugin root.
 * @returns {Promise<string>} hex digest.
 */
export async function pluginFingerprint(repositoryRoot) {
  const files = []
  for (const name of PLUGIN_FINGERPRINT_FILES) {
    if (existsSync(path.join(repositoryRoot, name))) files.push(name)
  }
  for (const dir of PLUGIN_FINGERPRINT_DIRS) {
    for (const rel of await listFiles(path.join(repositoryRoot, dir))) files.push(path.join(dir, rel))
  }
  files.sort()
  const hash = createHash('sha256')
  for (const rel of files) {
    hash.update(rel)
    hash.update('\0')
    hash.update(await sha256File(path.join(repositoryRoot, rel)))
    hash.update('\n')
  }
  return hash.digest('hex')
}

/**
 * Read the plugins that every package carries besides dsh-mesh itself.
 *
 * The list lives in `build/plugins.json` so a build stays reproducible from the
 * repository alone: adding a plugin is a data change, not a code change.
 * @param {string} repositoryRoot package root.
 * @returns {Promise<Array<{name: string, dir: string, repo: string, ref: string}>>} plugin entries.
 */
export async function readExtraPlugins(repositoryRoot) {
  const file = path.join(repositoryRoot, 'build', 'plugins.json')
  if (!existsSync(file)) return []
  const parsed = JSON.parse(await readFile(file, 'utf8'))
  const list = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.plugins) ? parsed.plugins : []
  return list
    .filter(entry => entry !== null && typeof entry === 'object')
    .map(entry => ({
      name: typeof entry.name === 'string' ? entry.name.trim() : '',
      dir: typeof entry.dir === 'string' && entry.dir.trim() !== '' ? entry.dir.trim() : '',
      repo: typeof entry.repo === 'string' ? entry.repo.trim() : '',
      ref: typeof entry.ref === 'string' && entry.ref.trim() !== '' ? entry.ref.trim() : 'main',
    }))
    .filter(entry => entry.name !== '' && entry.repo !== '')
    .map(entry => ({ ...entry, dir: entry.dir !== '' ? entry.dir : path.join('plugins', entry.name) }))
}

/** Serialises {@link copyExtraPlugins} calls inside one build process. */
let extraPluginsGate = Promise.resolve()

/**
 * Download every extra plugin and copy it into the package.
 *
 * Branch refs are re-downloaded on every build (the point is to ship the
 * current main), a 40-hex ref is immutable and therefore also safe to refetch.
 * The archive hash goes into the manifest next to dsh-mesh's own source hash.
 * @param {{packageDir: string, repositoryRoot: string, cacheDir?: string, fetchImpl?: typeof fetch, log?: (line: string) => void}} options copy input.
 * @returns {Promise<object[]>} manifest records.
 */
export async function copyExtraPlugins(options) {
  // Targets are packaged concurrently now, and every one of them fetches the
  // same plugin tarball into the same cache path. The download rewrites that
  // file (and its `.part` sibling), so the fetches are serialised instead of
  // racing each other.
  const run = extraPluginsGate.then(() => copyExtraPluginsOnce(options))
  extraPluginsGate = run.then(() => {}, () => {})
  return run
}

/**
 * Download and copy the extra plugins once; callers must go through
 * {@link copyExtraPlugins} so concurrent targets cannot race the cache file.
 * @param {{packageDir: string, repositoryRoot: string, cacheDir?: string, fetchImpl?: typeof fetch, log?: (line: string) => void}} options copy input.
 * @returns {Promise<object[]>} manifest records.
 */
async function copyExtraPluginsOnce(options) {
  const plugins = await readExtraPlugins(options.repositoryRoot)
  if (plugins.length === 0) return []
  const cacheDir = options.cacheDir ?? defaultCacheDir()
  const log = options.log ?? (() => {})
  const records = []
  for (const plugin of plugins) {
    const classified = classifySource(plugin.repo)
    if (classified.kind !== 'github') {
      throw new Error(`extra plugin ${plugin.name} must be a github.com repository, not ${plugin.repo}`)
    }
    const archive = path.join(cacheDir, 'plugins', `${plugin.name}.tar.gz`)
    await mkdir(path.dirname(archive), { recursive: true })
    await rm(archive, { force: true })
    let downloaded = false
    for (const url of tarballUrls(classified, plugin.ref)) {
      downloaded = await download(url, archive, { fetchImpl: options.fetchImpl, log })
      if (downloaded) break
    }
    if (!downloaded) {
      throw new Error(`cannot download extra plugin ${plugin.name} from ${plugin.repo}@${plugin.ref}`)
    }
    const tree = path.join(cacheDir, 'plugins', `${plugin.name}-tree`)
    await rm(tree, { recursive: true, force: true })
    await extractTarball(archive, tree, { log })
    const target = path.join(options.packageDir, plugin.dir)
    await rm(target, { recursive: true, force: true })
    await mkdir(path.dirname(target), { recursive: true })
    await cp(tree, target, { recursive: true })
    await rm(tree, { recursive: true, force: true })
    records.push({
      name: plugin.name,
      dir: plugin.dir,
      repo: plugin.repo,
      ref: plugin.ref,
      archiveSha256: await sha256File(archive),
      archiveEtag: await remoteRevision(plugin.repo, plugin.ref, { fetchImpl: options.fetchImpl, log }),
    })
    log(`extra plugin ${plugin.name}@${plugin.ref} -> ${plugin.dir}`)
  }
  return records
}

/**
 * Assemble one target package without downloading runtimes yet. This is the
 * deterministic half of packaging; the runtime/app layer is added by
 * `assembleRuntimePackage`.
 * @param {{dist: string, target: string, outputDir: string, version: string, buildStamp?: string|null, repositoryRoot: string, source?: string, ref?: string, tree?: string|null, sourceEtag?: string|null, pluginVersion?: string|null, pluginFingerprint?: string|null, fetchImpl?: typeof fetch, log?: (line: string) => void}} options package input.
 * @returns {Promise<{packageDir: string, manifest: object}>} package directory and manifest.
 */
export async function assembleWebPackage(options) {
  const { os: targetOs, arch, libc } = parseTarget(options.target)
  // The version segment is the DSH version and must never be rewritten. The
  // build stamp is an extra segment so two packages of the same DSH version do
  // not share a filename.
  const buildStamp = typeof options.buildStamp === 'string' && options.buildStamp !== '' ? options.buildStamp : null
  const identity = buildStamp === null ? options.version : `${options.version}-${buildStamp}`
  const packageDir = path.join(options.outputDir, `dsh-mesh-${identity}-${targetOs}-${arch}`)
  await rm(packageDir, { recursive: true, force: true })
  await mkdir(path.join(packageDir, 'web'), { recursive: true })
  await cp(options.dist, path.join(packageDir, 'web'), { recursive: true })
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'gate'), path.join(packageDir, 'gate'))
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'shared'), path.join(packageDir, 'shared'))
  // The runtime scripts under `code/` (deploy engine, target downloader) import
  // siblings from `code/shared`; every package must lay the tree out
  // that way or the deploy runner fails at
  // import time on a member.
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'shared'), path.join(packageDir, 'code', 'shared'))
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'config'), path.join(packageDir, 'config'))
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'windows-service'), path.join(packageDir, 'code', 'windows-service'))
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'interop-service'), path.join(packageDir, 'code', 'interop-service'))
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'wireguard'), path.join(packageDir, 'code', 'wireguard'))
  // The split-service supervisor: the gateway's dsh role runs it.
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'dsh-service'), path.join(packageDir, 'code', 'dsh-service'))
  // Every install and upgrade runs code/deploy/upgrade-local.mjs from the
  // package; it rewires the profile with code/deploy/wire-profile.mjs.
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'deploy'), path.join(packageDir, 'code', 'deploy'))
  // The pointer-layout installer and the stable launcher are part of the
  // package: upgrades run them from the extracted tree.
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'install'), path.join(packageDir, 'code', 'install'))
  await copyIfExists(path.join(options.repositoryRoot, 'dsh-mesh.mjs'), path.join(packageDir, 'dsh-mesh.mjs'))
  await copyIfExists(path.join(options.repositoryRoot, 'docs'), path.join(packageDir, 'docs'))
  for (const file of ['install.sh', 'install.ps1', 'VERSION']) {
    await copyIfExists(path.join(options.repositoryRoot, 'code', file), path.join(packageDir, file))
  }
  for (const file of ['start-interop.sh', 'install-interop-service.sh', 'uninstall-interop-service.sh']) {
    await copyIfExists(path.join(options.repositoryRoot, file), path.join(packageDir, file))
  }
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'package.json']) {
    await copyIfExists(path.join(options.repositoryRoot, file), path.join(packageDir, 'plugins', 'dsh-mesh', file))
  }
  await copyIfExists(path.join(options.repositoryRoot, 'locale'), path.join(packageDir, 'plugins', 'dsh-mesh', 'locale'))
  // The packaged plugin must be able to run `build_learn`/`build_resume` on a
  // deployed member, so its recipes, overlays, and build modules travel with it.
  await copyIfExists(path.join(options.repositoryRoot, 'build'), path.join(packageDir, 'plugins', 'dsh-mesh', 'build'))
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'build'), path.join(packageDir, 'plugins', 'dsh-mesh', 'code', 'build'))
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'shared'), path.join(packageDir, 'plugins', 'dsh-mesh', 'code', 'shared'))
  // The deploy runner/engine travel with the plugin too: a member that runs
  // its own panel starts `code/deploy/runner.mjs` from its plugin directory.
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'deploy'), path.join(packageDir, 'plugins', 'dsh-mesh', 'code', 'deploy'))
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'install'), path.join(packageDir, 'plugins', 'dsh-mesh', 'code', 'install'))
  // Plugins that travel with dsh-mesh (currently xl): fetched from main at build
  // time, so a package built today carries today's plugin code.
  const extraPlugins = await copyExtraPlugins({
    packageDir,
    repositoryRoot: options.repositoryRoot,
    cacheDir: options.cacheDir,
    fetchImpl: options.fetchImpl,
    log: options.log,
  })
  const staticAssets = await collectStaticAssets(path.join(options.repositoryRoot, 'code', 'gate'))
  const manifest = {
    format: 1,
    name: 'dsh-mesh',
    // Capabilities a rollback can inspect without executing the package. The
    // embedded interop moved the :8765 listener into DSH Web; a rollback to a
    // release without this feature has to start the standalone unit again.
    features: ['embedded-interop'],
    // `version` is the DSH version, unchanged. `buildStamp` is the daily
    // build revision that appears after it in the archive name.
    version: options.version,
    buildStamp,
    target: { os: targetOs, arch, libc },
    builtAt: new Date().toISOString(),
    source: options.source ?? null,
    ref: options.ref ?? null,
    tree: options.tree ?? null,
    sourceEtag: options.sourceEtag ?? null,
    plugin: {
      version: options.pluginVersion ?? null,
      fingerprint: options.pluginFingerprint ?? null,
    },
    files: (await listFiles(packageDir)).length,
    staticAssets,
    extraPlugins,
  }
  await writeFile(path.join(packageDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return { packageDir, manifest }
}

/**
 * Create a `.tar.gz` for Linux or a `.zip` for Windows.
 *
 * Linux archives are written by {@link createTarGz}: the tar is created
 * uncompressed, header modes are patched while streaming (Windows' bsdtar
 * writes every entry as 0666, which would strip the executable bit from
 * `install.sh` and the bundled node), and independent chunks are compressed on
 * worker threads. That replaces both the single-threaded `tar -czf` and the
 * old gunzip-patch-regzip pass that held the whole tree in memory.
 * @param {string} packageDir directory to archive.
 * @param {string} target target descriptor.
 * @param {{log?: (line: string) => void, threads?: number, env?: NodeJS.ProcessEnv}} [options] dependencies.
 * @returns {Promise<string>} archive path.
 */
export async function archivePackage(packageDir, target, options = {}) {
  const { os: targetOs } = parseTarget(target)
  const archive = targetOs === 'win'
    ? `${packageDir}.zip`
    : `${packageDir}.tar.gz`
  await rm(archive, { force: true })
  // Compressing a ~1 GiB package tree is one of the long silent steps; the
  // marker keeps the panel moving and says which target owns the time.
  options.log?.(`archiving ${target}`)
  if (targetOs === 'win') {
    let result
    if (process.platform !== 'win32') {
      // GNU tar cannot create a zip; a Linux build host needs the `zip` tool.
      result = await runCommand('zip', ['-qr', archive, path.basename(packageDir)], {
        cwd: path.dirname(packageDir),
        log: options.log,
      })
    } else {
      result = await runCommand('tar', ['-a', '-c', '-f', archive, '-C', path.dirname(packageDir), path.basename(packageDir)], {
        log: options.log,
      })
    }
    if (!result.ok) throw new Error(`cannot archive ${packageDir}: ${result.tail.join('\n')}`)
    return archive
  }
  try {
    await createTarGz({
      packageDir,
      destination: archive,
      // On a Windows host the tar header modes are wrong for a Linux target;
      // patching them is part of the streaming compressor now.
      patchModes: process.platform === 'win32',
      threads: options.threads ?? archiveThreads({ env: options.env }),
      log: options.log,
    })
  } catch (error) {
    throw new Error(`cannot archive ${packageDir}: ${error instanceof Error ? error.message : String(error)}`)
  }
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
  const fetchImpl = options.fetchImpl ?? fetch
  const sums = await fetchImpl(`${base}/SHASUMS256.txt`, { redirect: 'follow' })
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
 * @param {{appDir: string, version: string, target: string, env?: NodeJS.ProcessEnv, log?: (line: string) => void}} options install input.
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
    env: options.env,
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
 * Read the shape of the static module table the built web shell hands to the
 * client module loader.
 *
 * `apps/web` builds a table of `{id, factory}` descriptors and passes
 * `Object.values(...)`'s array. Older shells passed a plain `id → value`
 * record. The app's `@deepseek-ai/dsh-client-modules` has to understand the
 * same shape, otherwise `require("react")` and every other seed word miss the
 * table and the page stops at "Failed to load plugins".
 *
 * The table builder is a zero-argument function referenced from the shell's
 * `staticModules:` argument; minification keeps both halves of that link, so
 * the check follows the name instead of depending on a fixed identifier.
 * @param {string} distDir built web frontend (`index.html` + `assets/`).
 * @returns {Promise<{file: string, name: string, shape: 'array'|'record'|'unknown', hasRankByName: boolean}|null>} shell contract, or null when it cannot be found.
 */
export async function inspectShellSeedTable(distDir) {
  const index = path.join(distDir, 'index.html')
  if (!existsSync(index)) return null
  const html = await readFile(index, 'utf8')
  const sources = [...html.matchAll(/<script[^>]+src="\.?\/?([^"]+\.js)"/gu)].map(match => match[1])
  for (const relative of sources) {
    const file = path.join(distDir, relative)
    if (!existsSync(file)) continue
    const text = await readFile(file, 'utf8')
    const call = /staticModules:([A-Za-z_$][\w$]*)\(\)/u.exec(text)
    if (call === null) continue
    const name = call[1]
    const array = new RegExp(`function ${name}\\(\\)\\{return Object\\.values\\(`, 'u').test(text)
    const record = new RegExp(`function ${name}\\(\\)\\{return\\{`, 'u').test(text)
    return {
      file,
      name,
      shape: array ? 'array' : record ? 'record' : 'unknown',
      hasRankByName: text.includes('rankByName'),
    }
  }
  return null
}

/**
 * Read how the installed client module loader consumes the static module
 * table. A loader that only builds `new Map(Object.entries(...))` understands
 * a record and turns a descriptor array into the keys "0", "1", ….
 * @param {string} appDir installed package `app/`.
 * @returns {Promise<{file: string, version: string|null, recordOnly: boolean, arrayAware: boolean, providesRankByName: boolean}|null>} loader contract.
 */
export async function inspectAppModuleLoader(appDir) {
  const root = path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh-client-modules')
  const file = path.join(root, 'lib', 'client.js')
  if (!existsSync(file)) return null
  const text = await readFile(file, 'utf8')
  let version = null
  try {
    version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version ?? null
  } catch {
    version = null
  }
  return {
    file,
    version,
    recordOnly: /new Map\(Object\.entries\(options\.staticModules\)/u.test(text),
    arrayAware: /Array\.isArray\(options\.staticModules\)/u.test(text) || /options\.staticModules\.map\(/u.test(text),
    // A recovery patch (data/seed-patch on an affected install) adds the
    // missing export to the loader itself; the shell then does not need it.
    providesRankByName: text.includes('rankByName'),
  }
}

/**
 * Find an installed client bundle that uses one named export at runtime.
 *
 * The client plugins live in the app, but the copy of a shared module they
 * import comes from the shell's static table. A shell built from a different
 * DSH revision can therefore be missing an export the app's plugins call even
 * when both sides load fine on their own.
 * @param {string} appDir installed package `app/`.
 * @param {string} exportName identifier to look for.
 * @returns {Promise<string|null>} the first package that uses it.
 */
async function findClientBundleUsing(appDir, exportName) {
  const scope = path.join(appDir, 'node_modules', '@deepseek-ai')
  if (!existsSync(scope)) return null
  const entries = await readdir(scope, { withFileTypes: true }).catch(() => [])
  const pattern = new RegExp(`\\.${exportName}\\b`, 'u')
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // The provider and the loader itself are not consumers of the export.
    if (entry.name === 'dsh-client-ui-primitives' || entry.name === 'dsh-client-modules') continue
    const file = path.join(scope, entry.name, 'lib', 'client.js')
    if (!existsSync(file)) continue
    const text = await readFile(file, 'utf8').catch(() => '')
    if (pattern.test(text)) return entry.name
  }
  return null
}

/**
 * Refuse a package whose source-built shell and npm-installed app come from
 * different DSH revisions.
 *
 * This is the failure that made a 2026-11-16 build install and pass
 * `/__gate/health` while every browser saw "Failed to load plugins": the shell
 * came from source `master` (descriptor-array seed table), the app came from
 * the published npm package (record-only seed table, and client plugins that
 * already imported `rankByName` the shell's bundled primitives did not have).
 * The browser smoke test is the definitive check, but it can be skipped on a
 * build host that cannot run the target; this check needs no browser and fails
 * the build before the archive is kept.
 * @param {{appDir: string, dist: string, log?: (line: string) => void}} options contract input.
 * @returns {Promise<{shell: object, loader: object}>} the inspected contracts.
 */
export async function checkFrontendAppContract(options) {
  const log = options.log ?? (() => {})
  const shell = await inspectShellSeedTable(options.dist)
  if (shell === null) {
    log('frontend/app contract check: the shell static module table was not found; skipped')
    return { shell: null, loader: null }
  }
  const loader = await inspectAppModuleLoader(options.appDir)
  if (loader === null) {
    throw new Error('frontend/app contract check: app/node_modules/@deepseek-ai/dsh-client-modules is missing')
  }
  const version = loader.version === null ? '' : `@${loader.version}`
  if (shell.shape === 'array' && loader.recordOnly && !loader.arrayAware) {
    throw new Error(
      `the built web shell passes staticModules as a descriptor array, but @deepseek-ai/dsh-client-modules${version} in app/ only accepts a record ` +
      '(`new Map(Object.entries(options.staticModules))`). The source tree is ahead of the npm DSH app it is packaged with; ' +
      'every client plugin would fail with "Failed to load plugins". Pin --ref to the release commit of this DSH version ' +
      '(or build app/ from the same source tree) and rebuild.',
    )
  }
  if (!shell.hasRankByName && !loader.providesRankByName) {
    const user = await findClientBundleUsing(options.appDir, 'rankByName')
    if (user !== null) {
      throw new Error(
        `the installed client plugin ${user} calls rankByName from @deepseek-ai/dsh-client-ui-primitives, but the built web shell's bundled copy ` +
        'does not export it. The source tree and the npm DSH app are from different revisions; pin --ref to the release commit ' +
        'of this DSH version (or build app/ from the same source tree) and rebuild.',
      )
    }
  }
  log(`frontend/app contract check: seed table ${shell.shape}, loader${version} ${loader.recordOnly && !loader.arrayAware ? 'record-only' : 'array-aware'}`)
  return { shell, loader }
}

/**
 * Pick the frontend a package will actually serve.
 *
 * The source-built shell is preferred, but it is only usable when it agrees
 * with the npm app it is packaged with. When it does not, keep the frontend
 * that shipped inside the app: that pair is consistent by construction and the
 * directory-picker/account overlays still reach the package through
 * `patchInstalledClient`, which patches the app's client bundles, not the
 * shell. The alternative — shipping a shell the app's loader cannot read — is
 * the 2026-11-16 failure.
 *
 * A published frontend is not accepted blindly: it goes through the same
 * contract check, so a genuinely broken app still fails the build.
 * @param {{appDir: string, dist: string, log?: (line: string) => void}} options candidate input.
 * @returns {Promise<{source: 'built'|'published', dist: string, reason: string|null}>} chosen frontend.
 */
export async function chooseFrontend(options) {
  const log = options.log ?? (() => {})
  try {
    await checkFrontendAppContract({ appDir: options.appDir, dist: options.dist, log })
    return { source: 'built', dist: options.dist, reason: null }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log(`source-built frontend is incompatible with app/: ${reason}`)
    const published = path.join(options.appDir, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist')
    if (!existsSync(path.join(published, 'index.html'))) throw error
    log('keeping the published frontend from app/ (its client bundles match by construction); the UI overlays still apply through patchInstalledClient')
    await checkFrontendAppContract({ appDir: options.appDir, dist: published, log })
    return { source: 'published', dist: published, reason }
  }
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
 * Format of the cached app tree. Bump when the install or patch semantics
 * change, so an old cache cannot silently keep a stale tree.
 */
export const APP_CACHE_FORMAT = 1

/**
 * Hash the client-bundle patch scripts that are applied to a cached app.
 *
 * The app cache is keyed by DSH version and target, but the picker/login
 * patches come from this repository and change with it. Without them in the
 * key, editing a patch would keep serving the old patched bundle for the same
 * DSH version.
 * @param {string} repositoryRoot dsh-mesh root.
 * @returns {Promise<string>} hex digest.
 */
export async function patchBundleFingerprint(repositoryRoot) {
  const hash = createHash('sha256')
  hash.update(`format:${String(APP_CACHE_FORMAT)}`)
  for (const name of ['patch-picker.mjs', 'patch-login.mjs']) {
    hash.update(`\0${name}\0`)
    try {
      hash.update(await readFile(path.join(repositoryRoot, 'code', 'gate', name)))
    } catch {
      hash.update('missing')
    }
  }
  return hash.digest('hex')
}

/**
 * Install (or reuse) the npm app tree for one DSH version and target.
 *
 * `npm install @deepseek-ai/dsh` resolves a tree of ~1.4k packages and downloads
 * several hundred MiB. That tree depends only on the exact version and the
 * target platform, not on the dsh-mesh plugin or the source commit, so it is
 * cached under `<cacheDir>/app/<version>-<target>/` with the picker/login
 * patches already applied. A rebuild of the same version then costs a hard-link
 * clone instead of another npm run.
 *
 * The cache is a snapshot, never the tree a package ships: {@link materializeApp}
 * clones it, so overlaying the frontend or deleting a job cannot corrupt it.
 * @param {{cacheDir?: string|null, version: string, target: string, repositoryRoot: string, env?: NodeJS.ProcessEnv, log?: (line: string) => void, refresh?: boolean}} options input.
 * @returns {Promise<{dir: string, meta: object, cached: boolean}>} cached app tree.
 */
export async function ensureAppCache(options) {
  const log = options.log ?? (() => {})
  if (typeof options.cacheDir !== 'string' || options.cacheDir === '') {
    throw new Error('ensureAppCache needs a cacheDir')
  }
  const patchFingerprint = await patchBundleFingerprint(options.repositoryRoot)
  if (options.refresh !== true) {
    const cached = await readAppCache(options.cacheDir, options.version, options.target)
    if (cached !== null && cached.patchFingerprint === patchFingerprint) {
      log(`app cache hit ${options.target} (@deepseek-ai/dsh@${options.version})`)
      return { dir: appCacheDir(options.cacheDir, options.version, options.target), meta: cached, cached: true }
    }
    if (cached !== null) log(`app cache stale ${options.target}: the client patch scripts changed; reinstalling`)
  }
  const dir = appCacheDir(options.cacheDir, options.version, options.target)
  log(`app cache miss ${options.target}: installing @deepseek-ai/dsh@${options.version}`)
  await rm(dir, { recursive: true, force: true })
  await rm(appCacheMetaFile(options.cacheDir, options.version, options.target), { force: true })
  await installAppDependencies({
    appDir: dir,
    version: options.version,
    target: options.target,
    env: options.env,
    log,
  })
  await patchInstalledClient({ appDir: dir, repositoryRoot: options.repositoryRoot, log })
  const meta = {
    format: APP_CACHE_FORMAT,
    version: options.version,
    target: options.target,
    patchFingerprint,
    installedAt: new Date().toISOString(),
    npm: process.env.npm_config_user_agent ?? null,
    node: process.versions.node,
  }
  await writeAppCacheMeta({
    cacheDir: options.cacheDir,
    version: options.version,
    target: options.target,
    meta,
    log,
  })
  log(`app cache stored ${options.target}`)
  return { dir, meta, cached: false }
}

/**
 * Put the app tree for one target into a package directory.
 *
 * With a cache dir this is a clone of the cached tree; without one (the
 * prebuilt-package tool, unit tests) it falls back to a direct npm install,
 * which is the behaviour every caller had before the cache existed.
 * @param {{cacheDir?: string|null, version: string, target: string, appDir: string, repositoryRoot: string, env?: NodeJS.ProcessEnv, log?: (line: string) => void, refresh?: boolean}} options input.
 * @returns {Promise<{cached: boolean, meta: object|null}>} how the app was produced.
 */
export async function materializeApp(options) {
  const log = options.log ?? (() => {})
  if (typeof options.cacheDir !== 'string' || options.cacheDir === '') {
    await installAppDependencies({
      appDir: options.appDir,
      version: options.version,
      target: options.target,
      env: options.env,
      log,
    })
    await patchInstalledClient({ appDir: options.appDir, repositoryRoot: options.repositoryRoot, log })
    return { cached: false, meta: null }
  }
  const cached = await ensureAppCache({ ...options, log })
  await cloneTree(cached.dir, options.appDir, { log })
  return { cached: true, meta: cached.meta }
}

/**
 * Full target package: web payload, gate, plugin, npm app, and Node runtime.
 * This is the package the install scripts expect.
 * @param {{dist: string, target: string, outputDir: string, version: string, buildStamp?: string|null, dshVersion: string, repositoryRoot: string, source: string, ref: string, tree: string|null, nodeVersion: string, cacheDir: string, fetchImpl?: typeof fetch, log?: (line: string) => void}} options package input.
 * @returns {Promise<{packageDir: string, manifest: object}>} package.
 */
export async function assembleRuntimePackage(options) {
  const log = options.log ?? (() => {})
  const { packageDir, manifest } = await assembleWebPackage(options)
  const appDir = path.join(packageDir, 'app')
  const app = await materializeApp({
    // `appCacheDir` lets a build disable the app cache while still using
    // `cacheDir` for the Node runtime and the extra plugin tarballs.
    cacheDir: options.appCacheDir === undefined ? options.cacheDir : options.appCacheDir,
    version: options.dshVersion,
    target: options.target,
    appDir,
    repositoryRoot: options.repositoryRoot,
    env: options.env,
    log,
    refresh: options.refreshAppCache,
  })
  // The source-built shell and the npm app must agree on the client module
  // contract; a mismatch installs, starts, passes health, and then shows
  // "Failed to load plugins" in every browser. Prefer the built shell when it
  // agrees, keep the app's own published frontend when it does not, and never
  // ship a pair that disagrees.
  const frontend = await chooseFrontend({ appDir, dist: options.dist, log })
  if (frontend.source === 'built') {
    await overlayFrontend({ appDir, dist: frontend.dist, log })
  } else {
    // `web/` was copied from the source build before the app was installed;
    // point it at the frontend the app will actually serve so a rollback or a
    // manual inspection does not find a shell nobody uses.
    const web = path.join(packageDir, 'web')
    await rm(web, { recursive: true, force: true })
    await cp(frontend.dist, web, { recursive: true })
  }
  // The runtime download/extract is silent for up to two minutes per target;
  // the marker is what a remote build maps onto that target's archive stage.
  log(`node runtime ${options.target}`)
  await installNodeRuntime({
    version: options.nodeVersion,
    target: options.target,
    cacheDir: options.cacheDir,
    destination: path.join(packageDir, 'runtime', 'node'),
    fetchImpl: options.fetchImpl,
    log,
  })
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'install.sh'), path.join(packageDir, 'install.sh'))
  await copyIfExists(path.join(options.repositoryRoot, 'code', 'install.ps1'), path.join(packageDir, 'install.ps1'))
  await writeFile(path.join(packageDir, '.offline-payload'), 'dsh-mesh\n', 'utf8')
  await writeFile(path.join(packageDir, 'VERSION'), `${options.dshVersion}\n`, 'utf8')
  const updated = {
    ...manifest,
    kind: 'offline-runtime',
    dshVersion: options.dshVersion,
    nodeVersion: options.nodeVersion,
    // Which shell this package serves: the freshly built one, or the one that
    // shipped in the app because the two revisions disagreed. `reason` keeps
    // the drift visible on the package instead of only in the build log.
    frontend: frontend.reason === null ? { source: frontend.source } : { source: frontend.source, reason: frontend.reason },
    // Where the installed app came from: the cache (the version and target
    // were installed before) or a fresh npm install during this build.
    app: { source: app.cached ? 'cache' : 'npm', installedAt: app.meta?.installedAt ?? null },
    files: (await listFiles(packageDir)).length,
  }
  await writeFile(path.join(packageDir, 'manifest.json'), JSON.stringify(updated, null, 2), 'utf8')
  return { packageDir, manifest: updated }
}
