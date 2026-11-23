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
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mesh-cancel-'))
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
 * Put one running task with no replies in the service's in-memory table.
 * @param {object} service stub service.
 * @returns {object} task.
 */
function seed(service) {
  const task = {
    id: 'member-cancel',
    member: 'B',
    memberIp: '10.66.66.2',
    conversationId: 'c1',
    status: 'running',
    turns: 1,
    lastText: '',
    replies: [],
    replySeq: 0,
    deliveredSeq: 0,
    notify: false,
  }
  service.memberTasks.tasks.set(task.id, task)
  return task
}

test('cancelling the turn ends a parked wait instead of letting it time out', async () => {
  const { dataDir, service, wait } = await harness()
  try {
    seed(service)
    const controller = new AbortController()
    // DSH aborts tool calls with its own reason object; keep that identity.
    const reason = { kind: 'user' }
    const started = Date.now()
    setTimeout(() => controller.abort(reason), 20)
    const outcome = await wait
      .execute({ conversationId: 'c1', timeoutMs: 60_000 }, { signal: controller.signal })
      .then(value => ({ kind: 'returned', value }), error => ({ kind: 'threw', error }))
    const elapsed = Date.now() - started
    assert.equal(outcome.kind, 'threw', 'a cancelled wait must not return a keep-waiting hint')
    assert.equal(outcome.error, reason, 'the abort reason is rethrown so DSH reports the call as cancelled')
    assert.ok(elapsed < 2_000, `the wait ended ${String(elapsed)} ms after the abort`)
    const parked = [...service.memberTasks.waiters.values()].reduce((total, set) => total + set.size, 0)
    assert.equal(parked, 0, 'the aborted waiter is removed from the parked set')
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('an already-aborted call refuses to park at all', async () => {
  const { dataDir, service, wait } = await harness()
  try {
    seed(service)
    const controller = new AbortController()
    const reason = { kind: 'user' }
    controller.abort(reason)
    const started = Date.now()
    await assert.rejects(
      wait.execute({ conversationId: 'c1', timeoutMs: 60_000 }, { signal: controller.signal }),
      error => error === reason,
    )
    assert.ok(Date.now() - started < 1_000)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
