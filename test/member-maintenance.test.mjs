import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MeshService } from '../src/lib/service.mjs'
import { scheduleFile } from '../src/lib/schedule.mjs'
import { UPGRADE_LEAD_MS } from '../src/lib/upgrade-announce.mjs'

/**
 * A service that only has the two things `memberMaintenance` reads: the deploy
 * job table and the schedule file.
 * @param {{jobs?: object[], last?: object}} [options] deploy jobs and schedule `last`.
 * @returns {Promise<{service: object, dataDir: string}>} service and its temp dir.
 */
async function serviceOf(options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mesh-maintenance-'))
  const service = Object.create(MeshService.prototype)
  service.dataDir = dataDir
  service.deploy = { list: async () => options.jobs ?? [] }
  if (options.last !== undefined) {
    await writeFile(scheduleFile(dataDir), `${JSON.stringify({ schedule: {}, last: options.last }, null, 2)}\n`, 'utf8')
  }
  return { service, dataDir }
}

test('a running deploy job makes the target unavailable', async () => {
  const { service, dataDir } = await serviceOf({
    jobs: [
      { id: 'deploy-1', status: 'succeeded', member: '10.66.66.3', target: { host: '10.66.66.3' }, mode: 'upgrade' },
      { id: 'deploy-2', status: 'running', member: '10.66.66.3', target: { host: '10.66.66.3' }, mode: 'upgrade', phase: 'prepare', createdAt: '2026-11-26T08:00:00.000Z' },
    ],
  })
  try {
    const state = await service.memberMaintenance({ id: '10.66.66.3', name: 'ecs-92994806', ip: '10.66.66.3' })
    assert.equal(state.active, true)
    assert.equal(state.kind, '升级')
    assert.equal(state.job, 'deploy-2')
    assert.equal(state.phase, 'prepare')
    assert.equal(state.since, '2026-11-26T08:00:00.000Z')
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a job is found by its target host and an install is called a deploy', async () => {
  const { service, dataDir } = await serviceOf({
    jobs: [{ id: 'deploy-3', status: 'queued', member: '10.66.66.4', target: { host: '10.66.66.4' }, mode: 'install' }],
  })
  try {
    assert.equal((await service.memberMaintenance({ id: '10.66.66.4', ip: '10.66.66.4' })).kind, '部署')
    // A different member is untouched.
    assert.equal((await service.memberMaintenance({ id: '10.66.66.2', ip: '10.66.66.2' })).active, false)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('an announced scheduled upgrade blocks until its job is recorded', async () => {
  const announcedAt = new Date(Date.now() - 2 * 60_000).toISOString()
  const { service, dataDir } = await serviceOf({
    last: { prepares: { '10.66.66.3': { at: announcedAt, status: 'announced', announced: 2 } }, upgrades: {} },
  })
  try {
    const state = await service.memberMaintenance({ id: '10.66.66.3', ip: '10.66.66.3' })
    assert.equal(state.active, true)
    assert.equal(state.kind, '自动升级')
    assert.equal(state.phase, 'prepare')
    assert.equal(state.since, announcedAt)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a prepared window that already ran its upgrade no longer blocks', async () => {
  const announcedAt = new Date(Date.now() - 12 * 60_000).toISOString()
  const upgradedAt = new Date(Date.now() - 60_000).toISOString()
  const { service, dataDir } = await serviceOf({
    last: {
      prepares: { '10.66.66.3': { at: announcedAt, status: 'announced' } },
      upgrades: { '10.66.66.3': { at: upgradedAt, status: 'started' } },
    },
  })
  try {
    assert.equal((await service.memberMaintenance({ id: '10.66.66.3' })).active, false)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a stale or skipped preparation does not block a call', async () => {
  const stale = new Date(Date.now() - UPGRADE_LEAD_MS - 30 * 60_000).toISOString()
  const staleCase = await serviceOf({ last: { prepares: { m: { at: stale, status: 'announced' } }, upgrades: {} } })
  try {
    assert.equal((await staleCase.service.memberMaintenance({ id: 'm' })).active, false)
  } finally {
    await rm(staleCase.dataDir, { recursive: true, force: true })
  }
  const skippedCase = await serviceOf({
    last: { prepares: { m: { at: new Date().toISOString(), status: 'skipped' } }, upgrades: {} },
  })
  try {
    assert.equal((await skippedCase.service.memberMaintenance({ id: 'm' })).active, false)
  } finally {
    await rm(skippedCase.dataDir, { recursive: true, force: true })
  }
})

test('no schedule and no jobs is simply idle', async () => {
  const { service, dataDir } = await serviceOf()
  try {
    assert.deepEqual(await service.memberMaintenance({ id: 'm', ip: '10.66.66.9' }), { active: false })
    assert.deepEqual(await service.memberMaintenance({}), { active: false })
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
