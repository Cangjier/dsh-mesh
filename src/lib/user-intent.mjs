/**
 * Human-intent checks over a conversation's recent user messages.
 *
 * Budgets are the user's lever, so `set_member_scope` may only change a
 * `callMemberBudget` when a recent human message actually asked for it. The
 * check reads the live Session surface and ignores injected context: only
 * messages whose source kind is `user` count.
 *
 * @module @local/dsh-mesh/user-intent
 */

/** How many recent human messages one budget-authorisation check reads. */
export const BUDGET_AUTH_MESSAGE_WINDOW = 8

/**
 * The visible text of one message.
 * @param {object|null|undefined} message user message.
 * @returns {string} joined text blocks, trimmed.
 */
export function userMessageText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/**
 * The most recent human messages of one conversation, newest first.
 *
 * Injected member context and this plugin's own nudges carry a non-`user`
 * source kind; they must never authorize a budget change.
 * @param {any} agent live agent.
 * @param {number} [limit] maximum messages to return.
 * @returns {object[]} messages, newest first.
 */
export function recentHumanUserMessages(agent, limit = BUDGET_AUTH_MESSAGE_WINDOW) {
  const session = agent?.session
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []
  if (nodes.length === 0 || typeof session?.eventAt !== 'function') return []
  const messages = []
  for (let index = nodes.length - 1; index >= 0 && messages.length < limit; index -= 1) {
    const event = session.eventAt(nodes[index])
    if (event?.type !== 'user/message') continue
    const message = event.data
    if (message?.role !== 'user' || message?.source?.kind !== 'user') continue
    if (userMessageText(message) === '') continue
    messages.push(message)
  }
  return messages
}

/**
 * Whether one human message asks to change a call_member budget.
 *
 * A budget change needs the budget term, an adjustment verb and a number in
 * the same message: "把 A 阶段预算调到 26" authorises, "预算用完了" does not.
 * A negation directly in front of the verb ("不要调整") cancels it.
 * @param {unknown} text message text.
 * @returns {boolean} true when the text is a budget-change instruction.
 */
export function isBudgetAdjustmentText(text) {
  const value = typeof text === 'string' ? text : ''
  if (!/(预算|call[\s_-]*member|callMemberBudget)/iu.test(value)) return false
  if (/(不要|不用|别|无需|先不|暂不)[^。；;！!\n]{0,4}(调整|修改|设置|设定|改|调|提高|降低|增加|减少)/u.test(value)) {
    return false
  }
  if (!/(调整|修改|设置|设定|改成|改为|设为|调到|调成|提到|提高到|降到|降低到|增加到|减少到|加到|定为)/u.test(value)) {
    return false
  }
  return /\d/u.test(value)
}

/**
 * Whether any recent human message authorises a budget change.
 * @param {any} agent live agent.
 * @param {number} [limit] message window.
 * @returns {boolean} true when an authorising message is present.
 */
export function hasBudgetInstructionFromUser(agent, limit = BUDGET_AUTH_MESSAGE_WINDOW) {
  return recentHumanUserMessages(agent, limit)
    .some(message => isBudgetAdjustmentText(userMessageText(message)))
}
