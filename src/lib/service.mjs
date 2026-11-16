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
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  discoverMembers,
  probeMember,
  readWireGuardState,
  wireGuardIdentity,
} from '../../code/shared/wireguard.mjs'
import { readDeployment } from '../../code/shared/deployment.mjs'
import {
  appendLog,
  createJob,
  learnJob,
  readLogTail,
  readState,
  runJob,
  updateState,
} from '../../code/build/job.mjs'
import { DEFAULT_REF, DEFAULT_SOURCE, pluginFingerprint, readExtraPlugins, remoteRevision } from '../../code/build/engine.mjs'
import { nextBuildStamp } from '../../code/build/stamp.mjs'
import {
  appendDeployLog,
  buildDeployPlan,
  DeployManager,
  normalizeInstallRoot,
  initialDeploySteps,
  jobPaths,
  newJobId,
  readDeployState,
  writeDeployState,
} from '../../code/deploy/engine.mjs'
import { EgressProxy } from './egress.mjs'
import { RemoteBuilder } from './remote-build.mjs'
import { CLUSTER_HEADER, deriveClusterSecret, signClusterRequest } from '../../code/shared/cluster.mjs'
import { repackArchive } from '../../code/build/repack.mjs'
import { quickSystemInfo } from '../../code/shared/system-info.mjs'
import { GeoLookup } from '../../code/shared/geo.mjs'
import { buildUpdateReasons, memberDeployment, packageInfo, planUpgrades } from './schedule.mjs'
import { pickBuildMember, pickProxyMember } from './build-defaults.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** A good member probe outlives repeated failed re-probes by this long. */
const PROBE_GRACE_MS = 10 * 60_000
/** Budget for one probe. A 165 ms VPN hop with a retransmit still fits. */
const PROBE_TIMEOUT_MS = 4_500
/** Budget for the second probe attempt before a peer is called unreachable. */
const PROBE_RETRY_MS = 4_500
/** How long a result saved on disk keeps counting after a restart. */
const PROBE_CACHE_TTL_MS = 7 * 24 * 60 * 60_000

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
/**
 * Reject targets a test upgrade cannot work on, with a reason the panel shows.
 *
 * The rehearsal is a bash script and installs nothing: it needs a member that
 * already runs DSH on Linux, and a Linux package for it.
 * @param {object|null} target discovered member.
 * @param {{packageOs?: 'linux'|'windows'}} [options] package platform.
 * @returns {object} the same target.
 */
export function assertTestUpgradeTarget(target, options = {}) {
  if (target === null || target === undefined) {
    throw new Error('测试升级需要一个成员：请从成员列表里选一个已安装 DSH 的 Linux 成员')
  }
  if (target.kind === 'self' || target.id === 'local') {
    throw new Error('测试升级要在别的成员上跑；本机升级请直接用「升级」')
  }
  const memberOs = /win/iu.test(target.system?.platform ?? '') ? 'windows' : 'linux'
  // A Windows member has no flat install to rehearse in: its test upgrade is
  // the normal Windows upgrade. Only the package platform has to match.
  if (options.packageOs !== undefined && options.packageOs !== memberOs) {
    throw new Error(`选的是 ${options.packageOs === 'windows' ? 'Windows' : 'Linux'} 部署包，但成员 ${String(target.name ?? target.id)} 是 ${memberOs}；换一个匹配的包`)
  }
  if (target.dsh !== true) {
    throw new Error(`成员 ${String(target.name ?? target.id)} 还没有安装 DSH，没有可升级的安装；请先用「部署」`)
  }
  return target
}

export class MeshService {
  /**
   * @param {{dataDir: string, config?: object, log?: (line: string) => void, spawnRunner?: Function, geoLookup?: object}} options service input.
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
    const geoConfig = this.config.geo === false
      ? { enabled: false }
      : (this.config.geo !== null && typeof this.config.geo === 'object' ? this.config.geo : {})
    // The build panel defaults the outbound proxy to a member whose public
    // address is abroad; that is a cached country lookup over the WireGuard
    // endpoint, never a probe that blocks a build.
    this.geo = options.geoLookup ?? new GeoLookup({
      enabled: geoConfig.enabled !== false,
      cacheFile: path.join(this.dataDir, 'geo-cache.json'),
      provider: typeof geoConfig.provider === 'string' && geoConfig.provider !== '' ? geoConfig.provider : undefined,
      timeoutMs: typeof geoConfig.timeoutMs === 'number' ? geoConfig.timeoutMs : undefined,
      fetchImpl: typeof geoConfig.fetchImpl === 'function' ? geoConfig.fetchImpl : undefined,
      log: line => this.logLine(`geo: ${line}`),
    })
    this.deploy = new DeployManager({
      repositoryRoot: REPOSITORY_ROOT,
      dataDir: this.deployRoot,
      log: line => this.logLine(`deploy: ${line}`),
    })
    /**
     * How one detached job is started. Production spawns a systemd transient
     * unit (see `#spawnRunner`); tests replace it so no process is ever
     * started by the suite.
     * @type {(dir: string, id: string) => Promise<{mode: string, unit: string|null}>}
     */
    this.spawnRunner = options.spawnRunner ?? ((dir, id) => this.#spawnRunner(dir, id))
    /** @type {Map<string, Promise<object>>} */
    this.running = new Map()
    /** Egress proxies live exactly as long as the build that started them. */
    this.egress = new EgressProxy({ log: line => this.logLine(line) })
    this.remoteBuilder = new RemoteBuilder({ packagesDir: this.packagesDir, log: line => this.logLine(line) })
    /** @type {{value: object, expiresAt: number}|null} */
    this.systemCache = null
    /**
     * Last successful probe per peer address.
     *
     * A long-haul peer loses a packet now and then, and one failed probe used
     * to flip its row to 未部署 until the next refresh. Keeping the last good
     * answer for a short grace period makes that flicker stop.
     * @type {Map<string, {port: number|null, gate: object|null, system: object|null, latencyMs: number, at: number}>}
     */
    this.probes = new Map()
    this.probeCacheFile = path.join(this.dataDir, 'probe-cache.json')
    this.probeCacheLoaded = false
    /** Injectable for tests: every member probe goes through this fetch. */
    this.fetchImpl = options.fetchImpl
  }

  /**
   * Seed the probe map from the last run.
   *
   * The map lives in memory, so a panel reload used to forget that a peer was
   * installed and show 未部署 (with a tempting 部署 button) until the slow peer
   * answered again. The file keeps that knowledge across restarts; entries age
   * out after a week so an uninstalled member is eventually re-detected.
   */
  async #loadProbes() {
    if (this.probeCacheLoaded) return
    this.probeCacheLoaded = true
    try {
      const parsed = JSON.parse(await readFile(this.probeCacheFile, 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return
      const now = Date.now()
      for (const [ip, entry] of Object.entries(parsed)) {
        if (this.probes.has(ip) || entry === null || typeof entry !== 'object') continue
        const at = Number(entry.at)
        if (!Number.isFinite(at)) continue
        const expiresAt = at + PROBE_CACHE_TTL_MS
        if (expiresAt <= now) continue
        this.probes.set(ip, {
          port: Number.isInteger(entry.port) ? entry.port : null,
          gate: entry.gate ?? null,
          system: entry.system ?? null,
          latencyMs: Number(entry.latencyMs) || 0,
          at,
          expiresAt,
        })
      }
    } catch {
      // No cache yet (or an unreadable one): the next probe refills it.
    }
  }

  /** Persist the probe map; a failed write is not worth reporting. */
  async #saveProbes() {
    try {
      await mkdir(path.dirname(this.probeCacheFile), { recursive: true })
      await writeFile(this.probeCacheFile, JSON.stringify(Object.fromEntries(this.probes)), 'utf8')
    } catch {
      // Best effort: the in-memory map still serves this process.
    }
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
    this.egress.closeAll()
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

  /**
   * Post a message typed in the panel to selected members.
   *
   * An empty selection broadcasts to every other member; the panel resolves
   * `@3` mentions into ids before calling, so this stays a transport.
   * @param {{text?: string, members?: string[]}} request message and targets.
   * @returns {Promise<{ok: boolean, sent: object[], errors: object[]}>} outcome.
   */
  async sendConversation(request) {
    const tasks = this.memberTasks
    if (tasks === undefined || tasks === null) {
      throw Object.assign(new Error('the member task service is not available yet'), { status: 503 })
    }
    const text = typeof request?.text === 'string' ? request.text.trim() : ''
    if (text === '') throw Object.assign(new Error('消息不能为空'), { status: 400 })
    if (text.length > 8000) throw Object.assign(new Error('消息太长（上限 8000 字）'), { status: 400 })
    const members = Array.isArray(request?.members)
      ? request.members.filter(item => typeof item === 'string' && item.trim() !== '')
      : []
    return tasks.sendTo({ text, members })
  }

  /**
   * Ask every member's interop service to drop its finished conversations.
   * @returns {Promise<{ok: boolean, removed: number, errors: object[]}>} summary.
   */
  async clearConversations() {
    const tasks = this.memberTasks
    if (tasks === undefined || tasks === null) {
      throw Object.assign(new Error('the member task service is not available yet'), { status: 503 })
    }
    return tasks.clearConversations()
  }

  async members() {
    await this.#loadProbes()
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
    // This row is the machine answering the request; no probe can report on
    // itself, so read its own release from the install it runs out of.
    const install = this.#localAppRoot()
    if (install !== null) self.deployment = readDeployment(install.appRoot)
    const snapshot = await discoverMembers({
      state,
      stateError: error,
      self,
      ports: Array.isArray(this.config.memberPorts) ? this.config.memberPorts : [80, 8080],
      timeoutMs: PROBE_TIMEOUT_MS,
      fetchImpl: this.fetchImpl,
      geoLookup: this.geo,
    })
    // Keep the gate and host responses shaped the same: `local` is the row for
    // this machine, `members` are the peers.
    const tags = await this.memberTags()
    self.tag = tags[self.id] ?? null
    const ports = Array.isArray(this.config.memberPorts) ? this.config.memberPorts : [80, 8080]
    const now = Date.now()
    let probed = false
    const members = await Promise.all(snapshot.members.map(async (member) => {
      const tag = tags[member.id] ?? null
      const known = this.probes.get(member.ip)
      if (member.dsh) {
        this.probes.set(member.ip, {
          port: member.port,
          gate: member.gate,
          system: member.system,
          latencyMs: member.latencyMs,
          at: now,
          expiresAt: now + PROBE_GRACE_MS,
        })
        probed = true
        return { ...member, tag }
      }
      // One lost packet must not read as "not deployed": a peer that answered
      // before gets a second probe, and if that also fails the last good answer
      // stands in for a while. A peer that never answered fails fast instead.
      if (known === undefined) return { ...member, tag }
      // Retry the port that answered last time instead of walking every port
      // again: one extra request, not two more timeouts.
      const retryPorts = known.port === null ? ports : [known.port]
      const retry = await probeMember(member.ip, {
        ports: retryPorts,
        timeoutMs: PROBE_RETRY_MS,
        fetchImpl: this.fetchImpl,
      }).catch(() => null)
      if (retry !== null && retry.ok) {
        this.probes.set(member.ip, {
          port: retry.port,
          gate: retry.info,
          system: retry.info?.system ?? null,
          latencyMs: retry.latencyMs,
          at: now,
          expiresAt: now + PROBE_GRACE_MS,
        })
        probed = true
        return {
          ...member,
          dsh: true,
          port: retry.port,
          latencyMs: retry.latencyMs,
          gate: retry.info,
          system: retry.info?.system ?? null,
          error: null,
          tag,
        }
      }
      if (known.expiresAt === undefined || now > known.expiresAt) return { ...member, tag }
      return {
        ...member,
        dsh: true,
        port: known.port,
        latencyMs: known.latencyMs,
        gate: known.gate,
        system: known.system,
        error: null,
        tag,
        probeStale: true,
      }
    }))
    if (probed) void this.#saveProbes()
    if (this.probes.size > 64) {
      for (const [ip, cached] of this.probes) {
        if (cached.expiresAt !== undefined && now > cached.expiresAt) this.probes.delete(ip)
      }
    }
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
   * Remove the temporary files a build leaves behind.
   *
   * `state.json` and `build.log` are the postmortem, so they stay; the source
   * worktree, smoke screenshots, work order and extracted package trees are
   * only useful while the build runs.
   *
   * A successful job keeps its archives under `dist/` — a member build's were
   * already pulled into the packages directory, while a local build has no
   * other copy. A failed or planned job keeps nothing but the log and state: a
   * partial archive is not a deliverable.
   *
   * `needs-fix` and `learned` jobs are skipped: their worktree is the input the
   * repair/resume flow works on. `keepDist` disables the pruning entirely for
   * callers that want the whole tree (`--keep-dist`).
   * @param {{keep?: string, keepDist?: boolean}} [options] unused compatibility fields.
   * @returns {Promise<string[]>} ids whose temporary files were removed.
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
      // `keep` is exempt from the running check: `#runBuild` cleans up in its
      // finally block, where the finished job is still registered as running.
      if (this.running.has(state.id) && state.id !== options.keep) continue
      // These statuses still own a worktree the repair flow resumes from.
      if (state.status === 'created' || state.status === 'needs-fix' || state.status === 'learned') continue
      await rm(path.join(dir, 'src'), { recursive: true, force: true })
      await rm(path.join(dir, 'smoke'), { recursive: true, force: true })
      await rm(path.join(dir, 'work-order'), { recursive: true, force: true })
      if (options.keepDist !== true) {
        // Only a done job has a deliverable to keep; a planned job never had
        // one and a stopped job's partial output is not worth keeping.
        if (state.status === 'done') await this.#pruneDist(path.join(dir, 'dist'))
        else await rm(path.join(dir, 'dist'), { recursive: true, force: true })
      }
      removed.push(state.id)
    }
    return removed
  }

  /**
   * Remove the extracted package trees from a `dist/` directory.
   *
   * Archives and their `.sha256` sidecars are files and stay untouched; the
   * per-target package directories (an `app/` + `runtime/` copy each) are the
   * part that costs a gigabyte per target.
   * @param {string} distDir job `dist/` directory.
   * @returns {Promise<void>} completion.
   */
  async #pruneDist(distDir) {
    const entries = await readdir(distDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      await rm(path.join(distDir, entry.name), { recursive: true, force: true })
    }
  }

  /**
   * Start one build job in the background.
   *
   * `member` chooses the build host: empty or `local` runs the engine here,
   * anything else runs the same engine on that member over SSH and copies the
   * archives back into `~/.dsh/packages`. `proxyMember` borrows another
   * member's internet access for the downloads; `proxy` is an explicit HTTP
   * proxy URL that both the engine and npm use.
   * @param {{source?: string, ref?: string, targets?: string[], planOnly?: boolean, version?: string, keepDist?: boolean, member?: string, proxy?: string, proxyMember?: string}} request build request.
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
    const memberId = typeof request.member === 'string' ? request.member.trim() : ''
    const proxyMemberId = typeof request.proxyMember === 'string' ? request.proxyMember.trim() : ''
    const proxyUrl = typeof request.proxy === 'string' ? request.proxy.trim() : ''
    if (this.running.size > 0) {
      throw Object.assign(new Error('a build is already running; wait for it to finish'), { status: 409 })
    }
    const snapshot = await this.members()
    const everyone = [snapshot.local, ...snapshot.members].filter(candidate => candidate !== null && candidate !== undefined)
    let member = null
    if (memberId !== '' && memberId !== 'local') {
      const found = everyone.find(candidate => candidate.id === memberId || candidate.name === memberId || candidate.ip === memberId)
      if (found === undefined) throw new Error(`member not found: ${memberId}`)
      if (found.id !== 'local') {
        if (found.online === false) throw new Error(`member ${found.name} is offline`)
        const platform = String(found.system?.platform ?? '').toLowerCase()
        if (platform !== '' && !platform.startsWith('linux') && !platform.startsWith('win')) {
          throw new Error(`member build needs Linux or Windows; ${found.name} runs ${String(found.system?.platform)}`)
        }
        member = found
      }
    }
    if (request.planOnly === true && member !== null) throw new Error('plan-only builds run on the local host')
    const proxyMember = proxyMemberId === ''
      ? null
      : everyone.find(candidate => candidate.id === proxyMemberId || candidate.name === proxyMemberId || candidate.ip === proxyMemberId) ?? null
    if (proxyMemberId !== '' && proxyMember === null) throw new Error(`proxy member not found: ${proxyMemberId}`)
    if (proxyMember !== null && proxyMember.id === 'local') {
      throw new Error('the local host cannot proxy its own build; pick a member')
    }
    if (proxyMember !== null && String(proxyMember.system?.platform ?? '').toLowerCase().startsWith('win')) {
      // The egress proxy is one small Node script started with `bash -s`.
      throw new Error(`proxy member must be Linux; ${proxyMember.name} runs ${String(proxyMember.system?.platform)}`)
    }
    const buildStamp = await nextBuildStamp({
      stateFile: path.join(this.dataDir, 'build-stamp.json'),
      packagesDir: this.packagesDir,
    })
    const job = await createJob({
      root: this.jobRoot,
      source,
      ref,
      targets,
      member: member?.id ?? null,
      proxy: proxyUrl !== '' ? proxyUrl : proxyMember !== null ? `member:${proxyMember.id}` : null,
      mode: member === null ? 'local' : 'remote',
      buildStamp,
    })
    if (member !== null) {
      await updateState(job.dir, {
        memberName: member.name,
        memberIp: member.ip,
        percent: 0,
        proxyMember: proxyMember?.id ?? null,
      })
    } else if (proxyMember !== null) {
      await updateState(job.dir, { proxyMember: proxyMember.id, percent: 0 })
    }
    this.logLine(`mesh build job ${job.id} created (${member === null ? 'local' : member.name}${proxyMember === null ? '' : `, egress via ${proxyMember.name}`})`)
    const promise = this.#runBuild(job, {
      member,
      proxyMember,
      proxyUrl,
      planOnly: request.planOnly === true,
      version: request.version,
      buildStamp: job.state.buildStamp,
    }).catch((error) => {
      this.logLine(`mesh build job ${job.id} crashed: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      this.running.delete(job.id)
    })
    this.running.set(job.id, promise)
    return { ...job.state, dir: job.dir, running: true }
  }

  /**
   * Run one build job to completion, local or on a member.
   * @param {{id: string, dir: string}} job new job.
   * @param {{member: object|null, proxyMember: object|null, proxyUrl: string, planOnly: boolean, version?: string}} options run options.
   * @returns {Promise<void>}
   */
  async #runBuild(job, options) {
    let egress = null
    let proxyUrl = options.proxyUrl !== '' ? options.proxyUrl : null
    try {
      if (options.proxyMember !== null && (options.member === null || options.member.id !== options.proxyMember.id)) {
        egress = await this.egress.start({ plan: await this.#memberSshPlan(options.proxyMember), member: options.proxyMember.name })
        proxyUrl = egress.url
        await appendLog(job.dir, `outbound proxy ${proxyUrl} (${options.proxyMember.name})`)
        await updateState(job.dir, { proxy: proxyUrl, proxyMember: options.proxyMember.id })
      }
      if (options.member === null) {
        await runJob(job.dir, {
          repositoryRoot: this.repositoryRoot,
          recipesPath: this.recipesPath,
          overlayRoot: this.overlayRoot,
          cacheDir: this.cacheDir,
          planOnly: options.planOnly,
          version: options.version,
          buildStamp: options.buildStamp,
          proxy: proxyUrl,
          full: this.config.build?.full !== false,
          nodeVersion: typeof this.config.build?.nodeVersion === 'string' && this.config.build.nodeVersion !== '' ? this.config.build.nodeVersion : undefined,
          smoke: this.config.build?.smoke === false ? false : undefined,
          smokeRequired: this.config.build?.requireSmoke === true,
          smokeChrome: typeof this.config.build?.chrome === 'string' && this.config.build.chrome !== '' ? this.config.build.chrome : undefined,
        })
        return
      }
      await this.remoteBuilder.run(job.dir, {
        plan: await this.#memberSshPlan(options.member),
        memberName: options.member.name,
        proxyUrl,
        buildStamp: options.buildStamp,
        heapMb: typeof this.config.build?.memberHeapMb === 'number' ? this.config.build.memberHeapMb : undefined,
      })
    } catch (error) {
      // A failure before the engine starts (an unreachable proxy member, a
      // missing runtime) must settle the job, or the panel shows a job that
      // never starts and never ends.
      const message = error instanceof Error ? error.message : String(error)
      await appendLog(job.dir, `build failed to start: ${message}`).catch(() => {})
      await updateState(job.dir, { status: 'failed', phase: 'failed', error: message, percent: 0 }).catch(() => {})
      throw error
    } finally {
      egress?.close()
      // The panel starts builds through `startBuild` (not `build`), which never
      // ran the cleanup. Without this, every completed job keeps its source
      // tree and dist directory forever and the build disk fills up.
      await this.cleanupBuilds({ keep: job.id }).catch(error => {
        this.logLine(`mesh build cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }

  /**
   * SSH coordinates for one member.
   * @param {object} member member snapshot.
   * @returns {Promise<{host: string, user: string, port: number, identityFile?: string, appRoot?: string, os: string}>} plan.
   */
  async #memberSshPlan(member) {
    if (member.ip === '') throw new Error(`member ${member.name} has no VPN address`)
    let user = 'root'
    let identityFile
    let port = 22
    const { state } = await readWireGuardState({ file: path.join(this.home, 'wireguard', 'state.json') })
    const peer = state?.server?.peers?.find(candidate => candidate?.ip === member.ip)
    if (peer !== undefined && peer !== null) {
      if (typeof peer.sshUser === 'string' && peer.sshUser !== '') user = peer.sshUser
      if (Number.isSafeInteger(peer.sshPort)) port = peer.sshPort
      if (typeof peer.publicKey === 'string' && peer.publicKey !== '') {
        const digest = createHash('sha256').update(peer.publicKey).digest('hex')
        const candidate = path.join(this.home, 'wireguard', 'ssh', `${digest}.key`)
        if (existsSync(candidate)) identityFile = candidate
      }
    }
    const platform = String(member.system?.platform ?? '').toLowerCase()
    return {
      host: member.ip,
      user,
      port,
      identityFile,
      appRoot: typeof member.system?.appRoot === 'string' ? member.system.appRoot : undefined,
      os: platform.startsWith('win') ? 'windows' : 'linux',
    }
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
      buildStamp: state.buildStamp,
      full: this.config.build?.full !== false,
      nodeVersion: typeof this.config.build?.nodeVersion === 'string' && this.config.build.nodeVersion !== '' ? this.config.build.nodeVersion : undefined,
      smoke: this.config.build?.smoke === false ? false : undefined,
      smokeRequired: this.config.build?.requireSmoke === true,
      smokeChrome: typeof this.config.build?.chrome === 'string' && this.config.build.chrome !== '' ? this.config.build.chrome : undefined,
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
        jobs.push(this.#summary(state))
      } catch {
        // A half-created directory is not a job.
      }
    }
    return jobs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
  }

  /**
   * The list projection of one job, or null when it does not exist.
   *
   * The panel's event stream pushes this shape, so it is the same object
   * `jobs()` returns and the client can merge it into its table.
   * @param {string} id job id.
   * @returns {Promise<object|null>} summary.
   */
  async buildSummary(id) {
    let dir
    try {
      dir = this._jobDir(id)
    } catch {
      return null
    }
    try {
      return this.#summary(await readState(dir))
    } catch {
      return null
    }
  }

  /** Project a job state onto the fields the panel lists. */
  #summary(state) {
    return {
      id: state.id,
      status: state.status,
      phase: state.phase,
      source: state.source,
      ref: state.ref,
      targets: state.targets,
      updatedAt: state.updatedAt,
      createdAt: state.createdAt,
      member: state.member ?? null,
      memberName: state.memberName ?? null,
      mode: state.mode ?? 'local',
      proxy: state.proxy ?? null,
      proxyMember: state.proxyMember ?? null,
      percent: typeof state.percent === 'number' ? state.percent : null,
      currentTarget: state.currentTarget ?? null,
      version: state.version ?? null,
      error: state.error ?? null,
    }
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
   * The newest build that actually finished.
   *
   * A failed or needs-fix job must not become the baseline for the update
   * check, or one bad night would suppress the retry for every following day.
   * @returns {Promise<object|null>} job state with artifacts, or null.
   */
  async #latestDoneBuild() {
    for (const job of await this.jobs()) {
      if (job.status !== 'done') continue
      try {
        return await readState(this._jobDir(job.id))
      } catch {
        // A job directory that vanished mid-scan is not a baseline.
      }
    }
    return null
  }

  /**
   * Resolve the remote revisions the next build would use.
   *
   * The ETags come from codeload HEAD requests and are recorded in the package
   * manifest, so the daily check never downloads a tarball just to answer
   * "is there anything new?".
   * @param {string} source DSH source.
   * @param {string} ref DSH ref.
   * @returns {Promise<object>} current source state.
   */
  async #currentBuildSources(source, ref) {
    const extra = await readExtraPlugins(this.repositoryRoot)
    const extraPlugins = await Promise.all(extra.map(async plugin => ({
      name: plugin.name,
      repo: plugin.repo,
      ref: plugin.ref,
      etag: await remoteRevision(plugin.repo, plugin.ref),
    })))
    return {
      source,
      ref,
      sourceEtag: await remoteRevision(source, ref),
      pluginFingerprint: await pluginFingerprint(this.repositoryRoot),
      extraPlugins,
    }
  }

  /**
   * One scheduled build: build only when DSH, dsh-mesh, or a bundled plugin
   * changed since the newest finished build.
   *
   * Returns immediately after starting the job; the build itself is the same
   * background job the panel starts.
   * @returns {Promise<{status: string, reason?: string, jobId?: string}>} outcome.
   */
  async scheduledBuild() {
    if (this.running.size > 0) return { status: 'skipped', reason: '已有编译任务在运行' }
    const jobs = await this.jobs()
    if (jobs.some(job => job.status === 'running' || job.status === 'created')) {
      return { status: 'skipped', reason: '已有编译任务在运行' }
    }
    const defaults = await this.status()
    const source = defaults.build.source || DEFAULT_SOURCE
    const ref = defaults.build.ref || DEFAULT_REF
    const targets = defaults.build.targets
    const latest = await this.#latestDoneBuild()
    const latestManifest = latest?.artifacts?.[0]?.manifest ?? null
    const current = await this.#currentBuildSources(source, ref)
    const reasons = buildUpdateReasons({ latestManifest, current })
    if (reasons.length === 0) {
      return { status: 'skipped', reason: 'DSH、dsh-mesh、xl 都没有更新' }
    }
    const snapshot = await this.members()
    const everyone = [snapshot.local, ...snapshot.members].filter(Boolean)
    const member = pickBuildMember(everyone)
    const proxyMember = pickProxyMember(everyone)
    const job = await this.startBuild({
      source,
      ref,
      targets,
      ...(member !== 'local' ? { member } : {}),
      ...(proxyMember !== null ? { proxyMember } : {}),
    })
    this.logLine(`scheduled build ${job.id} started: ${reasons.join('；')}`)
    return {
      status: 'started',
      jobId: job.id,
      reason: reasons.join('；'),
      member: member === 'local' ? 'local' : member,
      proxyMember: proxyMember ?? null,
    }
  }

  /**
   * Fill in a member's deployment from the newest successful deploy job.
   *
   * Old gates do not report their release; this is the same fallback the
   * member table uses, so a member that never reported a version is still
   * compared instead of being skipped forever.
   * @param {object} member member row.
   * @param {object[]} deployJobs recent deploy jobs.
   * @returns {void}
   */
  #applyInferredDeployment(member, deployJobs) {
    if (memberDeployment(member) !== null) return
    const job = deployJobs.find(candidate => candidate.status === 'succeeded'
      && candidate.package !== undefined
      && (candidate.member === member.id || candidate.target?.host === member.ip))
    const parsed = packageInfo(path.basename(job?.package ?? ''))
    if (parsed === null) return
    member.deployment = { version: parsed.version, buildStamp: parsed.buildStamp, inferred: true }
  }

  /**
   * One member's scheduled auto-upgrade.
   *
   * The job is started and left detached; the scheduler records "started"
   * instead of holding its tick open for an upload that may take minutes.
   * @param {string} memberId member id.
   * @returns {Promise<{status: string, member?: string, package?: string, jobId?: string, reason?: string}>} outcome.
   */
  async scheduledUpgradeMember(memberId) {
    if (this.running.size > 0) return { status: 'skipped', reason: '编译任务还在运行', member: memberId }
    const snapshot = await this.members()
    const everyone = [snapshot.local, ...snapshot.members].filter(Boolean)
    const member = everyone.find(candidate => candidate.id === memberId)
    if (member === undefined) return { status: 'skipped', reason: '成员不在当前列表', member: memberId }
    if (member.online === false) return { status: 'skipped', reason: '离线', member: member.name }
    const deployJobs = await this.deployJobs(50)
    this.#applyInferredDeployment(member, deployJobs)
    const packages = (await this.packages()).packages
    const plan = planUpgrades([member], packages)
    if (plan.upgrades.length === 0) {
      return { status: 'skipped', member: member.name, reason: plan.skipped[0]?.reason ?? '当前部署已是最新' }
    }
    const entry = plan.upgrades[0]
    try {
      const result = await this.upgradeMember({ member: entry.member.id, package: entry.package.name })
      this.logLine(`scheduled upgrade ${entry.member.name} -> ${entry.package.name} (${result.job.id})`)
      return { status: 'started', member: entry.member.name, package: entry.package.name, jobId: result.job.id }
    } catch (error) {
      return { status: 'failed', member: member.name, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * One scheduled upgrade: bring every member that is behind to the newest
   * package for its OS, peers before the local gateway.
   *
   * Each member keeps its own detached job; a failure on one member does not
   * stop the others, and the local install is started last because upgrading
   * it restarts this process.
   * @returns {Promise<{status: string, reason?: string, upgraded?: object[], failed?: object[], skipped?: object[]}>} outcome.
   */
  async scheduledUpgrade() {
    if (this.running.size > 0) return { status: 'skipped', reason: '编译任务还在运行' }
    const snapshot = await this.members()
    const everyone = [snapshot.local, ...snapshot.members].filter(Boolean)
    const deployJobs = await this.deployJobs(50)
    for (const member of everyone) this.#applyInferredDeployment(member, deployJobs)
    const packages = (await this.packages()).packages
    const plan = planUpgrades(everyone, packages)
    const skipped = plan.skipped.map(entry => ({ member: entry.member.name, reason: entry.reason }))
    if (plan.upgrades.length === 0) {
      return { status: 'skipped', reason: '所有成员都已经是可用的最新部署', skipped }
    }
    const upgraded = []
    const failed = []
    for (const entry of plan.upgrades) {
      try {
        const result = await this.upgradeMember({ member: entry.member.id, package: entry.package.name })
        upgraded.push({ member: entry.member.name, package: entry.package.name, job: result.job.id })
        this.logLine(`scheduled upgrade ${entry.member.name} -> ${entry.package.name} (${result.job.id})`)
        // The local job restarts this process, so waiting would only be cut
        // short; the detached runner finishes the upgrade either way.
        if (entry.member.id === 'local') continue
        const final = await this.waitDeploy(result.job.id, { timeoutMs: 20 * 60_000 }).catch(() => null)
        if (final !== null && final.status === 'failed') {
          failed.push({ member: entry.member.name, reason: final.error ?? '升级失败' })
        }
      } catch (error) {
        failed.push({ member: entry.member.name, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return {
      status: failed.length === 0 ? 'done' : 'failed',
      upgraded,
      failed,
      skipped,
      reason: failed.length === 0 ? undefined : `${String(failed.length)} 个成员升级失败`,
    }
  }

  /**
   * Delete one package (and its `.sha256` sidecar) from the packages directory.
   * @param {{name: string}} request package file name.
   * @returns {Promise<{ok: boolean, removed: string[]}>} removed files.
   */
  async removePackage(request) {
    const name = typeof request?.name === 'string' ? request.name.trim() : ''
    if (name === '' || name !== path.basename(name) || name.startsWith('.')) {
      throw new Error('package name is invalid')
    }
    if (!/\.(?:zip|tar\.gz|tgz)$/iu.test(name)) throw new Error(`not a package name: ${name}`)
    const file = path.join(this.packagesDir, name)
    const info = await stat(file).catch(() => null)
    if (info === null || !info.isFile()) throw new Error(`package not found: ${name}`)
    const removed = []
    await rm(file, { force: true })
    removed.push(file)
    const sidecar = `${file}.sha256`
    if (existsSync(sidecar)) {
      await rm(sidecar, { force: true })
      removed.push(sidecar)
    }
    this.logLine(`removed package ${name}`)
    return { ok: true, removed }
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
   * Resolve a target and start a deployment or upgrade job.
   *
   * The job itself runs in a detached process (`code/deploy/runner.mjs`) so a
   * member — including this gateway — can restart dsh-web and the gateway while
   * its own upgrade keeps going. This method only writes the job directory and
   * returns; `waitDeploy()` is what the model tool uses to block.
   * @param {{host?: string, member?: string, package?: string, mode?: 'install'|'upgrade'}} request target and package.
   * @returns {Promise<{ok: boolean, job: object, member: object|null, packagePath: string, layout: string}>} queued job.
   */
  async startDeploy(request) {
    const mode = request.mode === 'upgrade' ? 'upgrade' : request.mode === 'test' ? 'test' : 'install'
    // A test upgrade rehearses the flat path on a *member*, then upgrades that
    // member normally. It is never a local job: the whole point is not to be
    // the machine being tested.
    const test = request.test === true || mode === 'test'
    const host = typeof request.host === 'string' ? request.host.trim() : ''
    const memberId = typeof request.member === 'string' ? request.member.trim() : ''
    const packagePath = await this.resolvePackage(request.package)
    const snapshot = await this.members()
    const all = [snapshot.local, ...snapshot.members].filter(Boolean)
    const member = memberId !== ''
      ? all.find(candidate => candidate.id === memberId)
      : all.find(candidate => candidate.id === host || candidate.name === host || candidate.ip === host)
    if (memberId !== '' && member === undefined) throw new Error(`member not found: ${memberId}`)
    // One job per target: a second upgrade of the same member would fight the
    // first one over the same release directory, and the panel can be a second
    // behind an already running job.
    const busy = await this.#activeDeployFor(member?.id ?? null, member?.ip ?? host)
    if (busy !== null) {
      throw Object.assign(
        new Error(`该目标已有正在进行的${busy.mode === 'upgrade' ? '升级' : busy.mode === 'test' ? '测试升级' : '部署'}任务：${busy.id}`),
        { status: 409 },
      )
    }
    if (member !== undefined) {
      const os = /win(?:dows)?/iu.test(path.basename(packagePath))
        ? 'windows'
        : member.system?.platform?.toLowerCase().startsWith('win') ? 'windows' : 'linux'
      const identity = { id: member.id, name: member.name, ip: member.ip }
      // The package platform is what decides whether the target can take it;
      // `os` above falls back to the member's platform when the name is silent.
      const packageOs = /win(?:dows)?/iu.test(path.basename(packagePath)) ? 'windows' : 'linux'
      if (test) assertTestUpgradeTarget(member, { packageOs })
      if (member.kind === 'self' || member.id === 'local') {
        return this.#startLocalJob({ member, packagePath, os, mode, identity })
      }
      const deployRequest = await this.#memberDeployRequest(member, packagePath, os)
      const job = await this.#startEngineJob({
        request: { ...deployRequest, member: member.id, test },
        member: member.id,
        mode,
      })
      return { ok: true, job, member: identity, packagePath, layout: 'bluegreen' }
    }
    if (host === '') throw new Error('host is required')
    if (test) throw new Error('测试升级需要一个成员（要在成员的安装上演练），不能直接给裸 SSH 主机')
    const os = /win(?:dows)?/iu.test(path.basename(packagePath)) ? 'windows' : 'linux'
    const appRoot = os === 'windows' ? 'C:\\dsh-mesh' : '/opt/dsh-mesh'
    const job = await this.#startEngineJob({ request: { host, package: packagePath, os, appRoot }, member: null, mode })
    return { ok: true, job, member: null, packagePath, layout: 'bluegreen' }
  }

  /**
   * Deploy one local package to a discovered member, without waiting.
   * Kept for the panel API, which returns a job id immediately.
   * @param {{member?: string, package?: string, mode?: 'install'|'upgrade'}} request member id/ip and package filename.
   * @returns {Promise<object>} started deploy job.
   */
  async deployMember(request) {
    const result = await this.startDeploy({ member: request.member, package: request.package, mode: request.mode })
    return {
      ok: true,
      job: result.job,
      member: result.member,
      layout: result.layout,
      packagesDir: this.packagesDir,
    }
  }

  /**
   * Upgrade one member (or this machine) from a chosen deployment package.
   *
   * Same flow as a first deploy; the difference is that an installed member is
   * upgraded by the package instead of being installed from scratch, and the
   * panel labels the job as an upgrade.
   * @param {{member?: string, package?: string}} request member id/ip and package filename.
   * @returns {Promise<object>} queued job.
   */
  async upgradeMember(request) {
    const result = await this.startDeploy({ member: request.member, package: request.package, mode: 'upgrade' })
    return {
      ok: true,
      job: result.job,
      member: result.member,
      layout: result.layout,
      packagesDir: this.packagesDir,
    }
  }

  /**
   * Test-upgrade one package on another member.
   *
   * The job does what a member upgrade does — upload, extract, switch, restart,
   * health check, rollback on failure — and, before touching the member, runs
   * the flat upgrade the gateway runs on itself against a sandbox built from
   * the member's current version. That way the local path is exercised on a
   * machine that is not this one.
   * @param {{member?: string, package?: string}} request member id/ip and package filename.
   * @returns {Promise<object>} queued job.
   */
  async testUpgradeMember(request) {
    const result = await this.startDeploy({ member: request.member, package: request.package, mode: 'test', test: true })
    return {
      ok: true,
      job: result.job,
      member: result.member,
      layout: result.layout,
      packagesDir: this.packagesDir,
    }
  }

  /**
   * Deploy one package to an SSH host, synchronously.
   *
   * The host may be a discovered member id/name/IP, in which case the member's
   * OS, install root and WireGuard SSH metadata are used; otherwise the host is
   * treated as a plain SSH target and the package platform decides the OS.
   * @param {{host?: string, package?: string, mode?: 'install'|'upgrade'}} request target host and package.
   * @returns {Promise<{job: object|null, logFile: string, log: string, member?: object}>} final result.
   */
  async deployPackage(request) {
    const started = await this.startDeploy({ host: request.host, package: request.package, mode: request.mode })
    const job = await this.waitDeploy(started.job.id)
    return {
      job,
      member: started.member,
      logFile: path.join(this.deployRoot, started.job.id, 'deploy.log'),
      log: await this.deployLogs(started.job.id, 80),
    }
  }

  /**
   * The job currently using one target, if any.
   * @param {string|null} memberId member id.
   * @param {string} host VPN address or SSH host.
   * @returns {Promise<object|null>} active job.
   */
  async #activeDeployFor(memberId, host) {
    for (const job of await this.deploy.list(20)) {
      if (job.status !== 'running' && job.status !== 'queued') continue
      if (memberId !== null && memberId !== '' && job.member === memberId) return job
      if (typeof host === 'string' && host !== '' && job.target?.host === host) return job
    }
    return null
  }

  /**
   * Wait for one detached deploy job to settle.
   * @param {string} id job id.
   * @param {{timeoutMs?: number}} [options] budget; 30 minutes by default.
   * @returns {Promise<object|null>} final job state.
   */
  async waitDeploy(id, options = {}) {
    const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30 * 60 * 1000
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const job = await this.deployStatus(id)
      if (job !== null && job.status !== 'running' && job.status !== 'queued') return job
      if (Date.now() >= deadline) return job
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }

  /**
   * Start one job for a blue-green target (blue-green members and plain hosts).
   *
   * The plan is built here, once: the queued job needs its release name and
   * size, and the runner must not hash a 300 MB package a second time.
   * @param {{request: object, member: string|null, mode: 'install'|'upgrade'}} input job input.
   * @returns {Promise<object>} queued job state.
   */
  async #startEngineJob(input) {
    const plan = await buildDeployPlan({
      ...input.request,
      gatePassword: typeof input.request.gatePassword === 'string' ? input.request.gatePassword : process.env.DSH_GATE_PASSWORD,
      repositoryRoot: this.repositoryRoot,
    })
    return this.#queueJob({
      mode: input.mode,
      member: input.member,
      plan,
      request: { kind: 'engine', plan, options: { ...input.request, plan, mode: input.mode } },
    })
  }

  /**
   * Start the local upgrade, or a local blue-green deploy, whichever the
   * install layout supports.
   *
   * A flat install (gateway) has no release symlink to switch: the package's
   * own `upgrade-local.sh` copies the new tree over it. A blue-green install
   * upgrades exactly like a member, using a local runner instead of SSH.
   * @param {{member: object, packagePath: string, os: string, mode: 'install'|'upgrade', identity: object}} input target.
   * @returns {Promise<object>} queued job and its layout.
   */
  async #startLocalJob(input) {
    const install = this.#localAppRoot()
    if (install === null) {
      throw new Error('本机没有可识别的 dsh-mesh 安装目录（找不到 config/gate.env），无法升级本机')
    }
    if (input.os === 'windows' && install.layout === 'flat') {
      throw new Error('本机是 Linux 网关，不能安装 Windows 部署包')
    }
    if (install.layout === 'flat') {
      const job = await this.#queueJob({
        mode: input.mode,
        member: 'local',
        plan: null,
        request: { kind: 'inplace', inplace: { package: input.packagePath, appRoot: install.appRoot } },
        target: { host: '127.0.0.1', user: os.userInfo().username, port: null, os: 'linux', appRoot: install.appRoot },
        services: ['dsh-web-app.service', 'dsh-web-gate.service', 'dsh-wireguard-control.service', 'dsh-interop.service'],
        packagePath: input.packagePath,
        release: path.basename(input.packagePath),
      })
      return { ok: true, job, member: input.identity, packagePath: input.packagePath, layout: 'flat' }
    }
    const job = await this.#startEngineJob({
      request: { host: '127.0.0.1', local: true, package: input.packagePath, os: input.os, appRoot: install.appRoot, member: input.member.id },
      member: input.member.id,
      mode: input.mode,
    })
    return { ok: true, job, member: input.identity, packagePath: input.packagePath, layout: 'bluegreen' }
  }

  /**
   * Write one queued job directory and spawn its detached runner.
   * @param {{mode: string, member: string|null, plan: object|null, request: object, target?: object, services?: string[], packagePath?: string, release?: string}} job job input.
   * @returns {Promise<object>} queued job state.
   */
  async #queueJob(job) {
    const id = newJobId()
    const dir = path.join(this.deployRoot, id)
    await mkdir(dir, { recursive: true })
    const now = new Date().toISOString()
    const bytes = job.plan?.package?.bytes ?? (await stat(job.packagePath).catch(() => null))?.size ?? 0
    const state = {
      id,
      mode: job.mode,
      createdAt: now,
      updatedAt: now,
      member: job.member,
      target: job.plan === null
        ? job.target
        : { host: job.plan.host, user: job.plan.user ?? null, port: job.plan.port, os: job.plan.os, appRoot: job.plan.appRoot },
      release: job.plan?.release ?? job.release ?? 'local',
      package: job.plan?.package?.path ?? job.packagePath ?? null,
      services: job.plan === null ? (job.services ?? []) : job.plan.services.map(service => service.name),
      status: 'queued',
      phase: 'starting',
      error: null,
      steps: initialDeploySteps({ test: job.plan?.test === true, os: job.plan?.os }),
      progress: { label: '启动独立升级进程', percent: 0, bytes: 0, totalBytes: bytes, speed: 0, indeterminate: false },
    }
    await writeDeployState(dir, state)
    const requestFile = jobPaths(dir).request
    await writeFile(requestFile, `${JSON.stringify({ ...job.request, id, member: job.member }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    const spawned = await this.spawnRunner(dir, id)
    await appendDeployLog(dir, `job queued; runner ${spawned.mode}${spawned.unit === null ? '' : ` (${spawned.unit})`}`)
    this.logLine(`mesh ${job.mode} job ${id} queued for ${state.target.host} via ${spawned.mode}`)
    return state
  }

  /**
   * Start the detached runner for one job.
   *
   * `systemd-run` is preferred: a service restart kills its whole cgroup, so a
   * plain detached child of dsh-web would not survive the very restart it is
   * deploying. The transient unit puts the runner in its own cgroup; when
   * systemd is unavailable the plain detached spawn still survives the parent.
   * @param {string} dir job directory.
   * @param {string} id job id.
   * @returns {Promise<{mode: string, unit: string|null}>} how it was started.
   */
  async #spawnRunner(dir, id) {
    const script = path.join(this.repositoryRoot, 'code', 'deploy', 'runner.mjs')
    if (!existsSync(script)) throw new Error(`deploy runner is missing: ${script}`)
    const node = process.execPath
    const unit = `dsh-mesh-job-${id.replace(/^deploy-/u, '')}`
    const systemdRun = ['/usr/bin/systemd-run', '/bin/systemd-run'].find(file => existsSync(file))
    if (systemdRun !== undefined && process.platform === 'linux' && process.getuid?.() === 0) {
      const result = await new Promise(resolve => {
        const child = spawn(systemdRun, [
          '--unit', unit,
          '--collect',
          '--description', `dsh-mesh ${id}`,
          '--setenv', `DSH_MESH_JOB_UNIT=${unit}`,
          node, script, '--job', dir,
        ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
        let stderr = ''
        child.stderr.on('data', chunk => { stderr += String(chunk) })
        child.once('error', error => resolve({ ok: false, detail: error.message }))
        child.once('exit', code => resolve({ ok: code === 0, detail: stderr.trim() }))
      })
      if (result.ok) return { mode: 'systemd-run', unit }
      await appendDeployLog(dir, `systemd-run failed, falling back to a detached process: ${result.detail}`)
    }
    const child = spawn(node, [script, '--job', dir], {
      cwd: this.repositoryRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, DSH_MESH_JOB_UNIT: '' },
    })
    child.unref()
    return { mode: 'detached', unit: null }
  }

  /**
   * Locate the install that owns this plugin.
   * @returns {{appRoot: string, layout: 'flat'|'bluegreen'}|null} install, or null in a source checkout.
   */
  #localAppRoot() {
    let candidate = path.resolve(this.repositoryRoot, '..')
    for (let depth = 0; depth < 5; depth += 1) {
      const parent = path.dirname(candidate)
      const current = path.join(parent, 'current')
      if (existsSync(current)) {
        try {
          if (realpathSync(candidate) === realpathSync(current)) return { appRoot: parent, layout: 'bluegreen' }
        } catch {
          // Fall through to the flat-install checks.
        }
      }
      if (existsSync(path.join(candidate, 'current')) && existsSync(path.join(candidate, 'releases'))) {
        return { appRoot: candidate, layout: 'bluegreen' }
      }
      if (existsSync(path.join(candidate, 'config', 'gate.env')) && existsSync(path.join(candidate, 'plugins', 'dsh-mesh'))) {
        return { appRoot: candidate, layout: 'flat' }
      }
      if (parent === candidate) break
      candidate = parent
    }
    return null
  }

  /**
   * Empty one finished build job's log.
   * @param {string} id job id.
   * @returns {Promise<{ok: boolean, id: string}>} result.
   */
  async clearBuildLog(id) {
    const dir = this._jobDir(id)
    const state = await readState(dir).catch(() => null)
    if (state === null) throw new Error(`build job not found: ${id}`)
    if (this.running.has(state.id) || state.status === 'running') {
      throw new Error('编译还在运行，结束后再清空日志')
    }
    await writeFile(path.join(dir, 'build.log'), '', 'utf8')
    return { ok: true, id: state.id }
  }

  /**
   * Drop every finished build job: its record, its log and its worktree.
   *
   * Truncating `build.log` alone looked like a no-op in the panel, because the
   * row stayed in the table. The bulk action now deletes the job directory, so
   * the list really goes back to empty; the archives themselves were already
   * copied to `~/.dsh/packages`, which this never touches. A running or queued
   * job is left alone.
   * @returns {Promise<{ok: boolean, cleared: string[]}>} cleared job ids.
   */
  async clearFinishedBuilds() {
    const cleared = []
    const entries = await readdir(this.jobRoot, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(this.jobRoot, entry.name)
      const state = await readState(dir).catch(() => null)
      if (state === null) continue
      if (this.running.has(state.id) || state.status === 'running' || state.status === 'queued') continue
      await rm(dir, { recursive: true, force: true })
      cleared.push(state.id)
    }
    return { ok: true, cleared }
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
    // A member reports the release it runs from; the deploy needs the root.
    let appRoot = normalizeInstallRoot(system?.appRoot) || undefined
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
   * Roll one discovered member back to the release it ran before the last
   * deploy.
   *
   * This is the escape hatch for "the upgrade came up broken": the panel that
   * started the upgrade is still alive (it is a different machine), so it can
   * put the member back without a shell. A flat install has no blue-green
   * `previous`, so it is refused with a pointer at its upgrade backup.
   * @param {{member: string}} request member id, VPN address, or name.
   * @returns {Promise<object>} rollback job.
   */
  async rollbackMember({ member = '' } = {}) {
    if (member === '') throw new Error('which member should roll back?')
    const snapshot = await this.members()
    const everyone = [snapshot.local, ...snapshot.members].filter(entry => entry !== null && entry !== undefined)
    const found = everyone.find(entry => entry.id === member || entry.name === member || entry.ip === member)
    if (found === undefined) throw new Error(`member not found: ${member}`)
    if (found.kind === 'self') {
      throw new Error('本机是平铺安装，没有 blue-green 的上一版可切；回滚用 .upgrade-backup 里的备份恢复')
    }
    if (found.dsh !== true) {
      throw new Error(`成员 ${found.name} 的网关没有应答，无法在线回滚；SSH 上去执行 code/deploy/cli.mjs rollback`)
    }
    const os = String(found.system?.platform ?? '').toLowerCase().startsWith('win') ? 'windows' : 'linux'
    const request = await this.#memberDeployRequest(found, '', os)
    const rolled = await this.deploy.rollback({ ...request, os, skipPackage: true })
    // `DeployManager.rollback` answers `{ ok, job }`; the route hands the client
    // the same `{ ok, job, member }` shape the upgrade route uses.
    return { ok: true, job: rolled.job ?? rolled, member: found }
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
