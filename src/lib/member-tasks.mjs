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
    const created = await this.#request(target.baseUrl, 'POST', '/v1/conversations', payload, 60_000)
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
    const result = await this.#request(task.baseUrl, 'POST', `/v1/conversations/${encodeURIComponent(task.conversationId)}/messages`, { content }, 30_000)
    task.status = 'running'
    task.error = null
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
        task.status = conversation.status === 'idle'
          ? (conversation.error ? 'failed' : 'completed')
          : 'running'
        if (task.status === 'completed' || task.status === 'failed') break
      } catch (error) {
        task.error = error instanceof Error ? error.message : String(error)
        await this.#log(task, `wait failed: ${task.error}`)
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
   * Absolute path of one task's log file.
   * @param {string} taskId task id.
   * @returns {string} log path.
   */
  logPath(taskId) {
    return path.join(this.taskRoot, `${String(taskId)}.log`)
  }
}
