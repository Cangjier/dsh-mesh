/**
 * Build jobs: one directory per build, a durable state file, and a log.
 *
 * A job is deliberately boring: every phase writes `state.json`, so the plugin
 * tool, the CLI, and a human reading the directory all see the same truth.
 *
 * @module dsh-mesh/build/job
 */

import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_REF,
  DEFAULT_SOURCE,
  DEFAULT_TARGETS,
  applyRecipes,
  archivePackage,
  proxyFor,
  assembleRuntimePackage,
  assembleWebPackage,
  ensureAppCache,
  learnOverlays,
  loadRecipes,
  pluginFingerprint,
  prepareSource,
  runWebBuild,
  writeWorkOrder,
} from './engine.mjs'
import { cachesDisabled, packagingConcurrency, webBuildCacheKey } from './cache.mjs'
import { runPackageSmoke } from './smoke.mjs'
import { buildStampDate, isValidBuildStamp } from './stamp.mjs'
import { targetPercent } from './progress.mjs'
import { publishRelease } from '../shared/release.mjs'

/**
 * Default job root.
 * @returns {string} absolute directory.
 */
export function defaultJobRoot() {
  return path.join(os.homedir(), '.dsh', 'mesh', 'build')
}

/**
 * Default source cache.
 * @returns {string} absolute directory.
 */
export function defaultCacheDir() {
  return path.join(os.homedir(), '.dsh', 'mesh', 'cache')
}

/**
 * Create one job directory and its initial state.
 * @param {{root?: string, source?: string, ref?: string, targets?: string[], member?: string|null, proxy?: string|null, mode?: string, buildStamp?: string|null}} options job input.
 * @returns {Promise<{id: string, dir: string, state: object}>} new job.
 */
export async function createJob(options = {}) {
  const root = options.root ?? defaultJobRoot()
  const id = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomBytes(3).toString('hex')}`
  const dir = path.join(root, id)
  await mkdir(dir, { recursive: true })
  const state = {
    id,
    dir,
    status: 'created',
    phase: 'created',
    source: options.source ?? DEFAULT_SOURCE,
    ref: options.ref ?? DEFAULT_REF,
    targets: options.targets ?? [...DEFAULT_TARGETS],
    // Immutable DSH version lives in `version`; this is the daily build
    // revision used in the package filename.
    buildStamp: options.buildStamp ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // `member` is the build host (null = this machine); `proxy` is the outbound
    // proxy the downloads go through, so a job can be reproduced as it ran.
    member: options.member ?? null,
    proxy: options.proxy ?? null,
    mode: options.mode ?? 'local',
    worktree: null,
    workOrder: null,
    artifacts: [],
    error: null,
    learnedAt: null,
  }
  await writeState(dir, state)
  await appendLog(dir, 'job created')
  return { id, dir, state }
}

/**
 * Read a job state.
 * @param {string} dir job directory.
 * @returns {Promise<object>} state.
 */
export async function readState(dir) {
  return JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
}

/**
 * Write a job state atomically.
 * @param {string} dir job directory.
 * @param {object} state state.
 * @returns {Promise<void>}
 */
export async function writeState(dir, state) {
  const file = path.join(dir, 'state.json')
  const temporary = `${file}.tmp`
  await writeFile(temporary, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
  await rename(temporary, file)
}

/**
 * Append one line to the job log.
 * @param {string} dir job directory.
 * @param {string} line text.
 * @returns {Promise<void>}
 */
export async function appendLog(dir, line) {
  await appendFile(path.join(dir, 'build.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
}

/**
 * Read the tail of the job log.
 * @param {string} dir job directory.
 * @param {number} [lines] number of lines.
 * @returns {Promise<string[]>} lines.
 */
export async function readLogTail(dir, lines = 80) {
  try {
    const text = await readFile(path.join(dir, 'build.log'), 'utf8')
    const trimmed = text.trimEnd()
    // A cleared or not-yet-written log is empty, not one blank line: the panel
    // decides between "等待日志" and "日志已清空" from the count.
    if (trimmed === '') return []
    return trimmed.split(/\r?\n/u).slice(-lines)
  } catch {
    return []
  }
}

/** One read-modify-write queue per job directory. */
const stateQueues = new Map()

/**
 * Update one job state field and return the new state.
 *
 * Packaging runs its targets concurrently, so several callers can update the
 * same state file at once. A plain read-modify-write loses fields when it
 * interleaves (one caller's `percent` overwriting the other's `artifacts`);
 * the queue serialises the read, the merge, and the atomic write.
 * @param {string} dir job directory.
 * @param {Partial<object>} patch fields.
 * @returns {Promise<object>} updated state.
 */
export function updateState(dir, patch) {
  const previous = stateQueues.get(dir) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(async () => {
    const state = { ...(await readState(dir)), ...patch }
    await writeState(dir, state)
    return state
  })
  stateQueues.set(dir, run)
  return run
}

/**
 * Decide whether a finished set of packages was verified in a browser.
 *
 * A full package is only a deliverable when at least one target actually
 * booted it in headless Chrome. Skipping is legitimate for a web-only package
 * or an explicit `--no-smoke`, but "no local target could run and no Chrome
 * was found" must not pass as success: that is exactly how an unbootable shell
 * shipped on 2026-11-16.
 * @param {Array<{target: string, smoke?: {status?: string, reason?: string}|null}>} artifacts packaged targets.
 * @param {{full?: boolean, smoke?: boolean}} options build switches.
 * @returns {string|null} failure reason, or null when the build is verified.
 */
export function unverifiedBuildReason(artifacts, options = {}) {
  if (options.full === false || options.smoke === false) return null
  if (artifacts.some(artifact => artifact.smoke?.status === 'passed')) return null
  const detail = artifacts
    .map(artifact => `${artifact.target}: ${artifact.smoke?.status ?? 'not run'}${artifact.smoke?.reason === undefined ? '' : ` (${artifact.smoke.reason})`}`)
    .join('; ')
  return `no target was booted in a browser (${detail}). Install Chrome/Chromium/Edge or set DSH_MESH_SMOKE_CHROME, ` +
    'build on a host that can run at least one target, or pass --no-smoke to accept an unverified package explicitly.'
}

/**
 * Run the deterministic build pipeline.
 * @param {string} dir job directory.
 * @param {{repositoryRoot: string, recipesPath?: string, overlayRoot?: string, cacheDir?: string, source?: string, ref?: string, targets?: string[], planOnly?: boolean, reuseWorktree?: boolean, install?: string[]|null, build?: string[], prepare?: string[][]|null, prebuild?: boolean, version?: string, buildStamp?: string, full?: boolean, nodeVersion?: string, proxy?: string|null, env?: NodeJS.ProcessEnv, onLog?: (line: string) => void}} options build input.
 * @returns {Promise<object>} final state.
 */
export async function runJob(dir, options) {
  const repositoryRoot = options.repositoryRoot
  const recipesPath = options.recipesPath ?? path.join(repositoryRoot, 'build', 'recipes.json')
  const overlayRoot = options.overlayRoot ?? path.join(repositoryRoot, 'build', 'overlays')
  const outbound = proxyFor({ proxy: options.proxy, env: options.env, fetchImpl: options.fetchImpl })
  let state = await readState(dir)
  const buildStamp = options.buildStamp ?? state.buildStamp ?? `${buildStampDate()}A`
  if (!isValidBuildStamp(buildStamp)) throw new Error(`invalid build stamp: ${String(buildStamp)}`)
  if (state.buildStamp !== buildStamp) state = await updateState(dir, { buildStamp })
  const log = (line) => {
    void appendLog(dir, line)
    // `onLog` lets the CLI (and therefore a remote build) mirror the log to
    // stdout, which is how the panel sees phases while a build runs.
    options.onLog?.(line)
  }
  try {
    state = await updateState(dir, { status: 'running', phase: 'prepare', percent: 2, currentTarget: null, error: null })
    const prepared = options.reuseWorktree === true && existsSync(path.join(dir, 'src'))
      ? { dir: path.join(dir, 'src'), source: state.source, ref: state.ref, local: false, archiveSha256: state.archiveSha256 ?? null }
      : await prepareSource({
        source: state.source,
        ref: state.ref,
        cacheDir: options.cacheDir ?? defaultCacheDir(),
        workDir: dir,
        fetchImpl: outbound.fetchImpl,
        log,
      })
    state = await updateState(dir, {
      phase: 'apply',
      percent: 7,
      proxy: outbound.proxy,
      source: prepared.source,
      ref: prepared.ref,
      worktree: prepared.dir,
      archiveSha256: prepared.archiveSha256 ?? null,
      archiveEtag: prepared.archiveEtag ?? null,
    })
    const recipes = await loadRecipes(recipesPath)
    const result = await applyRecipes({ dir: prepared.dir, recipes, overlayRoot, log })
    if (!result.ok) {
      const order = await writeWorkOrder({
        dir: path.join(dir, 'work-order'),
        jobDir: dir,
        source: state.source,
        ref: state.ref,
        recipes,
        result,
        worktree: prepared.dir,
      })
      state = await updateState(dir, {
        status: 'needs-fix',
        phase: 'apply',
        percent: 14,
        workOrder: order,
        mismatches: result.mismatches,
        applied: result.applied,
        skipped: result.skipped,
      })
      log(`needs-fix: ${String(result.mismatches.length)} overlay(s) no longer match`)
      return state
    }
    if (options.planOnly === true) {
      state = await updateState(dir, {
        status: 'planned',
        phase: 'apply',
        percent: 100,
        applied: result.applied,
        skipped: result.skipped,
        mismatchCount: 0,
      })
      log('plan complete: every overlay applies')
      return state
    }
    state = await updateState(dir, {
      phase: 'build',
      percent: 12,
      applied: result.applied,
      skipped: result.skipped,
    })
    const full = options.full !== false
    const targets = state.targets
    const cacheDir = options.cacheDir ?? defaultCacheDir()
    const env = options.env ?? process.env
    const cacheEnabled = options.cache !== false && !cachesDisabled(env)
    // The DSH version is on disk before the web build runs, so the per-target
    // app installs can start now and overlap the TypeScript/vite work instead
    // of following it. On a cold cache that install is the longest step of the
    // whole build (minutes per target); on a warm one it costs nothing.
    const version = options.version ?? await readSourceVersion(prepared.dir)
    const pluginVersion = await readPluginVersion(repositoryRoot)
    const fingerprint = await pluginFingerprint(repositoryRoot)
    const webKey = cacheEnabled
      ? await webBuildCacheKey({
        archiveSha256: prepared.archiveSha256 ?? state.archiveSha256 ?? null,
        source: state.source,
        recipesFile: recipesPath,
        overlayRoot,
        prepare: options.prepare ?? (Array.isArray(recipes.prepare) ? recipes.prepare : null),
        install: options.install,
        build: options.build,
        prebuild: options.prebuild !== false,
      })
      : null
    let prefetch = Promise.resolve()
    if (cacheEnabled && full) {
      prefetch = (async () => {
        for (const target of targets) {
          log(`prefetch app ${target}`)
          try {
            await ensureAppCache({
              cacheDir,
              version,
              target,
              repositoryRoot,
              env: outbound.env,
              refresh: options.refreshAppCache === true,
              log,
            })
          } catch (error) {
            // Packaging retries and reports the real failure; a prefetch that
            // dies early (network, registry) must not mask a build failure.
            log(`prefetch app ${target} failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      })().catch(error => {
        log(`app prefetch stopped: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    let built
    try {
      built = await runWebBuild({
        dir: prepared.dir,
        log,
        install: options.install,
        build: options.build,
        prepare: options.prepare ?? (Array.isArray(recipes.prepare) ? recipes.prepare : null),
        env: outbound.env,
        prebuild: options.prebuild,
        cacheDir: cacheEnabled ? cacheDir : null,
        cacheKey: webKey,
        cacheMeta: {
          source: state.source,
          ref: state.ref,
          archiveSha256: prepared.archiveSha256 ?? null,
          tree: recipes.tree ?? null,
        },
        refreshCache: options.refreshWebCache === true,
        // The install and the web build are the two long silent steps; the
        // panel would otherwise sit at 12% until packaging starts.
        onProgress: async update => {
          state = await updateState(dir, { phase: update.phase, percent: update.percent })
        },
      })
    } finally {
      // The prefetch runs in the background on purpose, but it must be settled
      // before the job returns: a half-started npm install left behind by an
      // early return would keep writing into the cache.
      await prefetch
    }
    if (!built.ok) {
      state = await updateState(dir, { status: 'build-failed', phase: 'build', error: built.error ?? 'web build failed' })
      log(`build failed: ${built.error ?? 'unknown error'}`)
      return state
    }
    state = await updateState(dir, {
      phase: 'package',
      percent: 65,
      version,
      pluginVersion,
      pluginFingerprint: fingerprint,
      dist: built.dist,
      webBuild: { cached: built.cached === true, key: webKey === null ? null : webKey.slice(0, 12) },
    })
    // `--no-cache` must also stop the packaging step from creating an app cache.
    const appCacheDir = cacheEnabled ? cacheDir : null
    const jobSource = state.source
    const jobRef = state.ref
    const sourceEtag = state.archiveEtag ?? null
    const artifacts = []
    let failure = null
    let reported = 65
    const concurrency = packagingConcurrency({
      targets: targets.length,
      requested: options.concurrency,
      env,
    })
    if (concurrency > 1) log(`packaging ${String(targets.length)} targets with up to ${String(concurrency)} at a time`)
    // Progress is monotonic: two targets in flight report their own slices, and
    // the bar must not jump backwards when the slower one updates.
    const advance = async (target, stage, extra = {}) => {
      reported = Math.max(reported, targetPercent(targets, target, stage))
      state = await updateState(dir, {
        phase: stage === 'smoke' ? 'smoke' : 'package',
        percent: reported,
        currentTarget: target,
        ...extra,
      })
    }
    const packageTarget = async (target) => {
      await advance(target, 'start')
      // A marker rather than only a state write: a remote build sees the log,
      // and its progress mapping needs to know which target owns the next
      // install.
      log(`packaging ${target}`)
      const shared = {
        dist: built.dist,
        target,
        outputDir: path.join(dir, 'dist'),
        version,
        buildStamp,
        repositoryRoot,
        source: jobSource,
        ref: jobRef,
        tree: recipes.tree ?? null,
        sourceEtag,
        pluginVersion,
        pluginFingerprint: fingerprint,
        fetchImpl: outbound.fetchImpl,
        env: outbound.env,
        cacheDir,
        log,
      }
      const assembled = full
        ? await assembleRuntimePackage({
          ...shared,
          dshVersion: version,
          nodeVersion: options.nodeVersion ?? process.versions.node,
          appCacheDir,
          refreshAppCache: options.refreshAppCache === true,
        })
        : await assembleWebPackage(shared)
      const archive = await archivePackage(assembled.packageDir, target, {
        log,
        env: outbound.env,
        threads: options.archiveThreads,
      })
      const info = await stat(archive)
      // A package that installs cleanly can still ship a UI that never boots.
      // Start it and look at it with headless Chrome before calling the build
      // done; the screenshots and the browser checks travel in the job state.
      let smoke = null
      if (options.smoke === false) {
        smoke = { ok: true, status: 'skipped', reason: 'smoke test disabled for this build', checks: [], screenshots: [] }
      } else if (!full) {
        smoke = { ok: true, status: 'skipped', reason: 'web-only package has no app/runtime to start', checks: [], screenshots: [] }
      } else {
        await advance(target, 'smoke')
        log(`smoke ${target}: starting the packaged DSH under headless Chrome`)
        smoke = await runPackageSmoke({
          packageRoot: assembled.packageDir,
          target,
          workDir: path.join(dir, 'smoke', target),
          screenshotDir: path.join(dir, 'smoke', target),
          chrome: options.smokeChrome,
          required: options.smokeRequired === true,
          startTimeoutMs: options.smokeStartTimeoutMs,
          pageTimeoutMs: options.smokePageTimeoutMs,
          log,
        })
        if (smoke.status === 'skipped') log(`smoke ${target}: skipped (${smoke.reason})`)
        else log(`smoke ${target}: ${smoke.status}${Array.isArray(smoke.screenshots) && smoke.screenshots.length > 0 ? ` (${smoke.screenshots.join(', ')})` : ''}`)
      }
      const artifact = {
        target,
        packageDir: assembled.packageDir,
        archive,
        bytes: info.size,
        manifest: assembled.manifest,
        smoke,
      }
      artifacts.push(artifact)
      log(`packaged ${target}: ${archive}`)
      await advance(target, 'end', { artifacts: [...artifacts] })
      if (smoke?.status === 'failed') {
        throw Object.assign(
          new Error(`${target} smoke test failed: ${smoke.error ?? 'see smoke.log'}`),
          { smokeFailure: true },
        )
      }
    }
    // A target that fails stops the queue; work already in flight is allowed to
    // finish so its archive and log are not left half written.
    const queue = [...targets]
    let stopped = false
    const worker = async () => {
      while (!stopped) {
        const target = queue.shift()
        if (target === undefined) return
        try {
          await packageTarget(target)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          failure ??= { message, smoke: error instanceof Error && error.smokeFailure === true }
          stopped = true
          if (concurrency > 1) log(`${target} failed; letting the other target finish`)
          return
        }
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(concurrency, targets.length) },
      () => worker(),
    ))
    artifacts.sort((left, right) => targets.indexOf(left.target) - targets.indexOf(right.target))
    if (failure !== null) {
      state = await updateState(dir, {
        status: failure.smoke ? 'smoke-failed' : 'failed',
        phase: failure.smoke ? 'smoke' : 'failed',
        percent: reported,
        error: failure.message,
        artifacts,
      })
      if (failure.smoke) log(`smoke verification failed: ${failure.message}`)
      else log(`build failed: ${failure.message}`)
      return state
    }
    // A package is a deliverable only after something actually booted it. A
    // Windows build host cannot run the Linux target, and without Chrome it
    // cannot run the Windows target either; the old code called that "done"
    // and the broken package went straight into ~/.dsh/packages. The shell is
    // shared by every target, so one booted target is enough to verify it.
    const unverified = unverifiedBuildReason(artifacts, { full, smoke: options.smoke })
    if (unverified !== null) {
      state = await updateState(dir, {
        status: 'smoke-failed',
        phase: 'smoke',
        percent: 95,
        error: unverified,
        artifacts,
      })
      log(`smoke verification incomplete: ${unverified}`)
      return state
    }
    // Publishing is part of a successful build, not a separate manual step:
    // the compile host is the only place the archives exist, and other members
    // are expected to download the newest package from a release instead of
    // pulling it through the gateway. A publish failure does not fail the
    // build (the archive is still deployable from here); it is recorded in
    // `state.publish`, which the panel shows next to the build result.
    state = await updateState(dir, { status: 'done', phase: 'publish', percent: 98, currentTarget: null, artifacts })
    if (options.publish === false || options.publish === null || options.publish === undefined) {
      log('release publish skipped (disabled)')
      state = await updateState(dir, {
        phase: 'done',
        percent: 100,
        publish: { status: 'skipped', reason: 'release publishing is disabled for this build' },
      })
      log('build complete')
      return state
    }
    if (full === false) {
      log('release publish skipped (web-only package has no app/runtime)')
      state = await updateState(dir, {
        phase: 'done',
        percent: 100,
        publish: { status: 'skipped', reason: 'web-only packages are not published as deployment packages' },
      })
      log('build complete')
      return state
    }
    try {
      const publish = await publishRelease({
        artifacts,
        config: options.publish.config,
        proxy: typeof options.publish.proxy === 'string' ? options.publish.proxy : null,
        log,
      })
      state = await updateState(dir, { phase: 'done', percent: 100, publish })
      log(`build complete (release publish ${publish.status})`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      state = await updateState(dir, {
        phase: 'done',
        percent: 100,
        publish: { status: 'failed', error: message },
      })
      log(`release publish failed: ${message}`)
      log('build complete')
    }
    return state
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`failed: ${message}`)
    state = await updateState(dir, { status: 'failed', phase: 'failed', error: message })
    return state
  }
}

/**
 * Learn overlays from a job's corrected worktree.
 * @param {string} dir job directory.
 * @param {{repositoryRoot: string, recipesPath?: string, overlayRoot?: string}} options learn input.
 * @returns {Promise<object>} updated state.
 */
export async function learnJob(dir, options) {
  const recipesPath = options.recipesPath ?? path.join(options.repositoryRoot, 'build', 'recipes.json')
  const overlayRoot = options.overlayRoot ?? path.join(options.repositoryRoot, 'build', 'overlays')
  const state = await readState(dir)
  if (state.worktree === null) throw new Error('this job has no worktree yet')
  const recipes = await loadRecipes(recipesPath)
  const learned = await learnOverlays({
    worktree: state.worktree,
    recipes,
    overlayRoot,
    mismatches: Array.isArray(state.mismatches) ? state.mismatches : [],
  })
  await writeFile(recipesPath, JSON.stringify(learned.recipes, null, 2), 'utf8')
  await appendLog(dir, `learned ${String(learned.learned.length)} overlay(s)`)
  // `learned` is its own status: the overlays now describe the corrected
  // worktree, so `resume` must accept the job even though its last run stopped
  // at `needs-fix`. Leaving the old status in place made the CLI's learn →
  // resume pair fail even though the plugin's build tool worked.
  return updateState(dir, { status: 'learned', learnedAt: new Date().toISOString(), learned: learned.learned })
}

/**
 * Continue a job from its existing worktree.
 *
 * This is the second half of the `needs-fix` loop: a caller corrects the
 * worktree, learns those files into `build/overlays`, then resumes the same
 * job so the install/build/package phases run on the corrected tree.
 * @param {string} dir job directory.
 * @param {object} options same options as {@link runJob}.
 * @returns {Promise<object>} final state.
 */
export async function resumeJob(dir, options) {
  const state = await readState(dir)
  if (!existsSync(path.join(dir, 'src'))) {
    throw new Error(`job ${state.id} has no worktree to resume; start a new build`)
  }
  if (state.status === 'needs-fix') {
    throw new Error(`job ${state.id} still needs its overlays learned before it can resume (run learn first)`)
  }
  return runJob(dir, { ...options, reuseWorktree: true })
}

/**
 * Remove a job directory.
 * @param {string} dir job directory.
 * @returns {Promise<void>}
 */
export async function removeJob(dir) {
  await rm(dir, { recursive: true, force: true })
}

/**
 * Read the dsh-mesh plugin version that goes into the package.
 * @param {string} repositoryRoot plugin root.
 * @returns {Promise<string|null>} version.
 */
async function readPluginVersion(repositoryRoot) {
  try {
    const parsed = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'))
    return typeof parsed?.version === 'string' && parsed.version.trim() !== '' ? parsed.version.trim() : null
  } catch {
    return null
  }
}

/**
 * Read the DSH version from the prepared source tree.
 * @param {string} worktree source root.
 * @returns {Promise<string>} version.
 */
async function readSourceVersion(worktree) {
  for (const candidate of [
    path.join(worktree, 'apps', 'cli', 'package.json'),
    path.join(worktree, 'package.json'),
  ]) {
    try {
      const pkg = JSON.parse(await readFile(candidate, 'utf8'))
      if (typeof pkg.version === 'string' && pkg.version !== '') return pkg.version
    } catch {
      // Try the next candidate.
    }
  }
  return '0.0.0'
}
