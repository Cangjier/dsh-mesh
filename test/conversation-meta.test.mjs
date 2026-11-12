import assert from 'node:assert/strict'
import test from 'node:test'
import {
  conversationRecord,
  normalizeInitiator,
  normalizeTitle,
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
    createdAt: '2026-11-12T06:00:00.000Z',
    updatedAt: '2026-11-12T06:01:00.000Z',
    lastText: 'y'.repeat(900),
    turns: 3,
    events: [{ type: 'x' }],
    clients: new Set(),
    lastReceipt: { big: true },
  })
  assert.deepEqual(Object.keys(record).sort(), [
    'createdAt', 'cwd', 'id', 'initiator', 'lastText', 'sessionId', 'status', 'title', 'turns', 'updatedAt',
  ])
  assert.equal(record.turns, 3)
  assert.ok(record.lastText.length <= 400)
  assert.equal(record.events, undefined)
})
