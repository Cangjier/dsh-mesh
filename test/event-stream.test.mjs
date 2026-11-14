import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventHub, JobDirectoryWatcher } from '../code/shared/event-stream.mjs'
import { startJobEvents } from '../src/lib/job-events.mjs'

/**
 * Minimal `ServerResponse` double that records everything written.
 * @returns {object} fake response.
 */
function fakeResponse() {
  return {
    status: 0,
    headers: {},
    chunks: [],
    ended: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    write(chunk) {
      this.chunks.push(String(chunk))
      return true
    },
    end() {
      this.ended = true
    },
    once() {
      // The hub also listens for `close`; a double has no real lifecycle.
    },
    body() {
      return this.chunks.join('')
    },
  }
}

/**
 * Poll until `check()` is true or the deadline passes.
 * @param {() => boolean} check condition.
 * @param {number} [timeoutMs] budget.
 * @returns {Promise<void>} completion.
 */
async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('condition was not reached in time')
}

test('the hub sends ready and named events to every subscriber', () => {
  const hub = new EventHub()
  const first = fakeResponse()
  const second = fakeResponse()
  hub.subscribe({ once() {} }, first)
  hub.subscribe({ once() {} }, second)

  assert.equal(hub.size, 2)
  assert.equal(first.status, 200)
  assert.match(first.headers['content-type'], /text\/event-stream/u)
  assert.match(first.body(), /event: ready/u)

  hub.send('build', { type: 'build', id: 'job-1', job: { id: 'job-1' } })
  for (const response of [first, second]) {
    assert.match(response.body(), /event: build\ndata: \{"type":"build","id":"job-1"/u)
  }

  hub.close()
  assert.equal(hub.size, 0)
  assert.equal(first.ended, true)
  assert.equal(second.ended, true)
})

test('the hub drops a subscriber that throws on write', () => {
  const hub = new EventHub()
  const broken = fakeResponse()
  hub.subscribe({ once() {} }, broken)
  assert.equal(hub.size, 1)
  // The socket dies after the stream was established.
  broken.write = () => { throw new Error('socket gone') }
  hub.send('build', { type: 'build' })
  assert.equal(hub.size, 0)
})

test('the watcher reports a file change in an immediate subdirectory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-watch-'))
  const seen = []
  const watcher = new JobDirectoryWatcher({ root, onChange: (dir, file) => seen.push(`${dir}/${file}`) })
  try {
    watcher.start()
    await mkdir(path.join(root, 'job-1'))
    await writeFile(path.join(root, 'job-1', 'state.json'), '{}', 'utf8')
    await waitFor(() => seen.includes('job-1/state.json'))
    assert.ok(seen.includes('job-1/state.json'), `saw ${JSON.stringify(seen)}`)
  } finally {
    watcher.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('job events push the summary and then the log tail', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-events-'))
  const sent = []
  const service = {
    dataDir: root,
    async buildSummary(id) {
      return { id, status: 'running', phase: 'install', updatedAt: new Date().toISOString() }
    },
    async log() {
      return 'one\ntwo'
    },
    async deployStatus() {
      return null
    },
    async deployLogs() {
      return ''
    },
  }
  const events = startJobEvents({ service, hub: { send: (type, payload) => sent.push({ type, payload }) } })
  try {
    await mkdir(path.join(root, 'build', 'job-1'), { recursive: true })
    await writeFile(path.join(root, 'build', 'job-1', 'state.json'), '{"id":"job-1"}', 'utf8')
    await waitFor(() => sent.some(event => event.type === 'build' && event.payload.id === 'job-1'))
    const summary = sent.find(event => event.type === 'build')
    assert.equal(summary.payload.job.status, 'running')

    await writeFile(path.join(root, 'build', 'job-1', 'build.log'), 'one\ntwo\n', 'utf8')
    await waitFor(() => sent.some(event => event.type === 'build-log' && event.payload.id === 'job-1'))
    const log = sent.find(event => event.type === 'build-log')
    assert.deepEqual(log.payload.lines, ['one', 'two'])
  } finally {
    events.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('GET /api/dsh-mesh/events streams a pushed build event', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-api-events-'))
  const { registerApi } = await import('../src/lib/http-api.mjs')
  const { createServer } = await import('node:http')
  const service = {
    dataDir: root,
    async buildSummary(id) {
      return { id, status: 'running', phase: 'install', updatedAt: new Date().toISOString() }
    },
    async log() { return 'one\ntwo' },
    async deployStatus() { return null },
    async deployLogs() { return '' },
  }
  let handler = null
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) { disposers.push(fn()) },
    webServer: {
      register(options) {
        handler = options.handler
        return () => {}
      },
    },
  }
  registerApi(ctx, service)
  assert.equal(typeof handler, 'function')
  const server = createServer((request, response) => { void handler(request, response) })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const controller = new AbortController()
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/dsh-mesh/events`, { signal: controller.signal })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/u)

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let received = ''
    const readUntil = async (needle) => {
      while (!received.includes(needle)) {
        const { value, done } = await reader.read()
        if (done) throw new Error(`stream ended before ${needle}`)
        received += decoder.decode(value, { stream: true })
      }
    }
    await readUntil('event: ready')

    await mkdir(path.join(root, 'build', 'job-1'), { recursive: true })
    await writeFile(path.join(root, 'build', 'job-1', 'state.json'), '{"id":"job-1"}', 'utf8')
    await readUntil('event: build')

    assert.match(received, /"type":"build","id":"job-1"/u)
    controller.abort()
  } finally {
    for (const dispose of disposers) {
      try { dispose() } catch { }
    }
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
