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

/** Status of a conversation whose turn died with the service that owned it. */
export const INTERRUPTED_STATUS = 'interrupted'

/** Why a restored conversation is no longer running. */
export const INTERRUPTED_ERROR = 'interrupted by a DSH restart; send a message to resume this conversation'

/** Persisted statuses that mean a turn was in flight when the service stopped. */
const ABANDONED_STATUSES = new Set(['running', 'starting', 'unavailable'])

/**
 * Turn one persisted record back into a conversation after a restart.
 *
 * A turn that was in flight when the service stopped cannot resume: the SDK
 * child that owned it died with the service. Such a conversation comes back as
 * `interrupted` with a reason, so the panel and any waiting member see an
 * interruption instead of an empty, falsely idle conversation.
 * @param {object} record persisted record written by {@link conversationRecord}.
 * @param {string} workdir fallback working directory.
 * @returns {object} conversation without its runtime-only fields.
 */
export function restoredConversation(record, workdir) {
  const status = typeof record?.status === 'string' ? record.status : 'idle'
  const abandoned = ABANDONED_STATUSES.has(status)
  return {
    id: String(record.id),
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : String(record.id),
    cwd: typeof record.cwd === 'string' ? record.cwd : workdir,
    status: abandoned ? INTERRUPTED_STATUS : status,
    title: typeof record.title === 'string' ? record.title : '',
    initiator: normalizeInitiator(record.initiator),
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
    lastText: typeof record.lastText === 'string' ? record.lastText : '',
    error: abandoned ? INTERRUPTED_ERROR : null,
    turns: Number.isSafeInteger(record.turns) ? record.turns : 0,
  }
}
