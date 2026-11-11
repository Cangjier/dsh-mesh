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
  assembleRuntimePackage,
  assembleWebPackage,
  learnOverlays,
  loadRecipes,
  prepareSource,
  runWebBuild,
  writeWorkOrder,
} from './engine.mjs'

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
 * @param {{root?: string, source?: string, ref?: string, targets?: string[]}} options job input.
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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
    return text.trimEnd().split(/\r?\n/u).slice(-lines)
  } catch {
    return []
  }
}

/**
 * Update one job state field and return the new state.
 * @param {string} dir job directory.
 * @param {Partial<object>} patch fields.
 * @returns {Promise<object>} updated state.
 */
export async function updateState(dir, patch) {
  const state = { ...(await readState(dir)), ...patch }
  await writeState(dir, state)
  return state
}

/**
 * Run the deterministic build pipeline.
 * @param {string} dir job directory.
 * @param {{repositoryRoot: string, recipesPath?: string, overlayRoot?: string, cacheDir?: string, source?: string, ref?: string, targets?: string[], planOnly?: boolean, reuseWorktree?: boolean, install?: string[]|null, build?: string[], version?: string, full?: boolean, nodeVersion?: string}} options build input.
 * @returns {Promise<object>} final state.
 */
export async function runJob(dir, options) {
  const repositoryRoot = options.repositoryRoot
  const recipesPath = options.recipesPath ?? path.join(repositoryRoot, 'build', 'recipes.json')
  const overlayRoot = options.overlayRoot ?? path.join(repositoryRoot, 'build', 'overlays')
  let state = await readState(dir)
  const log = (line) => {
    void appendLog(dir, line)
  }
  try {
    state = await updateState(dir, { status: 'running', phase: 'prepare', error: null })
    const prepared = options.reuseWorktree === true && existsSync(path.join(dir, 'src'))
      ? { dir: path.join(dir, 'src'), source: state.source, ref: state.ref, local: false, archiveSha256: state.archiveSha256 ?? null }
      : await prepareSource({
        source: state.source,
        ref: state.ref,
        cacheDir: options.cacheDir ?? defaultCacheDir(),
        workDir: dir,
        log,
      })
    state = await updateState(dir, {
      phase: 'apply',
      source: prepared.source,
      ref: prepared.ref,
      worktree: prepared.dir,
      archiveSha256: prepared.archiveSha256 ?? null,
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
        applied: result.applied,
        skipped: result.skipped,
        mismatchCount: 0,
      })
      log('plan complete: every overlay applies')
      return state
    }
    state = await updateState(dir, { phase: 'build', applied: result.applied, skipped: result.skipped })
    const built = await runWebBuild({
      dir: prepared.dir,
      log,
      install: options.install,
      build: options.build,
    })
    if (!built.ok) {
      state = await updateState(dir, { status: 'build-failed', phase: 'build', error: built.error ?? 'web build failed' })
      log(`build failed: ${built.error ?? 'unknown error'}`)
      return state
    }
    const version = options.version ?? await readSourceVersion(prepared.dir)
    state = await updateState(dir, { phase: 'package', version, dist: built.dist })
    const artifacts = []
    const full = options.full !== false
    for (const target of state.targets) {
      const shared = {
        dist: built.dist,
        target,
        outputDir: path.join(dir, 'dist'),
        version,
        repositoryRoot,
        source: state.source,
        ref: state.ref,
        tree: recipes.tree ?? null,
        log,
      }
      const assembled = full
        ? await assembleRuntimePackage({
          ...shared,
          dshVersion: version,
          nodeVersion: options.nodeVersion ?? process.versions.node,
          cacheDir: options.cacheDir ?? defaultCacheDir(),
        })
        : await assembleWebPackage(shared)
      const archive = await archivePackage(assembled.packageDir, target, { log })
      const info = await stat(archive)
      artifacts.push({
        target,
        packageDir: assembled.packageDir,
        archive,
        bytes: info.size,
        manifest: assembled.manifest,
      })
      log(`packaged ${target}: ${archive}`)
    }
    state = await updateState(dir, { status: 'done', phase: 'done', artifacts })
    log('build complete')
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
  return updateState(dir, { learnedAt: new Date().toISOString(), learned: learned.learned })
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
