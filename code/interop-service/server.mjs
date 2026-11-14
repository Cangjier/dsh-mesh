#!/usr/bin/env node
/**
 * Independent DSH interaction HTTP service.
 *
 * It owns a child `dsh --profile sdk` runtime (stdio JSON-RPC) and exposes a
 * small, authenticated HTTP API for another machine to:
 *
 *   - create a conversation (blank or with a first prompt)
 *   - send messages / notifications
 *   - inspect conversation state and events
 *   - wait for the conversation to become idle
 *
 * It is deliberately separate from the DSH Web process and the gateway: the
 * HTTP listener, the SDK runtime and the Web UI have independent lifetimes.
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JsonRpcLineTransport } from '../../app/node_modules/@deepseek-ai/dsh-sdk-protocol/lib/index.js'
// A built package flattens `code/shared` to `shared/`, while the source tree and
// the plugin copy keep it next to `code/interop-service`. Resolve both, so the
// same file runs in every layout.
async function sharedModule(name) {
  for (const candidate of [`../shared/${name}`, `../../shared/${name}`]) {
    const url = new URL(candidate, import.meta.url)
    if (existsSync(fileURLToPath(url))) return import(url.href)
  }
  throw new Error(`missing the shared module ${name}`)
}
const { collectSystemInfo } = await sharedModule('system-info.mjs')
const { conversationRecord, normalizeInitiator, normalizeTitle, restoredConversation, titleFromPrompt } = await sharedModule('conversation-meta.mjs')
const { applySessionEvent, repliesSince, summarizeReplies } = await sharedModule('conversation-replies.mjs')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const DATA = path.join(ROOT, 'data')
const DSH_ENTRY = path.join(ROOT, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const TOKEN_FILE = path.join(DATA, 'interop-token')
const STATE_FILE = path.join(DATA, 'conversations.json')
const CONFIG_FILE = path.join(ROOT, 'config', 'interop.env')

mkdirSync(DATA, { recursive: true })

function readEnvFile(file) {
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

const fileConfig = readEnvFile(CONFIG_FILE)
function setting(name, fallback) {
  const value = process.env[name] ?? fileConfig[name]
  return value === undefined || value === '' ? fallback : value
}

const HOST = setting('DSH_INTEROP_BIND', '127.0.0.1')
const PORT = Number.parseInt(setting('DSH_INTEROP_PORT', '8765'), 10)
const DSH_HOME = setting('DSH_HOME', path.join(DATA, 'home'))
const WORKDIR = setting('DSH_WORKDIR', path.join(ROOT, 'workspace'))
const PROVIDER = setting('DSH_INTEROP_PROVIDER', 'deepseek-official')
const MODEL = setting('DSH_INTEROP_MODEL', 'deepseek-flash')
const APPROVE = setting('DSH_INTEROP_APPROVE', '0') === '1'
const REQUEST_TIMEOUT_MS = Number.parseInt(setting('DSH_INTEROP_REQUEST_TIMEOUT_MS', '180000'), 10)
/** Reopening a persisted session after a restart replays its history: be patient. */
const RESUME_TIMEOUT_MS = 120_000
const MAX_EVENTS = Number.parseInt(setting('DSH_INTEROP_MAX_EVENTS', '5000'), 10)
const MAX_BODY = 1024 * 1024
/**
 * How long a wait looks for "the conversation is now fully idle" before it
 * reports the finished turn as still in progress.
 *
 * The probe races the conversation's one shared `session/wait`, so a task that
 * really ended answers `done` within milliseconds while a task that continues
 * pays at most this much extra latency per turn. Setting it to 0 reports every
 * finished turn as progress immediately.
 */
const SETTLE_MS = Math.max(0, Number.parseInt(setting('DSH_INTEROP_SETTLE_MS', '300'), 10) || 0)
/** A shared `session/wait` older than this is considered lost and restarted. */
const SESSION_WAIT_TIMEOUT_MS = Number.parseInt(setting('DSH_INTEROP_SESSION_WAIT_TIMEOUT_MS', '3600000'), 10)

mkdirSync(WORKDIR, { recursive: true })
mkdirSync(DSH_HOME, { recursive: true })

function log(line) {
  const text = `[interop ${new Date().toISOString()}] ${line}`
  try { writeFileSync(path.join(DATA, 'interop-service.log'), `${text}\n`, { encoding: 'utf8', flag: 'a' }) } catch { }
  console.log(text)
}

function loadToken() {
  if (setting('DSH_INTEROP_USE_GATE_PASSWORD', '0') === '1') {
    const gate = readEnvFile(path.join(ROOT, 'config', 'gate.env'))
    const password = gate.DSH_GATE_PASSWORD
    if (typeof password !== 'string' || password === '') {
      throw new Error('DSH_INTEROP_USE_GATE_PASSWORD=1 but config/gate.env has no DSH_GATE_PASSWORD')
    }
    return password
  }
  const fromEnv = setting('DSH_INTEROP_TOKEN', '')
  if (fromEnv !== '') return fromEnv
  try {
    const text = readFileSync(TOKEN_FILE, 'utf8').trim()
    if (text.length >= 32) return text
  } catch { }
  const token = randomBytes(32).toString('hex')
  writeFileSync(TOKEN_FILE, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  return token
}

const TOKEN = loadToken()
const TOKEN_SOURCE = setting('DSH_INTEROP_USE_GATE_PASSWORD', '0') === '1'
  ? 'config/gate.env DSH_GATE_PASSWORD'
  : TOKEN_FILE
const TOKEN_SHA256 = createHash('sha256').update(TOKEN).digest()

function authorized(request) {
  const header = request.headers.authorization ?? ''
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : String(request.headers['x-dsh-interop-token'] ?? '')
  if (raw === '') return false
  const digest = createHash('sha256').update(raw).digest()
  return digest.length === TOKEN_SHA256.length && timingSafeEqual(digest, TOKEN_SHA256)
}

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

function fail(response, status, code, message, details) {
  json(response, status, { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } })
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY) throw Object.assign(new Error('request body too large'), { status: 413, code: 'body_too_large' })
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch {
    throw Object.assign(new Error('request body is not a JSON object'), { status: 400, code: 'invalid_json' })
  }
}

function contentBlocks(value) {
  if (typeof value === 'string') {
    if (value.trim() === '') throw Object.assign(new Error('content is empty'), { status: 400, code: 'empty_content' })
    return [{ type: 'text', text: value }]
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw Object.assign(new Error('content must be a string or a non-empty content block array'), { status: 400, code: 'invalid_content' })
  }
  const blocks = value.map((block) => {
    if (block === null || typeof block !== 'object') throw Object.assign(new Error('invalid content block'), { status: 400, code: 'invalid_content' })
    if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text }
    if (block.type === 'image' && typeof block.data === 'string' && typeof block.mediaType === 'string') {
      return { type: 'image', data: block.data, mediaType: block.mediaType, ...(typeof block.name === 'string' ? { name: block.name } : {}) }
    }
    if (block.type === 'file' && typeof block.receiptId === 'string') return { type: 'file', receiptId: block.receiptId }
    throw Object.assign(new Error('unsupported content block'), { status: 400, code: 'invalid_content' })
  })
  if (!blocks.some(block => block.type !== 'text' || block.text.trim() !== '')) {
    throw Object.assign(new Error('content is empty'), { status: 400, code: 'empty_content' })
  }
  return blocks
}

const conversations = new Map()
const bySession = new Map()
let child = null
let transport = null
let sdkReady = false
let sdkStarting = null
let restartTimer = null
let stopping = false
let restartDelayMs = 2000
/**
 * Which SDK child opened each conversation's session.
 *
 * The HTTP listener outlives the child: a restarted runtime owns no sessions at
 * all. Bumping this counter makes every restored conversation look stale, so the
 * next request can resume its persisted session instead of guessing.
 */
let generation = 0

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
    // What the mesh panel lists: what this conversation is about and who
    // started it (another member, or this machine when started by hand).
    title: conversation.title ?? '',
    initiator: conversation.initiator ?? null,
    turns: Number.isSafeInteger(conversation.turns) ? conversation.turns : 0,
    replySeq: Number.isSafeInteger(conversation.replySeq) ? conversation.replySeq : 0,
  }
}

function updateConversation(conversation, patch) {
  Object.assign(conversation, patch, { updatedAt: new Date().toISOString() })
  scheduleSave()
}

function broadcast(conversation, payload) {
  for (const client of conversation.clients) {
    try {
      client.write(`event: ${payload.type ?? 'message'}\ndata: ${JSON.stringify(payload)}\n\n`)
    } catch { }
  }
}

// The conversation map is what the mesh panel lists, so it outlives a restart:
// only the slim record is written, never events or sockets.
let saveTimer = null
let saving = false

function scheduleSave() {
  if (saveTimer !== null || stopping) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveState()
  }, 500)
  saveTimer.unref?.()
}

function saveState() {
  if (saving) return
  saving = true
  try {
    const payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      conversations: [...conversations.values()].map(conversationRecord),
    }
    const temporary = `${STATE_FILE}.tmp`
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`)
    renameSync(temporary, STATE_FILE)
  } catch (error) {
    log(`could not persist conversations: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    saving = false
  }
}

function loadState() {
  if (!existsSync(STATE_FILE)) return
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    const records = Array.isArray(parsed?.conversations) ? parsed.conversations : []
    for (const record of records) {
      if (typeof record?.id !== 'string' || conversations.has(record.id)) continue
      const conversation = {
        ...restoredConversation(record, WORKDIR),
        events: [],
        clients: new Set(),
        callbackUrl: '',
        notifiedAt: null,
        // No session exists in the new child yet; the next request resumes one.
        generation: -1,
        // Runtime-only reply bookkeeping: a restored conversation has no live
        // turns, and the first message starts a fresh one.
        replySeq: 0,
        replies: [],
        turnText: '',
        idle: false,
        settledAt: null,
        waiters: new Set(),
        pendingWait: null,
      }
      conversations.set(conversation.id, conversation)
      bySession.set(conversation.sessionId, conversation)
    }
    if (conversations.size > 0) log(`restored ${String(conversations.size)} conversation(s) from ${STATE_FILE}`)
  } catch (error) {
    log(`could not restore conversations: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function appendEvent(conversation, event) {
  conversation.events.push(event)
  if (conversation.events.length > MAX_EVENTS) conversation.events.splice(0, conversation.events.length - MAX_EVENTS)
  // Fold the turn into a reply first: a waiter must be able to see the text the
  // moment it is woken, and a text-less turn must not wake anyone.
  const reply = applySessionEvent(conversation, event)
  // A turn just started: whatever "settled" meant before no longer holds.
  if (event?.type === 'turn/start') conversation.idle = false
  broadcast(conversation, { type: 'session.event', sessionId: conversation.sessionId, event })
  if (reply !== null) wake(conversation)
}

function findConversation(id) {
  const conversation = conversations.get(id)
  if (conversation === undefined) throw Object.assign(new Error('conversation not found'), { status: 404, code: 'conversation_not_found' })
  return conversation
}

function withTimeout(promise, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  timer.unref?.()
  return { controller, promise, timer }
}

async function sdkRequest(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (transport === null || !sdkReady) throw Object.assign(new Error('SDK runtime is not ready'), { status: 503, code: 'sdk_unavailable' })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), Math.max(1000, timeoutMs))
  timer.unref?.()
  try {
    return await transport.request(method, params, controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Make sure the current SDK child owns this conversation's session.
 *
 * The listener and its child have independent lifetimes: after the child
 * restarts, restored conversation records point at sessions the new runtime has
 * never opened. Resuming brings the persisted transcript back, while a plain
 * `session/query` would either start an empty session or be refused because the
 * session id already exists on disk.
 * @param {object} conversation restored or live conversation record.
 * @returns {Promise<boolean>} whether a session is now open for it.
 */
async function ensureSessionOpen(conversation) {
  if (conversation.generation === generation) return true
  try {
    await sdkRequest('session/resume', { sessionId: conversation.sessionId }, RESUME_TIMEOUT_MS)
    conversation.generation = generation
    // The turn that was cut short cannot come back, but the conversation can.
    // An `unavailable` status is kept on purpose: it is what tells the waiting
    // member that this turn was interrupted, and `send` clears it.
    if (conversation.status === 'interrupted') {
      conversation.idle = true
      updateConversation(conversation, { status: 'idle', error: null })
    }
    log(`resumed session ${conversation.sessionId}`)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/already open/i.test(message)) {
      conversation.generation = generation
      return true
    }
    // Nothing was ever persisted (a blank conversation): the first message
    // creates the session, exactly as before this restart.
    log(`could not resume ${conversation.id}: ${message}`)
    return false
  }
}

function handleServerRequest(method, params) {
  if (method === 'approval/request') {
    return { outcome: APPROVE ? 'allowed-once' : 'rejected' }
  }
  if (method === 'user-question/ask') {
    return { cancelled: true }
  }
  throw new Error(`unsupported server request: ${method}`)
}

function handleNotification(method, params) {
  if (method === 'session.event') {
    const conversation = bySession.get(String(params?.sessionId ?? ''))
    if (conversation !== undefined && params?.event !== undefined) appendEvent(conversation, params.event)
    return
  }
  if (method === 'session.status') {
    const conversation = bySession.get(String(params?.sessionId ?? ''))
    if (conversation === undefined) return
    const status = params?.status === 'running' ? 'running' : 'idle'
    // A new turn makes the conversation active again; only the shared
    // `session/wait` may declare it finished (it also accounts for subagents).
    if (status === 'running') {
      conversation.idle = false
      conversation.settledAt = null
    }
    updateConversation(conversation, { status })
    broadcast(conversation, { type: 'session.status', sessionId: conversation.sessionId, status })
    if (status === 'idle') notifyCallback(conversation)
    return
  }
  if (method === 'session.query.completed') {
    const conversation = bySession.get(String(params?.sessionId ?? ''))
    if (conversation === undefined) return
    if (typeof params?.finalResponse === 'string' && params.finalResponse !== '') conversation.lastText = params.finalResponse
    updateConversation(conversation, { status: 'idle' })
    broadcast(conversation, { type: 'session.query.completed', ...params })
    notifyCallback(conversation)
    return
  }
}

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
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ conversation: publicConversation(conversation) }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer))
  } catch (error) {
    log(`callback failed for ${conversation.id}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function startChild() {
  if (stopping) return
  generation += 1
  if (!existsSync(DSH_ENTRY)) {
    log(`missing ${DSH_ENTRY}`)
    scheduleRestart()
    return
  }
  log(`spawning dsh --profile sdk (home ${DSH_HOME}, cwd ${WORKDIR})`)
  child = spawn(process.execPath, [DSH_ENTRY, '--profile', 'sdk'], {
    cwd: WORKDIR,
    env: {
      ...process.env,
      DSH_HOME,
      DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME ?? path.join(DSH_HOME, 'agents'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.on('data', chunk => {
    const text = String(chunk).trim()
    if (text !== '') log(`sdk stderr: ${text.slice(-2000)}`)
  })
  transport = new JsonRpcLineTransport(child.stdout, child.stdin)
  transport.onRequest(handleServerRequest)
  transport.onNotification(handleNotification)
  transport.start()
  sdkStarting = (async () => {
    await transport.request('initialize', {
      cwd: WORKDIR,
      provider: PROVIDER,
      model: MODEL,
      approvalRequests: true,
      capabilities: { userQuestions: false },
    })
    sdkReady = true
    restartDelayMs = 2000
    log(`SDK runtime ready (${PROVIDER}/${MODEL})`)
  })().catch((error) => {
    sdkReady = false
    log(`SDK initialization failed: ${error instanceof Error ? error.message : String(error)}`)
    scheduleRestart()
  })
  child.once('error', error => {
    log(`SDK spawn failed: ${error.message}`)
    scheduleRestart()
  })
  child.once('exit', (code, signal) => {
    sdkReady = false
    transport?.close()
    transport = null
    child = null
    log(`SDK exited (${signal ?? String(code)})`)
    for (const conversation of conversations.values()) {
      conversation.pendingWait = null
      if (conversation.status === 'running') updateConversation(conversation, { status: 'unavailable', error: 'SDK runtime exited' })
      // A waiter parked on this conversation must not sit until its timeout.
      wake(conversation)
    }
    scheduleRestart()
  })
}

function scheduleRestart() {
  if (stopping || restartTimer !== null) return
  log(`restarting SDK runtime in ${String(restartDelayMs)}ms`)
  restartTimer = setTimeout(() => {
    restartTimer = null
    restartDelayMs = Math.min(restartDelayMs * 2, 30_000)
    startChild()
  }, restartDelayMs)
}

async function createConversation(request) {
  const id = randomUUID()
  const sessionId = id
  const cwd = typeof request.cwd === 'string' && request.cwd !== '' ? path.resolve(request.cwd) : WORKDIR
  const conversation = {
    id,
    sessionId,
    cwd,
    title: normalizeTitle(request.title) || titleFromPrompt(request.prompt),
    initiator: normalizeInitiator(request.initiator),
    status: 'blank',
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
    pendingWait: null,
  }
  conversations.set(id, conversation)
  bySession.set(sessionId, conversation)
  scheduleSave()
  try {
    await sdkRequest('session/working-directory/set', { sessionId, path: cwd })
    conversation.generation = generation
    if (request.prompt !== undefined) {
      const blocks = contentBlocks(request.prompt)
      const result = await sdkRequest('session/query', { sessionId, contentBlocks: blocks })
      updateConversation(conversation, { status: 'running' })
      conversation.idle = false
      conversation.settledAt = null
      conversation.lastReceipt = result
    }
    return conversation
  } catch (error) {
    conversations.delete(id)
    bySession.delete(sessionId)
    throw error
  }
}

async function sendMessage(conversation, request) {
  const blocks = contentBlocks(request.content ?? request.message ?? request.prompt)
  // A conversation that survived a restart keeps its transcript only if its
  // persisted session is resumed first.
  await ensureSessionOpen(conversation)
  const result = await sdkRequest('session/query', { sessionId: conversation.sessionId, contentBlocks: blocks })
  updateConversation(conversation, { status: 'running', error: null })
  conversation.idle = false
  conversation.settledAt = null
  conversation.notifiedAt = null
  if (request.callbackUrl !== undefined) conversation.callbackUrl = String(request.callbackUrl)
  broadcast(conversation, { type: 'message.accepted', sessionId: conversation.sessionId, result })
  return result
}

/**
 * Wake every request parked on this conversation.
 *
 * Waiters are plain resolvers: the loop in {@link waitForReply} re-reads the
 * conversation after each wake, so a wake never has to carry the news itself.
 * @param {object} conversation runtime conversation record.
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
 * Park until someone wakes us or the budget runs out.
 * @param {object} conversation runtime conversation record.
 * @param {number} ms maximum wait.
 * @returns {Promise<void>} resolves on a wake or on the deadline.
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

/**
 * Race a promise against a deadline without cancelling it.
 * @param {Promise<any>} promise work to race.
 * @param {number} ms budget.
 * @returns {Promise<{timedOut: boolean, value?: any}>} outcome.
 */
function raceDeadline(promise, ms) {
  return new Promise((resolve) => {
    let settled = false
    let timer
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    timer = setTimeout(() => finish({ timedOut: true }), Math.max(0, ms))
    timer.unref?.()
    promise.then(
      value => finish({ timedOut: false, value }),
      error => finish({ timedOut: false, value: { ok: false, error } }),
    )
  })
}

/**
 * The conversation's single in-flight SDK wait.
 *
 * `session/wait` already answers the only question a waiter really has — "is the
 * root agent idle and are all of its subagents finished?" — so the service keeps
 * exactly one of them running per conversation and races it instead of issuing
 * new ones. A probe that loses the race does not cancel it: the answer stays
 * useful for the next waiter (that is how a parent turn that ended while its
 * subagents were still running turns into a `done` later).
 * @param {object} conversation runtime conversation record.
 * @returns {Promise<{ok: boolean, error?: Error}>} settled outcome.
 */
function sessionWait(conversation) {
  if (conversation.idle === true) return Promise.resolve({ ok: true })
  if (conversation.pendingWait !== null && conversation.pendingWait !== undefined) {
    return conversation.pendingWait.promise
  }
  if (transport === null || !sdkReady) {
    return Promise.resolve({ ok: false, error: Object.assign(new Error('SDK runtime is not ready'), { status: 503, code: 'sdk_unavailable' }) })
  }
  const controller = new AbortController()
  const entry = { controller, promise: null }
  const timer = setTimeout(() => controller.abort(new Error('session wait timed out')), SESSION_WAIT_TIMEOUT_MS)
  timer.unref?.()
  const settle = (value) => {
    clearTimeout(timer)
    if (conversation.pendingWait === entry) conversation.pendingWait = null
    return value
  }
  entry.promise = transport.request('session/wait', { sessionId: conversation.sessionId }, controller.signal).then(
    () => {
      const value = settle({ ok: true })
      markSettled(conversation)
      return value
    },
    error => settle({ ok: false, error }),
  )
  conversation.pendingWait = entry
  return entry.promise
}

/**
 * Record that the conversation reached full idle.
 * @param {object} conversation runtime conversation record.
 * @returns {void}
 */
function markSettled(conversation) {
  conversation.idle = true
  conversation.settledAt = new Date().toISOString()
  updateConversation(conversation, { status: 'idle' })
  broadcast(conversation, { type: 'session.settled', sessionId: conversation.sessionId })
  notifyCallback(conversation)
  wake(conversation)
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
 * Old wait: block until root agent and all subagents are finished.
 * @param {object} conversation runtime conversation record.
 * @param {number} timeoutMs budget.
 * @returns {Promise<object>} wait result.
 */
async function waitUntilSettled(conversation, timeoutMs) {
  await ensureSessionOpen(conversation)
  const outcome = await raceDeadline(sessionWait(conversation), timeoutMs)
  if (outcome.timedOut === true) return { timedOut: true, state: 'running', settled: false }
  if (outcome.value?.ok !== true) throw outcome.value?.error ?? new Error('session wait failed')
  updateConversation(conversation, { status: 'idle' })
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
 * Whether the conversation looks finished right now.
 *
 * "Finished" is the shared `session/wait` resolving: root idle and every
 * subagent settled. A finished turn that is followed by another turn keeps that
 * wait pending, so this returns false and the caller reports progress.
 * @param {object} conversation runtime conversation record.
 * @param {number} budgetMs how long the probe may take.
 * @returns {Promise<boolean>} true when the task really ended.
 */
async function settledWithin(conversation, budgetMs) {
  if (conversation.idle === true) return true
  const outcome = await raceDeadline(sessionWait(conversation), budgetMs)
  if (outcome.timedOut === true) return false
  return outcome.value?.ok === true
}

/**
 * New wait: return as soon as a turn produced text, and say whether the
 * conversation will continue.
 *
 * The reply is read from the same event stream the panel sees, so a finished
 * turn wakes the caller immediately. Before answering `progress`, the service
 * gives the shared `session/wait` a short chance to resolve, which folds "this
 * was also the last turn" into the same response instead of making the caller
 * wait a second time.
 * @param {object} conversation runtime conversation record.
 * @param {number} timeoutMs budget for this call.
 * @param {number} since last reply seq the caller already received.
 * @returns {Promise<object>} wait result with `state` of `progress`, `done`, or `running`.
 */
async function waitForReply(conversation, timeoutMs, since) {
  const deadline = Date.now() + timeoutMs
  // Keep one wait running from the start: it is how "the whole task ended"
  // reaches this loop even when the last turn produced no new text.
  if (conversation.idle !== true) void sessionWait(conversation)
  for (;;) {
    const replies = repliesSince(conversation, since)
    if (replies.length > 0) {
      const settled = conversation.idle === true
        ? true
        : await settledWithin(conversation, Math.min(SETTLE_MS, Math.max(0, deadline - Date.now())))
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
      // The last reply was already delivered as progress; this call only has to
      // report that the whole task is over.
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
    if (conversation.status === 'unavailable') {
      // The turn died with the runtime. Report it as a terminal result; the
      // caller reads `conversation.status` and fails the task with that reason.
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

async function waitConversation(conversation, timeoutMs, since) {
  if (conversation.status === 'interrupted' && conversation.error !== null) {
    // The restart ended this turn before it could finish; there is no live
    // session to wait for, and the caller must hear about it right away.
    return { timedOut: false, state: 'done', settled: true }
  }
  // A caller that sends no cursor gets the old, all-or-nothing behaviour.
  if (!Number.isSafeInteger(since) || since < 0) return waitUntilSettled(conversation, timeoutMs)
  if (conversation.idle !== true) await ensureSessionOpen(conversation)
  return waitForReply(conversation, timeoutMs, since)
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://interop.invalid')
    if (request.method === 'GET' && url.pathname === '/healthz') {
      json(response, 200, {
        ok: true,
        service: 'dsh-interop',
        sdk: sdkReady ? 'ready' : 'starting',
        conversations: conversations.size,
      })
      return
    }
    if (!authorized(request)) {
      fail(response, 401, 'unauthorized', 'A bearer token is required.')
      return
    }
    if (request.method === 'GET' && (url.pathname === '/v1/system' || url.pathname.startsWith('/v1/system/'))) {
      const sampleMs = Number.parseInt(url.searchParams.get('sampleMs') ?? '200', 10)
      const system = await collectSystemInfo({ sampleMs: Number.isSafeInteger(sampleMs) ? sampleMs : 200 })
      const section = url.pathname.split('/')[3] ?? ''
      if (section === '') {
        json(response, 200, { ok: true, system })
        return
      }
      const key = section === 'disk' ? 'disks' : section
      if (key === 'cpu' || key === 'memory' || key === 'disks' || key === 'network' || key === 'process') {
        json(response, 200, { ok: true, sampledAt: system.sampledAt, [key]: system[key] })
        return
      }
      fail(response, 404, 'not_found', 'Unknown system information section.')
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/conversations') {
      json(response, 200, { ok: true, conversations: [...conversations.values()].map(publicConversation) })
      return
    }
    if (request.method === 'DELETE' && url.pathname === '/v1/conversations') {
      // Drop the finished ones; a running conversation is still owned by the
      // SDK session and would come back on its next event.
      let removed = 0
      for (const [id, conversation] of conversations) {
        if (conversation.status === 'running') continue
        conversations.delete(id)
        if (conversation.sessionId) bySession.delete(conversation.sessionId)
        removed += 1
      }
      saveState()
      log(`cleared ${String(removed)} conversation(s)`)
      json(response, 200, { ok: true, removed })
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/conversations') {
      if (!sdkReady) { fail(response, 503, 'sdk_unavailable', 'The SDK runtime is still starting.'); return }
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
      json(response, 200, { ok: true, conversation: publicConversation(conversation) })
      return
    }
    if (request.method === 'GET' && suffix === 'result') {
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
      const result = await sendMessage(conversation, body)
      json(response, 202, { ok: true, conversation: publicConversation(conversation), receipt: result })
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
    fail(response, status, typeof error?.code === 'string' ? error.code : 'internal_error', error instanceof Error ? error.message : String(error))
  }
})

loadState()
// A member runs exactly one interop service. If the port is already taken the
// process must die loudly: staying alive would let a stale instance keep
// serving an old release while the new one looks healthy.
server.on('error', error => {
  log(`listener failed on http://${HOST}:${String(PORT)}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${String(PORT)}; token source ${TOKEN_SOURCE}`)
  startChild()
})

async function shutdown(signal) {
  if (stopping) return
  stopping = true
  log(`${signal}; stopping`)
  server.close()
  if (restartTimer !== null) clearTimeout(restartTimer)
  saveState()
  try { await transport?.request('shutdown', {}) } catch { }
  transport?.close()
  if (child !== null && !child.killed) child.kill('SIGTERM')
  setTimeout(() => process.exit(0), 1000).unref?.()
}

process.once('SIGTERM', () => { void shutdown('SIGTERM') })
process.once('SIGINT', () => { void shutdown('SIGINT') })
