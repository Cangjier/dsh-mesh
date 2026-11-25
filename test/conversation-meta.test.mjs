import assert from 'node:assert/strict'
import test from 'node:test'
import {
  conversationRecord,
  INTERRUPTED_STATUS,
  normalizeInitiator,
  normalizeTitle,
  promptText,
  restoredConversation,
  titleFromPrompt,
  TITLE_LIMIT,
} from '../code/shared/conversation-meta.mjs'

test('a title collapses whitespace and keeps a single line', () => {
  assert.equal(normalizeTitle('  deploy\n  the   gateway '), 'deploy the gateway')
  assert.equal(normalizeTitle(null), '')
  assert.equal(normalizeTitle('   '), '')
})

test('a long prompt is truncated to the title budget', () => {
  const title = normalizeTitle('x'.repeat(TITLE_LIMIT * 2))
  assert.equal(Array.from(title).length, TITLE_LIMIT)
  assert.ok(title.endsWith('…'))
})

test('the title falls back to the first text block of a prompt', () => {
  assert.equal(titleFromPrompt('fix the build'), 'fix the build')
  assert.equal(titleFromPrompt([
    { type: 'image', data: 'x', mediaType: 'image/png' },
    { type: 'text', text: 'read this screenshot' },
  ]), 'read this screenshot')
  assert.equal(titleFromPrompt([{ type: 'image', data: 'x', mediaType: 'image/png' }]), '')
})

test('the prompt keeps its newlines for the detail view', () => {
  assert.equal(promptText('# 任务\n\n第一段'), '# 任务\n\n第一段')
  assert.equal(promptText([
    { type: 'text', text: '第一段' },
    { type: 'image', data: 'x', mediaType: 'image/png' },
    { type: 'text', text: '第二段' },
  ]), '第一段\n\n第二段')
  assert.equal(promptText([{ type: 'image', data: 'x', mediaType: 'image/png' }]), '')
  assert.equal(promptText(null), '')
})

test('an initiator keeps only the fields that identify a machine', () => {
  assert.deepEqual(normalizeInitiator({ id: 'local', name: ' member-a ', ip: '10.66.66.1', source: 'call_member', extra: 'x' }), {
    id: 'local',
    name: 'member-a',
    ip: '10.66.66.1',
    source: 'call_member',
  })
  assert.equal(normalizeInitiator(null), null)
  assert.equal(normalizeInitiator({ source: 'call_member' }), null)
})

test('the persisted record drops events, sockets and receipts', () => {
  const record = conversationRecord({
    id: 'c1',
    sessionId: 's1',
    title: 't',
    initiator: { id: 'local' },
    status: 'idle',
    cwd: '/root/ws',
    workspace: 'demo',
    prompt: '# 任务\n\n做点事',
    createdAt: '2026-11-12T06:00:00.000Z',
    updatedAt: '2026-11-12T06:01:00.000Z',
    lastText: 'y'.repeat(900),
    lastReasoning: 'z'.repeat(5000),
    turns: 3,
    replySeq: 7,
    events: [{ type: 'x' }],
    clients: new Set(),
    lastReceipt: { big: true },
  })
  assert.deepEqual(Object.keys(record).sort(), [
    'archived', 'archivedAt', 'createdAt', 'cwd', 'error', 'id', 'initiator', 'lastReasoning', 'lastText', 'prompt', 'replySeq', 'sessionId', 'status', 'title', 'turns', 'updatedAt', 'workspace',
  ])
  assert.equal(record.archived, false)
  assert.equal(record.archivedAt, null)
  assert.equal(record.error, null)
  assert.equal(record.turns, 3)
  assert.equal(record.replySeq, 7, 'the reply cursor is part of the durable record')
  assert.equal(record.workspace, 'demo')
  assert.equal(record.prompt, '# 任务\n\n做点事')
  assert.ok(record.lastText.length <= 400)
  assert.ok(record.lastReasoning.length <= 4000)
  assert.equal(record.events, undefined)
})

test('a conversation whose turn was in flight restores as interrupted', () => {
  const record = {
    id: 'c1',
    sessionId: 's1',
    title: 'sleep then answer',
    initiator: { id: 'local', source: 'call_member' },
    status: 'running',
    cwd: '/root/ws',
    createdAt: '2026-11-12T06:00:00.000Z',
    updatedAt: '2026-11-12T06:01:00.000Z',
    lastText: '',
    turns: 0,
  }
  const restored = restoredConversation(record, '/fallback')
  assert.equal(restored.status, INTERRUPTED_STATUS)
  assert.match(restored.error, /DSH restart/u)
  assert.equal(restored.cwd, '/root/ws')
  assert.equal(restored.turns, 0)

  // A finished conversation comes back exactly as it was.
  const idle = restoredConversation({ ...record, status: 'idle', lastText: 'done', turns: 2, replySeq: 7, workspace: 'demo', prompt: '# 原文' }, '/fallback')
  assert.equal(idle.status, 'idle')
  assert.equal(idle.error, null)
  assert.equal(idle.workspace, 'demo')
  assert.equal(idle.prompt, '# 原文')
  assert.equal(idle.replySeq, 7, 'a restart must not reset the cursor callers depend on')

  // A failed turn keeps its reason across the restart.
  const failed = restoredConversation({ ...record, status: 'error', error: 'model refused', turns: 2 }, '/fallback')
  assert.equal(failed.status, 'error')
  assert.equal(failed.error, 'model refused')
  assert.equal(idle.lastText, 'done')

  // A runtime that exited mid-turn is the same interruption.
  assert.equal(restoredConversation({ ...record, status: 'unavailable' }, '/fallback').status, INTERRUPTED_STATUS)

  // A record without a working directory or a status still yields a usable one.
  const bare = restoredConversation({ id: 'c2' }, '/fallback')
  assert.equal(bare.cwd, '/fallback')
  assert.equal(bare.status, 'idle')
  assert.equal(bare.sessionId, 'c2')
})
