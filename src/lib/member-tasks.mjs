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

const DEFAULT_INTEROP_PORT = 8765
const WAIT_TIMEOUT_MS = 60_000
const MAX_ATTEMPTS = 30
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
    /** Cached `{ id, name, ip }` of this machine, filled by the first member lookup. */
    this.identity = null
    this.loaded = false
    this.disposed = false
  }

  async dispose() {
    this.disposed = true
    for (const task of this.tasks.values()) {
      if (task.status === 'running' || task.status === 'starting') {
        task.status = 'interrupted'
        task.error = 'the plugin stopped before the member conversation completed'
        await this.#save(task).catch(() => {})
      }
    }
  }

  async #ensureLoaded() {
    if (this.loaded) return
    this.loaded = true
    await mkdir(this.taskRoot, { recursive: true })
    let files = []
    try { files = await readdir(this.taskRoot) } catch { }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const task = JSON.parse(await readFile(path.join(this.taskRoot, file), 'utf8'))
        if (task?.id === undefined) continue
        if (task.status === 'running' || task.status === 'starting') {
          task.status = 'interrupted'
          task.error = 'the plugin restarted before the member conversation completed'
          await this.#save(task)
        }
        this.tasks.set(task.id, task)
      } catch { }
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

  async #request(baseUrl, method, endpoint, body, timeoutMs = 30_000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), Math.max(1000, timeoutMs))
    timer.unref?.()
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
   * Wait out a member runtime that is still booting.
   *
   * A member's interop answers 503 while its SDK child starts, which is exactly
   * the window right after that machine's DSH restarted. A tool call made in
   * that window should wait for it instead of failing outright.
   * @param {() => Promise<any>} attempt one request.
   * @param {number} [budgetMs] how long to keep waiting.
   * @returns {Promise<any>} the request result.
   */
  async #waitForRuntime(attempt, budgetMs = 90_000) {
    const deadline = Date.now() + budgetMs
    for (;;) {
      try {
        return await attempt()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const starting = /SDK runtime is not ready|sdk_unavailable|SDK runtime is still starting/iu.test(message)
        if (!starting || Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 2_000))
      }
    }
  }

  async start({ member, prompt, cwd, agent, notify = true }) {
    await this.#ensureLoaded()
    if (typeof prompt !== 'string' || prompt.trim() === '') throw new Error('prompt is required')
    if (agent === undefined || agent === null) throw new Error('delegation must be called from a DSH conversation')
    const target = await this.#resolveMember(member)
    const payload = {
      prompt,
      // The member's panel lists these; without a title it would show a UUID.
      title: truncate(prompt, 80),
      initiator: { ...(this.identity ?? { id: 'local' }), source: 'call_member' },
      ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
    }
    const created = await this.#waitForRuntime(
      () => this.#request(target.baseUrl, 'POST', '/v1/conversations', payload, 60_000),
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
      notify,
      notified: false,
      notifiedAt: null,
      notifyError: null,
      originAgentId: String(agent.id ?? ''),
      originSessionId: String(agent.session?.id ?? ''),
    }
    this.tasks.set(task.id, task)
    await this.#save(task)
    await this.#log(task, `created ${conversation.id} on ${target.baseUrl}`)
    const monitor = this.#monitor(task)
    this.monitors.set(task.id, monitor)
    void monitor.finally(() => this.monitors.delete(task.id)).catch(() => {})
    return task
  }

  async run(options) {
    const task = await this.start({ ...options, notify: false })
    await this.monitors.get(task.id)
    return this.tasks.get(task.id) ?? task
  }

  async send(taskId, content) {
    await this.#ensureLoaded()
    const task = this.tasks.get(String(taskId))
    if (task === undefined) throw new Error('member task not found')
    if (typeof content !== 'string' || content.trim() === '') throw new Error('content is required')
    const result = await this.#waitForRuntime(
      () => this.#request(task.baseUrl, 'POST', `/v1/conversations/${encodeURIComponent(task.conversationId)}/messages`, { content }, 30_000),
    )
    task.status = 'running'
    task.error = null
    task.interrupted = false
    task.attempts = 0
    task.emptyWaits = 0
    task.notified = false
    task.notifiedAt = null
    task.notifyError = null
    task.notify = true
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
   * Send a message typed in the panel to one or more members.
   *
   * A member whose conversation is still running gets the text as a follow-up;
   * everyone else gets a fresh conversation. No task is created and nothing is
   * notified back: the panel reads conversations straight from each member, so
   * the answer shows up in the group chat on the next refresh.
   * @param {{text: string, members?: string[]}} input text and target ids/ips.
   * @returns {Promise<{ok: boolean, sent: object[], errors: object[]}>} outcome.
   */
  async sendTo({ text, members = [] }) {
    const content = String(text ?? '').trim()
    if (content === '') throw new Error('text is required')
    const snapshot = await this.service.members()
    this.identity = this.identity ?? {
      id: String(snapshot.local?.id ?? 'local'),
      name: String(snapshot.local?.name ?? snapshot.local?.id ?? 'local'),
      ip: String(snapshot.local?.ip ?? ''),
    }
    const others = [snapshot.local, ...(Array.isArray(snapshot.members) ? snapshot.members : [])]
      .filter(Boolean)
      .filter(member => member.kind !== 'self' && member.self !== true)
    const wanted = (Array.isArray(members) ? members : [])
      .map(item => String(item).trim())
      .filter(item => item !== '')
    /** @type {object[]} */
    const targets = []
    if (wanted.length === 0) {
      targets.push(...others)
    } else {
      for (const item of wanted) {
        const match = others.find(member => [String(member.id), String(member.ip), String(member.name)].includes(item))
        if (match !== undefined) {
          if (!targets.includes(match)) targets.push(match)
          continue
        }
        const resolved = await this.#resolveMember(item).catch(() => null)
        if (resolved !== null && !targets.some(member => member.ip === resolved.ip)) targets.push(resolved)
      }
    }
    if (targets.length === 0) throw new Error('no member to send to')
    const sent = []
    const errors = []
    await Promise.all(targets.map(async (member) => {
      const name = String(member.name ?? member.id ?? member.ip ?? '')
      const ip = String(member.ip ?? '')
      const label = ip === '' ? name : `${name} (${ip})`
      try {
        const baseUrl = this.#baseUrl(ip === '' ? name : ip)
        const listed = await this.#request(baseUrl, 'GET', '/v1/conversations', undefined, 8000).catch(() => null)
        const live = (Array.isArray(listed?.conversations) ? listed.conversations : [])
          .find(row => row.status === 'running' && this.#isOwnConversation(row))
        if (live !== undefined) {
          await this.#request(baseUrl, 'POST', `/v1/conversations/${encodeURIComponent(live.id)}/messages`, { content }, 30_000)
          sent.push({ member: name, ip, conversationId: String(live.id), reused: true })
          return
        }
        const created = await this.#request(baseUrl, 'POST', '/v1/conversations', {
          prompt: content,
          // The panel clamps the bubble, so the whole text is the title: a
          // truncated one would never be recoverable through 详细.
          title: content.length > 2000 ? `${content.slice(0, 2000)}…` : content,
          initiator: { ...this.identity, source: 'panel' },
        }, 60_000)
        const conversation = created?.conversation ?? {}
        sent.push({ member: name, ip, conversationId: String(conversation.id ?? ''), reused: false })
      } catch (error) {
        errors.push({ member: label, ip, error: error instanceof Error ? error.message : String(error) })
      }
    }))
    return { ok: true, sent, errors }
  }

  /**
   * True when a member's conversation was started from this machine.
   * @param {object} row conversation summary.
   * @returns {boolean} whether this host initiated it.
   */
  #isOwnConversation(row) {
    const initiator = row?.initiator ?? null
    if (initiator === null || this.identity === null) return false
    if (initiator.id !== undefined && String(initiator.id) === String(this.identity.id)) return true
    return initiator.ip !== undefined && String(initiator.ip) !== '' && String(initiator.ip) === String(this.identity.ip)
  }

  async #monitor(task) {
    while (!this.disposed && (task.status === 'running' || task.status === 'starting')) {
      task.attempts += 1
      try {
        const result = await this.#request(
          task.baseUrl,
          'POST',
          `/v1/conversations/${encodeURIComponent(task.conversationId)}/wait`,
          { timeoutMs: WAIT_TIMEOUT_MS },
          WAIT_TIMEOUT_MS + 10_000,
        )
        if (result.timedOut === true) {
          task.status = 'running'
          await this.#save(task)
          continue
        }
        if (this.disposed) break
        const conversation = result.conversation ?? {}
        task.lastText = typeof conversation.lastText === 'string' ? conversation.lastText : ''
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
    if (this.disposed && task.status === 'running') {
      task.status = 'interrupted'
      task.error = 'the plugin stopped before the member conversation completed'
    }
    if (task.status === 'completed' || task.status === 'failed') {
      await this.#save(task)
      await this.#log(task, `${task.status}: ${truncate(task.lastText || task.error || '', 500)}`)
      if (task.notify) await this.#notify(task)
    }
    return task
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

  async #notify(task) {
    const agents = typeof this.ctx.get === 'function' ? this.ctx.get('agents') : this.ctx.agents
    const agent = agents?.get?.(task.originAgentId)
    if (agent === undefined || agent === null) {
      task.notifyError = 'the originating conversation is no longer live'
      await this.#save(task)
      await this.#log(task, 'notification skipped: origin agent unavailable')
      return
    }
    const text = task.status === 'completed'
      ? [
        `[成员任务完成] ${task.member} (${task.memberIp}) 的对话 ${task.conversationId} 已完成。`,
        `任务：${truncate(task.prompt, 300)}`,
        '结果：',
        truncate(task.lastText || '(成员没有返回文本结果)', 8000),
        '',
        `taskId: ${task.id}`,
      ].join('\n')
      : [
        `[成员任务失败] ${task.member} (${task.memberIp}) 的对话 ${task.conversationId} 失败。`,
        `任务：${truncate(task.prompt, 300)}`,
        `错误：${task.error ?? 'unknown'}`,
        ...(task.interrupted === true
          ? ['', '目标的 DSH 重启（或运行时退出）打断了这一轮。对话和上下文还在：用 call_member send 同一个 taskId 继续，或重新 delegate 一个新任务。']
          : []),
        '',
        `taskId: ${task.id}`,
      ].join('\n')
    try {
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
      task.notified = true
      task.notifiedAt = new Date().toISOString()
      task.notifyError = null
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
   * List the conversations every member's interop service currently controls.
   *
   * A slow or offline member degrades to an `error` entry so one bad peer does
   * not hide the rest of the list.
   * @param {number} [timeoutMs] per-member request budget.
   * @returns {Promise<{ok: boolean, updatedAt: string, groups: object[]}>} groups by member.
   */
  async listByMember(timeoutMs = 4000) {
    const snapshot = await this.service.members()
    this.identity = this.identity ?? {
      id: String(snapshot.local?.id ?? 'local'),
      name: String(snapshot.local?.name ?? snapshot.local?.id ?? 'local'),
      ip: String(snapshot.local?.ip ?? ''),
    }
    const members = [snapshot.local, ...(Array.isArray(snapshot.members) ? snapshot.members : [])].filter(Boolean)
    const groups = await Promise.all(members.map(async (member) => {
      const summary = {
        id: String(member.id),
        name: String(member.name ?? member.id),
        ip: String(member.ip ?? ''),
        online: member.online !== false,
        self: member.kind === 'self',
        dsh: member.dsh === true,
      }
      if (summary.ip === '') return { ...summary, conversations: [], error: 'no VPN address' }
      try {
        const data = await this.#request(this.#baseUrl(summary.ip), 'GET', '/v1/conversations', undefined, timeoutMs)
        return { ...summary, conversations: Array.isArray(data?.conversations) ? data.conversations : [], error: null }
      } catch (error) {
        return { ...summary, conversations: [], error: error instanceof Error ? error.message : String(error) }
      }
    }))
    groups.sort((left, right) => {
      if (left.self !== right.self) return left.self ? -1 : 1
      if (left.online !== right.online) return left.online ? -1 : 1
      return left.name.localeCompare(right.name)
    })
    return { ok: true, updatedAt: new Date().toISOString(), groups }
  }

  /**
   * Delete the finished conversations each member's interop service holds. A
   * running one is left alone: its SDK session still owns it.
   * @param {number} timeoutMs per-member timeout.
   * @returns {Promise<{ok: boolean, removed: number, errors: object[]}>} summary.
   */
  async clearConversations(timeoutMs = 8000) {
    const state = await this.service.members()
    const members = [state.local, ...(Array.isArray(state.members) ? state.members : [])].filter(Boolean)
    let removed = 0
    const errors = []
    for (const member of members) {
      const ip = String(member.ip ?? '')
      if (ip === '') continue
      try {
        const data = await this.#request(this.#baseUrl(ip), 'DELETE', '/v1/conversations', undefined, timeoutMs)
        if (Number.isInteger(data?.removed)) removed += data.removed
      } catch (error) {
        errors.push({ member: String(member.name ?? ip), ip, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { ok: true, removed, errors }
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
