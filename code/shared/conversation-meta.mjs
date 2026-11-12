/**
 * Conversation metadata shared by the interop service and the mesh panel.
 *
 * A member's interop service owns the conversations it created (the ones a
 * `call_member` delegation or another member started). The panel lists them per
 * member, so both sides need one idea of a title, of "who started this", and of
 * the slim record that survives a service restart.
 *
 * @module @local/dsh-mesh/shared/conversation-meta
 */

/** Longest title kept for the panel; longer prompts are truncated. */
export const TITLE_LIMIT = 80

/** Longest single initiator field (a member name or an id). */
export const INITIATOR_LIMIT = 64

/** Longest stored answer preview. */
export const PREVIEW_LIMIT = 400

/**
 * Collapse whitespace, trim, and fit a value into a fixed budget.
 * @param {unknown} value raw value.
 * @param {number} limit maximum characters.
 * @returns {string} cleaned text, or '' when there is nothing to show.
 */
function clip(value, limit) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/gu, ' ').trim()
  if (text === '') return ''
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/**
 * Normalise an explicit title.
 * @param {unknown} value caller supplied title.
 * @returns {string} title, or '' when empty.
 */
export function normalizeTitle(value) {
  return clip(value, TITLE_LIMIT)
}

/**
 * Derive a title from a prompt or a content-block array.
 * @param {unknown} value prompt string or content blocks.
 * @returns {string} title, or '' when there is no text block.
 */
export function titleFromPrompt(value) {
  if (typeof value === 'string') return clip(value, TITLE_LIMIT)
  if (!Array.isArray(value)) return ''
  const parts = []
  for (const block of value) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return clip(parts.join(' '), TITLE_LIMIT)
}

/**
 * Normalise the description of the machine that started a conversation.
 * @param {unknown} value `{ id?, name?, ip?, source? }`.
 * @returns {{id?: string, name?: string, ip?: string, source?: string}|null} initiator or null.
 */
export function normalizeInitiator(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const initiator = {}
  for (const key of ['id', 'name', 'ip', 'source']) {
    const text = clip(value[key], INITIATOR_LIMIT)
    if (text !== '') initiator[key] = text
  }
  return initiator.id === undefined && initiator.name === undefined ? null : initiator
}

/**
 * Slim projection persisted to disk. Events, clients, and the SDK receipt stay
 * in memory only.
 * @param {object} conversation runtime conversation.
 * @returns {object} serialisable record.
 */
export function conversationRecord(conversation) {
  return {
    id: conversation.id,
    sessionId: conversation.sessionId,
    title: conversation.title ?? '',
    initiator: conversation.initiator ?? null,
    status: conversation.status,
    cwd: conversation.cwd,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastText: clip(conversation.lastText, PREVIEW_LIMIT),
    turns: Number.isSafeInteger(conversation.turns) ? conversation.turns : 0,
  }
}
