import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MemberTaskService } from '../src/lib/member-tasks.mjs'

/**
 * Fake member interop.
 *
 * `done` finishes on the first wait. `progress` answers the first wait with one
 * finished-turn reply, then parks the next one until the test calls `finish()`.
 * `hold` never answers.
 * @param {'hold'|'done'|'progress'} mode behaviour.
 * @returns {Promise<{port:number, finish:()=>void, close:()=>Promise<void>}>} server handle.
 */
async function fakeMember(mode) {
  const sockets = new Set()
  let waits = 0
  let release = null
  const finished = new Promise((resolve) => { release = resolve })
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const body = text === '' ? {} : JSON.parse(text)
      const reply = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (req.method === 'POST' && req.url === '/v1/conversations') {
        reply(201, { ok: true, conversation: { id: 'c1', status: 'running', turns: 0, lastText: '', replySeq: 0 } })
        return
      }
      if (req.method === 'POST' && req.url === '/v1/conversations/c1/wait') {
        waits += 1
        if (mode === 'hold') return
        if (mode === 'done') {
          setTimeout(() => {
            reply(200, {
              ok: true,
              timedOut: false,
              state: 'done',
              settled: true,
              text: 'done',
              turn: 1,
              seq: 1,
              replies: [{ seq: 1, turn: 1, text: 'done' }],
              conversation: { id: 'c1', status: 'idle', turns: 1, lastText: 'done', replySeq: 1 },
            })
          }, 120)
          return
        }
        // progress: first wait carries turn 1, later waits finish only when released.
        if (waits === 1) {
          reply(200, {
            ok: true,
            timedOut: false,
            state: 'progress',
            settled: false,
            text: 'first',
            turn: 1,
            seq: 1,
            replies: [{ seq: 1, turn: 1, text: 'first' }],
            conversation: { id: 'c1', status: 'running', turns: 1, lastText: 'first', replySeq: 1 },
          })
          return
        }
        void finished.then(() => {
          reply(200, {
            ok: true,
            timedOut: false,
            state: 'done',
            settled: true,
            text: 'second',
            turn: 2,
            seq: 2,
            replies: [{ seq: 2, turn: 2, text: 'second' }],
            conversation: { id: 'c1', status: 'idle', turns: 2, lastText: 'second', replySeq: 2 },
          })
        })
        return
      }
      reply(404, {})
    })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    finish: () => release(),
    close: () => new Promise(resolve => {
      for (const socket of sockets) socket.destroy()
      server.close(resolve)
    }),
  }
}

/**
 * Build a service pointed at a fake member.
 * @param {number} port interop port.
 * @returns {Promise<{tasks: MemberTaskService, dataDir: string}>} service.
 */
async function buildService(port) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mesh-wait-'))
  const tasks = new MemberTaskService({
    ctx: {},
    dataDir,
    service: {
      dataDir,
      repositoryRoot: '/nonexistent',
      config: { interopPort: port, interopToken: 'test-token' },
      async members() { return { local: { id: 'local', name: 'local', ip: '' }, members: [] } },
    },
  })
  return { tasks, dataDir }
}

const AGENT = { id: 'a1', session: { id: 's1' } }

test('wait returns the completed member task', async () => {
  const member = await fakeMember('done')
  const { tasks, dataDir } = await buildService(member.port)
  try {
    const task = await tasks.start({ member: '127.0.0.1', prompt: 'hello', agent: AGENT, notify: false })
    const result = await tasks.wait(task.id, { timeoutMs: 3000 })
    assert.equal(result.done, true)
    assert.equal(result.timedOut, false)
    assert.equal(result.state, 'done')
    assert.equal(result.task.status, 'completed')
    assert.equal(result.task.lastText, 'done')
    assert.deepEqual(result.replies.map(reply => reply.text), ['done'])
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('wait returns a finished turn immediately, then the completion', async () => {
  const member = await fakeMember('progress')
  const { tasks, dataDir } = await buildService(member.port)
  try {
    const task = await tasks.start({ member: '127.0.0.1', prompt: 'hello', agent: AGENT, notify: false })
    const first = await tasks.wait(task.id, { timeoutMs: 3000 })
    assert.equal(first.done, false)
    assert.equal(first.timedOut, false)
    assert.equal(first.state, 'progress')
    assert.equal(first.task.status, 'running')
    assert.deepEqual(first.replies.map(reply => reply.text), ['first'])

    // No new reply yet: the same task must not replay the one already delivered.
    const stillWaiting = await tasks.wait(task.id, { timeoutMs: 300 })
    assert.equal(stillWaiting.done, false)
    assert.equal(stillWaiting.timedOut, true)
    assert.deepEqual(stillWaiting.replies, [])

    member.finish()
    const done = await tasks.wait(task.id, { timeoutMs: 3000 })
    assert.equal(done.done, true)
    assert.equal(done.state, 'done')
    assert.equal(done.task.status, 'completed')
    assert.deepEqual(done.replies.map(reply => reply.text), ['second'])

    // A done task answers at once, without the text being repeated.
    const again = await tasks.wait(task.id, { timeoutMs: 1000 })
    assert.equal(again.done, true)
    assert.equal(again.state, 'done')
    assert.deepEqual(again.replies, [])
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('wait times out without ending the task', async () => {
  const member = await fakeMember('hold')
  const { tasks, dataDir } = await buildService(member.port)
  try {
    const task = await tasks.start({ member: '127.0.0.1', prompt: 'hello', agent: AGENT, notify: false })
    const started = Date.now()
    const result = await tasks.wait(task.id, { timeoutMs: 400 })
    assert.equal(result.done, false)
    assert.equal(result.timedOut, true)
    assert.equal(result.state, 'running')
    assert.equal(result.task.status, 'running')
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 350 && elapsed < 2000, `timeout took ${String(elapsed)}ms`)
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('wait aborts with the caller signal', async () => {
  const member = await fakeMember('hold')
  const { tasks, dataDir } = await buildService(member.port)
  try {
    const task = await tasks.start({ member: '127.0.0.1', prompt: 'hello', agent: AGENT, notify: false })
    const controller = new AbortController()
    const pending = tasks.wait(task.id, { timeoutMs: 5000, signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await assert.rejects(pending, /tool call aborted/)
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
