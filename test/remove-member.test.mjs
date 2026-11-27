import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { formatMemberStatusSnapshot } from '../src/lib/member-context.mjs'
import { registerTools } from '../src/lib/tools.mjs'

/**
 * Start a minimal member interop endpoint with an archive route.
 * @param {{archiveStatus?: number, removeStatus?: number, liveArchived?: boolean}} [options] knobs.
 * @returns {Promise<{server: import('node:http').Server, port: number, archiveCalls: number[]}>} endpoint.
 */
async function fakeMember(options = {}) {
  const archiveCalls = []
  const removedCalls = []
  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer test-token') {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'bad token' } }))
      return
    }
    if (request.method === 'GET' && request.url === '/v1/conversations/conv-1') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        ok: true,
        conversation: {
          id: 'conv-1',
          status: 'idle',
          turns: 2,
          archived: options.liveArchived === true,
          lastText: '已完成',
          lastReasoning: '',
          error: null,
        },
      }))
      return
    }
    if (request.method === 'POST' && request.url === '/v1/conversations/conv-1/messages') {
      response.writeHead(202, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        ok: true,
        conversation: { id: 'conv-1', status: 'running', archived: false, turns: 2 },
        receipt: { accepted: true, delivery: 'followup' },
      }))
      return
    }
    if (request.method === 'POST' && request.url === '/v1/conversations/conv-1/remove') {
      const status = options.removeStatus ?? 200
      if (status !== 200) {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'Unknown endpoint.' } }))
        return
      }
      removedCalls.push(1)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        ok: true,
        removed: true,
        archived: true,
        alreadyArchived: false,
        workspace: 'dsh-mesh',
        cwd: '/root/.dsh/workspaces/dsh-mesh',
        recordRemoved: true,
        directoryRemoved: true,
      }))
      return
    }
    if (request.method === 'POST' && request.url === '/v1/conversations/conv-1/archive') {
      archiveCalls.push(1)
      const status = options.archiveStatus ?? 200
      if (status !== 200) {
        response.writeHead(status, { 'content-type': 'application/json' })
        const code = status === 404 ? 'not_found' : 'archive_unavailable'
        response.end(JSON.stringify({ ok: false, error: { code, message: status === 404 ? 'Unknown endpoint.' : 'no registry' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        ok: true,
        archived: true,
        already: false,
        conversation: { id: 'conv-1', status: 'archived', archived: true },
      }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'not found' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, archiveCalls, removedCalls }
}

/**
 * Register the tools with one tracked task and return them with the service.
 * @param {{archiveStatus?: number, liveArchived?: boolean}} [options] knobs.
 * @returns {Promise<object>} harness.
 */
async function harness(options = {}) {
  const member = await fakeMember(options)
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'remove-member-'))
  const service = {
    config: { interopToken: 'test-token' },
    dataDir,
    repositoryRoot: process.cwd(),
    members: async () => ({ local: { id: 'local', name: 'a', ip: '127.0.0.1' }, members: [] }),
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: () => () => {},
    get: () => undefined,
  }
  const tools = []
  registerTools(ctx, { tools: { register: tool => { tools.push(tool) } } }, service)
  service.memberTasks.tasks.set('member-test', {
    id: 'member-test',
    conversationId: 'conv-1',
    member: 'build-2',
    memberIp: '10.66.66.2',
    baseUrl: `http://127.0.0.1:${member.port}`,
    prompt: '第一条消息',
    status: options.taskArchived === true ? 'archived' : 'completed',
    archived: options.taskArchived === true,
    archivedAt: options.taskArchived === true ? '2026-11-24T00:20:00.000Z' : null,
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:10:00.000Z',
    lastText: '已完成',
    error: null,
    turns: 2,
    workspace: 'dsh-mesh',
    originSessionId: 'session-1',
    originAgentId: 'session-1',
    replies: [],
    replySeq: 0,
    deliveredSeq: 0,
    sentMessages: [{ text: '第一条消息', at: '2026-11-24T00:00:00.000Z' }],
  })
  return {
    remove: tools.find(candidate => candidate.name === 'remove_member'),
    status: tools.find(candidate => candidate.name === 'status_member'),
    call: tools.find(candidate => candidate.name === 'call_member'),
    service,
    member,
    cleanup: async () => {
      await service.memberTasks.dispose()
      await new Promise(resolve => member.server.close(resolve))
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}

test('remove_member deletes the conversation, its workspace and the workspace directory', async () => {
  const h = await harness()
  try {
    const result = await h.remove.execute({ conversationId: 'conv-1' }, { agent: { session: { id: 'session-1' } } })
    assert.equal(result.ok, true)
    assert.match(result.text, /已删除成员会话 conv-1/u)
    assert.match(result.text, /工作区目录已清空并删除：\/root\/\.dsh\/workspaces\/dsh-mesh/u)
    assert.equal(h.member.removedCalls.length, 1, 'one call does everything on the member')
    assert.equal(result.data.workspaceRecordRemoved, true)
    assert.equal(result.data.workspaceDirectoryRemoved, true)

    // The local record and its log are gone: nothing can deliver to it, and no
    // status list can bring it back.
    assert.equal(await h.service.memberTasks.find('conv-1'), undefined)
    assert.deepEqual(await h.service.memberTasks.listForOrigin('session-1'), [])
    // The id is no longer tracked at all, so even asking for it by id is a
    // clear "not tracked" error instead of a stale row.
    await assert.rejects(
      () => h.status.execute({ conversationId: 'conv-1' }, { agent: { session: { id: 'session-1' } } }),
      /本机没有跟踪会话/u,
    )
    const snapshot = formatMemberStatusSnapshot(
      await h.service.memberTasks.listForOrigin('session-1'),
      { selfId: 'session-1' },
    )
    assert.doesNotMatch(snapshot, /conv-1/u)

    await assert.rejects(
      () => h.remove.execute({ conversationId: 'conv-1' }, { agent: { session: { id: 'session-1' } } }),
      /本机没有跟踪会话/u,
    )
  } finally {
    await h.cleanup()
  }
})

test('status_member hides a conversation archived in the member Web UI', async () => {
  const h = await harness({ liveArchived: true })
  try {
    const status = await h.status.execute({ conversationId: 'conv-1' }, { agent: { session: { id: 'session-1' } } })
    assert.equal(status.ok, true)
    assert.match(status.text, /已归档，不再列出：conv-1/u)
    const task = await h.service.memberTasks.find('conv-1')
    assert.equal(task.archived, true)
    assert.deepEqual(await h.service.memberTasks.listForOrigin('session-1'), [])
  } finally {
    await h.cleanup()
  }
})

test('remove_member drops the local record even when the member has no remove route', async () => {
  const h = await harness({ removeStatus: 404 })
  try {
    const result = await h.remove.execute({ conversationId: 'conv-1' }, { agent: { session: { id: 'session-1' } } })
    assert.equal(result.ok, true, 'the local removal is the guaranteed outcome')
    assert.match(result.text, /\[警告\] 已移除本机成员记录 conv-1/u)
    assert.match(result.text, /不支持完全删除会话/u)
    assert.equal(result.data.localRemoved, true)
    assert.equal(result.data.memberRemoved, false)
    assert.match(result.data.memberError, /不支持完全删除会话/u)
    assert.equal(await h.service.memberTasks.find('conv-1'), undefined)
    assert.deepEqual(await h.service.memberTasks.listForOrigin('session-1'), [])
    await assert.rejects(
      () => h.status.execute({ conversationId: 'conv-1' }, { agent: { session: { id: 'session-1' } } }),
      /本机没有跟踪会话/u,
    )
  } finally {
    await h.cleanup()
  }
})

test('remove_member drops the local record on a member-side server error too', async () => {
  const h = await harness({ removeStatus: 500 })
  try {
    const result = await h.remove.execute({ conversationId: 'conv-1' }, { agent: { session: { id: 'session-1' } } })
    assert.equal(result.ok, true)
    assert.equal(result.data.memberRemoved, false)
    assert.match(result.text, /成员侧归档\/删除失败/u)
    assert.equal(await h.service.memberTasks.find('conv-1'), undefined)
  } finally {
    await h.cleanup()
  }
})

test('continuing an archived conversation works once the member unarchives it', async () => {
  const h = await harness({ taskArchived: true, liveArchived: false })
  try {
    const result = await h.call.execute(
      { conversationId: 'conv-1', prompt: '恢复后继续' },
      { agent: { id: 'session-1', session: { id: 'session-1' } } },
    )
    assert.equal(result.ok, true)
    const task = await h.service.memberTasks.find('conv-1')
    assert.equal(task.archived, false, 'the member says unarchived, so the local flag must clear')
    assert.equal(task.status, 'running')
  } finally {
    await h.cleanup()
  }
})
