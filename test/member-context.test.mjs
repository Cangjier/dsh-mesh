import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DEFAULT_KEEP_PROMPT,
  MEMBER_STATUS_INTERVAL_MS,
  MEMBER_CONTEXT_SOURCE,
  createMemberContext,
  formatMemberStatusSnapshot,
} from '../src/lib/member-context.mjs'
import { applyProductStage } from '../src/lib/product-stage.mjs'
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
 * @param {{tasks?: object[], sessionId?: string, now?: () => number, memberTasks?: object, services?: Record<string, any>, scopes?: Record<string, object>, cwd?: string}} [options] knobs.
 * @returns {object} harness.
 */
function harness(options = {}) {
  const handlers = new Map()
  const disposers = []
  const logs = []
  const sessionId = options.sessionId ?? 'session-a'
  /** One session object, carrying a project directory when the test sets one. */
  const sessionOf = (id) => ({ id, ...(options.cwd === undefined ? {} : { header: { cwd: options.cwd } }) })
  const followups = []
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
  return { context, handlers, preStep, payload, next, logs, sessionId, agent, emit, session, scopes, followups }
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

test('the status interval is 60 seconds', () => {
  assert.equal(MEMBER_STATUS_INTERVAL_MS, 60_000)
})

test('a snapshot shows the self identity, work scope and effective settings', () => {
  const text = formatMemberStatusSnapshot([], {
    now: 1_000_000,
    selfId: 'session-a',
    selfScope: { identity: '网关', scope: '成员发现', compressPercent: 12.5 },
  })
  assert.match(text, /身份：网关（自身，会话 session-a）；工作范围：成员发现；保持目标：关闭（只对主对话生效）；避免耗时：关闭（只对主对话生效）；压缩阈值：12\.5%/u)
  assert.match(text, /保持目标：关闭/u)
  assert.match(text, /避免耗时：关闭/u)
  assert.doesNotMatch(text, /还没有身份\/工作范围/u)
})

test('a snapshot shows the default 35% threshold', () => {
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
  assert.match(text, /身份：未设置（自身，会话 session-a）；工作范围：未设置；保持目标：关闭（只对主对话生效）；避免耗时：关闭（只对主对话生效）/u)
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

/** Let one turn-end nudge and its async reads finish. */
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

test('an active product stage is injected even when no member conversation is running', async () => {
  const stage = {
    version: '20261126.2',
    stage: 'A',
    round: 1,
    goals: { product: { text: '可用的成员面板', status: '进行中' } },
    participation: { c2: { turn: 4, at: '' } },
  }
  const service = {
    async memberScopes() { return { c2: { role: '测试' } } },
    async productStage() { return stage },
  }
  const h = harness({ tasks: [settled], cwd: '/root/ws/project', service })
  try {
    const decision = await h.preStep(h.payload, h.next)
    assert.equal(decision.messages.length, 1)
    const text = decision.messages[0].content[0].text
    assert.match(text, /\[产品阶段\] 20261126\.2 · A 阶段（第 1 轮迭代）· 计划与目标/u)
    assert.match(text, /- 产品目标：可用的成员面板（进行中）/u)
    assert.match(text, /- 本轮参与：1\/1（测试 c2）/u)
    assert.match(text, /后续可能走向：/u)
    assert.ok(text.includes('1. 如果所有成员已参与建议、本轮计划与目标已经确定，则 set_product_stage({ "stage": "B" })'))
    assert.ok(text.includes('2. 如果计划还需要在同一阶段继续讨论或补充，则 set_product_stage({ "round": 2 })'))
    assert.doesNotMatch(text, /还没有设置产品阶段/u)
  } finally {
    h.context.dispose()
  }
})

test('a stage without responses names the missing member and the missing role', async () => {
  const stage = {
    version: '20261126.1',
    stage: 'B',
    round: 1,
    goals: {},
    participation: {},
  }
  const service = {
    async memberScopes() { return {} },
    async productStage() { return stage },
  }
  const h = harness({
    tasks: [
      { ...running, conversationId: 'c1', status: 'completed' },
      { ...settled, conversationId: 'c2' },
    ],
    cwd: '/root/ws/project',
    service,
  })
  try {
    const decision = await h.preStep(h.payload, h.next)
    const text = decision.messages[0].content[0].text
    assert.match(text, /- 本轮参与：0\/0/u)
    assert.match(text, /- 没有成员会话的标准身份：开发、测试、研究员/u)
    assert.match(text, /- 标准身份未设置：c1（身份未设置）、c2（身份未设置）/u)
  } finally {
    h.context.dispose()
  }
})

test('a tracked conversation without a stage asks for one', async () => {
  const h = harness({ tasks: [running] })
  try {
    const decision = await h.preStep(h.payload, h.next)
    assert.equal(decision.messages.length, 1)
    assert.match(decision.messages[0].content[0].text, /- 还没有设置产品阶段：用 set_product_stage/u)
  } finally {
    h.context.dispose()
  }
})

test('keep nudges 继续 once after a turn ends with no running member conversation', async () => {
  const h = harness({
    tasks: [],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', keep: true } },
  })
  try {
    turn(h, 1)
    await waitFollowups(h, 1)
    assert.equal(h.followups.length, 1)
    const message = h.followups[0]
    assert.equal(message.role, 'user')
    assert.deepEqual(message.content, [{ type: 'text', text: DEFAULT_KEEP_PROMPT }])
    assert.equal(message.source.kind, MEMBER_CONTEXT_SOURCE)
    assert.equal(message.source.form, 'keep')
    assert.equal(h.context.keepPending.has('session-a'), true)

    // The turn the nudge started is the nudge itself: it must not push again.
    turn(h, 2)
    await sleep(80)
    assert.equal(h.followups.length, 1)
    assert.equal(h.context.keepPending.has('session-a'), false)
  } finally {
    h.context.dispose()
  }
})

test('keep uses the configured keepPrompt as the nudge text', async () => {
  const h = harness({
    tasks: [],
    scopes: { 'session-a': { keep: true, keepPrompt: '继续推进成员结果，别停下来' } },
  })
  try {
    turn(h, 1)
    await waitFollowups(h, 1)
    assert.equal(h.followups.length, 1)
    assert.deepEqual(h.followups[0].content, [{ type: 'text', text: '继续推进成员结果，别停下来' }])
  } finally {
    h.context.dispose()
  }
})

test('keep does not nudge while a member conversation is running', async () => {
  const h = harness({
    tasks: [running],
    scopes: { 'session-a': { identity: '网关', scope: '成员发现', keep: true } },
  })
  try {
    turn(h, 1)
    await sleep(100)
    assert.equal(h.followups.length, 0, 'a running member conversation is already the work')
  } finally {
    h.context.dispose()
  }
})

test('keep defaults off and false stays silent', async () => {
  const missing = harness({ tasks: [], scopes: {} })
  try {
    turn(missing, 1)
    await sleep(80)
    assert.equal(missing.followups.length, 0)
  } finally {
    missing.context.dispose()
  }
  const disabled = harness({ tasks: [], scopes: { 'session-a': { keep: false } } })
  try {
    turn(disabled, 1)
    await sleep(80)
    assert.equal(disabled.followups.length, 0)
  } finally {
    disabled.context.dispose()
  }
})

test('a member conversation never receives the keep nudge', async () => {
  const h = harness({ tasks: [], scopes: { 'session-a': { keep: true } } })
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

test('a new turn that starts before the keep check abandons the nudge', async () => {
  const h = harness({ tasks: [], scopes: { 'session-a': { keep: true } } })
  try {
    h.emit('turn/end', { turn: 1 })
    h.emit('turn/start', { turn: 2 })
    await sleep(100)
    assert.equal(h.followups.length, 0)
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
