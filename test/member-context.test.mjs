import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  MEMBER_REVIEW_INTERVAL_MS,
  MEMBER_STATUS_INTERVAL_MS,
  MEMBER_CONTEXT_SOURCE,
  createMemberContext,
  formatMemberDispatchPush,
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
 * @param {{tasks?: object[], sessionId?: string, now?: () => number, memberTasks?: object, services?: Record<string, any>, scopes?: Record<string, object>, reviewIntervalMs?: number}} [options] knobs.
 * @returns {object} harness.
 */
function harness(options = {}) {
  const handlers = new Map()
  const disposers = []
  const logs = []
  const followups = []
  const sessionId = options.sessionId ?? 'session-a'
  /** One session object, carrying a project directory when the test sets one. */
  const sessionOf = (id) => ({ id, ...(options.cwd === undefined ? {} : { header: { cwd: options.cwd } }) })
  const agent = options.agent ?? {
    id: sessionId,
    session: sessionOf(sessionId),
    status: 'idle',
    followup: message => { followups.push(message) },
  }
  const scopes = options.scopes ?? {}
  const service = options.service ?? { async memberScopes() { return scopes } }
  const services = options.services ?? {}
  const ctx = {
    on(name, handler) {
      handlers.set(name, handler)
      const dispose = () => handlers.delete(name)
      disposers.push(dispose)
      return dispose
    },
    get(name) {
      if (name === 'agents') return { get: id => (id === sessionId ? agent : undefined) }
      return services[name]
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
    reviewIntervalMs: options.reviewIntervalMs,
  })
  const preStep = handlers.get('agent/pre-step')
  const session = { id: sessionId }
  const emit = (type, data) => {
    handlers.get('session/event')?.(session, { type, data })
  }
  const payload = {
    agent: { id: sessionId, session: sessionOf(sessionId), status: 'running' },
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
    assert.equal(message.source.kind, MEMBER_CONTEXT_SOURCE)
    assert.equal(message.source.form, 'snapshot')
    const text = message.content[0].text
    assert.match(text, /本对话跟踪 2 个成员会话，其中 1 个进行中/u)
    assert.match(text, /工作区：dsh-mesh；会话：c1（B 10\.66\.66\.2，进行中，第 2 轮）/u)
    assert.match(text, /工作区：unknown；会话：c2（B 10\.66\.66\.2，空闲，第 4 轮）/u)
    assert.match(text, /^\[成员上下文\]/u)
    assert.doesNotMatch(text, /wait_member/u)
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
  assert.match(text, /工作区：dsh-mesh；会话：a（B 10\.66\.66\.2，进行中/u)
  assert.match(text, /工作区：dsh-mesh；会话：b（B 10\.66\.66\.2，进行中/u)
  assert.match(text, /工作区：dsh-mesh；会话：c（B 10\.66\.66\.2，空闲/u)
  assert.match(text, /工作区：dsh-mesh；会话：d（B 10\.66\.66\.2，异常中止/u)
  assert.match(text, /工作区：dsh-mesh；会话：e（B 10\.66\.66\.2，异常中止/u)
})

test('a snapshot shows each conversation identity and work scope', () => {
  const text = formatMemberStatusSnapshot([
    { ...running, conversationId: 'c1', profile: { name: 'B', identity: '开发', scope: '插件开发' } },
    { ...settled, conversationId: 'c2', profile: { name: 'B', identity: '测试', scope: null } },
  ], { now: 1_000_000 })
  assert.match(text, /身份：开发；工作区：dsh-mesh；会话：c1（B 10\.66\.66\.2，进行中，第 2 轮）；工作范围：插件开发/u)
  assert.match(text, /身份：测试；工作区：unknown；会话：c2（B 10\.66\.66\.2，空闲，第 4 轮）；工作范围：未设置/u)
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
  assert.match(text, /身份：未设置；工作区：dsh-mesh；会话：legacy（B 10\.66\.66\.2，进行中，第 2 轮）；工作范围：未设置/u)
  assert.match(text, /还有成员会话没有身份\/工作范围：legacy（B）/u)
  assert.equal(text.match(/下次 call_member 带 identity 和 scope 参数/gu)?.length, 1)
})

test('the status interval is 60 seconds and the review interval is 10 minutes', () => {
  assert.equal(MEMBER_STATUS_INTERVAL_MS, 60_000)
  assert.equal(MEMBER_REVIEW_INTERVAL_MS, 600_000)
})

test('a snapshot shows the self identity, work scope, keep state and effective settings', () => {
  const text = formatMemberStatusSnapshot([], {
    now: 1_000_000,
    selfId: 'session-a',
    selfScope: { identity: '网关', scope: '成员发现', keep: false, compressPercent: 12.5 },
  })
  assert.match(text, /身份：网关（自身，会话 session-a）；工作范围：成员发现；保持目标：关闭（只对主对话生效）；避免耗时：关闭（只对主对话生效）；压缩阈值：12\.5%/u)
  assert.doesNotMatch(text, /还没有身份\/工作范围/u)
  assert.doesNotMatch(text, /静默推送/u, 'the quiet push delay is gone')
})

test('a snapshot shows the default 35% threshold and keep off', () => {
  const text = formatMemberStatusSnapshot([], { now: 1_000_000, selfId: 'session-a' })
  assert.match(text, /保持目标：关闭（只对主对话生效）/u)
  assert.match(text, /压缩阈值：35%/u)
})

test('a member line shows the main-only note when the scope carries one', () => {
  const text = formatMemberStatusSnapshot([
    { ...running, conversationId: 'c1' },
  ], {
    now: 1_000_000,
    selfId: 'session-a',
    scopes: { c1: { note: '只读复核，不要改内核文件' } },
  })
  assert.match(text, /身份：未设置；工作区：dsh-mesh；会话：c1（B 10\.66\.66\.2，进行中，第 2 轮）；工作范围：未设置；备注：只读复核，不要改内核文件/u)
})

test('a member line only shows an explicitly configured compression threshold', () => {
  const text = formatMemberStatusSnapshot([
    { ...running, conversationId: 'c1' },
    { ...settled, conversationId: 'c2' },
  ], {
    now: 1_000_000,
    scopes: { c1: { compressPercent: 10 } },
  })
  assert.match(text, /身份：未设置；工作区：dsh-mesh；会话：c1（B 10\.66\.66\.2，进行中，第 2 轮）；工作范围：未设置；压缩阈值：10%/u)
  assert.doesNotMatch(text, /c2（B[^\n]*压缩阈值/u, 'the default 35% is not repeated on every member line')
})

test('a snapshot asks for the self scope and marks missing fields', () => {
  const text = formatMemberStatusSnapshot([], { now: 1_000_000, selfId: 'session-a' })
  assert.match(text, /身份：未设置（自身，会话 session-a）；工作范围：未设置；保持目标：关闭（只对主对话生效）/u)
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
  assert.match(text, /身份：新身份；工作区：dsh-mesh；会话：c1（B 10\.66\.66\.2，进行中，第 2 轮）；工作范围：新范围/u)
})

/** Let one turn-end review and its async reads finish. */
async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** Emit one full main-conversation turn. */
function turn(h, number) {
  h.emit('turn/start', { turn: number })
  h.emit('turn/end', { turn: number })
}

/** Wait until the harness recorded `count` followups, or the deadline passes. */
async function waitFollowups(h, count, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (h.followups.length < count && Date.now() < deadline) await sleep(10)
}

test('a main turn end pushes the dispatch instruction at once', async () => {
  const h = harness({
    tasks: [running],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', keep: true } },
  })
  try {
    turn(h, 1)
    await waitFollowups(h, 1)
    assert.equal(h.followups.length, 1)
    const message = h.followups[0]
    assert.equal(message.role, 'user')
    assert.equal(message.source.kind, MEMBER_CONTEXT_SOURCE)
    assert.equal(message.source.form, 'push')
    const text = message.content[0].text
    assert.match(text, /^\[成员调度\] 本对话已空闲。请立即用 subagent 新建一个子代理做只读审查/u)
    assert.match(text, /\.coder\/members\/all\.md/u)
    assert.match(text, /\.coder\/members\/flow\.md/u)
    assert.match(text, /`.coder\/issues\/open\.md`、`.coder\/plan\/todo\.md`、`.coder\/plan\/goal\.md`/u)
    assert.match(text, /判断是否可以激活部分现有空闲成员对话/u)
    assert.match(text, /只考虑空闲成员会话；进行中\/异常中止的一律跳过，禁止重启、归档或新建同名会话——派活必须带原 conversationId 继续/u)
    assert.match(text, /身份：网关（自身，会话 session-a）；工作范围：成员发现/u)
    assert.match(text, /工作区：dsh-mesh；会话：c1（B 10\.66\.66\.2，进行中，第 2 轮）/u)
    assert.equal(h.context.lastInjection.has('session-a'), true)
    assert.equal(h.context.reviewPending.has('session-a'), true)
  } finally {
    h.context.dispose()
  }
})

test('the dispatch instruction lists the idle and running conversations for the review', () => {
  const text = formatMemberDispatchPush([running, settled], {
    now: 1_000_000,
    selfId: 'session-a',
    selfScope: { identity: 'leader', scope: '.coder', keep: true },
    scopes: { c2: { note: '队列无限，空闲时派活' } },
  })
  assert.match(text, /当前成员会话（本对话跟踪 2 个，其中 1 个进行中；快照 1970-01-01T00:16:40\.000Z）：/u)
  assert.match(text, /工作区：dsh-mesh；会话：c1（B 10\.66\.66\.2，进行中，第 2 轮）/u)
  assert.match(text, /身份：未设置；工作区：unknown；会话：c2（B 10\.66\.66\.2，空闲，第 4 轮）.*备注：队列无限，空闲时派活/u)
  assert.match(text, /由本对话用 call_member 决定是否派活/u)
})

test('the review turn end anchors the ten-minute window', async () => {
  let now = 1_000_000
  const h = harness({
    tasks: [running],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', keep: true } },
    now: () => now,
  })
  try {
    turn(h, 1)
    await waitFollowups(h, 1)
    assert.equal(h.followups.length, 1, 'the first turn end reviews at once')
    // The turn started by the push is the review; its end anchors the window.
    turn(h, 2)
    assert.equal(h.context.reviewPending.has('session-a'), false)
    assert.equal(h.context.lastReviewEnd.get('session-a'), 1_000_000)
    now += 9 * 60_000
    turn(h, 3)
    await sleep(80)
    assert.equal(h.followups.length, 1, 'inside ten minutes nothing is reviewed')
    now += 61_000
    turn(h, 4)
    await waitFollowups(h, 2)
    assert.equal(h.followups.length, 2, 'over ten minutes the next turn end reviews again')
    assert.equal(h.context.reviewPending.has('session-a'), true)
  } finally {
    h.context.dispose()
  }
})

test('the review waits for the agent to settle after turn/end before pushing', async () => {
  const h = harness({
    tasks: [running],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', keep: true } },
  })
  try {
    // The real runtime still reports `running` while `session/event` publishes
    // turn/end; the review must let that turn settle instead of skipping.
    h.agent.status = 'running'
    setImmediate(() => { h.agent.status = 'idle' })
    turn(h, 1)
    await waitFollowups(h, 1)
    assert.equal(h.followups.length, 1)
  } finally {
    h.context.dispose()
  }
})

test('an unchanged state is reviewed again after the window and compacts again', async () => {
  let now = 1_000_000
  let compactions = 0
  const h = harness({
    tasks: [running],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', keep: true, compressPercent: 35 } },
    now: () => now,
    services: {
      sessionProjections: projectionsAt(60_000),
      compaction: { async compactNow() { compactions += 1 } },
    },
  })
  try {
    turn(h, 1)
    await waitFollowups(h, 1)
    assert.equal(h.followups.length, 1)
    assert.equal(compactions, 1)
    turn(h, 2)
    now += MEMBER_REVIEW_INTERVAL_MS + 1
    turn(h, 3)
    await waitFollowups(h, 2)
    assert.equal(h.followups.length, 2, 'a periodic review is not deduplicated by state')
    assert.equal(compactions, 2)
  } finally {
    h.context.dispose()
  }
})

test('a long job since the last snapshot adds a delegation hint when avoidLongJobs is on', async () => {
  let clock = 1_000_000
  const h = harness({
    tasks: [],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', avoidLongJobs: true } },
    now: () => clock,
  })
  try {
    h.emit('job/settled', {
      jobId: 'bash-long',
      kind: 'bash',
      label: 'npm test',
      startedAt: clock - 100_000,
      finishedAt: clock,
      status: 'completed',
    })
    const decision = await h.preStep(h.payload, h.next)
    assert.equal(decision.messages.length, 1)
    const text = decision.messages[0].content[0].text
    assert.match(text, /避免耗时：开启（只对主对话生效）/u)
    assert.match(text, /耗时提醒.*1 个 job 耗时超过 1 分钟/u)
    assert.match(text, /bash：npm test（耗时 1 分 40 秒）/u)
    assert.match(text, /推荐把这类耗时工作交给成员对话执行.*call_member/u)

    // The window is consumed: a later snapshot has neither the job nor a hint.
    clock += 61_000
    const nextDecision = await h.preStep(h.payload, h.next)
    assert.equal(nextDecision.messages.length, 0)
  } finally {
    h.context.dispose()
  }
})

test('long jobs do not add a hint when avoidLongJobs is off', async () => {
  const h = harness({
    tasks: [],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', avoidLongJobs: false } },
  })
  try {
    h.emit('job/settled', {
      jobId: 'bash-long',
      kind: 'bash',
      label: 'npm test',
      startedAt: 900_000,
      finishedAt: 1_000_000,
    })
    const decision = await h.preStep(h.payload, h.next)
    assert.equal(decision.messages.length, 0, 'no running member conversation and no hint means no injection')
  } finally {
    h.context.dispose()
  }
})

test('a job of exactly one minute is not called long', async () => {
  const h = harness({
    tasks: [],
    scopes: { 'session-a': { avoidLongJobs: true } },
  })
  try {
    h.emit('job/settled', {
      jobId: 'bash-edge',
      kind: 'bash',
      label: 'edge',
      startedAt: 940_000,
      finishedAt: 1_000_000,
    })
    const decision = await h.preStep(h.payload, h.next)
    assert.equal(decision.messages.length, 0)
  } finally {
    h.context.dispose()
  }
})

test('a long job with a running member conversation still injects the normal snapshot', async () => {
  const h = harness({
    tasks: [running],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', avoidLongJobs: true } },
  })
  try {
    h.emit('job/settled', {
      jobId: 'bash-long',
      kind: 'bash',
      label: 'audit',
      startedAt: 900_000,
      finishedAt: 1_000_000,
    })
    const decision = await h.preStep(h.payload, h.next)
    assert.equal(decision.messages.length, 1)
    const text = decision.messages[0].content[0].text
    assert.match(text, /c1（B 10\.66\.66\.2/u)
    assert.match(text, /bash：audit（耗时 1 分 40 秒）/u)
  } finally {
    h.context.dispose()
  }
})

test('a scope without keep does not push (keep defaults off)', async () => {
  const h = harness({
    tasks: [running],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现' } },
  })
  try {
    turn(h, 1)
    await sleep(80)
    assert.equal(h.followups.length, 0)
  } finally {
    h.context.dispose()
  }
})

test('keep=false suppresses the push', async () => {
  const h = harness({
    tasks: [running],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', keep: false } },
  })
  try {
    turn(h, 1)
    await sleep(80)
    assert.equal(h.followups.length, 0)
  } finally {
    h.context.dispose()
  }
})

test('a member conversation never receives the push', async () => {
  const h = harness({
    tasks: [running],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', keep: true } },
  })
  markMemberSession('session-a')
  try {
    turn(h, 1)
    await sleep(80)
    assert.equal(h.followups.length, 0)
  } finally {
    unmarkMemberSession('session-a')
    h.context.dispose()
  }
})

test('a turn that starts before the review push abandons it', async () => {
  const h = harness({
    tasks: [running],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', keep: true } },
  })
  try {
    h.emit('turn/end', { turn: 1 })
    h.emit('turn/start', { turn: 2 })
    await sleep(100)
    assert.equal(h.followups.length, 0)
    assert.equal(h.context.reviewPending.has('session-a'), false)
  } finally {
    h.context.dispose()
  }
})

test('a conversation with neither tasks nor a self scope does not review', async () => {
  const h = harness({ tasks: [], scopes: {} })
  try {
    turn(h, 1)
    await sleep(80)
    assert.equal(h.followups.length, 0)
  } finally {
    h.context.dispose()
  }
})

/** Context projection service reporting one fixed occupancy. */
function projectionsAt(usedTokens, contextWindow = 100_000) {
  return {
    snapshot() {
      return { values: { contextPressure: { projectedTokens: usedTokens, contextWindow } } }
    },
  }
}

test('a review push compacts the main conversation when it is over the threshold', async () => {
  let compactions = 0
  const h = harness({
    tasks: [running],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', keep: true, compressPercent: 35 } },
    services: {
      sessionProjections: projectionsAt(50_000),
      compaction: { async compactNow() { compactions += 1 } },
    },
  })
  try {
    turn(h, 1)
    await waitFollowups(h, 1)
    assert.equal(compactions, 1, 'over 35% must compact before the followup')
    assert.equal(h.followups.length, 1)
    assert.equal(h.logs.some(line => /compressed 50% -> 50%（阈值 35%）/u.test(line)), true)
  } finally {
    h.context.dispose()
  }
})

test('a review push below the threshold does not compact', async () => {
  let compactions = 0
  const h = harness({
    tasks: [running],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', keep: true, compressPercent: 35 } },
    services: {
      sessionProjections: projectionsAt(20_000),
      compaction: { async compactNow() { compactions += 1 } },
    },
  })
  try {
    turn(h, 1)
    await waitFollowups(h, 1)
    assert.equal(compactions, 0)
    assert.equal(h.followups.length, 1)
    assert.equal(h.logs.some(line => /no compression（上下文 20% <= 阈值 35%）/u.test(line)), true)
  } finally {
    h.context.dispose()
  }
})

test('a failed pre-push compaction is logged but does not block the push', async () => {
  const h = harness({
    tasks: [running],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', keep: true, compressPercent: 35 } },
    services: {
      sessionProjections: projectionsAt(60_000),
      compaction: { async compactNow() { throw new Error('summarizer exploded') } },
    },
  })
  try {
    turn(h, 1)
    await waitFollowups(h, 1)
    assert.equal(h.followups.length, 1)
    assert.equal(h.logs.some(line => /compression skipped: summarizer exploded/u.test(line)), true)
  } finally {
    h.context.dispose()
  }
})

test('a compaction with no compactable range logs that instead of a fake before/after', async () => {
  const h = harness({
    tasks: [running],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', keep: true, compressPercent: 35 } },
    services: {
      sessionProjections: projectionsAt(50_000),
      compaction: { async compactNow() { return null } },
    },
  })
  try {
    turn(h, 1)
    await waitFollowups(h, 1)
    assert.equal(h.followups.length, 1)
    assert.equal(h.logs.some(line => /no compactable range（上下文 50%，阈值 35%）/u.test(line)), true)
    assert.equal(h.logs.some(line => /compressed 50% -> 50%/u.test(line)), false)
  } finally {
    h.context.dispose()
  }
})

test('a new turn that starts during the pre-push compaction abandons the push', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const h = harness({
    tasks: [running],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', keep: true, compressPercent: 35 } },
    services: {
      sessionProjections: projectionsAt(60_000),
      compaction: { async compactNow() { await gate } },
    },
  })
  try {
    turn(h, 1)
    await sleep(30)
    h.emit('turn/start', { turn: 2 })
    release()
    await sleep(100)
    assert.equal(h.followups.length, 0)
    assert.equal(h.logs.some(line => /abandoned: conversation resumed while compacting/u.test(line)), true)
  } finally {
    h.context.dispose()
  }
})

test('a slow pre-push compaction stamps the injection clock at push time', async () => {
  let now = 1_000_000
  let compactions = 0
  const h = harness({
    tasks: [running],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', keep: true, compressPercent: 35 } },
    now: () => now,
    services: {
      sessionProjections: projectionsAt(60_000),
      compaction: { async compactNow() { compactions += 1; now += 61_000 } },
    },
  })
  try {
    turn(h, 1)
    await waitFollowups(h, 1)
    assert.equal(compactions, 1)
    assert.equal(h.followups.length, 1)
    const pushedAt = now
    assert.equal(h.context.lastInjection.get('session-a'), pushedAt, 'the clock must be the post-compaction push time')

    // A pre-step right after the slow push must not re-inject the same snapshot.
    const decision = await h.preStep(h.payload, h.next)
    assert.deepEqual(decision.messages, [])

    // The review turn end starts the window; the next turn is inside it and
    // neither compacts nor pushes again.
    turn(h, 2)
    assert.equal(h.context.lastReviewEnd.get('session-a'), pushedAt)
    turn(h, 3)
    await sleep(80)
    assert.equal(h.followups.length, 1)
    assert.equal(compactions, 1)
  } finally {
    h.context.dispose()
  }
})

test('a roster member without a conversation is reported by the snapshot', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mesh-roster-context-'))
  try {
    await mkdir(path.join(dir, '.coder', 'members'), { recursive: true })
    await writeFile(path.join(dir, '.coder', 'members', 'all.md'), [
      '# 主对话',
      '身份：leader',
      '工作范围：.coder',
      '',
      '# 成员1',
      '工作区名称：mesh-kernel1',
      '身份：内核开发1',
      '工作范围：kernel/**',
      '',
      '# 成员2',
      '工作区名称：mesh-web1',
      '身份：前端开发1',
      '工作范围：web/**',
      '',
    ].join('\n'), 'utf8')
    const h = harness({
      // No member conversation at all: the roster alone must make the step carry
      // a gap, otherwise a forgotten dispatch stays invisible.
      tasks: [],
      cwd: dir,
      services: { agents: undefined },
    })
    try {
      const decision = await h.preStep(h.payload, h.next)
      assert.equal(decision.messages.length, 1)
      const text = decision.messages[0].content[0].text
      assert.match(text, /\[成员缺口\] \.coder\/members\/all\.md 记录了 2 个成员，其中 2 个还没有成员对话/u)
      assert.match(text, /成员1（工作区 mesh-kernel1，身份 内核开发1）还没有成员对话/u)
      assert.match(text, /call_member \{ "workspace": "mesh-kernel1", "identity": "内核开发1" \}/u)
    } finally {
      h.context.dispose()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a member conversation that covers the roster workspace clears the gap', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mesh-roster-context-'))
  try {
    await mkdir(path.join(dir, '.coder', 'members'), { recursive: true })
    await writeFile(path.join(dir, '.coder', 'members', 'all.md'), [
      '# 主对话',
      '身份：leader',
      '',
      '# 成员1',
      '工作区名称：mesh-kernel1',
      '身份：内核开发1',
      '',
    ].join('\n'), 'utf8')
    const task = { ...running, conversationId: 'c1', workspace: 'mesh-kernel1' }
    const h = harness({ tasks: [task], cwd: dir, memberTasks: taskService([{ ...task, status: 'completed' }]) })
    try {
      const decision = await h.preStep(h.payload, h.next)
      assert.equal(decision.messages.length, 0, 'no running conversation and no gap means no injection')
    } finally {
      h.context.dispose()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the dispatch push carries the roster gap even with no tracked conversations', () => {
  const text = formatMemberDispatchPush([], {
    now: 1_000_000,
    selfId: 'session-a',
    selfScope: { identity: 'leader', keep: true },
    gaps: ['[成员缺口] .coder/members/all.md 记录了 1 个成员，其中 1 个还没有成员对话（每个成员都必须有一个）：', '- 成员1（工作区 mesh-kernel1）还没有成员对话'],
  })
  assert.match(text, /名册里列出但还没有成员对话的成员必须建出来/u)
  assert.match(text, /\[成员缺口\] \.coder\/members\/all\.md 记录了 1 个成员/u)
})
