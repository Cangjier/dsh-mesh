import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MEMBER_STATUS_INTERVAL_MS,
  MEMBER_STATUS_SOURCE,
  createMemberContext,
  formatMemberStatusSnapshot,
} from '../src/lib/member-context.mjs'

/**
 * A task table that looks like the real service's origin lookups.
 * @param {object[]} tasks seeded tasks.
 * @returns {object} stub service.
 */
function taskService(tasks) {
  return {
    async inFlightForOrigin(sessionId) {
      return tasks.filter(task => task.originSessionId === sessionId &&
        (task.status === 'running' || task.status === 'starting'))
    },
    async listForOrigin(sessionId) {
      return tasks.filter(task => task.originSessionId === sessionId)
    },
  }
}

/**
 * Build one context harness.
 * @param {{tasks?: object[], sessionId?: string, now?: () => number, memberTasks?: object}} [options] knobs.
 * @returns {object} harness.
 */
function harness(options = {}) {
  const handlers = new Map()
  const disposers = []
  const logs = []
  const sessionId = options.sessionId ?? 'session-a'
  const ctx = {
    on(name, handler) {
      handlers.set(name, handler)
      const dispose = () => handlers.delete(name)
      disposers.push(dispose)
      return dispose
    },
  }
  const memberTasks = options.memberTasks ?? taskService(options.tasks ?? [])
  const context = createMemberContext({
    ctx,
    memberTasks,
    log: line => logs.push(line),
    now: options.now ?? (() => 1_000_000),
  })
  const preStep = handlers.get('agent/pre-step')
  const payload = {
    agent: { id: sessionId, session: { id: sessionId }, status: 'running' },
    messages: [],
    turn: 1,
    step: 1,
    signal: { aborted: false },
  }
  const next = async () => ({ kind: 'enter', messages: [] })
  return { context, handlers, preStep, payload, next, logs, sessionId }
}

const running = {
  id: 'task-c1',
  conversationId: 'c1',
  member: 'B',
  memberIp: '10.66.66.2',
  workspace: 'dsh-mesh',
  status: 'running',
  turns: 2,
  originSessionId: 'session-a',
}
const settled = {
  id: 'task-c2',
  conversationId: 'c2',
  member: 'B',
  memberIp: '10.66.66.2',
  status: 'completed',
  turns: 4,
  originSessionId: 'session-a',
}

test('a step with running member conversations carries one status snapshot', async () => {
  const h = harness({ tasks: [running, settled] })
  try {
    const decision = await h.preStep(h.payload, h.next)
    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 1)
    const message = decision.messages[0]
    assert.equal(message.role, 'user')
    assert.notEqual(message.source.kind, 'user')
    assert.equal(message.source.kind, MEMBER_STATUS_SOURCE)
    assert.equal(message.source.form, 'snapshot')
    const text = message.content[0].text
    assert.match(text, /本对话跟踪 2 个成员会话，其中 1 个进行中/u)
    assert.match(text, /c1（B 10\.66\.66\.2，工作区 dsh-mesh，进行中，第 2 轮）/u)
    assert.match(text, /c2（B 10\.66\.66\.2，工作区 unknown，空闲，第 4 轮）/u)
    assert.match(text, /wait_member \{ "all": true \}/u)
  } finally {
    h.context.dispose()
  }
})

test('no running conversation means no injection', async () => {
  const h = harness({ tasks: [settled] })
  try {
    const decision = await h.preStep(h.payload, h.next)
    assert.deepEqual(decision.messages, [])
  } finally {
    h.context.dispose()
  }
})

test('a second step within 30 seconds is not injected again', async () => {
  let now = 1_000_000
  const h = harness({ tasks: [running], now: () => now })
  try {
    const first = await h.preStep(h.payload, h.next)
    assert.equal(first.messages.length, 1)
    now += MEMBER_STATUS_INTERVAL_MS - 1
    const second = await h.preStep(h.payload, h.next)
    assert.deepEqual(second.messages, [])
    now += 1
    const third = await h.preStep(h.payload, h.next)
    assert.equal(third.messages.length, 1)
  } finally {
    h.context.dispose()
  }
})

test('a member read failure is swallowed and the step proceeds unchanged', async () => {
  const memberTasks = {
    async inFlightForOrigin() { throw new Error('member table unavailable') },
    async listForOrigin() { return [] },
  }
  const h = harness({ memberTasks })
  try {
    const decision = await h.preStep(h.payload, h.next)
    assert.equal(decision.kind, 'enter')
    assert.deepEqual(decision.messages, [])
    assert.equal(h.logs.some(line => /member status context skipped.*member table unavailable/u.test(line)), true)
  } finally {
    h.context.dispose()
  }
})

test('a rejected step is returned untouched', async () => {
  let looked = 0
  const memberTasks = {
    async inFlightForOrigin() { looked += 1; return [running] },
    async listForOrigin() { return [running] },
  }
  const h = harness({ memberTasks })
  try {
    const rejected = await h.preStep(h.payload, async () => ({ kind: 'reject' }))
    assert.deepEqual(rejected, { kind: 'reject' })
    assert.equal(looked, 0)
  } finally {
    h.context.dispose()
  }
})

test('disposing a session forgets its injection clock', async () => {
  let now = 1_000_000
  const h = harness({ tasks: [running], now: () => now })
  try {
    const first = await h.preStep(h.payload, h.next)
    assert.equal(first.messages.length, 1)
    h.handlers.get('session/disposed')({ id: h.sessionId })
    now += 1
    const second = await h.preStep(h.payload, h.next)
    assert.equal(second.messages.length, 1, 'a fresh session may inject again at once')
  } finally {
    h.context.dispose()
  }
})

test('the snapshot formatter covers every documented state', () => {
  const text = formatMemberStatusSnapshot([
    { ...running, conversationId: 'a', status: 'running' },
    { ...running, conversationId: 'b', status: 'starting' },
    { ...running, conversationId: 'c', status: 'completed' },
    { ...running, conversationId: 'd', status: 'failed' },
    { ...running, conversationId: 'e', status: 'interrupted' },
  ], { now: 1_000_000 })
  assert.match(text, /a（B 10\.66\.66\.2，工作区 dsh-mesh，进行中/u)
  assert.match(text, /b（B 10\.66\.66\.2，工作区 dsh-mesh，进行中/u)
  assert.match(text, /c（B 10\.66\.66\.2，工作区 dsh-mesh，空闲/u)
  assert.match(text, /d（B 10\.66\.66\.2，工作区 dsh-mesh，异常中止/u)
  assert.match(text, /e（B 10\.66\.66\.2，工作区 dsh-mesh，异常中止/u)
})
