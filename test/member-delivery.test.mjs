import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MemberTaskService } from '../src/lib/member-tasks.mjs'

/**
 * A member interop that can answer a progress turn and then hold the terminal
 * turn until the test releases it.
 *
 * This is the ai-cad shape: the first wait reports a finished turn as
 * `progress`; the second reports the conversation idle with no new reply.
 * @param {{progressText?: string|null, finalText?: string}} [options] knobs.
 * @returns {Promise<object>} endpoint handle.
 */
async function fakeMember(options = {}) {
  const progressText = options.progressText === undefined ? '第一轮进展' : options.progressText
  const finalText = options.finalText ?? '最终结果'
  let waits = 0
  const live = { id: 'conv-d', status: 'running', turns: 0, replySeq: 0, lastText: '', workspace: 'dsh-mesh' }
  let release = null
  const released = new Promise((resolve) => { release = resolve })
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8') === ''
      ? {}
      : JSON.parse(Buffer.concat(chunks).toString('utf8'))
    void body
    const reply = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (request.headers.authorization !== 'Bearer test-token') {
      reply(401, { ok: false, error: { code: 'unauthorized', message: 'bad token' } })
      return
    }
    if (request.method === 'POST' && request.url === '/v1/conversations') {
      Object.assign(live, { status: 'running', turns: 0, replySeq: 0, lastText: '' })
      reply(201, { ok: true, conversation: { ...live } })
      return
    }
    if (request.method === 'GET' && request.url.startsWith('/v1/conversations/conv-d')) {
      reply(200, {
        ok: true,
        conversation: { ...live },
        context: { usedTokens: 1000, maxTokens: 128_000, percent: 0.8 },
      })
      return
    }
    if (request.method === 'POST' && request.url === '/v1/conversations/conv-d/wait') {
      waits += 1
      if (progressText !== null && waits === 1) {
        Object.assign(live, { status: 'running', turns: 1, replySeq: 1, lastText: progressText })
        reply(200, {
          ok: true,
          timedOut: false,
          state: 'progress',
          settled: false,
          text: progressText,
          turn: 1,
          seq: 1,
          replies: [{ seq: 1, turn: 1, text: progressText }],
          conversation: {
            id: 'conv-d',
            status: 'running',
            turns: 1,
            replySeq: 1,
            lastText: progressText,
            workspace: 'dsh-mesh',
          },
          context: { usedTokens: 1000, maxTokens: 128_000, percent: 0.8 },
        })
        return
      }
      if (progressText !== null) await released
      if (finalText === '') {
        Object.assign(live, { status: 'idle', turns: 1, replySeq: 1 })
        reply(200, {
          ok: true,
          timedOut: false,
          state: 'done',
          settled: true,
          text: '',
          turn: 1,
          seq: 1,
          replies: [],
          conversation: {
            id: 'conv-d',
            status: 'idle',
            turns: 1,
            replySeq: 1,
            lastText: progressText ?? '',
            workspace: 'dsh-mesh',
          },
          context: { usedTokens: 1000, maxTokens: 128_000, percent: 0.8 },
        })
        return
      }
      Object.assign(live, { status: 'idle', turns: 2, replySeq: 2, lastText: finalText })
      reply(200, {
        ok: true,
        timedOut: false,
        state: 'done',
        settled: true,
        text: finalText,
        turn: 2,
        seq: 2,
        replies: [{ seq: 2, turn: 2, text: finalText }],
        conversation: {
          id: 'conv-d',
          status: 'idle',
          turns: 2,
          replySeq: 2,
          lastText: finalText,
          workspace: 'dsh-mesh',
        },
        context: { usedTokens: 1000, maxTokens: 128_000, percent: 0.8 },
      })
      return
    }
    reply(404, { ok: false, error: { code: 'not_found', message: 'not found' } })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    release() { release() },
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

/**
 * A task service over one fake member and a recording idle agent.
 * @param {number} port fake interop port.
 * @param {object} agent origin agent that records delivery.
 * @returns {Promise<{tasks: MemberTaskService, dataDir: string}>} harness.
 */
async function buildService(port, agent) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mesh-delivery-'))
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: () => () => {},
    get: name => name === 'agents' ? { get: id => (id === agent.id ? agent : undefined) } : undefined,
  }
  const service = {
    dataDir,
    repositoryRoot: '/nonexistent',
    config: { interopPort: port, interopToken: 'test-token', interopUseGatePassword: false },
    async members() {
      return { local: { id: 'local', name: 'member-b', ip: '127.0.0.1' }, members: [] }
    },
  }
  const tasks = new MemberTaskService({ ctx, service, dataDir, deliveryGraceMs: 100 })
  return { tasks, dataDir }
}

/**
 * Poll until a predicate holds.
 * @param {() => boolean} predicate condition.
 * @param {number} [timeoutMs] budget.
 * @returns {Promise<void>} resolution when it held.
 */
async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not reached in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * Give a delivery timer room to fire.
 * @param {number} [ms] delay.
 * @returns {Promise<void>} resolution.
 */
function sleep(ms = 250) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Recording origin agent.
 * @returns {object} agent.
 */
function recordingAgent() {
  const messages = []
  const steered = []
  return {
    id: 'session-a',
    session: { id: 'session-a' },
    status: 'idle',
    followup: message => { messages.push(message) },
    steer: message => { steered.push(message) },
    messages,
    steered,
  }
}

test('a progress reply taken by wait_member is never delivered a second time', async () => {
  const member = await fakeMember({ progressText: '第一轮进展', finalText: '' })
  const agent = recordingAgent()
  const { tasks, dataDir } = await buildService(member.port, agent)
  try {
    const task = await tasks.start({ member: '127.0.0.1', prompt: '检查磁盘', agent, notify: true })
    await waitFor(() => task.replySeq === 1)
    const progress = await tasks.waitAny([task.conversationId], { timeoutMs: 3_000 })
    assert.equal(progress.state, 'progress')
    assert.deepEqual(progress.replies.map(reply => reply.text), ['第一轮进展'])
    assert.equal(progress.task.deliveredSeq, 1)

    member.release()
    await waitFor(() => task.status === 'completed')
    await sleep()

    assert.equal(agent.messages.length, 1, 'the fallback still tells the caller the task finished, once')
    const text = agent.messages[0].content[0].text
    assert.match(text, /\[成员任务完成\]/u)
    assert.match(text, /已经通过 wait_member 返回/u)
    assert.doesNotMatch(text, /第一轮进展/u, 'a reply wait_member already returned must not be repeated')
    assert.equal(agent.steered.length, 0)
    assert.equal(task.deliveredSeq, 1)
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a terminal reply wait_member consumed cancels the fallback delivery entirely', async () => {
  const member = await fakeMember({ progressText: null, finalText: '最终结果' })
  const agent = recordingAgent()
  const { tasks, dataDir } = await buildService(member.port, agent)
  try {
    const task = await tasks.start({ member: '127.0.0.1', prompt: '检查磁盘', agent, notify: true })
    // Park before the terminal state so the monitor wakes this wait first and
    // the fallback timer is scheduled only after the outcome is taken.
    const waited = await tasks.wait(task.conversationId, { timeoutMs: 3_000 })
    assert.equal(waited.done, true)
    assert.deepEqual(waited.replies.map(reply => reply.text), ['最终结果'])
    assert.equal(tasks.deliveryTimers.has(task.id), false, 'the pending delivery timer is cancelled')
    await sleep()
    assert.equal(agent.messages.length, 0, 'a consumed terminal result is not delivered again')
    assert.equal(task.notified, false)
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('the fallback delivers only the replies wait_member has not taken', async () => {
  const member = await fakeMember({ progressText: '第一轮进展', finalText: '最终结果' })
  const agent = recordingAgent()
  const { tasks, dataDir } = await buildService(member.port, agent)
  try {
    const task = await tasks.start({ member: '127.0.0.1', prompt: '检查磁盘', agent, notify: true })
    await waitFor(() => task.replySeq === 1)
    const progress = await tasks.waitAny([task.conversationId], { timeoutMs: 3_000 })
    assert.equal(progress.state, 'progress')

    member.release()
    await waitFor(() => task.status === 'completed')
    await sleep()

    assert.equal(agent.messages.length, 1)
    const text = agent.messages[0].content[0].text
    assert.match(text, /最终结果/u)
    assert.doesNotMatch(text, /第一轮进展/u, 'only the unread turn is delivered')
    assert.equal(task.deliveredSeq, 2)

    // The claimed reply is not readable a second time either.
    const again = await tasks.wait(task.conversationId, { timeoutMs: 500 })
    assert.equal(again.done, true)
    assert.deepEqual(again.replies, [])
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
