import assert from 'node:assert/strict'
import test from 'node:test'
import { createTurnGuard } from '../src/lib/turn-guard.mjs'

/**
 * Build one idle agent and a fake host around the guard.
 * @param {{verdict?: string, task?: object|undefined}} [options] fake behavior.
 * @returns {object} harness.
 */
function harness(options = {}) {
  const sessionId = 'session-1'
  const followups = []
  let judgeCalls = 0
  const verdict = options.verdict ?? 'YES'
  const agent = {
    id: sessionId,
    status: 'idle',
    options: { provider: 'deepseek-account', model: 'deepseek-flash' },
    followup: message => { followups.push(message) },
  }
  const handlers = new Map()
  const task = options.noTask === true
    ? undefined
    : options.task ?? {
      member: 'build-2',
      memberIp: '10.66.66.2',
      conversationId: 'conv-1',
      status: 'completed',
      lastPrompt: '检查磁盘',
    }
  const llm = {
    async prepareCall() {
      return {
        config: { provider: 'deepseek-account', model: 'deepseek-flash' },
        async *stream() {
          judgeCalls += 1
          yield { type: 'text-delta', text: verdict }
        },
      }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'agents') return { get: id => (id === sessionId ? agent : undefined) }
      if (name === 'llm') return llm
      return undefined
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => { handlers.delete(event) }
    },
  }
  const memberTasks = {
    async latestForOrigin(id) {
      return id === sessionId && task !== undefined ? task : undefined
    },
  }
  const guard = createTurnGuard({ ctx, memberTasks, log: () => {} })
  const session = { id: sessionId }
  const emit = (type, data) => {
    handlers.get('session/event')?.(session, { type, data })
  }
  return {
    guard,
    emit,
    followups,
    agent,
    judgeCalls: () => judgeCalls,
    session,
  }
}

/** Let the guard's async judge and delivery finish. */
async function settle() {
  await new Promise(resolve => setTimeout(resolve, 20))
}

/**
 * Run one complete turn.
 * @param {{emit: Function}} harness guard harness.
 * @param {{text?: string, call?: boolean, turn: number}} turn turn shape.
 * @returns {Promise<void>} resolution after the guard settles.
 */
async function turn(harness, { text = '我让成员去查一下', call = false, turn }) {
  harness.emit('turn/start', { turn })
  if (call) harness.emit('tool/call', { turn, name: 'call_member', callId: 'c1', arguments: '{}' })
  harness.emit('assistant/message', { turn, message: { content: [{ type: 'text', text }] } })
  harness.emit('turn/end', { turn })
  await settle()
}

test('turn guard ignores sessions that never delegated', async () => {
  const h = harness({ noTask: true })
  await turn(h, { turn: 1 })
  assert.equal(h.judgeCalls(), 0)
  assert.equal(h.followups.length, 0)
  h.guard.dispose()
})

test('turn guard stays quiet while the member conversation is running', async () => {
  const h = harness({ task: { member: 'build-2', memberIp: '10.66.66.2', conversationId: 'conv-1', status: 'running', lastPrompt: '检查磁盘' } })
  await turn(h, { turn: 1 })
  assert.equal(h.judgeCalls(), 0)
  assert.equal(h.followups.length, 0)
  h.guard.dispose()
})

test('turn guard stays quiet when the judge reads the reply as ordinary', async () => {
  const h = harness({ verdict: 'NO' })
  await turn(h, { turn: 1 })
  assert.equal(h.judgeCalls(), 1)
  assert.equal(h.followups.length, 0)
  h.guard.dispose()
})

test('turn guard queues a call_member reminder and stops after three consecutive ones', async () => {
  const h = harness()
  for (let index = 1; index <= 5; index += 1) await turn(h, { turn: index })
  // Turns 4 and 5 are not judged: the guard gives up at three reminders.
  assert.equal(h.judgeCalls(), 3)
  assert.equal(h.followups.length, 3)
  const text = h.followups[0].content[0].text
  assert.match(text, /没有实际调用 call_member/u)
  assert.match(text, /会话id：conv-1/u)
  assert.match(text, /第 1\/3 次连续提醒/u)
  h.guard.dispose()
})

test('turn guard resets the reminder count when a turn calls call_member', async () => {
  const h = harness()
  for (let index = 1; index <= 3; index += 1) await turn(h, { turn: index })
  assert.equal(h.followups.length, 3)
  await turn(h, { turn: 4, call: true })
  assert.equal(h.followups.length, 3)
  await turn(h, { turn: 5 })
  assert.equal(h.followups.length, 4)
  assert.match(h.followups[3].content[0].text, /第 1\/3 次连续提醒/u)
  h.guard.dispose()
})

test('turn guard does not judge a turn that called call_member', async () => {
  const h = harness()
  await turn(h, { turn: 1, call: true })
  assert.equal(h.judgeCalls(), 0)
  assert.equal(h.followups.length, 0)
  h.guard.dispose()
})
