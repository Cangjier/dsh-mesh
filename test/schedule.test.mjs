import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DEFAULT_BUILD_SCHEDULE,
  DEFAULT_UPGRADE_SCHEDULE,
  SCHEDULE_FORMAT,
  buildUpdateReasons,
  compareBuildStamps,
  latestPackagesByOs,
  migrateSchedules,
  nextRunAt,
  normalizeSchedules,
  packageInfo,
  parseClock,
  planMemberUpgrade,
  planUpgrades,
  shouldUpgrade,
  upgradeEntryFor,
} from '../src/lib/schedule.mjs'
import { Scheduler, readScheduleFile } from '../src/lib/scheduler.mjs'

const GiB = 1024 ** 3

/** One member row with the fields the planner reads. */
function member(id, options = {}) {
  return {
    id,
    name: options.name ?? id,
    online: options.online ?? true,
    kind: options.kind ?? (id === 'local' ? 'self' : 'peer'),
    system: { platform: options.platform ?? 'linux', arch: options.arch ?? 'x64' },
    deployment: options.deployment ?? { version: '0.2.2-rc.3', buildStamp: '20261116D' },
    gate: options.gate ?? null,
  }
}

/** One normalized `latest` release asset. */
function releaseAsset(name) {
  return {
    target: /win/iu.test(name) ? 'win-x64' : 'linux-x64',
    os: /win/iu.test(name) ? 'windows' : 'linux',
    arch: 'x64',
    name,
    bytes: 1024,
    sha256: 'a'.repeat(64),
    providers: ['gitee', 'github'],
  }
}

test('the build clock and per-member upgrades are off by default', () => {
  const schedule = normalizeSchedules({})
  assert.deepEqual(schedule.build, { enabled: false, time: '04:00' })
  assert.deepEqual(schedule.upgrade, { enabled: false, time: '06:00' })
  assert.deepEqual(schedule.upgrades, {})
  assert.equal(DEFAULT_BUILD_SCHEDULE.time, '04:00')
  assert.equal(DEFAULT_UPGRADE_SCHEDULE.time, '06:00')
  assert.equal(DEFAULT_BUILD_SCHEDULE.enabled, false)
  assert.equal(DEFAULT_UPGRADE_SCHEDULE.enabled, false)
  assert.deepEqual(upgradeEntryFor(schedule, '10.66.66.2'), { enabled: false, time: '06:00' })
})

test('legacy default-on schedules migrate to off without touching custom choices', () => {
  const migrated = migrateSchedules({
    format: 2,
    build: { enabled: true, time: '04:00' },
    upgrade: { enabled: true, time: '06:00' },
    upgrades: { '10.66.66.2': { enabled: true, time: '06:00' } },
  })
  assert.deepEqual(migrated.build, { enabled: false, time: '04:00' })
  assert.deepEqual(migrated.upgrade, { enabled: false, time: '06:00' })
  assert.deepEqual(migrated.upgrades['10.66.66.2'], { enabled: true, time: '06:00' })

  const custom = migrateSchedules({
    format: 2,
    build: { enabled: true, time: '05:30' },
    upgrade: { enabled: false, time: '06:00' },
  })
  assert.deepEqual(custom.build, { enabled: true, time: '05:30' })
  assert.deepEqual(custom.upgrade, { enabled: false, time: '06:00' })

  const current = migrateSchedules({
    format: SCHEDULE_FORMAT,
    build: { enabled: true, time: '04:00' },
    upgrade: { enabled: true, time: '06:00' },
  })
  assert.deepEqual(current.build, { enabled: true, time: '04:00' })
  assert.deepEqual(current.upgrade, { enabled: true, time: '06:00' })
})

test('per-member overrides win over the default upgrade entry', () => {
  const schedule = normalizeSchedules({
    upgrade: { enabled: true, time: '06:00' },
    upgrades: { '10.66.66.2': { enabled: false, time: '7:30' } },
  })
  assert.deepEqual(upgradeEntryFor(schedule, '10.66.66.2'), { enabled: false, time: '07:30' })
  assert.deepEqual(upgradeEntryFor(schedule, '10.66.66.3'), { enabled: true, time: '06:00' })
})

test('clock values are validated and normalized', () => {
  assert.deepEqual(parseClock('4:05'), { hour: 4, minute: 5 })
  assert.deepEqual(parseClock('23:59'), { hour: 23, minute: 59 })
  assert.equal(parseClock('24:00'), null)
  assert.equal(parseClock('4:5'), null)
  assert.equal(parseClock('04:00:00'), null)
  const changed = normalizeSchedules({ build: { enabled: false, time: '3:15' }, upgrade: { time: 'bad' } })
  assert.deepEqual(changed.build, { enabled: false, time: '03:15' })
  assert.deepEqual(changed.upgrade, { enabled: false, time: '06:00' })
})

test('nextRunAt rolls over to tomorrow after the clock passed', () => {
  const early = new Date('2026-11-16T03:30:00+08:00')
  const evening = new Date('2026-11-16T23:30:00+08:00')
  assert.equal(nextRunAt(early, '04:00').toISOString(), new Date('2026-11-16T04:00:00+08:00').toISOString())
  assert.equal(nextRunAt(evening, '04:00').toISOString(), new Date('2026-11-17T04:00:00+08:00').toISOString())
})

test('package names expose version, daily stamp, and OS', () => {
  assert.deepEqual(packageInfo('dsh-mesh-0.2.2-rc.3-20261116D-linux-x64.tar.gz'), {
    version: '0.2.2-rc.3',
    buildStamp: '20261116D',
    os: 'linux',
  })
  assert.equal(packageInfo('dsh-mesh-0.2.2-20261116AA-win-x64.zip')?.os, 'windows')
  assert.equal(packageInfo('notes.txt'), null)
})

test('build stamps order Z before AA', () => {
  assert.ok(compareBuildStamps('20261116A', '20261116B') < 0)
  assert.ok(compareBuildStamps('20261116Z', '20261116AA') < 0)
  assert.ok(compareBuildStamps('20261116AA', '20261116AB') < 0)
  assert.ok(compareBuildStamps('20261116Z', '20261117A') < 0)
  assert.equal(compareBuildStamps('20261116D', '20261116D'), 0)
})

test('the newest package per OS is ordered by build stamp, not mtime', () => {
  const latest = latestPackagesByOs([
    { name: 'dsh-mesh-0.2.2-rc.3-20261115A-linux-x64.tar.gz', mtime: '2026-11-16T10:00:00Z', target: 'linux' },
    { name: 'dsh-mesh-0.2.2-rc.3-20261116D-linux-x64.tar.gz', mtime: '2026-11-16T09:00:00Z', target: 'linux' },
    { name: 'dsh-mesh-0.2.2-rc.3-20261116Z-linux-x64.tar.gz', mtime: '2026-11-16T08:30:00Z', target: 'linux' },
    { name: 'dsh-mesh-0.2.2-rc.3-20261116AA-linux-x64.tar.gz', mtime: '2026-11-16T08:00:00Z', target: 'linux' },
    { name: 'dsh-mesh-0.2.2-rc.3-20261116D-win-x64.zip', mtime: '2026-11-16T08:00:00Z', target: 'windows' },
  ])
  assert.equal(latest.linux.name, 'dsh-mesh-0.2.2-rc.3-20261116AA-linux-x64.tar.gz')
  assert.equal(latest.windows.name, 'dsh-mesh-0.2.2-rc.3-20261116D-win-x64.zip')
})

test('shouldUpgrade skips the same stamp and refuses a downgrade', () => {
  const newer = { name: 'dsh-mesh-0.2.2-rc.3-20261117A-linux-x64.tar.gz' }
  assert.equal(shouldUpgrade({ version: '0.2.2-rc.3', buildStamp: '20261117A' }, newer).needed, false)
  assert.equal(shouldUpgrade({ version: '0.2.2-rc.3', buildStamp: '20261117B' }, newer).needed, false)
  assert.equal(shouldUpgrade({ version: '0.2.2-rc.3', buildStamp: '20261116D' }, newer).needed, true)
  assert.equal(shouldUpgrade({ version: '0.2.2-rc.3' }, { name: 'dsh-mesh-0.2.2-rc.3-20261116D-linux-x64.tar.gz' }).needed, false)
})

test('a plugin bundle is never an upgrade candidate', () => {
  const plugin = { name: 'dsh-mesh-plugin-0.2.0-20261123-1735.tgz', mtime: '2026-11-23T09:25:00Z', target: 'linux' }
  assert.equal(packageInfo(plugin.name), null)
  assert.deepEqual(latestPackagesByOs([plugin]), {})
  assert.equal(shouldUpgrade({ version: '0.2.2-rc.5', buildStamp: '20261122B' }, plugin).needed, false)
  const plan = planUpgrades([member('10.66.66.3')], [plugin])
  assert.equal(plan.upgrades.length, 0)
  assert.equal(plan.skipped[0].reason, '没有 Linux 部署包')
})

test('upgrade planning puts peers first, skips current members, and matches the OS', () => {
  const packages = [
    { name: 'dsh-mesh-0.2.2-rc.3-20261117A-linux-x64.tar.gz', mtime: '2026-11-17T04:30:00Z', target: 'linux' },
    { name: 'dsh-mesh-0.2.2-rc.3-20261117A-win-x64.zip', mtime: '2026-11-17T04:30:00Z', target: 'windows' },
  ]
  const local = member('local', { deployment: { version: '0.2.2-rc.3', buildStamp: '20261116D' } })
  const linuxPeer = member('10.66.66.2', { name: 'vm', deployment: { version: '0.2.2-rc.3', buildStamp: '20261116D' } })
  const windowsPeer = member('10.66.66.4', { name: 'desktop', platform: 'win32', deployment: { version: '0.2.2-rc.3', buildStamp: '20261117A' } })
  const plan = planUpgrades([local, linuxPeer, windowsPeer], packages)
  assert.deepEqual(plan.upgrades.map(entry => entry.member.id), ['10.66.66.2', 'local'])
  assert.equal(plan.upgrades[0].package.name, 'dsh-mesh-0.2.2-rc.3-20261117A-linux-x64.tar.gz')
  assert.equal(plan.upgrades[1].package.name, 'dsh-mesh-0.2.2-rc.3-20261117A-linux-x64.tar.gz')
  assert.deepEqual(plan.skipped.map(entry => entry.member.id), ['10.66.66.4'])
})

test('a scheduled upgrade falls back to the latest release when no local package matches', () => {
  const release = {
    ok: true,
    assets: [releaseAsset('dsh-mesh-0.2.3-alpha.2-20261125A-linux-x64.7z')],
  }
  const candidate = planMemberUpgrade(member('10.66.66.3'), [], release)
  assert.equal(candidate.source, 'release')
  assert.equal(candidate.target, 'linux-x64')
  assert.equal(candidate.package.name, 'dsh-mesh-0.2.3-alpha.2-20261125A-linux-x64.7z')
  assert.equal(candidate.reason, '20261116D → 20261125A')
})

test('a local package newer than the release stays the upgrade source', () => {
  const local = { name: 'dsh-mesh-0.2.3-alpha.2-20261126A-linux-x64.7z', mtime: '2026-11-26T04:00:00Z', target: 'linux' }
  const release = {
    ok: true,
    assets: [releaseAsset('dsh-mesh-0.2.3-alpha.2-20261125A-linux-x64.7z')],
  }
  const candidate = planMemberUpgrade(member('10.66.66.3'), [local], release)
  assert.equal(candidate.source, 'local')
  assert.equal(candidate.package, local)
  assert.equal(candidate.target, null)
})

test('the release candidate must match the member target and be newer', () => {
  const windowsOnly = { ok: true, assets: [releaseAsset('dsh-mesh-0.2.3-alpha.2-20261125A-win-x64.7z')] }
  assert.equal(planMemberUpgrade(member('10.66.66.3'), [], windowsOnly).reason, '没有 Linux 部署包')
  const arm = member('10.66.66.3', { arch: 'arm64' })
  assert.equal(planMemberUpgrade(arm, [], { ok: true, assets: [releaseAsset('dsh-mesh-0.2.3-alpha.2-20261125A-linux-x64.7z')] }).reason, '没有 Linux 部署包')
  const current = member('10.66.66.3', { deployment: { version: '0.2.3-alpha.2', buildStamp: '20261125A' } })
  assert.equal(planMemberUpgrade(current, [], { ok: true, assets: [releaseAsset('dsh-mesh-0.2.3-alpha.2-20261125A-linux-x64.7z')] }).reason, '已经是这个部署包')
  assert.equal(planMemberUpgrade(member('10.66.66.3', { online: false }), [], null).reason, '离线')
  assert.equal(planMemberUpgrade(member('10.66.66.3'), [], null).reason, '没有 Linux 部署包')
})

test('build update reasons mention each source that moved', () => {
  const current = {
    source: 'https://github.com/deepseek-ai/deepseek-harness',
    ref: 'master',
    sourceEtag: 'etag-dsh',
    pluginFingerprint: 'fp-dsh-mesh',
    extraPlugins: [{ name: 'xl', etag: 'etag-xl' }],
  }
  const latestManifest = {
    source: current.source,
    ref: current.ref,
    sourceEtag: 'etag-dsh',
    plugin: { fingerprint: 'fp-dsh-mesh' },
    extraPlugins: [{ name: 'xl', archiveEtag: 'etag-xl' }],
  }
  assert.deepEqual(buildUpdateReasons({ latestManifest, current }), [])
  assert.deepEqual(buildUpdateReasons({
    latestManifest,
    current: { ...current, sourceEtag: 'etag-dsh-new' },
  }), ['DSH 源码有更新'])
  assert.deepEqual(buildUpdateReasons({
    latestManifest,
    current: { ...current, pluginFingerprint: 'fp-new' },
  }), ['dsh-mesh 有更新'])
  assert.deepEqual(buildUpdateReasons({
    latestManifest,
    current: { ...current, extraPlugins: [{ name: 'xl', etag: 'etag-xl-new' }] },
  }), ['xl 有更新'])
  assert.deepEqual(buildUpdateReasons({ latestManifest: null, current }), ['还没有带版本信息的编译任务'])
})

test('the scheduler waits for 04:00 once the build clock is enabled', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-schedule-'))
  const file = path.join(dir, 'schedule.json')
  let now = new Date('2026-11-16T03:00:00+08:00').getTime()
  let timer = null
  let delay = 0
  const calls = []
  const scheduler = new Scheduler({
    file,
    service: {
      scheduledBuild: async () => { calls.push('build'); return { status: 'skipped', reason: '没有更新' } },
      scheduledUpgradeMember: async memberId => { calls.push(`upgrade:${memberId}`); return { status: 'skipped', reason: '已是最新' } },
    },
    members: async () => ['local', 'peer'],
    now: () => now,
    setTimeout: (fn, ms) => { timer = fn; delay = ms; return { unref() {} } },
    clearTimeout: () => { timer = null },
    autoStart: false,
  })
  try {
    await scheduler.start()
    assert.equal(timer, null)
    const armed = await scheduler.update({ build: { enabled: true } })
    assert.equal(armed.build.enabled, true)
    assert.equal(delay, 60 * 60 * 1000)
    assert.ok(timer !== null)
    now = new Date('2026-11-16T04:00:00+08:00').getTime()
    const fire = timer
    fire()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(calls, ['build'])
    assert.equal(scheduler.status().build.last.status, 'skipped')
    const saved = await readScheduleFile(file)
    assert.equal(saved.schedule.build.time, '04:00')
    assert.equal(saved.last.build.reason, '没有更新')
  } finally {
    scheduler.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('starting on a legacy schedule file rewrites it with both defaults off', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-schedule-'))
  const file = path.join(dir, 'schedule.json')
  await writeFile(file, JSON.stringify({
    format: 2,
    build: { enabled: true, time: '04:00' },
    upgrade: { enabled: true, time: '06:00' },
    upgrades: { peer: { enabled: true, time: '7:30' } },
    last: { build: { at: '2026-11-16T04:00:00+08:00', status: 'done' }, upgrades: {} },
  }))
  const scheduler = new Scheduler({
    file,
    service: {
      scheduledBuild: async () => ({ status: 'skipped' }),
      scheduledUpgradeMember: async memberId => ({ status: 'skipped', member: memberId }),
    },
    members: async () => ['local', 'peer'],
    autoStart: false,
  })
  try {
    await scheduler.start()
    assert.equal(scheduler.status().build.enabled, false)
    assert.equal(scheduler.status('local').upgrade.enabled, false)
    assert.equal(scheduler.status('peer').upgrade.enabled, true)
    assert.equal(scheduler.status('peer').upgrade.time, '07:30')
    assert.equal(scheduler.status().build.last.status, 'done')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.format, SCHEDULE_FORMAT)
    assert.equal(saved.build.enabled, false)
    assert.equal(saved.upgrade.enabled, false)
    assert.deepEqual(saved.upgrades.peer, { enabled: true, time: '07:30' })
    assert.equal(saved.last.build.status, 'done')
  } finally {
    scheduler.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('updating the build schedule persists it and disarms the clock', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-schedule-'))
  const file = path.join(dir, 'schedule.json')
  const calls = []
  const scheduler = new Scheduler({
    file,
    service: {
      scheduledBuild: async () => { calls.push('build'); return { status: 'skipped' } },
      scheduledUpgradeMember: async memberId => { calls.push(`upgrade:${memberId}`); return { status: 'skipped' } },
    },
    autoStart: false,
  })
  try {
    await scheduler.start()
    const status = await scheduler.update({ build: { enabled: false, time: '05:30' } })
    assert.equal(status.build.enabled, false)
    assert.equal(status.build.time, '05:30')
    assert.equal(status.build.next, null)
    assert.equal(scheduler.status('local').upgrade.time, '06:00')
    assert.equal(scheduler.status('local').upgrade.enabled, false)
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.build.enabled, false)
    assert.equal(saved.build.time, '05:30')
    assert.equal(saved.format, SCHEDULE_FORMAT)
    assert.deepEqual(calls, [])
  } finally {
    scheduler.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('each member gets its own 06:00 upgrade tick once enabled', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-schedule-'))
  const file = path.join(dir, 'schedule.json')
  let now = new Date('2026-11-16T05:00:00+08:00').getTime()
  let timer = null
  let delay = 0
  const calls = []
  const scheduler = new Scheduler({
    file,
    service: {
      scheduledBuild: async () => { calls.push('build'); return { status: 'skipped' } },
      scheduledPrepareUpgrade: async memberId => { calls.push(`prepare:${memberId}`); return { status: 'announced', member: memberId } },
      scheduledUpgradeMember: async memberId => { calls.push(`upgrade:${memberId}`); return { status: 'started', member: memberId, jobId: `job-${memberId}` } },
    },
    members: async () => ['local', 'peer'],
    now: () => now,
    setTimeout: (fn, ms) => { timer = fn; delay = ms; return { unref() {} } },
    clearTimeout: () => { timer = null },
    autoStart: false,
  })
  try {
    await scheduler.start()
    assert.equal(timer, null)
    await scheduler.update({ member: 'local', upgrade: { enabled: true } })
    await scheduler.update({ member: 'peer', upgrade: { enabled: true } })
    // The first occurrence is the pre-upgrade announcement, ten minutes before
    // the 06:00 clock; the upgrade itself is armed after that tick.
    assert.equal(delay, 50 * 60 * 1000)
    now = new Date('2026-11-16T05:50:00+08:00').getTime()
    timer()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(calls.sort(), ['prepare:local', 'prepare:peer'])
    assert.equal(delay, 10 * 60 * 1000)
    assert.equal(scheduler.status('peer').upgrade.prepare.status, 'announced')
    now = new Date('2026-11-16T06:00:00+08:00').getTime()
    timer()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(calls.sort(), ['prepare:local', 'prepare:peer', 'upgrade:local', 'upgrade:peer'])
    assert.equal(scheduler.status('peer').upgrade.last.status, 'started')
    const saved = await readScheduleFile(file)
    assert.equal(saved.schedule.upgrade.time, '06:00')
    assert.equal(saved.last.upgrades.peer.status, 'started')
    assert.equal(saved.last.prepares.peer.status, 'announced')
  } finally {
    scheduler.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a per-member override persists and disables just that member', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-schedule-'))
  const file = path.join(dir, 'schedule.json')
  const scheduler = new Scheduler({
    file,
    service: {
      scheduledBuild: async () => ({ status: 'skipped' }),
      scheduledUpgradeMember: async memberId => ({ status: 'skipped', member: memberId }),
    },
    members: async () => ['local', 'peer'],
    autoStart: false,
  })
  try {
    await scheduler.start()
    await scheduler.update({ member: 'local', upgrade: { enabled: true } })
    const status = await scheduler.update({ member: 'peer', upgrade: { enabled: false, time: '7:30' } })
    assert.equal(status.upgrade.enabled, false)
    assert.equal(status.upgrade.time, '07:30')
    assert.equal(status.upgrade.next, null)
    assert.equal(scheduler.status('local').upgrade.enabled, true)
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(saved.upgrades.peer, { enabled: false, time: '07:30' })
  } finally {
    scheduler.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
