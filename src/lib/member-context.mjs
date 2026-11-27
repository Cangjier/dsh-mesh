/**
 * Member context: the pre-step snapshot.
 *
 * A conversation that delegated to members should not have to remember to ask
 * `status_member`/`wait_member` in every turn. Once it has tracked member
 * conversations, each of its steps may carry the big-stage definitions, the
 * product stage (version, A/B/C/D stage, goals, call_member budget,
 * participation and the next `set_product_stage` calls), the conversation's
 * own identity/work scope, and the tracked conversations' identity/workspace:
 *
 * - the snapshot is request-only context attached to `decision.messages` from
 *   an `agent/pre-step` listener, at most once per
 *   {@link MEMBER_STATUS_INTERVAL_MS};
 * - member conversation statuses (进行中 / 空闲 / 异常中止) are not part of it;
 *   `status_member` answers that question when it is actually asked;
 * - a running member conversation, a long job kept by `avoidLongJobs`, a roster
 *   gap in `.coder/members/all.md`, or an active product stage makes the step
 *   eligible;
 * - when the self scope sets `callMemberBudget`, the stage block counts the
 *   replies accepted this round and, once the budget is spent, insists on
 *   moving to the next stage and updating the stage state;
 * - when the self scope sets `avoidLongJobs`, the snapshot names the settled
 *   jobs longer than {@link LONG_JOB_WARN_MS} since the previous snapshot and
 *   recommends delegating that work to a member conversation;
 * - member conversations are excluded from the snapshot via
 *   {@link isMemberSession};
 * - with the self scope's `keep` on, a turn end with no running member
 *   conversation delivers one user message (default "继续", overridable with
 *   `keepPrompt`) to keep the conversation going; the turn that message starts
 *   does not nudge again, so the nudge cannot feed itself;
 * - a failure is logged and swallowed so the agent loop is never affected.
 *
 * @module @local/dsh-mesh/member-context
 */

import { randomUUID } from 'node:crypto'
import { memberTaskProfile } from './member-tasks.mjs'
import { isMemberSession } from './member-sessions.mjs'
import { DEFAULT_COMPRESS_PERCENT, effectiveCompressPercent } from './service.mjs'
import { formatMemberGapLines, memberRosterGaps, readMemberRoster } from './member-roster.mjs'
import { formatCallMemberBudgetSettings, formatProductStageDefinitions, formatProductStageLines } from './product-stage.mjs'

/** Minimum distance between two status snapshots in one session. */
export const MEMBER_STATUS_INTERVAL_MS = 60_000
/** A settled job longer than this is worth delegating to a member conversation. */
export const LONG_JOB_WARN_MS = 60_000

/** How long a member-host snapshot is reused when excusing a roster gap. */
const HOST_CACHE_MS = 5 * 60_000

/** How many long-job records one session keeps between snapshots. */
const LONG_JOBS_MAX = 20

/** Source kind of the injected/pushed message; it must never read as user input. */
export const MEMBER_CONTEXT_SOURCE = 'member-context'

/** The default message a `keep` turn end delivers. */
export const DEFAULT_KEEP_PROMPT = '继续'

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
 * The project directory one agent's session runs in.
 * @param {any} agent live agent.
 * @returns {string} absolute directory, or '' when unknown.
 */
function agentCwd(agent) {
  const session = agent?.session
  const cwd = session?.header?.cwd ?? session?.meta?.cwd ?? session?.cwd
  return typeof cwd === 'string' ? cwd.trim() : ''
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
 * Render the current conversation's own settings line.
 * @param {string} selfId current conversation id.
 * @param {object|null} selfScope stored self scope.
 * @returns {string} the bullet line.
 */
function formatSelfLine(selfId, selfScope) {
  // The identity answers "who am I" first.
  const keep = selfScope?.keep === true
  const keepPrompt = typeof selfScope?.keepPrompt === 'string' && selfScope.keepPrompt !== ''
    ? selfScope.keepPrompt
    : DEFAULT_KEEP_PROMPT
  const budget = formatCallMemberBudgetSettings(selfScope?.callMemberBudget)
  return `- 身份：${selfScope?.identity ?? '未设置'}（自身，会话 ${selfId === '' ? 'unknown' : selfId}）；工作范围：${selfScope?.scope ?? '未设置'}；保持目标：${keep ? `开启（只对主对话生效，提示语「${keepPrompt}」）` : '关闭（只对主对话生效）'}；避免耗时：${selfScope?.avoidLongJobs === true ? '开启' : '关闭'}（只对主对话生效）；call_member 预算：${budget}（只对主对话生效，每个大阶段单独计；未设置按参与成员数 × 2）；压缩阈值：${formatMemberPercent(effectiveCompressPercent(selfScope))}`
}

/**
 * Render one status snapshot for the model.
 *
 * The snapshot leads with the big-stage definitions, then the product stage
 * (version, round, goals, budget, participation and the possible next moves),
 * then the conversation's own settings and the roster gaps. It does not list
 * the tracked member conversations: identity, workspace, status and turn are
 * all left to `call_member` / `wait_member` / `status_member` results.
 * @param {object[]} tasks every conversation this session tracks.
 * @param {{selfId?: string, selfScope?: object|null, scopes?: Record<string, object>, longJobs?: object[], gaps?: string[], stage?: object|null}} [options] snapshot facts.
 * @returns {string} snapshot text.
 */
export function formatMemberStatusSnapshot(tasks, options = {}) {
  const list = Array.isArray(tasks) ? tasks : []
  const selfId = String(options.selfId ?? '')
  const selfScope = options.selfScope ?? null
  const scopes = options.scopes ?? {}
  const gapLines = Array.isArray(options.gaps) ? options.gaps : []
  const stage = options.stage ?? null
  // The stage block follows the definitions: it answers what version and round
  // the conversation is working on before it lists who answered.
  const stageLines = stage === null
    ? (list.length === 0 ? [] : ['- 还没有设置产品阶段：用 set_product_stage 设置版本、阶段与目标（如 { "stage": "A" }）。'])
    : formatProductStageLines(stage, list, scopes, {
        callMemberBudget: selfScope?.callMemberBudget,
        statuses: false,
      })
  const lines = [
    ...formatProductStageDefinitions(),
    ...stageLines,
    formatSelfLine(selfId, selfScope),
    ...gapLines,
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
  const selfHint = formatSelfScopeMissingHint(selfScope)
  if (selfHint !== '') lines.push(selfHint)
  return lines.join('\n')
}

/**
 * Install the pre-step status injection.
 * @param {{
 *   ctx: any,
 *   memberTasks: any,
 *   service?: {memberScopes?: () => Promise<Record<string, object>>, productStage?: (cwd: string) => Promise<object|null>},
 *   log?: (line: string) => void,
 *   intervalMs?: number,
 *   now?: () => number,
 * }} options host context, task service, scope/stage stores, logger and test knobs.
 * @returns {object} handle with the listener, maps and disposal.
 */
export function createMemberContext({
  ctx,
  memberTasks,
  service,
  log = () => {},
  intervalMs = MEMBER_STATUS_INTERVAL_MS,
  now = () => Date.now(),
}) {
  /** @type {Map<string, number>} session id -> last injection time */
  const lastInjection = new Map()
  /** @type {Map<string, number|null>} session id -> current/ended turn */
  const turns = new Map()
  /** @type {Set<string>} sessions whose keep nudge started a turn not ended yet */
  const keepPending = new Set()
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
   * The product stage of the project one agent runs in, or null.
   * @param {any} agent live agent.
   * @returns {Promise<object|null>} stage state.
   */
  async function stageFor(agent) {
    if (typeof service?.productStage !== 'function') return null
    const cwd = agentCwd(agent)
    if (cwd === '') return null
    return await service.productStage(cwd).catch(() => null)
  }

  /** Recent member-host rows, reused while excusing a roster gap. */
  let hostsCache = { at: 0, rows: null }

  /**
   * The member rows, for deciding whether a roster gap is creatable.
   * @returns {Promise<object[]|null>} rows, or null when the service cannot tell.
   */
  async function memberHosts() {
    if (hostsCache.rows !== null && now() - hostsCache.at < HOST_CACHE_MS) return hostsCache.rows
    const read = typeof service?.members === 'function' ? service.members : null
    if (read === null) return null
    const snapshot = await read.call(service).catch(() => null)
    if (snapshot === null || typeof snapshot !== 'object') return null
    const rows = [snapshot.local, ...(Array.isArray(snapshot.members) ? snapshot.members : [])]
      .filter(row => row !== null && row !== undefined && typeof row === 'object')
    hostsCache = { at: now(), rows }
    return rows
  }

  /**
   * The `.coder/members/all.md` gaps for one conversation.
   * @param {any} agent live agent (its session names the project directory).
   * @param {object[]} tasks tracked conversations.
   * @param {Record<string, object>} scopes conversation id -> stored scope.
   * @returns {Promise<{total: number, missing: object[], excused: object[]}|null>} gaps.
   */
  async function rosterGaps(agent, tasks, scopes) {
    const cwd = agentCwd(agent)
    if (cwd === '') return null
    const roster = await readMemberRoster(cwd).catch(() => null)
    if (roster === null) return null
    // Only ask the service about hosts when the roster actually has a gap.
    const covered = new Set()
    for (const task of tasks) {
      const workspace = typeof task?.workspace === 'string' ? task.workspace.trim() : ''
      if (workspace !== '' && workspace !== 'unknown') covered.add(workspace)
    }
    const uncovered = roster.members.some(member => !covered.has(member.workspace))
    const hosts = uncovered ? await memberHosts() : []
    return memberRosterGaps(roster, tasks, scopes, { hosts: Array.isArray(hosts) ? hosts : [] })
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
    const [running, stage] = await Promise.all([
      memberTasks.inFlightForOrigin(sessionId),
      stageFor(agent),
    ])
    if (!Array.isArray(running)) return null
    const [tasks, scopes] = await Promise.all([
      memberTasks.listForOrigin(sessionId),
      readScopes(),
    ])
    const selfScope = scopes[sessionId] ?? null
    // A long job can be worth reporting even when no member conversation is
    // running, so the buffer, not the running list, decides that case.
    const taken = takeLongJobs(sessionId, at, last)
    // Consuming the buffer at every snapshot keeps the window honest even when
    // the option is off; only an explicit avoidLongJobs turns it into a hint.
    const hintJobs = selfScope?.avoidLongJobs === true ? taken : []
    const gaps = await rosterGaps(agent, tasks, scopes)
    const gapLines = formatMemberGapLines(gaps)
    // An active product stage is its own reason to speak: it carries the
    // version, the goals, and who still owes this round an answer.
    if (running.length === 0 && hintJobs.length === 0 && gapLines.length === 0 && stage === null) return null
    return {
      text: formatMemberStatusSnapshot(tasks, { now: at, selfId: sessionId, selfScope, scopes, longJobs: hintJobs, gaps: gapLines, stage }),
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
   * Deliver the one-word "继续" nudge after a turn ends with nothing running.
   *
   * Only an explicit `keep: true` opts in, and only when the conversation
   * tracks no running/starting member conversation: the nudge is meant to keep
   * the main conversation working while its members are idle, not to interrupt
   * a delegation that is still in flight. The turn the nudge starts is marked,
   * so its own end does not nudge again; the next real turn can.
   * @param {string} sessionId session id.
   * @param {number|null} turn the turn that just ended.
   * @returns {Promise<void>} resolution after the attempt.
   */
  async function maybeKeep(sessionId, turn) {
    if (closed) return
    const scopes = await readScopes()
    if (closed || turns.get(sessionId) !== turn) return
    if ((scopes[sessionId] ?? null)?.keep !== true) return
    const running = await memberTasks.inFlightForOrigin(sessionId).catch(() => null)
    if (!Array.isArray(running)) return
    if (running.length > 0) return
    // `session/event` for `turn/end` fires while the loop still reports the
    // agent as running; let that turn settle so the followup is not queued
    // behind a turn that has already ended.
    await new Promise(resolve => setImmediate(resolve))
    if (closed || turns.get(sessionId) !== turn) return
    const agent = typeof ctx?.get === 'function' ? ctx.get('agents')?.get(sessionId) : undefined
    if (agent === undefined || agent === null || agent.status !== 'idle') return
    const selfScope = scopes[sessionId] ?? null
    const prompt = typeof selfScope?.keepPrompt === 'string' && selfScope.keepPrompt !== ''
      ? selfScope.keepPrompt
      : DEFAULT_KEEP_PROMPT
    try {
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: MEMBER_CONTEXT_SOURCE, form: 'keep' },
      })
      keepPending.add(sessionId)
      log(`member keep push to ${sessionId}: no member conversation is running, prompt "${prompt}"`)
    } catch (error) {
      log(`member keep push failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Handle one session event for the long-job buffer and the keep nudge.
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
      if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return
      recordLongJob(sessionId, {
        jobId: data.jobId,
        kind: data.kind,
        label: data.label,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      })
      return
    }
    if (event.type === 'turn/start') {
      turns.set(sessionId, Number.isSafeInteger(event.data?.turn) ? event.data.turn : null)
      return
    }
    if (event.type !== 'turn/end') return
    const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : (turns.get(sessionId) ?? null)
    turns.set(sessionId, turn)
    // The turn a keep nudge started is the nudge itself: it must not push
    // again, or a conversation with no members running would loop forever.
    if (keepPending.delete(sessionId)) return
    void maybeKeep(sessionId, turn).catch(error => {
      log(`member keep check failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  if (typeof ctx?.on === 'function') {
    disposers.push(ctx.on('agent/pre-step', handler, { prepend: true }))
    disposers.push(ctx.on('session/event', onEvent))
    disposers.push(ctx.on('session/disposed', session => {
      const id = String(session?.id ?? '')
      if (id === '') return
      lastInjection.delete(id)
      turns.delete(id)
      keepPending.delete(id)
      longJobs.delete(id)
    }))
  }

  return {
    handler,
    onEvent,
    lastInjection,
    turns,
    keepPending,
    dispose() {
      closed = true
      for (const dispose of disposers.splice(0)) {
        try { dispose?.() } catch { }
      }
      lastInjection.clear()
      turns.clear()
      keepPending.clear()
      longJobs.clear()
    },
  }
}
