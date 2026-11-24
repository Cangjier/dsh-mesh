import { randomUUID } from 'node:crypto'

/**
 * After-turn delegation guard.
 *
 * A model sometimes ends a turn saying it will hand work to a member (or wait
 * for one) without actually calling `call_member`. This guard watches sessions
 * that have delegated at least once, and after every turn:
 *
 * - a turn that called `call_member` resets the consecutive-reminder count;
 * - otherwise the newest member conversation for that session is checked;
 *   a conversation still running means the model is already being served;
 * - the turn's final assistant text is judged by one small LLM call; when it
 *   reads as "expected to call the member", a user-role reminder is queued back
 *   into the same session so the model gets one more chance to call it.
 *
 * At most {@link MAX_REMINDERS} consecutive reminders are sent per session.
 *
 * @module @local/dsh-mesh/turn-guard
 */

/** Consecutive reminders allowed before the guard gives up on a session. */
const MAX_REMINDERS = 3

/** Bound for the classification call; a slow judge must not wedge the guard. */
const JUDGE_TIMEOUT_MS = 15_000

/** Instructions for the one-shot classifier. */
const JUDGE_SYSTEM = [
  '你在检查一个编码 agent 的一轮回复是否漏掉了 call_member 调用。这一轮没有调用 call_member。',
  '如果回复表示它要把工作交给成员、让成员去做、等成员结果、或已经安排成员处理，回答 YES。',
  '如果只是回答用户、说明自己已经做完、提问、或明确不需要成员，回答 NO。',
  '只回答 YES 或 NO。',
].join('\n')

/**
 * Install the after-turn guard.
 * @param {{ctx: any, memberTasks: any, log?: (line: string) => void}} options host context, task service, logger.
 * @returns {{dispose: () => void}} guard handle.
 */
export function createTurnGuard({ ctx, memberTasks, log = () => {} }) {
  /** @type {Map<string, boolean>} session id -> has ever called call_member */
  const delegated = new Map()
  /** @type {Map<string, number>} session id -> consecutive reminders sent */
  const reminders = new Map()
  /** @type {Map<string, {turn: number|null, called: boolean, text: string}>} per-session turn state */
  const turns = new Map()
  /** @type {Set<string>} sessions with a judgement in flight */
  const judging = new Set()
  const disposers = []
  let closed = false

  /**
   * One session's live turn accumulator.
   * @param {string} id session id.
   * @returns {{turn: number|null, called: boolean, text: string}} state.
   */
  function stateOf(id) {
    let state = turns.get(id)
    if (state === undefined) {
      state = { turn: null, called: false, text: '' }
      turns.set(id, state)
    }
    return state
  }

  /**
   * Text of one assistant message.
   * @param {unknown} message raw assistant message.
   * @returns {string} joined text.
   */
  function textOf(message) {
    const content = message?.content
    if (!Array.isArray(content)) return ''
    return content
      .filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
      .trim()
  }

  /**
   * Whether the text reads as "intended to hand this to a member".
   * @param {string} sessionId session id (attribution only).
   * @param {any} agent live agent whose route is reused.
   * @param {string} reply final assistant text of the turn.
   * @returns {Promise<boolean>} judge verdict.
   */
  async function judge(sessionId, agent, reply) {
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (llm === undefined || typeof llm.prepareCall !== 'function') return false
    const provider = agent?.options?.provider
    const model = agent?.options?.model
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return false
    const signal = AbortSignal.timeout(JUDGE_TIMEOUT_MS)
    try {
      const call = await llm.prepareCall({ provider, model, maxTokens: 256 }, signal)
      let answer = ''
      for await (const chunk of call.stream({
        ...call.config,
        system: JUDGE_SYSTEM,
        messages: [{
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: `这一轮的回复：\n${reply.slice(0, 6000)}` }],
          source: { kind: 'user' },
        }],
        sessionId,
        purpose: 'mesh-turn-guard',
        signal,
      })) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') answer += chunk.text
        if (answer.length > 64) break
      }
      return /^\s*YES\b/iu.test(answer)
    } catch (error) {
      log(`turn guard judge failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * Check one finished turn and maybe queue a reminder.
   * @param {any} session session the turn belongs to.
   * @param {number|null} turn turn number.
   * @param {string} reply final assistant text.
   * @returns {Promise<void>} resolution after the check.
   */
  async function consider(session, turn, reply) {
    const sessionId = String(session?.id ?? '')
    if (sessionId === '' || reply === '' || closed) return
    if (judging.has(sessionId)) return
    judging.add(sessionId)
    try {
      await considerTurn(session, sessionId, turn, reply)
    } finally {
      judging.delete(sessionId)
    }
  }

  /**
   * Body of {@link consider}, serialized per session.
   * @param {any} session session.
   * @param {string} sessionId session id.
   * @param {number|null} turn turn number.
   * @param {string} reply final assistant text.
   * @returns {Promise<void>} resolution after the check.
   */
  async function considerTurn(session, sessionId, turn, reply) {
    const state = stateOf(sessionId)
    if (state.turn !== turn || state.called) return
    let task
    if (delegated.get(sessionId) !== true) {
      // The cache starts empty (and survives only this process); a false entry is
      // re-checked once per turn against the durable task table.
      task = await memberTasks.latestForOrigin(sessionId)
      if (task === undefined) {
        delegated.set(sessionId, false)
        return
      }
      delegated.set(sessionId, true)
    }
    task = task ?? (await memberTasks.latestForOrigin(sessionId))
    if (task === undefined) return
    if (task.status === 'running' || task.status === 'starting') return
    if ((reminders.get(sessionId) ?? 0) >= MAX_REMINDERS) return
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
    if (agent === undefined || agent === null) return
    if (!(await judge(sessionId, agent, reply))) return
    // The session may have moved on while the judge ran.
    if (closed || state.turn !== turn || state.called) return
    if ((reminders.get(sessionId) ?? 0) >= MAX_REMINDERS) return
    if (agent.status !== 'idle') return
    const count = (reminders.get(sessionId) ?? 0) + 1
    reminders.set(sessionId, count)
    const lastPrompt = typeof task.lastPrompt === 'string' && task.lastPrompt !== ''
      ? task.lastPrompt.replace(/\s+/gu, ' ').slice(0, 300)
      : ''
    const lines = [
      '[成员任务提醒] 你上一轮的回复看起来准备把工作交给成员或等待成员结果，但这一轮没有实际调用 call_member。',
      `最近一次成员对话：${task.member}（${task.memberIp}），会话id：${task.conversationId}`,
      ...(lastPrompt === '' ? [] : [`最近一次投递：${lastPrompt}`]),
      '如果还需要这个成员继续，请调用 call_member（带同一个 conversationId），再用 wait_member 取结果；如果不需要，请直接回答用户。',
      `这是第 ${String(count)}/${String(MAX_REMINDERS)} 次连续提醒，调用过 call_member 后会重置。`,
    ]
    try {
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: lines.join('\n') }],
        source: { kind: 'user' },
      })
      log(`turn guard reminder ${String(count)}/${String(MAX_REMINDERS)} queued in ${sessionId}`)
    } catch (error) {
      reminders.set(sessionId, count - 1)
      log(`turn guard reminder failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Handle one session event.
   * @param {any} session session.
   * @param {any} event session event.
   * @returns {void}
   */
  function onEvent(session, event) {
    if (closed || session === undefined || event === undefined) return
    const id = String(session.id ?? '')
    if (id === '') return
    if (event.type === 'turn/start') {
      const state = stateOf(id)
      state.turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : null
      state.called = false
      state.text = ''
      return
    }
    if (event.type === 'tool/call') {
      if (event.data?.name !== 'call_member') return
      const state = stateOf(id)
      state.called = true
      delegated.set(id, true)
      reminders.set(id, 0)
      return
    }
    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message)
      if (text !== '') stateOf(id).text = text
      return
    }
    if (event.type === 'turn/end') {
      const state = stateOf(id)
      const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : state.turn
      const called = state.called
      const reply = state.text
      state.turn = turn
      state.called = false
      state.text = ''
      if (called) {
        reminders.set(id, 0)
        return
      }
      void consider(session, turn, reply).catch(error => {
        log(`turn guard check failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }

  if (typeof ctx.on === 'function') {
    disposers.push(ctx.on('session/event', onEvent))
    disposers.push(ctx.on('session/disposed', session => {
      const id = String(session?.id ?? '')
      if (id !== '') {
        turns.delete(id)
        delegated.delete(id)
        reminders.delete(id)
      }
    }))
  }

  return {
    dispose() {
      closed = true
      for (const dispose of disposers.splice(0)) {
        try { dispose?.() } catch { }
      }
      turns.clear()
      delegated.clear()
      reminders.clear()
      judging.clear()
    },
  }
}
