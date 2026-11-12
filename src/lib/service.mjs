/**
 * Host-side service for the mesh plugin.
 *
 * It owns two things the model can call: member discovery (the same shared
 * module the gate uses) and build jobs (the deterministic engine in
 * `code/build`). It does not proxy traffic; that is the gate's job.
 *
 * @module @local/dsh-mesh/service
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
import { CLUSTER_HEADER, deriveClusterSecret, signClusterRequest } from '../../code/shared/cluster.mjs'
import { repackArchive } from '../../code/build/repack.mjs'
import { quickSystemInfo } from '../../code/shared/system-info.mjs'

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
export class MeshService {
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
    this.memberTagsFile = path.join(this.dataDir, 'member-tags.json')
    this.packagesDir = path.join(os.homedir(), '.dsh', 'packages')
    this.deploy = new DeployManager({
      repositoryRoot: REPOSITORY_ROOT,
      dataDir: this.deployRoot,
      log: line => this.logLine(`deploy: ${line}`),
    })
    /** @type {Map<string, Promise<object>>} */
    this.running = new Map()
    /** @type {{value: object, expiresAt: number}|null} */
    this.systemCache = null
  }

  /** Cached local host inventory for the member table. */
  async systemInfo() {
    if (this.systemCache !== null && this.systemCache.expiresAt > Date.now()) return this.systemCache.value
    const value = quickSystemInfo()
    this.systemCache = { value, expiresAt: Date.now() + 30_000 }
    return value
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
  /**
   * Ask a Windows member to move its stack into the interactive session.
   *
   * The request travels as a cluster call, the same signed channel a member
   * switch uses, so no new secret is introduced. The member's gate writes the
   * supervisor command file and answers with the supervisor's status.
   * @param {string} target member id, name or address.
   * @returns {Promise<{ok: boolean, member: object, status: object|null}>} result.
   */
  async promoteSession(target) {
    const wanted = String(target ?? '').trim()
    if (wanted === '') throw new Error('member is required')
    const snapshot = await this.members()
    const all = [snapshot.local, ...(Array.isArray(snapshot.members) ? snapshot.members : [])].filter(Boolean)
    const member = all.find(candidate => candidate.id === wanted || candidate.name === wanted || candidate.ip === wanted)
    if (member === undefined) throw new Error(`member not found: ${wanted}`)
    const password = process.env.DSH_GATE_PASSWORD ?? ''
    if (password === '') throw new Error('DSH_GATE_PASSWORD is not set; cannot sign the cluster request')
    let host = String(member.ip ?? '')
    if (host === '') throw new Error(`member ${member.id} has no VPN address`)
    if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`
    const path = '/__gate/cluster/__gate/session/promote'
    const response = await fetch(`http://${host}${path}`, {
      method: 'POST',
      headers: { [CLUSTER_HEADER]: signClusterRequest(deriveClusterSecret(password), { method: 'POST', path }) },
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`member ${member.name} refused the request: HTTP ${String(response.status)} ${text.slice(0, 120)}`)
    let parsed = null
    try { parsed = JSON.parse(text) } catch { }
    return { ok: true, member: { id: member.id, name: member.name, ip: member.ip }, status: parsed?.status ?? null }
  }

  /**
   * Conversations controlled by every member's interop service, grouped by
   * member. The task service owns the interop client and its token.
   * @returns {Promise<{ok: boolean, updatedAt: string, groups: object[]}>} groups.
   */
  async conversations() {
    const tasks = this.memberTasks
    if (tasks === undefined || tasks === null) {
      throw Object.assign(new Error('the member task service is not available yet'), { status: 503 })
    }
    return tasks.listByMember()
  }

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
      system: await this.systemInfo(),
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
    const tags = await this.memberTags()
    self.tag = tags[self.id] ?? null
    const members = snapshot.members.map(member => ({
      ...member,
      tag: tags[member.id] ?? null,
    }))
    return { ...snapshot, self, members, local: self }
  }

  /**
   * User labels for members, keyed by member id.
   * @returns {Promise<Record<string, string>>} tags.
   */
  async memberTags() {
    try {
      const parsed = JSON.parse(await readFile(this.memberTagsFile, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const tags = {}
      for (const [id, tag] of Object.entries(parsed)) {
        if (typeof id === 'string' && typeof tag === 'string' && tag.trim() !== '') tags[id] = tag.trim().slice(0, 32)
      }
      return tags
    } catch {
      return {}
    }
  }

  /**
   * Set or clear one member's label.
   * @param {string} id member id.
   * @param {string} tag label; empty removes it.
   * @returns {Promise<{ok: boolean, tags: Record<string, string>}>} saved tags.
   */
  async setMemberTag(id, tag) {
    if (typeof id !== 'string' || id.trim() === '') throw new Error('member id is required')
    const memberId = id.trim()
    const label = typeof tag === 'string' ? tag.trim().slice(0, 32) : ''
    const tags = await this.memberTags()
    if (label === '') delete tags[memberId]
    else tags[memberId] = label
    await mkdir(this.dataDir, { recursive: true })
    await writeFile(this.memberTagsFile, `${JSON.stringify(tags, null, 2)}\n`, 'utf8')
    return { ok: true, tags }
  }

  /**
   * Remove the files left by earlier builds.
   *
   * Called after a build finishes, with the just-finished job id as `keep`, so
   * the new `src/`, `work-order/` and `dist/` survive. All older jobs lose
   * their worktree, work order and (unless `keepDist`) their package.
   * `state.json` and `build.log` are always kept for postmortem.
   * @param {{keep?: string, keepDist?: boolean}} [options] job to preserve and whether to retain old packages.
   * @returns {Promise<string[]>} ids whose outputs were removed.
   */
  async cleanupBuilds(options = {}) {
    if (!existsSync(this.jobRoot)) return []
    const entries = await readdir(this.jobRoot, { withFileTypes: true })
    const removed = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(this.jobRoot, entry.name)
      let state
      try {
        state = await readState(dir)
      } catch {
        continue
      }
      if (this.running.has(state.id)) continue
      if (state.id === options.keep) continue
      await rm(path.join(dir, 'src'), { recursive: true, force: true })
      await rm(path.join(dir, 'work-order'), { recursive: true, force: true })
      if (options.keepDist !== true) await rm(path.join(dir, 'dist'), { recursive: true, force: true })
      removed.push(state.id)
    }
    return removed
  }

  /**
   * Start one build job in the background.
   * @param {{source?: string, ref?: string, targets?: string[], planOnly?: boolean, version?: string, keepDist?: boolean}} request build request.
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
    this.logLine(`mesh build job ${job.id} created`)
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
      this.logLine(`mesh build job ${job.id} crashed: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      this.running.delete(job.id)
    })
    this.running.set(job.id, promise)
    return { ...job.state, dir: job.dir, running: true }
  }

  /**
   * Run one build to completion.
   *
   * Without `jobId` this starts a fresh build. With `jobId` it treats the
   * job's worktree as the DSH-adapted result: if the job stopped at
   * `needs-fix`, it learns the corrected files into the overlay set first,
   * then resumes the same job. There is no separate learn/resume command.
   * Older jobs are cleaned only after the current job finishes, so a running
   * build never loses its own worktree or package.
   * @param {{source?: string, ref?: string, targets?: string[], planOnly?: boolean, version?: string, keepDist?: boolean, jobId?: string}} request build request.
   * @returns {Promise<object>} final job with log tail.
   */
  async build(request = {}) {
    if (typeof request.jobId === 'string' && request.jobId !== '') {
      const state = await this.job(request.jobId)
      if (state.status === 'needs-fix') await this.learn(request.jobId)
      const resumed = await this.resumeBuild(request.jobId)
      const running = this.running.get(resumed.id)
      if (running !== undefined) await running
      const final = await this.job(resumed.id)
      await this.cleanupBuilds({ keep: resumed.id, keepDist: request.keepDist === true })
      return final
    }
    const job = await this.startBuild(request)
    const running = this.running.get(job.id)
    if (running !== undefined) await running
    const final = await this.job(job.id)
    await this.cleanupBuilds({ keep: job.id, keepDist: request.keepDist === true })
    return final
  }

  /**
   * Continue a job from its corrected worktree. This is what follows the
   * automatic learn step: the overlays have been updated, and the worktree
   * already contains the fix, so nothing is downloaded again.
   * @param {string} id job id.
   * @returns {Promise<object>} the job state, running in the background.
   */
  async resumeBuild(id) {
    const dir = this._jobDir(id)
    if (this.running.has(id)) throw new Error('this job is already running')
    const state = await readState(dir)
    this.logLine(`mesh build job ${id} resumed`)
    const promise = runJob(dir, {
      repositoryRoot: this.repositoryRoot,
      recipesPath: this.recipesPath,
      overlayRoot: this.overlayRoot,
      cacheDir: this.cacheDir,
      reuseWorktree: true,
      full: this.config.build?.full !== false,
      nodeVersion: typeof this.config.build?.nodeVersion === 'string' && this.config.build.nodeVersion !== '' ? this.config.build.nodeVersion : undefined,
    }).catch((error) => {
      this.logLine(`mesh build job ${id} crashed: ${error instanceof Error ? error.message : String(error)}`)
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
      logFile: path.join(dir, 'build.log'),
      stateFile: path.join(dir, 'state.json'),
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
   * Local deployment packages. The fixed directory is `~/.dsh/packages`.
   * @returns {Promise<object>} package list.
   */
  async packages() {
    const entries = await readdir(this.packagesDir, { withFileTypes: true }).catch(() => [])
    const packages = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!/\.(?:zip|tar\.gz|tgz)$/iu.test(entry.name)) continue
      const file = path.join(this.packagesDir, entry.name)
      const info = await stat(file).catch(() => null)
      if (info === null) continue
      packages.push({
        name: entry.name,
        path: file,
        bytes: info.size,
        mtime: info.mtime.toISOString(),
        target: /win(?:dows)?/iu.test(entry.name) ? 'windows' : 'linux',
      })
    }
    packages.sort((left, right) => right.mtime.localeCompare(left.mtime))
    return { ok: true, dir: this.packagesDir, packages }
  }

  /**
   * Resolve a package path from an absolute path, `~/.dsh/packages/<name>`,
   * or the repository `dist/<name>`.
   * @param {string} input package path or filename.
   * @returns {Promise<string>} absolute package path.
   */
  async resolvePackage(input) {
    const raw = typeof input === 'string' ? input.trim() : ''
    if (raw === '') throw new Error('package is required')
    const candidates = path.isAbsolute(raw)
      ? [raw]
      : [path.join(this.packagesDir, raw), path.join(this.repositoryRoot, 'dist', raw)]
    for (const file of candidates) {
      const info = await stat(file).catch(() => null)
      if (info?.isFile()) return file
    }
    throw new Error(`package not found: ${raw}`)
  }

  /**
   * Resolve a target and start a deployment job.
   *
   * This is the single entry point used by both the panel API and the model
   * tool. The caller decides whether to wait by calling `deployPackage()`;
   * the panel keeps the historical non-blocking `deployMember()` wrapper.
   * @param {{host?: string, member?: string, package?: string}} request target and package.
   * @returns {Promise<{ok: boolean, job: object, member: object|null, packagePath: string}>} started job.
   */
  async startDeploy(request) {
    const host = typeof request.host === 'string' ? request.host.trim() : ''
    const memberId = typeof request.member === 'string' ? request.member.trim() : ''
    const packagePath = await this.resolvePackage(request.package)
    const snapshot = await this.members()
    const all = [snapshot.local, ...snapshot.members].filter(Boolean)
    const member = memberId !== ''
      ? all.find(candidate => candidate.id === memberId)
      : all.find(candidate => candidate.id === host || candidate.name === host || candidate.ip === host)
    if (memberId !== '' && member === undefined) throw new Error(`member not found: ${memberId}`)
    if (member !== undefined) {
      const os = /win(?:dows)?/iu.test(path.basename(packagePath))
        ? 'windows'
        : member.system?.platform?.toLowerCase().startsWith('win') ? 'windows' : 'linux'
      const deployRequest = await this.#memberDeployRequest(member, packagePath, os)
      const started = await this.deploy.start({ ...deployRequest, member: member.id })
      return {
        ok: true,
        job: started.job,
        member: { id: member.id, name: member.name, ip: member.ip },
        packagePath,
      }
    }
    if (host === '') throw new Error('host is required')
    const os = /win(?:dows)?/iu.test(path.basename(packagePath)) ? 'windows' : 'linux'
    const appRoot = os === 'windows' ? 'C:\\dsh-mesh' : '/opt/dsh-mesh'
    const started = await this.deploy.start({ host, package: packagePath, os, appRoot })
    return { ok: true, job: started.job, member: null, packagePath }
  }

  /**
   * Deploy one local package to a discovered member, without waiting.
   * Kept for the panel API, which returns a job id immediately.
   * @param {{member?: string, package?: string}} request member id/ip and package filename.
   * @returns {Promise<object>} started deploy job.
   */
  async deployMember(request) {
    const result = await this.startDeploy({ member: request.member, package: request.package })
    return {
      ok: true,
      job: result.job,
      member: result.member,
      packagesDir: this.packagesDir,
    }
  }

  /**
   * Deploy one package to an SSH host, synchronously.
   *
   * The host may be a discovered member id/name/IP, in which case the member's
   * OS, install root and WireGuard SSH metadata are used; otherwise the host is
   * treated as a plain SSH target and the package platform decides the OS.
   * @param {{host?: string, package?: string}} request target host and package.
   * @returns {Promise<{job: object|null, logFile: string, log: string, member?: object}>} final result.
   */
  async deployPackage(request) {
    const started = await this.startDeploy({ host: request.host, package: request.package })
    const job = await this.deploy.wait(started.job.id)
    return {
      job,
      member: started.member,
      logFile: path.join(this.deployRoot, started.job.id, 'deploy.log'),
      log: await this.deployLogs(started.job.id, 80),
    }
  }

  /**
   * Build the deployment request for a discovered member.
   * @param {object} member member snapshot.
   * @param {string} packagePath package file.
   * @param {'linux'|'windows'} os target OS.
   * @returns {Promise<object>} deploy request.
   */
  async #memberDeployRequest(member, packagePath, os) {
    if (member.ip === '') throw new Error(`member ${member.id} has no VPN address`)
    let user = 'root'
    let identityFile
    const { state } = await readWireGuardState({ file: path.join(this.home, 'wireguard', 'state.json') })
    const peer = state?.server?.peers?.find(candidate => candidate?.ip === member.ip)
    if (peer !== undefined && peer !== null) {
      if (typeof peer.sshUser === 'string' && peer.sshUser !== '') user = peer.sshUser
      if (typeof peer.publicKey === 'string' && peer.publicKey !== '') {
        const digest = createHash('sha256').update(peer.publicKey).digest('hex')
        const candidate = path.join(this.home, 'wireguard', 'ssh', `${digest}.key`)
        if (existsSync(candidate)) identityFile = candidate
      }
    }
    // The gate reports its own install root, home and run user, so a healthy
    // member needs no SSH round-trip just to learn where it lives.
    const system = member.system
    let appRoot = typeof system?.appRoot === 'string' && system.appRoot.trim() !== ''
      ? system.appRoot.trim()
      : undefined
    let serviceUser = typeof system?.user === 'string' && system.user.trim() !== ''
      ? system.user.trim()
      : undefined
    if (appRoot === undefined) {
      try {
        const detected = await this.deploy.inspectTarget({ host: member.ip, user, identityFile, os })
        appRoot = detected.appRoot
        serviceUser = serviceUser ?? detected.serviceUser
      } catch {
        // Keep the SSH error for the deploy job; fall back below.
      }
    }
    if (appRoot === undefined && typeof system?.home === 'string' && system.home.trim() !== '') {
      const home = system.home.trim().replace(/[\\/]+$/u, '')
      appRoot = os === 'windows' ? `${home}\\.dsh\\dsh-mesh` : `${home}/.dsh/dsh-mesh`
    }
    if (appRoot === undefined) {
      const home = os === 'windows'
        ? `C:\\Users\\${user}`
        : user === 'root' ? '/root' : `/home/${user}`
      appRoot = os === 'windows' ? `${home}\\.dsh\\dsh-mesh` : `${home}/.dsh/dsh-mesh`
    }
    return {
      host: member.ip,
      user,
      identityFile,
      os,
      appRoot,
      serviceUser,
      package: packagePath,
    }
  }

  /**
   * Refresh a prebuilt package from this repository, in place.
   *
   * The DSH app, the browser bundles and the Node runtime inside the package
   * stay as they are; only the gateway, the scripts and the plugin files are
   * replaced, then the archive and its checksum are rewritten.
   * @param {{package: string}} request package name (in the packages dir) or path.
   * @returns {Promise<object>} summary.
   */
  async repackPackage(request) {
    const packagePath = await this.resolvePackage(request.package)
    const summary = await repackArchive(packagePath, {
      repositoryRoot: this.repositoryRoot,
      log: line => this.logLine(`repack: ${line}`),
    })
    return { ok: true, ...summary }
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
   * List recent deployment jobs, newest first.
   * @param {number} [limit] maximum count.
   * @returns {Promise<object[]>} jobs.
   */
  async deployJobs(limit = 20) {
    return this.deploy.list(limit)
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
