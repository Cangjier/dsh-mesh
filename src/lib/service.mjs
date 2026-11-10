/**
 * Host-side service for the person-web plugin.
 *
 * It owns two things the model can call: member discovery (the same shared
 * module the gate uses) and build jobs (the deterministic engine in
 * `code/build`). It does not proxy traffic; that is the gate's job.
 *
 * @module @local/dsh-person-web/service
 */

import { readFile, readdir } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  discoverMembers,
  readWireGuardState,
  wireGuardIdentity,
} from '../../code/shared/wireguard.mjs'
import {
  createJob,
  learnJob,
  readLogTail,
  readState,
  runJob,
} from '../../code/build/job.mjs'
import { DEFAULT_REF, DEFAULT_SOURCE } from '../../code/build/engine.mjs'
import { DeployManager } from '../../code/deploy/engine.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * Find the package root both when this module runs from `src/lib` and when it
 * has been bundled into the package's `index.js`.
 * @param {string} start directory to start from.
 * @returns {string} package root.
 */
function findRepositoryRoot(start) {
  let current = start
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(path.join(current, 'build', 'recipes.json')) && existsSync(path.join(current, 'code', 'build'))) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return path.resolve(start, '..', '..')
}

const REPOSITORY_ROOT = findRepositoryRoot(HERE)

/**
 * Read this package's version once.
 * @returns {string} version.
 */
function packageVersion() {
  try {
    const parsed = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'))
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * One host service instance.
 */
export class PersonWebService {
  /**
   * @param {{dataDir: string, config?: object, log?: (line: string) => void}} options service input.
   */
  constructor(options) {
    this.dataDir = options.dataDir
    this.config = options.config ?? {}
    this.logLine = options.log ?? (() => {})
    this.jobRoot = path.join(this.dataDir, 'build')
    this.cacheDir = path.join(this.dataDir, 'cache')
    this.version = packageVersion()
    this.repositoryRoot = REPOSITORY_ROOT
    this.recipesPath = path.join(REPOSITORY_ROOT, 'build', 'recipes.json')
    this.overlayRoot = path.join(REPOSITORY_ROOT, 'build', 'overlays')
    this.home = path.dirname(this.dataDir)
    this.deployRoot = path.join(this.dataDir, 'deploy')
    this.deploy = new DeployManager({
      repositoryRoot: REPOSITORY_ROOT,
      dataDir: this.deployRoot,
      log: line => this.logLine(`deploy: ${line}`),
    })
    /** @type {Map<string, Promise<object>>} */
    this.running = new Map()
  }

  /** No child process is owned directly; jobs own their own. */
  async dispose() {
    await this.deploy.dispose()
  }

  /**
   * Local host and WireGuard facts.
   * @returns {Promise<object>} status.
   */
  async status() {
    const stateFile = path.join(this.home, 'wireguard', 'state.json')
    const { state, error } = await readWireGuardState({ file: stateFile })
    const identity = state === null ? null : wireGuardIdentity(state)
    return {
      ok: true,
      host: {
        hostname: os.hostname(),
        platform: process.platform,
        arch: process.arch,
        version: this.version,
        dataDir: this.dataDir,
        repositoryRoot: this.repositoryRoot,
      },
      wireguard: identity === null
        ? { available: false, error, stateFile }
        : {
          available: true,
          stateFile,
          role: identity.role,
          connected: identity.connected,
          vpnCidr: identity.vpnCidr,
          serverIp: identity.serverIp,
          serverUrl: identity.serverUrl,
          selfIp: identity.selfIp,
          selfName: identity.selfName,
          lastHandshakeAt: identity.lastHandshakeAt,
          warnings: identity.warnings,
        },
      gate: { url: typeof this.config.gateUrl === 'string' ? this.config.gateUrl : '' },
      build: {
        source: typeof this.config.build?.source === 'string' ? this.config.build.source : '',
        ref: typeof this.config.build?.ref === 'string' ? this.config.build.ref : 'master',
        targets: Array.isArray(this.config.build?.targets) ? this.config.build.targets : ['linux-x64', 'win-x64'],
        jobRoot: this.jobRoot,
      },
      deploy: { jobRoot: this.deployRoot },
    }
  }

  /**
   * Discover members from this host. The gate has its own copy of this logic;
   * this one keeps the panel useful when DSH is opened directly.
   * @returns {Promise<object>} discovery snapshot.
   */
  async members() {
    const stateFile = path.join(this.home, 'wireguard', 'state.json')
    const { state, error } = await readWireGuardState({ file: stateFile })
    const identity = state === null ? null : wireGuardIdentity(state)
    const self = {
      id: 'local',
      kind: 'self',
      name: identity?.selfName ?? os.hostname(),
      ip: identity?.selfIp ?? '',
      online: true,
      dsh: true,
      port: null,
      latencyMs: 0,
      gate: null,
      error: null,
    }
    const snapshot = await discoverMembers({
      state,
      stateError: error,
      self,
      ports: Array.isArray(this.config.memberPorts) ? this.config.memberPorts : [80, 8080],
    })
    // Keep the gate and host responses shaped the same: `local` is the row for
    // this machine, `members` are the peers.
    return { ...snapshot, local: snapshot.self }
  }

  /**
   * Start one build job in the background.
   * @param {{source?: string, ref?: string, targets?: string[], planOnly?: boolean, version?: string}} request build request.
   * @returns {Promise<object>} the initial job state.
   */
  async startBuild(request = {}) {
    const defaults = await this.status()
    const source = (typeof request.source === 'string' && request.source !== ''
      ? request.source
      : defaults.build.source) || DEFAULT_SOURCE
    const ref = (typeof request.ref === 'string' && request.ref !== ''
      ? request.ref
      : defaults.build.ref) || DEFAULT_REF
    const targets = Array.isArray(request.targets) && request.targets.length > 0
      ? request.targets
      : defaults.build.targets
    const job = await createJob({ root: this.jobRoot, source, ref, targets })
    this.logLine(`person-web build job ${job.id} created`)
    const promise = runJob(job.dir, {
      repositoryRoot: this.repositoryRoot,
      recipesPath: this.recipesPath,
      overlayRoot: this.overlayRoot,
      cacheDir: this.cacheDir,
      planOnly: request.planOnly === true,
      version: request.version,
      full: this.config.build?.full !== false,
      nodeVersion: typeof this.config.build?.nodeVersion === 'string' && this.config.build.nodeVersion !== '' ? this.config.build.nodeVersion : undefined,
    }).catch((error) => {
      this.logLine(`person-web build job ${job.id} crashed: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      this.running.delete(job.id)
    })
    this.running.set(job.id, promise)
    return { ...job.state, dir: job.dir, running: true }
  }

  /**
   * Continue a job from its corrected worktree. This is what follows
   * `build_learn`: the overlays have been updated, and the worktree already
   * contains the fix, so nothing is downloaded again.
   * @param {string} id job id.
   * @returns {Promise<object>} the job state, running in the background.
   */
  async resumeBuild(id) {
    const dir = this._jobDir(id)
    if (this.running.has(id)) throw new Error('this job is already running')
    const state = await readState(dir)
    this.logLine(`person-web build job ${id} resumed`)
    const promise = runJob(dir, {
      repositoryRoot: this.repositoryRoot,
      recipesPath: this.recipesPath,
      overlayRoot: this.overlayRoot,
      cacheDir: this.cacheDir,
      reuseWorktree: true,
      full: this.config.build?.full !== false,
      nodeVersion: typeof this.config.build?.nodeVersion === 'string' && this.config.build.nodeVersion !== '' ? this.config.build.nodeVersion : undefined,
    }).catch((error) => {
      this.logLine(`person-web build job ${id} crashed: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      this.running.delete(id)
    })
    this.running.set(id, promise)
    return { ...state, running: true }
  }

  /**
   * Read one job with its log tail and work-order paths.
   * @param {string} id job id.
   * @returns {Promise<object>} job detail.
   */
  async job(id) {
    const dir = this._jobDir(id)
    const state = await readState(dir)
    return {
      ...state,
      logTail: await readLogTail(dir, 60),
      running: this.running.has(id),
      workOrderMarkdown: state.workOrder?.markdown ?? null,
      workOrderPrompt: state.workOrder?.prompt ?? null,
    }
  }

  /**
   * List known jobs, newest first.
   * @returns {Promise<object[]>} jobs.
   */
  async jobs() {
    if (!existsSync(this.jobRoot)) return []
    const entries = await readdir(this.jobRoot, { withFileTypes: true })
    const jobs = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const state = await readState(path.join(this.jobRoot, entry.name))
        jobs.push({
          id: state.id,
          status: state.status,
          phase: state.phase,
          source: state.source,
          ref: state.ref,
          targets: state.targets,
          updatedAt: state.updatedAt,
        })
      } catch {
        // A half-created directory is not a job.
      }
    }
    return jobs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
  }

  /**
   * Read one job's log tail.
   * @param {string} id job id.
   * @param {number} [lines] number of lines.
   * @returns {Promise<string[]>} lines.
   */
  async log(id, lines = 80) {
    return readLogTail(this._jobDir(id), lines)
  }

  /**
   * Learn overlays from a corrected worktree.
   * @param {string} id job id.
   * @returns {Promise<object>} updated state.
   */
  async learn(id) {
    return learnJob(this._jobDir(id), {
      repositoryRoot: this.repositoryRoot,
      recipesPath: this.recipesPath,
      overlayRoot: this.overlayRoot,
    })
  }

  /**
   * Read the recipe manifest summary.
   * @returns {Promise<object>} recipes.
   */
  async recipes() {
    const parsed = JSON.parse(await readFile(this.recipesPath, 'utf8'))
    return {
      source: parsed.source,
      ref: parsed.ref,
      tree: parsed.tree ?? null,
      steps: (parsed.steps ?? []).map(step => ({
        id: step.id,
        title: step.title,
        doc: step.doc,
        files: (step.files ?? []).map(file => ({ path: file.path, baseSha256: file.baseSha256 ?? null })),
      })),
    }
  }

  /**
   * Plan an SSH blue-green deployment without touching the network.
   * @param {object} request deploy options.
   * @returns {Promise<object>} plan.
   */
  async deployPlan(request) {
    return this.deploy.plan(request)
  }

  /**
   * Start an SSH blue-green deployment.
   * @param {object} request deploy options.
   * @returns {Promise<object>} job.
   */
  async deployStart(request) {
    return this.deploy.start(request)
  }

  /**
   * Read one deployment job.
   * @param {string} id job id.
   * @returns {Promise<object|null>} job state.
   */
  async deployStatus(id) {
    return this.deploy.status(id)
  }

  /**
   * Read one deployment job's log tail.
   * @param {string} id job id.
   * @param {number} [lines] line count.
   * @returns {Promise<string>} log tail.
   */
  async deployLogs(id, lines = 80) {
    return this.deploy.logs(id, lines)
  }

  /**
   * Roll a deployment back to the previous release.
   * @param {object} request deploy target options.
   * @returns {Promise<object>} job.
   */
  async deployRollback(request) {
    return this.deploy.rollback(request)
  }

  /**
   * Resolve and validate one job directory.
   * @param {string} id job id.
   * @returns {string} path.
   */
  _jobDir(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(id)) throw new Error('invalid job id')
    const dir = path.resolve(this.jobRoot, id)
    if (!dir.startsWith(`${path.resolve(this.jobRoot)}${path.sep}`)) throw new Error('invalid job id')
    return dir
  }
}
