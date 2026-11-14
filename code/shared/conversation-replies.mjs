/**
 * Per-turn reply tracking for a member's interactive conversation.
 *
 * The interop service already receives the SDK runtime's raw `session.event`
 * stream. A waiter should not have to replay that stream to find out "did a
 * turn just finish, and what did it say": this module folds the stream into a
 * small, ordered list of replies, one per finished turn.
 *
 * One reply is the text the assistant emitted between `turn/start` and
 * `turn/end`, joined. Tool-only turns (no text at all) produce no reply: they
 * carry nothing a caller could act on, and the turn counter still moves so the
 * conversation keeps its place.
 *
 * @module @local/dsh-mesh/shared/conversation-replies
 */

/** How many finished-turn replies a conversation keeps for late waiters. */
export const MAX_REPLIES = 50

/**
 * Extract the assistant text of one `assistant/message` event.
 * @param {any} event session event.
 * @returns {string} joined text blocks, or '' for any other event.
 */
export function assistantText(event) {
  if (event?.type !== 'assistant/message') return ''
  const blocks = event?.data?.message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
}

/**
 * Fold one session event into a conversation's reply bookkeeping.
 *
 * Mutates only the reply fields (`turnText`, `turns`, `replies`, `replySeq`,
 * `lastText`, `error`), so the caller keeps ownership of status, events, and
 * sockets. Unknown event types are ignored.
 * @param {object} conversation runtime conversation record.
 * @param {any} event session event from the SDK runtime.
 * @returns {{seq: number, turn: number, text: string, at: string}|null} the reply
 *   a finished turn produced, or null when this event added none.
 */
export function applySessionEvent(conversation, event) {
  const type = event?.type

  if (type === 'assistant/message') {
    const text = assistantText(event)
    if (text === '') return null
    conversation.lastText = text
    conversation.turnText = typeof conversation.turnText === 'string' ? `${conversation.turnText}${text}` : text
    return null
  }

  if (type === 'turn/start') {
    // A new turn owns a fresh text buffer, and a previous turn's failure is no
    // longer this conversation's current state: the agent kept going.
    conversation.turnText = ''
    conversation.error = null
    return null
  }

  if (type !== 'turn/end') return null

  conversation.turns = Number.isSafeInteger(conversation.turns) ? conversation.turns + 1 : 1
  if (event?.data?.reason?.kind === 'error') {
    conversation.error = event.data.reason.error?.message ?? 'turn ended with an error'
  }
  const text = (typeof conversation.turnText === 'string' ? conversation.turnText : '').trim()
  conversation.turnText = ''
  if (text === '') return null

  const reply = {
    seq: (Number.isSafeInteger(conversation.replySeq) ? conversation.replySeq : 0) + 1,
    turn: conversation.turns,
    text,
    at: new Date().toISOString(),
  }
  conversation.replySeq = reply.seq
  if (!Array.isArray(conversation.replies)) conversation.replies = []
  conversation.replies.push(reply)
  if (conversation.replies.length > MAX_REPLIES) {
    conversation.replies.splice(0, conversation.replies.length - MAX_REPLIES)
  }
  return reply
}

/**
 * Replies a caller has not seen yet.
 * @param {object} conversation runtime conversation record.
 * @param {unknown} since last reply seq the caller received (0 or missing = all).
 * @returns {Array<{seq: number, turn: number, text: string, at: string}>} unseen replies, oldest first.
 */
export function repliesSince(conversation, since) {
  const after = Number.isSafeInteger(since) && since > 0 ? since : 0
  const replies = Array.isArray(conversation.replies) ? conversation.replies : []
  return replies.filter(reply => reply.seq > after)
}

/**
 * Join replies into the one text a wait response carries.
 * @param {Array<{seq: number, turn: number, text: string}>} replies replies to merge.
 * @returns {{text: string, turn: number|null, seq: number|null}} merged text and position.
 */
export function summarizeReplies(replies) {
  const text = replies.map(reply => reply.text).join('\n\n').trim()
  const last = replies[replies.length - 1]
  return {
    text,
    turn: last === undefined ? null : last.turn,
    seq: last === undefined ? null : last.seq,
  }
}
