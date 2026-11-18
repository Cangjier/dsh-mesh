/**
 * In-process member interop service.
 *
 * This is the embedded twin of `code/interop-service/server.mjs`. That service
 * drove a child `dsh --profile sdk` over stdio JSON-RPC; this one drives agents
 * through the Web host's own `ctx.agents` registry, so the session a task runs
 * in is owned by the same DSH process the Web UI (and its session list) talks
 * to. There is no second writer, no cold read of a live log, and therefore no
 * synthetic "interrupted" turn while the task is still running.
 *
 * The HTTP contract is unchanged: the gateway control service, the member task
 * tool, and the mesh panel keep using `/v1/conversations`, `/v1/system`,
 * `/healthz`, and the same bearer token.
 */

import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  INTERRUPTED_ERROR,
  conversationRecord,
  normalizeInitiator,
  normalizeTitle,
  promptText,
  restoredConversation,
  titleFromPrompt,
} from '../../code/shared/conversation-meta.mjs'
import { applySessionEvent, repliesSince, summarizeReplies } from '../../code/shared/conversation-replies.mjs'
import { collectSystemInfo } from '../../code/shared/system-info.mjs'

const execFileAsync = promisify(execFile)

/** How many events one conversation keeps for late `/events` readers. */
const MAX_EVENTS = 5000
/** Stable marker a rollback can find in a built plugin bundle. */
export const EMBEDDED_INTEROP_MARKER = 'dsh-mesh-embedded-interop-v1'
/** Largest accepted JSON body. */
const MAX_BODY = 1024 * 1024
/** How long "the whole task ended" may take to show up before a reply is called progress. */
const SETTLE_MS = 300

/**
 * Read a KEY=VALUE file, ignoring comments and stripping simple quotes.
 * @param {string} file path.
 * @returns {Record<string, string>} entries.
 */
export function readEnvFile(file) {
  const values = {}
  if (!existsSync(file)) return values
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const at = line.indexOf('=')
    if (at <= 0) continue
    const name = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[name] = value
  }
  return values
}

/**
 * Directories that may contain `config/interop.env`, nearest first.
 * @returns {string[]} candidate files.
 */
function configCandidates() {
  const candidates = []
  const explicit = process.env.DSH_INTEROP_CONFIG
  if (typeof explicit === 'string' && explicit.trim() !== '') candidates.push(path.resolve(explicit))
  const packageRoot = process.env.DSH_PACKAGE_ROOT
  if (typeof packageRoot === 'string' && packageRoot.trim() !== '') {
    candidates.push(path.join(packageRoot, 'config', 'interop.env'))
  }
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.trim() !== '') {
    candidates.push(path.join(path.dirname(home), 'config', 'interop.env'))
    candidates.push(path.join(home, 'config', 'interop.env'))
  }
  let current = process.cwd()
  for (let depth = 0; depth < 7; depth += 1) {
    candidates.push(path.join(current, 'config', 'interop.env'))
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return candidates
}

/**
 * Find the deployed interop configuration file.
 * @returns {string | null} path when one exists.
 */
export function findInteropConfig() {
  for (const candidate of configCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Read a boolean setting.
 * @param {unknown} value raw value.
 * @param {boolean} fallback default.
 * @returns {boolean} parsed value.
 */
function asBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string' || value.trim() === '') return fallback
  return /^(1|true|yes|on)$/iu.test(value.trim())
}

/**
 * Resolve every setting the embedded interop needs.
 *
 * The deployed `config/interop.env` wins over the plugin row config, exactly as
 * the standalone service did: a member that changes its token or bind address
 * there does not also have to change the DSH profile patch.
 * @param {Record<string, any>} [config] plugin row configuration.
 * @returns {Record<string, any>} settings.
 */
export function resolveInteropSettings(config = {}) {
  const file = findInteropConfig()
  const root = file === null ? null : path.dirname(path.dirname(file))
  const values = file === null ? {} : readEnvFile(file)
  const setting = (name, fallback) => {
    const fromEnv = process.env[name]
    if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
    if (typeof values[name] === 'string' && values[name] !== '') return values[name]
    return fallback
  }

  const useGatePassword = asBool(
    setting('DSH_INTEROP_USE_GATE_PASSWORD', config.interopUseGatePassword === true ? '1' : '0'),
    false,
  )
  const dataDir = root === null
    ? path.join(process.env.DSH_HOME ?? path.join(process.cwd(), '.dsh'), 'mesh', 'interop')
    : path.join(root, 'data')
  const tokenFile = path.join(dataDir, 'interop-token')
  let gatePassword = typeof process.env.DSH_GATE_PASSWORD === 'string' ? process.env.DSH_GATE_PASSWORD : ''
  if (useGatePassword && gatePassword === '' && root !== null) {
    gatePassword = readEnvFile(path.join(root, 'config', 'gate.env')).DSH_GATE_PASSWORD ?? ''
  }
  let token = ''
  if (useGatePassword) {
    token = gatePassword
  } else {
    token = setting('DSH_INTEROP_TOKEN', '')
    if (token === '' && typeof config.interopToken === 'string') token = config.interopToken
    if (token === '' && existsSync(tokenFile)) {
      const saved = readFileSync(tokenFile, 'utf8').trim()
      if (saved.length >= 32) token = saved
    }
    if (token === '') {
      token = randomBytes(32).toString('hex')
      try {
        mkdirSync(dataDir, { recursive: true, mode: 0o700 })
        writeFileSync(tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
      } catch { }
    }
  }

  const configuredPort = Number.parseInt(
    setting('DSH_INTEROP_PORT', String(config.interopPort ?? 8765)),
    10,
  )
  const port = Number.isSafeInteger(configuredPort) && configuredPort > 0
    ? configuredPort
    : Number.isSafeInteger(config.interopPort) && config.interopPort > 0 ? config.interopPort : 8765
  const preset = setting('DSH_INTEROP_PRESET', 'workspace-write')
  const agentPreset = setting('DSH_INTEROP_AGENT_PRESET', 'standard')
  const reasoning = setting('DSH_INTEROP_REASONING_EFFORT', '')
  const workdir = setting(
    'DSH_WORKDIR',
    root === null ? process.cwd() : path.join(root, 'workspace'),
  )
  return {
    file,
    root,
    dataDir,
    tokenFile,
    logFile: path.join(dataDir, 'interop-service.log'),
    stateFile: path.join(dataDir, 'conversations.json'),
    token,
    useGatePassword,
    tokenSource: useGatePassword ? 'gate password' : file === null ? 'generated token file' : 'interop.env',
    bind: setting('DSH_INTEROP_BIND', '127.0.0.1'),
    port,
    provider: setting('DSH_INTEROP_PROVIDER', 'deepseek-official'),
    model: setting('DSH_INTEROP_MODEL', 'deepseek-flash'),
    reasoningEffort: reasoning === '' ? undefined : reasoning,
    approve: asBool(setting('DSH_INTEROP_APPROVE', '0'), false),
    preset,
    agentPreset,
    workdir: path.resolve(workdir),
    // Task workspaces are always below this root, so a workspace name sent by
    // the panel can never address an arbitrary directory on the member.
    workspaceRoot: path.resolve(setting('DSH_WORKSPACES_DIR', path.join(homedir(), '.dsh', 'workspaces'))),
    requestTimeoutMs: Number.parseInt(setting('DSH_INTEROP_REQUEST_TIMEOUT_MS', '180000'), 10),
  }
}

/**
 * Validate one workspace name.
 *
 * A name is one directory below the workspace root: no separators, no `.` /
 * `..`, and no control characters. Chinese names and spaces are allowed.
 * @param {unknown} value raw name.
 * @returns {string} cleaned name, or '' when empty.
 */
function normalizeWorkspaceName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name === '') return ''
  if (name.length > 120) throw httpError(400, 'workspace_invalid', 'workspace name is too long')
  if (name === '.' || name === '..' || /[\\/"]/u.test(name) || /[\u0000-\u001f]/u.test(name)) {
    throw httpError(400, 'workspace_invalid', 'workspace name cannot contain a path separator or a quote')
  }
  return name
}

/**
 * Resolve one workspace name to its absolute directory.
 * @param {Record<string, any>} settings interop settings.
 * @param {string} name validated name.
 * @returns {string} absolute path.
 */
function workspacePath(settings, name) {
  return path.join(workspaceRootOf(settings), name)
}

/**
 * The workspace root, with the documented default when settings omit it.
 * @param {Record<string, any>} settings interop settings.
 * @returns {string} absolute root.
 */
function workspaceRootOf(settings) {
  const root = settings.workspaceRoot
  return typeof root === 'string' && root.trim() !== ''
    ? path.resolve(root)
    : path.join(homedir(), '.dsh', 'workspaces')
}

/**
 * Every directory directly below the workspace root.
 * @param {Record<string, any>} settings interop settings.
 * @returns {{dir: string, workspaces: Array<{name: string, path: string}>}} listing.
 */
function listWorkspaces(settings) {
  const dir = workspaceRootOf(settings)
  try {
    mkdirSync(dir, { recursive: true })
  } catch { }
  const workspaces = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      workspaces.push({ name: entry.name, path: path.join(dir, entry.name) })
    }
  } catch { }
  workspaces.sort((left, right) => left.name.localeCompare(right.name))
  return { dir, workspaces }
}

/**
 * One HTTP error with a stable status and code.
 * @param {number} status HTTP status.
 * @param {string} code stable code.
 * @param {string} message human message.
 * @returns {Error & {status: number, code: string}} error.
 */
function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

/**
 * Write one JSON response.
 * @param {http.ServerResponse} response response.
 * @param {number} status status.
 * @param {unknown} value body.
 * @returns {void}
 */
function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * Write one failure response.
 * @param {http.ServerResponse} response response.
 * @param {number} status status.
 * @param {string} code stable code.
 * @param {string} message message.
 * @returns {void}
 */
function fail(response, status, code, message) {
  json(response, status, { ok: false, error: { code, message } })
}

/**
 * Read one bounded JSON object body.
 * @param {http.IncomingMessage} request request.
 * @returns {Promise<Record<string, any>>} parsed body.
 */
function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(httpError(413, 'body_too_large', 'request body is too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (size === 0) { resolve({}); return }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
        resolve(value)
      } catch {
        reject(httpError(400, 'invalid_json', 'request body is not a JSON object'))
      }
    })
    request.on('error', reject)
  })
}

/**
 * Validate and normalize prompt content blocks.
 * @param {unknown} value prompt or content.
 * @returns {Array<Record<string, any>>} blocks.
 */
function contentBlocks(value) {
  if (typeof value === 'string') {
    if (value.trim() === '') throw httpError(400, 'empty_content', 'content is empty')
    return [{ type: 'text', text: value }]
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw httpError(400, 'invalid_content', 'content must be a string or a non-empty content block array')
  }
  const blocks = value.map((block) => {
    if (block === null || typeof block !== 'object') throw httpError(400, 'invalid_content', 'invalid content block')
    if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text }
    if (block.type === 'image' && typeof block.data === 'string' && typeof block.mediaType === 'string') {
      return { type: 'image', data: block.data, mediaType: block.mediaType, ...(typeof block.name === 'string' ? { name: block.name } : {}) }
    }
    if (block.type === 'file' && typeof block.receiptId === 'string') return { type: 'file', receiptId: block.receiptId }
    throw httpError(400, 'invalid_content', 'unsupported content block')
  })
  if (!blocks.some(block => block.type !== 'text' || block.text.trim() !== '')) {
    throw httpError(400, 'empty_content', 'content is empty')
  }
  return blocks
}

/**
 * Build one durable user message for the agent inbox.
 * @param {Array<Record<string, any>>} blocks content.
 * @returns {Record<string, any>} user message.
 */
function userMessage(blocks) {
  return { id: randomUUID(), role: 'user', content: blocks, source: { kind: 'user' } }
}

/**
 * The embedded interop service.
 *
 * @param {object} options options.
 * @param {any} options.ctx host context (carries `agents`, `on`, `get`, `effect`).
 * @param {Record<string, any>} [options.settings] resolved settings.
 * @param {Record<string, any>} [options.config] plugin row config.
 * @param {(line: string) => void} [options.log] logger.
 * @param {boolean} [options.retry] retry a listener that cannot bind (production).
 * @returns {object} service.
 */
export function createInteropService(options) {
  const ctx = options.ctx
  const config = options.config ?? {}
  const settings = options.settings ?? resolveInteropSettings(config)
  const logLine = options.log ?? (() => {})
  const retry = options.retry !== false

  /** @type {Map<string, string>} */
  const conversations = new Map()
  /** @type {Map<string, string>} */
  const bySession = new Map()
  /** @type {Map<string, {agent: any, dispose: () => Promise<void>}>} */
  const handles = new Map()
  const listeners = []
  let server = null
  let stopped = false
  let saveTimer = null
  let saving = false
  let retryTimer = null
  let started = false
  let listening = false

  mkdirSync(settings.dataDir, { recursive: true, mode: 0o700 })
  mkdirSync(settings.workdir, { recursive: true })

  /**
   * Log one line to the service log and the host console.
   * @param {string} line message.
   * @returns {void}
   */
  function log(line) {
    const text = `[interop ${new Date().toISOString()}] ${line}`
    try { writeFileSync(settings.logFile, `${text}\n`, { encoding: 'utf8', flag: 'a' }) } catch { }
    logLine(text)
  }

  const tokenDigest = settings.token === ''
    ? null
    : createHash('sha256').update(settings.token).digest()

  /**
   * Whether a request carries the interop token.
   * @param {http.IncomingMessage} request request.
   * @returns {boolean} authorized.
   */
  function authorized(request) {
    if (tokenDigest === null) return false
    const header = request.headers.authorization ?? ''
    const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : String(request.headers['x-dsh-interop-token'] ?? '')
    if (raw === '') return false
    const digest = createHash('sha256').update(raw).digest()
    return digest.length === tokenDigest.length && timingSafeEqual(digest, tokenDigest)
  }

  /**
   * One conversation's public projection.
   * @param {Record<string, any>} conversation conversation.
   * @returns {Record<string, any>} projection.
   */
  function publicConversation(conversation) {
    return {
      id: conversation.id,
      sessionId: conversation.sessionId,
      status: conversation.status,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      lastText: conversation.lastText,
      error: conversation.error,
      eventCount: conversation.events.length,
      cwd: conversation.cwd,
      workspace: conversation.workspace ?? '',
      // The title is capped at 80 characters for the list; the panel's detail
      // view reads the real first prompt from here.
      prompt: conversation.prompt ?? '',
      title: conversation.title ?? '',
      initiator: conversation.initiator ?? null,
      turns: Number.isSafeInteger(conversation.turns) ? conversation.turns : 0,
      replySeq: Number.isSafeInteger(conversation.replySeq) ? conversation.replySeq : 0,
    }
  }

  /**
   * Update one conversation and schedule a save.
   * @param {Record<string, any>} conversation conversation.
   * @param {Record<string, any>} patch fields.
   * @returns {void}
   */
  function updateConversation(conversation, patch) {
    Object.assign(conversation, patch, { updatedAt: new Date().toISOString() })
    scheduleSave()
  }

  /**
   * Wake every waiter parked on one conversation.
   * @param {Record<string, any>} conversation conversation.
   * @returns {void}
   */
  function wake(conversation) {
    const waiters = conversation.waiters
    if (!(waiters instanceof Set) || waiters.size === 0) return
    const parked = [...waiters]
    waiters.clear()
    for (const resolve of parked) {
      try { resolve() } catch { }
    }
  }

  /**
   * Broadcast one SSE frame to every live reader.
   * @param {Record<string, any>} conversation conversation.
   * @param {Record<string, any>} payload frame.
   * @returns {void}
   */
  function broadcast(conversation, payload) {
    for (const client of conversation.clients) {
      try {
        client.write(`event: ${payload.type ?? 'message'}\ndata: ${JSON.stringify(payload)}\n\n`)
      } catch { }
    }
  }

  /**
   * Persist the slim conversation records.
   * @returns {void}
   */
  function saveState() {
    if (saving) return
    saving = true
    try {
      const payload = {
        version: 1,
        savedAt: new Date().toISOString(),
        conversations: [...conversations.values()].map(conversationRecord),
      }
      const temporary = `${settings.stateFile}.tmp`
      writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`)
      renameSync(temporary, settings.stateFile)
    } catch (error) {
      log(`could not persist conversations: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      saving = false
    }
  }

  /**
   * Schedule one save after the current burst of events.
   * @returns {void}
   */
  function scheduleSave() {
    if (saveTimer !== null || stopped) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveState()
    }, 500)
    saveTimer.unref?.()
  }

  /**
   * Restore the persisted conversations.
   *
   * A turn that was in flight when this process stopped cannot come back, so it
   * is reported as interrupted exactly as the standalone service did.
   * @returns {void}
   */
  function loadState() {
    if (!existsSync(settings.stateFile)) return
    try {
      const parsed = JSON.parse(readFileSync(settings.stateFile, 'utf8'))
      const records = Array.isArray(parsed?.conversations) ? parsed.conversations : []
      for (const record of records) {
        if (typeof record?.id !== 'string' || conversations.has(record.id)) continue
        const restored = restoredConversation(record, settings.workdir)
        const conversation = {
          ...restored,
          events: [],
          clients: new Set(),
          callbackUrl: '',
          notifiedAt: null,
          replySeq: 0,
          replies: [],
          turnText: '',
          idle: true,
          settledAt: null,
          waiters: new Set(),
          prompted: restored.status !== 'blank',
          agent: null,
          handle: null,
          failed: restored.status === 'error',
          interrupted: restored.status === 'interrupted',
        }
        conversations.set(conversation.id, conversation)
        bySession.set(conversation.sessionId, conversation)
      }
      if (conversations.size > 0) log(`restored ${String(conversations.size)} conversation(s) from ${settings.stateFile}`)
    } catch (error) {
      log(`could not restore conversations: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Fold one session event into its conversation.
   * @param {Record<string, any>} conversation conversation.
   * @param {Record<string, any>} event session event.
   * @returns {void}
   */
  function appendEvent(conversation, event) {
    conversation.events.push(event)
    if (conversation.events.length > MAX_EVENTS) {
      conversation.events.splice(0, conversation.events.length - MAX_EVENTS)
    }
    const reply = applySessionEvent(conversation, event)
    if (event?.type === 'turn/start') {
      conversation.idle = false
      conversation.prompted = true
      conversation.status = 'running'
      conversation.error = null
      conversation.failed = false
      conversation.interrupted = false
    } else if (event?.type === 'turn/end') {
      const kind = event?.data?.reason?.kind
      if (kind === 'error') {
        conversation.failed = true
        conversation.error = conversation.error ?? event?.data?.reason?.error?.message ?? 'turn ended with an error'
      } else if (kind === 'aborted') {
        conversation.interrupted = true
        conversation.error = conversation.error ?? '对话被中断了。'
      }
    }
    conversation.updatedAt = new Date().toISOString()
    broadcast(conversation, { type: 'session.event', sessionId: conversation.sessionId, event })
    if (reply !== null) wake(conversation)
    scheduleSave()
  }

  /**
   * Map the agent lifecycle to the conversation status.
   * @param {Record<string, any>} conversation conversation.
   * @param {'idle' | 'running'} status agent status.
   * @returns {void}
   */
  function handleAgentStatus(conversation, status) {
    if (status === 'running') {
      conversation.idle = false
      if (conversation.prompted) conversation.status = 'running'
      wake(conversation)
      scheduleSave()
      return
    }
    conversation.idle = true
    conversation.settledAt = new Date().toISOString()
    if (!conversation.prompted && conversation.status === 'blank') {
      conversation.status = 'blank'
    } else if (conversation.interrupted) {
      conversation.status = 'interrupted'
    } else if (conversation.failed || conversation.error !== null) {
      conversation.status = 'error'
    } else {
      conversation.status = 'idle'
    }
    conversation.updatedAt = new Date().toISOString()
    broadcast(conversation, { type: 'session.settled', sessionId: conversation.sessionId })
    void notifyCallback(conversation)
    wake(conversation)
    scheduleSave()
  }

  /**
   * Re-read the live agent status before answering a poll.
   *
   * The event listener normally keeps this exact, but a missed `agent/status`
   * idle (for example a listener attached after creation) must not leave a
   * finished task running forever in history.
   * @param {Record<string, any>} conversation conversation.
   * @returns {void}
   */
  function reconcileStatus(conversation) {
    const agent = conversation.agent
    if (agent === null || agent === undefined) return
    if (agent.status === 'idle' && conversation.idle !== true) handleAgentStatus(conversation, 'idle')
  }

  /**
   * POST the final state to a caller supplied callback.
   * @param {Record<string, any>} conversation conversation.
   * @returns {Promise<void>} when delivery settled.
   */
  async function notifyCallback(conversation) {
    if (typeof conversation.callbackUrl !== 'string' || conversation.callbackUrl === '') return
    if (conversation.notifiedAt === conversation.updatedAt) return
    conversation.notifiedAt = conversation.updatedAt
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      timer.unref?.()
      await fetch(conversation.callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.token}` },
        body: JSON.stringify({ conversation: publicConversation(conversation) }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer))
    } catch (error) {
      log(`callback failed for ${conversation.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Find one conversation or fail the request.
   * @param {string} id conversation id.
   * @returns {Record<string, any>} conversation.
   */
  function findConversation(id) {
    const conversation = conversations.get(id)
    if (conversation === undefined) throw httpError(404, 'conversation_not_found', 'conversation not found')
    return conversation
  }

  /**
   * Acquire the live agent for a conversation, resuming its session when the
   * process that last owned it is gone.
   * @param {Record<string, any>} conversation conversation.
   * @returns {Promise<any>} agent.
   */
  async function ensureAgent(conversation) {
    const live = typeof ctx.agents?.get === 'function' ? ctx.agents.get(conversation.sessionId) : undefined
    if (live !== undefined) {
      conversation.agent = live
      return live
    }
    if (typeof ctx.agents?.resume !== 'function') {
      throw httpError(503, 'sdk_unavailable', 'DSH agent runtime is not available')
    }
    try {
      const composition = await resolveAgentPreset()
      const handle = await ctx.agents.resume({
        resumeSessionId: conversation.sessionId,
        ...(composition.presets === undefined || composition.id === '' ? {} : {
          setup: async (agentCtx) => {
            await composition.presets.mount(agentCtx, composition.id)
          },
        }),
      })
      handles.set(conversation.id, handle)
      conversation.handle = handle
      conversation.agent = handle.agent
      conversation.idle = true
      return handle.agent
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw httpError(404, 'conversation_not_found', `could not resume the session: ${message}`)
    }
  }

  /**
   * Resolve the agent-preset identity for a task.
   *
   * The Web's session controller mounts the preset in its setup callback; a
   * raw `ctx.agents.create` does not. Without this the task inherits no preset
   * tools (bash/pwsh/fs/skills) and can only see the globally registered mesh
   * tools.
   * @returns {Promise<{presets: any, id: string}>} resolved preset.
   */
  async function resolveAgentPreset() {
    const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
    if (presets === undefined || typeof presets.resolve !== 'function' || typeof presets.mount !== 'function') {
      return { presets: undefined, id: '' }
    }
    try {
      const resolved = await presets.resolve(settings.agentPreset === '' ? undefined : settings.agentPreset)
      return { presets, id: typeof resolved?.id === 'string' ? resolved.id : '' }
    } catch (error) {
      log(`could not resolve agent preset ${settings.agentPreset}: ${error instanceof Error ? error.message : String(error)}`)
      return { presets: undefined, id: '' }
    }
  }

  /**
   * Apply the configured permission preset to a freshly created agent.
   * @param {any} agent live agent.
   * @returns {void}
   */
  function applyPreset(agent) {
    const presets = typeof ctx.get === 'function' ? ctx.get('permissionPresets') : undefined
    if (presets === undefined || typeof presets.set !== 'function' || settings.preset === '') return
    try { presets.set(agent.session, settings.preset) } catch (error) {
      log(`could not apply preset ${settings.preset} to ${String(agent?.id ?? '')}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Append the task title to the session transcript.
   * @param {Record<string, any>} conversation conversation.
   * @returns {void}
   */
  function appendTitle(conversation) {
    if (conversation.title === '' || conversation.agent === null) return
    try {
      conversation.agent.session.append([['session/title', {
        title: conversation.title,
        messageSeqs: [],
        source: { kind: 'user' },
      }]])
    } catch (error) {
      log(`could not title ${conversation.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Create a conversation through the host agent registry.
   * @param {Record<string, any>} request create body.
   * @returns {Promise<Record<string, any>>} conversation.
   */
  async function createConversation(request) {
    if (typeof ctx.agents?.create !== 'function') {
      throw httpError(503, 'sdk_unavailable', 'DSH agent runtime is not available')
    }
    const id = randomUUID()
    const workspace = normalizeWorkspaceName(request.workspace)
    const cwd = workspace !== ''
      ? workspacePath(settings, workspace)
      : typeof request.cwd === 'string' && request.cwd !== '' ? path.resolve(request.cwd) : settings.workdir
    const prompt = request.prompt
    try {
      mkdirSync(cwd, { recursive: true })
    } catch { }
    const conversation = {
      id,
      sessionId: id,
      cwd,
      workspace,
      prompt: promptText(prompt),
      title: normalizeTitle(request.title) || titleFromPrompt(prompt),
      initiator: normalizeInitiator(request.initiator),
      status: prompt === undefined ? 'blank' : 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastText: '',
      error: null,
      events: [],
      clients: new Set(),
      callbackUrl: typeof request.callbackUrl === 'string' ? request.callbackUrl : '',
      notifiedAt: null,
      turns: 0,
      replySeq: 0,
      replies: [],
      turnText: '',
      idle: false,
      settledAt: null,
      waiters: new Set(),
      prompted: prompt !== undefined,
      agent: null,
      handle: null,
      failed: false,
      interrupted: false,
    }
    conversations.set(id, conversation)
    bySession.set(id, conversation)
    const composition = await resolveAgentPreset()
    let handle = null
    try {
      handle = await ctx.agents.create({
        sessionId: id,
        // Record the resolved identity in the session header as well as mounting
        // it below; the Web's resume path reads the header.
        meta: { cwd, ...(composition.id === '' ? {} : { agentPreset: composition.id }) },
        agentOptions: {
          provider: settings.provider,
          model: settings.model,
          ...(settings.reasoningEffort === undefined ? {} : { reasoningEffort: settings.reasoningEffort }),
        },
        setup: async (agentCtx, agent) => {
          if (composition.presets !== undefined && composition.id !== '') {
            await composition.presets.mount(agentCtx, composition.id)
          }
          applyPreset(agent)
        },
      })
      handles.set(id, handle)
      conversation.handle = handle
      conversation.agent = handle.agent
      appendTitle(conversation)
      if (prompt !== undefined) {
        handle.agent.followup(userMessage(contentBlocks(prompt)))
        conversation.status = 'running'
        conversation.idle = false
      }
      scheduleSave()
      return conversation
    } catch (error) {
      conversations.delete(id)
      bySession.delete(id)
      if (handle !== null) {
        handles.delete(id)
        await Promise.resolve(handle.dispose()).catch(() => {})
      }
      throw error
    }
  }

  /**
   * Send one user message to an existing conversation.
   * @param {Record<string, any>} conversation conversation.
   * @param {Record<string, any>} request message body.
   * @returns {Promise<{accepted: boolean}>} receipt.
   */
  async function sendMessage(conversation, request) {
    const blocks = contentBlocks(request.content ?? request.message ?? request.prompt)
    const agent = await ensureAgent(conversation)
    conversation.prompted = true
    conversation.status = 'running'
    conversation.idle = false
    conversation.error = null
    conversation.failed = false
    conversation.interrupted = false
    conversation.notifiedAt = null
    if (request.callbackUrl !== undefined) conversation.callbackUrl = String(request.callbackUrl)
    agent.followup(userMessage(blocks))
    conversation.updatedAt = new Date().toISOString()
    broadcast(conversation, { type: 'message.accepted', sessionId: conversation.sessionId, ok: true })
    scheduleSave()
    return { accepted: true }
  }

  /**
   * Park until the conversation changes or the budget runs out.
   * @param {Record<string, any>} conversation conversation.
   * @param {number} ms budget.
   * @returns {Promise<void>} resolved.
   */
  function nextSignal(conversation, ms) {
    if (!(conversation.waiters instanceof Set)) conversation.waiters = new Set()
    return new Promise((resolve) => {
      let timer
      const waiter = () => {
        clearTimeout(timer)
        resolve()
      }
      timer = setTimeout(() => {
        conversation.waiters.delete(waiter)
        resolve()
      }, Math.max(0, ms))
      timer.unref?.()
      conversation.waiters.add(waiter)
    })
  }

  /** Turns finished so far. */
  function turnsOf(conversation) {
    return Number.isSafeInteger(conversation.turns) ? conversation.turns : 0
  }

  /** Newest reply sequence number. */
  function seqOf(conversation) {
    return Number.isSafeInteger(conversation.replySeq) ? conversation.replySeq : 0
  }

  /**
   * Wait until the whole agent (including subagents) is idle.
   * @param {Record<string, any>} conversation conversation.
   * @param {number} timeoutMs budget.
   * @returns {Promise<Record<string, any>>} wait result.
   */
  async function waitUntilSettled(conversation, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (conversation.idle !== true) {
      const left = deadline - Date.now()
      if (left <= 0) return { timedOut: true, state: 'running', settled: false }
      await nextSignal(conversation, left)
    }
    return {
      timedOut: false,
      state: 'done',
      settled: true,
      text: conversation.lastText ?? '',
      turn: turnsOf(conversation),
      seq: seqOf(conversation),
      replies: [],
    }
  }

  /**
   * Wait for the next finished turn, reporting whether more work is queued.
   * @param {Record<string, any>} conversation conversation.
   * @param {number} timeoutMs budget.
   * @param {number} since last reply seq the caller saw.
   * @returns {Promise<Record<string, any>>} wait result.
   */
  async function waitForReply(conversation, timeoutMs, since) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const replies = repliesSince(conversation, since)
      if (replies.length > 0) {
        let settled = conversation.idle === true
        if (!settled) {
          const left = Math.min(SETTLE_MS, Math.max(0, deadline - Date.now()))
          if (left > 0) {
            await nextSignal(conversation, left)
            settled = conversation.idle === true
          }
        }
        const summary = summarizeReplies(replies)
        return {
          timedOut: false,
          state: settled ? 'done' : 'progress',
          settled,
          text: summary.text,
          turn: summary.turn ?? turnsOf(conversation),
          seq: summary.seq ?? seqOf(conversation),
          replies,
        }
      }
      if (conversation.idle === true) {
        return {
          timedOut: false,
          state: 'done',
          settled: true,
          text: '',
          turn: turnsOf(conversation),
          seq: seqOf(conversation),
          replies: [],
        }
      }
      if (conversation.interrupted || conversation.failed || conversation.error !== null) {
        return {
          timedOut: false,
          state: 'done',
          settled: true,
          text: '',
          turn: turnsOf(conversation),
          seq: seqOf(conversation),
          replies: [],
        }
      }
      const left = deadline - Date.now()
      if (left <= 0) {
        return {
          timedOut: true,
          state: 'running',
          settled: false,
          text: '',
          turn: turnsOf(conversation),
          seq: seqOf(conversation),
          replies: [],
        }
      }
      await nextSignal(conversation, left)
    }
  }

  /**
   * The `/wait` entry point.
   * @param {Record<string, any>} conversation conversation.
   * @param {number} timeoutMs budget.
   * @param {number | undefined} since reply cursor.
   * @returns {Promise<Record<string, any>>} wait result.
   */
  async function waitConversation(conversation, timeoutMs, since) {
    reconcileStatus(conversation)
    if (conversation.interrupted && conversation.error !== null) {
      return { timedOut: false, state: 'done', settled: true, text: conversation.lastText ?? '', turn: turnsOf(conversation), seq: seqOf(conversation), replies: [] }
    }
    if (!Number.isSafeInteger(since) || since < 0) return waitUntilSettled(conversation, timeoutMs)
    if (conversation.idle !== true) await ensureAgent(conversation).catch((error) => {
      conversation.interrupted = true
      conversation.error = error instanceof Error ? error.message : String(error)
      conversation.idle = true
      wake(conversation)
    })
    return waitForReply(conversation, timeoutMs, since)
  }

  /**
   * Remove finished conversations and dispose their live agents.
   * @returns {number} removed count.
   */
  async function clearFinished() {
    let removed = 0
    for (const [id, conversation] of [...conversations]) {
      if (conversation.status === 'running') continue
      conversations.delete(id)
      bySession.delete(conversation.sessionId)
      const handle = handles.get(id)
      handles.delete(id)
      if (handle !== undefined) await Promise.resolve(handle.dispose()).catch(() => {})
      removed += 1
    }
    saveState()
    return removed
  }

  /**
   * Serve one system information request.
   * @param {http.ServerResponse} response response.
   * @param {URL} url request URL.
   * @returns {Promise<void>} resolved after the response.
   */
  async function serveSystem(response, url) {
    const sampleMs = Number.parseInt(url.searchParams.get('sampleMs') ?? '200', 10)
    const system = await collectSystemInfo({ sampleMs: Number.isSafeInteger(sampleMs) ? sampleMs : 200 })
    const section = url.pathname.split('/')[3] ?? ''
    if (section === '') { json(response, 200, { ok: true, system }); return }
    const key = section === 'disk' ? 'disks' : section
    if (key === 'cpu' || key === 'memory' || key === 'disks' || key === 'network' || key === 'process') {
      json(response, 200, { ok: true, sampledAt: system.sampledAt, [key]: system[key] })
      return
    }
    fail(response, 404, 'not_found', 'Unknown system information section.')
  }

  /**
   * Route one HTTP request.
   * @param {http.IncomingMessage} request request.
   * @param {http.ServerResponse} response response.
   * @returns {Promise<void>} resolved when handled.
   */
  async function handle(request, response) {
    try {
      const url = new URL(request.url ?? '/', 'http://interop.invalid')
      if (request.method === 'GET' && url.pathname === '/healthz') {
        json(response, 200, {
          ok: true,
          service: 'dsh-interop',
          mode: 'embedded',
          engine: EMBEDDED_INTEROP_MARKER,
          sdk: 'ready',
          conversations: conversations.size,
        })
        return
      }
      if (!authorized(request)) {
        fail(response, 401, 'unauthorized', 'A bearer token is required.')
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/workspaces') {
        const listing = listWorkspaces(settings)
        json(response, 200, { ok: true, dir: listing.dir, workspaces: listing.workspaces })
        return
      }
      if (request.method === 'GET' && (url.pathname === '/v1/system' || url.pathname.startsWith('/v1/system/'))) {
        await serveSystem(response, url)
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/conversations') {
        json(response, 200, { ok: true, conversations: [...conversations.values()].map(publicConversation) })
        return
      }
      if (request.method === 'DELETE' && url.pathname === '/v1/conversations') {
        const removed = await clearFinished()
        log(`cleared ${String(removed)} conversation(s)`)
        json(response, 200, { ok: true, removed })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/conversations') {
        const body = await readJson(request)
        const conversation = await createConversation(body)
        json(response, 201, { ok: true, conversation: publicConversation(conversation) })
        return
      }
      const match = /^\/v1\/conversations\/([^/]+)(?:\/(messages|notify|wait|events|result))?$/u.exec(url.pathname)
      if (match === null) { fail(response, 404, 'not_found', 'Unknown endpoint.'); return }
      const conversation = findConversation(decodeURIComponent(match[1]))
      const suffix = match[2] ?? ''
      if (request.method === 'GET' && suffix === '') {
        reconcileStatus(conversation)
        json(response, 200, { ok: true, conversation: publicConversation(conversation) })
        return
      }
      if (request.method === 'GET' && suffix === 'result') {
        reconcileStatus(conversation)
        json(response, 200, { ok: true, conversation: publicConversation(conversation), finalText: conversation.lastText })
        return
      }
      if (request.method === 'GET' && suffix === 'events') {
        const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10)
        const once = url.searchParams.get('once') === '1'
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        response.write(`event: ready\ndata: ${JSON.stringify({ conversation: publicConversation(conversation), since })}\n\n`)
        for (const event of conversation.events) {
          if (typeof event?.seq === 'number' && event.seq < since) continue
          response.write(`event: session.event\ndata: ${JSON.stringify(event)}\n\n`)
        }
        if (once) { response.end(); return }
        conversation.clients.add(response)
        const heartbeat = setInterval(() => {
          try { response.write(': ping\n\n') } catch { }
        }, 15_000)
        heartbeat.unref?.()
        request.once('close', () => {
          clearInterval(heartbeat)
          conversation.clients.delete(response)
        })
        return
      }
      if (request.method === 'POST' && (suffix === 'messages' || suffix === 'notify')) {
        const body = await readJson(request)
        const receipt = await sendMessage(conversation, body)
        json(response, 202, { ok: true, conversation: publicConversation(conversation), receipt })
        return
      }
      if (request.method === 'POST' && suffix === 'wait') {
        const body = await readJson(request).catch(() => ({}))
        const timeoutMs = Number.isSafeInteger(body.timeoutMs) ? Math.max(1000, Math.min(body.timeoutMs, 600_000)) : 30_000
        const since = Number.isSafeInteger(body.since) ? body.since : undefined
        const result = await waitConversation(conversation, timeoutMs, since)
        json(response, 200, {
          ok: true,
          timedOut: result.timedOut === true,
          state: result.state ?? 'done',
          settled: result.settled === true,
          text: typeof result.text === 'string' ? result.text : '',
          turn: Number.isSafeInteger(result.turn) ? result.turn : turnsOf(conversation),
          seq: Number.isSafeInteger(result.seq) ? result.seq : seqOf(conversation),
          replies: Array.isArray(result.replies) ? result.replies : [],
          conversation: publicConversation(conversation),
        })
        return
      }
      fail(response, 405, 'method_not_allowed', 'Unsupported method for this endpoint.')
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500
      const code = typeof error?.code === 'string' ? error.code : 'internal_error'
      const message = error instanceof Error ? error.message : String(error)
      if (status >= 500) log(`request failed: ${message}`)
      fail(response, status, code, message)
    }
  }

  /**
   * Register the host event listeners.
   * @returns {void}
   */
  function attachListeners() {
    if (typeof ctx.on !== 'function') return
    if (settings.approve) {
      listeners.push(ctx.on('approval/request', (request, next) => {
        try {
          if (request?.agent?.id !== undefined && conversations.has(request.agent.id)) {
            return Promise.resolve('allowed-once')
          }
        } catch { }
        return next()
      }, { prepend: true }))
    }
    listeners.push(ctx.on('session/event', (session, event) => {
      if (session?.id === undefined || event === undefined) return
      const conversation = bySession.get(String(session.id))
      if (conversation !== undefined) appendEvent(conversation, event)
    }))
    listeners.push(ctx.on('agent/status', (payload) => {
      const id = payload?.agent?.id
      if (id === undefined) return
      const conversation = conversations.get(String(id))
      if (conversation !== undefined) handleAgentStatus(conversation, payload.status === 'running' ? 'running' : 'idle')
    }))
    listeners.push(ctx.on('agent/disposed', (payload) => {
      const id = payload?.agent?.id
      if (id === undefined) return
      const conversation = conversations.get(String(id))
      if (conversation === undefined) return
      if (conversation.status === 'running') {
        conversation.interrupted = true
        conversation.error = conversation.error ?? INTERRUPTED_ERROR
      }
      conversation.agent = null
      conversation.handle = null
      conversation.idle = true
      if (conversation.prompted) {
        conversation.status = conversation.interrupted ? 'interrupted' : conversation.error !== null ? 'error' : 'idle'
      }
      conversation.updatedAt = new Date().toISOString()
      wake(conversation)
      scheduleSave()
    }))
  }

  /**
   * Release every host listener and live agent.
   * @returns {Promise<void>} resolved.
   */
  async function dispose() {
    if (stopped) return
    stopped = true
    if (retryTimer !== null) clearTimeout(retryTimer)
    if (saveTimer !== null) clearTimeout(saveTimer)
    for (const off of listeners.splice(0)) {
      try { off?.() } catch { }
    }
    for (const conversation of conversations.values()) {
      if (conversation.status === 'running') {
        conversation.status = 'interrupted'
        conversation.interrupted = true
        conversation.error = conversation.error ?? INTERRUPTED_ERROR
        conversation.idle = true
        conversation.updatedAt = new Date().toISOString()
      }
    }
    saveState()
    for (const [id, handle] of [...handles]) {
      handles.delete(id)
      await Promise.resolve(handle.dispose()).catch(() => {})
    }
    await new Promise((resolve) => {
      if (server === null) { resolve(); return }
      try { server.close(() => resolve()) } catch { resolve() }
      setTimeout(resolve, 2000).unref?.()
    })
    server = null
    listening = false
  }

  /**
   * Bind the listener, retrying transient address problems.
   * @returns {Promise<{port: number}>} resolved after listening.
   */
  function listen() {
    return new Promise((resolve, reject) => {
      const current = http.createServer((request, response) => { void handle(request, response) })
      current.on('error', (error) => {
        const code = error?.code
        if (!stopped && retry && (code === 'EADDRINUSE' || code === 'EADDRNOTAVAIL' || code === 'EACCES')) {
          log(`listen on ${settings.bind}:${String(settings.port)} failed (${String(code)}); retrying in 5s`)
          try { current.close() } catch { }
          retryTimer = setTimeout(() => {
            retryTimer = null
            listen().then(resolve, reject)
          }, 5000)
          retryTimer.unref?.()
          return
        }
        reject(error)
      })
      current.listen(settings.port, settings.bind, () => {
        server = current
        listening = true
        const address = current.address()
        const port = typeof address === 'object' && address !== null ? address.port : settings.port
        log(`listening on http://${settings.bind}:${String(port)} (embedded; token source ${settings.tokenSource})`)
        resolve({ port })
      })
    })
  }

  return {
    settings,
    /** Start the listener and host listeners. */
    async start() {
      if (started) return { port: settings.port }
      started = true
      loadState()
      attachListeners()
      return listen()
    },
    /** Stop the listener, dispose agents, and persist status. */
    dispose,
    /** Public conversations, for tests and diagnostics. */
    conversations,
    /** Whether the listener is currently bound. */
    get listening() { return listening },
  }
}
