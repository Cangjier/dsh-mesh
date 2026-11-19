/**
 * The wall clock behind the build timer and the per-member auto-upgrade.
 *
 * `MeshService` owns the decisions (is anything new? is this member behind?);
 * this class only reads the persisted settings, waits for the next local-time
 * occurrence, calls the matching service hook, and records what happened.
 * Keeping the timer here means a panel tab, a browser, or a session is not
 * required for either job to run.
 *
 * Per-member upgrades share one timer: the earliest enabled occurrence wins,
 * and every member whose own time is due is started in that tick.
 *
 * @module @local/dsh-mesh/scheduler
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_BUILD_SCHEDULE,
  SCHEDULE_FORMAT,
  formatClock,
  migrateSchedules,
  nextRunAt,
  normalizeBuildSchedule,
  normalizeSchedules,
  normalizeUpgradeSchedule,
  parseClock,
  upgradeEntryFor,
} from './schedule.mjs'

/** How late a tick may still count as the scheduled occurrence. */
const TICK_TOLERANCE_MS = 90_000
/** Do not run the same kind twice within this window after a restart. */
const DUPLICATE_WINDOW_MS = 10 * 60_000

/**
 * One persistent daily scheduler.
 */
export class Scheduler {
  /**
   * @param {object} options scheduler input.
   * @param {{ scheduledBuild: () => Promise<object>, scheduledUpgradeMember: (memberId: string) => Promise<object> }} options.service mesh service.
   * @param {string} options.file `schedule.json` path.
   * @param {() => Promise<string[]>} [options.members] current member id provider.
   * @param {(line: string) => void} [options.log] logger.
   * @param {() => number} [options.now] clock (tests).
   * @param {typeof setTimeout} [options.setTimeout] timer factory (tests).
   * @param {typeof clearTimeout} [options.clearTimeout] timer canceller (tests).
   * @param {boolean} [options.autoStart] arm on construction; default true.
   */
  constructor(options) {
    this.service = options.service
    this.file = options.file
    this.memberIdProvider = typeof options.members === 'function' ? options.members : null
    this.log = typeof options.log === 'function' ? options.log : () => {}
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.setTimer = options.setTimeout ?? setTimeout
    this.clearTimer = options.clearTimeout ?? clearTimeout
    this.schedule = normalizeSchedules({})
    /** @type {Map<string, object>} */
    this.upgrades = new Map()
    /** @type {{build: object|null, upgrades: Record<string, object>}} */
    this.last = { build: null, upgrades: {} }
    /** @type {Set<string>} */
    this.runningUpgrades = new Set()
    this.runningBuild = false
    /** @type {string[]} */
    this.memberIds = []
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.timer = null
    /** @type {boolean} */
    this.disposed = false
    /** @type {Promise<void>|null} */
    this.loading = null
    if (options.autoStart !== false) void this.start()
  }

  /**
   * Read the persisted schedule, discover members, and arm the timer.
   * @returns {Promise<void>} when armed.
   */
  async start() {
    await this.#load()
    await this.#refreshMembers()
    this.#arm()
  }

  /**
   * Merge one client update and re-arm immediately.
   *
   * Either the build clock (`{build}`) or one member's auto-upgrade
   * (`{member, upgrade}`) is updated per call.
   * @param {{build?: {enabled?: boolean, time?: string}, member?: string, upgrade?: {enabled?: boolean, time?: string}}} patch schedule patch.
   * @returns {Promise<object>} new status (build or the member's entry).
   */
  async update(patch) {
    const memberId = typeof patch?.member === 'string' ? patch.member.trim() : ''
    if (memberId !== '') {
      const entry = normalizeUpgradeSchedule({
        ...upgradeEntryFor(this.schedule, memberId),
        ...(patch?.upgrade ?? {}),
      })
      this.upgrades.set(memberId, entry)
      if (!this.memberIds.includes(memberId)) this.memberIds.push(memberId)
    } else if (patch?.build !== undefined) {
      this.schedule.build = normalizeBuildSchedule({ ...this.schedule.build, ...(patch.build ?? {}) })
    }
    this.schedule = {
      ...this.schedule,
      upgrades: Object.fromEntries(this.upgrades),
    }
    await this.#save()
    this.#arm()
    this.log(`schedule saved: build ${this.schedule.build.time} ${this.schedule.build.enabled ? 'on' : 'off'}${memberId === '' ? '' : `, upgrade ${memberId} ${this.upgrades.get(memberId)?.time} ${this.upgrades.get(memberId)?.enabled ? 'on' : 'off'}`}`)
    return this.status(memberId === '' ? undefined : memberId)
  }

  /**
   * The panel's read model.
   * @param {string} [memberId] when set, include that member's auto-upgrade.
   * @returns {object} status.
   */
  status(memberId) {
    const at = new Date(this.now())
    const result = {
      ok: true,
      build: this.#statusEntry(this.schedule.build, 'build', undefined, at),
    }
    if (typeof memberId === 'string' && memberId !== '') {
      result.upgrade = this.#statusEntry(upgradeEntryFor(this.schedule, memberId), 'upgrade', memberId, at)
    }
    return result
  }

  /** Stop the timer. */
  dispose() {
    this.disposed = true
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
  }

  /** Build one status row with next occurrence and last outcome. */
  #statusEntry(entry, kind, memberId, at) {
    const last = kind === 'build' ? this.last.build : this.last.upgrades[memberId] ?? null
    return {
      enabled: entry.enabled,
      time: entry.time,
      next: entry.enabled ? nextRunAt(at, entry.time).toISOString() : null,
      last,
      running: kind === 'build' ? this.runningBuild : this.runningUpgrades.has(memberId),
      ...(memberId === undefined ? {} : { member: memberId }),
    }
  }

  /** Read the schedule file once. */
  async #load() {
    if (this.loading !== null) return this.loading
    this.loading = (async () => {
      try {
        const parsed = JSON.parse(await readFile(this.file, 'utf8'))
        const normalized = migrateSchedules(parsed)
        this.schedule = normalized
        this.upgrades = new Map(Object.entries(normalized.upgrades))
        if (parsed?.last !== null && typeof parsed?.last === 'object') {
          this.last = {
            build: typeof parsed.last.build === 'object' ? parsed.last.build : null,
            upgrades: parsed.last.upgrades !== null && typeof parsed.last.upgrades === 'object' ? parsed.last.upgrades : {},
          }
        }
        // Rewrite a legacy file once so the next read sees the new format even
        // when the in-memory migration was the only change.
        if (parsed?.format !== SCHEDULE_FORMAT) await this.#save()
      } catch {
        // First run (or a corrupt file): keep the documented defaults.
      }
    })()
    return this.loading
  }

  /** Persist the current settings and last outcomes. */
  async #save() {
    try {
      await mkdir(path.dirname(this.file), { recursive: true })
      await writeFile(this.file, `${JSON.stringify({
        format: SCHEDULE_FORMAT,
        build: this.schedule.build,
        upgrade: this.schedule.upgrade,
        upgrades: Object.fromEntries(this.upgrades),
        last: this.last,
      }, null, 2)}\n`, 'utf8')
    } catch (error) {
      this.log(`cannot save schedule: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Ask the service who exists now; a failure keeps the previous list. */
  async #refreshMembers() {
    if (this.memberIdProvider === null) return
    try {
      const ids = await this.memberIdProvider()
      const unique = [...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id !== ''))]
      if (unique.length > 0) this.memberIds = unique
    } catch {
      // Keep the previous list; the next tick retries.
    }
  }

  /** One timer for the nearest enabled occurrence. */
  #arm() {
    if (this.disposed) return
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    const at = new Date(this.now())
    const candidates = []
    if (this.schedule.build.enabled) {
      candidates.push({ kind: 'build', memberId: undefined, at: nextRunAt(at, this.schedule.build.time) })
    }
    const ids = [...new Set([...this.memberIds, ...this.upgrades.keys()])]
    for (const memberId of ids) {
      const entry = upgradeEntryFor(this.schedule, memberId)
      if (!entry.enabled) continue
      candidates.push({ kind: 'upgrade', memberId, at: nextRunAt(at, entry.time) })
    }
    if (candidates.length === 0) return
    candidates.sort((left, right) => left.at.getTime() - right.at.getTime())
    const next = candidates[0]
    const delay = Math.max(0, next.at.getTime() - at.getTime())
    this.timer = this.setTimer(() => {
      this.timer = null
      void this.#tick()
    }, delay)
    if (typeof this.timer?.unref === 'function') this.timer.unref()
    this.log(`next ${next.kind}${next.memberId === undefined ? '' : ` ${next.memberId}`} at ${next.at.toISOString()}`)
  }

  /** Run every occurrence due in this tick, then re-arm. */
  async #tick() {
    if (this.disposed) return
    await this.#refreshMembers()
    const at = new Date(this.now())
    try {
      if (this.schedule.build.enabled && this.#isDue(this.schedule.build.time, at)) {
        if (!this.#recentlyRan(this.last.build)) await this.#runBuild()
      }
      for (const memberId of [...new Set([...this.memberIds, ...this.upgrades.keys()])]) {
        const entry = upgradeEntryFor(this.schedule, memberId)
        if (!entry.enabled || !this.#isDue(entry.time, at)) continue
        if (this.runningUpgrades.has(memberId)) continue
        if (this.#recentlyRan(this.last.upgrades[memberId])) continue
        await this.#runUpgrade(memberId)
      }
    } finally {
      this.#arm()
    }
  }

  /** Whether a daily clock occurrence is within the tick window. */
  #isDue(time, at) {
    const base = new Date(at.getTime() - 24 * 60 * 60_000)
    const due = nextRunAt(base, time)
    return Math.abs(due.getTime() - at.getTime()) <= TICK_TOLERANCE_MS
  }

  /** Whether this kind already ran within the duplicate window. */
  #recentlyRan(last) {
    const at = last?.at
    return typeof at === 'string' && Math.abs(this.now() - Date.parse(at)) < DUPLICATE_WINDOW_MS
  }

  /** Run the build hook and record the outcome. */
  async #runBuild() {
    if (this.runningBuild) return
    this.runningBuild = true
    const at = new Date(this.now()).toISOString()
    try {
      this.log(`build tick at ${at}`)
      const result = await this.service.scheduledBuild()
      this.last.build = { at, ...(result !== null && typeof result === 'object' ? result : { status: 'unknown' }) }
      await this.#save()
      this.log(`build: ${String(this.last.build.status ?? 'unknown')}${this.last.build.reason ? ` (${String(this.last.build.reason)})` : ''}`)
    } catch (error) {
      this.last.build = { at, status: 'failed', reason: error instanceof Error ? error.message : String(error) }
      await this.#save()
      this.log(`build failed: ${String(this.last.build.reason)}`)
    } finally {
      this.runningBuild = false
    }
  }

  /** Run one member's upgrade hook and record the outcome. */
  async #runUpgrade(memberId) {
    if (this.runningUpgrades.has(memberId)) return
    this.runningUpgrades.add(memberId)
    const at = new Date(this.now()).toISOString()
    try {
      this.log(`upgrade ${memberId} tick at ${at}`)
      const result = await this.service.scheduledUpgradeMember(memberId)
      this.last.upgrades[memberId] = { at, ...(result !== null && typeof result === 'object' ? result : { status: 'unknown' }) }
      await this.#save()
      this.log(`upgrade ${memberId}: ${String(this.last.upgrades[memberId].status ?? 'unknown')}${this.last.upgrades[memberId].reason ? ` (${String(this.last.upgrades[memberId].reason)})` : ''}`)
    } catch (error) {
      this.last.upgrades[memberId] = { at, status: 'failed', reason: error instanceof Error ? error.message : String(error) }
      await this.#save()
      this.log(`upgrade ${memberId} failed: ${String(this.last.upgrades[memberId].reason)}`)
    } finally {
      this.runningUpgrades.delete(memberId)
    }
  }
}

/**
 * Read a schedule file without constructing a timer (CLI/tests).
 * @param {string} file schedule file.
 * @returns {Promise<{schedule: object, upgrades: Record<string, object>, last: object}>} persisted values.
 */
export async function readScheduleFile(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    const schedule = migrateSchedules(parsed)
    return {
      schedule,
      upgrades: schedule.upgrades,
      last: {
        build: typeof parsed?.last?.build === 'object' ? parsed.last.build : null,
        upgrades: parsed?.last?.upgrades !== null && typeof parsed?.last?.upgrades === 'object' ? parsed.last.upgrades : {},
      },
    }
  } catch {
    return {
      schedule: normalizeSchedules({}),
      upgrades: {},
      last: { build: null, upgrades: {} },
    }
  }
}

/**
 * Format an `HH:MM` clock value for logs and tool output.
 * @param {string} time clock.
 * @returns {string} normalized clock.
 */
export function showClock(time) {
  return formatClock(parseClock(time) ?? parseClock(DEFAULT_BUILD_SCHEDULE.time))
}

