/**
 * Request-time member status context.
 *
 * A conversation that delegated to members should not have to remember to ask
 * `status_member`/`wait_member` in every turn. Once it has running member
 * conversations, each of its steps may carry a snapshot of every conversation
 * it tracks: id, state (进行中 / 空闲 / 异常中止), workspace and turn.
 *
 * The snapshot is attached to `decision.messages` from an `agent/pre-step`
 * listener, exactly like the harness's time-context plugin:
 *
 * - it opens no turn and never calls `followup` / `steer`;
 * - it is request-only context, not a chat message the user typed;
 * - one injection per session per {@link MEMBER_STATUS_INTERVAL_MS};
 * - a failure is logged and swallowed so the agent loop is never affected.
 *
 * @module @local/dsh-mesh/member-context
 */

import { randomUUID } from 'node:crypto'
import { describeMemberTask } from './member-tasks.mjs'

/** Minimum distance between two status snapshots in one session. */
export const MEMBER_STATUS_INTERVAL_MS = 30_000

/** Source kind of the injected message; it must never read as user input. */
export const MEMBER_STATUS_SOURCE = 'mesh-member-status'

/**
 * Render one status snapshot for the model.
 *
 * Statuses are the initiator's task states, matching the documented mapping:
 * running/starting = 进行中, completed = 空闲, failed/interrupted = 异常中止.
 * @param {object[]} tasks every conversation this session tracks.
 * @param {{now?: number}} [options] snapshot time (tests pin it).
 * @returns {string} snapshot text.
 */
export function formatMemberStatusSnapshot(tasks, options = {}) {
  const list = Array.isArray(tasks) ? tasks : []
  const running = list.filter(task => task?.status === 'running' || task?.status === 'starting')
  const at = Number.isFinite(options.now) ? options.now : Date.now()
  const lines = [
    `[成员任务状态] 本对话跟踪 ${String(list.length)} 个成员会话，其中 ${String(running.length)} 个进行中（快照 ${new Date(at).toISOString()}）。`,
  ]
  for (const task of list) {
    const entry = describeMemberTask(task)
    const turn = entry.turns !== null && entry.turns > 0 ? `第 ${String(entry.turns)} 轮` : ''
    lines.push(
      `- ${entry.conversationId}（${entry.member} ${entry.memberIp}，工作区 ${entry.workspace}，${entry.statusLabel}${turn === '' ? '' : `，${turn}`}）`,
    )
  }
  lines.push(
    '继续用 wait_member { "all": true } 等所有进行中的会话：任意一个先返回就立刻返回；也可以只等指定的会话：wait_member { "conversationIds": [...] }。',
  )
  return lines.join('\n')
}

/**
 * Install the pre-step status injection.
 * @param {{ctx: any, memberTasks: any, log?: (line: string) => void, intervalMs?: number, now?: () => number}} options host context, task service, logger and test knobs.
 * @returns {{dispose: () => void, handler: (payload: any, next: () => Promise<any>) => Promise<any>, lastInjection: Map<string, number>}} handle.
 */
export function createMemberContext({ ctx, memberTasks, log = () => {}, intervalMs = MEMBER_STATUS_INTERVAL_MS, now = () => Date.now() }) {
  /** @type {Map<string, number>} session id -> last injection time */
  const lastInjection = new Map()
  const disposers = []
  let closed = false

  /**
   * The status snapshot to append to one step, or null when this step is not
   * eligible.
   * @param {any} agent the agent proposing the step.
   * @returns {Promise<{text: string, at: number}|null>} snapshot.
   */
  async function snapshotFor(agent) {
    const sessionId = String(agent?.session?.id ?? agent?.id ?? '')
    if (sessionId === '') return null
    const running = await memberTasks.inFlightForOrigin(sessionId)
    if (!Array.isArray(running) || running.length === 0) return null
    const at = now()
    const last = lastInjection.get(sessionId)
    if (typeof last === 'number' && Number.isFinite(last) && at >= last && at - last < intervalMs) return null
    const tasks = await memberTasks.listForOrigin(sessionId)
    return { text: formatMemberStatusSnapshot(tasks, { now: at }), at }
  }

  /**
   * One pre-step waterfall listener.
   * @param {any} payload pre-step payload.
   * @param {() => Promise<any>} next downstream decision.
   * @returns {Promise<any>} decision, with the snapshot appended when eligible.
   */
  async function handler(payload, next) {
    const decision = await next()
    if (closed || decision?.kind === 'reject' || payload?.signal?.aborted) return decision
    try {
      const snapshot = await snapshotFor(payload?.agent)
      if (snapshot === null) return decision
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: snapshot.text }],
        // Deliberately not `user`: this is injected context, not input the
        // human sent, and the source keeps it distinguishable in the request.
        source: {
          kind: MEMBER_STATUS_SOURCE,
          form: 'snapshot',
          sections: [{ name: MEMBER_STATUS_SOURCE, text: snapshot.text }],
        },
      }
      lastInjection.set(String(payload.agent?.session?.id ?? payload.agent?.id ?? ''), snapshot.at)
      return { ...decision, messages: [...(Array.isArray(decision.messages) ? decision.messages : []), message] }
    } catch (error) {
      // Context is a convenience: a failed member task read must never reject
      // the step or break the agent loop.
      log(`member status context skipped: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  }

  if (typeof ctx?.on === 'function') {
    disposers.push(ctx.on('agent/pre-step', handler, { prepend: true }))
    disposers.push(ctx.on('session/disposed', session => {
      const id = String(session?.id ?? '')
      if (id !== '') lastInjection.delete(id)
    }))
  }

  return {
    handler,
    lastInjection,
    dispose() {
      closed = true
      for (const dispose of disposers.splice(0)) {
        try { dispose?.() } catch { }
      }
      lastInjection.clear()
    },
  }
}
