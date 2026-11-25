import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { registerTools } from '../src/lib/tools.mjs'

/**
 * Start a minimal member interop endpoint that answers one conversation read.
 * @param {{status?: string, turns?: number}} [conversation] projection.
 * @returns {Promise<{server: import('node:http').Server, port: number}>} endpoint.
 */
async function fakeMember(conversation = {}) {
  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer test-token') {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'bad token' } }))
      return
    }
    if (request.method === 'GET' && request.url === '/v1/conversations/conv-1') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        ok: true,
        conversation: {
          id: 'conv-1',
          status: conversation.status ?? 'idle',
          turns: conversation.turns ?? 2,
          lastText: '已完成',
          lastReasoning: '先检查磁盘，再看日志。',
          error: null,
          context: { usedTokens: 1200, maxTokens: 1_000_000, percent: 0.1 },
        },
      }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'not found' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

/**
 * Register the tools with a tracked task and return `status_member`.
 * @param {object} options harness inputs.
 * @returns {Promise<{tool: object, dataDir: string, cleanup: () => Promise<void>, service: object}>} harness.
 */
async function harness(options = {}) {
  const member = await fakeMember(options.conversation)
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'status-member-'))
  const service = {
    config: { interopToken: 'test-token' },
    dataDir,
    repositoryRoot: process.cwd(),
    members: async () => ({ local: { id: 'local', name: 'a', ip: '127.0.0.1' }, members: [] }),
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: () => () => {},
    get: () => undefined,
  }
  const tools = []
  registerTools(ctx, { tools: { register: tool => { tools.push(tool) } } }, service)
  service.memberTasks.tasks.set('member-test', {
    id: 'member-test',
    conversationId: 'conv-1',
    member: 'build-2',
    memberIp: '10.66.66.2',
    baseUrl: `http://127.0.0.1:${member.port}`,
    prompt: '第一条消息',
    status: options.status ?? 'completed',
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:10:00.000Z',
    lastText: '已完成',
    error: null,
    turns: 2,
    workspace: 'dsh-mesh',
    originSessionId: 'session-1',
    originAgentId: 'session-1',
    sentMessages: [
      { text: '第一条消息', at: '2026-11-24T00:00:00.000Z' },
      { text: '第二条消息', at: '2026-11-24T00:05:00.000Z' },
    ],
  })
  return {
    tool: tools.find(candidate => candidate.name === 'status_member'),
    dataDir,
    service,
    cleanup: async () => {
      await new Promise(resolve => member.server.close(resolve))
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}

test('status_member reports live status and the last two user messages', async () => {
  const { tool, cleanup } = await harness()
  try {
    assert.notEqual(tool, undefined)
    const result = await tool.execute({ conversationId: 'conv-1' }, {})
    assert.equal(result.ok, true)
    assert.match(result.text, /状态：空闲（目标实时）/u)
    assert.match(result.text, /轮次 2/u)
    assert.match(result.text, /最近两次用户消息（旧→新）：/u)
    const first = result.text.indexOf('第一条消息')
    const second = result.text.indexOf('第二条消息')
    assert.equal(first >= 0 && second > first, true)
    assert.match(result.text, /最近一次思考：先检查磁盘，再看日志。/u)
    assert.equal(result.data.status, 'idle')
    assert.equal(result.data.taskStatus, 'completed')
    assert.deepEqual(result.data.messages.map(message => message.text), ['第一条消息', '第二条消息'])
    assert.equal(result.data.reasoning, '先检查磁盘，再看日志。')
    assert.equal(result.data.workspace, 'dsh-mesh')
    assert.match(result.text, /工作区：dsh-mesh/u)
    assert.match(result.text, /备注：未设置/u)
    assert.match(result.text, /本对话跟踪的成员会话（共 1 个/u)
  } finally {
    await cleanup()
  }
})

test('status_member shows the main-only note for a conversation', async () => {
  const { tool, service, cleanup } = await harness()
  try {
    service.memberScopes = async () => ({ 'conv-1': { note: '只读复核，不要改内核文件' } })
    const result = await tool.execute({ conversationId: 'conv-1' }, {})
    assert.equal(result.ok, true)
    assert.match(result.text, /备注：只读复核，不要改内核文件/u)
    assert.equal(result.data.note, '只读复核，不要改内核文件')
  } finally {
    await cleanup()
  }
})

test('status_member lists every tracked conversation with its state and workspace', async () => {
  const { tool, service, cleanup } = await harness()
  try {
    service.memberTasks.tasks.set('member-two', {
      id: 'member-two',
      conversationId: 'conv-2',
      member: 'build-3',
      memberIp: '10.66.66.3',
      baseUrl: 'http://127.0.0.1:1',
      prompt: '另一个任务',
      status: 'running',
      createdAt: '2026-11-24T00:01:00.000Z',
      updatedAt: '2026-11-24T00:11:00.000Z',
      lastText: '',
      error: null,
      turns: 1,
      workspace: 'other-workspace',
      originSessionId: 'session-1',
      originAgentId: 'session-1',
      sentMessages: [{ text: '另一个任务', at: '2026-11-24T00:01:00.000Z' }],
    })
    const result = await tool.execute({ conversationId: 'conv-1' }, {})
    assert.equal(result.ok, true)
    assert.match(result.text, /本对话跟踪的成员会话（共 2 个/u)
    assert.match(result.text, /conv-2（build-3 10\.66\.66\.3，工作区 other-workspace，进行中，第 1 轮）/u)
    assert.deepEqual(result.data.conversations.map(entry => entry.conversationId), ['conv-1', 'conv-2'])
    assert.deepEqual(result.data.conversations.map(entry => entry.workspace), ['dsh-mesh', 'other-workspace'])
    assert.deepEqual(result.data.conversations.map(entry => entry.statusLabel), ['空闲', '进行中'])
    assert.equal(result.data.requested.length, 1)
    assert.equal(result.data.requested[0].conversationId, 'conv-1')
    assert.equal(result.data.count, 2)
  } finally {
    await cleanup()
  }
})

test('status_member labels an abnormally stopped conversation', async () => {
  const { tool, cleanup } = await harness({ status: 'interrupted', conversation: { status: 'interrupted' } })
  try {
    const result = await tool.execute({ conversationId: 'conv-1' }, {})
    assert.match(result.text, /状态：异常中止（目标实时）/u)
    assert.equal(result.data.status, 'interrupted')
  } finally {
    await cleanup()
  }
})

test('status_member refuses a conversation this host does not track', async () => {
  const { tool, cleanup } = await harness()
  try {
    await assert.rejects(tool.execute({ conversationId: 'unknown' }, {}), /本机没有跟踪会话 unknown/u)
    await assert.rejects(tool.execute({}, {}), /conversationId is required/u)
  } finally {
    await cleanup()
  }
})

test('status_member shows identity and scope and asks for missing ones once', async () => {
  const { tool, service, cleanup } = await harness()
  try {
    const result = await tool.execute({ conversationId: 'conv-1' }, {})
    assert.match(result.text, /身份：未设置；工作范围：未设置/u)
    assert.match(result.text, /conv-1（build-2 10\.66\.66\.2，工作区 dsh-mesh，空闲，第 2 轮） 身份：未设置；工作范围：未设置/u)
    assert.match(result.text, /还有成员会话没有身份\/工作范围：conv-1（build-2）/u)
    assert.equal(result.text.match(/下次 call_member 带 identity 和 scope 参数/gu)?.length, 1)
    assert.equal(result.data.identity, null)
    assert.equal(result.data.scope, null)
    assert.equal(result.data.conversations[0].identity, null)

    service.memberTasks.tasks.get('member-test').profile = {
      name: 'build-2',
      identity: '测试',
      scope: '跨平台验收',
    }
    const profiled = await tool.execute({ conversationId: 'conv-1' }, {})
    assert.match(profiled.text, /身份：测试；工作范围：跨平台验收/u)
    assert.match(profiled.text, /conv-1（build-2 10\.66\.66\.2，工作区 dsh-mesh，空闲，第 2 轮） 身份：测试；工作范围：跨平台验收/u)
    assert.doesNotMatch(profiled.text, /下次 call_member 带 identity 和 scope 参数/u)
    assert.equal(profiled.data.conversations[0].identity, '测试')
    assert.equal(profiled.data.conversations[0].scope, '跨平台验收')
  } finally {
    await cleanup()
  }
})


test('status_member prefers member-scopes.json over the task profile snapshot', async () => {
  const { tool, service, cleanup } = await harness()
  try {
    const task = service.memberTasks.tasks.get('member-test')
    task.profile = { name: 'build-2', identity: '旧身份', scope: '旧范围' }
    service.memberScopes = async () => ({ 'conv-1': { identity: '新身份', scope: '新范围' } })
    const result = await tool.execute({ conversationId: 'conv-1' }, {})
    assert.match(result.text, /身份：新身份；工作范围：新范围/u)
    assert.doesNotMatch(result.text, /下次 call_member 带 identity 和 scope 参数/u)
    assert.equal(result.data.identity, '新身份')
    assert.equal(result.data.conversations[0].identity, '新身份')
  } finally {
    await cleanup()
  }
})
