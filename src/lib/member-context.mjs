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
 * - after a main-conversation turn ends, if `keep` is explicitly on and more
 *   than {@link MEMBER_REVIEW_INTERVAL_MS} has passed since the previous review
 *   ended, a dispatch push is delivered with `followup`: it asks the main
 *   conversation to create a subagent that reviews `.coder/members` plus the
 *   current gaps and decides whether any idle member conversation can be
 *   activated, carrying only the tracked conversation lines as facts. There is
 *   no quiet delay any more: the review turn's own `turn/end` anchors the
 *   window. `keep` defaults to off: a scope without the flag never pushes;
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
import { DEFAULT_COMPRESS_PERCENT, effectiveCompressPercent } from './service.mjs'

/** Minimum distance between two status snapshots in one session. */
export const MEMBER_STATUS_INTERVAL_MS = 60_000

/** Minimum time between the end of one member-status review and the next review. */
export const MEMBER_REVIEW_INTERVAL_MS = 10 * 60_000

/** How long one pre-push main-conversation compaction may take. */
const PUSH_COMPACT_TIMEOUT_MS = 180_000

/** A settled job longer than this is worth delegating to a member conversation. */
export const LONG_JOB_WARN_MS = 60_000

/** How many long-job records one session keeps between snapshots. */
const LONG_JOBS_MAX = 20

/** Source kind of the injected/pushed message; it must never read as user input. */
export const MEMBER_CONTEXT_SOURCE = 'member-context'

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
 * Render one tracked conversation line, shared by the snapshot and the push.
 * @param {object} task task or status entry.
 * @param {Record<string, object>} [scopes] conversation id -> stored scope.
 * @returns {string} the bullet line.
 */
function formatMemberConversationLine(task, scopes = {}) {
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
  return `- ${entry.conversationId}（${entry.member} ${entry.memberIp}，工作区 ${entry.workspace}，${entry.statusLabel}${turn === '' ? '' : `，${turn}`}）身份：${profile?.identity ?? '未设置'}；工作范围：${profile?.scope ?? '未设置'}${explicitCompress}${noteText}`
}

/**
 * Render the current conversation's own settings line.
 * @param {string} selfId current conversation id.
 * @param {object|null} selfScope stored self scope.
 * @returns {string} the bullet line.
 */
function formatSelfLine(selfId, selfScope) {
  return `- 自身（会话 ${selfId === '' ? 'unknown' : selfId}）：身份：${selfScope?.identity ?? '未设置'}；工作范围：${selfScope?.scope ?? '未设置'}；保持目标：${selfScope?.keep === true ? '开启' : '关闭'}（只对主对话生效）；避免耗时：${selfScope?.avoidLongJobs === true ? '开启' : '关闭'}（只对主对话生效）；压缩阈值：${formatMemberPercent(effectiveCompressPercent(selfScope))}`
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
  const lines = [
    `[成员上下文] 本对话跟踪 ${String(list.length)} 个成员会话，其中 ${String(running.length)} 个进行中（快照 ${new Date(at).toISOString()}）。`,
    formatSelfLine(selfId, selfScope),
    ...list.map(task => formatMemberConversationLine(task, scopes)),
  ]
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
 * Render the idle dispatch push.
 *
 * The push no longer repeats the status snapshot: the main conversation is
 * idle, so the useful action is a fresh review of the roster and the current
 * gaps. The tracked conversation lines stay in the text because the review
 * needs to know which conversations exist and which are already busy.
 * @param {object[]} tasks every conversation this session tracks.
 * @param {{now?: number, selfId?: string, selfScope?: object|null, scopes?: Record<string, object>}} [options] push facts (tests pin the time).
 * @returns {string} push text.
 */
export function formatMemberDispatchPush(tasks, options = {}) {
  const list = Array.isArray(tasks) ? tasks : []
  const running = list.filter(task => task?.status === 'running' || task?.status === 'starting')
  const at = Number.isFinite(options.now) ? options.now : Date.now()
  const selfId = String(options.selfId ?? '')
  const selfScope = options.selfScope ?? null
  const scopes = options.scopes ?? {}
  return [
    '[成员调度] 本对话已空闲。请立即用 subagent 新建一个子代理做只读审查：读本工作区的 `.coder/members/all.md`、`.coder/members/flow.md` 和现有 gap（`.coder/issues/open.md`、`.coder/plan/todo.md`、`.coder/plan/goal.md` 等），判断是否可以激活部分现有空闲成员对话。',
    '- 子代理只读：不改代码、不跑重活；结论逐条给出可激活的成员会话（conversationId）、建议任务与依据；不建议激活的写原因。',
    '- 只考虑空闲成员会话；进行中/异常中止的一律跳过，禁止重启、归档或新建同名会话——派活必须带原 conversationId 继续。',
    '- 审查结论交回本对话，由本对话用 call_member 决定是否派活。',
    `- 当前成员会话（本对话跟踪 ${String(list.length)} 个，其中 ${String(running.length)} 个进行中；快照 ${new Date(at).toISOString()}）：`,
    ...list.map(task => formatMemberConversationLine(task, scopes)),
    formatSelfLine(selfId, selfScope),
  ].join('\n')
}

/**
 * Install the pre-step status injection and the turn-end review push.
 * @param {{
 *   ctx: any,
 *   memberTasks: any,
 *   service?: {memberScopes?: () => Promise<Record<string, object>>},
 *   log?: (line: string) => void,
 *   intervalMs?: number,
 *   reviewIntervalMs?: number,
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
  reviewIntervalMs = MEMBER_REVIEW_INTERVAL_MS,
  now = () => Date.now(),
}) {
  /** @type {Map<string, number>} session id -> last injection/push time */
  const lastInjection = new Map()
  /** @type {Map<string, number>} session id -> when the last review turn ended */
  const lastReviewEnd = new Map()
  /** @type {Set<string>} sessions whose dispatch push has not seen its turn end yet */
  const reviewPending = new Set()
  /** @type {Map<string, number|null>} session id -> current/ended turn */
  const turns = new Map()
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
   * Review the member conversations after one main-conversation turn ends.
   *
   * There is no quiet delay: a normal turn end evaluates the window since the
   * last review ended and, when it is over {@link MEMBER_REVIEW_INTERVAL_MS},
   * delivers the dispatch instruction. The turn that the dispatch push starts
   * is the review itself, so its `turn/end` records the anchor. Only an
   * explicit `keep: true` opts in; `keep` defaults to off.
   * @param {string} sessionId session id.
   * @param {number|null} turn turn that just ended.
   * @returns {Promise<void>} resolution after the attempt.
   */
  async function maybeReview(sessionId, turn) {
    if (closed) return
    const [tasks, scopes] = await Promise.all([
      memberTasks.listForOrigin(sessionId).catch(() => []),
      readScopes(),
    ])
    if (closed || turns.get(sessionId) !== turn) return
    const selfScope = scopes[sessionId] ?? null
    if (tasks.length === 0 && selfScope === null) return
    if (selfScope?.keep !== true) return
    const last = lastReviewEnd.get(sessionId)
    if (typeof last === 'number' && now() - last <= reviewIntervalMs) return
    // `session/event` for `turn/end` fires while the loop still reports the
    // agent as running; let that turn settle on a macrotask so the agent is
    // idle for the compaction and the dispatch is not queued behind a turn
    // that has already ended.
    await new Promise(resolve => setImmediate(resolve))
    if (closed || turns.get(sessionId) !== turn) return
    const agent = typeof ctx?.get === 'function' ? ctx.get('agents')?.get(sessionId) : undefined
    if (agent === undefined || agent === null || agent.status !== 'idle') return
    // Measure and, when the main conversation is over its threshold, compact
    // before the push. A missing/failed compaction never blocks the push, but
    // a turn that started meanwhile invalidates this review.
    const threshold = effectiveCompressPercent(selfScope)
    const beforePercent = measureMemberContextPercent(ctx, agent)
    let compressionLine
    if (beforePercent !== null && beforePercent > threshold) {
      const outcome = await compactMainAgent(ctx, agent)
      if (closed || turns.get(sessionId) !== turn || agent.status !== 'idle') {
        log(`member dispatch push abandoned: conversation resumed while compacting (context ${formatMemberPercent(beforePercent)}, threshold ${formatMemberPercent(threshold)})`)
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
    // time: the push text (and the timestamp used to suppress the next
    // pre-step injection) belongs to the moment the push actually happens.
    const at = now()
    const text = formatMemberDispatchPush(tasks, { now: at, selfId: sessionId, selfScope, scopes })
    try {
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: MEMBER_CONTEXT_SOURCE, form: 'push' },
      })
      reviewPending.add(sessionId)
      lastInjection.set(sessionId, at)
      log(`member dispatch push to ${sessionId}: ${compressionLine}`)
    } catch (error) {
      log(`member dispatch push failed: ${error instanceof Error ? error.message : String(error)}`)
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
      return
    }
    if (event.type !== 'turn/end') return
    const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : (turns.get(sessionId) ?? null)
    turns.set(sessionId, turn)
    // The turn the dispatch push started is the review itself: its end is the
    // anchor for the next 10-minute window, and it must not push again.
    if (reviewPending.delete(sessionId)) {
      lastReviewEnd.set(sessionId, now())
      return
    }
    void maybeReview(sessionId, turn).catch(error => {
      log(`member status review failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  if (typeof ctx?.on === 'function') {
    disposers.push(ctx.on('agent/pre-step', handler, { prepend: true }))
    disposers.push(ctx.on('session/event', onEvent))
    disposers.push(ctx.on('session/disposed', session => {
      const id = String(session?.id ?? '')
      if (id === '') return
      lastInjection.delete(id)
      lastReviewEnd.delete(id)
      reviewPending.delete(id)
      turns.delete(id)
      longJobs.delete(id)
    }))
  }

  return {
    handler,
    onEvent,
    lastInjection,
    lastReviewEnd,
    reviewPending,
    turns,
    dispose() {
      closed = true
      for (const dispose of disposers.splice(0)) {
        try { dispose?.() } catch { }
      }
      lastInjection.clear()
      lastReviewEnd.clear()
      reviewPending.clear()
      turns.clear()
      longJobs.clear()
    },
  }
}
