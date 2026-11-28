import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MemberTaskService } from '../src/lib/member-tasks.mjs'
import { registerTools } from '../src/lib/tools.mjs'

/**
 * Start a fake member interop endpoint. It creates one conversation and answers
 * the first wait as completed with a known final text.
 * @returns {Promise<{server: import('node:http').Server, port: number}>} endpoint.
 */
async function fakeMember() {
  let conversations = 0
  const created = []
  const server = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    if (request.headers.authorization !== 'Bearer test-token') {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'bad token' } }))
      return
    }
    if (request.method === 'GET' && request.url === '/v1/conversations') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        ok: true,
        conversations: [
          { id: 'conv-1', title: 'render the report', status: 'idle', turns: 2, updatedAt: '2026-11-12T06:00:00.000Z', initiator: { id: 'local', name: 'member-a', source: 'call_member' } },
          { id: 'conv-2', title: 'check the logs', status: 'running', turns: 1, updatedAt: '2026-11-12T06:05:00.000Z', initiator: null },
        ],
      }))
      return
    }
    if (request.method === 'POST' && request.url === '/v1/conversations') {
      created.push(body === '' ? {} : JSON.parse(body))
      conversations += 1
      response.writeHead(201, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, conversation: { id: `conv-${conversations}`, status: 'running' } }))
      return
    }
    if (request.method === 'POST' && request.url === '/v1/conversations/conv-1/wait') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        ok: true,
        timedOut: false,
        conversation: { id: 'conv-1', status: 'idle', lastText: 'MEMBER DONE', error: null },
      }))
      return
    }
    if (request.method === 'GET' && request.url === '/v1/system?sampleMs=200') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        ok: true,
        system: { hostname: 'member-b', cpu: { cores: 4, usagePercent: 1 }, memory: { usedPercent: 2 }, disks: [] },
      }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'unknown' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { server, port: address.port, created }
}

/**
 * Run one delegation far enough to capture what it POSTs to the member.
 * @param {object} [options] knobs: session, registry, start overrides.
 * @returns {Promise<{created: object[]}>} the captured create bodies.
 */
async function delegationPayload(options = {}) {
  const { server, port, created } = await fakeMember()
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'member-task-workspace-'))
  const agent = {
    id: 'session-A',
    session: options.session ?? { id: 'session-A' },
    followup: () => {},
  }
  const ctx = {
    get: (name) => {
      if (name === 'agents') return { get: () => undefined }
      if (name === 'workspaceRegistry') return options.registry
      return undefined
    },
  }
  const service = {
    config: { interopPort: port, interopToken: 'test-token', interopUseGatePassword: false },
    dataDir,
    repositoryRoot: process.cwd(),
    members: async () => ({ local: { id: 'local', name: 'member-b', ip: '127.0.0.1' }, members: [] }),
  }
  const tasks = new MemberTaskService({ ctx, service, dataDir, log: () => {} })
  let task
  try {
    task = await tasks.start({
      member: '127.0.0.1',
      prompt: 'do the member job',
      agent,
      notify: false,
      ...options.start,
    })
  } finally {
    await tasks.dispose()
    await new Promise(resolve => server.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  }
  return { created, task }
}

test('a delegation from a workspace session carries that workspace title', async () => {
  const cwd = path.join(os.tmpdir(), 'caller-dsh-mesh')
  const { created, task } = await delegationPayload({
    session: { id: 'session-A', header: { cwd } },
    registry: {
      async resolveByPath(dir) {
        return dir === cwd ? { title: 'dsh-mesh' } : undefined
      },
    },
  })
  // The title of the caller's workspace becomes the create request's
  // workspace; the member resolves it below its own workspace root.
  assert.equal(created[0].workspace, 'dsh-mesh')
  assert.equal('cwd' in created[0], false)
  assert.equal(task.workspace, 'dsh-mesh')
})

test('a delegation without a resolvable workspace falls back to the default one', async () => {
  // No workspace/cwd and no registry at all.
  const absent = await delegationPayload({ session: { id: 'session-A', header: { cwd: '/work/unknown' } } })
  assert.equal(absent.created[0].workspace, 'default-workspace')

  // A registry that knows the directory under another spelling still misses;
  // `meta.cwd` is accepted as the header fallback.
  const missed = await delegationPayload({
    session: { id: 'session-A', meta: { cwd: '/work/other' } },
    registry: { async resolveByPath() { return undefined } },
  })
  assert.equal(missed.created[0].workspace, 'default-workspace')
})

test('an unusable workspace title falls back to the default one', async () => {
  const cwd = '/work/bad-title'
  const { created } = await delegationPayload({
    session: { id: 'session-A', header: { cwd } },
    registry: { async resolveByPath() { return { title: 'bad/name' } } },
  })
  assert.equal(created[0].workspace, 'default-workspace')
})

test('an auto-derived title with a Windows-invalid name falls back to the default one', async () => {
  const cwd = '/work/portable-name'
  // ':' is legal in a Linux workspace title but unusable as a directory name
  // on a Windows member, so the derived name is refused before it is sent.
  const derived = await delegationPayload({
    session: { id: 'session-A', header: { cwd } },
    registry: { async resolveByPath() { return { title: 'parts: one' } } },
  })
  assert.equal(derived.created[0].workspace, 'default-workspace')

  // An explicit workspace argument keeps the interop's own rule set.
  const explicit = await delegationPayload({ start: { workspace: 'parts: one' } })
  assert.equal(explicit.created[0].workspace, 'parts: one')
})

test('an explicit cwd keeps its own meaning and carries no workspace', async () => {
  const { created, task } = await delegationPayload({
    session: { id: 'session-A', header: { cwd: '/work/dsh-mesh' } },
    registry: { async resolveByPath() { return { title: 'dsh-mesh' } } },
    start: { cwd: '/srv/task-dir' },
  })
  assert.equal(created[0].cwd, '/srv/task-dir')
  assert.equal('workspace' in created[0], false)
  assert.equal(task.workspace, 'task-dir')
})

test('a completed member conversation notifies the originating agent', async () => {
  const { server, port, created } = await fakeMember()
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'member-task-'))
  const messages = []
  const agent = {
    id: 'session-A',
    session: { id: 'session-A' },
    followup: message => { messages.push(message) },
  }
  const service = {
    config: { interopPort: port, interopToken: 'test-token', interopUseGatePassword: false },
    dataDir,
    repositoryRoot: process.cwd(),
    members: async () => ({
      local: { id: 'local', name: 'member-b', ip: '127.0.0.1' },
      members: [],
    }),
    // The latest positioning, changed after the task started.
    memberScope: async () => ({ identity: '前端开发1', scope: 'web/**' }),
  }
  const ctx = {
    get: name => name === 'agents' ? { get: id => id === 'session-A' ? agent : undefined } : undefined,
  }
  const tasks = new MemberTaskService({ ctx, service, dataDir, log: () => {} })
  try {
    const task = await tasks.start({
      member: '127.0.0.1',
      prompt: 'do the member job',
      workspace: 'demo',
      agent,
      notify: true,
    })
    // A continuation moved the conversation on: the completion notice must
    // use this delivery, not the creation prompt.
    task.lastPrompt = '【成员身份】你的身份：前端开发1；负责范围：web/**。\n最新的前端任务'
    // The workspace name crosses the interop boundary as-is; the member
    // resolves it below its own ~/.dsh/workspaces.
    assert.equal(created[0].workspace, 'demo')
    assert.equal('cwd' in created[0], false)
    const deadline = Date.now() + 10_000
    while (messages.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const final = await tasks.status(task.id)
    assert.equal(final.status, 'completed')
    assert.equal(final.notified, true)
    assert.equal(final.lastText, 'MEMBER DONE')
    assert.equal(messages.length, 1)
    assert.equal(messages[0].role, 'user')
    assert.match(messages[0].content[0].text, /^\[成员任务完成\]\n成员：前端开发1\n标识符：member-b \(127\.0\.0\.1\) 的对话 conv-1\n\nMEMBER DONE$/u)
    assert.doesNotMatch(messages[0].content[0].text, /do the member job/u)
    assert.doesNotMatch(messages[0].content[0].text, /最新的前端任务/u)
  } finally {
    await tasks.dispose()
    await new Promise(resolve => server.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a finished task nobody waits for is delivered to the calling conversation', async () => {
  const { server, port } = await fakeMember()
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'member-task-'))
  const messages = []
  const agent = {
    id: 'session-A',
    session: { id: 'session-A' },
    followup: message => { messages.push(message) },
  }
  const service = {
    config: { interopPort: port, interopToken: 'test-token', interopUseGatePassword: false },
    dataDir,
    repositoryRoot: process.cwd(),
    members: async () => ({ local: { id: 'local', name: 'member-b', ip: '127.0.0.1' }, members: [] }),
  }
  const ctx = { get: name => name === 'agents' ? { get: id => id === 'session-A' ? agent : undefined } : undefined }
  const tasks = new MemberTaskService({ ctx, service, dataDir, log: () => {} })
  const started = Date.now()
  try {
    await tasks.start({ member: '127.0.0.1', prompt: 'do the member job', agent, notify: true })
    // The model may still issue one more wait_member: the result must not be
    // delivered while that call could take it.
    await new Promise(resolve => setTimeout(resolve, 1_500))
    assert.equal(messages.length, 0, 'delivery must wait out the grace window')
    const deadline = Date.now() + 10_000
    while (messages.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(messages.length, 1)
    assert.match(messages[0].content[0].text, /成员任务完成/u)
    assert.match(messages[0].content[0].text, /MEMBER DONE/u)
    assert.ok(Date.now() - started >= 2_900, 'the 3 second grace window must elapse first')
  } finally {
    await tasks.dispose()
    await new Promise(resolve => server.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a wait_member that takes the result suppresses the delayed delivery', async () => {
  const { server, port } = await fakeMember()
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'member-task-'))
  const messages = []
  const agent = {
    id: 'session-A',
    session: { id: 'session-A' },
    followup: message => { messages.push(message) },
  }
  const service = {
    config: { interopPort: port, interopToken: 'test-token', interopUseGatePassword: false },
    dataDir,
    repositoryRoot: process.cwd(),
    members: async () => ({ local: { id: 'local', name: 'member-b', ip: '127.0.0.1' }, members: [] }),
  }
  const ctx = { get: name => name === 'agents' ? { get: id => id === 'session-A' ? agent : undefined } : undefined }
  const tasks = new MemberTaskService({ ctx, service, dataDir, log: () => {} })
  try {
    const task = await tasks.start({ member: '127.0.0.1', prompt: 'do the member job', agent, notify: true })
    const waited = await tasks.wait(task.conversationId, { timeoutMs: 10_000 })
    assert.equal(waited.done, true)
    // Give the post-completion delivery timer every chance to fire.
    await new Promise(resolve => setTimeout(resolve, 3_500))
    const final = await tasks.status(task.id)
    assert.equal(final.terminalDelivered, true)
    assert.equal(final.notified, false)
    assert.equal(messages.length, 0, 'a consumed result must not be delivered twice')
  } finally {
    await tasks.dispose()
    await new Promise(resolve => server.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  }
})

/**
 * Fake member that answers a wait with one finished reply.
 * @param {string} text reply text.
 * @param {string} conversationId conversation id.
 * @returns {Promise<{server: import('node:http').Server, port: number}>} endpoint.
 */
async function memberWithResult(text, conversationId) {
  const server = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    void body
    if (request.method === 'POST' && request.url === `/v1/conversations/${conversationId}/wait`) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        ok: true,
        timedOut: false,
        state: 'done',
        settled: true,
        text,
        turn: 1,
        seq: 1,
        replies: [{ seq: 1, turn: 1, text }],
        conversation: { id: conversationId, status: 'idle', turns: 1, lastText: text, replySeq: 1 },
      }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'unknown' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

/**
 * One persisted task record, as a previous plugin process would have left it.
 * @param {object} overrides fields to override.
 * @returns {object} record.
 */
function persistedTask(overrides = {}) {
  const now = new Date().toISOString()
  return {
    id: 'member-resume-test',
    member: 'member-b',
    memberIp: '127.0.0.1',
    baseUrl: 'http://127.0.0.1:1',
    conversationId: 'conv-recover',
    prompt: 'recover this task',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    lastText: '',
    error: null,
    interrupted: false,
    attempts: 0,
    turns: 0,
    replies: [],
    replySeq: 0,
    deliveredSeq: 0,
    terminalDelivered: false,
    notify: true,
    notified: false,
    notifiedAt: null,
    notifyError: null,
    originAgentId: 'session-A',
    originSessionId: 'session-A',
    context: null,
    lastCompaction: null,
    adopted: false,
    ...overrides,
  }
}

/**
 * Boot one service against a persisted task record and wait for its delivery.
 * @param {object} record persisted task record.
 * @param {string} text expected reply text.
 * @returns {Promise<{task: object, messages: object[]}>} final task and followups.
 */
async function recoverPersisted(record, text) {
  const { server, port } = await memberWithResult(text, record.conversationId)
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'member-resume-'))
  const taskRoot = path.join(dataDir, 'member-tasks')
  await mkdir(taskRoot, { recursive: true })
  await writeFile(path.join(taskRoot, `${record.id}.json`), `${JSON.stringify({ ...record, baseUrl: `http://127.0.0.1:${port}` }, null, 2)}\n`)
  const messages = []
  const agent = { id: 'session-A', session: { id: 'session-A' }, followup: message => { messages.push(message) } }
  const service = {
    config: { interopPort: port, interopToken: 'test-token', interopUseGatePassword: false },
    dataDir,
    repositoryRoot: process.cwd(),
    members: async () => ({ local: { id: 'local', name: 'member-b', ip: '127.0.0.1' }, members: [] }),
  }
  const ctx = { get: name => name === 'agents' ? { get: id => id === 'session-A' ? agent : undefined } : undefined }
  const tasks = new MemberTaskService({ ctx, service, dataDir, log: () => {} })
  try {
    await tasks.init()
    const deadline = Date.now() + 12_000
    while (messages.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const task = await tasks.status(record.id)
    return { task, messages }
  } finally {
    await tasks.dispose()
    await new Promise(resolve => server.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  }
}

test('a running task is re-attached after a plugin restart and its result delivered', async () => {
  const { task, messages } = await recoverPersisted(persistedTask(), 'RECOVERED RESULT')
  assert.equal(task.status, 'completed')
  assert.equal(task.lastText, 'RECOVERED RESULT')
  assert.equal(task.notified, true)
  assert.equal(messages.length, 1)
  assert.match(messages[0].content[0].text, /成员任务完成/u)
  assert.match(messages[0].content[0].text, /RECOVERED RESULT/u)
})

test('a task a graceful stop marked resumable is re-attached on the next start', async () => {
  const { task, messages } = await recoverPersisted(
    persistedTask({
      status: 'interrupted',
      error: 'the plugin stopped before the member conversation completed',
      resumable: true,
    }),
    'RESUMED RESULT',
  )
  assert.equal(task.status, 'completed')
  assert.equal(task.lastText, 'RESUMED RESULT')
  assert.equal(task.notified, true)
  assert.equal(messages.length, 1)
  assert.match(messages[0].content[0].text, /RESUMED RESULT/u)
})

test('an accepted reply is recorded as this round\'s product-stage participation', async () => {
  const conversationId = 'conv-stage'
  const { server, port } = await memberWithResult('STAGE RESULT', conversationId)
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'member-stage-'))
  const taskRoot = path.join(dataDir, 'member-tasks')
  await mkdir(taskRoot, { recursive: true })
  await writeFile(path.join(taskRoot, 'member-stage.json'), `${JSON.stringify({
    ...persistedTask({ id: 'member-stage', conversationId, originCwd: '/root/ws/project' }),
    baseUrl: `http://127.0.0.1:${port}`,
  }, null, 2)}\n`)
  const notes = []
  const agent = { id: 'session-A', session: { id: 'session-A', header: { cwd: '/root/ws/project' } }, followup: () => {} }
  const service = {
    config: { interopPort: port, interopToken: 'test-token', interopUseGatePassword: false },
    dataDir,
    repositoryRoot: process.cwd(),
    members: async () => ({ local: { id: 'local', name: 'member-b', ip: '127.0.0.1' }, members: [] }),
    noteMemberParticipation: async facts => { notes.push(facts) },
  }
  const ctx = { get: name => name === 'agents' ? { get: id => id === 'session-A' ? agent : undefined } : undefined }
  const tasks = new MemberTaskService({ ctx, service, dataDir, log: () => {} })
  try {
    await tasks.init()
    const deadline = Date.now() + 12_000
    while (notes.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.deepEqual(notes[0], { cwd: '/root/ws/project', conversationId, turn: 1 })
  } finally {
    await tasks.dispose()
    await new Promise(resolve => server.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a legacy task without originCwd recovers it from the stored session header', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'member-cwd-'))
  const taskRoot = path.join(dataDir, 'member-tasks')
  await mkdir(taskRoot, { recursive: true })
  await writeFile(path.join(taskRoot, 'member-legacy-cwd.json'), `${JSON.stringify(persistedTask({
    id: 'member-legacy-cwd',
    status: 'completed',
    notify: false,
  }), null, 2)}\n`)
  const service = {
    config: { interopToken: 'test-token', interopUseGatePassword: false },
    dataDir,
    repositoryRoot: process.cwd(),
    members: async () => ({ local: { id: 'local', name: 'member-b', ip: '127.0.0.1' }, members: [] }),
  }
  const ctx = {
    get: name => name === 'sessionPersistence'
      ? { stat: async id => ({ header: { cwd: id === 'session-A' ? '/root/ws/ai-cad' : '' } }) }
      : undefined,
  }
  const tasks = new MemberTaskService({ ctx, service, dataDir, log: () => {} })
  try {
    await tasks.init()
    const task = await tasks.find('conv-recover')
    assert.equal(task.originCwd, '/root/ws/ai-cad')
  } finally {
    await tasks.dispose()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a graceful stop leaves its running task marked resumable', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'member-stop-'))
  const service = {
    config: { interopToken: 'test-token', interopUseGatePassword: false },
    dataDir,
    repositoryRoot: process.cwd(),
    members: async () => ({ local: { id: 'local', name: 'member-b', ip: '127.0.0.1' }, members: [] }),
  }
  const tasks = new MemberTaskService({ ctx: { get: () => undefined }, service, dataDir, log: () => {} })
  try {
    tasks.tasks.set('member-stop-test', persistedTask({ id: 'member-stop-test', status: 'running' }))
    await tasks.dispose()
    const saved = JSON.parse(await readFile(path.join(dataDir, 'member-tasks', 'member-stop-test.json'), 'utf8'))
    assert.equal(saved.status, 'interrupted')
    assert.equal(saved.resumable, true)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('member system inventory is fetched through the interop service', async () => {
  const { server, port } = await fakeMember()
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'member-task-'))
  const service = {
    config: { interopPort: port, interopToken: 'test-token', interopUseGatePassword: false },
    dataDir,
    repositoryRoot: process.cwd(),
    members: async () => ({ local: { id: 'local', name: 'member-b', ip: '127.0.0.1' }, members: [] }),
  }
  const tasks = new MemberTaskService({ ctx: { get: () => undefined }, service, dataDir })
  try {
    const info = await tasks.system('127.0.0.1')
    assert.equal(info.hostname, 'member-b')
    assert.equal(info.member, 'member-b')
    assert.equal(info.memberIp, '127.0.0.1')
  } finally {
    await tasks.dispose()
    await new Promise(resolve => server.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('delegation requires a live DSH conversation', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'member-task-'))
  const service = {
    config: { interopToken: 'test-token', interopUseGatePassword: false },
    dataDir,
    repositoryRoot: process.cwd(),
    members: async () => ({ local: { id: 'local', name: 'b', ip: '127.0.0.1' }, members: [] }),
  }
  const tasks = new MemberTaskService({ ctx: { get: () => undefined }, service, dataDir })
  try {
    await assert.rejects(
      () => tasks.start({ member: '127.0.0.1', prompt: 'x' }),
      /must be called from a DSH conversation/,
    )
  } finally {
    await tasks.dispose()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('build tool returns the final job and its log path', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'member-build-tool-'))
  const tools = []
  const service = {
    config: {},
    dataDir,
    repositoryRoot: process.cwd(),
    members: async () => ({ local: { id: 'local', name: 'a', ip: '127.0.0.1' }, members: [] }),
    build: async () => ({
      id: 'build-test',
      status: 'done',
      phase: 'done',
      source: 'local',
      ref: 'master',
      targets: ['linux-x64'],
      logFile: path.join(dataDir, 'build', 'build-test', 'build.log'),
      stateFile: path.join(dataDir, 'build', 'build-test', 'state.json'),
      logTail: ['job created', 'build complete'],
      artifacts: [],
    }),
  }
  const ctx = {
    logger: { info: () => {}, error: () => {} },
    effect: () => () => {},
    get: () => undefined,
  }
  try {
    registerTools(ctx, { tools: { register: tool => { tools.push(tool) } } }, service)
    const build = tools.find(tool => tool.name === 'build')
    const result = await build.execute({ planOnly: true }, {})
    assert.equal(result.ok, true)
    assert.match(result.text, /build-test/)
    assert.match(result.text, /build\.log/)
    assert.match(result.text, /job created/)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('registerTools exposes the build, deploy, member and product-stage tools', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'member-tools-'))
  const names = []
  const tools = []
  const service = {
    config: {},
    dataDir,
    repositoryRoot: process.cwd(),
    members: async () => ({ local: { id: 'local', name: 'a', ip: '127.0.0.1' }, members: [] }),
  }
  const ctx = {
    logger: { info: () => {}, error: () => {} },
    effect: () => () => {},
    get: () => undefined,
  }
  const toolsCtx = { tools: { register: tool => { names.push(tool.name); tools.push(tool) } } }
  try {
    registerTools(ctx, toolsCtx, service)
    assert.deepEqual(names.sort(), ['build', 'call_member', 'deploy', 'members', 'remove_member', 'repack', 'set_member_scope', 'set_product_stage', 'status_member', 'stop_all_member', 'wait_member'].sort())
    for (const name of ['build', 'deploy', 'members']) {
      const tool = tools.find(candidate => candidate.name === name)
      assert.equal(tool.parameters.properties.action, undefined)
    }
    const deploy = tools.find(candidate => candidate.name === 'deploy')
    assert.deepEqual(deploy.parameters.required, ['host', 'package'])
    const call = tools.find(candidate => candidate.name === 'call_member')
    assert.equal(call.parameters.properties.action, undefined)
    assert.deepEqual(call.parameters.required, ['prompt'])
    assert.deepEqual(
      Object.keys(call.parameters.properties).sort(),
      ['conversationId', 'cwd', 'identity', 'member', 'prompt', 'role', 'scope', 'workspace'].sort(),
    )
    const setScope = tools.find(candidate => candidate.name === 'set_member_scope')
    assert.equal(setScope.parameters.properties.action, undefined)
    assert.deepEqual(
      Object.keys(setScope.parameters.properties).sort(),
      ['avoidLongJobs', 'budgetAudit', 'waitMember', 'compressOnTurnEnd', 'callMemberBudget', 'call_member_budget', 'compressPercent', 'conversationId', 'identity', 'keep', 'keepPrompt', 'keep_prompt', 'note', 'role', 'scope'].sort(),
    )
    const setStage = tools.find(candidate => candidate.name === 'set_product_stage')
    assert.deepEqual(Object.keys(setStage.parameters.properties).sort(), ['goals', 'round', 'stage'].sort())
    const repack = tools.find(candidate => candidate.name === 'repack')
    assert.deepEqual(repack.parameters.required, ['package'])
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a delegation tells the member what the conversation is about and who started it', async () => {
  const { server, port, created } = await fakeMember()
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'member-task-'))
  const agent = { id: 'session-A', session: { id: 'session-A' }, followup: () => {} }
  const service = {
    config: { interopPort: port, interopToken: 'test-token', interopUseGatePassword: false },
    dataDir,
    repositoryRoot: process.cwd(),
    members: async () => ({ local: { id: 'local', name: 'member-b', ip: '127.0.0.1' }, members: [] }),
  }
  const ctx = { get: name => name === 'agents' ? { get: id => id === 'session-A' ? agent : undefined } : undefined }
  const tasks = new MemberTaskService({ ctx, service, dataDir, log: () => {} })
  try {
    await tasks.start({ member: '127.0.0.1', prompt: 'summarise the deploy log', agent, notify: false })
    assert.equal(created.length, 1)
    assert.equal(created[0].title, 'summarise the deploy log')
    assert.equal(created[0].initiator.name, 'member-b')
    assert.equal(created[0].initiator.id, 'local')
    assert.equal(created[0].initiator.source, 'call_member')
  } finally {
    await tasks.dispose()
    await new Promise(resolve => server.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  }
})

/**
 * Start a member interop that creates one conversation and then answers its
 * waits with the supplied handler, so a single failure mode can be exercised.
 * @param {(response: import('node:http').ServerResponse, body: string) => void} onWait wait handler.
 * @returns {Promise<{server: import('node:http').Server, port: number}>} endpoint.
 */
async function memberThatFails(onWait, id) {
  const server = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    if (request.method === 'POST' && request.url === '/v1/conversations') {
      response.writeHead(201, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, conversation: { id, status: 'running' } }))
      return
    }
    if (request.method === 'POST' && request.url === `/v1/conversations/${id}/wait`) {
      onWait(response, body)
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'unknown' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

test('a member conversation the restart erased fails at once instead of retrying', async () => {
  const { server, port } = await memberThatFails((response) => {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: { code: 'conversation_not_found', message: 'conversation not found' } }))
  }, 'conv-lost')
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'member-task-'))
  const service = {
    config: { interopPort: port, interopToken: 'test-token', interopUseGatePassword: false },
    dataDir,
    repositoryRoot: process.cwd(),
    members: async () => ({ local: { id: 'local', name: 'member-b', ip: '127.0.0.1' }, members: [] }),
  }
  const tasks = new MemberTaskService({ ctx: { get: () => undefined }, service, dataDir })
  try {
    const started = Date.now()
    const created = await tasks.start({ member: '127.0.0.1', prompt: 'long job', agent: { id: 'a', session: { id: 'a' } }, notify: false })
    const task = (await tasks.wait(created.conversationId, { timeoutMs: 4000 })).task
    assert.equal(task.status, 'failed')
    assert.equal(task.interrupted, true)
    assert.equal(task.attempts, 1, 'a lost conversation must not be retried')
    assert.match(task.error, /conversation not found/u)
    assert.ok(Date.now() - started < 4000, 'the failure must be immediate')
  } finally {
    await tasks.dispose()
    await new Promise(resolve => server.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('an idle conversation that never ran a turn is a failure, not a success', async () => {
  const { server, port } = await memberThatFails((response) => {
    // Exactly what a restart produces: the wait resolves before the turn starts.
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      ok: true,
      timedOut: false,
      conversation: { id: 'conv-empty', status: 'idle', lastText: '', error: null, turns: 0, eventCount: 0 },
    }))
  }, 'conv-empty')
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'member-task-'))
  const messages = []
  const agent = { id: 'session-A', session: { id: 'session-A' }, followup: message => { messages.push(message) } }
  const service = {
    config: { interopPort: port, interopToken: 'test-token', interopUseGatePassword: false },
    dataDir,
    repositoryRoot: process.cwd(),
    members: async () => ({ local: { id: 'local', name: 'member-b', ip: '127.0.0.1' }, members: [] }),
  }
  const ctx = { get: name => name === 'agents' ? { get: id => id === 'session-A' ? agent : undefined } : undefined }
  const tasks = new MemberTaskService({ ctx, service, dataDir, log: () => {} })
  try {
    const task = await tasks.start({ member: '127.0.0.1', prompt: 'long job', agent, notify: true })
    const deadline = Date.now() + 10_000
    while (messages.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const final = await tasks.status(task.id)
    assert.equal(final.status, 'failed')
    assert.equal(final.interrupted, true)
    assert.match(final.error, /重启/u)
    assert.equal(messages.length, 1)
    assert.match(messages[0].content[0].text, /成员任务失败/u)
    assert.match(messages[0].content[0].text, /call_member 带 conversationId/u)
  } finally {
    await tasks.dispose()
    await new Promise(resolve => server.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a delegation waits out a member runtime that is still starting', async () => {
  let attempts = 0
  const server = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    if (request.method === 'POST' && request.url === '/v1/conversations') {
      attempts += 1
      if (attempts === 1) {
        // Exactly what a member answers while its SDK child boots.
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, error: { code: 'sdk_unavailable', message: 'The SDK runtime is still starting.' } }))
        return
      }
      response.writeHead(201, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, conversation: { id: 'conv-boot', status: 'running' } }))
      return
    }
    if (request.method === 'POST' && request.url === '/v1/conversations/conv-boot/wait') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        ok: true,
        timedOut: false,
        conversation: { id: 'conv-boot', status: 'idle', lastText: 'BOOTED', error: null, turns: 1 },
      }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'unknown' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'member-task-'))
  const service = {
    config: { interopPort: port, interopToken: 'test-token', interopUseGatePassword: false },
    dataDir,
    repositoryRoot: process.cwd(),
    members: async () => ({ local: { id: 'local', name: 'member-b', ip: '127.0.0.1' }, members: [] }),
  }
  const tasks = new MemberTaskService({ ctx: { get: () => undefined }, service, dataDir })
  try {
    const created = await tasks.start({ member: '127.0.0.1', prompt: 'restart window', agent: { id: 'a', session: { id: 'a' } }, notify: false })
    const task = (await tasks.wait(created.conversationId, { timeoutMs: 4000 })).task
    assert.equal(attempts, 2, 'the booting member must be retried once')
    assert.equal(task.status, 'completed')
    assert.equal(task.lastText, 'BOOTED')
  } finally {
    await tasks.dispose()
    await new Promise(resolve => server.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a new conversation request carries no force escape hatch', async () => {
  // The one-conversation-per-workspace rule has no override: a caller that
  // still passes force must not turn it into forceWorkspace on the wire.
  const forced = await delegationPayload({ start: { force: true } })
  assert.equal('forceWorkspace' in forced.created[0], false)
  const plain = await delegationPayload({})
  assert.equal('forceWorkspace' in plain.created[0], false)
})

test('call_member turns a busy workspace into a "continue that conversation" answer', async () => {
  const created = []
  const member = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    if (request.method === 'POST' && request.url === '/v1/conversations/conv-busy/messages') {
      response.writeHead(202, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        ok: true,
        conversation: { id: 'conv-busy', status: 'running', turns: 2 },
        receipt: { accepted: true, delivery: 'followup' },
      }))
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/conversations') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'not found' } }))
      return
    }
    created.push(body === '' ? {} : JSON.parse(body))
    response.writeHead(409, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      ok: false,
      error: {
        code: 'workspace_occupied',
        message: '目标工作区「repo」（/w/repo）已有对话：conv-busy（idle）。一个工作区只允许一个对话：请直接 call_member 带 conversationId "conv-busy" 继续这个对话；需要新的工作区就换一个 workspace 名。',
        detail: { workspace: 'repo', cwd: '/w/repo', conversationId: 'conv-busy', conversationIds: ['conv-busy'] },
      },
    }))
  })
  await new Promise(resolve => member.listen(0, '127.0.0.1', resolve))
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'member-guard-'))
  const service = {
    config: { interopPort: member.address().port, interopToken: 'test-token', interopUseGatePassword: false },
    dataDir,
    repositoryRoot: process.cwd(),
    members: async () => ({ local: { id: 'local', name: 'member-b', ip: '127.0.0.1' }, members: [] }),
  }
  const tools = []
  const ctx = {
    logger: { info: () => {}, error: () => {} },
    effect: () => () => {},
    get: () => undefined,
  }
  try {
    registerTools(ctx, { tools: { register: tool => { tools.push(tool) } } }, service)
    const call = tools.find(tool => tool.name === 'call_member')
    const agent = { id: 'session-A', session: { id: 'session-A' } }

    const blocked = await call.execute({ member: '127.0.0.1', prompt: '并发任务' }, { agent })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.data.code, 'workspace_occupied')
    assert.deepEqual(blocked.data.occupiedConversationIds, ['conv-busy'])
    assert.equal(blocked.data.conversationId, 'conv-busy')
    assert.equal(blocked.data.workspace, 'repo')
    assert.match(blocked.text, /一个工作区只允许一个对话/u)
    assert.match(blocked.text, /继续那个对话：call_member \{ "member": "127\.0\.0\.1", "conversationId": "conv-busy"/u)
    assert.doesNotMatch(blocked.text, /force/u, 'there is no override to suggest')
    assert.equal(service.memberTasks.tasks.size, 0, 'a refused create must not be tracked as a task')

    const forced = await call.execute({ member: '127.0.0.1', prompt: '确认并发', force: true }, { agent })
    assert.equal(forced.ok, false)
    assert.equal(created.length, 2)
    assert.equal('forceWorkspace' in created[1], false)

    assert.match(blocked.text, /"member": "127\.0\.0\.1"/u, 'the suggestion names the member when it is known')
    const continued = await call.execute({ member: '127.0.0.1', conversationId: 'conv-busy', prompt: '继续那个任务' }, { agent })
    assert.equal(continued.ok, true)
    assert.equal(continued.data.currentConversationId, 'conv-busy')
  } finally {
    await service.memberTasks.dispose()
    await new Promise(resolve => member.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  }
})
