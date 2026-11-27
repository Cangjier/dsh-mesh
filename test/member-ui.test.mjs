import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { MeshService } from '../src/lib/service.mjs'
import { registerApi } from '../src/lib/http-api.mjs'
import {
  MEMBER_UI_TASK_MAX,
  memberConversationEntries,
  memberConversationEntry,
  memberConversationSummary,
  memberShortLabel,
} from '../src/lib/member-ui.mjs'

/** One running task on member 10.66.66.3. */
const task = {
  conversationId: 'conv-c1',
  member: 'ecs-92994806',
  memberIp: '10.66.66.3',
  workspace: 'ai-cad-kernel4',
  status: 'running',
  turns: 2,
  originSessionId: 'session-a',
  profile: { name: 'ecs-92994806', identity: '内核开发4', scope: 'kernel/**' },
  prompt: '把三支未合的 dressup 分支整合到 master',
  createdAt: '2026-11-26T06:00:00.000Z',
  updatedAt: '2026-11-26T07:02:03.267Z',
  lastSentAt: '2026-11-26T07:01:00.000Z',
}

test('the member label is the VPN address tail, with a name fallback', () => {
  assert.equal(memberShortLabel(task), '3')
  assert.equal(memberShortLabel({ ...task, memberIp: '10.66.66.40' }), '40')
  assert.equal(memberShortLabel({ ...task, memberIp: '' }), 'ecs-92994806')
  assert.equal(memberShortLabel({ member: '', memberIp: null }), 'unknown')
})

test('one conversation row carries the facts the chip and the detail view need', () => {
  const entry = memberConversationEntry(task)
  assert.equal(entry.conversationId, 'conv-c1')
  assert.equal(entry.memberLabel, '3')
  assert.equal(entry.memberName, 'ecs-92994806')
  assert.equal(entry.workspace, 'ai-cad-kernel4')
  assert.equal(entry.identity, '内核开发4')
  assert.equal(entry.scope, 'kernel/**')
  assert.equal(entry.status, 'running')
  assert.equal(entry.statusLabel, '进行中')
  assert.equal(entry.turns, 2)
  assert.equal(entry.lastTask, task.prompt, 'a record without lastTaskText falls back to its first prompt')
  assert.equal(entry.updatedAt, task.updatedAt)
})

test('a stored scope wins over the task profile snapshot', () => {
  const entry = memberConversationEntry(task, {
    'conv-c1': { identity: '新身份', scope: '新范围', note: '只读复核', compressPercent: 10 },
  })
  assert.equal(entry.identity, '新身份')
  assert.equal(entry.scope, '新范围')
  assert.equal(entry.note, '只读复核')
  assert.equal(entry.compressPercent, 10)
})

test('a conversation without a profile is still listed, marked unset', () => {
  const entry = memberConversationEntry({
    conversationId: 'legacy',
    member: 'ecs-92994806',
    memberIp: '10.66.66.3',
    workspace: 'unknown',
    status: 'completed',
    turns: 0,
  })
  assert.equal(entry.identity, null)
  assert.equal(entry.scope, null)
  assert.equal(entry.statusLabel, '空闲')
  assert.equal(entry.turns, 0)
})

test('status labels cover running, idle and interrupted', () => {
  const labels = ['running', 'completed', 'interrupted'].map(status =>
    memberConversationEntry({ ...task, status }).statusLabel)
  assert.deepEqual(labels, ['进行中', '空闲', '异常中止'])
})

test('the task text is the latest one and it is bounded', () => {
  const entry = memberConversationEntry({ ...task, prompt: '第一轮', lastTaskText: '第三轮' })
  assert.equal(entry.lastTask, '第三轮')
  const long = memberConversationEntry({ ...task, lastTaskText: 'x'.repeat(MEMBER_UI_TASK_MAX + 50) })
  assert.equal(long.lastTask.length, MEMBER_UI_TASK_MAX + 1)
  assert.ok(long.lastTask.endsWith('…'))
})

test('the summary counts every conversation and the running ones', () => {
  const entries = memberConversationEntries([
    task,
    { ...task, conversationId: 'conv-c2', status: 'starting' },
    { ...task, conversationId: 'conv-c3', status: 'completed' },
    { ...task, conversationId: 'conv-c4', status: 'interrupted' },
  ])
  assert.deepEqual(memberConversationSummary(entries), { total: 4, running: 2 })
  assert.equal(entries.length, 4)
  assert.deepEqual(entries.map(entry => entry.conversationId), ['conv-c1', 'conv-c2', 'conv-c3', 'conv-c4'])
})

test('the service lists one origin conversation and counts its members', async () => {
  const service = Object.create(MeshService.prototype)
  const asked = []
  service.memberTasks = {
    async listForOrigin(sessionId) {
      asked.push(sessionId)
      return [task, { ...task, conversationId: 'conv-c2', status: 'completed' }]
    },
  }
  service.memberScopes = async () => ({ 'conv-c2': { identity: '测试1' } })
  const result = await service.memberConversations('session-a')
  assert.deepEqual(asked, ['session-a'])
  assert.equal(result.ok, true)
  assert.equal(result.total, 2)
  assert.equal(result.running, 1)
  assert.equal(result.conversations[1].identity, '测试1')
})

test('the service answers with an empty list before the task table exists', async () => {
  const service = Object.create(MeshService.prototype)
  service.memberScopes = async () => ({})
  const result = await service.memberConversations('session-a')
  assert.deepEqual(result, { ok: true, total: 0, running: 0, conversations: [], stage: null, budget: null })
  const blank = await service.memberConversations('')
  assert.deepEqual(blank.conversations, [])
})

/** Register the panel API over a stub service and expose its handler. */
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

test('the member-conversation route serves one session and rejects nothing else', async () => {
  const asked = []
  const call = apiCaller({
    async memberConversations(sessionId) {
      asked.push(sessionId)
      return {
        ok: true,
        total: 1,
        running: 1,
        conversations: [memberConversationEntry(task)],
      }
    },
  })
  const result = await call('GET', '/api/dsh-mesh/member-conversations?session=session-a')
  assert.equal(result.status, 200)
  assert.equal(result.body.total, 1)
  assert.equal(result.body.conversations[0].memberLabel, '3')
  assert.deepEqual(asked, ['session-a'])

  const blank = await call('GET', '/api/dsh-mesh/member-conversations')
  assert.equal(blank.status, 200)
  assert.deepEqual(asked, ['session-a', ''])
})
