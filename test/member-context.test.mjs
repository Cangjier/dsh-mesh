import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MEMBER_PUSH_DELAY_MS,
  MEMBER_STATUS_INTERVAL_MS,
  MEMBER_STATUS_SOURCE,
  createMemberContext,
  formatMemberStatusSignature,
  formatMemberStatusSnapshot,
} from '../src/lib/member-context.mjs'
import { markMemberSession, unmarkMemberSession } from '../src/lib/member-sessions.mjs'

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
  const followups = []
  const sessionId = options.sessionId ?? 'session-a'
  const agent = options.agent ?? {
    id: sessionId,
    session: { id: sessionId },
    status: 'idle',
    followup: message => { followups.push(message) },
  }
  const scopes = options.scopes ?? {}
  const service = options.service ?? { async memberScopes() { return scopes } }
  const ctx = {
    on(name, handler) {
      handlers.set(name, handler)
      const dispose = () => handlers.delete(name)
      disposers.push(dispose)
      return dispose
    },
    get(name) {
      if (name === 'agents') return { get: id => (id === sessionId ? agent : undefined) }
      return undefined
    },
  }
  const memberTasks = options.memberTasks ?? taskService(options.tasks ?? [])
  const context = createMemberContext({
    ctx,
    memberTasks,
    service,
    log: line => logs.push(line),
    now: options.now ?? (() => 1_000_000),
    intervalMs: options.intervalMs,
    pushDelayMs: options.pushDelayMs ?? MEMBER_PUSH_DELAY_MS,
  })
  const preStep = handlers.get('agent/pre-step')
  const session = { id: sessionId }
  const emit = (type, data) => {
    handlers.get('session/event')?.(session, { type, data })
  }
  const payload = {
    agent: { id: sessionId, session: { id: sessionId }, status: 'running' },
    messages: [],
    turn: 1,
    step: 1,
    signal: { aborted: false },
  }
  const next = async () => ({ kind: 'enter', messages: [] })
  return { context, handlers, preStep, payload, next, logs, sessionId, agent, followups, emit, session, scopes }
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

test('a second step within the 60 second interval is not injected again', async () => {
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

test('an aborted step is returned untouched', async () => {
  let looked = 0
  const memberTasks = {
    async inFlightForOrigin() { looked += 1; return [running] },
    async listForOrigin() { return [running] },
  }
  const h = harness({ memberTasks })
  try {
    const aborted = { ...h.payload, signal: { aborted: true } }
    const decision = await h.preStep(aborted, h.next)
    assert.deepEqual(decision.messages, [])
    assert.equal(looked, 0, 'a cancelled turn must not read the member task table')
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

test('a snapshot shows each conversation identity and work scope', () => {
  const text = formatMemberStatusSnapshot([
    { ...running, conversationId: 'c1', profile: { name: 'B', identity: '开发', scope: '插件开发' } },
    { ...settled, conversationId: 'c2', profile: { name: 'B', identity: '测试', scope: null } },
  ], { now: 1_000_000 })
  assert.match(text, /c1（B 10\.66\.66\.2，工作区 dsh-mesh，进行中，第 2 轮）身份：开发；工作范围：插件开发/u)
  assert.match(text, /c2（B 10\.66\.66\.2，工作区 unknown，空闲，第 4 轮）身份：测试；工作范围：未设置/u)
  assert.equal(text.match(/下次 call_member 带 identity 和 scope 参数/gu)?.length, 1, 'one aggregate hint, not one per line')
  assert.match(text, /还有成员会话没有身份\/工作范围：c2（B）/u)
})

test('a fully profiled snapshot carries no profile hint', () => {
  const text = formatMemberStatusSnapshot([
    { ...running, profile: { name: 'B', identity: '开发', scope: '插件开发' } },
    { ...settled, profile: { name: 'B', identity: '测试', scope: '验收' } },
  ], { now: 1_000_000 })
  assert.doesNotMatch(text, /下次 call_member 带 identity 和 scope 参数/u)
})

test('an old conversation without a profile snapshot is reported as missing', () => {
  const text = formatMemberStatusSnapshot([{ ...running, conversationId: 'legacy' }], { now: 1_000_000 })
  assert.match(text, /legacy（B 10\.66\.66\.2，工作区 dsh-mesh，进行中，第 2 轮）身份：未设置；工作范围：未设置/u)
  assert.match(text, /还有成员会话没有身份\/工作范围：legacy（B）/u)
  assert.equal(text.match(/下次 call_member 带 identity 和 scope 参数/gu)?.length, 1)
})

test('the injection interval is 60 seconds and the push delay is 30 seconds', () => {
  assert.equal(MEMBER_STATUS_INTERVAL_MS, 60_000)
  assert.equal(MEMBER_PUSH_DELAY_MS, 30_000)
})

test('a snapshot shows the self identity, work scope and keep state', () => {
  const text = formatMemberStatusSnapshot([], {
    now: 1_000_000,
    selfId: 'session-a',
    selfScope: { identity: '网关', scope: '成员发现', keep: false },
  })
  assert.match(text, /自身（会话 session-a）：身份：网关；工作范围：成员发现；保持目标：关闭（只对主对话生效）/u)
  assert.doesNotMatch(text, /还没有身份\/工作范围/u)
})

test('a snapshot asks for the self scope and marks missing fields', () => {
  const text = formatMemberStatusSnapshot([], { now: 1_000_000, selfId: 'session-a' })
  assert.match(text, /自身（会话 session-a）：身份：未设置；工作范围：未设置；保持目标：开启（只对主对话生效）/u)
  assert.match(text, /自身还没有身份\/工作范围：用 set_member_scope（省略 conversationId 或传 self）设置自身身份和工作范围。/u)
})

test('a stored scope wins over the task profile snapshot', () => {
  const text = formatMemberStatusSnapshot([{
    ...running,
    profile: { name: 'B', identity: '旧身份', scope: '旧范围' },
  }], {
    now: 1_000_000,
    selfId: 'session-a',
    selfScope: { identity: '网关', scope: '成员发现' },
    scopes: { c1: { identity: '新身份', scope: '新范围' } },
  })
  assert.match(text, /c1（B 10\.66\.66\.2，工作区 dsh-mesh，进行中，第 2 轮）身份：新身份；工作范围：新范围/u)
})

/** Let the push timer and its async reads finish. */
async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

test('a main turn end pushes the snapshot after the quiet delay', async () => {
  const h = harness({
    tasks: [running],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', keep: true } },
    pushDelayMs: 15,
  })
  try {
    h.emit('turn/start', { turn: 1 })
    h.emit('turn/end', { turn: 1 })
    await sleep(80)
    assert.equal(h.followups.length, 1)
    const message = h.followups[0]
    assert.equal(message.role, 'user')
    assert.equal(message.source.kind, MEMBER_STATUS_SOURCE)
    assert.equal(message.source.form, 'push')
    assert.match(message.content[0].text, /自身（会话 session-a）：身份：网关；工作范围：成员发现/u)
    assert.match(message.content[0].text, /c1（B 10\.66\.66\.2，工作区 dsh-mesh，进行中，第 2 轮）/u)
    assert.equal(h.context.lastInjection.has('session-a'), true)
  } finally {
    h.context.dispose()
  }
})

test('the same snapshot signature is not pushed twice', async () => {
  const h = harness({
    tasks: [running],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', keep: true } },
    pushDelayMs: 15,
  })
  try {
    h.emit('turn/start', { turn: 1 })
    h.emit('turn/end', { turn: 1 })
    await sleep(80)
    assert.equal(h.followups.length, 1)
    h.emit('turn/start', { turn: 2 })
    h.emit('turn/end', { turn: 2 })
    await sleep(80)
    assert.equal(h.followups.length, 1, 'unchanged content must not repeat')
  } finally {
    h.context.dispose()
  }
})

test('a changed task signature is pushed again', async () => {
  const task = { ...running }
  const h = harness({
    tasks: [task],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', keep: true } },
    pushDelayMs: 15,
  })
  try {
    h.emit('turn/start', { turn: 1 })
    h.emit('turn/end', { turn: 1 })
    await sleep(80)
    assert.equal(h.followups.length, 1)
    task.status = 'completed'
    task.turns = 3
    h.emit('turn/start', { turn: 2 })
    h.emit('turn/end', { turn: 2 })
    await sleep(80)
    assert.equal(h.followups.length, 2)
    assert.match(h.followups[1].content[0].text, /空闲，第 3 轮/u)
  } finally {
    h.context.dispose()
  }
})

test('keep=false suppresses the active push', async () => {
  const h = harness({
    tasks: [running],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', keep: false } },
    pushDelayMs: 15,
  })
  try {
    h.emit('turn/start', { turn: 1 })
    h.emit('turn/end', { turn: 1 })
    await sleep(80)
    assert.equal(h.followups.length, 0)
  } finally {
    h.context.dispose()
  }
})

test('a member conversation never receives the active push', async () => {
  const h = harness({
    tasks: [running],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', keep: true } },
    pushDelayMs: 15,
  })
  markMemberSession('session-a')
  try {
    h.emit('turn/start', { turn: 1 })
    h.emit('turn/end', { turn: 1 })
    await sleep(80)
    assert.equal(h.followups.length, 0)
  } finally {
    unmarkMemberSession('session-a')
    h.context.dispose()
  }
})

test('turn/start cancels the pending push', async () => {
  const h = harness({
    tasks: [running],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', keep: true } },
    pushDelayMs: 40,
  })
  try {
    h.emit('turn/end', { turn: 1 })
    h.emit('turn/start', { turn: 2 })
    await sleep(100)
    assert.equal(h.followups.length, 0)
  } finally {
    h.context.dispose()
  }
})

test('a conversation with neither tasks nor a self scope does not schedule a push', async () => {
  const h = harness({ tasks: [], scopes: {}, pushDelayMs: 15 })
  try {
    h.emit('turn/start', { turn: 1 })
    h.emit('turn/end', { turn: 1 })
    await sleep(80)
    assert.equal(h.followups.length, 0)
  } finally {
    h.context.dispose()
  }
})
