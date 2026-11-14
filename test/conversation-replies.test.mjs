import test from 'node:test'
import assert from 'node:assert/strict'
import { applySessionEvent, assistantText, repliesSince, summarizeReplies } from '../code/shared/conversation-replies.mjs'

/**
 * Minimal conversation record the shared helpers mutate.
 * @returns {object} fresh record.
 */
function record() {
  return {
    turns: 0,
    replySeq: 0,
    replies: [],
    turnText: '',
    lastText: '',
    error: null,
  }
}

/**
 * Build an assistant message event.
 * @param {string} text message text.
 * @returns {object} event.
 */
function assistant(text) {
  return { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }
}

test('one reply per turn joins every assistant message of that turn', () => {
  const conversation = record()
  applySessionEvent(conversation, { type: 'turn/start', data: { turn: 1 } })
  applySessionEvent(conversation, assistant('先看文件，'))
  applySessionEvent(conversation, assistant('再看日志。'))
  const reply = applySessionEvent(conversation, { type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })

  assert.deepEqual(reply, {
    seq: 1,
    turn: 1,
    text: '先看文件，再看日志。',
    at: reply.at,
  })
  assert.equal(conversation.turns, 1)
  assert.equal(conversation.replySeq, 1)
  assert.equal(conversation.replies.length, 1)
  assert.equal(conversation.lastText, '再看日志。')
  assert.equal(conversation.turnText, '')
})

test('a text-less turn counts but produces no reply', () => {
  const conversation = record()
  applySessionEvent(conversation, { type: 'turn/start', data: { turn: 1 } })
  const reply = applySessionEvent(conversation, { type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })

  assert.equal(reply, null)
  assert.equal(conversation.turns, 1)
  assert.equal(conversation.replySeq, 0)
  assert.deepEqual(conversation.replies, [])
})

test('a second turn appends a second reply with its own sequence', () => {
  const conversation = record()
  applySessionEvent(conversation, { type: 'turn/start' })
  applySessionEvent(conversation, assistant('第一轮'))
  applySessionEvent(conversation, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
  applySessionEvent(conversation, { type: 'turn/start' })
  applySessionEvent(conversation, assistant('第二轮'))
  applySessionEvent(conversation, { type: 'turn/end', data: { reason: { kind: 'stop' } } })

  assert.deepEqual(conversation.replies.map(reply => [reply.seq, reply.turn, reply.text]), [
    [1, 1, '第一轮'],
    [2, 2, '第二轮'],
  ])
  assert.equal(conversation.turns, 2)
})

test('an error turn records the failure and still keeps the text', () => {
  const conversation = record()
  applySessionEvent(conversation, { type: 'turn/start' })
  applySessionEvent(conversation, assistant('做到一半'))
  const reply = applySessionEvent(conversation, {
    type: 'turn/end',
    data: { reason: { kind: 'error', error: { message: 'boom' } } },
  })

  assert.equal(reply.text, '做到一半')
  assert.equal(conversation.error, 'boom')

  // A resumed turn clears the failure: the conversation is no longer failed.
  applySessionEvent(conversation, { type: 'turn/start' })
  assert.equal(conversation.error, null)
})

test('repliesSince only returns what the caller has not seen', () => {
  const conversation = record()
  for (const text of ['a', 'b', 'c']) {
    applySessionEvent(conversation, { type: 'turn/start' })
    applySessionEvent(conversation, assistant(text))
    applySessionEvent(conversation, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
  }

  assert.deepEqual(repliesSince(conversation, 0).map(reply => reply.text), ['a', 'b', 'c'])
  assert.deepEqual(repliesSince(conversation, 1).map(reply => reply.text), ['b', 'c'])
  assert.deepEqual(repliesSince(conversation, 3), [])
  assert.deepEqual(repliesSince(conversation, undefined).map(reply => reply.text), ['a', 'b', 'c'])
})

test('summarizeReplies merges text and reports the newest position', () => {
  const summary = summarizeReplies([
    { seq: 4, turn: 2, text: '一' },
    { seq: 5, turn: 3, text: '二' },
  ])
  assert.deepEqual(summary, { text: '一\n\n二', turn: 3, seq: 5 })
  assert.deepEqual(summarizeReplies([]), { text: '', turn: null, seq: null })
})

test('assistantText reads only text blocks', () => {
  assert.equal(assistantText(assistant('hi')), 'hi')
  assert.equal(assistantText({ type: 'turn/end' }), '')
  assert.equal(assistantText({ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } }), '')
})
