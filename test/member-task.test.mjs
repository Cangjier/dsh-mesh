import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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
  const server = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    if (request.headers.authorization !== 'Bearer test-token') {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'bad token' } }))
      return
    }
    if (request.method === 'POST' && request.url === '/v1/conversations') {
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
  return { server, port: address.port }
}

test('a completed member conversation notifies the originating agent', async () => {
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
    members: async () => ({
      local: { id: 'local', name: 'member-b', ip: '127.0.0.1' },
      members: [],
    }),
  }
  const ctx = {
    get: name => name === 'agents' ? { get: id => id === 'session-A' ? agent : undefined } : undefined,
  }
  const tasks = new MemberTaskService({ ctx, service, dataDir, log: () => {} })
  try {
    const task = await tasks.start({
      member: '127.0.0.1',
      prompt: 'do the member job',
      agent,
      notify: true,
    })
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
    assert.match(messages[0].content[0].text, /成员任务完成/)
    assert.match(messages[0].content[0].text, /MEMBER DONE/)
  } finally {
    await tasks.dispose()
    await new Promise(resolve => server.close(resolve))
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

test('registerTools exposes dsh_member_task alongside the existing tools', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'member-tools-'))
  const names = []
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
  const toolsCtx = { tools: { register: tool => { names.push(tool.name) } } }
  try {
    registerTools(ctx, toolsCtx, service)
    assert.deepEqual(names.sort(), ['dsh_member_task', 'dsh_person_deploy', 'dsh_person_web'].sort())
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
