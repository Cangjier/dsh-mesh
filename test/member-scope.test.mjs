import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MeshService, effectiveCompressPercent } from '../src/lib/service.mjs'
import { MemberTaskService } from '../src/lib/member-tasks.mjs'
import { STOP_ALL_MEMBER_PROMPT, registerTools } from '../src/lib/tools.mjs'

/**
 * A member interop fake that records create and message payloads.
 * @returns {Promise<object>} server handle.
 */
async function fakeMember() {
  const created = []
  const messages = []
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
    if (request.method === 'POST' && request.url === '/v1/conversations') {
      created.push(body)
      reply(201, { ok: true, conversation: { id: 'conv-new', status: 'running', turns: 0, replySeq: 0 } })
      return
    }
    if (request.method === 'GET' && request.url === '/v1/conversations/conv-9?resume=1') {
      reply(200, {
        ok: true,
        conversation: { id: 'conv-9', status: 'idle', turns: 3, replySeq: 3, workspace: 'dsh-mesh' },
      })
      return
    }
    if (request.method === 'POST' && /^\/v1\/conversations\/(conv-new|conv-9)\/messages$/u.test(request.url)) {
      const conversationId = request.url.split('/')[3]
      messages.push({ conversationId, content: body.content })
      reply(202, {
        ok: true,
        receipt: { messageId: 'm1', delivery: 'followup' },
        conversation: { id: conversationId, status: 'running', turns: 3, replySeq: 3 },
      })
      return
    }
    if (request.method === 'POST' && /^\/v1\/conversations\/(conv-new|conv-9)\/wait$/u.test(request.url)) {
      const conversationId = request.url.split('/')[3]
      await new Promise(resolve => setTimeout(resolve, 40))
      reply(200, {
        ok: true,
        timedOut: true,
        state: 'running',
        replies: [],
        conversation: { id: conversationId, status: 'running', turns: 3, replySeq: 3 },
      })
      return
    }
    reply(404, { ok: false, error: { code: 'not_found', message: 'not found' } })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    created,
    messages,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

/**
 * Build a real MeshService pointed at the fake member.
 * @param {number} port interop port.
 * @param {string} dataDir mesh data directory.
 * @returns {MeshService} service.
 */
function buildService(port, dataDir) {
  const service = new MeshService({
    dataDir,
    config: { interopPort: port, interopToken: 'test-token', interopUseGatePassword: false },
    log: () => {},
  })
  service.members = async () => ({
    local: { id: 'local', name: 'member-a', ip: '127.0.0.1' },
    members: [{ id: '10.66.66.2', name: 'B', ip: '127.0.0.1' }],
  })
  return service
}

/**
 * Register the member tools.
 * @param {object} service service.
 * @returns {object[]} tools.
 */
function register(service) {
  const tools = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: () => () => {},
    get: () => undefined,
  }
  registerTools(ctx, { tools: { register: tool => { tools.push(tool) } } }, service)
  return tools
}

const mainAgent = { id: 'main-1', session: { id: 'main-1' } }

/**
 * A main agent whose session surface carries the given messages.
 * @param {{text: string, kind?: string}[]} messages user messages, oldest first.
 * @returns {object} agent.
 */
function agentWithMessages(messages) {
  const nodes = []
  const events = new Map()
  messages.forEach((message, index) => {
    const seq = index + 1
    nodes.push(seq)
    events.set(seq, {
      type: 'user/message',
      data: {
        role: 'user',
        source: { kind: message.kind ?? 'user' },
        content: [{ type: 'text', text: message.text }],
      },
    })
  })
  return { id: 'main-1', session: { id: 'main-1', surface: { nodes }, eventAt: seq => events.get(seq) } }
}

test('member scopes persist per conversation, merge, clear, and read as empty without a file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-scope-service-'))
  const dataDir = path.join(dir, 'mesh')
  try {
    const service = new MeshService({ dataDir, config: {}, log: () => {} })
    assert.deepEqual(await service.memberScopes(), {})
    assert.equal(await service.memberScope('conv-1'), null)

    const first = await service.setMemberScope('conv-1', { identity: '  开发  ', scope: ' 插件开发 ' })
    assert.deepEqual(first.scope, { identity: '开发', scope: '插件开发' })
    const merged = await service.setMemberScope('conv-1', { identity: '测试' })
    assert.deepEqual(merged.scope, { identity: '测试', scope: '插件开发' })
    await service.setMemberScope('main-1', {
      scope: '主对话验收',
      avoidLongJobs: true,
      compressPercent: 50,
    })

    const saved = JSON.parse(await readFile(path.join(dataDir, 'member-scopes.json'), 'utf8'))
    assert.deepEqual(saved, {
      'conv-1': { identity: '测试', scope: '插件开发' },
      'main-1': { scope: '主对话验收', avoidLongJobs: true, compressPercent: 50 },
    })

    const cleared = await service.setMemberScope('conv-1', { identity: '' })
    assert.deepEqual(cleared.scope, { scope: '插件开发' })
    const removed = await service.setMemberScope('conv-1', { scope: '' })
    assert.equal(removed.scope, null, 'the record disappears when nothing remains')

    await assert.rejects(service.setMemberScope('', {}), /conversation id is required/u)
    await assert.rejects(service.setMemberScope('x', { identity: 42 }), /identity must be a string/u)
    await assert.rejects(service.setMemberScope('x', { scope: null }), /scope must be a string/u)
    await assert.rejects(service.setMemberScope('x', { role: '老板' }), /role must be one of/u)
    await assert.rejects(service.setMemberScope('x', { identity: 'a'.repeat(41) }), /identity is too long: 41 > 40/u)
    await assert.rejects(service.setMemberScope('x', { scope: 'b'.repeat(121) }), /scope is too long: 121 > 120/u)
    await assert.rejects(service.setMemberScope('x', { callMemberBudget: 8 }), /callMemberBudget must be an object mapping A, B, C, D to budgets \(no single number\)/u)
    await assert.rejects(service.setMemberScope('x', { callMemberBudget: {} }), /callMemberBudget must set at least one of A, B, C, D/u)
    await assert.rejects(service.setMemberScope('x', { callMemberBudget: { A: 0 } }), /callMemberBudget.A is out of range: 0 \(1-999\)/u)
    await assert.rejects(service.setMemberScope('x', { callMemberBudget: { A: 1000 } }), /callMemberBudget.A is out of range/u)
    await assert.rejects(service.setMemberScope('x', { callMemberBudget: { A: 1.5 } }), /callMemberBudget.A must be an integer/u)
    await assert.rejects(service.setMemberScope('x', { callMemberBudget: { E: 3 } }), /unknown callMemberBudget stage: E/u)
    await assert.rejects(service.setMemberScope('x', { compressPercent: '35' }), /compressPercent must be a number/u)
    await assert.rejects(service.setMemberScope('x', { compressPercent: 0 }), /compressPercent is out of range: 0/u)
    await assert.rejects(service.setMemberScope('x', { compressPercent: 101 }), /compressPercent is out of range/u)

    const restarted = new MeshService({ dataDir, config: {}, log: () => {} })
    assert.deepEqual((await restarted.memberScopes())['main-1'], {
      scope: '主对话验收',
      avoidLongJobs: true,
      compressPercent: 50,
    })
    await writeFile(path.join(dataDir, 'member-scopes.json'), '{not json', 'utf8')
    assert.deepEqual(await service.memberScopes(), {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scope readers apply defaults and drop unusable stored values', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-scope-defaults-'))
  const dataDir = path.join(dir, 'mesh')
  try {
    assert.equal(effectiveCompressPercent(null), 35)
    assert.equal(effectiveCompressPercent({ compressPercent: 12.5 }), 12.5)

    const service = new MeshService({ dataDir, config: {}, log: () => {} })
    await mkdir(dataDir, { recursive: true })
    await writeFile(path.join(dataDir, 'member-scopes.json'), JSON.stringify({
      good: { identity: '开发', role: '开发', keep: true, keepPrompt: '检查成员结果', avoidLongJobs: true, callMemberBudget: { A: 20, C: 3 }, note: '只读复核', compressPercent: 75 },
      badIdle: { identity: '测试' },
      badPercent: { compressPercent: 0 },
      badBudget: { callMemberBudget: { A: 0 } },
      onlyJunk: { compressPercent: 101, role: '老板', avoidLongJobs: 'yes' },
      badNote: { note: 'x'.repeat(501) },
    }), 'utf8')
    assert.deepEqual(await service.memberScopes(), {
      good: { identity: '开发', role: '开发', keep: true, keepPrompt: '检查成员结果', avoidLongJobs: true, callMemberBudget: { A: 20, C: 3 }, note: '只读复核', compressPercent: 75 },
      badIdle: { identity: '测试' },
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('set_member_scope sets self by default and preserves the stored settings', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-scope-self-'))
  const dataDir = path.join(dir, 'mesh')
  let service
  try {
    service = new MeshService({ dataDir, config: {}, log: () => {} })
    const tools = register(service)
    const set = tools.find(tool => tool.name === 'set_member_scope')
    const first = await set.execute({ identity: '开发', scope: '插件开发' }, { agent: mainAgent })
    assert.equal(first.ok, true)
    assert.deepEqual(await service.memberScope('main-1'), { identity: '开发', scope: '插件开发' })
    assert.match(first.text, /已设置自身（会话 main-1）/u)
    assert.match(first.text, /身份：开发/u)
    assert.match(first.text, /工作范围：插件开发/u)
    assert.match(first.text, /保持目标：关闭（只对主对话生效）/u)

    const viaSelf = await set.execute({ conversationId: 'self', identity: '测试' }, { agent: mainAgent })
    assert.match(viaSelf.text, /已设置自身/u)
    const viaLocal = await set.execute({ conversationId: 'local', scope: '验收' }, { agent: mainAgent })
    assert.match(viaLocal.text, /已设置自身/u)
    const viaSession = await set.execute({ conversationId: 'main-1', avoidLongJobs: true }, { agent: mainAgent })
    assert.match(viaSession.text, /避免耗时：开启/u)

    const partial = await set.execute({ identity: '网关' }, { agent: mainAgent })
    assert.deepEqual(await service.memberScope('main-1'), {
      identity: '网关',
      scope: '验收',
      avoidLongJobs: true,
    }, 'identity-only must not reset the stored flags')
    assert.match(partial.text, /避免耗时：开启/u)
  } finally {
    await service?.memberTasks.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('set_member_scope on self stores avoidLongJobs and shows it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-scope-avoid-long-'))
  const dataDir = path.join(dir, 'mesh')
  let service
  try {
    service = new MeshService({ dataDir, config: {}, log: () => {} })
    const tools = register(service)
    const set = tools.find(tool => tool.name === 'set_member_scope')

    const initial = await set.execute({ identity: '开发' }, { agent: mainAgent })
    assert.match(initial.text, /避免耗时：关闭（只对主对话生效）/u)
    assert.deepEqual(await service.memberScope('main-1'), { identity: '开发' })

    const enabled = await set.execute({ avoidLongJobs: true }, { agent: mainAgent })
    assert.match(enabled.text, /避免耗时：开启（只对主对话生效）/u)
    assert.deepEqual(await service.memberScope('main-1'), { identity: '开发', avoidLongJobs: true })
    assert.equal(enabled.data.avoidLongJobs, true)

    const disabled = await set.execute({ avoidLongJobs: false }, { agent: mainAgent })
    assert.match(disabled.text, /避免耗时：关闭/u)
    assert.deepEqual(await service.memberScope('main-1'), { identity: '开发', avoidLongJobs: false })

    await assert.rejects(
      () => set.execute({ avoidLongJobs: 'yes' }, { agent: mainAgent }),
      /avoidLongJobs must be a boolean/u,
    )
  } finally {
    await service?.memberTasks.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('set_member_scope on self stores compressPercent and shows effective values', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-scope-self-settings-'))
  const dataDir = path.join(dir, 'mesh')
  let service
  try {
    service = new MeshService({ dataDir, config: {}, log: () => {} })
    const tools = register(service)
    const set = tools.find(tool => tool.name === 'set_member_scope')

    const configured = await set.execute(
      { compressPercent: 50 },
      { agent: mainAgent },
    )
    assert.equal(configured.ok, true)
    assert.deepEqual(await service.memberScope('main-1'), { compressPercent: 50 })
    assert.match(configured.text, /已设置自身（会话 main-1）/u)
    assert.match(configured.text, /压缩阈值：50%/u)
    assert.equal(configured.data.compressPercent, 50)

    const scope = await set.execute({ identity: '网关' }, { agent: mainAgent })
    assert.deepEqual(await service.memberScope('main-1'), {
      identity: '网关',
      compressPercent: 50,
    }, 'a later identity setting keeps the numeric settings')
    assert.match(scope.text, /保持目标：关闭/u)

    await assert.rejects(
      () => set.execute({ compressPercent: 101 }, { agent: mainAgent }),
      /compressPercent is out of range/u,
    )
    await assert.rejects(
      () => set.execute({}, { agent: mainAgent }),
      /identity, role, scope, note, keep, keepPrompt, avoidLongJobs, budgetAudit, waitMember, compressOnTurnEnd, callMemberBudget, or compressPercent is required/u,
    )
  } finally {
    await service?.memberTasks.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('set_member_scope stores keep only for the current conversation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-scope-keep-'))
  const dataDir = path.join(dir, 'mesh')
  let service
  try {
    service = new MeshService({ dataDir, config: {}, log: () => {} })
    const set = register(service).find(tool => tool.name === 'set_member_scope')

    const enabled = await set.execute({ keep: true }, { agent: mainAgent })
    assert.match(enabled.text, /保持目标：开启（只对主对话生效，提示语「继续」）/u)
    assert.equal(enabled.data.keep, true)
    assert.equal(enabled.data.keepPrompt, '继续')
    assert.deepEqual(await service.memberScope('main-1'), { keep: true })

    const partial = await set.execute({ identity: '网关' }, { agent: mainAgent })
    assert.deepEqual(await service.memberScope('main-1'), { identity: '网关', keep: true })
    assert.match(partial.text, /保持目标：开启/u)

    const custom = await set.execute({ keep_prompt: '继续推进成员结果' }, { agent: mainAgent })
    assert.deepEqual(await service.memberScope('main-1'), { identity: '网关', keep: true, keepPrompt: '继续推进成员结果' })
    assert.match(custom.text, /提示语「继续推进成员结果」/u)
    assert.equal(custom.data.keepPrompt, '继续推进成员结果')

    const cleared = await set.execute({ keepPrompt: '' }, { agent: mainAgent })
    assert.deepEqual(await service.memberScope('main-1'), { identity: '网关', keep: true })
    assert.equal(cleared.data.keepPrompt, '继续')
    assert.match(cleared.text, /提示语「继续」/u)

    const ignored = await set.execute({ conversationId: 'conv-x', identity: '开发', keep: true }, { agent: mainAgent })
    assert.equal(ignored.data.ignoredKeep, true)
    assert.deepEqual(await service.memberScope('conv-x'), { identity: '开发' })
    assert.match(ignored.text, /keep \/ keepPrompt \/ avoidLongJobs \/ budgetAudit \/ waitMember \/ compressOnTurnEnd \/ callMemberBudget 只对主对话自身生效/u)

    const ignoredPrompt = await set.execute({ conversationId: 'conv-x', identity: '开发', keep_prompt: '看这里' }, { agent: mainAgent })
    assert.equal(ignoredPrompt.data.ignoredKeepPrompt, true)

    await assert.rejects(() => set.execute({ keep: 'yes' }, { agent: mainAgent }), /keep must be a boolean/u)
    await assert.rejects(() => set.execute({ keepPrompt: 'x'.repeat(201) }, { agent: mainAgent }), /keepPrompt is too long/u)
    await assert.rejects(
      () => set.execute({ keepPrompt: 'a', keep_prompt: 'b' }, { agent: mainAgent }),
      /use only one of keepPrompt and keep_prompt/u,
    )
    await assert.rejects(
      () => set.execute({ conversationId: 'conv-x', keep: false }, { agent: mainAgent }),
      /keep, keepPrompt, avoidLongJobs, budgetAudit, waitMember, compressOnTurnEnd and callMemberBudget only apply to the current session; set identity, role, scope, note, or compressPercent/u,
    )
  } finally {
    await service?.memberTasks.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('set_member_scope stores the opt-in budget audit on self only', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-scope-audit-'))
  const dataDir = path.join(dir, 'mesh')
  let service
  try {
    service = new MeshService({ dataDir, config: {}, log: () => {} })
    const set = register(service).find(tool => tool.name === 'set_member_scope')

    const initial = await set.execute({ identity: '网关' }, { agent: mainAgent })
    assert.match(initial.text, /预算审查：关闭（只对主对话生效）/u)
    assert.equal(initial.data.budgetAudit, false)
    assert.deepEqual(await service.memberScope('main-1'), { identity: '网关' })

    const enabled = await set.execute({ budgetAudit: true }, { agent: mainAgent })
    assert.match(enabled.text, /预算审查：开启（只对主对话生效）/u)
    assert.equal(enabled.data.budgetAudit, true)
    assert.deepEqual(await service.memberScope('main-1'), { identity: '网关', budgetAudit: true })

    const ignored = await set.execute(
      { conversationId: 'conv-x', identity: '开发', budgetAudit: true },
      { agent: mainAgent },
    )
    assert.equal(ignored.data.ignoredBudgetAudit, true)
    assert.deepEqual(await service.memberScope('conv-x'), { identity: '开发' })
    assert.match(ignored.text, /budgetAudit \/ waitMember \/ compressOnTurnEnd \/ callMemberBudget 只对主对话自身生效/u)

    await assert.rejects(
      () => set.execute({ budgetAudit: 'yes' }, { agent: mainAgent }),
      /budgetAudit must be a boolean/u,
    )
    await assert.rejects(
      () => set.execute({ conversationId: 'conv-x', budgetAudit: true }, { agent: mainAgent }),
      /only apply to the current session/u,
    )
  } finally {
    await service?.memberTasks.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('set_member_scope stores a self-only call_member budget and shows it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-scope-budget-'))
  const dataDir = path.join(dir, 'mesh')
  let service
  try {
    service = new MeshService({ dataDir, config: {}, log: () => {} })
    const set = register(service).find(tool => tool.name === 'set_member_scope')
    const budgetAgent = agentWithMessages([{ text: '把 A 阶段预算调到 26，B 阶段预算调到 10' }])

    // Without a recent human instruction the whole call is refused.
    const refused = await set.execute({ callMemberBudget: { A: 8 } }, { agent: mainAgent })
    assert.equal(refused.ok, false)
    assert.match(refused.text, /预算额度只能由用户调整/u)
    assert.equal(refused.data.reason, 'budget_requires_user_instruction')
    assert.equal(await service.memberScope('main-1'), null, 'nothing was written')

    // An injected context message is not a human instruction.
    const injected = await set.execute(
      { callMemberBudget: { A: 8 } },
      { agent: agentWithMessages([{ text: '把 A 阶段预算调到 26', kind: 'member-context' }]) },
    )
    assert.equal(injected.ok, false)
    assert.match(injected.text, /预算额度只能由用户调整/u)

    // A negated or non-adjustment mention does not authorise.
    for (const text of ['不要调整预算到 26', '预算用完了', '继续推进']) {
      const denied = await set.execute({ callMemberBudget: { A: 8 } }, { agent: agentWithMessages([{ text }]) })
      assert.equal(denied.ok, false, text)
    }

    // Only the recent window counts: the authorising message is now too old.
    const old = await set.execute(
      { callMemberBudget: { A: 8 } },
      {
        agent: agentWithMessages([
          { text: '把 A 阶段预算调到 26' },
          ...Array.from({ length: 8 }, () => ({ text: '继续推进' })),
        ]),
      },
    )
    assert.equal(old.ok, false, 'an instruction outside the recent window is ignored')

    const configured = await set.execute({ callMemberBudget: { A: 8 } }, { agent: budgetAgent })
    assert.match(configured.text, /call_member 预算：A 8 \/ B 默认 \/ C 默认 \/ D 默认（只对主对话生效，每个大阶段单独计；未设置按参与成员数 × 2）/u)
    assert.deepEqual(configured.data.callMemberBudget, { A: 8 })
    assert.deepEqual(await service.memberScope('main-1'), { callMemberBudget: { A: 8 } })

    // Each big stage is set separately; a later stage must not wipe the first.
    const viaAlias = await set.execute({ call_member_budget: { B: 12 } }, { agent: budgetAgent })
    assert.deepEqual(viaAlias.data.callMemberBudget, { A: 8, B: 12 })
    assert.deepEqual(await service.memberScope('main-1'), { callMemberBudget: { A: 8, B: 12 } })
    assert.match(viaAlias.text, /A 8 \/ B 12 \/ C 默认 \/ D 默认/u)

    const memberTarget = await set.execute(
      { conversationId: 'conv-x', identity: '开发', callMemberBudget: { A: 3 } },
      { agent: mainAgent },
    )
    assert.equal(memberTarget.data.ignoredCallMemberBudget, true)
    assert.deepEqual(await service.memberScope('conv-x'), { identity: '开发' })
    assert.match(memberTarget.text, /callMemberBudget 只对主对话自身生效/u)

    await assert.rejects(
      () => set.execute({ conversationId: 'conv-x', callMemberBudget: { A: 3 } }, { agent: mainAgent }),
      /only apply to the current session/u,
    )
    await assert.rejects(
      () => set.execute({ callMemberBudget: 8 }, { agent: mainAgent }),
      /must be an object mapping A, B, C, D to budgets \(no single number\)/u,
    )
    await assert.rejects(
      () => set.execute({ callMemberBudget: {} }, { agent: mainAgent }),
      /must set at least one of A, B, C, D/u,
    )
    await assert.rejects(
      () => set.execute({ callMemberBudget: { A: 0 } }, { agent: mainAgent }),
      /callMemberBudget.A is out of range: 0 \(1-999\)/u,
    )
    await assert.rejects(
      () => set.execute({ callMemberBudget: { A: 1000 } }, { agent: mainAgent }),
      /callMemberBudget.A is out of range/u,
    )
    await assert.rejects(
      () => set.execute({ callMemberBudget: { A: 1.5 } }, { agent: mainAgent }),
      /callMemberBudget.A must be an integer/u,
    )
    await assert.rejects(
      () => set.execute({ callMemberBudget: { E: 3 } }, { agent: mainAgent }),
      /unknown callMemberBudget stage: E/u,
    )
    await assert.rejects(
      () => set.execute({ callMemberBudget: { A: 3 }, call_member_budget: { B: 4 } }, { agent: mainAgent }),
      /use only one of callMemberBudget and call_member_budget/u,
    )
  } finally {
    await service?.memberTasks.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('set_member_scope updates a tracked member conversation and stores its standard role', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-scope-member-'))
  const dataDir = path.join(dir, 'mesh')
  let service
  try {
    service = new MeshService({ dataDir, config: {}, log: () => {} })
    const tools = register(service)
    service.memberTasks.tasks.set('task-1', {
      id: 'task-1',
      conversationId: 'conv-9',
      member: 'B',
      memberIp: '10.66.66.2',
      baseUrl: 'http://127.0.0.1:1',
      originSessionId: 'main-1',
      status: 'completed',
      workspace: 'dsh-mesh',
      createdAt: '2026-11-24T00:00:00.000Z',
      updatedAt: '2026-11-24T00:00:00.000Z',
      profile: null,
    })
    const set = tools.find(tool => tool.name === 'set_member_scope')
    const result = await set.execute(
      { conversationId: 'conv-9', identity: '测试', role: '测试', scope: '跨平台验收' },
      { agent: mainAgent },
    )
    assert.equal(result.ok, true)
    assert.deepEqual(await service.memberScope('conv-9'), { identity: '测试', role: '测试', scope: '跨平台验收' })
    assert.match(result.text, /已设置成员会话 conv-9/u)
    assert.match(result.text, /标准身份：测试/u)
    assert.doesNotMatch(result.text, /保持目标：/u)
    assert.match(result.text, /压缩阈值：35%（投递前超过该占比自动压缩）/u)
    assert.deepEqual(service.memberTasks.tasks.get('task-1').profile, {
      name: 'B',
      identity: '测试',
      role: '测试',
      scope: '跨平台验收',
    })
    const savedTask = JSON.parse(await readFile(path.join(dataDir, 'member-tasks', 'task-1.json'), 'utf8'))
    assert.deepEqual(savedTask.profile, { name: 'B', identity: '测试', role: '测试', scope: '跨平台验收' })

    const partial = await set.execute({ conversationId: 'conv-9', identity: '开发' }, { agent: mainAgent })
    assert.deepEqual(await service.memberScope('conv-9'), { identity: '开发', role: '测试', scope: '跨平台验收' })
    assert.match(partial.text, /身份：开发/u)
    assert.match(partial.text, /工作范围：跨平台验收/u)
    assert.match(partial.text, /标准身份：测试/u)

    const cleared = await set.execute({ conversationId: 'conv-9', identity: '', role: '', scope: '' }, { agent: mainAgent })
    assert.equal(cleared.data.scope, null)
    assert.match(cleared.text, /身份：未设置/u)
    assert.match(cleared.text, /工作范围：未设置/u)
    assert.equal(service.memberTasks.tasks.get('task-1').profile, null)

    const onlyCompress = await set.execute(
      { conversationId: 'conv-9', compressPercent: 10 },
      { agent: mainAgent },
    )
    assert.deepEqual(await service.memberScope('conv-9'), { compressPercent: 10 })
    assert.match(onlyCompress.text, /压缩阈值：10%（投递前超过该占比自动压缩）/u)
    assert.equal(onlyCompress.data.compressPercent, 10)

    const ignored = await set.execute(
      { conversationId: 'conv-9', identity: '开发', avoidLongJobs: true },
      { agent: mainAgent },
    )
    assert.deepEqual(await service.memberScope('conv-9'), { identity: '开发', compressPercent: 10 })
    assert.match(ignored.text, /keep \/ keepPrompt \/ avoidLongJobs \/ budgetAudit \/ waitMember \/ compressOnTurnEnd \/ callMemberBudget 只对主对话自身生效/u)
    assert.equal(ignored.data.ignoredAvoidLongJobs, true)

    await assert.rejects(
      () => set.execute({ conversationId: 'conv-9', avoidLongJobs: true }, { agent: mainAgent }),
      /keep, keepPrompt, avoidLongJobs, budgetAudit, waitMember, compressOnTurnEnd and callMemberBudget only apply to the current session; set identity, role, scope, note, or compressPercent/u,
    )
    await assert.rejects(
      () => set.execute({ conversationId: 'conv-9', compressPercent: 0 }, { agent: mainAgent }),
      /compressPercent is out of range/u,
    )
  } finally {
    await service?.memberTasks.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('set_member_scope stores a main-only note for a member conversation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-scope-note-'))
  const dataDir = path.join(dir, 'mesh')
  let service
  try {
    service = new MeshService({ dataDir, config: {}, log: () => {} })
    const tools = register(service)
    service.memberTasks.tasks.set('task-note', {
      id: 'task-note',
      conversationId: 'conv-note',
      member: 'B',
      memberIp: '10.66.66.2',
      baseUrl: 'http://127.0.0.1:1',
      originSessionId: 'main-1',
      status: 'completed',
      workspace: 'dsh-mesh',
      createdAt: '2026-11-24T00:00:00.000Z',
      updatedAt: '2026-11-24T00:00:00.000Z',
      profile: { name: 'B', identity: '测试', scope: '跨平台验收' },
    })
    const set = tools.find(tool => tool.name === 'set_member_scope')

    const saved = await set.execute(
      { conversationId: 'conv-note', identity: '测试', note: '只做只读复核，不要改内核文件' },
      { agent: mainAgent },
    )
    assert.equal(saved.ok, true)
    assert.match(saved.text, /备注：只做只读复核，不要改内核文件/u)
    assert.deepEqual(await service.memberScope('conv-note'), {
      identity: '测试',
      note: '只做只读复核，不要改内核文件',
    })
    assert.equal(saved.data.note, '只做只读复核，不要改内核文件')

    // The note is main-conversation metadata: it must never leak into the
    // profile snapshot that is injected into / prefixed onto the member.
    const profile = service.memberTasks.tasks.get('task-note').profile
    assert.equal('note' in profile, false, 'the note must not enter the member profile snapshot')
    assert.equal(profile.identity, '测试')

    const cleared = await set.execute({ conversationId: 'conv-note', note: '' }, { agent: mainAgent })
    assert.deepEqual(await service.memberScope('conv-note'), { identity: '测试' })
    assert.match(cleared.text, /备注：未设置/u)

    const selfIgnored = await set.execute({ note: '主对话自己的备注' }, { agent: mainAgent })
    assert.match(selfIgnored.text, /note 只对成员会话生效，设置自身时已忽略/u)
    assert.equal(selfIgnored.data.ignoredNote, true)

    await assert.rejects(
      () => set.execute({ conversationId: 'conv-note', note: 123 }, { agent: mainAgent }),
      /note must be a string/u,
    )
    await assert.rejects(
      () => set.execute({ conversationId: 'conv-note', note: 'x'.repeat(501) }, { agent: mainAgent }),
      /note is too long/u,
    )
  } finally {
    await service?.memberTasks.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('setting only compressPercent preserves the tracked task profile', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-scope-profile-'))
  const dataDir = path.join(dir, 'mesh')
  let service
  try {
    service = new MeshService({ dataDir, config: {}, log: () => {} })
    const set = register(service).find(tool => tool.name === 'set_member_scope')
    service.memberTasks.tasks.set('task-1', {
      id: 'task-1',
      conversationId: 'conv-9',
      member: 'B',
      memberIp: '10.66.66.2',
      baseUrl: 'http://127.0.0.1:1',
      originSessionId: 'main-1',
      status: 'completed',
      workspace: 'dsh-mesh',
      createdAt: '2026-11-24T00:00:00.000Z',
      updatedAt: '2026-11-24T00:00:00.000Z',
      profile: null,
    })
    const oldProfile = { name: 'B', identity: '旧身份', scope: '旧范围' }
    await service.memberTasks.syncTaskScope('conv-9', { identity: '旧身份', scope: '旧范围' })
    assert.deepEqual(service.memberTasks.tasks.get('task-1').profile, oldProfile)

    const result = await set.execute({ conversationId: 'conv-9', compressPercent: 10 }, { agent: mainAgent })
    assert.equal(result.data.tracked, true)
    assert.deepEqual(service.memberTasks.tasks.get('task-1').profile, oldProfile)
    const saved = JSON.parse(await readFile(path.join(dataDir, 'member-tasks', 'task-1.json'), 'utf8'))
    assert.deepEqual(saved.profile, oldProfile)
    assert.deepEqual(await service.memberScope('conv-9'), { compressPercent: 10 })
  } finally {
    await service?.memberTasks.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('stop_all_member messages every running conversation and continues after a failure', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-stop-all-'))
  const dataDir = path.join(dir, 'mesh')
  let service
  try {
    service = new MeshService({ dataDir, config: {}, log: () => {} })
    const stop = register(service).find(tool => tool.name === 'stop_all_member')
    const sent = []
    service.memberTasks.inFlightForOrigin = async () => [
      { conversationId: 'c1', member: 'B', memberIp: '10.66.66.2', status: 'running' },
      { conversationId: 'c2', member: 'C', memberIp: '10.66.66.3', status: 'starting' },
    ]
    service.memberTasks.send = async ({ conversationId, prompt }) => {
      sent.push({ conversationId, prompt })
      if (conversationId === 'c2') throw new Error('unreachable')
      return { conversationId, lastDelivery: 'steer' }
    }

    const result = await stop.execute({}, { agent: mainAgent })
    assert.deepEqual(sent.map(item => item.conversationId), ['c1', 'c2'])
    assert.equal(sent[0].prompt, STOP_ALL_MEMBER_PROMPT)
    assert.equal(result.ok, false, 'one failed delivery')
    assert.equal(result.data.total, 2)
    assert.equal(result.data.sent, 1)
    assert.equal(result.data.failed, 1)
    assert.match(result.text, /已向 1\/2 个进行中的成员对话发送停止请求/u)
    assert.match(result.text, /c1（B 10\.66\.66\.2）：已插入当前轮/u)
    assert.match(result.text, /c2（C 10\.66\.66\.3）：失败：unreachable/u)

    service.memberTasks.inFlightForOrigin = async () => []
    const empty = await stop.execute({}, { agent: mainAgent })
    assert.equal(empty.ok, true)
    assert.match(empty.text, /没有进行中的成员对话/u)
    assert.equal(empty.data.total, 0)
  } finally {
    await service?.memberTasks.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('member conversations expose the current stage and budget for the header', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-member-stage-'))
  const dataDir = path.join(dir, 'mesh')
  try {
    const service = new MeshService({ dataDir, config: {}, log: () => {} })
    const cwd = '/root/ws/project'
    await service.setProductStage({ cwd, stage: 'A', now: new Date(2026, 10, 26, 18, 0, 0) })
    await service.setMemberScope('main-1', { callMemberBudget: { A: 4 } })
    const tasks = [{
      conversationId: 'c1',
      member: 'B',
      memberIp: '10.66.66.2',
      workspace: 'dsh-mesh',
      status: 'running',
      originCwd: cwd,
      replies: [{ at: '2026-11-26T18:01:00.000Z' }],
      createdAt: '2026-11-26T18:00:00.000Z',
      updatedAt: '2026-11-26T18:01:00.000Z',
    }]
    service.memberTasks = { listForOrigin: async () => tasks }
    const view = await service.memberConversations('main-1')
    assert.deepEqual(view.stage, {
      version: '20261126.1.1', stage: 'A', round: 1, label: '计划与目标',
    })
    assert.deepEqual(view.budget, {
      stage: 'A', used: 1, limit: 4, remaining: 3, source: 'explicit', exhausted: false,
    })

    service.memberTasks = { listForOrigin: async () => [] }
    const noTasks = await service.memberConversations('main-1')
    assert.equal(noTasks.stage, null)
    assert.equal(noTasks.budget, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('concurrent saves of one task serialize and never collide on a temporary file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-scope-concurrent-'))
  const dataDir = path.join(dir, 'mesh')
  let memberTasks
  try {
    memberTasks = new MemberTaskService({
      ctx: {},
      service: { config: {}, dataDir, repositoryRoot: dataDir },
      dataDir,
      log: () => {},
    })
    await memberTasks.init()
    memberTasks.tasks.set('task-concurrent', {
      id: 'task-concurrent',
      conversationId: 'conv-concurrent',
      member: 'B',
      memberIp: '10.66.66.2',
      baseUrl: 'http://127.0.0.1:1',
      originSessionId: 'main-1',
      status: 'completed',
      workspace: 'dsh-mesh',
      createdAt: '2026-11-24T00:00:00.000Z',
      updatedAt: '2026-11-24T00:00:00.000Z',
      profile: null,
    })

    // A monitor and a tool call used to save the same task through one shared
    // temporary file; the first rename moved it away and the rest hit ENOENT.
    const writes = 64
    await Promise.all(Array.from({ length: writes }, (_, index) => memberTasks.syncTaskScope(
      'conv-concurrent',
      { identity: `identity-${index}`, scope: `scope-${index}` },
    )))

    // Serialization must also leave the newest snapshot, not whichever
    // temporary rename finished last.
    const expected = { name: 'B', identity: `identity-${writes - 1}`, scope: `scope-${writes - 1}` }
    assert.deepEqual(memberTasks.tasks.get('task-concurrent').profile, expected)
    const saved = JSON.parse(await readFile(path.join(dataDir, 'member-tasks', 'task-concurrent.json'), 'utf8'))
    assert.deepEqual(saved.profile, expected)
    const leftovers = (await readdir(path.join(dataDir, 'member-tasks'))).filter(file => file.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], 'no temporary file may be left behind')
  } finally {
    await memberTasks?.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('set_member_scope on self stores the wait_member switch', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-scope-wait-'))
  const dataDir = path.join(dir, 'mesh')
  let service
  try {
    service = new MeshService({ dataDir, config: {}, log: () => {} })
    const tools = register(service)
    const set = tools.find(tool => tool.name === 'set_member_scope')

    const initial = await set.execute({ identity: '开发' }, { agent: mainAgent })
    assert.match(initial.text, /wait_member：开启（只对主对话生效）/u)

    const off = await set.execute({ waitMember: false }, { agent: mainAgent })
    assert.equal(off.ok, true)
    assert.match(off.text, /wait_member：关闭（只对主对话生效）/u)
    assert.equal(off.data.waitMember, false)
    assert.deepEqual(await service.memberScope('main-1'), { identity: '开发', waitMember: false })

    const on = await set.execute({ waitMember: true }, { agent: mainAgent })
    assert.match(on.text, /wait_member：开启/u)
    assert.equal(on.data.waitMember, true)
    assert.deepEqual(await service.memberScope('main-1'), { identity: '开发', waitMember: true })

    await assert.rejects(
      () => set.execute({ waitMember: 'no' }, { agent: mainAgent }),
      /waitMember must be a boolean/u,
    )

    const member = await set.execute({ conversationId: 'conv-x', identity: '测试', waitMember: false }, { agent: mainAgent })
    assert.match(member.text, /waitMember \/ compressOnTurnEnd \/ callMemberBudget 只对主对话自身生效/u)
    assert.deepEqual(await service.memberScope('conv-x'), { identity: '测试' }, 'a member conversation never stores the switch')
  } finally {
    await service?.memberTasks.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('set_member_scope on self stores turn-end compression', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-scope-compress-'))
  const dataDir = path.join(dir, 'mesh')
  let service
  try {
    service = new MeshService({ dataDir, config: {}, log: () => {} })
    const tools = register(service)
    const set = tools.find(tool => tool.name === 'set_member_scope')

    const initial = await set.execute({ identity: '开发' }, { agent: mainAgent })
    assert.match(initial.text, /turn\/end 自动压缩：关闭（只对主对话生效）/u)

    const on = await set.execute({ compressPercent: 40, compressOnTurnEnd: true }, { agent: mainAgent })
    assert.equal(on.ok, true)
    assert.match(on.text, /turn\/end 自动压缩：开启（只对主对话生效）/u)
    assert.match(on.text, /压缩阈值：40%/u)
    assert.equal(on.data.compressOnTurnEnd, true)
    assert.equal(on.data.compressPercent, 40)
    assert.deepEqual(await service.memberScope('main-1'), {
      identity: '开发',
      compressPercent: 40,
      compressOnTurnEnd: true,
    })

    const off = await set.execute({ compressOnTurnEnd: false }, { agent: mainAgent })
    assert.match(off.text, /turn\/end 自动压缩：关闭/u)
    assert.equal(off.data.compressOnTurnEnd, false)
    assert.equal((await service.memberScope('main-1')).compressOnTurnEnd, false)

    await assert.rejects(
      () => set.execute({ compressOnTurnEnd: 'yes' }, { agent: mainAgent }),
      /compressOnTurnEnd must be a boolean/u,
    )
  } finally {
    await service?.memberTasks.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('set_member_scope saves an untracked conversation and rejects invalid input', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-scope-untracked-'))
  const dataDir = path.join(dir, 'mesh')
  let service
  try {
    service = new MeshService({ dataDir, config: {}, log: () => {} })
    const tools = register(service)
    const set = tools.find(tool => tool.name === 'set_member_scope')
    const untracked = await set.execute({ conversationId: 'conv-other', scope: '外部会话' }, { agent: mainAgent })
    assert.match(untracked.text, /本机未跟踪该会话，只保存设置/u)
    assert.deepEqual(await service.memberScope('conv-other'), { scope: '外部会话' })

    await assert.rejects(() => set.execute({}, { agent: mainAgent }), /identity, role, scope, note, keep, keepPrompt, avoidLongJobs, budgetAudit, waitMember, compressOnTurnEnd, callMemberBudget, or compressPercent is required/u)
    await assert.rejects(
      () => set.execute({ conversationId: 'conv-other', avoidLongJobs: true }, { agent: mainAgent }),
      /keep, keepPrompt, avoidLongJobs, budgetAudit, waitMember, compressOnTurnEnd and callMemberBudget only apply to the current session; set identity, role, scope, note, or compressPercent/u,
    )
    await assert.rejects(
      () => set.execute({ identity: 'a'.repeat(41) }, { agent: mainAgent }),
      /identity is too long: 41 > 40/u,
    )
    await assert.rejects(
      () => set.execute({ scope: 'b'.repeat(121) }, { agent: mainAgent }),
      /scope is too long: 121 > 120/u,
    )
    await assert.rejects(
      () => set.execute({ identity: 42 }, { agent: mainAgent }),
      /identity must be a string/u,
    )
  } finally {
    await service?.memberTasks.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('call_member persists a new conversation scope, injects it into mesh, and snapshots the task', async () => {
  const member = await fakeMember()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-scope-call-'))
  const dataDir = path.join(dir, 'mesh')
  let service
  try {
    service = buildService(member.port, dataDir)
    const call = register(service).find(tool => tool.name === 'call_member')
    const result = await call.execute(
      {
        member: '10.66.66.2',
        prompt: '实现功能',
        identity: '开发',
        scope: 'dsh-mesh 插件开发与构建',
      },
      { agent: mainAgent },
    )
    assert.equal(result.ok, true)
    assert.match(result.text, /身份：开发；负责范围：dsh-mesh 插件开发与构建/u)
    assert.deepEqual(result.data.profile, {
      name: 'B',
      identity: '开发',
      scope: 'dsh-mesh 插件开发与构建',
    })
    assert.equal('mesh' in member.created[0], false, 'mesh facts no longer ride in the create request')
    assert.equal(member.created[0].prompt, '【成员身份】你的身份：开发；负责范围：dsh-mesh 插件开发与构建。\n实现功能')
    assert.deepEqual(await service.memberScope('conv-new'), {
      identity: '开发',
      scope: 'dsh-mesh 插件开发与构建',
    })
    const task = [...service.memberTasks.tasks.values()][0]
    assert.deepEqual(task.profile, result.data.profile)
    const saved = JSON.parse(await readFile(path.join(dataDir, 'member-tasks', `${task.id}.json`), 'utf8'))
    assert.deepEqual(saved.profile, result.data.profile)
  } finally {
    await service?.memberTasks.dispose()
    await member.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('call_member injects the environment block into every prompt instead of the context', async () => {
  const member = await fakeMember()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-scope-env-'))
  const dataDir = path.join(dir, 'mesh')
  let service
  try {
    service = buildService(member.port, dataDir)
    service.releaseTokens = async () => ({ github: 'ghp_live', gitee: null })
    service.directLinkFor = async () => ({ port: 8080 })
    service.probeMemberEgress = async () => ({ ok: true, latencyMs: 118, downMbps: 42.3 })
    const call = register(service).find(tool => tool.name === 'call_member')

    await call.execute(
      { member: '10.66.66.2', prompt: '第一件事', identity: '开发', scope: '插件' },
      { agent: mainAgent },
    )
    assert.equal(member.created[0].prompt, [
      '【成员身份】你的身份：开发；负责范围：插件。',
      '【成员环境】',
      '本机代理端口 8080；经代理出网实测：延迟 118 ms，下行 42.3 Mbps。',
      'GitHub token: ghp_live',
      '第一件事',
    ].join('\n'))
    assert.equal('mesh' in member.created[0], false)

    await call.execute(
      { member: '10.66.66.2', conversationId: 'conv-new', prompt: '第二件事' },
      { agent: mainAgent },
    )
    assert.equal(member.messages.length, 1)
    const continuation = member.messages[0].content
    assert.equal(continuation, [
      '【成员环境】',
      '本机代理端口 8080；经代理出网实测：延迟 118 ms，下行 42.3 Mbps。',
      'GitHub token: ghp_live',
      '第二件事',
    ].join('\n'), 'the environment is re-injected; no identity prefix without scope args')
  } finally {
    await service?.memberTasks.dispose()
    await member.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('call_member without identity/scope asks for them next time', async () => {
  const member = await fakeMember()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-scope-missing-'))
  const dataDir = path.join(dir, 'mesh')
  let service
  try {
    service = buildService(member.port, dataDir)
    const call = register(service).find(tool => tool.name === 'call_member')
    const result = await call.execute({ member: '10.66.66.2', prompt: '新任务' }, { agent: mainAgent })
    assert.equal(result.data.profile, null)
    assert.equal('mesh' in member.created[0], false)
    assert.equal(member.created[0].prompt, '新任务')
    assert.match(result.text, /该会话还没有身份\/工作范围：下次 call_member 带 identity 和 scope 参数，或用 set_member_scope 设置。/u)
  } finally {
    await service?.memberTasks.dispose()
    await member.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('continuing an old conversation merges its scope and prefixes the delivery', async () => {
  const member = await fakeMember()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-scope-continue-'))
  const dataDir = path.join(dir, 'mesh')
  let service
  try {
    service = buildService(member.port, dataDir)
    const call = register(service).find(tool => tool.name === 'call_member')
    const base = { member: '10.66.66.2', conversationId: 'conv-9', prompt: '继续' }

    const missing = await call.execute(base, { agent: mainAgent })
    assert.equal(missing.data.profile, null)
    assert.equal(member.messages[0].content, '继续')

    const partial = await call.execute({ ...base, scope: '跨平台验收' }, { agent: mainAgent })
    assert.deepEqual(partial.data.profile, { name: 'B', identity: null, scope: '跨平台验收' })
    assert.equal(member.messages[1].content, '【成员身份】负责范围：跨平台验收。\n继续')
    assert.deepEqual(await service.memberScope('conv-9'), { scope: '跨平台验收' })

    const merged = await call.execute({ ...base, identity: '测试' }, { agent: mainAgent })
    assert.deepEqual(merged.data.profile, { name: 'B', identity: '测试', scope: '跨平台验收' })
    assert.equal(member.messages[2].content, '【成员身份】你的身份：测试；负责范围：跨平台验收。\n继续')
    assert.match(merged.text, /身份：测试；负责范围：跨平台验收/u)
  } finally {
    await service?.memberTasks.dispose()
    await member.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('call_member rejects invalid scope values before creating or delivering anything', async () => {
  const member = await fakeMember()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-scope-invalid-'))
  const dataDir = path.join(dir, 'mesh')
  let service
  try {
    service = buildService(member.port, dataDir)
    const call = register(service).find(tool => tool.name === 'call_member')
    await assert.rejects(
      () => call.execute({ member: '10.66.66.2', prompt: 'x', identity: 42 }, { agent: mainAgent }),
      /identity must be a string/u,
    )
    await assert.rejects(
      () => call.execute({ member: '10.66.66.2', prompt: 'x', scope: 'b'.repeat(121) }, { agent: mainAgent }),
      /scope is too long: 121 > 120/u,
    )
    await assert.rejects(
      () => call.execute({ member: '10.66.66.2', conversationId: 'conv-9', prompt: '继续', identity: 'a'.repeat(41) }, { agent: mainAgent }),
      /identity is too long: 41 > 40/u,
    )
    assert.deepEqual(member.created, [])
    assert.deepEqual(member.messages, [])
  } finally {
    await service?.memberTasks.dispose()
    await member.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('continuing without scope arguments shows an existing stored scope but adds no prefix', async () => {
  const member = await fakeMember()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-scope-existing-'))
  const dataDir = path.join(dir, 'mesh')
  let service
  try {
    service = buildService(member.port, dataDir)
    await service.setMemberScope('conv-9', { identity: '预置身份', scope: '预置范围' })
    const call = register(service).find(tool => tool.name === 'call_member')
    const result = await call.execute(
      { member: '10.66.66.2', conversationId: 'conv-9', prompt: '继续' },
      { agent: mainAgent },
    )
    assert.deepEqual(result.data.profile, { name: 'B', identity: '预置身份', scope: '预置范围' })
    assert.match(result.text, /身份：预置身份；负责范围：预置范围/u)
    assert.equal(member.messages[0].content, '继续', 'without arguments the delivery stays unprefixed')
  } finally {
    await service?.memberTasks.dispose()
    await member.close()
    await rm(dir, { recursive: true, force: true })
  }
})
