/**
 * Member status context: pre-step snapshots and the idle active push.
 *
 * A conversation that delegated to members should not have to remember to ask
 * `status_member`/`wait_member` in every turn. Once it has running member
 * conversations, each of its steps may carry a snapshot of every conversation
 * it tracks plus its own identity/work scope:
 *
 * - the snapshot is request-only context attached to `decision.messages` from
 *   an `agent/pre-step` listener, at most once per
 *   {@link MEMBER_STATUS_INTERVAL_MS};
 * - after a main-conversation turn ends, if `keep` is explicitly on, the same
 *   snapshot is pushed back with `followup` after {@link MEMBER_PUSH_DELAY_MS}
 *   of quiet, so the model sees completed work without another user message.
 *   `keep` defaults to off: a scope without the flag never pushes;
 * - when the self scope sets `avoidLongJobs`, the snapshot names the settled
 *   jobs longer than {@link LONG_JOB_WARN_MS} since the previous snapshot and
 *   recommends delegating that work to a member conversation;
 * - member conversations are excluded from the push via
 *   {@link isMemberSession};
 * - a failure is logged and swallowed so the agent loop is never affected.
 *
 * @module @local/dsh-mesh/member-context
 */

import { randomUUID } from 'node:crypto'
import { describeMemberTask, memberTaskProfile } from './member-tasks.mjs'
import { isMemberSession } from './member-sessions.mjs'
import {
  DEFAULT_COMPRESS_PERCENT,
  DEFAULT_MEMBER_IDLE_PUSH_MS,
  effectiveCompressPercent,
  effectiveMemberIdlePushMs,
} from './service.mjs'

/** Minimum distance between two status snapshots in one session. */
export const MEMBER_STATUS_INTERVAL_MS = 60_000

/** Default quiet time after a main-conversation turn end before the active push. */
export const MEMBER_PUSH_DELAY_MS = DEFAULT_MEMBER_IDLE_PUSH_MS

/** How long one pre-push main-conversation compaction may take. */
const PUSH_COMPACT_TIMEOUT_MS = 180_000

/** A settled job longer than this is worth delegating to a member conversation. */
export const LONG_JOB_WARN_MS = 60_000

/** How many long-job records one session keeps between snapshots. */
const LONG_JOBS_MAX = 20

/** Source kind of the injected/pushed message; it must never read as user input. */
export const MEMBER_CONTEXT_SOURCE = 'member-context'

/**
 * Render a push delay in human-readable form.
 * @param {number} ms delay in milliseconds.
 * @returns {string} "5 分钟" / "30 秒" / "1 分 30 秒".
 */
export function formatMemberPushDelay(ms) {
  const value = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : DEFAULT_MEMBER_IDLE_PUSH_MS
  if (value % 60_000 === 0) return `${String(value / 60_000)} 分钟`
  if (value >= 60_000) {
    const minutes = Math.floor(value / 60_000)
    const seconds = Math.round((value % 60_000) / 1000)
    return `${String(minutes)} 分 ${String(seconds)} 秒`
  }
  return `${String(Math.round(value / 1000))} 秒`
}

/**
 * Resolve the quiet-period delay for one main conversation.
 *
 * An unset `idlePushMs` keeps the injected `pushDelayMs` (the test knob); an
 * explicit one is validated again, so an out-of-range stored value falls back
 * to {@link DEFAULT_MEMBER_IDLE_PUSH_MS} rather than a huge or tiny timeout.
 * @param {{idlePushMs?: number}|null} selfScope stored self scope.
 * @param {number} [pushDelayMs] default/test delay.
 * @returns {number} delay in milliseconds.
 */
export function resolveMemberPushDelayMs(selfScope, pushDelayMs = MEMBER_PUSH_DELAY_MS) {
  if (selfScope?.idlePushMs === undefined) return pushDelayMs
  return effectiveMemberIdlePushMs(selfScope)
}

/**
 * Render a percentage threshold without a trailing `.0`.
 * @param {number} value percentage.
 * @returns {string} "35%" / "12.5%".
 */
export function formatMemberPercent(value) {
  const amount = Number.isFinite(value) ? value : DEFAULT_COMPRESS_PERCENT
  return `${amount >= 100 ? String(Math.round(amount)) : amount.toFixed(1).replace(/\.0$/u, '')}%`
}

/**
 * Measure the main agent's context occupancy, matching the interop service.
 *
 * `projectedTokens` is what the next request would cost; `pressureTokens` is
 * the last provider-reported prompt size. A projection snapshot is preferred,
 * with the token meter as fallback. No live session or no usable numbers means
 * "unmeasured", never an error.
 * @param {any} ctx host context.
 * @param {any} agent live agent.
 * @returns {number|null} percentage, or null when unmeasured.
 */
export function measureMemberContextPercent(ctx, agent) {
  const session = agent?.session
  if (session === undefined || session === null) return null
  const nonNegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  let pressure
  const projections = typeof ctx?.get === 'function' ? ctx.get('sessionProjections') : undefined
  if (typeof projections?.snapshot === 'function') {
    try {
      pressure = projections.snapshot(session, ['contextPressure']).values.contextPressure
    } catch { }
  }
  if (pressure === undefined) {
    const meter = typeof ctx?.get === 'function' ? ctx.get('tokenMeter') : undefined
    if (typeof meter?.contextPressure === 'function') {
      try { pressure = meter.contextPressure(session) } catch { }
    }
  }
  if (pressure === null || typeof pressure !== 'object') return null
  const usedTokens = nonNegative(pressure.projectedTokens) ?? nonNegative(pressure.pressureTokens)
  const maxTokens = nonNegative(pressure.contextWindow)
  if (usedTokens === null || maxTokens === null || maxTokens <= 0) return null
  return Math.round((usedTokens / maxTokens) * 1000) / 10
}

/**
 * Run one compaction of the main conversation before pushing its snapshot.
 *
 * The Web profile keeps the compaction engine inside the agent's isolated
 * preset group; a composition without presets keeps it on the host context.
 * @param {any} ctx host context.
 * @param {any} agent idle main agent.
 * @returns {Promise<{ok: boolean, reason?: string}>} outcome; a failure is only
 *   informational because the push still proceeds.
 */
async function compactMainAgent(ctx, agent) {
  const presets = typeof ctx?.get === 'function' ? ctx.get('agentPresets') : undefined
  const scoped = typeof presets?.serviceFor === 'function' ? presets.serviceFor(agent, 'compaction') : undefined
  const compaction = scoped ?? (typeof ctx?.get === 'function' ? ctx.get('compaction') : undefined)
  if (compaction === undefined || compaction === null || typeof compaction.compactNow !== 'function') {
    return { ok: false, reason: 'no compaction service' }
  }
  if (agent.status !== 'idle') return { ok: false, reason: 'agent is not idle' }
  try {
    const result = await compaction.compactNow(agent, AbortSignal.timeout(PUSH_COMPACT_TIMEOUT_MS))
    return { ok: true, result }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The scope shown for one tracked conversation.
 *
 * A record in `member-scopes.json` (keyed by conversation id) wins; the task
 * profile snapshot is the fallback for conversations created before the store
 * or read from an older task file.
 * @param {object} task task or status entry.
 * @param {Record<string, object>} [scopes] conversation id -> stored scope.
 * @returns {{name: string|null, identity: string|null, scope: string|null}|null} normalised scope.
 */
function scopeForTask(task, scopes = {}) {
  const stored = scopes[String(task?.conversationId ?? '')]
  return stored !== undefined ? memberTaskProfile({ profile: stored }) : memberTaskProfile(task)
}

/**
 * The aggregate line that asks the model to complete missing member scopes.
 *
 * One task is missing when its effective scope has no identity or no scope.
 * The line names every such conversation once, then gives the single next
 * action. The self scope has its own hint.
 * @param {object[]} tasks tracked conversations.
 * @param {Record<string, object>} [scopes] conversation id -> stored scope.
 * @returns {string} hint line, or '' when every conversation has both fields.
 */
export function formatMemberScopeMissingHint(tasks, scopes = {}) {
  const missing = []
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (task === null || typeof task !== 'object') continue
    const profile = scopeForTask(task, scopes)
    if (profile !== null && profile.identity !== null && profile.scope !== null) continue
    const conversationId = String(task.conversationId ?? '')
    const member = String(task.member ?? '')
    const label = conversationId === ''
      ? member
      : member === '' ? conversationId : `${conversationId}（${member}）`
    if (label !== '' && !missing.includes(label)) missing.push(label)
  }
  if (missing.length === 0) return ''
  return `还有成员会话没有身份/工作范围：${missing.join('、')}；下次 call_member 带 identity 和 scope 参数，或用 set_member_scope 设置。`
}

/**
 * The line that asks the model to set the current conversation's own scope.
 * @param {{identity?: string, scope?: string}|null} selfScope stored self scope.
 * @returns {string} hint line, or '' when both fields are set.
 */
export function formatSelfScopeMissingHint(selfScope) {
  if (typeof selfScope?.identity === 'string' && selfScope.identity.trim() !== ''
    && typeof selfScope?.scope === 'string' && selfScope.scope.trim() !== '') return ''
  return '自身还没有身份/工作范围：用 set_member_scope（省略 conversationId 或传 self）设置自身身份和工作范围。'
}

/**
 * Render one job duration in human-readable form.
 * @param {number} ms duration in milliseconds.
 * @returns {string} "45 秒" / "2 分 10 秒" / "3 分钟".
 */
export function formatJobDuration(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0
  if (total < 60) return `${String(total)} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return seconds === 0 ? `${String(minutes)} 分钟` : `${String(minutes)} 分 ${String(seconds)} 秒`
}

/**
 * Render one status snapshot for the model.
 *
 * Statuses are the initiator's task states, matching the documented mapping:
 * running/starting = 进行中, completed = 空闲, failed/interrupted = 异常中止.
 * @param {object[]} tasks every conversation this session tracks.
 * @param {{now?: number, selfId?: string, selfScope?: object|null, scopes?: Record<string, object>, longJobs?: object[]}} [options] snapshot facts (tests pin the time).
 * @returns {string} snapshot text.
 */
export function formatMemberStatusSnapshot(tasks, options = {}) {
  const list = Array.isArray(tasks) ? tasks : []
  const running = list.filter(task => task?.status === 'running' || task?.status === 'starting')
  const at = Number.isFinite(options.now) ? options.now : Date.now()
  const selfId = String(options.selfId ?? '')
  const selfScope = options.selfScope ?? null
  const scopes = options.scopes ?? {}
  const selfIdlePushMs = effectiveMemberIdlePushMs(selfScope)
  const selfCompressPercent = effectiveCompressPercent(selfScope)
  const lines = [
    `[成员上下文] 本对话跟踪 ${String(list.length)} 个成员会话，其中 ${String(running.length)} 个进行中（快照 ${new Date(at).toISOString()}）。`,
    `- 自身（会话 ${selfId === '' ? 'unknown' : selfId}）：身份：${selfScope?.identity ?? '未设置'}；工作范围：${selfScope?.scope ?? '未设置'}；保持目标：${selfScope?.keep === true ? '开启' : '关闭'}（只对主对话生效）；避免耗时：${selfScope?.avoidLongJobs === true ? '开启' : '关闭'}（只对主对话生效）；静默推送：${formatMemberPushDelay(selfIdlePushMs)}（只对主对话生效）；压缩阈值：${formatMemberPercent(selfCompressPercent)}`,
  ]
  for (const task of list) {
    const entry = describeMemberTask(task)
    const profile = scopeForTask(task, scopes)
    const stored = scopes[String(task?.conversationId ?? '')]
    const explicitCompress = typeof stored?.compressPercent === 'number' && Number.isFinite(stored.compressPercent)
      ? `；压缩阈值：${formatMemberPercent(stored.compressPercent)}`
      : ''
    const noteText = typeof stored?.note === 'string' && stored.note.trim() !== ''
      ? `；备注：${stored.note.trim().length > 120 ? `${stored.note.trim().slice(0, 120)}…` : stored.note.trim()}`
      : ''
    const turn = entry.turns !== null && entry.turns > 0 ? `第 ${String(entry.turns)} 轮` : ''
    lines.push(
      `- ${entry.conversationId}（${entry.member} ${entry.memberIp}，工作区 ${entry.workspace}，${entry.statusLabel}${turn === '' ? '' : `，${turn}`}）身份：${profile?.identity ?? '未设置'}；工作范围：${profile?.scope ?? '未设置'}${explicitCompress}${noteText}`,
    )
  }
  const longJobs = Array.isArray(options.longJobs) ? options.longJobs : []
  if (longJobs.length > 0) {
    lines.push(
      `[耗时提醒] 距上一次快照有 ${String(longJobs.length)} 个 job 耗时超过 1 分钟：`,
      ...longJobs.map((job) => {
        const kind = typeof job?.kind === 'string' && job.kind !== '' ? `${job.kind}：` : ''
        const label = typeof job?.label === 'string' && job.label !== '' ? job.label : String(job?.jobId ?? 'job')
        return `- ${kind}${label}（耗时 ${formatJobDuration(job?.durationMs)}）`
      }),
      '推荐把这类耗时工作交给成员对话执行：用 call_member 指定成员和工作区，避免主对话被长任务占用。',
    )
  }
  const memberHint = formatMemberScopeMissingHint(list, scopes)
  if (memberHint !== '') lines.push(memberHint)
  const selfHint = formatSelfScopeMissingHint(selfScope)
  if (selfHint !== '') lines.push(selfHint)
  return lines.join('\n')
}

/**
 * The timestamp-free signature used to deduplicate active pushes.
 *
 * It covers the self scope/keep and every tracked conversation's id, member,
 * status, turns and profile. Same signature means the previous push still
 * describes the current state.
 * @param {{selfId?: string, selfScope?: object|null, tasks?: object[], scopes?: Record<string, object>}} state current snapshot facts.
 * @returns {string} stable signature.
 */
export function formatMemberStatusSignature(state = {}) {
  const tasks = Array.isArray(state.tasks) ? state.tasks : []
  const scopes = state.scopes ?? {}
  return JSON.stringify({
    selfId: String(state.selfId ?? ''),
    self: {
      identity: state.selfScope?.identity ?? null,
      scope: state.selfScope?.scope ?? null,
      keep: state.selfScope?.keep === true,
      avoidLongJobs: state.selfScope?.avoidLongJobs === true,
      idlePushMs: effectiveMemberIdlePushMs(state.selfScope),
      compressPercent: effectiveCompressPercent(state.selfScope),
    },
    tasks: tasks.map((task) => {
      const profile = scopeForTask(task, scopes)
      const stored = scopes[String(task?.conversationId ?? '')]
      return {
        conversationId: String(task?.conversationId ?? ''),
        member: String(task?.member ?? ''),
        status: String(task?.status ?? ''),
        turns: Number.isSafeInteger(task?.turns) ? task.turns : null,
        ...(typeof stored?.compressPercent === 'number' && Number.isFinite(stored.compressPercent)
          ? { compressPercent: stored.compressPercent }
          : {}),
        profile: profile === null
          ? null
          : { name: profile.name, identity: profile.identity, scope: profile.scope },
      }
    }),
  })
}

/**
 * Install the pre-step status injection and the idle active push.
 * @param {{
 *   ctx: any,
 *   memberTasks: any,
 *   service?: {memberScopes?: () => Promise<Record<string, object>>},
 *   log?: (line: string) => void,
 *   intervalMs?: number,
 *   pushDelayMs?: number,
 *   now?: () => number,
 * }} options host context, task service, scope store, logger and test knobs.
 * @returns {object} handle with the listener, maps and disposal.
 */
export function createMemberContext({
  ctx,
  memberTasks,
  service,
  log = () => {},
  intervalMs = MEMBER_STATUS_INTERVAL_MS,
  pushDelayMs = MEMBER_PUSH_DELAY_MS,
  now = () => Date.now(),
}) {
  /** @type {Map<string, number>} session id -> last injection/push time */
  const lastInjection = new Map()
  /** @type {Map<string, ReturnType<typeof setTimeout>>} session id -> pending push timer */
  const pushTimers = new Map()
  /** @type {Map<string, string>} session id -> signature of the last push */
  const lastPushSignature = new Map()
  /** @type {Map<string, number|null>} session id -> current/ended turn */
  const turns = new Map()
  /** @type {Map<string, number>} session id -> scheduling generation */
  const generations = new Map()
  /** @type {Map<string, object[]>} session id -> settled jobs over the warn threshold */
  const longJobs = new Map()
  const disposers = []
  let closed = false

  /**
   * Read the scope store, treating a failure as "nothing set".
   * @returns {Promise<Record<string, object>>} conversation id -> scope.
   */
  async function readScopes() {
    if (typeof service?.memberScopes !== 'function') return {}
    return await service.memberScopes().catch(() => ({}))
  }

  /**
   * Cancel one pending push timer.
   * @param {string} sessionId session id.
   * @returns {void}
   */
  function cancelPush(sessionId) {
    const timer = pushTimers.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    pushTimers.delete(sessionId)
  }

  /**
   * The status snapshot to append to one step, or null when this step is not
   * eligible.
   * @param {any} agent the agent proposing the step.
   * @returns {Promise<{text: string, at: number}|null>} snapshot.
   */
  async function snapshotFor(agent) {
    const sessionId = String(agent?.session?.id ?? agent?.id ?? '')
    if (sessionId === '') return null
    const at = now()
    const last = lastInjection.get(sessionId)
    if (typeof last === 'number' && Number.isFinite(last) && at >= last && at - last < intervalMs) return null
    const running = await memberTasks.inFlightForOrigin(sessionId)
    if (!Array.isArray(running)) return null
    // A long job can be worth reporting even when no member conversation is
    // running, so the buffer, not the running list, decides that case.
    const pendingJobs = (longJobs.get(sessionId)?.length ?? 0) > 0
    if (running.length === 0 && !pendingJobs) return null
    const [tasks, scopes] = await Promise.all([
      memberTasks.listForOrigin(sessionId),
      readScopes(),
    ])
    const selfScope = scopes[sessionId] ?? null
    const taken = takeLongJobs(sessionId, at, last)
    // Consuming the buffer at every snapshot keeps the window honest even when
    // the option is off; only an explicit avoidLongJobs turns it into a hint.
    const hintJobs = selfScope?.avoidLongJobs === true ? taken : []
    if (running.length === 0 && hintJobs.length === 0) return null
    return {
      text: formatMemberStatusSnapshot(tasks, { now: at, selfId: sessionId, selfScope, scopes, longJobs: hintJobs }),
      at,
    }
  }

  /**
   * Record one settled job that crossed the warn threshold.
   * @param {string} sessionId session id.
   * @param {{jobId?: string, kind?: string, label?: string, startedAt: number, finishedAt: number, durationMs: number}} job facts.
   * @returns {void}
   */
  function recordLongJob(sessionId, job) {
    if (!(job.durationMs > LONG_JOB_WARN_MS)) return
    const list = longJobs.get(sessionId) ?? []
    const label = String(job.label ?? '').replace(/\s+/gu, ' ').trim().slice(0, 120)
    list.push({
      jobId: typeof job.jobId === 'string' ? job.jobId : '',
      kind: typeof job.kind === 'string' ? job.kind : '',
      label: label === '' ? String(job.jobId ?? 'job') : label,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      durationMs: job.durationMs,
    })
    if (list.length > LONG_JOBS_MAX) list.splice(0, list.length - LONG_JOBS_MAX)
    longJobs.set(sessionId, list)
  }

  /**
   * Take the long jobs settled in (last snapshot, now] and clear the buffer.
   * @param {string} sessionId session id.
   * @param {number} at current snapshot time.
   * @param {number|undefined} last previous snapshot time.
   * @returns {object[]} long jobs for this snapshot.
   */
  function takeLongJobs(sessionId, at, last) {
    const list = longJobs.get(sessionId)
    if (!Array.isArray(list) || list.length === 0) return []
    longJobs.delete(sessionId)
    const floor = typeof last === 'number' && Number.isFinite(last) ? last : 0
    return list.filter(job => Number.isFinite(job.finishedAt) && job.finishedAt <= at && job.finishedAt > floor)
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
          kind: MEMBER_CONTEXT_SOURCE,
          form: 'snapshot',
          sections: [{ name: MEMBER_CONTEXT_SOURCE, text: snapshot.text }],
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

  /**
   * Arm the quiet-period push after one main-conversation turn ends.
   *
   * Only a session that has a tracked member task or an existing self scope is
   * armed, and anything but an explicit `keep: true` cancels it (`keep`
   * defaults off). The timer is intentionally not awaited by the event
   * listener.
   * @param {string} sessionId session id.
   * @param {number|null} turn turn that just ended.
   * @param {number} generation scheduling generation this call belongs to.
   * @returns {Promise<void>} resolution after scheduling or skipping.
   */
  async function schedulePush(sessionId, turn, generation) {
    if (closed) return
    const [tasks, scopes] = await Promise.all([
      memberTasks.listForOrigin(sessionId).catch(() => []),
      readScopes(),
    ])
    if (closed || generations.get(sessionId) !== generation) return
    if (!turns.has(sessionId) || turns.get(sessionId) !== turn) return
    const selfScope = scopes[sessionId] ?? null
    if (tasks.length === 0 && selfScope === null) return
    if (selfScope?.keep !== true) return
    cancelPush(sessionId)
    // The per-conversation setting wins over the process default; injecting
    // `pushDelayMs` remains the test knob only when no setting is stored.
    const delay = resolveMemberPushDelayMs(selfScope, pushDelayMs)
    const timer = setTimeout(() => {
      pushTimers.delete(sessionId)
      void pushSnapshot(sessionId, turn).catch(error => {
        log(`member status push failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, delay)
    timer.unref?.()
    pushTimers.set(sessionId, timer)
  }

  /**
   * Push the current snapshot if the conversation is still quiet and idle and
   * its content signature changed since the last push.
   * @param {string} sessionId session id.
   * @param {number|null} turn turn that armed the timer.
   * @returns {Promise<void>} resolution after the attempt.
   */
  async function pushSnapshot(sessionId, turn) {
    if (closed) return
    if (turns.get(sessionId) !== turn) return
    const agent = typeof ctx?.get === 'function' ? ctx.get('agents')?.get(sessionId) : undefined
    if (agent === undefined || agent === null || agent.status !== 'idle') return
    const [tasks, scopes] = await Promise.all([
      memberTasks.listForOrigin(sessionId).catch(() => []),
      readScopes(),
    ])
    if (closed || turns.get(sessionId) !== turn) return
    const selfScope = scopes[sessionId] ?? null
    if (tasks.length === 0 && selfScope === null) return
    if (selfScope?.keep !== true) return
    if (agent.status !== 'idle') return
    // Signature first: an unchanged snapshot must not pay for a compaction.
    const signature = formatMemberStatusSignature({ selfId: sessionId, selfScope, tasks, scopes })
    if (lastPushSignature.get(sessionId) === signature) return
    // Measure and, when the main conversation is over its threshold, compact
    // before the push. A missing/failed compaction never blocks the push, but
    // a turn that started meanwhile invalidates this snapshot.
    const threshold = effectiveCompressPercent(selfScope)
    const beforePercent = measureMemberContextPercent(ctx, agent)
    let compressionLine
    if (beforePercent !== null && beforePercent > threshold) {
      const outcome = await compactMainAgent(ctx, agent)
      if (closed || turns.get(sessionId) !== turn || agent.status !== 'idle') {
        log(`member status push abandoned: conversation resumed while compacting (context ${formatMemberPercent(beforePercent)}, threshold ${formatMemberPercent(threshold)})`)
        return
      }
      if (outcome.ok) {
        if (outcome.result === null) {
          compressionLine = `no compactable range（上下文 ${formatMemberPercent(beforePercent)}，阈值 ${formatMemberPercent(threshold)}）`
        } else {
          const afterPercent = measureMemberContextPercent(ctx, agent)
          compressionLine = `compressed ${formatMemberPercent(beforePercent)} -> ${afterPercent === null ? '未测' : formatMemberPercent(afterPercent)}（阈值 ${formatMemberPercent(threshold)}）`
        }
      } else {
        compressionLine = `compression skipped: ${outcome.reason}（上下文 ${formatMemberPercent(beforePercent)}，阈值 ${formatMemberPercent(threshold)}）`
      }
    } else if (beforePercent === null) {
      compressionLine = `context not measured（阈值 ${formatMemberPercent(threshold)}）`
    } else {
      compressionLine = `no compression（上下文 ${formatMemberPercent(beforePercent)} <= 阈值 ${formatMemberPercent(threshold)}）`
    }
    // A slow compaction must not leave the injection clock at the old start
    // time: the snapshot text (and the timestamp used to suppress the next
    // pre-step injection) belongs to the moment the push actually happens.
    // The signature stays the pre-compaction one so a time-only difference
    // never re-pushes.
    const at = now()
    const text = formatMemberStatusSnapshot(tasks, { now: at, selfId: sessionId, selfScope, scopes })
    try {
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: MEMBER_CONTEXT_SOURCE, form: 'push' },
      })
      lastPushSignature.set(sessionId, signature)
      lastInjection.set(sessionId, at)
      log(`member status pushed to ${sessionId}: ${compressionLine}`)
    } catch (error) {
      log(`member status push failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Handle one session event for the active push.
   * @param {any} session session.
   * @param {any} event session event.
   * @returns {void}
   */
  function onEvent(session, event) {
    if (closed || session === undefined || event === undefined) return
    const sessionId = String(session.id ?? '')
    if (sessionId === '' || isMemberSession(sessionId)) return
    if (event.type === 'job/settled') {
      const data = event.data ?? {}
      const startedAt = Number(data.startedAt)
      const finishedAt = Number.isFinite(Number(data.finishedAt)) ? Number(data.finishedAt) : Number(event.time)
      if (Number.isFinite(startedAt) && Number.isFinite(finishedAt)) {
        recordLongJob(sessionId, {
          jobId: data.jobId,
          kind: data.kind,
          label: data.label,
          startedAt,
          finishedAt,
          durationMs: finishedAt - startedAt,
        })
      }
      return
    }
    if (event.type === 'turn/start') {
      turns.set(sessionId, Number.isSafeInteger(event.data?.turn) ? event.data.turn : null)
      generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1)
      cancelPush(sessionId)
      return
    }
    if (event.type !== 'turn/end') return
    const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : (turns.get(sessionId) ?? null)
    turns.set(sessionId, turn)
    const generation = (generations.get(sessionId) ?? 0) + 1
    generations.set(sessionId, generation)
    cancelPush(sessionId)
    void schedulePush(sessionId, turn, generation).catch(error => {
      log(`member status push scheduling failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  if (typeof ctx?.on === 'function') {
    disposers.push(ctx.on('agent/pre-step', handler, { prepend: true }))
    disposers.push(ctx.on('session/event', onEvent))
    disposers.push(ctx.on('session/disposed', session => {
      const id = String(session?.id ?? '')
      if (id === '') return
      cancelPush(id)
      lastInjection.delete(id)
      lastPushSignature.delete(id)
      turns.delete(id)
      generations.delete(id)
      longJobs.delete(id)
    }))
  }

  return {
    handler,
    onEvent,
    lastInjection,
    pushTimers,
    lastPushSignature,
    turns,
    dispose() {
      closed = true
      for (const dispose of disposers.splice(0)) {
        try { dispose?.() } catch { }
      }
      for (const timer of pushTimers.values()) clearTimeout(timer)
      pushTimers.clear()
      lastInjection.clear()
      lastPushSignature.clear()
      turns.clear()
      generations.clear()
      longJobs.clear()
    },
  }
}
