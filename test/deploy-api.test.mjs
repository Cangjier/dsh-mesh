import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { registerApi } from '../src/lib/http-api.mjs'

/**
 * Register the panel API over a stub service and expose its handler.
 * @param {object} service stub service.
 * @returns {(method: string, url: string) => Promise<{status: number, body: any}>} caller.
 */
function apiCaller(service) {
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
  registerApi(ctx, service)
  return async (method, url) => {
    const request = Readable.from([])
    request.method = method
    request.url = url
    request.headers = {}
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
