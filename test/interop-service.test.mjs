import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createInteropService, resolveInteropSettings } from '../src/lib/interop-service.mjs'
import { isMemberSession } from '../src/lib/member-sessions.mjs'

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
          followupCalls: [],
          steerCalls: [],
          followup(message) {
            this.lastMessage = message
            this.followupCalls.push(message)
            this.status = 'running'
            input.followupCalls?.push?.(message)
            emit('agent/status', { agent: this, status: 'running' })
            emit('session/event', session, { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } })
          },
          steer(message) {
            this.lastMessage = message
            this.steerCalls.push(message)
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
          followupCalls: [],
          steerCalls: [],
          followup(message) {
            this.lastMessage = message
            this.followupCalls.push(message)
            this.status = 'running'
            emit('agent/status', { agent: this, status: 'running' })
            emit('session/event', session, { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } })
          },
          steer(message) {
            this.lastMessage = message
            this.steerCalls.push(message)
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

/**
 * An in-memory stand-in for the host `workspaceRegistry` service.
 *
 * It mirrors the parts the interop service touches: `resolveByPath` only looks
 * a directory up, `create` reuses an existing record for the same path without
 * changing its title, and an entity records every `attachSession` call.
 * @param {object} [options] failure knobs.
 * @returns {object} registry plus inspection helpers.
 */
function memoryWorkspaceRegistry(options = {}) {
  const records = new Map()
  const creates = []
  const attaches = []
  const archived = []
  const archiveCalls = []
  /** Register one record without going through `create`, for pre-seeded state. */
  const seed = (dir, title) => {
    const workspace = {
      path: dir,
      title,
      sessionIds: [],
      async attachSession(id) {
        if (options.attachThrows === true) throw new Error('attach failed')
        this.sessionIds.push(id)
        attaches.push([dir, id])
      },
    }
    records.set(dir, workspace)
    return workspace
  }
  const registry = {
    async resolveByPath(dir) {
      if (options.resolveThrows === true) throw new Error('resolve failed')
      return records.get(dir)
    },
    list() {
      if (options.listThrows === true) throw new Error('list failed')
      return [...records.values()]
    },
    async create(dir, title) {
      creates.push([dir, title])
      if (options.createThrows === true) throw new Error('create failed')
      const existing = records.get(dir)
      if (existing !== undefined) return existing
      return seed(dir, title)
    },
    get archivedSessionIds() { return archived },
    async archiveSession(sessionId, archiveOptions) {
      if (options.archiveThrows === true) throw new Error('archive failed')
      archiveCalls.push([sessionId, archiveOptions])
      if (!archived.includes(sessionId)) archived.push(sessionId)
    },
  }
  return { registry, records, creates, attaches, seed, archived, archiveCalls }
}

test('a conversation without workspace or cwd joins the default workspace', async () => {
  const memory = memoryWorkspaceRegistry()
  const { service, call, settings, dir } = await serviceOf({}, { services: { workspaceRegistry: memory.registry } })
  try {
    const created = await call('POST', '/v1/conversations', { prompt: '默认归属' })
    assert.equal(created.status, 201)
    const conversation = created.body.conversation
    const expected = path.join(settings.workspaceRoot, 'default-workspace')
    assert.equal(conversation.cwd, expected)
    assert.equal(conversation.workspace, 'default-workspace')
    assert.equal(existsSync(expected), true)
    assert.deepEqual(memory.creates, [[expected, 'default-workspace']])
    assert.deepEqual(memory.attaches, [[expected, conversation.id]])
    assert.equal(memory.records.get(expected).title, 'default-workspace')
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('archiving a conversation stops it, hides the session and refuses new messages', async () => {
  const memory = memoryWorkspaceRegistry()
  const { service, call, dir } = await serviceOf({}, { services: { workspaceRegistry: memory.registry } })
  try {
    const created = await call('POST', '/v1/conversations', { prompt: '归档我' })
    assert.equal(created.status, 201)
    const id = created.body.conversation.id

    const archived = await call('POST', `/v1/conversations/${id}/archive`)
    assert.equal(archived.status, 200)
    assert.equal(archived.body.ok, true)
    assert.equal(archived.body.archived, true)
    assert.equal(archived.body.already, false)
    assert.equal(archived.body.conversation.archived, true)
    assert.equal(archived.body.conversation.status, 'archived')
    assert.deepEqual(memory.archiveCalls, [[id, { stopActivity: true }]])
    assert.deepEqual(memory.archived, [id])

    const again = await call('POST', `/v1/conversations/${id}/archive`)
    assert.equal(again.status, 200)
    assert.equal(again.body.already, true)
    assert.equal(memory.archiveCalls.length, 1, 'a second archive must not ask the registry again')

    const sent = await call('POST', `/v1/conversations/${id}/messages`, { content: '还要继续' })
    assert.equal(sent.status, 409)
    assert.equal(sent.body.error.code, 'conversation_archived')

    const waited = await call('POST', `/v1/conversations/${id}/wait`, { timeoutMs: 1000 })
    assert.equal(waited.status, 200)
    assert.equal(waited.body.state, 'archived')
    assert.equal(waited.body.archived, true)

    const read = await call('GET', `/v1/conversations/${id}`)
    assert.equal(read.status, 200)
    assert.equal(read.body.conversation.archived, true)
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('unarchiving on the member lets the conversation receive messages again', async () => {
  const memory = memoryWorkspaceRegistry()
  const { service, call, dir } = await serviceOf({}, { services: { workspaceRegistry: memory.registry } })
  try {
    const created = await call('POST', '/v1/conversations', { prompt: '先归档再恢复' })
    const id = created.body.conversation.id
    await call('POST', `/v1/conversations/${id}/archive`)
    const refused = await call('POST', `/v1/conversations/${id}/messages`, { content: '归档中' })
    assert.equal(refused.status, 409)

    // The user unarchives the session in the member Web UI: the registry is
    // the source of truth, so a stale local flag must not block the message.
    memory.archived.splice(0)
    const resumed = await call('POST', `/v1/conversations/${id}/messages`, { content: '恢复' })
    assert.equal(resumed.status, 202)
    assert.equal(resumed.body.conversation.archived, false)

    const waited = await call('POST', `/v1/conversations/${id}/wait`, { timeoutMs: 1000 })
    assert.notEqual(waited.body.state, 'archived')
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a member without a workspace registry reports archive as unavailable', async () => {
  const { service, call, dir } = await serviceOf({}, {})
  try {
    const created = await call('POST', '/v1/conversations', { prompt: '没有 registry' })
    const id = created.body.conversation.id
    const archived = await call('POST', `/v1/conversations/${id}/archive`)
    assert.equal(archived.status, 501)
    assert.equal(archived.body.error.code, 'archive_unavailable')
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('an existing default workspace is reused instead of creating a second one', async () => {
  const memory = memoryWorkspaceRegistry()
  const { service, call, dir } = await serviceOf({}, { services: { workspaceRegistry: memory.registry } })
  try {
    // DSH's own first-use default workspace lives outside the mesh root.
    const documents = path.join(dir, 'Documents', 'deepseek-harness', 'default-workspace')
    mkdirSync(documents, { recursive: true })
    const existing = memory.seed(documents, 'default-workspace')

    const created = await call('POST', '/v1/conversations', { prompt: '复用默认' })
    assert.equal(created.status, 201)
    const conversation = created.body.conversation
    assert.equal(conversation.cwd, documents)
    assert.equal(conversation.workspace, 'default-workspace')
    assert.deepEqual(memory.creates, [])
    assert.deepEqual(memory.attaches, [[documents, conversation.id]])
    assert.deepEqual(existing.sessionIds, [conversation.id])
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('an explicit default-workspace request reuses the existing record too', async () => {
  const memory = memoryWorkspaceRegistry()
  const { service, call, dir } = await serviceOf({}, { services: { workspaceRegistry: memory.registry } })
  try {
    // `call_member` sends this exact name when the caller has no workspace.
    const documents = path.join(dir, 'Documents', 'deepseek-harness', 'default-workspace')
    mkdirSync(documents, { recursive: true })
    memory.seed(documents, 'default-workspace')

    const created = await call('POST', '/v1/conversations', { prompt: '显式默认', workspace: 'default-workspace' })
    assert.equal(created.status, 201)
    const conversation = created.body.conversation
    assert.equal(conversation.cwd, documents)
    assert.equal(conversation.workspace, 'default-workspace')
    assert.deepEqual(memory.creates, [])
    assert.deepEqual(memory.attaches, [[documents, conversation.id]])
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a broken default record does not hide a later valid one', async () => {
  const memory = memoryWorkspaceRegistry()
  const { service, call, dir } = await serviceOf({}, { services: { workspaceRegistry: memory.registry } })
  try {
    memory.seed(path.join(dir, 'gone', 'default-workspace'), 'default-workspace')
    const documents = path.join(dir, 'Documents', 'deepseek-harness', 'default-workspace')
    mkdirSync(documents, { recursive: true })
    memory.seed(documents, 'default-workspace')

    const created = await call('POST', '/v1/conversations', { prompt: '跳过损坏记录' })
    assert.equal(created.status, 201)
    assert.equal(created.body.conversation.cwd, documents)
    assert.deepEqual(memory.creates, [])
    assert.deepEqual(memory.attaches, [[documents, created.body.conversation.id]])
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a root cwd still gets a non-empty workspace title', async () => {
  const memory = memoryWorkspaceRegistry()
  const { service, call, dir } = await serviceOf({}, { services: { workspaceRegistry: memory.registry } })
  try {
    const root = path.resolve('/')
    const created = await call('POST', '/v1/conversations', { prompt: '根目录', cwd: root })
    assert.equal(created.status, 201)
    const conversation = created.body.conversation
    assert.equal(conversation.cwd, root)
    assert.equal(conversation.workspace, '')
    // path.basename('/') is '', which would register an untitled workspace.
    assert.deepEqual(memory.creates, [[root, 'default-workspace']])
    assert.deepEqual(memory.attaches, [[root, conversation.id]])
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a named workspace is created below the root and its session attached', async () => {
  const memory = memoryWorkspaceRegistry()
  const { service, call, settings, dir } = await serviceOf({}, { services: { workspaceRegistry: memory.registry } })
  try {
    const created = await call('POST', '/v1/conversations', { prompt: '同名工作区', workspace: 'dsh-mesh' })
    assert.equal(created.status, 201)
    const conversation = created.body.conversation
    const expected = path.join(settings.workspaceRoot, 'dsh-mesh')
    assert.equal(conversation.cwd, expected)
    assert.equal(conversation.workspace, 'dsh-mesh')
    assert.deepEqual(memory.creates, [[expected, 'dsh-mesh']])
    assert.deepEqual(memory.attaches, [[expected, conversation.id]])
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('an existing workspace record is reused instead of created twice', async () => {
  const memory = memoryWorkspaceRegistry()
  const { service, call, settings, dir } = await serviceOf({}, { services: { workspaceRegistry: memory.registry } })
  try {
    const expected = path.join(settings.workspaceRoot, 'reused')
    const existing = {
      path: expected,
      title: '已有名字',
      sessionIds: [],
      async attachSession(id) { this.sessionIds.push(id); memory.attaches.push([expected, id]) },
    }
    memory.records.set(expected, existing)

    const created = await call('POST', '/v1/conversations', { prompt: '复用', workspace: 'reused' })
    assert.equal(created.status, 201)
    assert.deepEqual(memory.creates, [])
    assert.deepEqual(memory.attaches, [[expected, created.body.conversation.id]])
    assert.deepEqual(existing.sessionIds, [created.body.conversation.id])
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a host without a workspace registry still creates the conversation', async () => {
  const { service, call, fake, dir } = await serviceOf()
  try {
    const created = await call('POST', '/v1/conversations', { prompt: '没有注册表' })
    assert.equal(created.status, 201)
    assert.ok(fake.agents.get(created.body.conversation.id))
    assert.equal(created.body.conversation.workspace, 'default-workspace')
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failing attach never fails the conversation', async () => {
  const memory = memoryWorkspaceRegistry({ attachThrows: true })
  const { service, call, fake, dir } = await serviceOf({}, { services: { workspaceRegistry: memory.registry } })
  try {
    const created = await call('POST', '/v1/conversations', { prompt: '挂载失败' })
    assert.equal(created.status, 201)
    assert.ok(fake.agents.get(created.body.conversation.id))
    assert.equal(created.body.conversation.workspace, 'default-workspace')
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failing registry lookup or create never fails the conversation', async () => {
  for (const options of [{ resolveThrows: true }, { createThrows: true }]) {
    const memory = memoryWorkspaceRegistry(options)
    const { service, call, fake, dir } = await serviceOf({}, { services: { workspaceRegistry: memory.registry } })
    try {
      const created = await call('POST', '/v1/conversations', { prompt: '注册表失败' })
      assert.equal(created.status, 201)
      assert.ok(fake.agents.get(created.body.conversation.id))
      assert.equal(created.body.conversation.workspace, 'default-workspace')
    } finally {
      await service.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  }
})

test('an explicit cwd keeps its own meaning and carries no workspace name', async () => {
  const memory = memoryWorkspaceRegistry()
  const { service, call, dir } = await serviceOf({}, { services: { workspaceRegistry: memory.registry } })
  try {
    const explicit = path.join(dir, 'somewhere')
    const created = await call('POST', '/v1/conversations', { prompt: '显式目录', cwd: explicit })
    assert.equal(created.status, 201)
    assert.equal(created.body.conversation.cwd, explicit)
    assert.equal(created.body.conversation.workspace, '')
    assert.deepEqual(memory.creates, [[explicit, 'somewhere']])
    assert.deepEqual(memory.attaches, [[explicit, created.body.conversation.id]])
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

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

test('a new conversation denies the question tool and ignores mesh facts for context', async () => {
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
    assert.deepEqual(contexts.map(entry => entry.name), ['mesh:interaction', 'mesh:subagent'])
    assert.match(contexts[0].text, /禁用了 ask_user_question/u)
    assert.match(contexts[1].text, /35%/u)
    assert.match(contexts[1].text, /新的子代理/u)
    assert.equal(contexts[0].interpolate, false)
    assert.equal(contexts[1].interpolate, false)
    // Proxy/token facts now travel in the prompt, never in system context.
    assert.equal(contexts.some(entry => /ghp_test_token|代理端口/.test(entry.text)), false)
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
    assert.deepEqual(contexts.map(entry => entry.name), ['mesh:interaction', 'mesh:subagent'])
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
    assert.deepEqual(contexts.map(entry => entry.name), ['mesh:interaction', 'mesh:subagent'])
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

    // A conversation that had finished turns before the restart carries a
    // non-zero cursor; the restored record must keep it so callers can still
    // use their `since`.
    const saved = JSON.parse(await readFile(settings.stateFile, 'utf8'))
    saved.conversations[0].replySeq = 5
    await writeFile(settings.stateFile, `${JSON.stringify(saved, null, 2)}\n`)

    service = createInteropService({ ctx: fake.host, settings, log: () => {}, retry: false })
    ;({ port } = await service.start())
    const restored = await call('GET', `/v1/conversations/${created.body.conversation.id}`, undefined, port)
    assert.equal(restored.body.conversation.status, 'interrupted')
    assert.match(restored.body.conversation.error, /interrupted/iu)
    assert.equal(restored.body.conversation.replySeq, 5, 'the reply cursor survives the restart')
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

    // The caller reads the conversation before delivering so it can decide on
    // a forced compaction; the read carries the same projection as a wait.
    const read = await call('GET', `/v1/conversations/${id}`)
    assert.equal(read.status, 200)
    assert.deepEqual(read.body.context, { usedTokens: 1200, maxTokens: 128_000, percent: 0.9 })
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

test('a message to a running conversation is steered, an idle one is a followup', async () => {
  const { service, fake, call, dir } = await serviceOf()
  try {
    const created = await call('POST', '/v1/conversations', { prompt: '先做一件事' })
    const id = created.body.conversation.id
    const agent = fake.agents.get(id)
    assert.ok(agent)
    const followupsBefore = agent.followupCalls.length
    agent.status = 'running'
    const sent = await call('POST', `/v1/conversations/${id}/messages`, { content: '补充一句' })
    assert.equal(sent.status, 202)
    assert.equal(sent.body.receipt.steered, true)
    assert.equal(sent.body.receipt.delivery, 'steer')
    assert.equal(agent.steerCalls.length, 1)
    assert.equal(agent.steerCalls[0].content[0].text, '补充一句')
    assert.equal(agent.followupCalls.length, followupsBefore, 'a running conversation must not queue a new turn')

    agent.status = 'idle'
    const second = await call('POST', `/v1/conversations/${id}/messages`, { content: '继续' })
    assert.equal(second.status, 202)
    assert.equal(second.body.receipt.steered, false)
    assert.equal(second.body.receipt.delivery, 'followup')
    assert.equal(agent.followupCalls.length, followupsBefore + 1)
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a running conversation in a git workspace blocks a second one unless forced', async () => {
  const { service, call, dir } = await serviceOf()
  try {
    const repo = path.join(dir, 'workspaces', 'repo')
    mkdirSync(path.join(repo, '.git'), { recursive: true })
    const first = await call('POST', '/v1/conversations', { prompt: '第一个任务', workspace: 'repo' })
    assert.equal(first.status, 201)
    const firstId = first.body.conversation.id

    const blocked = await call('POST', '/v1/conversations', { prompt: '第二个任务', workspace: 'repo' })
    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.error.code, 'workspace_busy_git')
    assert.match(blocked.body.error.message, /已有进行中的对话/u)
    assert.match(blocked.body.error.message, /force: true/u)
    assert.deepEqual(blocked.body.error.detail.conversationIds, [firstId])
    assert.equal(blocked.body.error.detail.workspace, 'repo')
    assert.equal(service.conversations.size, 1, 'a refused create must not register a conversation')

    const forced = await call('POST', '/v1/conversations', {
      prompt: '确认并发',
      workspace: 'repo',
      forceWorkspace: true,
    })
    assert.equal(forced.status, 201)

    // Continuing an existing conversation never passes through the create guard.
    const sent = await call('POST', `/v1/conversations/${firstId}/messages`, { content: '继续第一个' })
    assert.equal(sent.status, 202)
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a .git file (linked worktree) also blocks, while a non-git directory stays concurrent', async () => {
  const { service, call, dir } = await serviceOf()
  try {
    const linked = path.join(dir, 'workspaces', 'linked')
    mkdirSync(linked, { recursive: true })
    writeFileSync(path.join(linked, '.git'), 'gitdir: /elsewhere/.git/worktrees/linked\n')
    const first = await call('POST', '/v1/conversations', { prompt: '链接工作树一', workspace: 'linked' })
    assert.equal(first.status, 201)
    const blocked = await call('POST', '/v1/conversations', { prompt: '链接工作树二', workspace: 'linked' })
    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.error.code, 'workspace_busy_git')

    const scratch = path.join(dir, 'workspaces', 'scratch')
    mkdirSync(scratch, { recursive: true })
    const one = await call('POST', '/v1/conversations', { prompt: '非 git 一', workspace: 'scratch' })
    const two = await call('POST', '/v1/conversations', { prompt: '非 git 二', workspace: 'scratch' })
    assert.equal(one.status, 201)
    assert.equal(two.status, 201, 'a directory without .git may host concurrent conversations')
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})


test('interop marks created sessions as member sessions and clears them when removed', async () => {
  const { service, fake, call, dir } = await serviceOf()
  try {
    const created = await call('POST', '/v1/conversations', { prompt: '成员会话' })
    assert.equal(created.status, 201)
    const id = created.body.conversation.id
    assert.equal(isMemberSession(id), true)
    const agent = fake.agents.get(id)
    fake.emit('session/event', agent.session, {
      type: 'turn/end',
      seq: 1,
      time: Date.now(),
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    fake.emit('agent/status', { agent, status: 'idle' })
    const cleared = await call('DELETE', '/v1/conversations')
    assert.equal(cleared.body.removed, 1)
    assert.equal(isMemberSession(id), false)
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
