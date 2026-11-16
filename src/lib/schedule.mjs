/**
 * Timed build and per-member timed upgrade policy.
 *
 * There are two independent clocks: one build at 04:00, and one auto-upgrade
 * per member at 06:00 by default. Both are deliberately conservative:
 *
 * - the build only starts when DSH, dsh-mesh, or a bundled plugin (xl) really
 *   changed compared with the most recent finished build;
 * - a member upgrade only touches that member when its current deployment
 *   differs from the newest package for its OS.
 *
 * `upgrade` is the default for members without an override; `upgrades` holds
 * the per-member settings the "自动升级" dialog writes.
 *
 * The pure helpers are separated from the timer so the decisions can be tested
 * without sleeping until four in the morning.
 *
 * @module @local/dsh-mesh/schedule
 */

import path from 'node:path'

/** Build default: before sunrise. */
export const DEFAULT_BUILD_SCHEDULE = Object.freeze({ enabled: true, time: '04:00' })
/** Auto-upgrade default for a member without its own override. */
export const DEFAULT_UPGRADE_SCHEDULE = Object.freeze({ enabled: true, time: '06:00' })

/** A clock value used by the panel and the scheduler. */
export function parseClock(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim())
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null
  return { hour, minute }
}

/** Format an hour/minute pair as `HH:MM`. */
export function formatClock(clock) {
  const hour = clock?.hour
  const minute = clock?.minute
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return ''
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** Normalize one `{enabled, time}` entry, falling back to its default. */
function normalizeEntry(value, fallback) {
  const source = value !== null && typeof value === 'object' ? value : {}
  const parsed = parseClock(source.time)
  const time = parsed === null ? fallback.time : formatClock(parsed)
  return { enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled, time }
}

/** Normalize the single build schedule. */
export function normalizeBuildSchedule(value) {
  return normalizeEntry(value, DEFAULT_BUILD_SCHEDULE)
}

/** Normalize one member's auto-upgrade entry. */
export function normalizeUpgradeSchedule(value) {
  return normalizeEntry(value, DEFAULT_UPGRADE_SCHEDULE)
}

/**
 * Normalize a persisted or client-supplied schedule object.
 *
 * Format 1 stored one global `upgrade`; it is still read as the default so an
 * existing install keeps its 06:00 setting after the per-member change.
 * @param {unknown} value raw schedule.
 * @returns {{build: {enabled: boolean, time: string}, upgrade: {enabled: boolean, time: string}, upgrades: Record<string, {enabled: boolean, time: string}>}} normalized schedules.
 */
export function normalizeSchedules(value) {
  const source = value !== null && typeof value === 'object' ? value : {}
  const upgrades = {}
  const raw = source.upgrades !== null && typeof source.upgrades === 'object' ? source.upgrades : {}
  for (const [memberId, entry] of Object.entries(raw)) {
    if (typeof memberId === 'string' && memberId !== '' && entry !== null && typeof entry === 'object') {
      upgrades[memberId] = normalizeUpgradeSchedule(entry)
    }
  }
  return {
    build: normalizeBuildSchedule(source.build),
    upgrade: normalizeUpgradeSchedule(source.upgrade),
    upgrades,
  }
}

/**
 * The effective auto-upgrade entry for one member.
 * @param {{upgrade: object, upgrades: Record<string, object>}} schedules normalized schedules.
 * @param {string} memberId member id.
 * @returns {{enabled: boolean, time: string}} entry.
 */
export function upgradeEntryFor(schedules, memberId) {
  const entry = schedules?.upgrades?.[memberId]
  return entry !== null && typeof entry === 'object' ? entry : schedules?.upgrade ?? DEFAULT_UPGRADE_SCHEDULE
}

/**
 * The next local-time occurrence of a daily clock value, strictly after `at`.
 * @param {Date} at reference instant.
 * @param {string} time `HH:MM`.
 * @returns {Date} next occurrence.
 */
export function nextRunAt(at, time) {
  const clock = parseClock(time) ?? parseClock(DEFAULT_BUILD_SCHEDULE.time)
  const next = new Date(at.getTime())
  next.setHours(clock.hour, clock.minute, 0, 0)
  if (next.getTime() <= at.getTime()) next.setDate(next.getDate() + 1)
  return next
}

/**
 * Version/build stamp/os encoded in a deployed archive name.
 *
 * `dsh-mesh-<version>-<YYYYMMDD><Letter>-<os>-<arch>.(tar.gz|zip)`.
 * @param {string} name archive file name.
 * @returns {{version: string, buildStamp: string, os: 'linux'|'windows'|null}|null} parsed name.
 */
export function packageInfo(name) {
  if (typeof name !== 'string') return null
  const match = /^dsh-mesh-(.+)-(\d{8}[A-Z]+)-(linux|win(?:dows)?)-(?:x64|arm64)\.(?:tar\.gz|tgz|zip)$/u.exec(name)
  if (match === null) return null
  return {
    version: match[1],
    buildStamp: match[2],
    os: match[3].startsWith('win') ? 'windows' : 'linux',
  }
}

/**
 * Numeric rank of a daily build stamp (`YYYYMMDD` + Excel-style letters).
 *
 * Plain string comparison would put `20261116Z` after `20261116AA`, but AA is
 * the next build after Z. The letters are base-26 with A=1.
 * @param {string} stamp build stamp.
 * @returns {{date: number, letter: number}|null} rank, or null when malformed.
 */
function stampRank(stamp) {
  const match = /^(\d{8})([A-Z]+)$/u.exec(String(stamp ?? ''))
  if (match === null) return null
  let letter = 0
  for (const char of match[2]) letter = letter * 26 + (char.charCodeAt(0) - 64)
  return { date: Number(match[1]), letter }
}

/**
 * Compare two build stamps in build order.
 * @param {string} left first stamp.
 * @param {string} right second stamp.
 * @returns {number} negative when left is older.
 */
export function compareBuildStamps(left, right) {
  const a = stampRank(left)
  const b = stampRank(right)
  if (a === null || b === null) return String(left ?? '').localeCompare(String(right ?? ''))
  if (a.date !== b.date) return a.date - b.date
  return a.letter - b.letter
}

/**
 * Choose the newest package for each OS.
 *
 * Build stamps are the ordering key because a copied archive can have a newer
 * mtime without being a newer build. Unparseable names fall back to mtime.
 * @param {{name: string, mtime?: string, target?: string}[]} packages package list.
 * @returns {{linux?: object, windows?: object}} newest package per OS.
 */
export function latestPackagesByOs(packages) {
  const latest = {}
  for (const item of Array.isArray(packages) ? packages : []) {
    const parsed = packageInfo(item.name)
    const os = parsed?.os ?? (item.target === 'windows' ? 'windows' : item.target === 'linux' ? 'linux' : null)
    if (os === null) continue
    const current = latest[os]
    if (current === undefined) {
      latest[os] = item
      continue
    }
    const currentInfo = packageInfo(current.name)
    if (parsed !== null && currentInfo !== null) {
      if (compareBuildStamps(parsed.buildStamp, currentInfo.buildStamp) > 0) latest[os] = item
    } else if (String(item.mtime ?? '') > String(current.mtime ?? '')) {
      latest[os] = item
    }
  }
  return latest
}

/** Deployment facts from a member row, whichever field carries them. */
export function memberDeployment(member) {
  const direct = member?.deployment
  if (direct !== null && typeof direct === 'object') return direct
  const nested = member?.gate?.deployment
  return nested !== null && typeof nested === 'object' ? nested : null
}

/**
 * Compare a member's current deployment with the newest package for its OS.
 * @param {object} deployment current deployment.
 * @param {{name: string, mtime?: string, target?: string}} candidate package.
 * @returns {{needed: boolean, reason: string}} decision.
 */
export function shouldUpgrade(deployment, candidate) {
  const parsed = packageInfo(candidate?.name)
  if (parsed === null) return { needed: true, reason: '部署包名称无法解析版本，按需要升级处理' }
  const currentStamp = typeof deployment?.buildStamp === 'string' ? deployment.buildStamp : ''
  if (currentStamp !== '') {
    const order = compareBuildStamps(parsed.buildStamp, currentStamp)
    if (order === 0) return { needed: false, reason: '已经是这个部署包' }
    if (order < 0) return { needed: false, reason: '最新包的构建号比当前部署旧' }
    return { needed: true, reason: `${currentStamp} → ${parsed.buildStamp}` }
  }
  const currentVersion = typeof deployment?.version === 'string' ? deployment.version : ''
  if (currentVersion !== '' && currentVersion === parsed.version) {
    return { needed: false, reason: `已经是 ${parsed.version}` }
  }
  return { needed: true, reason: `升级到 ${parsed.buildStamp}` }
}

/**
 * One member's OS, normalized to the package spelling.
 * @param {object} member member row.
 * @returns {'linux'|'windows'} OS.
 */
export function memberOs(member) {
  const platform = String(member?.system?.platform ?? member?.gate?.system?.platform ?? '').toLowerCase()
  if (platform.startsWith('win')) return 'windows'
  if (platform.startsWith('linux')) return 'linux'
  const target = String(memberDeployment(member)?.target?.os ?? '').toLowerCase()
  return target.startsWith('win') ? 'windows' : 'linux'
}

/**
 * Plan which members the 06:00 upgrade should touch.
 *
 * Peers are returned first and the local gateway last: a local upgrade
 * restarts this DSH process, so the jobs that must survive it are started
 * before it. Members without deployment facts or without a package for their
 * OS are skipped with a reason the panel can show.
 * @param {object[]} members local + peers.
 * @param {{name: string, mtime?: string, target?: string}[]} packages package list.
 * @returns {{upgrades: Array<{member: object, package: object}>, skipped: Array<{member: object, reason: string}>}} plan.
 */
export function planUpgrades(members, packages) {
  const latest = latestPackagesByOs(packages)
  const upgrades = []
  const skipped = []
  const rows = (Array.isArray(members) ? members : []).filter(Boolean)
  const ordered = [
    ...rows.filter(member => member.id !== 'local' && member.kind !== 'self'),
    ...rows.filter(member => member.id === 'local' || member.kind === 'self'),
  ]
  for (const member of ordered) {
    const deployment = memberDeployment(member)
    if (deployment === null) {
      skipped.push({ member, reason: '读不到当前部署' })
      continue
    }
    if (member.online === false) {
      skipped.push({ member, reason: '离线' })
      continue
    }
    const os = memberOs(member)
    const candidate = latest[os]
    if (candidate === undefined) {
      skipped.push({ member, reason: `没有 ${os === 'windows' ? 'Windows' : 'Linux'} 部署包` })
      continue
    }
    const decision = shouldUpgrade(deployment, candidate)
    if (decision.needed) upgrades.push({ member, package: candidate })
    else skipped.push({ member, reason: decision.reason })
  }
  return { upgrades, skipped }
}

/**
 * Compare the newest finished build with the current source inputs.
 *
 * A missing field counts as changed: the first scheduled build after an older
 * package format must produce a package that carries the new metadata.
 * @param {{latestManifest: object|null, current: {source: string, ref: string, sourceEtag: string|null, pluginFingerprint: string|null, extraPlugins: Array<{name: string, etag: string|null}>}}} input comparison input.
 * @returns {string[]} human-readable reasons; empty means nothing changed.
 */
export function buildUpdateReasons(input) {
  const latest = input.latestManifest
  const current = input.current
  if (latest === null || typeof latest !== 'object') return ['还没有带版本信息的编译任务']
  const reasons = []
  if (latest.source !== current.source || latest.ref !== current.ref) {
    reasons.push('源码或引用变了')
  }
  if (latest.sourceEtag === undefined || latest.sourceEtag === null || current.sourceEtag === null) {
    reasons.push('无法确认 DSH 源码版本')
  } else if (latest.sourceEtag !== current.sourceEtag) {
    reasons.push('DSH 源码有更新')
  }
  const plugin = latest.plugin
  if (plugin === null || typeof plugin !== 'object' || typeof plugin.fingerprint !== 'string' || current.pluginFingerprint === null) {
    reasons.push('无法确认 dsh-mesh 版本')
  } else if (plugin.fingerprint !== current.pluginFingerprint) {
    reasons.push('dsh-mesh 有更新')
  }
  const latestPlugins = Array.isArray(latest.extraPlugins) ? latest.extraPlugins : []
  for (const entry of current.extraPlugins) {
    const previous = latestPlugins.find(item => item?.name === entry.name)
    const previousEtag = typeof previous?.archiveEtag === 'string' ? previous.archiveEtag : ''
    if (previousEtag === '' || entry.etag === null) reasons.push(`${entry.name} 有更新`)
    else if (previousEtag !== entry.etag) reasons.push(`${entry.name} 有更新`)
  }
  return reasons
}

/**
 * The display name for one schedule kind.
 * @param {'build'|'upgrade'} kind schedule kind.
 * @returns {string} Chinese label.
 */
export function scheduleLabel(kind) {
  return kind === 'upgrade' ? '定时升级' : '定时编译'
}

/** A stable, absolute path for the schedule file. */
export function scheduleFile(dataDir) {
  return path.join(dataDir, 'schedule.json')
}
