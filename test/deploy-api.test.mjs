import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { registerApi } from '../src/lib/http-api.mjs'

/**
 * Register the panel API over a stub service and expose its handler.
 * @param {object} service stub service.
 * @param {object|null} [scheduler] stub scheduler.
 * @returns {(method: string, url: string, body?: object) => Promise<{status: number, body: any}>} caller.
 */
function apiCaller(service, scheduler = null) {
  let handler
  const ctx = {
    effect(fn) {
      fn()
      return () => {}
    },
    webServer: {
      register(options) {
        handler = options.handler
        return () => {}
      },
    },
  }
  registerApi(ctx, service, scheduler)
  return async (method, url, body, headers = { 'x-dsh-mesh': '1' }) => {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    request.method = method
    request.url = url
    request.headers = headers
    let settled
    const response = {
      statusCode: 0,
      writeHead(status) {
        this.statusCode = status
      },
      end(text) {
        settled = { status: this.statusCode, body: JSON.parse(text) }
      },
    }
    await handler(request, response)
    return settled
  }
}

test('deploy job routes expose progress and the log tail', async () => {
  const job = { id: 'deploy-abc', status: 'running', progress: { percent: 42 } }
  const call = apiCaller({
    async deployJobs(limit) {
      assert.equal(limit, 30)
      return [job]
    },
    async deployStatus(id) {
      return id === 'deploy-abc' ? job : null
    },
    async deployLogs(id, lines) {
      assert.equal(id, 'deploy-abc')
      assert.equal(lines, 50)
      return 'one\ntwo'
    },
  })

  const list = await call('GET', '/api/dsh-mesh/deploy/jobs')
  assert.equal(list.status, 200)
  assert.deepEqual(list.body.jobs, [job])

  const detail = await call('GET', '/api/dsh-mesh/deploy/deploy-abc?lines=50')
  assert.equal(detail.status, 200)
  assert.deepEqual(detail.body.job, job)
  assert.deepEqual(detail.body.lines, ['one', 'two'])

  const missing = await call('GET', '/api/dsh-mesh/deploy/deploy-nope')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.ok, false)
})

test('the panel can upgrade a member with a chosen package', async () => {
  const calls = []
  const call = apiCaller({
    async upgradeMember(request) {
      calls.push(request)
      return { ok: true, job: { id: 'deploy-up', status: 'queued' }, member: { id: '10.66.66.2' }, layout: 'bluegreen' }
    },
  })
  const response = await call('POST', '/api/dsh-mesh/upgrade', { member: '10.66.66.2', package: 'dsh-mesh-0.2.3-linux-x64.tar.gz' })
  assert.equal(response.status, 202)
  assert.equal(response.body.job.id, 'deploy-up')
  assert.deepEqual(calls, [{ member: '10.66.66.2', package: 'dsh-mesh-0.2.3-linux-x64.tar.gz' }])
})

test('the panel can test-upgrade a member instead of this machine', async () => {
  const calls = []
  const call = apiCaller({
    async testUpgradeMember(request) {
      calls.push(request)
      return { ok: true, job: { id: 'deploy-test', mode: 'test', status: 'queued' }, member: { id: '10.66.66.3' }, layout: 'bluegreen' }
    },
  })
  const response = await call('POST', '/api/dsh-mesh/test-upgrade', { member: '10.66.66.3', package: 'dsh-mesh-0.2.2-rc.3-linux-x64.tar.gz' })
  assert.equal(response.status, 202)
  assert.equal(response.body.job.mode, 'test')
  assert.deepEqual(calls, [{ member: '10.66.66.3', package: 'dsh-mesh-0.2.2-rc.3-linux-x64.tar.gz' }])
})

test('build logs can be cleared one job or in bulk', async () => {
  const cleared = []
  const call = apiCaller({
    async clearBuildLog(id) {
      cleared.push(id)
      return { ok: true, id }
    },
    async clearFinishedBuilds() {
      return { ok: true, cleared: ['job-a', 'job-b'] }
    },
  })
  const one = await call('POST', '/api/dsh-mesh/build/job-a/log/clear', {})
  assert.equal(one.status, 200)
  assert.deepEqual(cleared, ['job-a'])
  const all = await call('POST', '/api/dsh-mesh/build/logs/clear', {})
  assert.equal(all.status, 200)
  assert.deepEqual(all.body.cleared, ['job-a', 'job-b'])
})

test('the panel can roll a member back to its previous release', async () => {
  const calls = []
  const call = apiCaller({
    async rollbackMember(request) {
      calls.push(request)
      return { ok: true, job: { id: 'deploy-rb', status: 'running' }, member: { id: '10.66.66.2' } }
    },
  })
  const response = await call('POST', '/api/dsh-mesh/deploy/rollback', { member: '10.66.66.2' })
  assert.equal(response.status, 202)
  assert.equal(response.body.job.id, 'deploy-rb')
  assert.deepEqual(calls, [{ member: '10.66.66.2' }])
})


test('the schedule routes read the build clock and one member at a time', async () => {
  const build = { enabled: true, time: '04:00', next: null, last: null, running: false }
  const upgrade = { enabled: true, time: '06:00', next: null, last: null, running: false, member: '10.66.66.2' }
  const updates = []
  const scheduler = {
    status(memberId) {
      return memberId === undefined ? { ok: true, build } : { ok: true, build, upgrade }
    },
    async update(patch) {
      updates.push(patch)
      return patch.member === undefined ? { ok: true, build } : { ok: true, build, upgrade }
    },
  }
  const call = apiCaller({}, scheduler)
  const read = await call('GET', '/api/dsh-mesh/schedule')
  assert.equal(read.status, 200)
  assert.deepEqual(read.body.schedule, { ok: true, build })
  const memberRead = await call('GET', '/api/dsh-mesh/schedule?member=10.66.66.2')
  assert.equal(memberRead.status, 200)
  assert.deepEqual(memberRead.body.schedule, { ok: true, build, upgrade })
  const written = await call('POST', '/api/dsh-mesh/schedule', { build: { enabled: false, time: '05:15' } })
  assert.equal(written.status, 200)
  const memberWritten = await call('POST', '/api/dsh-mesh/schedule', { member: '10.66.66.2', upgrade: { enabled: false, time: '07:30' } })
  assert.equal(memberWritten.status, 200)
  assert.deepEqual(updates, [
    { build: { enabled: false, time: '05:15' } },
    { member: '10.66.66.2', upgrade: { enabled: false, time: '07:30' } },
  ])
})

test('the schedule route reports unavailable when no scheduler exists', async () => {
  const call = apiCaller({})
  const read = await call('GET', '/api/dsh-mesh/schedule')
  assert.equal(read.status, 503)
  const written = await call('POST', '/api/dsh-mesh/schedule', {})
  assert.equal(written.status, 503)
})


test('release settings routes mask tokens and require the CSRF header', async () => {
  const saved = []
  const call = apiCaller({
    async releaseSettings() {
      return { ok: true, config: { github: { hasToken: true }, gitee: { hasToken: false } }, manifestUrls: [], configured: true }
    },
    async saveReleaseSettings(body) {
      saved.push(body)
      return { ok: true, config: body.config, manifestUrls: [], configured: true }
    },
  })
  const read = await call('GET', '/api/dsh-mesh/release')
  assert.equal(read.status, 200)
  assert.equal(read.body.config.github.hasToken, true)

  const written = await call('POST', '/api/dsh-mesh/release', { config: { enabled: true, tag: 'latest' } })
  assert.equal(written.status, 200)
  assert.equal(saved.length, 1)

  const forbidden = await call('POST', '/api/dsh-mesh/release', { config: { enabled: false } }, {})
  assert.equal(forbidden.status, 403)
  assert.equal(saved.length, 1)
})

test('upgrade routes forward the download proxy choice', async () => {
  const seen = []
  const call = apiCaller({
    async upgradeMember(request) {
      seen.push({ kind: 'upgrade', request })
      return { ok: true, job: { id: 'deploy-up', mode: 'upgrade' } }
    },
    async testUpgradeMember(request) {
      seen.push({ kind: 'test', request })
      return { ok: true, job: { id: 'deploy-test', mode: 'test' } }
    },
  })
  const upgraded = await call('POST', '/api/dsh-mesh/upgrade', { member: 'b', package: 'p.tar.gz', proxyMember: 'c' })
  assert.equal(upgraded.status, 202)
  assert.deepEqual(seen[0], { kind: 'upgrade', request: { member: 'b', package: 'p.tar.gz', proxyMember: 'c' } })
  const direct = await call('POST', '/api/dsh-mesh/test-upgrade', { member: 'b', package: 'p.tar.gz', direct: true })
  assert.equal(direct.status, 202)
  assert.deepEqual(seen[1], { kind: 'test', request: { member: 'b', package: 'p.tar.gz', direct: true } })
})
