/**
 * Pre-upgrade stop messages and the post-restart resume.
 *
 * An automatic upgrade restarts the DSH process, which kills every turn in
 * progress. Ten minutes before it starts, this host asks the conversations it
 * is running to wind down, so nobody loses a half-written commit to the
 * restart:
 *
 * - **leader** (a conversation that called `call_member`): stop every running
 *   member conversation, commit what is ready, stop dispatching, wait;
 * - **member** (a conversation created by another host's `call_member`): stop
 *   and commit; it is not resumed here because its initiator owns it;
 * - **plain** (every other running conversation): stop.
 *
 * Only conversations whose agent is running are touched. The announcement is
 * remembered in `upgrade-plan.json`; after the restart the plugin waits
 * {@link UPGRADE_RESUME_DELAY_MS} and then sends the leader and plain
 * conversations the resume message. Member conversations are skipped: the
 * initiator continues them through `call_member` when it is ready.
 *
 * @module @local/dsh-mesh/upgrade-announce
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isMemberSession } from './member-sessions.mjs'

/** How long before an automatic upgrade the stop messages go out. */
export const UPGRADE_LEAD_MS = 10 * 60_000

/** How long after the restarted plugin comes up the resume messages go out. */
export const UPGRADE_RESUME_DELAY_MS = 2 * 60_000

/** A stop message older than this is not reused for a later prepare call. */
const PLAN_REUSE_MS = UPGRADE_LEAD_MS * 4

/**
 * A plan older than this is not replayed after a restart.
 *
 * A scheduled upgrade announces ten minutes ahead and restarts around the
 * upgrade tick; a manual one announces right before its job starts. A plan
 * that is much older belongs to an upgrade that failed before restarting, so
 * sending "重启成功，请继续。" for it on a later, unrelated restart would be a
 * lie. The plan is consumed instead.
 */
export const UPGRADE_PLAN_MAX_AGE_MS = 30 * 60_000

/** The message a leader conversation gets before an upgrade. */
export const UPGRADE_LEADER_MESSAGE = '请通过call_member停止所有进行中的成员对话，把需要提交的代码进行提交。并停止派发新的任务。dsh准备升级，将会重启。等我通知。'

/** The message a member conversation gets before an upgrade. */
export const UPGRADE_MEMBER_MESSAGE = 'dsh准备升级，请停止，把需要提交的代码进行提交。'

/** The message every other running conversation gets before an upgrade. */
export const UPGRADE_PLAIN_MESSAGE = 'dsh准备升级，请停止。'

/** The message a leader or plain conversation gets after the restart. */
export const UPGRADE_RESUME_MESSAGE = '重启成功，请继续。'

/** Conversation kinds, in the order the panel reports them. */
export const UPGRADE_KINDS = Object.freeze(['leader', 'member', 'plain'])

/**
 * Whether one live agent's session ever called a tool.
 *
 * The call log is the durable record: a conversation resumed after a crash
 * still carries the `tool/call` event, so classification does not depend on
 * this process having seen the call. The read is bounded by the session's own
 * events, which are already in memory.
 * @param {any} agent live agent.
 * @param {string} name tool name.
 * @returns {boolean} true when the session called that tool.
 */
export function sessionCalledTool(agent, name) {
  const session = agent?.session
  if (session === null || session === undefined) return false
  let events
  try {
    events = typeof session.ownEvents === 'function' ? session.ownEvents() : session.snapshotEvents?.(0, session.seq)
  } catch {
    return false
  }
  if (!Array.isArray(events)) return false
  for (const event of events) {
    if (event?.type === 'tool/call' && event?.data?.name === name) return true
  }
  return false
}

/**
 * Classify one running conversation for the pre-upgrade announcement.
 *
 * A member conversation is one this host created for another host's
 * `call_member` — the interop service marks exactly those sessions. Among the
 * rest, a conversation that called `call_member` is a leader; everything else
 * is plain.
 * @param {any} agent live agent.
 * @returns {'leader'|'member'|'plain'} kind.
 */
export function classifyUpgradeConversation(agent) {
  const id = String(agent?.id ?? '')
  if (id === '') return 'plain'
  if (isMemberSession(id)) return 'member'
  return sessionCalledTool(agent, 'call_member') ? 'leader' : 'plain'
}

/**
 * The stop message for one kind.
 * @param {'leader'|'member'|'plain'} kind conversation kind.
 * @returns {string} message text.
 */
export function upgradeMessageFor(kind) {
  if (kind === 'leader') return UPGRADE_LEADER_MESSAGE
  if (kind === 'member') return UPGRADE_MEMBER_MESSAGE
  return UPGRADE_PLAIN_MESSAGE
}

/**
 * Build the user message the agent will read.
 * @param {string} text message body.
 * @returns {object} message.
 */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * Insert one message into a live conversation.
 *
 * Running agents are steered so the model sees the message at the next step
 * boundary of the turn in progress; anything else gets an ordinary follow-up.
 * @param {any} agent live agent.
 * @param {string} text message body.
 * @returns {boolean} whether the message was accepted.
 */
export function injectUpgradeMessage(agent, text) {
  const message = userMessage(text)
  if (agent?.status === 'running' && typeof agent.steer === 'function') {
    try {
      agent.steer(message)
      return true
    } catch {
      // Fall through to the follow-up path.
    }
  }
  try {
    agent?.followup?.(message)
    return true
  } catch {
    return false
  }
}

/**
 * Read the persisted plan.
 * @param {string} file plan path.
 * @returns {Promise<object|null>} plan or null.
 */
export async function readUpgradePlan(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Persist the plan atomically.
 * @param {string} file plan path.
 * @param {object} plan plan.
 * @returns {Promise<void>} when written.
 */
async function writeUpgradePlan(file, plan) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${String(process.pid)}.tmp`
  await writeFile(temporary, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

/**
 * Count the announced conversations by kind.
 * @param {{sessions?: {kind: string}[]}} plan plan.
 * @returns {{leader: number, member: number, plain: number}} counts.
 */
export function upgradePlanCounts(plan) {
  const counts = { leader: 0, member: 0, plain: 0 }
  for (const entry of Array.isArray(plan?.sessions) ? plan.sessions : []) {
    if (typeof entry?.kind === 'string' && Object.hasOwn(counts, entry.kind)) counts[entry.kind] += 1
  }
  return counts
}

/**
 * Announce an imminent upgrade to every running conversation on this host.
 *
 * A plan announced within the last {@link PLAN_REUSE_MS} that was never
 * resumed is reused: a prepare call is idempotent, so a retry or a scheduler
 * tick that fires twice cannot stop the same conversations twice.
 * @param {any} ctx host context.
 * @param {{planFile: string, log?: (line: string) => void, now?: () => number}} options announcement input.
 * @returns {Promise<object>} announcement result.
 */
export async function announceUpgrade(ctx, options) {
  const file = options.planFile
  const log = typeof options.log === 'function' ? options.log : () => {}
  const now = typeof options.now === 'function' ? options.now : Date.now
  const at = now()
  const existing = await readUpgradePlan(file)
  if (existing !== null && existing.resumedAt === null && typeof existing.announcedAt === 'string') {
    const announcedAt = Date.parse(existing.announcedAt)
    if (Number.isFinite(announcedAt) && at - announcedAt < PLAN_REUSE_MS && announcedAt - at < PLAN_REUSE_MS) {
      log(`upgrade announcement reused (${existing.announcedAt})`)
      return {
        ok: true,
        already: true,
        announcedAt: existing.announcedAt,
        counts: upgradePlanCounts(existing),
      }
    }
  }
  const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : ctx?.agents
  const list = typeof agents?.list === 'function' ? agents.list() : []
  const running = list.filter(agent => agent?.status === 'running')
  const counts = { leader: 0, member: 0, plain: 0 }
  const sessions = []
  let announced = 0
  for (const agent of running) {
    const kind = classifyUpgradeConversation(agent)
    const delivered = injectUpgradeMessage(agent, upgradeMessageFor(kind))
    if (!delivered) {
      log(`upgrade announcement could not reach ${String(agent?.id ?? 'unknown')} (${kind})`)
      continue
    }
    counts[kind] += 1
    announced += 1
    // Member conversations belong to their initiator: it hands them the
    // restart news through call_member, so they are not resumed here.
    if (kind !== 'member') sessions.push({ id: String(agent.id), kind })
  }
  const plan = {
    version: 1,
    announcedAt: new Date(at).toISOString(),
    counts,
    sessions,
    resumedAt: null,
  }
  await writeUpgradePlan(file, plan)
  log(`upgrade announced to ${String(announced)} running conversation(s): leader ${String(counts.leader)}, member ${String(counts.member)}, plain ${String(counts.plain)}`)
  return { ok: true, already: false, announced, announcedAt: plan.announcedAt, counts }
}

/**
 * Resume the conversations the announcement stopped.
 *
 * Runs {@link UPGRADE_RESUME_DELAY_MS} after the restarted plugin comes up.
 * Leader and plain conversations get a follow-up turn; a conversation that is
 * already running again (the user came back on their own) is left alone.
 * The plan is marked resumed before the messages go out, so a crash during the
 * resume never sends the same message twice.
 * @param {any} ctx host context.
 * @param {{planFile: string, log?: (line: string) => void, now?: () => number}} options resume input.
 * @returns {Promise<object>} resume result.
 */
export async function resumeUpgradeConversations(ctx, options) {
  const file = options.planFile
  const log = typeof options.log === 'function' ? options.log : () => {}
  const now = typeof options.now === 'function' ? options.now : Date.now
  const plan = await readUpgradePlan(file)
  if (plan === null) return { ok: true, skipped: true, reason: 'no plan' }
  if (typeof plan.resumedAt === 'string' && plan.resumedAt !== '') {
    return { ok: true, skipped: true, reason: 'already resumed' }
  }
  const sessions = Array.isArray(plan.sessions) ? plan.sessions : []
  plan.resumedAt = new Date(now()).toISOString()
  await writeUpgradePlan(file, plan)
  const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : ctx?.agents
  let resumed = 0
  const failed = []
  for (const entry of sessions) {
    const id = String(entry?.id ?? '')
    if (id === '') continue
    try {
      let agent = typeof agents?.get === 'function' ? agents.get(id) : undefined
      if (agent === undefined || agent === null) {
        if (typeof agents?.resume !== 'function') {
          failed.push(id)
          continue
        }
        const handle = await agents.resume({ resumeSessionId: id })
        agent = handle?.agent ?? null
      }
      if (agent === null || agent === undefined) {
        failed.push(id)
        continue
      }
      if (agent.status !== 'idle') {
        log(`upgrade resume skipped ${id}: the conversation is ${String(agent.status)}`)
        continue
      }
      if (injectUpgradeMessage(agent, UPGRADE_RESUME_MESSAGE)) resumed += 1
      else failed.push(id)
    } catch (error) {
      failed.push(id)
      log(`upgrade resume failed for ${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  log(`upgrade resume sent to ${String(resumed)} conversation(s)${failed.length === 0 ? '' : `; ${String(failed.length)} failed`}`)
  return { ok: true, skipped: false, resumed, failed, announcedAt: plan.announcedAt }
}

/**
 * Arm the post-restart resume for the next plugin start.
 *
 * A plan left by an announcement is consumed once: the timer fires
 * {@link UPGRADE_RESUME_DELAY_MS} after the plugin is up, and the plan is
 * marked resumed when it does.
 * @param {any} ctx host context.
 * @param {{planFile: string, log?: (line: string) => void, delayMs?: number, setTimeout?: typeof setTimeout, now?: () => number}} options arm input.
 * @returns {Promise<boolean>} whether a resume was armed.
 */
export async function armUpgradeResume(ctx, options) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const now = typeof options.now === 'function' ? options.now : Date.now
  const plan = await readUpgradePlan(options.planFile)
  if (plan === null) return false
  if (typeof plan.resumedAt === 'string' && plan.resumedAt !== '') return false
  const announcedAt = Date.parse(String(plan.announcedAt ?? ''))
  if (Number.isFinite(announcedAt) && now() - announcedAt > UPGRADE_PLAN_MAX_AGE_MS) {
    // The announced restart never happened (the upgrade failed or was
    // cancelled). Consume the plan so a later restart does not replay it.
    plan.resumedAt = new Date(now()).toISOString()
    await writeUpgradePlan(options.planFile, plan)
    log(`upgrade plan from ${String(plan.announcedAt)} expired; no resume armed`)
    return false
  }
  const delay = Number.isSafeInteger(options.delayMs) && options.delayMs >= 0 ? options.delayMs : UPGRADE_RESUME_DELAY_MS
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout
  const timer = setTimer(() => {
    void resumeUpgradeConversations(ctx, options).catch(error => {
      const log = typeof options.log === 'function' ? options.log : () => {}
      log(`upgrade resume failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, delay)
  timer?.unref?.()
  log(`upgrade resume armed in ${String(Math.round(delay / 1000))}s for ${String(Array.isArray(plan.sessions) ? plan.sessions.length : 0)} conversation(s)`)
  return true
}
