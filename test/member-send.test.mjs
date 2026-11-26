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
 * @param {{compact?: 'ok'|'unsupported'|'busy', usedTokens?: number, liveContext?: object|null, status?: string}} [options] knobs.
 * @returns {Promise<object>} server handle.
 */
async function fakeMember(options = {}) {
  const members = {
    compact: options.compact ?? 'ok',
    // What the conversation read says about the live agent; 'running' means a
    // pre-delivery compaction is impossible.
    status: options.status ?? 'idle',
    usedTokens: options.usedTokens ?? 12_000,
    // What a conversation read reports before a delivery; null keeps an older
    // member's response (no context on the read).
    liveContext: options.liveContext ?? null,
    // Workspace name the member's projection reports for this conversation.
    workspace: options.workspace ?? '',
    // How the member took the message; the tool surfaces it in the receipt line.
    delivery: options.delivery ?? 'followup',
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
        conversation: { id: use, status: members.status, turns: members.turns, replySeq: members.replySeq, workspace: members.workspace },
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
        receipt: { messageId: 'm1', steered: members.delivery === 'steer', delivery: members.delivery },
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
    })
    assert.equal(task.adopted, true)
    assert.equal(task.conversationId, 'conv-9')
    assert.equal(task.replySeq, 5, 'the cursor starts at the member’s current reply')
    assert.deepEqual(member.order, ['message'], 'a context below the threshold needs no compaction')
    assert.deepEqual(member.messages, ['继续'])
    assert.equal(task.lastCompaction, null)

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

test('send uses the conversation scope threshold before delivering', async () => {
  const member = await fakeMember({
    compact: 'unsupported',
    liveContext: { usedTokens: 20_000, maxTokens: 128_000, percent: 15.6 },
  })
  const { tasks, service, dataDir } = await buildService(member.port)
  // A low explicit threshold (10%) makes the 15.6% context over the limit.
  service.memberScope = async () => ({ compressPercent: 10 })
  try {
    // A member too old to compact still refuses, with the upgrade hint: the
    // conversation would grow without bound and the caller must act.
    await assert.rejects(
      () => tasks.send({ member: '127.0.0.1', conversationId: 'conv-9', prompt: '继续' }),
      /不支持上下文压缩/u,
    )
    assert.deepEqual(member.messages, [], 'a failed compaction must not deliver the message')
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a conversation that is running is delivered without a compaction', async () => {
  const member = await fakeMember({
    status: 'running',
    liveContext: { usedTokens: 60_000, maxTokens: 128_000, percent: 46.9 },
  })
  const { tasks, dataDir } = await buildService(member.port)
  try {
    const task = await tasks.send({ member: '127.0.0.1', conversationId: 'conv-9', prompt: '继续' })
    // The member cannot compact a live agent, and the delivery steers the turn
    // in progress: no compaction request, no error, the message still lands.
    assert.deepEqual(member.order, ['message'])
    assert.deepEqual(member.messages, ['继续'])
    assert.equal(task.lastCompaction, null)
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
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

test('a delivery whose context is over the default 35% compacts before sending', async () => {
  const member = await fakeMember({
    liveContext: { usedTokens: 60_000, maxTokens: 128_000, percent: 46.9 },
  })
  const { tasks, dataDir } = await buildService(member.port)
  try {
    const task = await tasks.send({ member: '127.0.0.1', conversationId: 'conv-9', prompt: '继续' })
    assert.deepEqual(member.order, ['compact', 'message'], 'the automatic compaction must finish before delivery')
    assert.equal(task.lastCompaction?.forced, true)
    assert.equal(task.lastCompaction?.forcedPercent, 35, 'the stored threshold, not the observed occupancy')
    assert.equal(task.lastCompaction?.observedPercent, 46.9)
    assert.equal(task.lastCompaction?.compacted, true)
    assert.deepEqual(member.messages, ['继续'])
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('exactly the default 35% does not trigger a compaction', async () => {
  const member = await fakeMember({
    liveContext: { usedTokens: 44_800, maxTokens: 128_000, percent: 35 },
  })
  const { tasks, dataDir } = await buildService(member.port)
  try {
    const task = await tasks.send({ member: '127.0.0.1', conversationId: 'conv-9', prompt: '继续' })
    assert.deepEqual(member.order, ['message'], '35.0% is not over the threshold')
    assert.equal(task.lastCompaction, null)
    assert.deepEqual(member.messages, ['继续'])
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a lower conversation threshold compacts an otherwise unremarkable context', async () => {
  const member = await fakeMember({
    liveContext: { usedTokens: 19_200, maxTokens: 128_000, percent: 15 },
  })
  const { tasks, service, dataDir } = await buildService(member.port)
  service.memberScope = async () => ({ compressPercent: 10 })
  try {
    const task = await tasks.send({ member: '127.0.0.1', conversationId: 'conv-9', prompt: '继续' })
    assert.deepEqual(member.order, ['compact', 'message'])
    assert.equal(task.lastCompaction?.forcedPercent, 10)
    assert.equal(task.lastCompaction?.observedPercent, 15)
    assert.deepEqual(member.messages, ['继续'])
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a higher conversation threshold leaves a 15% context alone', async () => {
  const member = await fakeMember({
    liveContext: { usedTokens: 19_200, maxTokens: 128_000, percent: 15 },
  })
  const { tasks, service, dataDir } = await buildService(member.port)
  service.memberScope = async () => ({ compressPercent: 50 })
  try {
    const task = await tasks.send({ member: '127.0.0.1', conversationId: 'conv-9', prompt: '继续' })
    assert.deepEqual(member.order, ['message'])
    assert.equal(task.lastCompaction, null)
    assert.deepEqual(member.messages, ['继续'])
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a conversation that starts running during the compaction still gets the message', async () => {
  const member = await fakeMember({
    compact: 'busy',
    liveContext: { usedTokens: 60_000, maxTokens: 128_000, percent: 46.9 },
  })
  const { tasks, dataDir } = await buildService(member.port)
  try {
    // The occupancy read says idle, the compact request then finds it running.
    // Compaction is skipped and the delivery proceeds instead of failing.
    const task = await tasks.send({ member: '127.0.0.1', conversationId: 'conv-9', prompt: '继续' })
    assert.deepEqual(member.order, ['compact', 'message'])
    assert.deepEqual(member.messages, ['继续'])
    assert.equal(task.lastCompaction, null, 'no compaction was recorded')
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('call_member reports the automatic compaction with the threshold', async () => {
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
    assert.match(result.text, /上下文占比 46\.9% 已超过压缩阈值 35%，投递前已自动压缩/u)
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

test('wait_member and call_member expose the conversation id but no compress flag', async () => {
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
    const result = await wait.execute({ conversationIds: [task.conversationId], timeoutMs: 3000 }, {})
    assert.equal(result.ok, true)
    assert.match(result.text, /会话id：conv-9/u)
    assert.match(result.text, /继续这个对话：call_member/u)
    assert.match(result.text, /上下文：40k \/ 128k tokens（31\.3%）/u)
    assert.doesNotMatch(result.text, /compress/u, '31.3% is under the default 35% threshold')
    assert.equal(result.data.context.percent, 31.3)

    const call = tools.find(tool => tool.name === 'call_member')
    assert.equal(call.parameters.properties.action, undefined)
    assert.deepEqual(call.parameters.required, ['prompt'])
    assert.equal(call.parameters.properties.compress, undefined)
    assert.doesNotMatch(call.description, /compress: true/u)
    assert.equal(call.parameters.properties.conversationId.type, 'string')
    assert.equal(call.parameters.properties.force.type, 'boolean')
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

test('call_member rejects a conversation id put into member', async () => {
  const member = await fakeMember({ usedTokens: 1_000 })
  const { service, dataDir } = await buildService(member.port)
  const tools = []
  const ctx = {
    logger: { info: () => {}, error: () => {} },
    effect: () => () => {},
    get: () => undefined,
  }
  try {
    // registerTools installs the MemberTaskService on the service object.
    registerTools(ctx, { tools: { register: tool => { tools.push(tool) } } }, service)
    // A UUID is never a member; without this guard it becomes a hostname and
    // the call fails with a bare "fetch failed" that looks like a broken member.
    await assert.rejects(
      () => service.memberTasks.start({
        member: '4f4a674c-5671-4932-a0e2-9e2a823e932d',
        prompt: '继续',
        agent: {},
        notify: false,
      }),
      /is a conversation id, not a member/u,
    )
  } finally {
    await service.memberTasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('wait_member says the next delivery will auto-compact over the conversation threshold', async () => {
  const member = await fakeMember({ usedTokens: 40_000 })
  const { service, dataDir } = await buildService(member.port)
  service.memberScope = async () => ({ compressPercent: 10 })
  const tools = []
  const ctx = {
    logger: { info: () => {}, error: () => {} },
    effect: () => () => {},
    get: () => undefined,
  }
  try {
    registerTools(ctx, { tools: { register: tool => { tools.push(tool) } } }, service)
    const task = await service.memberTasks.send({ member: '127.0.0.1', conversationId: 'conv-9', prompt: '继续' })
    const wait = tools.find(tool => tool.name === 'wait_member')
    const result = await wait.execute({ conversationIds: [task.conversationId], timeoutMs: 3000 }, {})
    assert.match(result.text, /超过本会话压缩阈值 10%：下次 call_member 投递前会自动压缩/u)
    assert.doesNotMatch(result.text, /compress: true|加 "compress"/u)
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

test('a continued conversation records the workspace the member reports', async () => {
  const member = await fakeMember({ workspace: 'dsh-mesh' })
  const { tasks, dataDir } = await buildService(member.port)
  try {
    const task = await tasks.send({ member: '127.0.0.1', conversationId: 'conv-9', prompt: '继续' })
    assert.equal(task.workspace, 'dsh-mesh', 'the live projection wins over the unknown placeholder')
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('call_member reports whether the message was steered or queued', async () => {
  for (const delivery of ['steer', 'followup']) {
    const member = await fakeMember({ delivery })
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
      assert.equal(result.ok, true)
      if (delivery === 'steer') {
        assert.match(result.text, /已用 steer 插入当前 turn/u)
        assert.equal(result.data.lastDelivery, 'steer')
      } else {
        assert.match(result.text, /按 followup 排入下一轮/u)
        assert.equal(result.data.lastDelivery, 'followup')
      }
    } finally {
      await service.memberTasks.dispose()
      await member.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  }
})
