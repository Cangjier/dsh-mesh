import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createInteropService, resolveInteropSettings } from '../src/lib/interop-service.mjs'

/**
 * One fake host context plus its agent registry.
 * @param {object} [options] knobs.
 * @returns {object} fake context and inspection helpers.
 */
function fakeHost(options = {}) {
  const listeners = new Map()
  const emitted = []
  const sessions = new Map()
  const agents = new Map()
  const presetCalls = []
  const presetMounts = []
  const createInputs = []
  let nextAgent = null

  /** Emit one host event to its listeners. */
  const emit = (name, ...args) => {
    emitted.push([name, args])
    for (const entry of listeners.get(name) ?? []) entry.fn(...args)
  }

  const host = {
    _listeners: listeners,
    listenersFor(name) { return (listeners.get(name) ?? []).map(entry => entry.fn) },
    on(name, fn, opts) {
      const list = listeners.get(name) ?? []
      list.push({ fn, opts })
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        listeners.set(name, current.filter(entry => entry.fn !== fn))
      }
    },
    get(name) {
      if (options.services !== undefined && name in options.services) return options.services[name]
      if (name === 'permissionPresets') {
        return { set: (session, preset) => { presetCalls.push([session.id, preset]) } }
      }
      if (name === 'agentPresets') {
        return {
          resolve: async id => ({ id: id ?? 'standard' }),
          mount: async (_agentCtx, id) => { presetMounts.push(id) },
          serviceFor: (_agent, service) => options.services?.scoped?.[service],
        }
      }
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      return () => dispose?.()
    },
    agents: {
      async create(input) {
        createInputs.push(input)
        const session = {
          id: input.sessionId,
          appended: [],
          append(events) { this.appended.push(...events) },
        }
        const agent = {
          id: input.sessionId,
          status: 'idle',
          session,
          options: { provider: 'deepseek-account', model: 'deepseek-flash' },
          followup(message) {
            this.lastMessage = message
            this.status = 'running'
            input.followupCalls?.push?.(message)
            emit('agent/status', { agent: this, status: 'running' })
            emit('session/event', session, { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } })
          },
          async runMaintenance(job) { return job(new AbortController().signal) },
        }
        await input.setup?.(options.agentCtx ?? {}, agent)
        sessions.set(session.id, session)
        agents.set(session.id, agent)
        nextAgent = agent
        return {
          agent,
          async dispose() {
            agents.delete(session.id)
            emit('agent/disposed', { agent })
          },
        }
      },
      async resume(input) {
        const session = sessions.get(input.resumeSessionId) ?? { id: input.resumeSessionId, appended: [], append(events) { this.appended.push(...events) } }
        const agent = {
          id: input.resumeSessionId,
          status: 'idle',
          session,
          options: { provider: 'deepseek-account', model: 'deepseek-flash' },
          followup(message) {
            this.lastMessage = message
            this.status = 'running'
            emit('agent/status', { agent: this, status: 'running' })
            emit('session/event', session, { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } })
          },
          async runMaintenance(job) { return job(new AbortController().signal) },
        }
        sessions.set(session.id, session)
        agents.set(agent.id, agent)
        await input.setup?.(options.agentCtx ?? {}, agent)
        return { agent, async dispose() { agents.delete(agent.id); emit('agent/disposed', { agent }) } }
      },
      get(id) { return agents.get(id) },
    },
  }

  return { host, emit, sessions, agents, presetCalls, presetMounts, createInputs, getAgent: () => nextAgent }
}

/**
 * One service over a temp dir and a fake host.
 * @param {object} [overrides] settings overrides.
 * @param {object} [hostOptions] fake-host options, such as extra services.
 * @returns {Promise<object>} service, host, port and dir.
 */
async function serviceOf(overrides = {}, hostOptions = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mesh-interop-'))
  const fake = fakeHost(hostOptions)
  const settings = {
    bind: '127.0.0.1',
    port: 0,
    token: 'test-token',
    dataDir: dir,
    workdir: dir,
    workspaceRoot: path.join(dir, 'workspaces'),
    stateFile: path.join(dir, 'conversations.json'),
    logFile: path.join(dir, 'interop.log'),
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    approve: true,
    preset: 'workspace-write',
    agentPreset: 'standard',
    tokenSource: 'test',
    ...overrides,
  }
  const service = createInteropService({
    ctx: fake.host,
    settings,
    log: () => {},
    retry: false,
  })
  const { port } = await service.start()
  const token = settings.token
  const call = async (method, url, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }
  return { service, fake, settings, port, call, dir }
}

test('a launch creates a host agent, titles it and prompts it', async () => {
  const { service, fake, call, dir } = await serviceOf()
  try {
    const created = await call('POST', '/v1/conversations', {
      prompt: '# 任务\n\n做点事',
      title: '重建面板',
      initiator: { id: 'gateway', name: 'gw' },
    })
    assert.equal(created.status, 201)
    const id = created.body.conversation.id
    assert.equal(created.body.conversation.status, 'running')
    const agent = fake.agents.get(id)
    assert.ok(agent)
    assert.equal(agent.session.appended[0][0], 'session/title')
    assert.equal(agent.session.appended[0][1].title, '重建面板')
    assert.equal(agent.lastMessage.role, 'user')
    assert.equal(agent.lastMessage.content[0].text, '# 任务\n\n做点事')
    assert.deepEqual(fake.presetCalls, [[id, 'workspace-write']])
    assert.equal(fake.createInputs[0].meta.agentPreset, 'standard')
    assert.deepEqual(fake.presetMounts, ['standard'])

    // A live agent's completion is reflected without any cold read.
    fake.emit('session/event', agent.session, {
      type: 'assistant/message',
      seq: 1,
      time: Date.now(),
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '完成' }] }, stream: [] },
    })
    fake.emit('session/event', agent.session, { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
    fake.emit('agent/status', { agent, status: 'idle' })

    const answer = await call('GET', `/v1/conversations/${id}/result`)
    assert.equal(answer.body.conversation.status, 'idle')
    assert.equal(answer.body.finalText, '完成')
    assert.equal(answer.body.conversation.turns, 1)
    assert.equal(answer.body.conversation.updatedAt >= created.body.conversation.updatedAt, true)
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a new conversation denies the question tool and carries the measured mesh facts', async () => {
  const restricted = []
  const contexts = []
  const agentCtx = {
    tools: { restrict: filter => { restricted.push(filter) } },
    systemPrompt: { context: entry => { contexts.push(entry) } },
  }
  const { service, call, dir } = await serviceOf({}, { agentCtx })
  try {
    const created = await call('POST', '/v1/conversations', {
      prompt: '做个任务',
      mesh: {
        link: true,
        proxyPort: 8080,
        egress: { ok: true, latencyMs: 118, downMbps: 42.3 },
        tokens: { github: 'ghp_test_token', gitee: null },
      },
    })
    assert.equal(created.status, 201)
    // The question tool has no answerer in a task conversation, so the preset's
    // contribution is filtered out for this agent only.
    assert.deepEqual(restricted, [{ deny: ['ask_user_question'] }])
    assert.deepEqual(contexts.map(entry => entry.name), ['mesh:interaction', 'mesh:environment'])
    assert.match(contexts[0].text, /禁用了 ask_user_question/u)
    assert.equal(contexts[0].interpolate, false)
    assert.equal(contexts[1].text, '本机代理端口 8080；经代理出网实测：延迟 118 ms，下行 42.3 Mbps。\nGitHub token: ghp_test_token')
    assert.equal(contexts[1].interpolate, false)
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a conversation without mesh facts still gets the interaction rule', async () => {
  const contexts = []
  const agentCtx = {
    tools: { restrict: () => { throw new Error('unknown global tool "ask_user_question"') } },
    systemPrompt: { context: entry => { contexts.push(entry) } },
  }
  const { service, call, dir } = await serviceOf({}, { agentCtx })
  try {
    const created = await call('POST', '/v1/conversations', { prompt: '照常执行' })
    assert.equal(created.status, 201)
    assert.deepEqual(contexts.map(entry => entry.name), ['mesh:interaction'])
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a resumed conversation re-applies the question-tool restriction', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mesh-interop-'))
  const settings = {
    bind: '127.0.0.1',
    port: 0,
    token: 'test-token',
    dataDir: dir,
    workdir: dir,
    workspaceRoot: path.join(dir, 'workspaces'),
    stateFile: path.join(dir, 'conversations.json'),
    logFile: path.join(dir, 'interop.log'),
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    approve: true,
    preset: 'workspace-write',
    agentPreset: 'standard',
    tokenSource: 'test',
  }
  const call = async (port, method, url, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { authorization: 'Bearer test-token', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }
  let service = createInteropService({
    ctx: fakeHost({ agentCtx: { tools: { restrict: () => {} }, systemPrompt: { context: () => {} } } }).host,
    settings,
    log: () => {},
    retry: false,
  })
  let port = 0
  try {
    ;({ port } = await service.start())
    const created = await call(port, 'POST', '/v1/conversations', { prompt: '先做一半' })
    assert.equal(created.status, 201)
    const id = created.body.conversation.id
    await service.dispose()

    // A restart loses the live agent; the next message resumes the session and
    // must restore the restriction or the tool comes back unanswerable.
    const restricted = []
    const contexts = []
    const resumedCtx = {
      tools: { restrict: filter => { restricted.push(filter) } },
      systemPrompt: { context: entry => { contexts.push(entry) } },
    }
    service = createInteropService({
      ctx: fakeHost({ agentCtx: resumedCtx }).host,
      settings,
      log: () => {},
      retry: false,
    })
    ;({ port } = await service.start())
    const sent = await call(port, 'POST', `/v1/conversations/${id}/messages`, { content: '继续' })
    assert.equal(sent.status, 202)
    assert.deepEqual(restricted, [{ deny: ['ask_user_question'] }])
    assert.deepEqual(contexts.map(entry => entry.name), ['mesh:interaction'])
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a workspace conversation lives below the root and keeps its prompt', async () => {
  const { service, call, settings, dir } = await serviceOf()
  try {
    const created = await call('POST', '/v1/conversations', {
      prompt: '# 大任务\n\n第一段\n\n第二段',
      title: '协调',
      workspace: 'demo',
    })
    assert.equal(created.status, 201)
    const conversation = created.body.conversation
    assert.equal(conversation.workspace, 'demo')
    assert.equal(conversation.cwd, path.join(settings.workspaceRoot, 'demo'))
    assert.equal(conversation.prompt, '# 大任务\n\n第一段\n\n第二段')
    assert.equal(existsSync(path.join(settings.workspaceRoot, 'demo')), true)

    const listed = await call('GET', '/v1/workspaces')
    assert.equal(listed.status, 200)
    assert.equal(listed.body.dir, settings.workspaceRoot)
    assert.deepEqual(listed.body.workspaces.map(item => item.name), ['demo'])

    // A name is one directory: separators are refused, not normalized.
    const escaped = await call('POST', '/v1/conversations', { prompt: 'x', workspace: '../escape' })
    assert.equal(escaped.status, 400)
    assert.match(escaped.body.error.message, /path separator/u)
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('wait returns the finished turn and then the settled state', async () => {
  const { service, fake, call, dir } = await serviceOf()
  try {
    const created = await call('POST', '/v1/conversations', { prompt: '先做这个' })
    const id = created.body.conversation.id
    const agent = fake.agents.get(id)

    // The wait is parked until a turn finishes.
    const waiting = call('POST', `/v1/conversations/${id}/wait`, { timeoutMs: 5000, since: 0 })
    await new Promise(resolve => setTimeout(resolve, 50))
    fake.emit('session/event', agent.session, {
      type: 'assistant/message',
      seq: 1,
      time: Date.now(),
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '第一轮' }] }, stream: [] },
    })
    fake.emit('session/event', agent.session, { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
    fake.emit('agent/status', { agent, status: 'idle' })

    const first = await waiting
    assert.equal(first.status, 200)
    assert.equal(first.body.state, 'done')
    assert.equal(first.body.text, '第一轮')
    assert.equal(first.body.replies.length, 1)

    const settled = await call('POST', `/v1/conversations/${id}/wait`, { timeoutMs: 1000 })
    assert.equal(settled.body.state, 'done')
    assert.equal(settled.body.settled, true)

    // A later message resumes the same session and reports progress again.
    const sent = await call('POST', `/v1/conversations/${id}/messages`, { content: '继续' })
    assert.equal(sent.status, 202)
    assert.equal(sent.body.conversation.status, 'running')
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('authentication, blank conversations and deletion follow the old API', async () => {
  const { service, fake, call, port, dir } = await serviceOf()
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/conversations`)
    assert.equal(unauthorized.status, 401)

    const blank = await call('POST', '/v1/conversations', { title: '空白' })
    assert.equal(blank.status, 201)
    assert.equal(blank.body.conversation.status, 'blank')
    assert.equal(fake.agents.get(blank.body.conversation.id).lastMessage, undefined)

    fake.emit('agent/status', { agent: fake.agents.get(blank.body.conversation.id), status: 'idle' })
    const removed = await call('DELETE', '/v1/conversations')
    assert.equal(removed.status, 200)
    assert.equal(removed.body.removed, 1)
    assert.equal((await call('GET', `/v1/conversations/${blank.body.conversation.id}`)).status, 404)
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a running conversation restores as interrupted and keeps its error', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mesh-interop-'))
  const fake = fakeHost()
  const settings = {
    bind: '127.0.0.1', port: 0, token: 't', dataDir: dir, workdir: dir,
    workspaceRoot: path.join(dir, 'workspaces'),
    stateFile: path.join(dir, 'conversations.json'), logFile: path.join(dir, 'log'),
    provider: 'deepseek-account', model: 'deepseek-flash', approve: false, preset: '', agentPreset: 'standard',
    tokenSource: 'test',
  }
  let service = createInteropService({ ctx: fake.host, settings, log: () => {}, retry: false })
  let { port } = await service.start()
  const call = async (method, url, body, base = port) => {
    const response = await fetch(`http://127.0.0.1:${base}${url}`, {
      method,
      headers: { authorization: 'Bearer t', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }
  try {
    const created = await call('POST', '/v1/conversations', { prompt: '跑很久' })
    assert.equal(created.body.conversation.status, 'running')
    // Let the debounced save publish the in-flight record, then read it before
    // dispose (a clean stop intentionally records the interruption itself).
    await new Promise(resolve => setTimeout(resolve, 700))
    const raw = JSON.parse(await readFile(settings.stateFile, 'utf8'))
    assert.equal(raw.conversations[0].status, 'running')
    await service.dispose()

    service = createInteropService({ ctx: fake.host, settings, log: () => {}, retry: false })
    ;({ port } = await service.start())
    const restored = await call('GET', `/v1/conversations/${created.body.conversation.id}`, undefined, port)
    assert.equal(restored.body.conversation.status, 'interrupted')
    assert.match(restored.body.conversation.error, /interrupted/iu)
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('approval requests are answered only for owned agents', async () => {
  const { service, fake, call, dir } = await serviceOf()
  try {
    const created = await call('POST', '/v1/conversations', { prompt: '需要审批' })
    const id = created.body.conversation.id
    const answerers = fake.host.listenersFor('approval/request')
    assert.equal(answerers.length, 1)
    assert.equal(await answerers[0]({ agent: { id }, toolName: 'bash' }, async () => 'fallback'), 'allowed-once')
    assert.equal(await answerers[0]({ agent: { id: 'someone-else' }, toolName: 'bash' }, async () => 'fallback'), 'fallback')
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('manual compaction runs through the agent preset compaction service and reports context', async () => {
  const calls = []
  const compaction = {
    async compactNow(agent) {
      calls.push(agent.id)
      return {
        compactionId: 'c-1',
        startSeq: 10,
        summarySeq: 11,
        endSeq: 12,
        summary: [{ type: 'text', text: '早先工作的摘要' }],
        shadowedSeqs: [1, 2, 3],
        shadowedTokenCount: 4321,
      }
    },
  }
  const sessionProjections = {
    snapshot: () => ({
      values: {
        contextPressure: { pressureTokens: 1000, projectedTokens: 1200, contextWindow: 128_000 },
      },
    }),
  }
  // The Web profile mounts compaction inside the Agent's isolated preset
  // group, not on the host context, so the scoped lookup is what must work.
  const { service, fake, call, dir } = await serviceOf({}, {
    services: { scoped: { compaction }, sessionProjections },
  })
  try {
    const created = await call('POST', '/v1/conversations', { title: '空白' })
    const id = created.body.conversation.id
    const agent = fake.agents.get(id)
    fake.emit('agent/status', { agent, status: 'idle' })

    const compacted = await call('POST', `/v1/conversations/${id}/compact`)
    assert.equal(compacted.status, 200)
    assert.equal(compacted.body.compacted, true)
    assert.equal(compacted.body.summary, '早先工作的摘要')
    assert.equal(compacted.body.shadowedCount, 3)
    assert.equal(compacted.body.shadowedTokenCount, 4321)
    assert.deepEqual(compacted.body.context, { usedTokens: 1200, maxTokens: 128_000, percent: 0.9 })
    assert.deepEqual(calls, [id], 'the member compacts its own live agent')

    const waited = await call('POST', `/v1/conversations/${id}/wait`, { timeoutMs: 1000 })
    assert.equal(waited.body.state, 'done')
    assert.deepEqual(waited.body.context, { usedTokens: 1200, maxTokens: 128_000, percent: 0.9 })
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('compaction refuses a running conversation and an absent compaction service', async () => {
  const compaction = { compactNow: async () => null }
  const { service, call, dir } = await serviceOf({}, { services: { scoped: { compaction } } })
  try {
    const created = await call('POST', '/v1/conversations', { prompt: '跑很久' })
    const id = created.body.conversation.id
    const busy = await call('POST', `/v1/conversations/${id}/compact`)
    assert.equal(busy.status, 409)
    assert.equal(busy.body.error.code, 'conversation_busy')
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }

  const bare = await serviceOf()
  try {
    const created = await bare.call('POST', '/v1/conversations', { title: '空白' })
    const missing = await bare.call('POST', `/v1/conversations/${created.body.conversation.id}/compact`)
    assert.equal(missing.status, 501)
    assert.equal(missing.body.error.code, 'compaction_unavailable')
  } finally {
    await bare.service.dispose()
    await rm(bare.dir, { recursive: true, force: true })
  }
})

test('settings discovery honors the deployed interop env', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mesh-interop-env-'))
  try {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const root = path.join(dir, 'shared')
    await mkdir(path.join(root, 'config'), { recursive: true })
    await mkdir(path.join(root, 'data'), { recursive: true })
    await writeFile(path.join(root, 'config', 'interop.env'), [
      'DSH_INTEROP_BIND=10.66.66.9',
      'DSH_INTEROP_PORT=9876',
      'DSH_INTEROP_TOKEN=abc',
      'DSH_INTEROP_PROVIDER=deepseek-account',
      'DSH_INTEROP_MODEL=deepseek-flash',
      'DSH_INTEROP_APPROVE=1',
      '',
    ].join('\n'))
    const oldConfig = process.env.DSH_INTEROP_CONFIG
    const oldHome = process.env.DSH_HOME
    process.env.DSH_INTEROP_CONFIG = path.join(root, 'config', 'interop.env')
    process.env.DSH_HOME = path.join(root, 'home')
    try {
      const settings = resolveInteropSettings({ interopPort: 1 })
      assert.equal(settings.bind, '10.66.66.9')
      assert.equal(settings.port, 9876)
      assert.equal(settings.token, 'abc')
      assert.equal(settings.approve, true)
      assert.equal(settings.dataDir, path.join(root, 'data'))
    } finally {
      if (oldConfig === undefined) delete process.env.DSH_INTEROP_CONFIG
      else process.env.DSH_INTEROP_CONFIG = oldConfig
      if (oldHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = oldHome
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
