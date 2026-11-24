/**
 * Which live DSH sessions are member conversations.
 *
 * The interop service creates a session per delegated member conversation.
 * Those sessions must never receive the proactive member-status push: the
 * initiator owns the status snapshot, and a member conversation has no user to
 * report to. The registry is in-memory state shared by the interop service and
 * the member context inside the same plugin process.
 *
 * @module @local/dsh-mesh/member-sessions
 */

/** @type {Set<string>} session ids created by the interop service */
const memberSessions = new Set()

/**
 * Remember one interop-created session.
 * @param {unknown} sessionId session id.
 * @returns {void}
 */
export function markMemberSession(sessionId) {
  const id = String(sessionId ?? '').trim()
  if (id !== '') memberSessions.add(id)
}

/**
 * Forget one interop-created session.
 * @param {unknown} sessionId session id.
 * @returns {void}
 */
export function unmarkMemberSession(sessionId) {
  memberSessions.delete(String(sessionId ?? '').trim())
}

/**
 * Whether a session belongs to a member conversation.
 * @param {unknown} sessionId session id.
 * @returns {boolean} true for an interop-created member session.
 */
export function isMemberSession(sessionId) {
  return memberSessions.has(String(sessionId ?? '').trim())
}

/** Forget every remembered session; used when the interop service shuts down. */
export function clearMemberSessions() {
  memberSessions.clear()
}
