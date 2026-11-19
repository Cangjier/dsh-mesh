/**
 * Build caches: the web shell one source revision produced, and the npm app
 * tree one DSH version needs for one target.
 *
 * A rebuild of the same source commit is the normal case for this project —
 * the dsh-mesh plugin changes far more often than DSH itself. Every such
 * build used to repeat the whole monorepo `pnpm install`, the TypeScript
 * project builds, the web build, and one `npm install` per target. None of
 * that work depends on the plugin, so it is cached here and keyed by the
 * inputs that actually determine it.
 *
 * The caches are self-contained directories under `<cacheDir>`:
 *
 *   web/<key>/dist          the built apps/web/dist
 *   web/<key>/meta.json     how it was produced (for a human debugging a hit)
 *   app/<version>-<os>-<arch>/<...>   the installed app tree
 *   app/<version>-<os>-<arch>.json    its metadata
 *
 * A cache entry is only ever *read*; the package's own `app/` is a clone
 * (hard links when possible) of the cached tree, so patching, overlaying the
 * frontend, or deleting a job never mutates the cache.
 *
 * @module dsh-mesh/build/cache
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, lstat, link, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, chmod, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Bump when the shape of the cached web build changes. */
export const WEB_CACHE_FORMAT = 2

/** How many web builds to keep. Each is a few megabytes. */
export const WEB_CACHE_KEEP = 4

/** How many app trees to keep. Each is ~1 GiB; old DSH versions are useless. */
export const APP_CACHE_KEEP = 3

/**
 * Normalise one target into a directory-safe slug.
 * @param {string} target target such as `linux-x64`.
 * @returns {string} slug.
 */
export function targetSlug(target) {
  return String(target).trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, '_')
}

/**
 * Directory holding one cached app tree.
 * @param {string} cacheDir cache root.
 * @param {string} version DSH version.
 * @param {string} target target name.
 * @returns {string} absolute directory.
 */
export function appCacheDir(cacheDir, version, target) {
  const versionSlug = String(version).trim().replace(/[^A-Za-z0-9._+-]+/gu, '_')
  return path.join(cacheDir, 'app', `${versionSlug}-${targetSlug(target)}`)
}

/**
 * Metadata file beside (not inside) one cached app tree.
 * @param {string} cacheDir cache root.
 * @param {string} version DSH version.
 * @param {string} target target name.
 * @returns {string} absolute file.
 */
export function appCacheMetaFile(cacheDir, version, target) {
  return `${appCacheDir(cacheDir, version, target)}.json`
}

/**
 * Directory holding one cached web build.
 * @param {string} cacheDir cache root.
 * @param {string} key cache key.
 * @returns {string} absolute directory.
 */
export function webCacheDir(cacheDir, key) {
  return path.join(cacheDir, 'web', key)
}

/**
 * Hash one directory's files as relative path + content.
 *
 * Overlays are the only source input that is not part of the DSH tarball, so
 * they must be in the web cache key: a learned overlay changes the shell.
 * @param {string} dir directory.
 * @param {import('node:crypto').Hash} hash sink.
 * @param {string} [root] top directory for relative names.
 * @returns {Promise<void>}
 */
async function hashTree(dir, hash, root = dir) {
  if (!existsSync(dir)) return
  const entries = await readdir(dir, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await hashTree(full, hash, root)
      continue
    }
    if (!entry.isFile()) continue
    hash.update(`\0file:${path.relative(root, full).split(path.sep).join('/')}\0`)
    hash.update(await readFile(full))
  }
}

/**
 * Key a web build by every input that changes its output.
 *
 * `archiveSha256` already pins the source bytes; the overlay tree, the recipe
 * file, and the commands are the rest. The platform is included because the
 * same inputs can produce slightly different bundles on Windows and Linux.
 * @param {{archiveSha256?: string|null, source?: string|null, recipesFile?: string|null, overlayRoot?: string|null, prepare?: string[][]|null, install?: string[]|null, build?: string[]|null, prebuild?: boolean}} options inputs.
 * @returns {Promise<string|null>} hex key, or null when the source is not pinned.
 */
export async function webBuildCacheKey(options) {
  const sourcePinned = typeof options.archiveSha256 === 'string' && options.archiveSha256 !== ''
  if (!sourcePinned) return null
  const hash = createHash('sha256')
  hash.update(JSON.stringify({
    format: WEB_CACHE_FORMAT,
    platform: `${process.platform}-${process.arch}`,
    node: process.versions.node,
    source: options.source ?? null,
    archiveSha256: options.archiveSha256,
    prepare: options.prepare ?? null,
    install: options.install ?? null,
    build: options.build ?? null,
    prebuild: options.prebuild !== false,
  }))
  if (typeof options.recipesFile === 'string' && existsSync(options.recipesFile)) {
    hash.update('\0recipes\0')
    hash.update(await readFile(options.recipesFile))
  }
  hash.update('\0overlays\0')
  await hashTree(options.overlayRoot ?? '', hash)
  return hash.digest('hex')
}

/**
 * Read a cached web build.
 * @param {string} cacheDir cache root.
 * @param {string} key cache key.
 * @returns {Promise<{dist: string, meta: object}|null>} cached build or null.
 */
export async function readWebCache(cacheDir, key) {
  const dir = webCacheDir(cacheDir, key)
  const dist = path.join(dir, 'dist')
  if (!existsSync(path.join(dist, 'index.html'))) return null
  let meta = {}
  try {
    meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8'))
  } catch {
    // A missing metadata file does not invalidate the outputs themselves.
  }
  return { dist, meta }
}

/**
 * Store one web build. Failures are logged, never fatal: a cache is an
 * optimisation and must not turn a good build red.
 * @param {{cacheDir: string, key: string, dist: string, meta?: object, log?: (line: string) => void}} options input.
 * @returns {Promise<boolean>} whether it was stored.
 */
export async function writeWebCache(options) {
  const log = options.log ?? (() => {})
  const dir = webCacheDir(options.cacheDir, options.key)
  const staging = `${dir}.tmp-${String(process.pid)}`
  try {
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    await cp(options.dist, path.join(staging, 'dist'), { recursive: true })
    await writeFile(path.join(staging, 'meta.json'), JSON.stringify({
      ...options.meta,
      key: options.key,
      platform: `${process.platform}-${process.arch}`,
      node: process.versions.node,
      createdAt: new Date().toISOString(),
    }, null, 2), 'utf8')
    await rm(dir, { recursive: true, force: true })
    await rename(staging, dir)
    await pruneWebCache(options.cacheDir, WEB_CACHE_KEEP, log)
    return true
  } catch (error) {
    log(`web build cache write failed (ignored): ${error instanceof Error ? error.message : String(error)}`)
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    return false
  }
}

/**
 * Delete old web builds, newest first.
 * @param {string} cacheDir cache root.
 * @param {number} keep how many to keep.
 * @param {(line: string) => void} [log] logger.
 * @returns {Promise<void>}
 */
export async function pruneWebCache(cacheDir, keep = WEB_CACHE_KEEP, log = () => {}) {
  const root = path.join(cacheDir, 'web')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  const dirs = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = path.join(root, entry.name)
    try {
      dirs.push({ full, mtime: (await stat(full)).mtimeMs })
    } catch {
      // raced with another build; ignore
    }
  }
  dirs.sort((left, right) => right.mtime - left.mtime)
  for (const stale of dirs.slice(keep)) {
    await rm(stale.full, { recursive: true, force: true }).catch(() => {})
    log(`pruned web build cache ${path.basename(stale.full)}`)
  }
}

/**
 * Read one cached app tree if it matches this version and target.
 * @param {string} cacheDir cache root.
 * @param {string} version DSH version.
 * @param {string} target target name.
 * @returns {Promise<object|null>} metadata, or null when it cannot be reused.
 */
export async function readAppCache(cacheDir, version, target) {
  const dir = appCacheDir(cacheDir, version, target)
  const metaFile = appCacheMetaFile(cacheDir, version, target)
  if (!existsSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))) return null
  try {
    const meta = JSON.parse(await readFile(metaFile, 'utf8'))
    if (meta.complete !== true) return null
    if (meta.version !== version || meta.target !== target) return null
    return meta
  } catch {
    return null
  }
}

/**
 * Store metadata for one cached app tree and prune older versions.
 * @param {{cacheDir: string, version: string, target: string, meta: object, log?: (line: string) => void}} options input.
 * @returns {Promise<void>}
 */
export async function writeAppCacheMeta(options) {
  const log = options.log ?? (() => {})
  await mkdir(path.join(options.cacheDir, 'app'), { recursive: true })
  await writeFile(appCacheMetaFile(options.cacheDir, options.version, options.target), JSON.stringify({
    ...options.meta,
    version: options.version,
    target: options.target,
    complete: true,
    createdAt: new Date().toISOString(),
  }, null, 2), 'utf8')
  await pruneAppCache(options.cacheDir, APP_CACHE_KEEP, options.target, options.version, log)
}

/**
 * Delete old app trees, newest first, never the one that was just used.
 * @param {string} cacheDir cache root.
 * @param {number} keep how many to keep.
 * @param {string} [currentTarget] target to keep regardless of age.
 * @param {string} [currentVersion] version to keep regardless of age.
 * @param {(line: string) => void} [log] logger.
 * @returns {Promise<void>}
 */
export async function pruneAppCache(cacheDir, keep = APP_CACHE_KEEP, currentTarget = '', currentVersion = '', log = () => {}) {
  const root = path.join(cacheDir, 'app')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  const dirs = []
  for (const entry of entries) {
    // Metadata files share the directory; only the trees are candidates.
    if (!entry.isDirectory()) continue
    const full = path.join(root, entry.name)
    try {
      dirs.push({ full, mtime: (await stat(full)).mtimeMs })
    } catch {
      // ignore
    }
  }
  dirs.sort((left, right) => right.mtime - left.mtime)
  const keepDir = appCacheDir(cacheDir, currentVersion, currentTarget)
  const survivors = new Set(dirs.slice(0, keep).map(entry => entry.full))
  survivors.add(keepDir)
  for (const entry of dirs) {
    if (survivors.has(entry.full)) continue
    await rm(entry.full, { recursive: true, force: true }).catch(() => {})
    await rm(`${entry.full}.json`, { force: true }).catch(() => {})
    log(`pruned app cache ${path.basename(entry.full)}`)
  }
}

/** Concurrency for the clone walk: enough to keep the IO queue full, not enough to exhaust handles. */
const CLONE_CONCURRENCY = 24

/**
 * Simple counting semaphore.
 * @param {number} limit maximum concurrent holders.
 * @returns {<T>(fn: () => Promise<T>) => Promise<T>} runner.
 */
function semaphore(limit) {
  let active = 0
  const waiting = []
  const next = () => {
    if (active >= limit) return
    const job = waiting.shift()
    if (job === undefined) return
    // `run()` inside the queued job takes the slot; incrementing here too
    // would leak one permit per dispatch and deadlock the walk.
    void job()
  }
  return async (fn) => {
    const run = () => {
      active += 1
      return fn().finally(() => {
        active -= 1
        next()
      })
    }
    if (active < limit) return run()
    return new Promise((resolve, reject) => {
      waiting.push(() => {
        run().then(resolve, reject)
      })
    })
  }
}

/**
 * Clone one tree cheaply.
 *
 * Files are hard linked when the platforms and volumes allow it, so cloning a
 * ~1 GiB app tree costs metadata operations instead of copying a gigabyte.
 * Symlinks are recreated (a hard link to a symlink would silently copy its
 * target, which is wrong for `node_modules/.bin` on Linux). Any other failure
 * falls back to a real copy for that file. The clone is a snapshot: callers
 * must not assume the two trees stay identical.
 * @param {string} from source directory.
 * @param {string} to destination; removed first.
 * @param {{log?: (line: string) => void}} [options] dependencies.
 * @returns {Promise<{linked: number, copied: number, symlinked: number}>} what happened.
 */
export async function cloneTree(from, to, options = {}) {
  const log = options.log ?? (() => {})
  await rm(to, { recursive: true, force: true })
  const counts = { linked: 0, copied: 0, symlinked: 0 }
  // The permit guards one filesystem call, never a recursive wait: holding it
  // while awaiting children would deadlock the whole walk.
  const run = semaphore(CLONE_CONCURRENCY)

  const cloneEntry = async (source, destination) => {
    const info = await run(() => lstat(source))
    if (info.isDirectory()) {
      await run(() => mkdir(destination, { recursive: true }))
      const entries = await run(() => readdir(source))
      await Promise.all(entries.map(name => cloneEntry(path.join(source, name), path.join(destination, name))))
      return
    }
    if (info.isSymbolicLink()) {
      const target = await run(() => readlink(source))
      await run(() => symlink(target, destination))
      counts.symlinked += 1
      return
    }
    if (!info.isFile()) return
    try {
      await run(() => link(source, destination))
      counts.linked += 1
      return
    } catch {
      await run(() => cp(source, destination, { preserveTimestamps: true }))
      try {
        await run(() => chmod(destination, info.mode & 0o777))
      } catch {
        // Copying without the exact mode is still a usable file.
      }
      counts.copied += 1
    }
  }

  await cloneEntry(from, to)
  log(`cloned app tree: ${String(counts.linked)} linked, ${String(counts.copied)} copied, ${String(counts.symlinked)} symlinks`)
  return counts
}

/**
 * Whether this process should skip caches entirely.
 * @param {NodeJS.ProcessEnv} [env] environment.
 * @returns {boolean} true when disabled.
 */
export function cachesDisabled(env = process.env) {
  const value = String(env.DSH_MESH_NO_CACHE ?? '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

/**
 * Parallelism for independent per-target work.
 *
 * The two long parts of packaging (npm install of the app, archive) spend most
 * of their wall time in IO and in one hash/compression thread, so two targets
 * never saturate a four-core build host. Memory, not cores, is the limit: an
 * npm install peaks around 1.5 GiB, so a small member stays serial.
 * @param {{targets?: number, cpus?: number, totalMemBytes?: number, requested?: number|null, env?: NodeJS.ProcessEnv}} [options] inputs.
 * @returns {number} 1..targets.
 */
export function packagingConcurrency(options = {}) {
  const targets = Math.max(1, Number(options.targets) || 1)
  if (targets === 1) return 1
  const requested = Number(options.requested)
  if (Number.isSafeInteger(requested) && requested > 0) return Math.min(targets, requested)
  const env = options.env ?? process.env
  const fromEnv = Number(env.DSH_MESH_CONCURRENCY)
  if (Number.isSafeInteger(fromEnv) && fromEnv > 0) return Math.min(targets, fromEnv)
  const cpus = Number(options.cpus) || os.availableParallelism?.() || os.cpus().length || 1
  const memory = Number(options.totalMemBytes) || os.totalmem()
  if (memory < 6 * 1024 ** 3) return 1
  // Two targets are enough to overlap install with archive; more workers would
  // only compete for the same npm cache and tunnel.
  return Math.min(targets, Math.max(1, Math.floor(cpus / 4)))
}
