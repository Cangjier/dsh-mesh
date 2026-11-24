import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MeshService } from '../src/lib/service.mjs'
import { registerTools } from '../src/lib/tools.mjs'

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
    await service.setMemberScope('main-1', { scope: '主对话验收', keep: false })

    const saved = JSON.parse(await readFile(path.join(dataDir, 'member-scopes.json'), 'utf8'))
    assert.deepEqual(saved, {
      'conv-1': { identity: '测试', scope: '插件开发' },
      'main-1': { scope: '主对话验收', keep: false },
    })

    const cleared = await service.setMemberScope('conv-1', { identity: '' })
    assert.deepEqual(cleared.scope, { scope: '插件开发' })
    const removed = await service.setMemberScope('conv-1', { scope: '' })
    assert.equal(removed.scope, null, 'the record disappears when nothing remains')

    await assert.rejects(service.setMemberScope('', {}), /conversation id is required/u)
    await assert.rejects(service.setMemberScope('x', { identity: 42 }), /identity must be a string/u)
    await assert.rejects(service.setMemberScope('x', { scope: null }), /scope must be a string/u)
    await assert.rejects(service.setMemberScope('x', { keep: 'yes' }), /keep must be a boolean/u)
    await assert.rejects(service.setMemberScope('x', { identity: 'a'.repeat(41) }), /identity is too long: 41 > 40/u)
    await assert.rejects(service.setMemberScope('x', { scope: 'b'.repeat(121) }), /scope is too long: 121 > 120/u)

    const restarted = new MeshService({ dataDir, config: {}, log: () => {} })
    assert.deepEqual((await restarted.memberScopes())['main-1'], { scope: '主对话验收', keep: false })
    await writeFile(path.join(dataDir, 'member-scopes.json'), '{not json', 'utf8')
    assert.deepEqual(await service.memberScopes(), {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('set_member_scope sets self by default, defaults keep on, and preserves keep=false', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-scope-self-'))
  const dataDir = path.join(dir, 'mesh')
  let service
  try {
    service = new MeshService({ dataDir, config: {}, log: () => {} })
    const tools = register(service)
    const set = tools.find(tool => tool.name === 'set_member_scope')
    const first = await set.execute({ identity: '开发', scope: '插件开发' }, { agent: mainAgent })
    assert.equal(first.ok, true)
    assert.deepEqual(await service.memberScope('main-1'), { identity: '开发', scope: '插件开发', keep: true })
    assert.match(first.text, /已设置自身（会话 main-1）/u)
    assert.match(first.text, /身份：开发/u)
    assert.match(first.text, /工作范围：插件开发/u)
    assert.match(first.text, /保持目标：开启（只对主对话生效）/u)

    const viaSelf = await set.execute({ conversationId: 'self', identity: '测试' }, { agent: mainAgent })
    assert.match(viaSelf.text, /已设置自身/u)
    const viaLocal = await set.execute({ conversationId: 'local', scope: '验收' }, { agent: mainAgent })
    assert.match(viaLocal.text, /已设置自身/u)
    const viaSession = await set.execute({ conversationId: 'main-1', keep: false }, { agent: mainAgent })
    assert.match(viaSession.text, /保持目标：关闭/u)

    const partial = await set.execute({ identity: '网关' }, { agent: mainAgent })
    assert.deepEqual(await service.memberScope('main-1'), {
      identity: '网关',
      scope: '验收',
      keep: false,
    }, 'identity-only must not reset an existing keep=false')
    assert.match(partial.text, /保持目标：关闭/u)
  } finally {
    await service?.memberTasks.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('set_member_scope updates a tracked member conversation and ignores keep', async () => {
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
      { conversationId: 'conv-9', identity: '测试', scope: '跨平台验收', keep: true },
      { agent: mainAgent },
    )
    assert.equal(result.ok, true)
    assert.deepEqual(await service.memberScope('conv-9'), { identity: '测试', scope: '跨平台验收' })
    assert.match(result.text, /已设置成员会话 conv-9/u)
    assert.match(result.text, /keep 只对主对话自身生效，设置成员会话时已忽略/u)
    assert.doesNotMatch(result.text, /保持目标：/u)
    assert.deepEqual(service.memberTasks.tasks.get('task-1').profile, {
      name: 'B',
      identity: '测试',
      scope: '跨平台验收',
    })
    const savedTask = JSON.parse(await readFile(path.join(dataDir, 'member-tasks', 'task-1.json'), 'utf8'))
    assert.deepEqual(savedTask.profile, { name: 'B', identity: '测试', scope: '跨平台验收' })

    const partial = await set.execute({ conversationId: 'conv-9', identity: '开发' }, { agent: mainAgent })
    assert.deepEqual(await service.memberScope('conv-9'), { identity: '开发', scope: '跨平台验收' })
    assert.match(partial.text, /身份：开发/u)
    assert.match(partial.text, /工作范围：跨平台验收/u)

    const cleared = await set.execute({ conversationId: 'conv-9', identity: '', scope: '' }, { agent: mainAgent })
    assert.equal(cleared.data.scope, null)
    assert.match(cleared.text, /身份：未设置/u)
    assert.match(cleared.text, /工作范围：未设置/u)
    assert.equal(service.memberTasks.tasks.get('task-1').profile, null)
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

    await assert.rejects(() => set.execute({}, { agent: mainAgent }), /identity, scope, or keep is required/u)
    await assert.rejects(
      () => set.execute({ conversationId: 'conv-other', keep: false }, { agent: mainAgent }),
      /keep only applies to the current session/u,
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
    assert.deepEqual(member.created[0].mesh.profile, result.data.profile)
    assert.equal(member.created[0].prompt, '实现功能', 'the scope rides in mesh, not the prompt')
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
    assert.equal('profile' in member.created[0].mesh, false)
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
