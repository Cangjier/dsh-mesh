import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUDGET_AUTH_MESSAGE_WINDOW,
  hasBudgetInstructionFromUser,
  isBudgetAdjustmentText,
  recentHumanUserMessages,
  userMessageText,
} from '../src/lib/user-intent.mjs'

/**
 * A fake agent whose session surface exposes the given messages.
 * @param {{text: string, kind?: string}[]} messages oldest first.
 * @returns {object} agent.
 */
function agentWith(messages) {
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
  return { session: { surface: { nodes }, eventAt: seq => events.get(seq) } }
}

test('recent human messages skip injected context and respect the window', () => {
  const messages = [
    { text: '老消息' },
    { text: '注入的成员上下文', kind: 'member-context' },
    { text: '第二条用户消息' },
    { text: '最新用户消息' },
  ]
  const recent = recentHumanUserMessages(agentWith(messages), 2)
  assert.deepEqual(recent.map(userMessageText), ['最新用户消息', '第二条用户消息'])
  assert.equal(recentHumanUserMessages({ session: {} }).length, 0)
  assert.equal(BUDGET_AUTH_MESSAGE_WINDOW, 8)
})

test('one message text joins only its text blocks', () => {
  assert.equal(userMessageText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(userMessageText({ content: [] }), '')
  assert.equal(userMessageText(null), '')
})

test('a budget instruction needs the term, a verb and a number', () => {
  assert.equal(isBudgetAdjustmentText('把 A 阶段预算调到 26'), true)
  assert.equal(isBudgetAdjustmentText('call_member 预算设为 10 / 6 / 4 / 4'), true)
  assert.equal(isBudgetAdjustmentText('预算改成 A 26 B 10'), true)
  assert.equal(isBudgetAdjustmentText('调整预算到 26'), true)
  assert.equal(isBudgetAdjustmentText('预算用完了'), false)
  assert.equal(isBudgetAdjustmentText('预算设置'), false)
  assert.equal(isBudgetAdjustmentText('继续推进'), false)
  assert.equal(isBudgetAdjustmentText('不要调整预算到 26'), false)
  assert.equal(isBudgetAdjustmentText('不用把预算改成 26'), false)
})

test('a recent human instruction authorises a budget change', () => {
  const agent = agentWith([
    { text: '先把预算调到 20' },
    { text: '继续推进' },
    { text: '把 A 阶段预算调到 26' },
  ])
  assert.equal(hasBudgetInstructionFromUser(agent), true)
  assert.equal(hasBudgetInstructionFromUser(agentWith([{ text: '继续推进' }])), false)
  assert.equal(hasBudgetInstructionFromUser(agentWith([{ text: '把 A 阶段预算调到 26', kind: 'member-context' }])), false)
})
