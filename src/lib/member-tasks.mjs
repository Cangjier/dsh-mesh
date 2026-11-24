/**
 * Member-to-member DSH task delegation.
 *
 * A tool call on member A creates a conversation through member B's
 * independent interop HTTP service, then keeps watching it. When B's
 * conversation becomes idle, this service queues a user-role message into the
 * exact Agent that called the tool — the same wake-up/next-turn behaviour a
 * background job or subagent completion uses.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { formatEgressLine } from './egress-probe.mjs'

const DEFAULT_INTEROP_PORT = 8765
const WAIT_TIMEOUT_MS = 60_000
const MAX_ATTEMPTS = 30
/**
 * How long a finished task waits for a `wait_member` call to take its result.
 *
 * The model may stop calling `wait_member` after a `progress` reply. Once the
 * conversation ends, a parked wait is woken immediately, and the model's next
 * step may issue another one; this window is what lets either of them consume
 * the terminal outcome before it is written back into the calling conversation,
 * so the same answer is never delivered twice.
 */
const DELIVERY_GRACE_MS = 3_000
/**
 * Context occupancy above which a delivery compacts before sending.
 *
 * `compress: true` always compacts; this threshold makes the same compaction
 * non-optional once the target conversation is already loaded, so a
 * long-running conversation cannot keep growing just because the caller
 * forgot the flag. "超过" is strict: exactly 30.0% still delivers directly.
 */
export const FORCED_COMPACT_PERCENT = 30
/** Error a graceful stop writes; a later start resumes watching that task. */
const STOPPED_ERROR = 'the plugin stopped before the member conversation completed'
/**
 * How recently a task must have stopped for a restart to resume it.
 *
 * A member conversation can outlive this plugin, but a task from days ago is
 * history: resuming it would fetch an answer nobody is waiting for. One day
 * keeps an overnight stop recoverable without waking ancient records.
 */
const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000
/** How many times an unavailable origin conversation is retried for delivery. */
const NOTIFY_RETRY_LIMIT = 5
/**
 * How long one pre-delivery compaction may take.
 *
 * Compaction is model-backed: a long conversation can spend a couple of
 * minutes in the member's summarizer, far longer than a normal message POST.
 */
const COMPACT_TIMEOUT_MS = 180_000
/**
 * Errors that say the conversation itself is gone: the member's interop knows no
 * such conversation any more, or its runtime lost the session behind it (which
 * happens when the member's DSH restarts mid-conversation). Retrying cannot fix
 * either, so the task fails at once with the reason instead of burning attempts.
 */
const LOST_CONVERSATION = /conversation not found|unknown SDK session|session "?[\w-]+"? already exists|SDK session is already open or opening|session agent was disposed/iu
/** Text a message that starts a member conversation carries when nothing ran. */
const EMPTY_TURN = '目标的 DSH 在任务执行期间重启了：对话没有产生任何输出，这一轮已中断'
/** How many empty idle answers are tolerated before a task counts as cut short. */
const EMPTY_WAIT_RETRIES = 3
/**
 * The workspace a call joins when the caller names neither one nor a cwd.
 *
 * The member's interop gives the same fixed title to its default workspace and
 * the Web client localizes exactly this title, so it must not be translated.
 */
const DEFAULT_WORKSPACE = 'default-workspace'

function envFile(file) {
  const values = {}
  if (!existsSync(file)) return values
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return values
}

function truncate(text, limit) {
  const value = String(text ?? '')
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/**
 * Clean one workspace title into a name the member's interop accepts.
 *
 * The member rejects a name longer than 120 characters or one containing a
 * path separator or a quote with a 400, and that would fail the whole task.
 * A name derived automatically from a workspace title is also held to the
 * portable subset: `: * ? < > |` are legal in a Linux title but make an
 * unusable directory on a Windows member, so such a title falls back to the
 * default workspace instead of sending a name the member cannot create. An
 * explicitly passed `workspace` keeps the interop's own rule set.
 * Such a title is not rewritten into a near-duplicate name either: the caller
 * falls back to the default workspace instead. A title that only needs
 * trimming is accepted.
 * @param {unknown} value workspace title.
 * @returns {string} the usable name, or '' when there is none.
 */
function workspaceNameFromTitle(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name === '' || name === '.' || name === '..' || name.length > 120) return ''
  if (/[\\/"<>:|?*]/u.test(name) || /[\u0000-\u001f]/u.test(name)) return ''
  return name
}

/**
 * The workspace title of the conversation that is delegating.
 *
 * The caller's own directory is read from its session header and matched
 * against the local workspace registry, so a task started from a "dsh-mesh"
 * conversation lands in the same-named workspace on the member. Anything short
 * of a confident match — no session, no cwd, no registry, no record, an
 * unusable title — resolves to the default workspace rather than failing.
 * @param {any} ctx host context carrying `get`.
 * @param {any} agent the calling agent.
 * @returns {Promise<string>} workspace name for the create request.
 */
async function callerWorkspaceName(ctx, agent) {
  if (typeof ctx?.get !== 'function') return DEFAULT_WORKSPACE
  const cwd = agent?.session?.header?.cwd ?? agent?.session?.meta?.cwd ?? agent?.session?.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') return DEFAULT_WORKSPACE
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || registry === null || typeof registry.resolveByPath !== 'function') {
    return DEFAULT_WORKSPACE
  }
  try {
    const found = await registry.resolveByPath(cwd)
    const name = workspaceNameFromTitle(found?.title)
    return name === '' ? DEFAULT_WORKSPACE : name
  } catch {
    return DEFAULT_WORKSPACE
  }
}

/**
 * A non-negative finite number, or null.
 * @param {unknown} value raw value.
 * @returns {number|null} the number.
 */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Normalise the context occupancy a member reports.
 *
 * The member answers with the same numbers its Web status line shows: the
 * member-side interop derives them from the DSH token meter. A member from an
 * older release sends nothing, which is not an error: the caller simply has no
 * occupancy to display.
 * @param {unknown} value `{usedTokens, maxTokens, percent}` or a raw pressure.
 * @returns {{usedTokens: number|null, maxTokens: number|null, percent: number|null}|null} occupancy.
 */
function normalizeContext(value) {
  if (value === null || typeof value !== 'object') return null
  const usedTokens = finiteOrNull(value.usedTokens ?? value.used ?? value.pressureTokens)
  const maxTokens = finiteOrNull(value.maxTokens ?? value.max ?? value.contextWindow)
  if (usedTokens === null && maxTokens === null) return null
  const percent = usedTokens !== null && maxTokens !== null && maxTokens > 0
    ? Math.round((usedTokens / maxTokens) * 1000) / 10
    : finiteOrNull(value.percent)
  return { usedTokens, maxTokens, percent }
}

/**
 * Join a compaction summary's content blocks into one string.
 * @param {unknown} value string or content blocks.
 * @returns {string} summary text.
 */
function summaryText(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

export class MemberTaskService {
  /**
   * @param {{ctx: any, service: any, dataDir: string, log?: (line:string)=>void}} options options.
   */
  constructor(options) {
    this.ctx = options.ctx
    this.service = options.service
    this.dataDir = options.dataDir
    this.logLine = options.log ?? (() => {})
    this.taskRoot = path.join(this.dataDir, 'member-tasks')
    this.tasks = new Map()
    this.monitors = new Map()
    /** @type {Map<string, AbortController>} per-task cancellation for the in-flight wait */
    this.controllers = new Map()
    /** @type {Map<string, Set<() => void>>} `wait_member` calls parked on a task */
    this.waiters = new Map()
    /** @type {Map<string, ReturnType<typeof setTimeout>>} pending post-completion deliveries */
    this.deliveryTimers = new Map()
    /** @type {Map<string, ReturnType<typeof setTimeout>>} retries for a cold origin conversation */
    this.notifyTimers = new Map()
    /** Cached `{ id, name, ip }` of this machine, filled by the first member lookup. */
    this.identity = null
    this.loaded = false
    this.disposed = false
  }

  async dispose() {
    this.disposed = true
    for (const timer of this.deliveryTimers.values()) clearTimeout(timer)
    this.deliveryTimers.clear()
    for (const timer of this.notifyTimers.values()) clearTimeout(timer)
    this.notifyTimers.clear()
    for (const controller of this.controllers.values()) {
      try { controller.abort(new Error('the plugin stopped')) } catch { }
    }
    for (const task of this.tasks.values()) {
      if (task.status === 'running' || task.status === 'starting') {
        task.status = 'interrupted'
        task.error = STOPPED_ERROR
        // The member conversation keeps running; the next start re-attaches it.
        task.resumable = true
        await this.#save(task).catch(() => {})
      }
      this.#notifyWaiters(task)
    }
  }

  /**
   * Load persisted tasks and re-attach the conversations that outlived a stop.
   * @returns {Promise<void>} resolution after the load and monitor start.
   */
  async init() {
    await this.#ensureLoaded()
  }

  async #ensureLoaded() {
    if (this.loaded) return
    this.loaded = true
    await mkdir(this.taskRoot, { recursive: true })
    let files = []
    try { files = await readdir(this.taskRoot) } catch { }
    /** @type {object[]} tasks whose member conversation outlived the plugin */
    const resumable = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const task = JSON.parse(await readFile(path.join(this.taskRoot, file), 'utf8'))
        if (task?.id === undefined) continue
        const stoppedAt = Date.parse(task.updatedAt)
        const recent = Number.isFinite(stoppedAt) && Date.now() - stoppedAt <= RESUME_WINDOW_MS
        const interruptedByStop = task.status === 'interrupted' && recent &&
          (task.resumable === true || task.error === STOPPED_ERROR)
        if (recent && (task.status === 'running' || task.status === 'starting' || interruptedByStop)) {
          // The member kept the conversation while this plugin was down. Resume
          // watching instead of dropping the result: a member that died too
          // reports interrupted on the next wait, and the task fails then.
          task.status = 'running'
          task.error = null
          task.interrupted = false
          task.resumable = false
          resumable.push(task)
          await this.#save(task)
        }
        // Older records predate per-turn replies; start them at zero so a
        // resumed task cannot replay an answer it never had.
        task.replies = Array.isArray(task.replies) ? task.replies : []
        task.replySeq = Number.isSafeInteger(task.replySeq) ? task.replySeq : 0
        task.deliveredSeq = Number.isSafeInteger(task.deliveredSeq) ? task.deliveredSeq : 0
        task.terminalDelivered = task.terminalDelivered === true
        this.tasks.set(task.id, task)
      } catch { }
    }
    for (const task of resumable) {
      this.controllers.set(task.id, new AbortController())
      await this.#log(task, 'resuming after the plugin restart')
      const monitor = this.#monitor(task)
      this.monitors.set(task.id, monitor)
      void monitor.finally(() => this.monitors.delete(task.id)).catch(() => {})
    }
  }

  async #save(task) {
    task.updatedAt = new Date().toISOString()
    const file = path.join(this.taskRoot, `${task.id}.json`)
    const temporary = `${file}.${process.pid}.tmp`
    await mkdir(this.taskRoot, { recursive: true })
    await writeFile(temporary, `${JSON.stringify(task, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
  }

  async #log(task, line) {
    const text = `[${new Date().toISOString()}] ${line}\n`
    try { await writeFile(path.join(this.taskRoot, `${task.id}.log`), text, { encoding: 'utf8', flag: 'a' }) } catch { }
    try { this.logLine(`member-task ${task.id}: ${line}`) } catch { }
  }

  #port() {
    const configured = this.service.config?.interopPort
    if (Number.isSafeInteger(configured) && configured > 0 && configured < 65_536) return configured
    return DEFAULT_INTEROP_PORT
  }

  #token() {
    const configured = this.service.config?.interopToken
    if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
    if (process.env.DSH_INTEROP_TOKEN) return process.env.DSH_INTEROP_TOKEN
    if (this.service.config?.interopUseGatePassword !== false) {
      if (process.env.DSH_GATE_PASSWORD) return process.env.DSH_GATE_PASSWORD
      const candidates = [
        path.join(this.service.repositoryRoot, '..', 'config', 'gate.env'),
        path.join(this.service.repositoryRoot, 'config', 'gate.env'),
        path.join(this.service.dataDir, '..', '..', 'config', 'gate.env'),
      ]
      for (const file of candidates) {
        const password = envFile(file).DSH_GATE_PASSWORD
        if (typeof password === 'string' && password !== '') return password
      }
    }
    throw new Error('no interop token: set interopToken, DSH_INTEROP_TOKEN, or DSH_GATE_PASSWORD')
  }

  /**
   * The interop base URL of one member address.
   * @param {string} address member VPN address or http(s) URL.
   * @returns {string} base URL without trailing slash.
   */
  #baseUrl(address) {
    const raw = String(address ?? '')
    if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '')
    const host = raw.includes(':') && !raw.startsWith('[') ? `[${raw}]` : raw
    return `http://${host}:${String(this.#port())}`
  }

  async #resolveMember(input) {
    const raw = String(input ?? '').trim()
    if (raw === '') throw new Error('member is required')
    if (/^https?:\/\//i.test(raw)) {
      return { name: raw, ip: raw, baseUrl: raw.replace(/\/+$/, '') }
    }
    const snapshot = await this.service.members()
    this.identity = this.identity ?? {
      id: String(snapshot.local?.id ?? 'local'),
      name: String(snapshot.local?.name ?? snapshot.local?.id ?? 'local'),
      ip: String(snapshot.local?.ip ?? ''),
    }
    const all = [snapshot.local, ...(Array.isArray(snapshot.members) ? snapshot.members : [])].filter(Boolean)
    const match = all.find(member => String(member.id) === raw || String(member.name) === raw || String(member.ip) === raw)
    const member = match ?? { id: raw, name: raw, ip: raw }
    let host = String(member.ip ?? member.id ?? raw)
    if (/^https?:\/\//i.test(host)) return { name: member.name ?? raw, ip: host, baseUrl: host.replace(/\/+$/, '') }
    return {
      name: member.name ?? member.id ?? raw,
      ip: String(member.ip ?? member.id ?? raw),
      baseUrl: this.#baseUrl(host),
    }
  }

  async #request(baseUrl, method, endpoint, body, timeoutMs = 30_000, signal) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), Math.max(1000, timeoutMs))
    timer.unref?.()
    const forwardAbort = () => {
      controller.abort(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    if (signal !== undefined) {
      if (signal.aborted) forwardAbort()
      else signal.addEventListener('abort', forwardAbort, { once: true })
    }
    let response
    try {
      response = await fetch(`${baseUrl}${endpoint}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#token()}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forwardAbort)
    }
    const text = await response.text()
    let parsed = null
    try { parsed = text === '' ? null : JSON.parse(text) } catch { }
    if (!response.ok) {
      const message = parsed?.error?.message ?? text ?? `HTTP ${String(response.status)}`
      throw new Error(`${String(response.status)} ${message}`)
    }
    if (parsed === null) throw new Error('member interop returned a non-JSON response')
    return parsed
  }

  /**
   * Facts the target conversation starts with: the measured egress line and
   * the mesh's git tokens.
   *
   * The proxy is the mesh networking config's direct link for this member:
   * only its client has a local proxy, and a member without a client link is
   * told nothing about egress. The probe measures the link's advertised HTTP
   * proxy port before delivery; a failure is reported, never thrown.
   * @param {{name: string, ip: string}} target resolved member.
   * @returns {Promise<object>} create-request `mesh` field.
   */
  async #meshFor(target) {
    const tokens = typeof this.service.releaseTokens === 'function'
      ? await this.service.releaseTokens().catch(() => ({}))
      : {}
    const tokenPair = { github: tokens.github ?? null, gitee: tokens.gitee ?? null }
    const link = typeof this.service.directLinkFor === 'function'
      ? await this.service.directLinkFor(target.ip).catch(() => null)
      : null
    if (link === null) return { link: false, proxyPort: null, egress: null, tokens: tokenPair }
    const probe = typeof this.service.probeMemberEgress === 'function'
      ? await this.service.probeMemberEgress(target.ip, link.port).catch(() => ({ ok: false, error: 'probe failed' }))
      : { ok: false, error: 'probe unavailable' }
    return {
      link: true,
      proxyPort: link.port,
      egress: probe?.ok === true
        ? { ok: true, latencyMs: probe.latencyMs ?? null, downMbps: probe.downMbps ?? null }
        : { ok: false, error: typeof probe?.error === 'string' ? probe.error : null },
      tokens: tokenPair,
    }
  }

  /**
   * Wait out a member runtime that is still booting.
   *
   * A member's interop answers 503 while its SDK child starts, which is exactly
   * the window right after that machine's DSH restarted. A tool call made in
   * that window should wait for it instead of failing outright.
   * @param {() => Promise<any>} attempt one request.
   * @param {number} [budgetMs] how long to keep waiting.
   * @returns {Promise<any>} the request result.
   */
  async #waitForRuntime(attempt, budgetMs = 90_000, signal) {
    const deadline = Date.now() + budgetMs
    for (;;) {
      signal?.throwIfAborted()
      try {
        return await attempt()
      } catch (error) {
        signal?.throwIfAborted()
        const message = error instanceof Error ? error.message : String(error)
        const starting = /SDK runtime is not ready|sdk_unavailable|SDK runtime is still starting/iu.test(message)
        if (!starting || Date.now() >= deadline) throw error
        await new Promise((resolve) => {
          const timer = setTimeout(done, 2_000)
          timer.unref?.()
          function done() {
            clearTimeout(timer)
            signal?.removeEventListener('abort', done)
            resolve()
          }
          if (signal !== undefined) {
            if (signal.aborted) done()
            else signal.addEventListener('abort', done, { once: true })
          }
        })
      }
    }
  }

  async start({ member, prompt, cwd, workspace, agent, notify = true, signal }) {
    await this.#ensureLoaded()
    if (typeof prompt !== 'string' || prompt.trim() === '') throw new Error('prompt is required')
    if (agent === undefined || agent === null) throw new Error('delegation must be called from a DSH conversation')
    const target = await this.#resolveMember(member)
    // Measure the target's proxy before the message exists: the one-line
    // result rides along in the create request, so the target conversation
    // starts with what was actually measured, not a guess.
    const mesh = await this.#meshFor(target)
    const egressLine = mesh.link === true ? formatEgressLine(mesh) : ''
    const explicitWorkspace = typeof workspace === 'string' && workspace.trim() !== ''
    const explicitCwd = typeof cwd === 'string' && cwd !== ''
    // Precedence: an explicitly named workspace, then an explicit cwd (which
    // keeps its own meaning and carries no workspace), then the workspace the
    // calling conversation is itself in.
    const targetWorkspace = explicitWorkspace
      ? workspace.trim()
      : explicitCwd ? '' : await callerWorkspaceName(this.ctx, agent)
    const payload = {
      prompt,
      // The member's panel lists these; without a title it would show a UUID.
      title: truncate(prompt, 80),
      initiator: { ...(this.identity ?? { id: 'local' }), source: 'call_member' },
      mesh,
      ...(targetWorkspace !== '' ? { workspace: targetWorkspace } : {}),
      ...(explicitCwd ? { cwd } : {}),
    }
    const created = await this.#waitForRuntime(
      () => this.#request(target.baseUrl, 'POST', '/v1/conversations', payload, 60_000, signal),
      90_000,
      signal,
    )
    const conversation = created.conversation
    if (conversation === undefined || typeof conversation.id !== 'string') throw new Error('member interop did not return a conversation id')
    const task = {
      id: `member-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      member: target.name,
      memberIp: target.ip,
      baseUrl: target.baseUrl,
      conversationId: conversation.id,
      prompt: truncate(prompt, 2000),
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastText: '',
      error: null,
      interrupted: false,
      attempts: 0,
      turns: 0,
      /** Replies already accepted from the member, oldest first. */
      replies: [],
      /** Newest reply sequence number seen on the member. */
      replySeq: 0,
      /** Newest reply seq a `wait_member` call already returned to the model. */
      deliveredSeq: 0,
      /** True once a `wait_member` call returned this task's terminal outcome. */
      terminalDelivered: false,
      notify,
      notified: false,
      notifiedAt: null,
      notifyError: null,
      originAgentId: String(agent.id ?? ''),
      originSessionId: String(agent.session?.id ?? ''),
      /** One-line egress report the target received, or ''. */
      egressLine,
      /** Context occupancy last reported by the member, or null. */
      context: null,
      /** Last pre-delivery compaction, when the caller asked for one. */
      lastCompaction: null,
      /** True for a task attached to a conversation this initiator did not start. */
      adopted: false,
    }
    this.controllers.set(task.id, new AbortController())
    this.tasks.set(task.id, task)
    await this.#save(task)
    await this.#log(task, `created ${conversation.id} on ${target.baseUrl}`)
    const monitor = this.#monitor(task)
    this.monitors.set(task.id, monitor)
    void monitor.finally(() => this.monitors.delete(task.id)).catch(() => {})
    return task
  }

  /**
   * Wait for the next news about one task, up to a bounded timeout.
   *
   * "News" is either a finished-turn reply the model has not seen yet, or the
   * task reaching a terminal state. The monitor keeps running in the background,
   * so a timeout only ends this caller's wait; the same conversationId can be
   * waited again, and replies that arrived meanwhile are not lost.
   *
   * The conversation id is the only handle the caller needs; the task record
   * it resolves to stays an implementation detail of this service.
   *
   * `signal` is the tool call's own cancellation. It ends the park at once
   * rather than at the next wake, so stopping the conversation does not leave
   * the call hanging until its deadline; the thrown reason is the signal's own
   * reason, which is what makes DSH report the call as cancelled.
   * @param {string} conversationId conversation id returned by call_member.
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options] wait options.
   * @returns {Promise<{done: boolean, timedOut: boolean, task: object, replies: object[], state: string}>} outcome.
   */
  async wait(conversationId, options = {}) {
    await this.#ensureLoaded()
    const key = String(conversationId ?? '')
    if (key === '') throw new Error('conversationId is required')
    const task = this.#taskOfConversation(key)
    if (task === undefined) throw new Error(`member conversation is not tracked: ${key}`)
    const timeoutMs = Math.max(1000, Math.min(Number.isSafeInteger(options.timeoutMs) ? options.timeoutMs : 30_000, 300_000))
    const signal = options.signal
    const deadline = Date.now() + timeoutMs
    let terminalSynced = false
    for (;;) {
      signal?.throwIfAborted()
      const terminal = task.status === 'completed' || task.status === 'failed' || task.status === 'interrupted'
      if (terminal && !terminalSynced) {
        // The monitor stopped when this task ended, so any turn the member ran
        // afterwards is invisible locally. Re-read the conversation once before
        // answering a wait on a finished task.
        terminalSynced = true
        await this.#syncTerminal(task, signal)
      }
      const replies = this.#pendingReplies(task)
      if (replies.length > 0) {
        task.deliveredSeq = replies[replies.length - 1].seq
        // A terminal answer handed over together with its text also tells the
        // model the task is over, so the post-completion delivery is skipped.
        if (terminal) task.terminalDelivered = true
        await this.#save(task).catch(() => {})
        return {
          done: terminal,
          timedOut: false,
          task,
          replies,
          state: terminal ? (task.status === 'completed' ? 'done' : 'failed') : 'progress',
        }
      }
      if (terminal) {
        // A terminal outcome with no new text (a failure, or an idle finish)
        // still counts as consumed: the model knows the task ended.
        task.terminalDelivered = true
        await this.#save(task).catch(() => {})
        return { done: true, timedOut: false, task, replies: [], state: task.status === 'completed' ? 'done' : 'failed' }
      }
      const left = deadline - Date.now()
      if (left <= 0) return { done: false, timedOut: true, task, replies: [], state: 'running' }
      await this.#waitForWake(task, left, signal)
    }
  }

  /**
   * The newest task tracked for one member conversation.
   * @param {string} conversationId member conversation id.
   * @returns {object|undefined} task record.
   */
  #taskOfConversation(conversationId) {
    return [...this.tasks.values()]
      .filter(task => task.conversationId === conversationId)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0]
  }

  /** Replies this task received but no `wait` call has returned yet. */
  #pendingReplies(task) {
    const delivered = Number.isSafeInteger(task.deliveredSeq) ? task.deliveredSeq : 0
    const replies = Array.isArray(task.replies) ? task.replies : []
    return replies.filter(reply => Number.isSafeInteger(reply?.seq) && reply.seq > delivered)
  }

  /**
   * Whether the member's reply counter went backwards.
   *
   * The counter is an in-memory increment per conversation. A member that
   * restarted used to begin a new epoch at zero while the caller still held the
   * old cursor, which made every new reply look "already seen"; older members
   * still do this, so the caller must notice it rather than trust `since`.
   * @param {object} task tracked task.
   * @param {unknown} conversation conversation projection from the member.
   * @returns {boolean} true when a re-sync is needed.
   */
  #replyCursorReset(task, conversation) {
    const seen = Number.isSafeInteger(task.replySeq) ? task.replySeq : 0
    const reported = Number.isSafeInteger(conversation?.replySeq) ? conversation.replySeq : null
    return seen > 0 && reported !== null && reported < seen
  }

  /**
   * Start a new reply epoch at the member's current counter.
   *
   * The stored reply texts belong to the previous epoch, and their seq numbers
   * no longer match the member's; dropping them is what lets the caller accept
   * the replies the member still has.
   * @param {object} task tracked task.
   * @param {number} reported the member's counter.
   * @returns {Promise<void>} resolution after the state is saved.
   */
  async #resetReplyCursor(task, reported) {
    const previous = Number.isSafeInteger(task.replySeq) ? task.replySeq : 0
    task.replySeq = 0
    task.deliveredSeq = 0
    task.replies = []
    await this.#log(task, `reply cursor reset on the member (was ${String(previous)}, member now reports ${String(reported)}); re-syncing replies`)
    await this.#save(task).catch(() => {})
  }

  /**
   * Re-read a finished task's member conversation before answering a wait.
   *
   * The monitor stops at the terminal state, so a turn the member ran
   * afterwards (or a restart that reset its reply counter) never reached the
   * local record. The read decides whether a fetch is needed; only an idle
   * conversation is synced, because a running one is the caller's next send
   * to handle.
   * @param {object} task tracked task.
   * @param {AbortSignal} [signal] cancellation of the waiting tool call.
   * @returns {Promise<void>} resolution after the best-effort sync.
   */
  async #syncTerminal(task, signal) {
    let state
    try {
      state = await this.#request(
        task.baseUrl,
        'GET',
        `/v1/conversations/${encodeURIComponent(task.conversationId)}`,
        undefined,
        5_000,
        signal,
      )
    } catch {
      signal?.throwIfAborted()
      return
    }
    const conversation = state?.conversation
    if (conversation === null || typeof conversation !== 'object') return
    if (String(conversation.status ?? '') !== 'idle') return
    const reset = this.#replyCursorReset(task, conversation)
    if (reset) await this.#resetReplyCursor(task, conversation.replySeq)
    const cursor = Number.isSafeInteger(task.replySeq) ? task.replySeq : 0
    const reported = Number.isSafeInteger(conversation.replySeq) ? conversation.replySeq : 0
    if (!reset && reported <= cursor) return
    let result
    try {
      result = await this.#request(
        task.baseUrl,
        'POST',
        `/v1/conversations/${encodeURIComponent(task.conversationId)}/wait`,
        { timeoutMs: 1_000, since: cursor },
        20_000,
        signal,
      )
    } catch {
      signal?.throwIfAborted()
      return
    }
    if (result?.state !== 'progress' && result?.state !== 'done') return
    await this.#acceptReplies(task, result, { notify: false }).catch(() => {})
    if (Number.isSafeInteger(result.turn)) task.turns = result.turn
    await this.#save(task).catch(() => {})
  }

  /**
   * Park until this task changes, the budget runs out, or the call is cancelled.
   *
   * A promise per waiter (rather than a poll loop) is what makes a finished
   * turn reach the model immediately, without a half-second of latency. The
   * abort listener is the same waiter, so a cancelled tool call stops parking
   * right away instead of waiting for a reply or the deadline.
   * @param {object} task member task.
   * @param {number} ms maximum wait.
   * @param {AbortSignal} [signal] cancellation of the waiting tool call.
   * @returns {Promise<void>} resolves on a wake, on the deadline, or on abort.
   */
  #waitForWake(task, ms, signal) {
    return new Promise((resolve) => {
      let timer
      const wake = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', wake)
        this.waiters.get(task.id)?.delete(wake)
        resolve()
      }
      timer = setTimeout(wake, Math.max(0, ms))
      timer.unref?.()
      let parked = this.waiters.get(task.id)
      if (parked === undefined) {
        parked = new Set()
        this.waiters.set(task.id, parked)
      }
      parked.add(wake)
      if (signal !== undefined) {
        if (signal.aborted) wake()
        else signal.addEventListener('abort', wake, { once: true })
      }
    })
  }

  /** Wake every `wait_member` call parked on this task. */
  #notifyWaiters(task) {
    const parked = this.waiters.get(task.id)
    if (parked === undefined) return
    this.waiters.delete(task.id)
    for (const waiter of [...parked]) {
      try { waiter() } catch { }
    }
  }

  /**
   * Send one message into an existing member conversation.
   *
   * The conversation is named by the member's conversation id. That id is the
   * portable key: it is what `call_member` / `wait_member` return, it survives a
   * new process on this side, and it lets a model continue a conversation it
   * did not start.
   *
   * `compress` runs the member's own compaction before the message is queued,
   * so the next turn starts from a shortened context. It requires that
   * conversation to be idle. Without the flag, a conversation whose context
   * occupancy is already above {@link FORCED_COMPACT_PERCENT} is compacted
   * anyway before the message is delivered.
   *
   * @param {{conversationId: string, member?: string, prompt: string, compress?: boolean, agent?: any, signal?: AbortSignal}} request send request.
   * @returns {Promise<object>} the tracked task.
   */
  async send(request) {
    await this.#ensureLoaded()
    const prompt = request.prompt
    if (typeof prompt !== 'string' || prompt.trim() === '') throw new Error('prompt is required')
    const signal = request.signal
    const { task, fresh } = await this.#sendTarget(request)
    // A compaction record belongs to one delivery; the next one starts clean.
    task.lastCompaction = null
    // The read also detects a member whose reply counter restarted; the cursor
    // must move to the new epoch before the monitor polls it again.
    await this.#refreshContext(task, signal)
    if (request.compress === true) {
      await this.#compact(task, signal)
    } else {
      await this.#compactIfCrowded(task, signal)
    }
    const result = await this.#waitForRuntime(
      () => this.#request(task.baseUrl, 'POST', `/v1/conversations/${encodeURIComponent(task.conversationId)}/messages`, { content: prompt }, 30_000, signal),
      90_000,
      signal,
    )
    if (fresh) {
      // A conversation this initiator never tracked already has a reply
      // history. Start the cursor where the member is now, or the first wait
      // would replay turns the model has already seen (or never saw at all).
      this.#adoptPosition(task, result?.conversation)
      task.prompt = truncate(prompt, 2000)
      this.tasks.set(task.id, task)
    }
    this.#rememberContext(task, result?.context ?? result?.conversation?.context)
    task.status = 'running'
    task.error = null
    task.interrupted = false
    task.attempts = 0
    task.emptyWaits = 0
    task.terminalDelivered = false
    task.notified = false
    task.notifiedAt = null
    task.notifyError = null
    task.notify = true
    task.notifyRetries = 0
    // A pending delivery (or its origin-unavailable retry) belongs to the
    // previous completion; this new message starts a new one.
    const pendingDelivery = this.deliveryTimers.get(task.id)
    if (pendingDelivery !== undefined) {
      clearTimeout(pendingDelivery)
      this.deliveryTimers.delete(task.id)
    }
    const pendingNotify = this.notifyTimers.get(task.id)
    if (pendingNotify !== undefined) {
      clearTimeout(pendingNotify)
      this.notifyTimers.delete(task.id)
    }
    if (!this.controllers.has(task.id)) this.controllers.set(task.id, new AbortController())
    await this.#save(task)
    await this.#log(task, `message queued: ${result?.receipt?.messageId ?? 'unknown'}`)
    if (!this.monitors.has(task.id)) {
      const monitor = this.#monitor(task)
      this.monitors.set(task.id, monitor)
      void monitor.finally(() => this.monitors.delete(task.id)).catch(() => {})
    }
    return task
  }

  /**
   * Resolve who a send targets: an existing tracked task, or a conversation on
   * a named member that this initiator will adopt.
   * @param {{conversationId: string, member?: string, prompt: string, agent?: any}} request send request.
   * @returns {Promise<{task: object, fresh: boolean}>} target task.
   */
  async #sendTarget(request) {
    const conversationId = typeof request.conversationId === 'string' ? request.conversationId.trim() : ''
    if (conversationId === '') throw new Error('conversationId is required to continue a conversation')
    const tracked = this.#taskOfConversation(conversationId)
    if (tracked !== undefined) {
      const named = typeof request.member === 'string' ? request.member.trim() : ''
      if (named !== '') {
        const target = await this.#resolveMember(named)
        if (target.baseUrl !== tracked.baseUrl) {
          throw new Error(`conversation ${conversationId} belongs to ${tracked.member} (${tracked.baseUrl}), not ${target.baseUrl}`)
        }
      }
      return { task: tracked, fresh: false }
    }
    const named = typeof request.member === 'string' ? request.member.trim() : ''
    if (named === '') {
      throw new Error('send by conversationId needs member: no local task tracks this conversation')
    }
    const target = await this.#resolveMember(named)
    return {
      task: {
        id: `member-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
        member: target.name,
        memberIp: target.ip,
        baseUrl: target.baseUrl,
        conversationId,
        prompt: truncate(request.prompt, 2000),
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastText: '',
        error: null,
        interrupted: false,
        attempts: 0,
        turns: 0,
        /** Replies already accepted from the member, oldest first. */
        replies: [],
        /** Newest reply sequence number seen on the member. */
        replySeq: 0,
        /** Newest reply seq a `wait_member` call already returned to the model. */
        deliveredSeq: 0,
        /** True once a `wait_member` call returned this task's terminal outcome. */
        terminalDelivered: false,
        notify: true,
        notified: false,
        notifiedAt: null,
        notifyError: null,
        originAgentId: String(request.agent?.id ?? ''),
        originSessionId: String(request.agent?.session?.id ?? ''),
        context: null,
        lastCompaction: null,
        adopted: true,
      },
      fresh: true,
    }
  }

  /**
   * Move an adopted task's cursors to the member's current position.
   * @param {object} task adopted task.
   * @param {unknown} conversation the member's conversation projection.
   * @returns {void}
   */
  #adoptPosition(task, conversation) {
    if (conversation === null || typeof conversation !== 'object') return
    const seq = Number.isSafeInteger(conversation.replySeq) ? conversation.replySeq : 0
    task.replySeq = Math.max(Number.isSafeInteger(task.replySeq) ? task.replySeq : 0, seq)
    task.deliveredSeq = Math.max(Number.isSafeInteger(task.deliveredSeq) ? task.deliveredSeq : 0, task.replySeq)
    if (Number.isSafeInteger(conversation.turns)) task.turns = conversation.turns
  }

  /**
   * Record the context occupancy a member reported.
   * @param {object} task member task.
   * @param {unknown} value raw occupancy.
   * @returns {void}
   */
  #rememberContext(task, value) {
    const context = normalizeContext(value)
    if (context !== null) task.context = context
  }

  /**
   * Compact before delivery when the target conversation is already loaded.
   *
   * The occupancy is re-read from the member first: the cached figure comes
   * from the last wait, and an adopted conversation has none. A member that
   * does not answer the read with a context leaves the cached value alone, so
   * an older member still decides on what the last wait reported.
   * @param {object} task member task.
   * @param {AbortSignal} [signal] cancellation of the sending tool call.
   * @returns {Promise<boolean>} whether a compaction was attempted.
   */
  async #compactIfCrowded(task, signal) {
    const percent = task.context?.percent
    if (typeof percent !== 'number' || percent <= FORCED_COMPACT_PERCENT) return false
    await this.#compact(task, signal, { forced: true, percent })
    return true
  }

  /**
   * Re-read the target conversation's context occupancy before a delivery.
   *
   * `GET /v1/conversations/<id>` is cheap and reports the same projection the
   * wait responses do. A member from an older release returns no context; the
   * cached value then stays in place.
   * @param {object} task member task.
   * @param {AbortSignal} [signal] cancellation of the sending tool call.
   * @returns {Promise<void>} resolution after the best-effort read.
   */
  async #refreshContext(task, signal) {
    try {
      const result = await this.#request(
        task.baseUrl,
        'GET',
        `/v1/conversations/${encodeURIComponent(task.conversationId)}?resume=1`,
        undefined,
        15_000,
        signal,
      )
      this.#rememberContext(task, result?.context)
      if (this.#replyCursorReset(task, result?.conversation)) {
        await this.#resetReplyCursor(task, result.conversation.replySeq)
      }
    } catch (error) {
      // Stopping the tool call must stop the delivery, not be reported as a
      // missing context. Any other read failure is left to the message
      // request that follows, which reports the real problem.
      signal?.throwIfAborted()
      void error
    }
  }

  /**
   * Compact a member conversation before delivering into it.
   *
   * The member owns the session, so only it can compact. An older member has
   * no `/compact` endpoint; that is reported as "upgrade the member", not
   * retried as a transient failure.
   * @param {object} task member task.
   * @param {AbortSignal} [signal] cancellation of the sending tool call.
   * @param {{forced?: boolean, percent?: number}} [options] set by the
   *   automatic over-threshold path, which has no `compress` flag to drop.
   * @returns {Promise<object>} the recorded compaction.
   */
  async #compact(task, signal, options = {}) {
    const forced = options.forced === true
    await this.#log(
      task,
      forced
        ? `compacting context before delivery (forced at ${String(options.percent)}%)`
        : 'compacting context before delivery',
    )
    let result
    try {
      result = await this.#waitForRuntime(
        () => this.#request(
          task.baseUrl,
          'POST',
          `/v1/conversations/${encodeURIComponent(task.conversationId)}/compact`,
          {},
          COMPACT_TIMEOUT_MS,
          signal,
        ),
        90_000,
        signal,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/conversation not found|conversation_not_found/iu.test(message)) {
        throw new Error(`成员 ${task.member} 上已经没有对话 ${task.conversationId}：${message}`)
      }
      if (/unknown endpoint|not_found|unsupported|compaction_unavailable/iu.test(message)) {
        throw new Error(forced
          ? `对话 ${task.conversationId} 的上下文占比已超过 ${String(FORCED_COMPACT_PERCENT)}%，但成员 ${task.member} 的 interop 服务不支持上下文压缩（版本过旧）：${message}。先升级该成员再投递。`
          : `成员 ${task.member} 的 interop 服务不支持上下文压缩（版本过旧）：${message}。去掉 compress 直接投递，或先升级该成员。`)
      }
      if (/busy|already has active work|conversation_busy|409/iu.test(message)) {
        throw new Error(forced
          ? `对话 ${task.conversationId} 的上下文占比已超过 ${String(FORCED_COMPACT_PERCENT)}%，需要先压缩，但它还在运行：${message}。等 wait_member 返回 state=done 后再投递。`
          : `对话 ${task.conversationId} 还在运行，不能压缩：${message}。等 wait_member 返回 state=done 后再投递，或去掉 compress。`)
      }
      throw error
    }
    task.lastCompaction = {
      at: new Date().toISOString(),
      forced,
      ...(forced ? { forcedPercent: options.percent } : {}),
      compacted: result?.compacted === true,
      summary: summaryText(result?.summary),
      shadowedCount: Number.isSafeInteger(result?.shadowedCount) ? result.shadowedCount : 0,
      shadowedTokenCount: Number.isSafeInteger(result?.shadowedTokenCount) ? result.shadowedTokenCount : null,
    }
    this.#rememberContext(task, result?.context)
    await this.#log(
      task,
      task.lastCompaction.compacted
        ? `compacted ${String(task.lastCompaction.shadowedCount)} item(s), ~${String(task.lastCompaction.shadowedTokenCount ?? 0)} tokens`
        : 'no compactable history',
    )
    return task.lastCompaction
  }

  async #monitor(task) {
    const signal = this.controllers.get(task.id)?.signal
    while (!this.disposed && (task.status === 'running' || task.status === 'starting')) {
      if (signal?.aborted) break
      task.attempts += 1
      try {
        const result = await this.#request(
          task.baseUrl,
          'POST',
          `/v1/conversations/${encodeURIComponent(task.conversationId)}/wait`,
          { timeoutMs: WAIT_TIMEOUT_MS, since: Number.isSafeInteger(task.replySeq) ? task.replySeq : 0 },
          WAIT_TIMEOUT_MS + 10_000,
          signal,
        )
        // A completed round trip proves the member is healthy: start the retry
        // budget over, so a long multi-turn task is not failed by one late blip.
        task.attempts = 0
        this.#rememberContext(task, result.context ?? result.conversation?.context)
        const conversation = result.conversation ?? {}
        if (this.#replyCursorReset(task, conversation)) {
          // The member restarted and its reply counter began a new epoch; the
          // old `since` would hide every reply the member still has, and a
          // timed-out poll is just as good a place to notice it.
          if (Number.isSafeInteger(conversation.turns)) task.turns = conversation.turns
          await this.#resetReplyCursor(task, conversation.replySeq)
          continue
        }
        if (result.timedOut === true) {
          task.status = 'running'
          await this.#save(task)
          continue
        }
        if (this.disposed) break
        if (conversation.error) task.error = String(conversation.error)
        const status = String(conversation.status ?? '')
        if (status === 'interrupted' || status === 'unavailable') {
          // The member's DSH restarted (or its runtime died) before the turn
          // finished. `send` can resume this conversation; the task cannot.
          task.status = 'failed'
          task.interrupted = true
          task.error = String(conversation.error ?? EMPTY_TURN)
          break
        }
        const state = typeof result.state === 'string' ? result.state : ''
        if (state === 'progress' || state === 'done') {
          // A member with per-turn replies: every finished turn carries its own
          // text, and `done` means the runtime is idle with no subagent left.
          // The `done` path updates the status before waking anyone, so a parked
          // `wait_member` never sees a reply that already ended the task and
          // calls it "progress" by mistake.
          await this.#acceptReplies(task, result, { notify: state === 'progress' })
          if (Number.isSafeInteger(result.turn)) task.turns = result.turn
          if (state === 'progress') {
            task.emptyWaits = 0
            task.status = 'running'
            await this.#save(task)
            continue
          }
          if (task.turns === 0 && String(task.lastText ?? '') === '') {
            // Idle before the prompt ever produced a turn: the same guard as the
            // legacy path, so a runtime that starts late is not called finished.
            task.emptyWaits = (task.emptyWaits ?? 0) + 1
            if (task.emptyWaits < EMPTY_WAIT_RETRIES) {
              await new Promise(resolve => setTimeout(resolve, 1_000))
              continue
            }
            task.status = 'failed'
            task.interrupted = true
            task.error = EMPTY_TURN
            break
          }
          task.emptyWaits = 0
          task.status = conversation.error ? 'failed' : 'completed'
          break
        }
        // Older members answer with the conversation only: wait for idle.
        task.lastText = typeof conversation.lastText === 'string' ? conversation.lastText : ''
        if (status === 'idle' && !this.#turnAdvanced(task, conversation) && String(task.lastText ?? '') === '') {
          // An idle answer without a finished turn is not a finished turn: the
          // target answered while its runtime was shutting down, or the prompt
          // never started. Give it a couple of chances, then say it was cut.
          task.emptyWaits = (task.emptyWaits ?? 0) + 1
          if (task.emptyWaits < EMPTY_WAIT_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, 1_000))
            continue
          }
          task.status = 'failed'
          task.interrupted = true
          task.error = EMPTY_TURN
          break
        }
        task.emptyWaits = 0
        if (Number.isSafeInteger(conversation.turns)) task.turns = conversation.turns
        task.status = conversation.status === 'idle'
          ? (conversation.error ? 'failed' : 'completed')
          : 'running'
        if (task.status === 'completed' || task.status === 'failed') break
      } catch (error) {
        if (signal?.aborted || task.status === 'interrupted') break
        task.error = error instanceof Error ? error.message : String(error)
        await this.#log(task, `wait failed: ${task.error}`)
        if (LOST_CONVERSATION.test(task.error)) {
          task.status = 'failed'
          task.interrupted = true
          break
        }
        if (task.attempts >= MAX_ATTEMPTS) {
          task.status = 'failed'
          break
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(2_000 * task.attempts, 15_000)))
      }
    }
    this.controllers.delete(task.id)
    if (this.disposed && task.status === 'running') {
      task.status = 'interrupted'
      task.error = 'the plugin stopped before the member conversation completed'
    }
    if (task.status === 'completed' || task.status === 'failed') {
      task.settledAt = new Date().toISOString()
      await this.#save(task)
      await this.#log(task, `${task.status}: ${truncate(task.lastText || task.error || '', 500)}`)
    }
    // A parked `wait_member` must hear about a terminal state (or an
    // interruption) without waiting for its own timeout. Waking it first lets
    // it take the result before the delivery grace window starts.
    this.#notifyWaiters(task)
    // The model may have stopped waiting after a `progress` reply. Unless a
    // `wait_member` call takes the result within the grace window, write it
    // back into the conversation that called `call_member`.
    if (task.notify && (task.status === 'completed' || task.status === 'failed')) {
      this.#scheduleDelivery(task)
    }
    return task
  }

  /**
   * Store the replies a wait response brought and wake parked `wait_member` calls.
   *
   * Replies are idempotent on their `seq`, so a response that repeats the last
   * reply (a `done` that follows a `progress` for the same turn) cannot make the
   * model read the same answer twice.
   * @param {object} task the tracked task.
   * @param {object} result wait response from the member.
   * @param {{notify?: boolean}} [options] `notify: false` when the caller will
   *   wake waiters itself after updating the task status.
   * @returns {Promise<boolean>} whether anything new arrived.
   */
  async #acceptReplies(task, result, options = {}) {
    const incoming = Array.isArray(result.replies) && result.replies.length > 0
      ? result.replies
      : (typeof result.text === 'string' && result.text !== '' && Number.isSafeInteger(result.seq)
          ? [{ seq: result.seq, turn: result.turn, text: result.text }]
          : [])
    const seen = Number.isSafeInteger(task.replySeq) ? task.replySeq : 0
    let added = false
    for (const reply of incoming) {
      if (!Number.isSafeInteger(reply?.seq) || reply.seq <= seen) continue
      if (typeof reply.text !== 'string' || reply.text.trim() === '') continue
      task.replies = Array.isArray(task.replies) ? task.replies : []
      task.replies.push({
        seq: reply.seq,
        turn: Number.isSafeInteger(reply.turn) ? reply.turn : null,
        text: truncate(reply.text, 20_000),
        at: typeof reply.at === 'string' ? reply.at : new Date().toISOString(),
      })
      if (task.replies.length > 30) task.replies.splice(0, task.replies.length - 30)
      task.replySeq = reply.seq
      task.lastText = truncate(reply.text, 20_000)
      added = true
    }
    if (!added) return false
    await this.#save(task)
    await this.#log(task, `reply ${String(task.replySeq)}: ${truncate(task.lastText, 300)}`)
    if (options.notify !== false) this.#notifyWaiters(task)
    return true
  }

  /**
   * True when a wait result proves a turn finished on the member.
   *
   * Members that report a turn counter let this be exact: the count has to grow.
   * An older member returns no counter, so its answer text is the only evidence.
   * @param {object} task the tracked task.
   * @param {object} conversation the member's conversation summary.
   * @returns {boolean} whether the conversation moved past the previous turn.
   */
  #turnAdvanced(task, conversation) {
    if (!Number.isSafeInteger(conversation.turns)) return String(conversation.lastText ?? '') !== ''
    return conversation.turns > (Number.isSafeInteger(task.turns) ? task.turns : 0)
  }

  /**
   * Hand a finished task's result to the calling conversation after a grace window.
   *
   * A parked `wait_member` is woken before this runs, and the model's next step
   * may still issue one; the window is what lets either of them consume the
   * terminal outcome first. The timer is unref'd so a pending delivery never
   * holds the process open on its own.
   * @param {object} task terminal task.
   * @returns {void}
   */
  #scheduleDelivery(task) {
    const previous = this.deliveryTimers.get(task.id)
    if (previous !== undefined) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.deliveryTimers.delete(task.id)
      void this.#deliverIfUnconsumed(task).catch(() => {})
    }, DELIVERY_GRACE_MS)
    timer.unref?.()
    this.deliveryTimers.set(task.id, timer)
  }

  /**
   * Deliver a terminal result unless a `wait_member` call already returned it.
   * @param {object} task terminal task.
   * @returns {Promise<void>} resolution after the notification attempt.
   */
  async #deliverIfUnconsumed(task) {
    if (this.disposed) return
    if (task.status !== 'completed' && task.status !== 'failed') return
    if (task.terminalDelivered === true) {
      await this.#log(task, 'delivery skipped: a wait_member call already returned the result')
      return
    }
    await this.#notify(task)
  }

  /**
   * Retry a delivery whose origin conversation is not live yet.
   *
   * A plugin restart can finish the notification before the Web client
   * reopens its session. The backoff keeps trying while the user may still be
   * coming back, then leaves the result recorded as a notifyError.
   * @param {object} task terminal task.
   * @returns {void}
   */
  #scheduleNotifyRetry(task) {
    const previous = this.notifyTimers.get(task.id)
    if (previous !== undefined) clearTimeout(previous)
    const retry = Number.isSafeInteger(task.notifyRetries) ? task.notifyRetries : 1
    const delay = Math.min(10_000 * 2 ** (retry - 1), 300_000)
    const timer = setTimeout(() => {
      this.notifyTimers.delete(task.id)
      if (this.disposed || task.notified) return
      void this.#notify(task).catch(() => {})
    }, delay)
    timer.unref?.()
    this.notifyTimers.set(task.id, timer)
  }

  async #notify(task) {
    const agents = typeof this.ctx.get === 'function' ? this.ctx.get('agents') : this.ctx.agents
    const agent = agents?.get?.(task.originAgentId)
    if (agent === undefined || agent === null) {
      task.notifyError = 'the originating conversation is no longer live'
      task.notifyRetries = Number.isSafeInteger(task.notifyRetries) ? task.notifyRetries : 0
      if (task.notifyRetries < NOTIFY_RETRY_LIMIT) {
        task.notifyRetries += 1
        this.#scheduleNotifyRetry(task)
      }
      await this.#save(task)
      await this.#log(task, `notification deferred: origin agent unavailable (retry ${String(task.notifyRetries)})`)
      return
    }
    const text = task.status === 'completed'
      ? [
        `[成员任务完成] ${task.member} (${task.memberIp}) 的对话 ${task.conversationId} 已完成。`,
        `任务：${truncate(task.prompt, 300)}`,
        '结果：',
        truncate(task.lastText || '(成员没有返回文本结果)', 8000),
        '',
        `会话id: ${task.conversationId}`,
      ].join('\n')
      : [
        `[成员任务失败] ${task.member} (${task.memberIp}) 的对话 ${task.conversationId} 失败。`,
        `任务：${truncate(task.prompt, 300)}`,
        `错误：${task.error ?? 'unknown'}`,
        ...(task.interrupted === true
          ? ['', `目标的 DSH 重启（或运行时退出）打断了这一轮。对话和上下文还在：用 call_member 带 conversationId ${task.conversationId} 继续，或新开一个任务。`]
          : []),
        '',
        `会话id: ${task.conversationId}`,
      ].join('\n')
    try {
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
      const pending = this.notifyTimers.get(task.id)
      if (pending !== undefined) {
        clearTimeout(pending)
        this.notifyTimers.delete(task.id)
      }
      task.notified = true
      task.notifiedAt = new Date().toISOString()
      task.notifyError = null
      task.notifyRetries = 0
      await this.#save(task)
      await this.#log(task, `notification queued into ${task.originSessionId}`)
    } catch (error) {
      task.notifyError = error instanceof Error ? error.message : String(error)
      await this.#save(task)
      await this.#log(task, `notification failed: ${task.notifyError}`)
    }
  }

  async status(taskId) {
    await this.#ensureLoaded()
    const task = this.tasks.get(String(taskId))
    if (task === undefined) return null
    return task
  }

  /**
   * Read the target member's host inventory from its interop service.
   * @param {string} member member id/name/ip/url.
   * @returns {Promise<object>} system information.
   */
  async system(member) {
    const target = await this.#resolveMember(member)
    const result = await this.#request(target.baseUrl, 'GET', '/v1/system?sampleMs=200', undefined, 15_000)
    if (result?.system === undefined || typeof result.system !== 'object') {
      throw new Error('member interop returned no system information')
    }
    return { ...result.system, member: target.name, memberIp: target.ip }
  }

  async list() {
    await this.#ensureLoaded()
    return [...this.tasks.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  async logs(taskId, lines = 80) {
    await this.#ensureLoaded()
    const task = this.tasks.get(String(taskId))
    if (task === undefined) return ''
    try {
      const text = await readFile(path.join(this.taskRoot, `${task.id}.log`), 'utf8')
      return text.split('\n').slice(-Math.max(1, Math.min(lines, 500))).join('\n')
    } catch {
      return ''
    }
  }

  /**
   * Absolute path of one task's log file.
   * @param {string} taskId task id.
   * @returns {string} log path.
   */
  logPath(taskId) {
    return path.join(this.taskRoot, `${String(taskId)}.log`)
  }
}
