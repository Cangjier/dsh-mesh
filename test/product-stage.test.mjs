import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  MEMBER_ROLES,
  applyProductStage,
  countCallMemberReplies,
  defaultCallMemberBudget,
  formatCallMemberBudget,
  formatProductStageBlocked,
  formatProductStageDefinitions,
  formatProductStageLines,
  formatProductStageResult,
  isAdvancingProductStage,
  productStageParticipationBlockers,
  nextProductVersion,
  normalizeProductStageInput,
  normalizeStoredProductStage,
  productStageParticipants,
  productStageWarnings,
  roleOfScope,
  stageRequiredRoles,
} from '../src/lib/product-stage.mjs'
import { MeshService } from '../src/lib/service.mjs'
import { registerTools } from '../src/lib/tools.mjs'
import { markMemberSession, unmarkMemberSession } from '../src/lib/member-sessions.mjs'

/** A fixed local day for the version rules. */
const DAY = new Date(2026, 10, 26, 10, 0, 0)
const NEXT_DAY = new Date(2026, 10, 27, 9, 0, 0)

test('the product version bumps minor and always grows the revision', () => {
  assert.equal(nextProductVersion(null, DAY), '20261126.1.1')
  assert.equal(nextProductVersion('', DAY), '20261126.1.1')
  // A two-part version written by an older build counts as revision 1.
  assert.equal(nextProductVersion('20261126.1', DAY), '20261126.2.2')
  assert.equal(nextProductVersion('20261126.9', DAY), '20261126.10.2')
  assert.equal(nextProductVersion('20261126.1.4', DAY), '20261126.2.5')
  assert.equal(nextProductVersion('20261125.7', DAY), '20261126.1.2')
  assert.equal(nextProductVersion('20261125.7.9', DAY), '20261126.1.10')
  assert.equal(nextProductVersion('20261127.3', DAY), '20261126.1.2', 'a future date resets to today')
  assert.equal(nextProductVersion('not-a-version', DAY), '20261126.1.1')
  assert.equal(nextProductVersion('20261126.2', NEXT_DAY), '20261127.1.2')
})

test('a first call creates one version, round and goal set', () => {
  const state = applyProductStage(null, {
    stage: 'A',
    goals: { product: { text: '应用功能 现状 只有基础列表，预期 可用的成员面板。' } },
  }, DAY)
  assert.equal(state.version, '20261126.1.1')
  assert.equal(state.stage, 'A')
  assert.equal(state.round, 1)
  assert.deepEqual(state.goals, { product: { text: '应用功能 现状 只有基础列表，预期 可用的成员面板。', status: '未开始' } })
  assert.deepEqual(state.participation, {})
  assert.equal(state.roundStartedAt, DAY.toISOString())
  assert.equal(state.updatedAt, DAY.toISOString())
})

test('only a released D returning to A moves the version and the round', () => {
  const a = applyProductStage(null, { stage: 'A' }, DAY)
  const b = applyProductStage(a, { stage: 'B' }, DAY)
  assert.equal(b.version, '20261126.1.1')
  assert.equal(b.round, 1)
  const c = applyProductStage(b, { stage: 'C' }, DAY)
  assert.equal(c.version, '20261126.1.1')
  const d = applyProductStage(c, { stage: 'D' }, DAY)
  assert.equal(d.version, '20261126.1.1')
  const again = applyProductStage(d, { stage: 'A' }, DAY)
  assert.equal(again.version, '20261126.2.2')
  assert.equal(again.round, 2)
  const tomorrow = applyProductStage({ ...d, participation: { c1: { turn: 3, at: '' } } }, { stage: 'A' }, NEXT_DAY)
  assert.equal(tomorrow.version, '20261127.1.2')
  assert.equal(tomorrow.round, 2)
  assert.deepEqual(tomorrow.participation, {}, 'a new iteration has no participants yet')
})

test('a same-stage goal update keeps the version, round and participation', () => {
  const a = applyProductStage(null, { stage: 'A' }, DAY)
  a.participation = { c1: { turn: 1, at: DAY.toISOString() } }
  const updated = applyProductStage(a, { goals: { dev: { text: '无 BUG', status: '进行中' } } }, DAY)
  assert.equal(updated.stage, 'A')
  assert.equal(updated.version, '20261126.1.1')
  assert.equal(updated.round, 1)
  assert.deepEqual(updated.participation, a.participation)
  assert.equal(updated.roundStartedAt, a.roundStartedAt, 'a goal update does not restart the round')
  assert.deepEqual(updated.goals.dev, { text: '无 BUG', status: '进行中' })
})

test('an explicit sub-stage round starts a new round and clears participation', () => {
  const b = { ...applyProductStage(null, { stage: 'B' }, DAY), participation: { c1: { turn: 2, at: '' } } }
  const next = applyProductStage(b, { round: 2 }, DAY)
  assert.equal(next.stage, 'B')
  assert.equal(next.round, 2)
  assert.equal(next.version, b.version)
  assert.deepEqual(next.participation, {})
})

test('the stage input is validated before anything is saved', () => {
  assert.deepEqual(normalizeProductStageInput({ stage: ' b ' }), { stage: 'B' })
  assert.deepEqual(normalizeProductStageInput({ round: 3 }), { round: 3 })
  assert.throws(() => normalizeProductStageInput({ stage: 'E' }), /stage must be one of A, B, C, D/u)
  assert.throws(() => normalizeProductStageInput({ stage: 1 }), /stage must be a string/u)
  assert.throws(() => normalizeProductStageInput({ round: 0 }), /round must be an integer/u)
  assert.throws(() => normalizeProductStageInput({ round: 1.5 }), /round must be an integer/u)
  assert.throws(() => normalizeProductStageInput({ goals: { business: { text: 'x' } } }), /unknown goal: business/u)
  assert.throws(() => normalizeProductStageInput({ goals: { dev: { status: '完成' } } }), /goal status must be one of/u)
  assert.throws(() => normalizeProductStageInput({ goals: { dev: { text: 'x', extra: true } } }), /unknown dev goal field/u)
  assert.throws(() => normalizeProductStageInput({ goals: { dev: { text: 'x'.repeat(301) } } }), /goal text is too long/u)
  assert.throws(() => normalizeProductStageInput({}), /stage, round, or goals is required/u)
})

test('goal text follows the category / 现状 / 预期 shape', () => {
  const normalized = normalizeProductStageInput({ goals: {
    product: '应用功能：现状 只能做基础建模；预期 支持参数化特征',
    dev: { text: '内核 现状 依赖旧几何核，预期 换用 OCC' },
  } })
  assert.equal(normalized.goals.product.text, '应用功能 现状 只能做基础建模，预期 支持参数化特征。')
  assert.equal(normalized.goals.dev.text, '内核 现状 依赖旧几何核，预期 换用 OCC。')
  assert.throws(
    () => normalizeProductStageInput({ goals: { product: { text: '可用的成员面板' } } }),
    /现状.*预期/u,
  )
  assert.throws(
    () => normalizeProductStageInput({ goals: { product: { text: '应用功能 现状 只有列表' } } }),
    /预期/u,
  )
  assert.throws(
    () => normalizeProductStageInput({ goals: { product: { text: '现状 只有列表，预期 有' } } }),
    /现状/u,
  )
})

test('an explicit goal category composes the fixed text', () => {
  const normalized = normalizeProductStageInput({ goals: {
    product: { category: '应用功能', text: '现状 只能做基础建模，预期 支持参数化特征。' },
    dev: { category: '性能', text: '性能：现状 2 秒，预期 1 秒。' },
  } })
  assert.equal(normalized.goals.product.text, '应用功能 现状 只能做基础建模，预期 支持参数化特征。')
  assert.equal(normalized.goals.dev.text, '性能 现状 2 秒，预期 1 秒。')
  assert.throws(
    () => normalizeProductStageInput({ goals: { product: { category: '应用功能' } } }),
    /category must be sent together with text/u,
  )
  assert.throws(
    () => normalizeProductStageInput({ goals: { product: { category: '应用功能', text: '算法 现状 x，预期 y' } } }),
    /must start with 现状/u,
  )
})

test('goal text and status can be cleared independently', () => {
  const a = applyProductStage(null, {
    stage: 'A',
    goals: { product: { text: '应用功能 现状 未定义，预期 目标。', status: '已达成' } },
  }, DAY)
  const cleared = applyProductStage(a, normalizeProductStageInput({ goals: { product: { status: '' } } }), DAY)
  assert.deepEqual(cleared.goals.product, { text: '应用功能 现状 未定义，预期 目标。', status: '未开始' }, 'a text goal defaults to 未开始')
  const removed = applyProductStage(cleared, normalizeProductStageInput({ goals: { product: { text: '' } } }), DAY)
  assert.deepEqual(removed.goals, {})
})

test('a corrupt stored state is ignored instead of breaking the reader', () => {
  const good = {
    version: '20261126.2.1',
    stage: 'B',
    round: 3,
    goals: { dev: { text: '无 BUG', status: '进行中' } },
    participation: { c1: { turn: 2, at: '2026-11-26T02:00:00.000Z' }, bad: 'x' },
    updatedAt: '2026-11-26T02:00:00.000Z',
    updatedBy: 'session-a',
  }
  assert.deepEqual(normalizeStoredProductStage(good), {
    version: '20261126.2.1',
    stage: 'B',
    round: 3,
    goals: { dev: { text: '无 BUG', status: '进行中' } },
    participation: { c1: { turn: 2, at: '2026-11-26T02:00:00.000Z' } },
    updatedAt: '2026-11-26T02:00:00.000Z',
    updatedBy: 'session-a',
  })
  assert.equal(
    normalizeStoredProductStage({ ...good, version: '20261126.2' }).version,
    '20261126.2.1',
    'a pre-revision two-part version is upgraded instead of dropped',
  )
  assert.equal(normalizeStoredProductStage({ ...good, stage: 'E' }), null)
  assert.equal(normalizeStoredProductStage({ ...good, version: 'x' }), null)
  assert.equal(normalizeStoredProductStage({ ...good, round: 0 }), null)
  assert.equal(normalizeStoredProductStage(null), null)
})

test('the standard role is read from a scope only when it is one of the five', () => {
  assert.equal(roleOfScope({ role: '开发' }), '开发')
  assert.equal(roleOfScope({ role: ' 测试 ' }), '测试')
  assert.equal(roleOfScope({ role: '老板' }), null)
  assert.equal(roleOfScope({ identity: '开发' }), null, 'free-text identity is not a standard role')
  assert.equal(roleOfScope(null), null)
  assert.deepEqual(MEMBER_ROLES, ['产品经理', '研究员', '开发', '测试', '业务'])
  assert.deepEqual(stageRequiredRoles('B'), ['开发', '测试', '研究员', '产品经理', '业务'])
  assert.deepEqual(stageRequiredRoles('C'), ['产品经理'])
  assert.deepEqual(stageRequiredRoles('D'), ['业务'])
})

test('participation is counted for every member in A and for the stage roles later', () => {
  const tasks = [
    { conversationId: 'c1', statusLabel: '空闲', profile: { name: 'B', identity: '内核', role: '开发' } },
    { conversationId: 'c2', statusLabel: '进行中' },
    { conversationId: 'c3', statusLabel: '空闲' },
  ]
  const scopes = { c3: { role: '测试' } }
  const b = {
    version: '20261126.1.1',
    stage: 'B',
    round: 1,
    goals: {},
    participation: { c1: { turn: 2, at: '' } },
  }
  const view = productStageParticipants(b, tasks, scopes)
  assert.deepEqual(view.required.map(entry => entry.conversationId), ['c1', 'c3'])
  assert.deepEqual(view.missing.map(entry => entry.conversationId), ['c3'])
  assert.deepEqual(view.missingRoles, ['研究员', '产品经理', '业务'])
  assert.deepEqual(view.roleLess.map(entry => entry.conversationId), ['c2'])

  const a = productStageParticipants({ ...b, stage: 'A' }, tasks, scopes)
  assert.deepEqual(a.required.map(entry => entry.conversationId), ['c1', 'c2', 'c3'])
  assert.deepEqual(a.missing.map(entry => entry.conversationId), ['c2', 'c3'])
})

test('a reply after the round started counts as participation without a recorded map', () => {
  const state = {
    version: '20261126.1.1',
    stage: 'A',
    round: 1,
    goals: {},
    updatedAt: '2026-11-26T15:12:00.000Z',
    participation: {},
  }
  const after = [{ conversationId: 'c1', statusLabel: '空闲', replies: [{ at: '2026-11-26T17:25:00.000Z' }] }]
  const before = [{ conversationId: 'c1', statusLabel: '空闲', replies: [{ at: '2026-11-26T15:09:00.000Z' }] }]
  assert.equal(productStageParticipants(state, after, {}).required[0].participated, true)
  assert.equal(productStageParticipants(state, before, {}).required[0].participated, false)
  const explicit = { ...state, roundStartedAt: '2026-11-26T18:00:00.000Z' }
  assert.equal(productStageParticipants(explicit, after, {}).required[0].participated, false, 'roundStartedAt wins')
})

test('the stage block leads with the version, goals, participation and possible next moves', () => {
  const tasks = [
    { conversationId: 'c1', statusLabel: '空闲', profile: { name: 'B', role: '开发' } },
  ]
  const state = {
    version: '20261126.2.1',
    stage: 'B',
    round: 2,
    goals: { product: { text: '可用的成员面板', status: '进行中' }, research: { text: '并发模型', status: '已达成' } },
    participation: {},
  }
  const text = formatProductStageLines(state, tasks, {}).join('\n')
  assert.match(text, /\[产品阶段\] 20261126\.2\.1 · B 阶段（第 2 轮迭代）· 开发与测试/u)
  assert.match(text, /- 阶段要求：开发、测试、研究员、产品经理、业务参与/u)
  assert.match(text, /- 产品目标：可用的成员面板（进行中）/u)
  assert.match(text, /- 开发目标：未设置/u)
  assert.match(text, /- 研究目标：并发模型（已达成）/u)
  assert.match(text, /- 本轮参与：0\/1/u)
  assert.match(text, /- 未参与：开发 c1/u)
  assert.match(text, /- 没有成员会话的标准身份：测试、研究员/u)
  assert.match(text, /后续可能走向：/u)
  assert.ok(text.includes('1. 如果本轮功能已经没有 BUG（疑难杂症除外），可以交给产品经理使用，则 set_product_stage({ "stage": "C" })'))
  assert.ok(text.includes('3. 如果本轮还需要继续修复或验证，则 set_product_stage({ "round": 3 })'))
  assert.ok(text.includes('4. 如果只需要更新开发目标状态，则 set_product_stage({ "goals": { "dev": { "status": "已达成" } } })'))
})

test('the tool result reports a creation and the previous stage warnings', () => {
  const state = {
    version: '20261126.2.1',
    stage: 'B',
    round: 2,
    goals: { product: { text: '目标', status: '进行中' } },
    participation: {},
  }
  const text = formatProductStageResult(state, {
    created: true,
    tasks: [{ conversationId: 'c1', statusLabel: '空闲', profile: { name: 'B', role: '开发' } }],
    scopes: {},
    warnings: ['离开 A 阶段时还有成员没有参与本轮：开发 c1'],
  })
  assert.match(text, /^产品阶段已建立：20261126\.2\.1 · B 阶段（第 2 轮迭代）/u)
  assert.match(text, /\[放行检查\]/u)
  assert.match(text, /- 离开 A 阶段时还有成员没有参与本轮：开发 c1/u)
})

test('leaving a stage warns about missing participants and unmet goals', () => {
  const tasks = [{ conversationId: 'c1', statusLabel: '空闲', profile: { name: 'B', role: '开发' } }]
  const a = {
    version: '20261126.1.1', stage: 'A', round: 1, goals: {}, participation: {},
  }
  const warnings = productStageWarnings(a, tasks, {})
  assert.deepEqual(warnings, [
    '离开 A 阶段时还有成员没有参与本轮：开发 c1',
    '离开 A 阶段时产品目标还没有设置',
  ])

  const b = {
    version: '20261126.1.1', stage: 'B', round: 1,
    goals: { dev: { text: '无 BUG', status: '进行中' } },
    participation: { c1: { turn: 1, at: '' } },
  }
  assert.deepEqual(productStageWarnings(b, tasks, {}), [
    '离开 B 阶段时没有这些身份的成员会话：测试、研究员、产品经理、业务',
    '离开 B 阶段时开发目标状态不是「已达成」',
  ])

  const c = {
    version: '20261126.1.1', stage: 'C', round: 1,
    goals: { product: { text: '目标', status: '进行中' } },
    participation: { c1: { turn: 1, at: '' } },
  }
  assert.deepEqual(productStageWarnings(c, tasks, {}), [
    '离开 C 阶段时没有这些身份的成员会话：产品经理',
    '离开 C 阶段时产品目标状态不是「已达成」',
  ])
  assert.deepEqual(productStageWarnings(null, tasks, {}), [])
})

test('an advancing change is blocked until the current round participants answer', () => {
  const tasks = [
    { conversationId: 'c1', statusLabel: '空闲', profile: { name: 'B', role: '开发' } },
    { conversationId: 'c2', statusLabel: '进行中' },
  ]
  const scopes = { c2: { role: '测试' } }
  const a = { version: '20261126.1.1', stage: 'A', round: 1, goals: {}, participation: {} }
  assert.deepEqual(productStageParticipationBlockers(a, tasks, scopes), [
    '开发 c1 还没有参与本轮（空闲）',
    '测试 c2 还没有参与本轮（进行中）',
  ])

  const b = { version: '20261126.1.1', stage: 'B', round: 1, goals: {}, participation: { c1: { turn: 1, at: '' } } }
  assert.deepEqual(productStageParticipationBlockers(b, tasks, scopes), [
    '测试 c2 还没有参与本轮（进行中）',
    '没有研究员身份的成员会话',
    '没有产品经理身份的成员会话',
    '没有业务身份的成员会话',
  ])

  const complete = {
    version: '20261126.1.1',
    stage: 'B',
    round: 1,
    goals: {},
    participation: { c1: { turn: 1, at: '' }, c2: { turn: 2, at: '' }, c3: { turn: 1, at: '' }, c4: { turn: 1, at: '' }, c5: { turn: 1, at: '' } },
  }
  const completeTasks = [
    ...tasks,
    { conversationId: 'c3', statusLabel: '空闲', profile: { name: 'B', role: '研究员' } },
    { conversationId: 'c4', statusLabel: '空闲', profile: { name: 'PM', role: '产品经理' } },
    { conversationId: 'c5', statusLabel: '空闲', profile: { name: 'CAD', role: '业务' } },
  ]
  assert.deepEqual(productStageParticipationBlockers(complete, completeTasks, scopes), [])

  const text = formatProductStageBlocked(a, { ...a, round: 2 }, ['开发 c1 还没有参与本轮（空闲）'])
  assert.match(text, /无法进入 A 阶段（第 2 轮迭代）：本轮参与人员不满足要求，阶段状态没有改变/u)
  assert.match(text, /- 当前：20261126\.1\.1 · A 阶段（第 1 轮迭代）/u)
  assert.match(text, /开发 c1 还没有参与本轮（空闲）/u)
  assert.match(text, /call_member 派任务、wait_member 取回复/u)
})

test('only advancing changes count as a new round', () => {
  const a = { stage: 'A', round: 1 }
  const b = { stage: 'B', round: 1 }
  assert.equal(isAdvancingProductStage(null, a), false, 'the first call is not an advance')
  assert.equal(isAdvancingProductStage(a, b), true)
  assert.equal(isAdvancingProductStage(b, a), false, 'backward rework is not gated')
  assert.equal(isAdvancingProductStage(b, { stage: 'B', round: 2 }), true, 'another round advances')
  assert.equal(isAdvancingProductStage(b, { ...b }), false, 'a goal-only update is not an advance')
  assert.equal(isAdvancingProductStage({ stage: 'D', round: 1 }, { stage: 'A', round: 2 }), true)
  assert.equal(isAdvancingProductStage({ stage: 'C', round: 1 }, { stage: 'A', round: 1 }), false)
})

test('the service persists one stage per project and resets participation on a transition', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-stage-service-'))
  const dataDir = path.join(dir, 'mesh')
  try {
    const service = new MeshService({ dataDir, config: {}, log: () => {} })
    assert.equal(await service.productStage('/root/ws/project'), null)

    const first = await service.setProductStage({
      cwd: '/root/ws/project',
      stage: 'A',
      goals: { product: { text: '应用功能 现状 未定义，预期 目标。' } },
      bySessionId: 'session-a',
      now: DAY,
    })
    assert.equal(first.previous, null)
    assert.equal(first.state.updatedBy, 'session-a')
    assert.equal(first.state.version, '20261126.1.1')
    assert.deepEqual(await service.productStage('/root/ws/project'), first.state)

    assert.equal(await service.noteMemberParticipation({
      cwd: '/root/ws/project',
      conversationId: 'c1',
      turn: 2,
      at: '2026-11-26T02:00:00.000Z',
    }), true)
    const withReply = await service.productStage('/root/ws/project')
    assert.deepEqual(withReply.participation, { c1: { turn: 2, at: '2026-11-26T02:00:00.000Z' } })

    const moved = await service.setProductStage({ cwd: '/root/ws/project', stage: 'B', now: DAY })
    assert.equal(moved.state.version, '20261126.1.1')
    assert.deepEqual(moved.state.participation, {})

    assert.equal(await service.noteMemberParticipation({ cwd: '/root/ws/unknown', conversationId: 'c1', turn: 1 }), false)
    assert.equal(await service.noteMemberParticipation({ cwd: '/root/ws/project', conversationId: '', turn: 1 }), false)
    await assert.rejects(service.setProductStage({ cwd: '', stage: 'A' }), /project directory/u)
    await assert.rejects(service.setProductStage({ cwd: '/root/ws/project', stage: 'E' }), /stage must be one of/u)

    const saved = JSON.parse(await readFile(path.join(dataDir, 'product-stages.json'), 'utf8'))
    assert.equal(saved[path.resolve('/root/ws/project')].stage, 'B')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a corrupt product stage file reads as no stage', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-stage-corrupt-'))
  const dataDir = path.join(dir, 'mesh')
  try {
    const service = new MeshService({ dataDir, config: {}, log: () => {} })
    await mkdir(dataDir, { recursive: true })
    await writeFile(path.join(dataDir, 'product-stages.json'), JSON.stringify({
      '/root/ws/good': { version: '20261126.3.1', stage: 'C', round: 2, goals: {} },
      '/root/ws/bad': { version: 'x', stage: 'A', round: 1 },
    }), 'utf8')
    const stages = await service.productStages()
    assert.deepEqual(Object.keys(stages), ['/root/ws/good'])
    assert.equal(stages['/root/ws/good'].version, '20261126.3.1')

    await writeFile(path.join(dataDir, 'product-stages.json'), '{not json', 'utf8')
    assert.deepEqual(await service.productStages(), {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the set_product_stage tool writes the project state and reports possible next moves', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-stage-tool-'))
  const dataDir = path.join(dir, 'mesh')
  let service
  try {
    service = new MeshService({ dataDir, config: {}, log: () => {} })
    const tools = []
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      effect: () => () => {},
      get: () => undefined,
    }
    registerTools(ctx, { tools: { register: tool => { tools.push(tool) } } }, service)
    const set = tools.find(tool => tool.name === 'set_product_stage')
    const agent = { id: 'main-1', session: { id: 'main-1', header: { cwd: '/root/ws/project' } } }

    const created = await set.execute({ stage: 'A', goals: { product: { text: '应用功能 现状 未定义，预期 目标。' } } }, { agent })
    assert.equal(created.ok, true)
    assert.match(created.text, /^产品阶段已建立：\d{8}\.1\.1 · A 阶段（第 1 轮迭代）/u)
    assert.match(created.text, /- 产品目标：应用功能 现状 未定义，预期 目标。（未开始）/u)
    assert.match(created.text, /后续可能走向：/u)
    assert.ok(created.text.includes('1. 如果所有成员已参与建议、本轮计划与目标已经确定，则 set_product_stage({ "stage": "B" })'))
    const stored = await service.productStage('/root/ws/project')
    assert.equal(stored.stage, 'A')
    assert.equal(stored.updatedBy, 'main-1')

    const updated = await set.execute({ goals: { dev: { status: '进行中' } } }, { agent })
    assert.match(updated.text, /^产品阶段已更新/u, 'a goal-only call keeps the stage')
    assert.equal((await service.productStage('/root/ws/project')).stage, 'A')

    // A tracked member conversation makes the next round an advancing change;
    // it is refused until that member answered this round.
    service.memberTasks.tasks.set('task-c1', {
      id: 'task-c1',
      conversationId: 'c1',
      member: 'B',
      memberIp: '10.66.66.2',
      workspace: 'dsh-mesh',
      status: 'completed',
      statusLabel: '空闲',
      originSessionId: 'main-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      profile: { name: 'B', role: '开发' },
    })
    const blocked = await set.execute({ round: 2 }, { agent })
    assert.equal(blocked.ok, false)
    assert.match(blocked.text, /无法进入 A 阶段（第 2 轮迭代）/u)
    assert.match(blocked.text, /开发 c1 还没有参与本轮/u)
    assert.equal(blocked.data.blocked, true)
    assert.deepEqual(blocked.data.blockers, ['开发 c1 还没有参与本轮（空闲）'])
    assert.equal((await service.productStage('/root/ws/project')).round, 1, 'a blocked call writes nothing')

    await service.noteMemberParticipation({ cwd: '/root/ws/project', conversationId: 'c1', turn: 1 })
    const advanced = await set.execute({ round: 2 }, { agent })
    assert.equal(advanced.ok, true)
    assert.match(advanced.text, /^产品阶段已更新：.*A 阶段（第 2 轮迭代）/u)
    assert.equal((await service.productStage('/root/ws/project')).round, 2)
    assert.deepEqual((await service.productStage('/root/ws/project')).participation, {}, 'the new round starts empty')

    await assert.rejects(
      () => set.execute({ stage: 'B' }, { agent: { id: 'main-2', session: { id: 'main-2' } } }),
      /project directory/u,
    )
    await assert.rejects(() => set.execute({ stage: 'E' }, { agent }), /stage must be one of A, B, C, D/u)

    markMemberSession('main-1')
    try {
      await assert.rejects(
        () => set.execute({ stage: 'B' }, { agent }),
        /only available in a main conversation/u,
      )
    } finally {
      unmarkMemberSession('main-1')
    }
  } finally {
    await service?.memberTasks?.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the stage definitions lead with all four big stages', () => {
  const lines = formatProductStageDefinitions()
  assert.equal(lines[0], '[产品阶段定义] 产品按 A → B → C → D → A 循环：')
  const text = lines.join('\n')
  assert.match(text, /- A 计划与目标：所有成员参与并提出建议/u)
  assert.match(text, /- B 开发与测试：开发、测试、研究员、产品经理、业务参与/u)
  assert.match(text, /- C 产品经理使用：产品经理真实使用/u)
  assert.match(text, /- D 业务介入：业务人员开展业务工作/u)
})

test('the call_member budget counts this round only and insists on advancing when spent', () => {
  const state = {
    version: '20261126.1.1',
    stage: 'B',
    round: 1,
    goals: {},
    roundStartedAt: '2026-11-26T18:00:00.000Z',
  }
  const tasks = [
    { conversationId: 'c1', replies: [{ at: '2026-11-26T17:59:00.000Z' }, { at: '2026-11-26T18:01:00.000Z' }, { at: '2026-11-26T18:02:00.000Z' }] },
    { conversationId: 'c2', replies: [{ at: '2026-11-26T18:03:00.000Z' }] },
  ]
  const scopes = { c1: { role: '开发' }, c2: { role: '测试' } }
  assert.equal(countCallMemberReplies(state, tasks), 3, 'the reply before the round start does not count')

  assert.deepEqual(formatCallMemberBudget(state, tasks, { A: 9, B: 5, C: 2, D: 2 }, scopes), [
    '- call_member 预算（B 阶段）：本轮已用 3/5，剩余 2（已设置）',
  ])
  const spent = formatCallMemberBudget(state, tasks, { A: 9, B: 3, C: 2, D: 2 }, scopes).join('\n')
  assert.match(spent, /\[call_member 预算用尽\] B 阶段本轮预算 3 次已用完/u)
  assert.match(spent, /必须进入下一个阶段/u)
  assert.match(spent, /set_product_stage 及时更新阶段和目标状态/u)
  assert.match(spent, /本轮参与未齐时，先 wait_member 取回已派任务的回复。$/mu)
  assert.doesNotMatch(spent, /调大|callMemberBudget|set_member_scope/u, 'the prompt must not invite raising the budget')

  // A stage with no explicit budget runs on twice its participating members.
  assert.deepEqual(formatCallMemberBudget(state, tasks, undefined, scopes), [
    '- call_member 预算（B 阶段）：本轮已用 3/4，剩余 1（默认 = 参与成员数 × 2）',
  ])
  assert.deepEqual(formatCallMemberBudget(state, tasks, { A: 9 }, scopes), [
    '- call_member 预算（B 阶段）：本轮已用 3/4，剩余 1（默认 = 参与成员数 × 2）',
  ], 'a missing stage falls back to its own default, not to another stage')
  assert.equal(defaultCallMemberBudget({ ...state, stage: 'C', round: 1 }, [], {}), 1, 'no participant means one call, not zero')

  const nextRound = { ...state, round: 2, roundStartedAt: '2026-11-26T18:04:00.000Z' }
  assert.equal(countCallMemberReplies(nextRound, tasks), 0, 'a new round resets the budget')
})

test('the member-context stage block hides member conversation statuses', () => {
  const state = {
    version: '20261126.1.1',
    stage: 'A',
    round: 1,
    goals: {},
    participation: {},
  }
  const tasks = [{ conversationId: 'c2', status: 'failed', statusLabel: '异常中止' }]
  const hidden = formatProductStageLines(state, tasks, {}, { statuses: false }).join('\n')
  assert.match(hidden, /- 未参与：c2$/mu)
  assert.doesNotMatch(hidden, /异常中止|需先恢复会话/u)

  const shown = formatProductStageLines(state, tasks, {}).join('\n')
  assert.match(shown, /- 未参与：c2（异常中止，需先恢复会话）/u, 'tool results keep the status')
})

test('budget audits are capped at three per stage and ten minutes apart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-stage-audit-'))
  const dataDir = path.join(dir, 'mesh')
  try {
    const service = new MeshService({ dataDir, config: {}, log: () => {} })
    const cwd = '/root/ws/project'
    const at = DAY.getTime()
    await service.setProductStage({ cwd, stage: 'A', now: DAY })

    const first = await service.claimBudgetAudit({ cwd, now: at })
    assert.deepEqual(first, { count: 1, lastAt: new Date(at).toISOString() })
    assert.equal(await service.claimBudgetAudit({ cwd, now: at + 60_000 }), null, 'ten minutes apart')
    assert.equal((await service.claimBudgetAudit({ cwd, now: at + 10 * 60_000 }))?.count, 2)
    assert.equal((await service.claimBudgetAudit({ cwd, now: at + 20 * 60_000 }))?.count, 3)
    assert.equal(await service.claimBudgetAudit({ cwd, now: at + 30 * 60_000 }), null, 'at most three per stage')

    const goalOnly = await service.setProductStage({
      cwd,
      goals: { product: { text: '应用功能 现状 只有基础列表，预期 可用的成员面板。' } },
      now: new Date(at + 31 * 60_000),
    })
    assert.equal(goalOnly.state.audits?.count, 3, 'a goal-only update keeps the audit count')

    const moved = await service.setProductStage({ cwd, stage: 'B', now: new Date(at + 32 * 60_000) })
    assert.equal(moved.state.audits, undefined, 'a stage change resets the audit count')
    assert.equal((await service.claimBudgetAudit({ cwd, now: at + 40 * 60_000 }))?.count, 1)

    const saved = JSON.parse(await readFile(path.join(dataDir, 'product-stages.json'), 'utf8'))
    const stored = saved[path.resolve(cwd)]
    assert.equal(stored.audits.count, 1)
    assert.equal(await service.releaseBudgetAudit({ cwd, lastAt: stored.audits.lastAt }), true)
    assert.equal((await service.productStage(cwd)).audits, undefined, 'releasing the only claim removes the record')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
