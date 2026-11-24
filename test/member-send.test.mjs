import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MemberTaskService } from '../src/lib/member-tasks.mjs'
import { registerTools } from '../src/lib/tools.mjs'

/**
 * Fake member interop for a conversation that already has five turns.
 *
 * A send queues a message; the next wait reports the new sixth reply only when
 * the caller's cursor is past the five old ones, which is exactly what proves
 * that an adopted conversation does not replay its history.
 * @param {{compact?: 'ok'|'unsupported'|'busy', usedTokens?: number, liveContext?: object|null}} [options] knobs.
 * @returns {Promise<object>} server handle.
 */
async function fakeMember(options = {}) {
  const members = {
    compact: options.compact ?? 'ok',
    usedTokens: options.usedTokens ?? 12_000,
    // What a conversation read reports before a delivery; null keeps an older
    // member's response (no context on the read).
    liveContext: options.liveContext ?? null,
    // Live conversation position. `reset` simulates a member restart, where
    // the reply counter begins a new epoch at zero.
    turns: 5,
    replySeq: 5,
    reset: false,
  }
  const messages = []
  const created = []
  const order = []
  const waits = []
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    const body = text === '' ? {} : JSON.parse(text)
    const reply = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (request.headers.authorization !== 'Bearer test-token') {
      reply(401, { ok: false, error: { code: 'unauthorized', message: 'bad token' } })
      return
    }
    const use = `conv-9`
    if (request.method === 'POST' && request.url === '/v1/conversations') {
      order.push('create')
      created.push(body)
      reply(201, { ok: true, conversation: { id: 'conv-new', status: 'running', turns: 0, replySeq: 0 } })
      return
    }
    if (request.method === 'POST' && request.url === '/v1/conversations/conv-new/wait') {
      reply(200, {
        ok: true,
        timedOut: false,
        state: 'done',
        settled: true,
        text: '新任务完成',
        turn: 1,
        seq: 1,
        replies: [{ seq: 1, turn: 1, text: '新任务完成' }],
        conversation: { id: 'conv-new', status: 'idle', turns: 1, lastText: '新任务完成', replySeq: 1 },
        context: { usedTokens: 3000, maxTokens: 128_000, percent: 2.3 },
      })
      return
    }
    if (request.method === 'GET' && (request.url === `/v1/conversations/${use}` || request.url === `/v1/conversations/${use}?resume=1`)) {
      reply(200, {
        ok: true,
        conversation: { id: use, status: 'idle', turns: members.turns, replySeq: members.replySeq },
        ...(members.liveContext === null ? {} : { context: members.liveContext }),
      })
      return
    }
    if (request.method === 'POST' && request.url === `/v1/conversations/${use}/compact`) {
      order.push('compact')
      if (members.compact === 'unsupported') {
        reply(404, { ok: false, error: { code: 'not_found', message: 'Unknown endpoint.' } })
        return
      }
      if (members.compact === 'busy') {
        reply(409, { ok: false, error: { code: 'conversation_busy', message: 'the conversation is running' } })
        return
      }
      reply(200, {
        ok: true,
        compacted: true,
        summary: '摘要',
        shadowedCount: 2,
        shadowedTokenCount: 1234,
        context: { usedTokens: 2000, maxTokens: 128_000, percent: 1.6 },
      })
      return
    }
    if (request.method === 'POST' && request.url === `/v1/conversations/${use}/messages`) {
      order.push('message')
      messages.push(body.content)
      reply(202, {
        ok: true,
        receipt: { messageId: 'm1' },
        conversation: { id: use, status: 'running', turns: 5, replySeq: 5 },
        context: { usedTokens: 2000, maxTokens: 128_000, percent: 1.6 },
      })
      return
    }
    if (request.method === 'POST' && request.url === `/v1/conversations/${use}/wait`) {
      waits.push(body.since)
      const since = Number.isSafeInteger(body.since) ? body.since : 0
      const all = members.reset
        ? [{ seq: 1, turn: 7, text: 'new-epoch' }]
        : [
          { seq: 1, turn: 1, text: 'old-1' },
          { seq: 2, turn: 2, text: 'old-2' },
          { seq: 3, turn: 3, text: 'old-3' },
          { seq: 4, turn: 4, text: 'old-4' },
          { seq: 5, turn: 5, text: 'old-5' },
          { seq: 6, turn: 6, text: 'new-answer' },
        ]
      const replies = all.filter(reply => reply.seq > since)
      const last = replies[replies.length - 1]
      if (last !== undefined) {
        members.replySeq = last.seq
        members.turns = last.turn
      }
      const usedTokens = members.usedTokens
      reply(200, {
        ok: true,
        timedOut: false,
        state: 'done',
        settled: true,
        text: replies.map(reply => reply.text).join('\n\n'),
        turn: members.turns,
        seq: members.replySeq,
        replies,
        conversation: { id: use, status: 'idle', turns: members.turns, lastText: members.reset ? '' : 'new-answer', replySeq: members.replySeq },
        context: { usedTokens, maxTokens: 128_000, percent: Math.round((usedTokens / 128_000) * 1000) / 10 },
      })
      return
    }
    reply(404, { ok: false, error: { code: 'not_found', message: 'Unknown endpoint.' } })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    messages,
    created,
    order,
    waits,
    resetEpoch: () => {
      members.reset = true
      members.replySeq = 0
      members.turns = 7
    },
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

/**
 * One MemberTaskService pointed at a fake member.
 * @param {number} port interop port.
 * @param {{ctx?: object}} [options] host-context override.
 * @returns {Promise<{tasks: MemberTaskService, service: object, dataDir: string}>} service.
 */
async function buildService(port, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mesh-send-'))
  const service = {
    dataDir,
    repositoryRoot: '/nonexistent',
    config: { interopPort: port, interopToken: 'test-token', interopUseGatePassword: false },
    async members() { return { local: { id: 'local', name: 'member-b', ip: '127.0.0.1' }, members: [] } },
  }
  const tasks = new MemberTaskService({ ctx: options.ctx ?? { get: () => undefined }, service, dataDir })
  return { tasks, service, dataDir }
}

test('send by conversationId adopts the conversation without replaying its history', async () => {
  const member = await fakeMember()
  const { tasks, dataDir } = await buildService(member.port)
  try {
    const task = await tasks.send({
      member: '127.0.0.1',
      conversationId: 'conv-9',
      prompt: '继续',
      compress: true,
    })
    assert.equal(task.adopted, true)
    assert.equal(task.conversationId, 'conv-9')
    assert.equal(task.replySeq, 5, 'the cursor starts at the member’s current reply')
    assert.deepEqual(member.order, ['compact', 'message'], 'compaction must finish before delivery')
    assert.deepEqual(member.messages, ['继续'])
    assert.equal(task.lastCompaction.compacted, true)
    assert.equal(task.lastCompaction.shadowedTokenCount, 1234)

    const result = await tasks.wait(task.conversationId, { timeoutMs: 3000 })
    assert.equal(result.done, true)
    assert.deepEqual(result.replies.map(reply => reply.text), ['new-answer'])
    assert.equal(member.waits[0], 5)
    assert.deepEqual(result.task.context, { usedTokens: 12_000, maxTokens: 128_000, percent: 9.4 })
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('send refuses compress when the member cannot compact, before delivering anything', async () => {
  for (const mode of ['unsupported', 'busy']) {
    const member = await fakeMember({ compact: mode })
    const { tasks, dataDir } = await buildService(member.port)
    try {
      await assert.rejects(
        () => tasks.send({ member: '127.0.0.1', conversationId: 'conv-9', prompt: '继续', compress: true }),
        mode === 'busy' ? /还在运行/u : /不支持上下文压缩/u,
      )
      assert.deepEqual(member.messages, [], 'a failed compaction must not deliver the message')
    } finally {
      await tasks.dispose()
      await member.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  }
})

test('send by conversationId without member needs a tracked task', async () => {
  const member = await fakeMember()
  const { tasks, dataDir } = await buildService(member.port)
  try {
    await assert.rejects(
      () => tasks.send({ conversationId: 'conv-9', prompt: '继续' }),
      /needs member/u,
    )
    assert.deepEqual(member.messages, [])
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a continued conversation is addressable by its conversation id', async () => {
  const member = await fakeMember()
  const { tasks, dataDir } = await buildService(member.port)
  try {
    const first = await tasks.send({ member: '127.0.0.1', conversationId: 'conv-9', prompt: '第一轮' })
    await tasks.wait(first.conversationId, { timeoutMs: 3000 })
    // Same conversation, no task id: the tracked task is found and reused.
    const second = await tasks.send({ conversationId: 'conv-9', prompt: '第二轮' })
    assert.equal(second.id, first.id)
    assert.deepEqual(member.order, ['message', 'message'])
    assert.deepEqual(member.messages, ['第一轮', '第二轮'])
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a continued conversation is delivered back when nobody waits for it', async () => {
  const member = await fakeMember()
  const messages = []
  const agent = {
    id: 'session-a',
    session: { id: 'session-a' },
    followup: message => { messages.push(message) },
  }
  const ctx = { get: name => name === 'agents' ? { get: id => id === 'session-a' ? agent : undefined } : undefined }
  const { tasks, dataDir } = await buildService(member.port, { ctx })
  const started = Date.now()
  try {
    const task = await tasks.send({ member: '127.0.0.1', conversationId: 'conv-9', prompt: '继续', agent })
    assert.equal(task.notify, true, 'a continued conversation is deliverable too')
    await new Promise(resolve => setTimeout(resolve, 1_500))
    assert.equal(messages.length, 0, 'delivery must wait out the grace window')
    const deadline = Date.now() + 10_000
    while (messages.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(messages.length, 1)
    assert.match(messages[0].content[0].text, /成员任务完成/u)
    assert.match(messages[0].content[0].text, /new-answer/u)
    assert.ok(Date.now() - started >= 2_900, 'the 3 second grace window must elapse first')
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a delivery whose context is already over 30% compacts before sending', async () => {
  const member = await fakeMember({
    liveContext: { usedTokens: 60_000, maxTokens: 128_000, percent: 46.9 },
  })
  const { tasks, dataDir } = await buildService(member.port)
  try {
    const task = await tasks.send({ member: '127.0.0.1', conversationId: 'conv-9', prompt: '继续' })
    assert.deepEqual(member.order, ['compact', 'message'], 'the forced compaction must finish before delivery')
    assert.equal(task.lastCompaction?.forced, true)
    assert.equal(task.lastCompaction?.forcedPercent, 46.9)
    assert.equal(task.lastCompaction?.compacted, true)
    assert.deepEqual(member.messages, ['继续'])
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('exactly 30% does not force a compaction', async () => {
  const member = await fakeMember({
    liveContext: { usedTokens: 38_400, maxTokens: 128_000, percent: 30 },
  })
  const { tasks, dataDir } = await buildService(member.port)
  try {
    const task = await tasks.send({ member: '127.0.0.1', conversationId: 'conv-9', prompt: '继续' })
    assert.deepEqual(member.order, ['message'], '30.0% is not over the threshold')
    assert.equal(task.lastCompaction, null)
    assert.deepEqual(member.messages, ['继续'])
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a forced compaction that cannot reach an idle conversation refuses the delivery', async () => {
  const member = await fakeMember({
    compact: 'busy',
    liveContext: { usedTokens: 60_000, maxTokens: 128_000, percent: 46.9 },
  })
  const { tasks, dataDir } = await buildService(member.port)
  try {
    await assert.rejects(
      () => tasks.send({ member: '127.0.0.1', conversationId: 'conv-9', prompt: '继续' }),
      /超过 30%|还在运行/u,
    )
    assert.deepEqual(member.order, ['compact'], 'the message must not be delivered without the compaction')
    assert.deepEqual(member.messages, [])
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('call_member reports the forced compaction', async () => {
  const member = await fakeMember({
    liveContext: { usedTokens: 60_000, maxTokens: 128_000, percent: 46.9 },
  })
  const { service, dataDir } = await buildService(member.port)
  const tools = []
  const ctx = {
    logger: { info: () => {}, error: () => {} },
    effect: () => () => {},
    get: () => undefined,
  }
  try {
    registerTools(ctx, { tools: { register: tool => { tools.push(tool) } } }, service)
    const call = tools.find(tool => tool.name === 'call_member')
    const result = await call.execute(
      { member: '127.0.0.1', conversationId: 'conv-9', prompt: '继续' },
      { agent: { id: 'session-a', session: { id: 'session-a' } } },
    )
    assert.match(result.text, /上下文占比已超过 30%（46\.9%），投递前已强制压缩/u)
    assert.deepEqual(member.messages, ['继续'])
  } finally {
    await service.memberTasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a wait on a finished task re-syncs after the member counter resets', async () => {
  const member = await fakeMember()
  const { tasks, dataDir } = await buildService(member.port)
  try {
    const task = await tasks.send({ member: '127.0.0.1', conversationId: 'conv-9', prompt: '第一轮' })
    const first = await tasks.wait(task.conversationId, { timeoutMs: 3000 })
    assert.equal(first.done, true)
    assert.deepEqual(first.replies.map(reply => reply.text), ['new-answer'])
    assert.equal(first.task.replySeq, 6)

    // The member restarted (counter back at zero) and ran a new turn after the
    // restart. The old cursor would hide it: a plain `since=6` returns nothing.
    member.resetEpoch()
    const second = await tasks.wait(task.conversationId, { timeoutMs: 3000 })
    assert.equal(second.done, true)
    assert.deepEqual(second.replies.map(reply => reply.text), ['new-epoch'])
    assert.equal(second.task.replySeq, 1)
    assert.equal(second.task.deliveredSeq, 1)
    assert.equal(second.task.lastText, 'new-epoch')
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('wait_member and call_member expose the conversation id and context advice', async () => {
  const member = await fakeMember({ usedTokens: 40_000 })
  const { service, dataDir } = await buildService(member.port)
  const tools = []
  const ctx = {
    logger: { info: () => {}, error: () => {} },
    effect: () => () => {},
    get: () => undefined,
  }
  try {
    // registerTools installs its own MemberTaskService on the service object;
    // start a task through it, then read the tool output like the model does.
    registerTools(ctx, { tools: { register: tool => { tools.push(tool) } } }, service)
    const task = await service.memberTasks.send({ member: '127.0.0.1', conversationId: 'conv-9', prompt: '继续' })
    const wait = tools.find(tool => tool.name === 'wait_member')
    const result = await wait.execute({ conversationId: task.conversationId, timeoutMs: 3000 }, {})
    assert.equal(result.ok, true)
    assert.match(result.text, /会话id：conv-9/u)
    assert.match(result.text, /继续这个对话：call_member/u)
    assert.match(result.text, /上下文：40k \/ 128k tokens（31\.3%）/u)
    assert.match(result.text, /超过 20%：下次投递时建议加 "compress": true/u)
    assert.equal(result.data.context.percent, 31.3)

    const call = tools.find(tool => tool.name === 'call_member')
    assert.equal(call.parameters.properties.action, undefined)
    assert.deepEqual(call.parameters.required, ['prompt'])
    assert.equal(call.parameters.properties.compress.type, 'boolean')
    assert.equal(call.parameters.properties.conversationId.type, 'string')
    await assert.rejects(
      () => call.execute({ member: '127.0.0.1', prompt: 'x', compress: true }, {}),
      /compress only applies/u,
    )
    await assert.rejects(
      () => call.execute({ prompt: 'x' }, {}),
      /member is required/u,
    )
    await assert.rejects(
      () => call.execute({ member: '127.0.0.1', conversationId: 'conv-9', prompt: 'x', cwd: '/tmp' }, {}),
      /only apply to a new conversation/u,
    )
  } finally {
    await service.memberTasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('call_member starts a new conversation when conversationId is absent', async () => {
  const member = await fakeMember()
  const { service, dataDir } = await buildService(member.port)
  const tools = []
  const ctx = {
    logger: { info: () => {}, error: () => {} },
    effect: () => () => {},
    get: () => undefined,
  }
  try {
    registerTools(ctx, { tools: { register: tool => { tools.push(tool) } } }, service)
    const call = tools.find(tool => tool.name === 'call_member')
    const result = await call.execute(
      { member: '127.0.0.1', prompt: '新任务' },
      { agent: { id: 'session-a', session: { id: 'session-a' } } },
    )
    assert.equal(result.ok, true)
    assert.match(result.text, /已发起成员任务/u)
    assert.match(result.text, /会话id：conv-new/u)
    assert.equal(result.data.conversationId, 'conv-new')
    assert.equal(result.data.id, undefined, 'the internal task id is not exposed')
    assert.equal(member.created.length, 1)
    assert.equal(member.created[0].prompt, '新任务')
    const waited = await service.memberTasks.wait(result.data.conversationId, { timeoutMs: 3000 })
    assert.equal(waited.done, true)
    assert.deepEqual(waited.replies.map(reply => reply.text), ['新任务完成'])
  } finally {
    await service.memberTasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
