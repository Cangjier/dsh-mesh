import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MemberTaskService } from '../src/lib/member-tasks.mjs'

/**
 * Fake member interop: create returns immediately, wait holds or completes.
 * @param {'hold'|'done'} mode behaviour.
 * @returns {Promise<{port:number, close:()=>Promise<void>}>} server handle.
 */
async function fakeMember(mode) {
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/conversations') {
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, conversation: { id: 'c1', status: 'running', turns: 0, lastText: '' } }))
        return
      }
      if (req.method === 'POST' && req.url === '/v1/conversations/c1/wait') {
        if (mode === 'done') {
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true, timedOut: false, conversation: { id: 'c1', status: 'idle', turns: 1, lastText: 'done' } }))
          }, 120)
        }
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
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
    assert.equal(result.task.status, 'completed')
    assert.equal(result.task.lastText, 'done')
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
