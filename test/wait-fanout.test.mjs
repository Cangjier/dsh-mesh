import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MemberTaskService } from '../src/lib/member-tasks.mjs'
import { registerTools } from '../src/lib/tools.mjs'

/**
 * Minimal member interop: a create endpoint, a conversation that never
 * answers, and read/wait/message endpoints for conversation `conv-9`.
 * @param {{statusById?: Record<string, string>}} [options] live status per id.
 * @returns {Promise<{port: number, close: () => Promise<void>}>} endpoint.
 */
async function fakeMember(options = {}) {
  const statusById = options.statusById ?? {}
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const reply = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (request.headers.authorization !== 'Bearer test-token') {
      reply(401, { ok: false, error: { code: 'unauthorized', message: 'bad token' } })
      return
    }
    const conversation = request.url?.match(/^\/v1\/conversations\/([^/?]+)$/u)
    if (request.method === 'GET' && conversation !== null && conversation !== undefined) {
      const id = decodeURIComponent(conversation[1])
      reply(200, {
        ok: true,
        conversation: { id, status: statusById[id] ?? 'idle', turns: 1, replySeq: 0, lastReasoning: '看一下磁盘。' },
      })
      return
    }
    if (request.method === 'POST' && request.url === '/v1/conversations') {
      reply(201, { ok: true, conversation: { id: 'conv-new', status: 'running', turns: 0, replySeq: 0 } })
      return
    }
    if (request.method === 'POST' && request.url === '/v1/conversations/conv-9/wait') {
      reply(200, {
        ok: true,
        timedOut: false,
        state: 'done',
        settled: true,
        text: '磁盘正常',
        turn: 1,
        seq: 1,
        replies: [{ seq: 1, turn: 1, text: '磁盘正常' }],
        conversation: { id: 'conv-9', status: 'idle', turns: 1, lastText: '磁盘正常', replySeq: 1 },
        context: { usedTokens: 900, maxTokens: 128_000, percent: 0.7 },
      })
      return
    }
    if (request.method === 'POST' && request.url?.endsWith('/wait') === true) {
      reply(200, { ok: true, timedOut: true, state: 'running', replies: [], conversation: { status: 'running' } })
      return
    }
    if (request.method === 'POST' && request.url?.endsWith('/messages') === true) {
      reply(202, {
        ok: true,
        receipt: { messageId: 'm1' },
        conversation: { id: 'conv-9', status: 'running', turns: 0, replySeq: 0 },
        context: { usedTokens: 900, maxTokens: 128_000, percent: 0.7 },
      })
      return
    }
    reply(404, { ok: false, error: { code: 'not_found', message: 'not found' } })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

/**
 * A stub mesh service pointing at a fake member interop.
 * @param {number} port fake interop port.
 * @returns {Promise<{service: object, dataDir: string}>} stub.
 */
async function buildStub(port) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mesh-fanout-'))
  const service = {
    dataDir,
    repositoryRoot: '/nonexistent',
    config: { interopPort: port, interopToken: 'test-token', interopUseGatePassword: false },
    async members() {
      return { local: { id: 'local', name: 'member-b', ip: '127.0.0.1' }, members: [] }
    },
  }
  return { service, dataDir }
}

/**
 * One explicit task service (not the one `registerTools` builds) so a test can
 * drive `waitAny` and the fallback delivery directly.
 * @param {number} port fake interop port.
 * @param {object} [hostAgent] live agent of the origin session.
 * @returns {Promise<{tasks: MemberTaskService, dataDir: string}>} service.
 */
async function buildService(port, hostAgent) {
  const { service, dataDir } = await buildStub(port)
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: () => () => {},
    get: name => name === 'agents' && hostAgent !== undefined
      ? { get: id => (id === hostAgent.id ? hostAgent : undefined) }
      : undefined,
  }
  const tasks = new MemberTaskService({ ctx, service, dataDir })
  return { tasks, dataDir }
}

/**
 * Register the tools and index them by name.
 * @param {object} service stub service.
 * @returns {Map<string, object>} definitions.
 */
function register(service) {
  const definitions = new Map()
  registerTools(
    { logger: {}, effect(fn) { fn() }, get() { return undefined } },
    { tools: { register(definition) { definitions.set(definition.name, definition) } } },
    service,
  )
  return definitions
}

/**
 * Seed one tracked task into the task table under test.
 * @param {{tasks: Map<string, object>}} taskService task service.
 * @param {string} conversationId member conversation id.
 * @param {object} [overrides] task fields.
 * @returns {object} task.
 */
function seed(taskService, conversationId, overrides = {}) {
  const task = {
    id: `task-${conversationId}`,
    member: 'B',
    memberIp: '10.66.66.2',
    conversationId,
    status: 'running',
    turns: 1,
    lastText: '',
    replies: [],
    replySeq: 0,
    deliveredSeq: 0,
    notify: false,
    createdAt: '2026-11-24T00:00:00.000Z',
    originSessionId: 'session-a',
    originAgentId: 'session-a',
    ...overrides,
  }
  taskService.tasks.set(task.id, task)
  return task
}

test('waitAny returns the first conversation with a reply and keeps the others unread', async () => {
  const { tasks, dataDir } = await buildService(8765)
  try {
    seed(tasks, 'c1', { replies: [{ seq: 1, turn: 1, text: '第一件事的进展' }], replySeq: 1 })
    seed(tasks, 'c2', { replies: [{ seq: 1, turn: 1, text: '第二件事的进展' }], replySeq: 1 })
    const first = await tasks.waitAny(['c1', 'c2'], { timeoutMs: 1000 })
    assert.equal(first.task.conversationId, 'c1')
    assert.deepEqual(first.replies.map(reply => reply.text), ['第一件事的进展'])
    assert.equal(first.state, 'progress')
    assert.deepEqual(first.remaining.map(entry => entry.conversationId), ['c2'])
    assert.equal(tasks.tasks.get('task-c2').deliveredSeq, 0, 'the other conversation keeps its reply')
    assert.equal(tasks.tasks.get('task-c1').deliveredSeq, 1)
  } finally {
    await tasks.dispose()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('waitAny wins on a finished conversation even when it has no new text', async () => {
  const { tasks, dataDir } = await buildService(8765)
  try {
    seed(tasks, 'c1', { status: 'completed' })
    seed(tasks, 'c2', { status: 'running' })
    const result = await tasks.waitAny(['c2', 'c1'], { timeoutMs: 1000 })
    assert.equal(result.task.conversationId, 'c1')
    assert.equal(result.done, true)
    assert.equal(result.state, 'done')
    assert.deepEqual(result.remaining.map(entry => entry.conversationId), ['c2'])
  } finally {
    await tasks.dispose()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('waitAny refuses the whole call when one id is not tracked', async () => {
  const { tasks, dataDir } = await buildService(8765)
  try {
    seed(tasks, 'c1')
    await assert.rejects(() => tasks.waitAny(['c1', 'nope'], { timeoutMs: 100 }), /not tracked: nope/u)
    await assert.rejects(() => tasks.waitAny([], { timeoutMs: 100 }), /conversationId is required/u)
  } finally {
    await tasks.dispose()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('wait_member lists the conversations it did not return without wait hints', async () => {
  const member = await fakeMember()
  const { service, dataDir } = await buildStub(member.port)
  const wait = register(service).get('wait_member')
  seed(service.memberTasks, 'c1', { replies: [{ seq: 1, turn: 2, text: '第一条回复' }], replySeq: 1 })
  seed(service.memberTasks, 'c2', { turns: 3 })
  try {
    const result = await wait.execute({ conversationIds: ['c1', 'c2'] }, { signal: undefined })
    assert.equal(result.ok, true)
    assert.match(result.text, /第一条回复/u)
    assert.match(result.text, /还有 1 个会话没有返回/u)
    assert.match(result.text, /c2（B 10\.66\.66\.2，工作区 unknown，第 3 轮，进行中）/u)
    assert.doesNotMatch(result.text, /wait_member/u)
    assert.deepEqual(result.data.remaining.map(entry => entry.conversationId), ['c2'])
    assert.deepEqual(result.data.conversationIds, ['c1', 'c2'])
  } finally {
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('wait_member refuses conversationId and the all/conversationIds mix', async () => {
  const member = await fakeMember()
  const { service, dataDir } = await buildStub(member.port)
  const wait = register(service).get('wait_member')
  seed(service.memberTasks, 'c1', { replies: [{ seq: 1, turn: 1, text: '单独那个' }], replySeq: 1 })
  try {
    await assert.rejects(
      () => wait.execute({ conversationId: 'c1' }, { signal: undefined }),
      /不再接受 conversationId/u,
    )
    await assert.rejects(
      () => wait.execute({ all: true, conversationIds: ['c1'] }, { signal: undefined }),
      /all 和 conversationIds 互斥/u,
    )
    await assert.rejects(
      () => wait.execute({}, { signal: undefined }),
      /conversationIds is required/u,
    )
  } finally {
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('wait_member all waits every running conversation of this origin', async () => {
  const member = await fakeMember()
  const { service, dataDir } = await buildStub(member.port)
  const wait = register(service).get('wait_member')
  seed(service.memberTasks, 'c1', {
    workspace: 'dsh-mesh',
    replies: [{ seq: 1, turn: 2, text: '第一条回复' }],
    replySeq: 1,
  })
  seed(service.memberTasks, 'c2', { workspace: 'other', turns: 1 })
  try {
    const result = await wait.execute({ all: true }, { agent: { session: { id: 'session-a' } }, signal: undefined })
    assert.equal(result.ok, true)
    assert.equal(result.data.all, true)
    assert.deepEqual(result.data.conversationIds, ['c1', 'c2'])
    assert.match(result.text, /第一条回复/u)
    assert.deepEqual(result.data.remaining.map(entry => entry.conversationId), ['c2'])
    assert.deepEqual(result.data.conversations.map(entry => entry.workspace), ['dsh-mesh', 'other'])
    assert.deepEqual(result.data.conversations.map(entry => entry.statusLabel), ['进行中', '进行中'])
    assert.equal(result.data.conversations.find(entry => entry.current)?.conversationId, 'c1')
  } finally {
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('wait_member is refused when the main conversation switched it off', async () => {
  const member = await fakeMember()
  const { service, dataDir } = await buildStub(member.port)
  service.memberScope = async () => ({ waitMember: false })
  const wait = register(service).get('wait_member')
  try {
    const result = await wait.execute({ all: true }, { agent: { session: { id: 'session-a' } } })
    assert.equal(result.ok, false)
    assert.equal(result.data.disabled, true)
    assert.equal(result.data.waitMember, false)
    assert.match(result.text, /wait_member 已被关闭/u)
    assert.match(result.text, /set_member_scope/u)
  } finally {
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('wait_member all with nothing running is ok and lists every conversation', async () => {
  const member = await fakeMember()
  const { service, dataDir } = await buildStub(member.port)
  const wait = register(service).get('wait_member')
  seed(service.memberTasks, 'c1', {
    status: 'completed',
    workspace: 'dsh-mesh',
    turns: 3,
    replies: [{ seq: 1, turn: 3, text: '已经完成' }],
    replySeq: 1,
  })
  try {
    const result = await wait.execute({ all: true }, { agent: { session: { id: 'session-a' } }, signal: undefined })
    assert.equal(result.ok, true)
    assert.equal(result.data.waiting, false)
    assert.equal(result.data.state, 'idle')
    assert.deepEqual(result.data.conversationIds, [])
    assert.match(result.text, /本对话当前没有进行中的成员会话/u)
    assert.match(result.text, /c1（B 10\.66\.66\.2，工作区 dsh-mesh，空闲，第 3 轮）/u)
    assert.deepEqual(result.data.conversations.map(entry => entry.statusLabel), ['空闲'])
  } finally {
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a fan-out timeout names every conversation that is still running', async () => {
  const member = await fakeMember()
  const { service, dataDir } = await buildStub(member.port)
  const wait = register(service).get('wait_member')
  seed(service.memberTasks, 'c1')
  seed(service.memberTasks, 'c2')
  try {
    const result = await wait.execute({ conversationIds: ['c1', 'c2'], timeoutMs: 1000 }, { signal: undefined })
    assert.equal(result.ok, true)
    assert.equal(result.data.timedOut, true)
    assert.match(result.text, /等待超时/u)
    assert.match(result.text, /2 个会话在 1000 毫秒内都没有新回复/u)
    assert.match(result.text, /还有 2 个会话没有返回/u)
    assert.match(result.text, /c1（B 10\.66\.66\.2/u)
    assert.match(result.text, /c2（B 10\.66\.66\.2/u)
    assert.doesNotMatch(result.text, /wait_member/u)
    assert.deepEqual(result.data.remaining.map(entry => entry.conversationId), ['c1', 'c2'])
  } finally {
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('call_member points at every conversation the turn already has running', async () => {
  const member = await fakeMember()
  const agent = { id: 'session-a', session: { id: 'session-a' }, status: 'idle' }
  const { service, dataDir } = await buildStub(member.port)
  const call = register(service).get('call_member')
  seed(service.memberTasks, 'conv-old', { lastSentAt: '2026-11-24T00:00:00.000Z', turns: 2 })
  try {
    const result = await call.execute({ member: '127.0.0.1', prompt: '再跑一件' }, { agent })
    assert.match(result.text, /本对话跟踪的成员会话（共 2 个/u)
    assert.match(result.text, /conv-old/u)
    assert.match(result.text, /conv-new/u)
    assert.doesNotMatch(result.text, /wait_member/u)
    assert.equal(result.data.currentConversationId, 'conv-new')
    assert.deepEqual(result.data.conversations.map(entry => entry.conversationId), ['conv-old', 'conv-new'])
    assert.deepEqual(result.data.conversations.map(entry => entry.statusLabel), ['进行中', '进行中'])
    assert.deepEqual(result.data.conversations.map(entry => entry.workspace), ['unknown', 'default-workspace'])
    assert.equal(result.data.conversations.find(entry => entry.current)?.conversationId, 'conv-new')
  } finally {
    await service.memberTasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('call_member does not append a wait hint to a single conversation', async () => {
  const member = await fakeMember()
  const agent = { id: 'session-a', session: { id: 'session-a' }, status: 'idle' }
  const { service, dataDir } = await buildStub(member.port)
  const call = register(service).get('call_member')
  try {
    const result = await call.execute({ member: '127.0.0.1', prompt: '只跑一件' }, { agent })
    assert.match(result.text, /会话id：conv-new/u)
    assert.match(result.text, /本对话跟踪的成员会话（共 1 个/u)
    assert.doesNotMatch(result.text, /wait_member/u)
  } finally {
    await service.memberTasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('status_member reports several conversations in one call', async () => {
  const member = await fakeMember({ statusById: { c1: 'running' } })
  const { service, dataDir } = await buildStub(member.port)
  const status = register(service).get('status_member')
  const baseUrl = `http://127.0.0.1:${member.port}`
  seed(service.memberTasks, 'c1', { status: 'running', turns: 2, baseUrl })
  seed(service.memberTasks, 'c2', { status: 'completed', turns: 4, baseUrl })
  try {
    const result = await status.execute({ conversationIds: ['c1', 'c2', 'nope'] }, {})
    assert.equal(result.ok, true)
    assert.match(result.text, /成员会话状态：共 2 个（进行中 1，空闲 1）/u)
    assert.match(result.text, /\[1\] 成员会话 c1/u)
    assert.match(result.text, /\[2\] 成员会话 c2/u)
    assert.match(result.text, /最近一次思考：看一下磁盘。/u)
    assert.match(result.text, /本机没有跟踪这些会话：nope/u)
    assert.deepEqual(result.data.conversations.map(entry => entry.conversationId), ['c1', 'c2'])
    assert.deepEqual(result.data.missing, ['nope'])
  } finally {
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('status_member refuses a call that names only unknown conversations', async () => {
  const member = await fakeMember()
  const { service, dataDir } = await buildStub(member.port)
  const status = register(service).get('status_member')
  seed(service.memberTasks, 'c1')
  try {
    await assert.rejects(() => status.execute({ conversationIds: ['nope', 'nada'] }, {}), /本机没有跟踪会话 nope、nada/u)
    await assert.rejects(() => status.execute({}, {}), /conversationId is required/u)
  } finally {
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a member reply is steered into a running origin conversation instead of queued', async () => {
  const member = await fakeMember()
  const steered = []
  const followups = []
  const agent = {
    id: 'session-a',
    session: { id: 'session-a' },
    status: 'running',
    steer: message => { steered.push(message) },
    followup: message => { followups.push(message) },
  }
  const { tasks, dataDir } = await buildService(member.port, agent)
  try {
    const task = await tasks.send({ member: '127.0.0.1', conversationId: 'conv-9', prompt: '检查磁盘', agent })
    assert.equal(task.notify, true)
    const deadline = Date.now() + 15_000
    while (steered.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(steered.length, 1, 'the result must be steered into the running turn')
    assert.match(steered[0].content[0].text, /成员任务完成/u)
    assert.equal(steered[0].source.kind, 'user')
    assert.deepEqual(followups, [], 'a running conversation must not wait for the turn to end')
    assert.equal(task.notifiedVia, 'steer')
  } finally {
    await tasks.dispose()
    await member.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
