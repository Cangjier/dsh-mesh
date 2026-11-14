import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { registerTools } from '../src/lib/tools.mjs'

/**
 * Register the tools against a stub service and return the wait_member tool.
 * @returns {Promise<{dataDir: string, service: object, wait: object}>} harness.
 */
async function harness() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mesh-hint-'))
  const service = {
    dataDir,
    config: { interopPort: 8765, interopToken: 'test-token' },
    async members() {
      return { local: { id: 'local', name: 'local', ip: '' }, members: [] }
    },
  }
  const definitions = new Map()
  registerTools(
    { logger: {}, effect(fn) { fn() }, get() { return undefined } },
    { tools: { register(definition) { definitions.set(definition.name, definition); return () => {} } } },
    service,
  )
  return { dataDir, service, wait: definitions.get('wait_member') }
}

/**
 * Put one task in the service's in-memory table.
 * @param {object} service stub service.
 * @param {object} [overrides] task fields.
 * @returns {object} task.
 */
function seed(service, overrides = {}) {
  const task = {
    id: 'member-hint',
    member: 'B',
    memberIp: '10.66.66.2',
    conversationId: 'c1',
    status: 'running',
    turns: 2,
    lastText: '',
    replies: [],
    replySeq: 0,
    deliveredSeq: 0,
    notify: false,
    ...overrides,
  }
  service.memberTasks.tasks.set(task.id, task)
  return task
}

test('a finished turn tells the model to keep waiting', async () => {
  const { dataDir, service, wait } = await harness()
  try {
    seed(service, {
      replies: [{ seq: 1, turn: 2, text: '第一轮的答复' }],
      replySeq: 1,
    })
    const result = await wait.execute({ taskId: 'member-hint' }, { signal: undefined })
    assert.equal(result.ok, true)
    assert.equal(result.data.done, false)
    assert.equal(result.data.state, 'progress')
    assert.match(result.text, /进行中/u)
    assert.match(result.text, /第 2 轮/u)
    assert.match(result.text, /请继续调用 wait_member/u)
    assert.match(result.text, /state=done 才是最终结果/u)
    assert.match(result.text, /第一轮的答复/u)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a timeout says the task is still running and how to continue', async () => {
  const { dataDir, service, wait } = await harness()
  try {
    seed(service, { turns: 1 })
    const result = await wait.execute({ taskId: 'member-hint', timeoutMs: 1000 }, { signal: undefined })
    assert.equal(result.ok, true)
    assert.equal(result.data.done, false)
    assert.equal(result.data.timedOut, true)
    assert.equal(result.data.state, 'running')
    assert.match(result.text, /仍在运行/u)
    assert.match(result.text, /请继续调用 wait_member/u)
    assert.match(result.text, /timeoutMs=1000/u)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('completion says no further wait is needed', async () => {
  const { dataDir, service, wait } = await harness()
  try {
    seed(service, {
      status: 'completed',
      replies: [{ seq: 2, turn: 3, text: '最终结果' }],
      replySeq: 2,
    })
    const result = await wait.execute({ taskId: 'member-hint' }, { signal: undefined })
    assert.equal(result.ok, true)
    assert.equal(result.data.done, true)
    assert.equal(result.data.state, 'done')
    assert.match(result.text, /已完成/u)
    assert.match(result.text, /不需要再调用 wait_member/u)
    assert.match(result.text, /最终结果/u)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a failed task carries the reason', async () => {
  const { dataDir, service, wait } = await harness()
  try {
    seed(service, { status: 'failed', error: '目标 SSH 不可达' })
    const result = await wait.execute({ taskId: 'member-hint' }, { signal: undefined })
    assert.equal(result.ok, false)
    assert.match(result.text, /failed/u)
    assert.match(result.text, /目标 SSH 不可达/u)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
