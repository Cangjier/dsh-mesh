#!/usr/bin/env node
/**
 * dsh-web-gate — the public front door of the packaged DeepSeek Harness Web GUI.
 *
 * It owns the listener the user reaches (all interfaces, port 80 by default),
 * asks for the deployment password on the first visit, and forwards everything
 * after that to a private `dsh web` listener on 127.0.0.1.
 *
 * Two things make it work with DSH unchanged:
 *
 * - `dsh web` refuses a wildcard bind, so it listens on loopback only and this
 *   process is the only door. Every local address the server has is handed to
 *   `dsh web` as `--trusted-host`, because DSH's /api fence accepts a request
 *   only when its `Host` header names loopback, the listener, or a declared
 *   authority. The browser-facing `Host` is forwarded unchanged: rewriting it
 *   would break the fence's Origin comparison.
 * - `dsh web` prints one launch URL carrying a per-process token. The gate
 *   reads that line from the child's output, and after a successful login it
 *   sends the browser through `/?token=...` so DSH mints its own session
 *   cookie. A browser that holds the gate cookie but not the DSH cookie is
 *   sent through the same exchange again, which is what makes access survive
 *   a DSH restart.
 *
 * The gate keeps no session state but its own signed cookie: the password is
 * the only credential it owns, and DSH's token is handed to every admitted
 * browser exactly as if the operator had pasted the printed URL.
 */

import { spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loginPage, page, accountLoginPage, PAGE_CSP } from './pages.mjs'
import { AccountLogin } from './account-login.mjs'
import { InteractiveBrowser } from './windows-browser.mjs'
import { CLUSTER_PREFIX, MemberService } from './members.mjs'
import { deriveClusterSecret } from '../shared/cluster.mjs'
import { TARGET_COOKIE } from '../shared/wireguard.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')
const PACKAGE_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** Read one env value, falling back to the given default. */
function env(name, fallback) {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

/** Read one positive integer env value. */
function envInt(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

/**
 * First installed Chrome/Chromium.
 *
 * The Google rpm installed with `--noscripts` on a server image does not create
 * `/usr/bin/google-chrome`, so the real binary location is probed rather than
 * assumed; `DSH_GATE_CHROME` overrides the probe.
 * @returns absolute path to a browser, or the conventional path when none exists.
 */
function resolveChrome() {
  const configured = process.env.DSH_GATE_CHROME
  if (configured !== undefined && configured !== '') return configured
  const candidates = []
  if (process.platform === 'win32') {
    for (const root of [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
    ]) {
      if (root === undefined || root === '') continue
      candidates.push(
        path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(root, 'Chromium', 'Application', 'chrome.exe'),
      )
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/opt/google/chrome/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/usr/lib/chromium/chromium',
    )
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0] ?? 'google-chrome'
}

/**
 * Heap ceiling for the `dsh web` child.
 *
 * A V8 default heap on a small machine can grow past what the box actually
 * has, and the Linux OOM killer then takes down the whole server instead of
 * one session. Below 3.5 GB the harness is capped at 1 GB, which is enough for
 * the Web plane plus a couple of agent turns; a bigger machine keeps Node's
 * own default. `DSH_WEB_HEAP_MB` overrides both, and 0 disables the ceiling.
 * @returns megabytes to pass as `--max-old-space-size`, or 0 for no ceiling.
 */
function resolveHeapMb() {
  const raw = process.env.DSH_WEB_HEAP_MB
  if (raw !== undefined && raw !== '') {
    const value = Number.parseInt(raw, 10)
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`DSH_WEB_HEAP_MB must be a non-negative integer, got ${JSON.stringify(raw)}`)
    }
    return value
  }
  const totalMb = Math.round(os.totalmem() / (1024 * 1024))
  return totalMb > 0 && totalMb < 3584 ? 1024 : 0
}

const CONFIG = {
  /** Port the public listener binds. 80 by default, as the deployment requires. */
  port: envInt('DSH_GATE_PORT', 80),
  /** Bind address: `::` accepts IPv4 and IPv6, `0.0.0.0` only IPv4. */
  bind: env('DSH_GATE_BIND', '::'),
  /** The deployment password. Every admitted browser proves it once. */
  password: env('DSH_GATE_PASSWORD', 'ChangeMe-Please-2026'),
  /** Signed gate-cookie lifetime in days. */
  cookieDays: envInt('DSH_GATE_COOKIE_DAYS', 30),
  /** Where the gate keeps its signing secret, logs, and the DSH home. */
  dataDir: path.resolve(env('DSH_GATE_DATA_DIR', path.join(PACKAGE_ROOT, 'data'))),
  /** Application directory holding node_modules/@deepseek-ai/dsh. */
  appDir: path.resolve(env('DSH_APP_DIR', path.join(PACKAGE_ROOT, 'app'))),
  /** Workspace root the agent starts in; the browser can pick another one. */
  workdir: path.resolve(env('DSH_WORKDIR', os.homedir())),
  /** Loopback port for the private DSH listener; 0 asks the OS for a free one. */
  upstreamPort: envInt('DSH_WEB_PORT', 0),
  /** Extra authorities DSH should trust, for DNS names that reach this host. */
  extraHosts: env('DSH_TRUSTED_HOSTS', '')
    .split(',')
    .map(value => value.trim())
    .filter(value => value !== ''),
  /** Skip spawning DSH and use an already running listener instead. */
  noSpawn: env('DSH_GATE_NO_SPAWN', '0') === '1',
  /** Launch URL (with token) when DSH runs outside this process. */
  externalTokenUrl: env('DSH_WEB_TOKEN_URL', ''),
  /** JSON handoff file written by the independent DSH service. */
  externalTokenFile: env('DSH_WEB_TOKEN_FILE', ''),
  /** Loader overlay that pins the in-browser directory picker. */
  patchFile: env('DSH_GATE_PATCH', path.join(PACKAGE_ROOT, 'config', 'browse-picker.patch.yml')),
  /** Log every request line. */
  accessLog: env('DSH_GATE_ACCESS_LOG', '0') === '1',
  /**
   * Heap ceiling for the `dsh web` child in MB. Empty means "decide from the
   * machine's memory"; 0 disables the ceiling.
   */
  heapMb: resolveHeapMb(),
  /**
   * Optional HTTPS listener for an origin that terminates TLS itself (a
   * Cloudflare Origin CA certificate, for example). Both files or neither;
   * the plain HTTP listener stays up so a proxy that still speaks HTTP keeps
   * working while the TLS listener is switched on.
   */
  tls: {
    certFile: env('DSH_GATE_TLS_CERT', ''),
    keyFile: env('DSH_GATE_TLS_KEY', ''),
    port: envInt('DSH_GATE_TLS_PORT', 443),
  },
  /** Browser used by the local account sign-in helper. */
  chromeBinary: resolveChrome(),
  /** Loopback debugging port of a browser started in the interactive session. */
  chromePort: envInt('DSH_GATE_CHROME_PORT', 9222),
  /** Port peers use to reach this gate; defaults to the public listener port. */
  memberPort: envInt('DSH_GATE_MEMBER_PORT', envInt('DSH_GATE_PORT', 80)),
  /** Extra ports probed on every peer (for custom member ports). */
  memberPorts: env('DSH_GATE_MEMBER_PORTS', '')
    .split(',')
    .map(value => Number.parseInt(value.trim(), 10))
    .filter(value => Number.isSafeInteger(value) && value > 0 && value <= 65_535),
  /** Per-peer probe timeout while discovering members. */
  discoveryTimeoutMs: envInt('DSH_GATE_DISCOVERY_TIMEOUT_MS', 800),
  /** Discovery cache lifetime. */
  discoveryCacheMs: envInt('DSH_GATE_DISCOVERY_CACHE_MS', 10_000),
  /** Expose /__gate/member to non-private sources. Off by default. */
  memberPublic: env('DSH_GATE_MEMBER_PUBLIC', '0') === '1',
  /** Extra exact source addresses allowed to call /__gate/cluster. */
  clusterAllow: env('DSH_GATE_CLUSTER_ALLOW', '')
    .split(',')
    .map(value => value.trim())
    .filter(value => value !== ''),
}
/** Peer requests are signed with a secret derived from the gateway password. */
CONFIG.clusterKey = deriveClusterSecret(CONFIG.password)

/**
 * Send plain-HTTP browser traffic to the TLS listener. On by default whenever
 * TLS material is configured; `DSH_GATE_REDIRECT_HTTPS=0` keeps HTTP usable
 * and `=1` forces the redirect even without a certificate (tests, proxies).
 */
{
  const explicit = env('DSH_GATE_REDIRECT_HTTPS', '')
  CONFIG.redirectHttps = explicit === '1'
    ? true
    : explicit === '0'
      ? false
      : CONFIG.tls.certFile !== '' && CONFIG.tls.keyFile !== ''
}


const COOKIE_NAME = 'dsh_gate'
const PID_FILE = path.join(CONFIG.dataDir, 'gate.pid')
const TOKEN_LINE = /dsh web: (https?:\/\/\S+)/u
const STARTUP_TIMEOUT_MS = 180_000

/** Everything the gate learns from one `dsh web` process. */
const upstream = {
  /** Real port of the private listener, once known. */
  port: CONFIG.upstreamPort,
  /** The launch URL including the process token. */
  launchUrl: undefined,
  /** The token alone, for building `/?token=` redirects. */
  token: undefined,
  /** The supervised child, when the gate spawns DSH itself. */
  child: undefined,
  /** Set once the startup line has been printed. */
  ready: false,
}

let shuttingDown = false
let restartDelayMs = 2_000

const startedAt = Date.now()

// ─── gate cookie ───────────────────────────────────────────────────────────

/** Read or create the HMAC secret that signs every gate cookie. */
async function loadSecret() {
  const file = path.join(CONFIG.dataDir, 'secret')
  mkdirSync(CONFIG.dataDir, { recursive: true, mode: 0o700 })
  if (existsSync(file)) {
    const text = (await readFile(file, 'utf8')).trim()
    if (text.length >= 32) return Buffer.from(text, 'hex')
  }
  const secret = randomBytes(32)
  await writeFile(file, secret.toString('hex'), { mode: 0o600 })
  return secret
}

const secret = await loadSecret()

/** base64url without padding, the only alphabet used in cookie values. */
function b64url(buffer) {
  return Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** Decode base64url text, or undefined when it is not canonical. */
function unb64url(text) {
  if (!/^[A-Za-z0-9_-]*$/u.test(text) || text.length % 4 === 1) return undefined
  const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4)
  return Buffer.from(padded, 'base64')
}

/**
 * Issue a signed gate cookie value.
 * @param now - issue time in milliseconds.
 * @returns the cookie value `v1.<payload>.<signature>`.
 */
function mintCookie(now) {
  const payload = { v: 1, iat: now, exp: now + CONFIG.cookieDays * 86_400_000 }
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signature = b64url(createHmac('sha256', secret).update(body).digest())
  return `v1.${body}.${signature}`
}

/**
 * Verify a gate cookie value.
 * @param value - the raw cookie value.
 * @param now - current time in milliseconds.
 * @returns true only for an unexpired value signed by this deployment.
 */
function verifyCookie(value, now) {
  const parts = value.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return false
  const [, body, signature] = parts
  const bodyBytes = unb64url(body)
  const signatureBytes = unb64url(signature)
  if (bodyBytes === undefined || signatureBytes === undefined) return false
  const expected = createHmac('sha256', secret).update(body).digest()
  if (signatureBytes.length !== expected.length || !timingSafeEqual(signatureBytes, expected)) return false
  try {
    const payload = JSON.parse(bodyBytes.toString('utf8'))
    return typeof payload === 'object' && payload !== null && payload.v === 1
      && Number.isSafeInteger(payload.exp) && payload.exp > now && payload.exp - payload.iat <= CONFIG.cookieDays * 86_400_000
  } catch {
    return false
  }
}

/** Parse the Cookie header into the one name the gate reads. */
function cookieFrom(req, name) {
  const raw = req.headers.cookie
  if (typeof raw !== 'string') return undefined
  for (const segment of raw.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim()
  }
  return undefined
}

/** Whether the request carries a valid gate cookie. */
function isAdmitted(req) {
  if (req.__dshCluster === true) return true
  const value = cookieFrom(req, COOKIE_NAME)
  return value !== undefined && verifyCookie(value, Date.now())
}

/**
 * The cookie name DSH itself mints for one request authority, mirroring
 * `client-connection`'s spelling (`dsh-auth-<base64url(sha256(authority))>`),
 * so the gate can tell whether this browser already holds a DSH session.
 */
function dshCookieName(hostHeader) {
  if (typeof hostHeader !== 'string') return undefined
  let authority
  try {
    authority = new URL(`http://${hostHeader}`).host
  } catch {
    return undefined
  }
  return `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`
}

// ─── login throttling ──────────────────────────────────────────────────────

const attempts = new Map()
const MAX_FAILURES = 6
const FAILURE_WINDOW_MS = 10 * 60_000
const LOCKOUT_MS = 60_000

/** Record one failure and answer whether the caller is now locked out. */
function registerFailure(ip, now) {
  const record = attempts.get(ip) ?? { failures: [], lockedUntil: 0 }
  record.failures = record.failures.filter(at => now - at < FAILURE_WINDOW_MS)
  record.failures.push(now)
  if (record.failures.length >= MAX_FAILURES) {
    record.lockedUntil = now + LOCKOUT_MS
    record.failures = []
  }
  attempts.set(ip, record)
  return record.lockedUntil > now
}

/** Seconds this caller must wait before another attempt, or 0. */
function lockoutSeconds(ip, now) {
  const record = attempts.get(ip)
  if (record === undefined || record.lockedUntil <= now) return 0
  return Math.ceil((record.lockedUntil - now) / 1000)
}

// ─── password check ────────────────────────────────────────────────────────

const passwordDigest = createHash('sha256').update(CONFIG.password, 'utf8').digest()

/** Constant-time password comparison over fixed-length digests. */
function passwordMatches(candidate) {
  const digest = createHash('sha256').update(candidate, 'utf8').digest()
  return timingSafeEqual(digest, passwordDigest)
}

// ─── `dsh web` supervision ─────────────────────────────────────────────────

const CHILD_PID_FILE = path.join(CONFIG.dataDir, 'dsh-web.pid')

/**
 * Stop a `dsh web` left behind by a gate that was killed rather than shut
 * down. Only a process whose Linux command line names this installation's CLI
 * is signalled, so a recycled pid is never a victim.
 */
function reapOrphan() {
  if (!existsSync(CHILD_PID_FILE)) return
  const raw = readFileSync(CHILD_PID_FILE, 'utf8').trim()
  const pid = Number.parseInt(raw, 10)
  rmSync(CHILD_PID_FILE, { force: true })
  if (!Number.isSafeInteger(pid) || pid <= 0) return
  let commandLine
  try {
    commandLine = readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').replaceAll('\0', ' ')
  } catch {
    return
  }
  if (!commandLine.includes(dshEntry())) return
  try {
    process.kill(pid, 'SIGTERM')
    log(`stopped orphaned dsh web (pid ${String(pid)}) from a previous run`)
  } catch (error) {
    log(`could not stop orphaned dsh web (pid ${String(pid)}): ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Authorities the browser may use: every local address, plus configured names. */
function trustedAuthorities() {
  const authorities = new Set(['localhost', '127.0.0.1', '[::1]'])
  const hostname = os.hostname().toLowerCase()
  if (hostname !== '') authorities.add(hostname)
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal) continue
      // A zone id selects an interface and is not address text; DSH rejects it.
      const bare = address.address.split('%')[0]
      if (address.family === 'IPv4') authorities.add(bare)
      else if (address.family === 'IPv6' && !bare.toLowerCase().startsWith('fe80')) authorities.add(`[${bare}]`)
    }
  }
  for (const extra of CONFIG.extraHosts) authorities.add(extra.toLowerCase())
  return [...authorities]
}

/** Absolute path of the `dsh` CLI entry inside the installed application. */
function dshEntry() {
  return path.join(CONFIG.appDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/** One line, prefixed, into stdout and the gate log. */
function log(line) {
  const stamp = new Date().toISOString()
  process.stdout.write(`[gate ${stamp}] ${line}\n`)
}

/** Feed one chunk of child output to the startup-line parser. */
function scanForLaunchUrl(text) {
  const match = TOKEN_LINE.exec(text)
  if (match?.[1] === undefined || upstream.ready) return
  const url = new URL(match[1])
  upstream.launchUrl = match[1]
  upstream.token = url.searchParams.get('token') ?? undefined
  upstream.port = Number.parseInt(url.port === '' ? '80' : url.port, 10)
  upstream.ready = true
  restartDelayMs = 2_000
  log(`dsh web ready on 127.0.0.1:${String(upstream.port)}`)
}

/** Follow the token handoff file written by the independent DSH service. */
function startExternalTokenFile() {
  const file = CONFIG.externalTokenFile
  let lastKey = ''
  let warned = false
  const read = () => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const port = Number.parseInt(String(parsed.port ?? ''), 10)
      const token = typeof parsed.token === 'string' ? parsed.token : ''
      if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new Error('invalid port')
      const key = `${String(port)}:${token}`
      if (key === lastKey) return
      upstream.port = port
      upstream.token = token === '' ? undefined : token
      upstream.launchUrl = typeof parsed.launchUrl === 'string' && parsed.launchUrl !== ''
        ? parsed.launchUrl
        : `http://127.0.0.1:${String(port)}/${token === '' ? '' : `?token=${encodeURIComponent(token)}`}`
      upstream.ready = true
      lastKey = key
      warned = false
      log(`external dsh web ready on 127.0.0.1:${String(port)}`)
    } catch (error) {
      if (upstream.ready || !warned) {
        log(`external dsh token file not ready (${error instanceof Error ? error.message : String(error)})`)
      }
      warned = true
      upstream.ready = false
      lastKey = ''
    }
  }
  read()
  try {
    const directory = path.dirname(file)
    const base = path.basename(file)
    const watcher = watch(directory, { persistent: false }, (_event, changed) => {
      if (changed === null || String(changed) === base) read()
    })
    watcher.unref?.()
  } catch (error) {
    log(`cannot watch external dsh token file: ${error instanceof Error ? error.message : String(error)}`)
  }
  log(`watching external dsh token file ${file}`)
}

/** Spawn one supervised `dsh web` child and wire its output into the gate. */
function startUpstream() {
  if (CONFIG.externalTokenFile !== '') {
    startExternalTokenFile()
    return
  }
  if (CONFIG.noSpawn) {
    if (CONFIG.externalTokenUrl === '') {
      log('DSH_GATE_NO_SPAWN=1 without DSH_WEB_TOKEN_URL: every page will answer 503')
      return
    }
    const url = new URL(CONFIG.externalTokenUrl)
    upstream.launchUrl = CONFIG.externalTokenUrl
    upstream.token = url.searchParams.get('token') ?? undefined
    upstream.port = Number.parseInt(url.port === '' ? '80' : url.port, 10)
    upstream.ready = true
    log(`using external dsh web at ${url.origin}`)
    return
  }
  const entry = dshEntry()
  if (!existsSync(entry)) {
    log(`missing ${entry}: run install.sh first`)
    process.exitCode = 1
    return
  }
  reapOrphan()
  // Launcher flags come before the profile token: `--patch` belongs to the
  // launcher and is rejected once `web` has already been expanded into
  // `--profile web` with the app owning the rest of the line.
  const args = [entry]
  if (existsSync(CONFIG.patchFile)) args.push('--patch', CONFIG.patchFile)
  args.push('--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', String(CONFIG.upstreamPort))
  for (const authority of trustedAuthorities()) args.push('--trusted-host', authority)
  log(`spawning dsh web (workdir ${CONFIG.workdir})`)
  const child = spawn(process.execPath, args, {
    cwd: CONFIG.workdir,
    env: {
      ...process.env,
      DSH_HOME: env('DSH_HOME', path.join(CONFIG.dataDir, 'home')),
      DSH_AGENTS_HOME: env('DSH_AGENTS_HOME', path.join(CONFIG.dataDir, 'agents')),
      ...(CONFIG.heapMb > 0
        ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=${String(CONFIG.heapMb)}`.trim() }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  upstream.child = child
  upstream.ready = false
  if (child.pid !== undefined) {
    try {
      writeFileSync(CHILD_PID_FILE, `${String(child.pid)}\n`, { mode: 0o644 })
    } catch (error) {
      log(`could not record the child pid: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const startupTimer = setTimeout(() => {
    if (shuttingDown || upstream.ready) return
    log(`dsh web has printed no startup line after ${String(STARTUP_TIMEOUT_MS / 1000)}s; check the log above`)
  }, STARTUP_TIMEOUT_MS)
  startupTimer.unref()
  let buffered = ''
  const consume = (chunk) => {
    const text = String(chunk)
    buffered = (buffered + text).slice(-64_000)
    process.stdout.write(text)
    scanForLaunchUrl(buffered)
    if (upstream.ready) clearTimeout(startupTimer)
  }
  child.stdout.on('data', consume)
  child.stderr.on('data', consume)
  child.once('error', (error) => {
    log(`dsh web spawn failed: ${error.message}`)
    scheduleRestart()
  })
  child.once('exit', (code, signal) => {
    upstream.ready = false
    upstream.child = undefined
    rmSync(CHILD_PID_FILE, { force: true })
    if (shuttingDown) return
    log(`dsh web exited (${signal ?? String(code)}); restarting in ${String(restartDelayMs)}ms`)
    scheduleRestart()
  })
}

/** Restart DSH after a backoff, unless the process is going down. */
function scheduleRestart() {
  const delay = restartDelayMs
  restartDelayMs = Math.min(restartDelayMs * 2, 30_000)
  setTimeout(() => {
    if (!shuttingDown) startUpstream()
  }, delay).unref()
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

/** Hop-by-hop headers a proxy must not forward. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Request headers as a plain object, minus hop-by-hop entries. */
function forwardableHeaders(req) {
  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue
    headers[name] = value
  }
  const peer = req.socket.remoteAddress ?? ''
  headers['x-forwarded-for'] = peer
  headers['x-forwarded-proto'] = req.socket.encrypted === true ? 'https' : 'http'
  headers['x-forwarded-host'] = req.headers.host ?? ''
  return headers
}

/** Authority the private DSH listener sees on every proxied request. */
function upstreamAuthority() {
  return `127.0.0.1:${String(upstream.port)}`
}

/**
 * Headers for the private DSH listener. A browser may use any Host after the
 * gate password; the upstream sees one canonical loopback authority so DSH's
 * Host/Origin fence and its host-derived cookie name stay stable.
 * @param {import('node:http').IncomingMessage} req incoming request.
 * @returns {Record<string, string|string[]>} headers.
 */
function localProxyHeaders(req) {
  const headers = forwardableHeaders(req)
  const authority = upstreamAuthority()
  headers.host = authority
  const origin = headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    try {
      const parsed = new URL(origin)
      headers.origin = `${parsed.protocol}//${authority}`
    } catch {
      // A malformed Origin stays malformed; the upstream fence decides.
    }
  }
  return headers
}

/**
 * Rewrite a redirect the private listener issued in its canonical loopback
 * origin back to the browser-facing authority.
 * @param {import('node:http').IncomingMessage} req incoming request.
 * @param {string} location upstream Location value.
 * @returns {string} browser-facing Location.
 */
function browserLocation(req, location) {
  const canonical = `http://${upstreamAuthority()}`
  if (location !== canonical && !location.startsWith(`${canonical}/`)) return location
  const scheme = isSecureRequest(req) ? 'https' : 'http'
  return `${scheme}://${req.headers.host ?? ''}${location.slice(canonical.length)}`
}

/** Send a complete HTML response. */
function sendHtml(res, status, html, csp = PAGE_CSP) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    // `no-referrer` here would make Chrome send `Origin: null` on the form
    // POST, which is indistinguishable from an opaque third-party origin.
    'referrer-policy': 'same-origin',
  })
  res.end(html)
}

/** Send a small text response. */
function sendText(res, status, text, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  })
  res.end(text)
}

/** Only same-origin paths may be used as a post-login destination. */
function safeNext(raw) {
  if (typeof raw !== 'string' || raw === '') return '/'
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/'
  return raw
}

/** Read a request body up to a small bound. */
function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ─── gate routes ───────────────────────────────────────────────────────────

/** The local account sign-in helper, rebuilt whenever the DSH child changes. */
let accountLogin

/** The helper bound to the current listener, or undefined before readiness. */
function accountLoginHelper() {
  if (!upstream.ready || upstream.token === undefined) return undefined
  if (accountLogin !== undefined && accountLogin.port === upstream.port) return accountLogin
  accountLogin?.stop().catch(() => undefined)
  accountLogin = new AccountLogin({
    port: upstream.port,
    token: upstream.token,
    chromeBinary: CONFIG.chromeBinary,
    log,
    browserLauncher: process.platform === 'win32'
      ? new InteractiveBrowser({
        binary: CONFIG.chromeBinary,
        directory: path.join(CONFIG.dataDir, 'login-browser'),
        port: CONFIG.chromePort,
        log,
      })
      : undefined,
  })
  return accountLogin
}

/** Whether one gate page request is allowed; sends the refusal when it is not. */
function requireAdmission(req, res) {
  if (isAdmitted(req)) return true
  if (req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://gate.invalid')
    res.writeHead(303, {
      'cache-control': 'no-store',
      location: `/__gate/login?next=${encodeURIComponent(url.pathname)}`,
      'referrer-policy': 'no-referrer',
    })
    res.end()
    return false
  }
  sendText(res, 401, 'dsh-web-gate: authentication required\n')
  return false
}

/**
 * The QR image request IS the sign-in request.
 *
 * It starts the local browser when needed, waits for the platform to paint the
 * code, and answers with the picture — one call, one image. A caller that just
 * wants the code never needs a second endpoint.
 */
async function handleQrImage(req, res) {
  if (!requireAdmission(req, res)) return
  const helper = accountLoginHelper()
  if (helper === undefined) {
    sendText(res, 503, 'internal service is not ready yet\n')
    return
  }
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (res.writableEnded || req.destroyed) return
    await helper.reap()
    const result = await helper.requestQr().catch((error) => {
      log(`account qr: ${error instanceof Error ? error.message : String(error)}`)
      return { ready: false, signedIn: false }
    })
    if (result.signedIn === true) {
      // Already signed in: no image to show, the caller just refreshes.
      sendText(res, 204, '')
      return
    }
    const png = helper.qr
    if (result.ready === true && png !== undefined) {
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'content-length': png.length,
        'x-content-type-options': 'nosniff',
      })
      res.end(png)
      return
    }
    await wait(500)
  }
  sendText(res, 503, 'the QR code did not become ready in time\n')
}

/**
 * One held-open request that answers when the account lands.
 *
 * Not a stream: it returns exactly once, when DSH reports a stored grant or
 * when the sign-in window is over.
 */
async function handleAwait(req, res) {
  if (!requireAdmission(req, res)) return
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const deadline = Date.now() + 9 * 60_000
  let closed = false
  let seenRunning = false
  req.on('close', () => { closed = true })
  while (Date.now() < deadline && !closed) {
    const helper = accountLoginHelper()
    if (helper !== undefined) {
      const snapshot = helper.snapshot()
      if (snapshot.running === true) seenRunning = true
      const value = await helper.state().catch(() => undefined)
      if (value?.status === 'credential-stored') {
        sendText(res, 200, JSON.stringify({ signedIn: true }), {
          'content-type': 'application/json; charset=utf-8',
        })
        return
      }
      // The attempt (and with it the QR) is gone: the caller must fetch a new
      // code, otherwise the visitor scans a picture nobody is waiting for.
      if (seenRunning && snapshot.running === false) {
        sendText(res, 200, JSON.stringify({ signedIn: false, expired: true }), {
          'content-type': 'application/json; charset=utf-8',
        })
        return
      }
    }
    await wait(1500)
  }
  if (closed) return
  sendText(res, 200, JSON.stringify({ signedIn: false, expired: false }), {
    'content-type': 'application/json; charset=utf-8',
  })
}

/** Routes for the local account sign-in helper. */
async function handleAccountLogin(req, res, pathname) {
  if (!requireAdmission(req, res)) return
  const helper = accountLoginHelper()
  if (helper === undefined) {
    if (pathname === '/__gate/account-login/qr') {
      sendText(res, 503, JSON.stringify({ ready: false, signedIn: false, error: '内部服务尚未就绪' }), {
        'content-type': 'application/json; charset=utf-8',
      })
      return
    }
    sendHtml(res, 503, page({
      title: '正在启动',
      heading: '服务正在启动',
      body: 'DeepSeek Harness 还没有就绪，请稍等几秒再试。',
      refresh: 3,
    }))
    return
  }
  try {
    if (pathname === '/__gate/account-login' && req.method === 'GET') {
      const nonce = randomBytes(16).toString('base64url')
      const url = new URL(req.url ?? '/', 'http://gate.invalid')
      const { html, csp } = accountLoginPage({ nonce, embedded: url.searchParams.get('embed') === '1' })
      sendHtml(res, 200, html, csp)
      return
    }
    if (pathname === '/__gate/account-login/qr.png' && req.method === 'GET') {
      await handleQrImage(req, res)
      return
    }
    if (pathname === '/__gate/account-login/await' && req.method === 'GET') {
      await handleAwait(req, res)
      return
    }
    if (pathname === '/__gate/account-login/stop' && req.method === 'POST') {
      await helper.stop()
      sendText(res, 200, JSON.stringify(helper.snapshot()), {
        'content-type': 'application/json; charset=utf-8',
      })
      return
    }
    if (pathname === '/__gate/account-login/state' && req.method === 'GET') {
      await helper.reap()
      await helper.state().catch(() => undefined)
      sendText(res, 200, JSON.stringify(helper.snapshot()), {
        'content-type': 'application/json; charset=utf-8',
      })
      return
    }
    sendText(res, 404, 'not found\n')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`account login: ${message}`)
    sendText(res, 200, JSON.stringify({ ready: false, signedIn: false, qrAt: 0, error: message }), {
      'content-type': 'application/json; charset=utf-8',
    })
  }
}

/** The login form. */
function handleLoginForm(req, res, url) {
  const next = safeNext(url.searchParams.get('next'))
  const ip = req.socket.remoteAddress ?? ''
  const wait = lockoutSeconds(ip, Date.now())
  sendHtml(res, wait > 0 ? 429 : 200, loginPage({
    next,
    wait,
    startedSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
  }))
}

/**
 * Whether one login submission may be accepted from this caller's browser.
 *
 * The password is a deployment secret, so a page on another site must not be
 * able to submit it for a visitor. Browsers label the initiator on every
 * request: `Sec-Fetch-Site` is authoritative when present, and an attached
 * `Origin` must name this very authority. An opaque `null` origin is accepted
 * only for a same-origin submission, because Chrome emits exactly that when a
 * page's referrer policy suppresses the origin. Non-browser clients (curl, a
 * health probe) send neither header, and the check does not pretend to
 * authenticate them — the password still does.
 * @param req - the incoming POST /__gate/login request.
 * @returns true when this submission may be evaluated.
 */
function loginSubmissionAllowed(req) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  const host = req.headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') return true
  if (origin === 'null') return site === 'same-origin'
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Verify one submitted password and mint the gate cookie. */
async function handleLoginSubmit(req, res, url) {
  const ip = req.socket.remoteAddress ?? ''
  const now = Date.now()
  const wait = lockoutSeconds(ip, now)
  if (wait > 0) {
    sendHtml(res, 429, loginPage({ next: '/', wait, error: `尝试次数过多，请 ${String(wait)} 秒后再试` }))
    return
  }
  if (!loginSubmissionAllowed(req)) {
    log(`login refused from ${ip}: origin ${String(req.headers.origin)} vs host ${String(req.headers.host)}`)
    sendHtml(res, 403, page({
      title: '请求被拒绝',
      heading: '请求被拒绝',
      body: '登录请求来自其他站点。请直接访问本服务地址后重试。',
    }))
    return
  }
  let body
  try {
    body = await readBody(req)
  } catch {
    sendText(res, 413, 'request body too large\n')
    return
  }
  const form = new URLSearchParams(body)
  const password = form.get('password') ?? ''
  const next = safeNext(form.get('next') ?? url.searchParams.get('next'))
  if (!passwordMatches(password)) {
    const locked = registerFailure(ip, now)
    log(`login failed from ${ip}${locked ? ' (locked)' : ''}`)
    sendHtml(res, 401, loginPage({
      next,
      wait: locked ? LOCKOUT_MS / 1000 : 0,
      error: '密码不正确',
    }))
    return
  }
  attempts.delete(ip)
  const maxAgeSeconds = CONFIG.cookieDays * 86_400
  // Behind a TLS-terminating proxy the browser leg is HTTPS even though the
  // request reaching this listener may be plain, so Secure is added only when
  // this very connection is encrypted.
  const secure = req.socket.encrypted === true ? '; Secure' : ''
  const cookie = `${COOKIE_NAME}=${mintCookie(now)}; Max-Age=${String(maxAgeSeconds)}; Path=/; HttpOnly; SameSite=Lax${secure}`
  log(`login ok from ${ip}`)
  res.writeHead(303, {
    'cache-control': 'no-store',
    'location': next,
    'set-cookie': cookie,
    'referrer-policy': 'no-referrer',
  })
  res.end()
}

/** Clear the gate cookie and every DSH session cookie this browser presented. */
function handleLogout(req, res) {
  const expired = [
    `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`,
    `${TARGET_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`,
  ]
  const raw = req.headers.cookie
  if (typeof raw === 'string') {
    for (const segment of raw.split(';')) {
      const at = segment.indexOf('=')
      if (at === -1) continue
      const name = segment.slice(0, at).trim()
      // DSH mints `dsh-auth-*`; a proxied member's jars live under `dsh_m_*`.
      if (!name.startsWith('dsh-auth-') && !name.startsWith('dsh_m_')) continue
      // DSH's own cookie is HttpOnly too, so only a response can remove it.
      expired.push(`${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`)
    }
  }
  res.writeHead(303, {
    'cache-control': 'no-store',
    'location': '/__gate/login',
    'set-cookie': expired,
    'referrer-policy': 'no-referrer',
  })
  res.end()
}

/** Machine-readable readiness, for a supervisor or a smoke check. */
function handleHealth(req, res) {
  const body = JSON.stringify({
    ok: upstream.ready,
    gate: 'up',
    upstream: upstream.ready ? `http://127.0.0.1:${String(upstream.port)}` : 'starting',
    authenticated: isAdmitted(req),
    passwordRequired: true,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  })
  res.writeHead(upstream.ready ? 200 : 503, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Whether the path is a gate-owned route. */
function isGatePath(pathname) {
  return pathname === '/__gate' || pathname.startsWith('/__gate/')
}

// ─── proxying ──────────────────────────────────────────────────────────────

// A fresh socket per upstream request. The private DSH listener closes idle
// keep-alive connections after a few seconds, and a socket the pool still
// believes in can swallow the next request without any error - the page then
// hangs behind a healthy-looking gate until the gate is restarted.
const agent = new http.Agent({ keepAlive: false, maxSockets: 128 })

/**
 * Member discovery, selection, and the remote proxy. The service is the only
 * place that knows how to reach another member; the dispatch path below only
 * asks it which route a request takes.
 */
const members = new MemberService({
  clusterKey: CONFIG.clusterKey,
  memberPort: CONFIG.memberPort,
  discoveryPorts: CONFIG.memberPorts,
  stateFile: path.join(env('DSH_HOME', path.join(os.homedir(), '.dsh')), 'wireguard', 'state.json'),
  discoveryTimeoutMs: CONFIG.discoveryTimeoutMs,
  discoveryCacheMs: CONFIG.discoveryCacheMs,
  clusterAllow: CONFIG.clusterAllow,
  memberPublic: CONFIG.memberPublic,
  version: PACKAGE_VERSION,
  fetchImpl: fetch,
  log,
  isAdmitted,
  isUpstreamReady: () => upstream.ready,
  forwardableHeaders,
  agent,
  page,
  sendHtml,
  now: Date.now,
})

/** A short page telling the visitor DSH is still coming up. */
function sendStarting(res) {
  sendHtml(res, 503, page({
    title: '正在启动',
    heading: '服务正在启动',
    body: 'DeepSeek Harness 正在启动，页面会自动刷新。首次启动通常需要十几秒。',
    refresh: 3,
  }))
}

/**
 * Forward one ordinary request to the private listener.
 * @param req - incoming public request.
 * @param res - response owned to completion.
 */
function proxyRequest(req, res) {
  if (!upstream.ready) {
    sendStarting(res)
    return
  }
  const startedAtMs = Date.now()
  let responseTimer
  const upstreamReq = http.request({
    host: '127.0.0.1',
    port: upstream.port,
    method: req.method,
    path: req.url,
    headers: localProxyHeaders(req),
    agent,
  }, (upstreamRes) => {
    clearTimeout(responseTimer)
    const headers = {}
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue
      headers[name] = name.toLowerCase() === 'location' && typeof value === 'string'
        ? browserLocation(req, value)
        : value
    }
    res.writeHead(upstreamRes.statusCode ?? 502, headers)
    upstreamRes.pipe(res)
    upstreamRes.on('error', () => {
      if (!res.writableEnded) res.destroy()
    })
    upstreamRes.on('end', () => {
      if (CONFIG.accessLog) {
        log(`${req.method ?? 'GET'} ${req.url ?? '/'} ${String(upstreamRes.statusCode)} ${String(Date.now() - startedAtMs)}ms`)
      }
    })
  })
  // A request whose response headers never arrive must fail instead of
  // pinning a browser (and, before keep-alive was disabled, a socket) forever.
  responseTimer = setTimeout(() => {
    upstreamReq.destroy(new Error('upstream response timeout'))
  }, 60_000)
  // The browser closing the page, navigating away, or cancelling a stream
  // leaves the upstream half open unless this request is torn down with it.
  res.on('close', () => {
    clearTimeout(responseTimer)
    if (!res.writableFinished) upstreamReq.destroy()
  })
  upstreamReq.on('error', (error) => {
    clearTimeout(responseTimer)
    if (res.headersSent) {
      res.destroy()
      return
    }
    log(`upstream error for ${req.method ?? 'GET'} ${req.url ?? '/'}: ${error.message}`)
    sendHtml(res, 502, page({
      title: '服务不可用',
      heading: '无法连接 DeepSeek Harness',
      body: '内部服务没有响应，可能正在重启。请稍后刷新页面。',
      refresh: 5,
    }))
  })
  req.pipe(upstreamReq)
}

/**
 * Forward one WebSocket (or other upgrade) request after the cookie check.
 * @param req - the HTTP upgrade request.
 * @param socket - the client socket.
 * @param head - bytes already read from the client.
 */
async function proxyUpgrade(req, socket, head) {
  if (!isAdmitted(req)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return
  }
  let target
  try {
    target = await members.resolveTarget(req)
  } catch (error) {
    log(`member resolution failed for upgrade ${req.url ?? '/'}: ${error instanceof Error ? error.message : String(error)}`)
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return
  }
  if (target.kind === 'remote') {
    members.proxyRemoteUpgrade(req, socket, head, target.member)
    return
  }
  if (target.kind === 'unavailable') {
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return
  }
  proxyUpgradeLocal(req, socket, head)
}

/**
 * Forward one WebSocket (or other upgrade) request to the private listener.
 * @param req - the HTTP upgrade request.
 * @param socket - the client socket.
 * @param head - bytes already read from the client.
 */
function proxyUpgradeLocal(req, socket, head) {
  if (!isAdmitted(req)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return
  }
  if (!upstream.ready) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return
  }
  const headers = localProxyHeaders(req)
  // An upgrade keeps these two, which ordinary requests must drop.
  if (req.headers.upgrade !== undefined) headers.upgrade = req.headers.upgrade
  headers.connection = 'Upgrade'
  const upstreamReq = http.request({
    host: '127.0.0.1',
    port: upstream.port,
    method: req.method,
    path: req.url,
    headers,
    agent: false,
  })
  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    const lines = [`HTTP/1.1 ${String(upstreamRes.statusCode ?? 101)} ${upstreamRes.statusMessage ?? 'Switching Protocols'}`]
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (value === undefined) continue
      for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`)
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    if (head.length > 0) upstreamSocket.write(head)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
    upstreamSocket.on('error', () => socket.destroy())
    socket.on('error', () => upstreamSocket.destroy())
    upstreamSocket.on('close', () => socket.destroy())
    socket.on('close', () => upstreamSocket.destroy())
  })
  upstreamReq.on('response', (upstreamRes) => {
    // The listener answered with an ordinary response instead of upgrading.
    socket.end(`HTTP/1.1 ${String(upstreamRes.statusCode ?? 502)} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  })
  upstreamReq.on('error', () => {
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })
  upstreamReq.end()
}

// ─── request dispatch ──────────────────────────────────────────────────────

/**
 * Static application metadata a browser requests on its own — before the
 * password is entered, for a manifest it cached on an earlier visit. These
 * carry no data; refusing them only produces 401 noise in the console.
 */
const PUBLIC_ASSETS = new Set(['/manifest.webmanifest', '/favicon.ico', '/robots.txt', '/apple-touch-icon.png'])

/** Route one public request. */
/**
 * Paths a peer or a monitor calls over plain HTTP. Redirecting them would
 * break member discovery, cluster proxying, and health checks.
 */
const HTTPS_REDIRECT_EXEMPT = [
  /^\/__gate\/cluster(?:\/|$)/u,
  /^\/__gate\/health$/u,
  /^\/__gate\/member$/u,
  /^\/\.well-known\/acme-challenge\//u,
]

/**
 * Host header without its port, keeping an IPv6 literal in brackets.
 * @param {unknown} header raw `Host` header.
 * @returns {string} host, or an empty string when unusable.
 */
function hostWithoutPort(header) {
  if (typeof header !== 'string' || header === '') return ''
  if (header.startsWith('[')) {
    const end = header.indexOf(']')
    return end === -1 ? '' : header.slice(0, end + 1)
  }
  const colon = header.lastIndexOf(':')
  return colon === -1 ? header : header.slice(0, colon)
}

/**
 * Whether the browser reached this gate over TLS.
 *
 * A gate behind a TLS-terminating proxy (Cloudflare, nginx, a load balancer)
 * only ever sees plain HTTP on its own listener. Redirecting those requests
 * would send the browser back through the proxy to the same plain listener,
 * and the two would bounce until the browser reports ERR_TOO_MANY_REDIRECTS.
 * The proxy reports the browser-facing scheme in `X-Forwarded-Proto`.
 *
 * @param {import('node:http').IncomingMessage} req request.
 * @returns {boolean} true when the browser connection is encrypted.
 */
function isSecureRequest(req) {
  if (req.socket.encrypted === true) return true
  const header = req.headers['x-forwarded-proto']
  const value = Array.isArray(header) ? header[0] : header
  if (typeof value !== 'string') return false
  return value.split(',')[0].trim().toLowerCase() === 'https'
}

/**
 * Answer a browser request that arrived on the plain listener with a redirect
 * to the TLS listener.
 * @param {import('node:http').IncomingMessage} req request.
 * @param {import('node:http').ServerResponse} res response.
 * @param {URL} url parsed request URL.
 * @param {string} pathname request path.
 * @returns {boolean} true when the request was answered.
 */
function redirectPlainHttp(req, res, url, pathname) {
  if (CONFIG.redirectHttps !== true) return false
  if (isSecureRequest(req)) return false
  if (HTTPS_REDIRECT_EXEMPT.some(pattern => pattern.test(pathname))) return false
  const host = hostWithoutPort(req.headers.host)
  if (host === '') return false
  const port = CONFIG.tls.port === 443 ? '' : `:${String(CONFIG.tls.port)}`
  res.writeHead(308, {
    // `no-store` keeps a config change from being pinned by the browser cache.
    'cache-control': 'no-store',
    location: `https://${host}${port}${pathname}${url.search}`,
    'referrer-policy': 'no-referrer',
  })
  res.end()
  return true
}

/** Ask the Windows supervisor to re-evaluate where the stack runs. */
async function handleSessionPromote(res) {
  const root = process.env.DSH_PACKAGE_ROOT && process.env.DSH_PACKAGE_ROOT.trim() !== ''
    ? process.env.DSH_PACKAGE_ROOT.trim()
    : process.cwd()
  const dataDir = path.join(root, 'data')
  const commandFile = path.join(dataDir, 'session-command.json')
  const statusFile = path.join(dataDir, 'session-status.json')
  try { mkdirSync(dataDir, { recursive: true }) } catch { }
  await writeFile(commandFile, `${JSON.stringify({ action: 'promote', at: new Date().toISOString() })}\n`, 'utf8').catch(() => {})
  // The supervisor watches that file once per tick; give it one tick to react.
  await new Promise(resolve => setTimeout(resolve, 2500))
  let status = null
  try {
    status = JSON.parse(await readFile(statusFile, 'utf8'))
  } catch { }
  const body = JSON.stringify({ ok: true, status })
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function dispatch(req, res) {
  const url = new URL(req.url ?? '/', 'http://gate.invalid')
  const pathname = url.pathname
  if (redirectPlainHttp(req, res, url, pathname)) return

  // A peer gate forwards here under /__gate/cluster/...; strip and serve it
  // from the local DSH as if the browser had asked this gate directly.
  if (pathname === CLUSTER_PREFIX || pathname.startsWith(`${CLUSTER_PREFIX}/`)) {
    await members.handleCluster(req, res, dispatch)
    return
  }

  if (isGatePath(pathname)) {
    if (await members.handle(req, res, url)) return
    if (pathname.startsWith('/__gate/account-login')) {
      await handleAccountLogin(req, res, pathname)
      return
    }
    if (pathname === '/__gate/login' && req.method === 'GET') {
      handleLoginForm(req, res, url)
      return
    }
    if (pathname === '/__gate/login' && req.method === 'POST') {
      await handleLoginSubmit(req, res, url)
      return
    }
    if (pathname === '/__gate/logout') {
      handleLogout(req, res)
      return
    }
    if (pathname === '/__gate/session/promote' && req.method === 'POST') {
      // Only a peer gate may ask for this: a browser can reach the same path.
      if (req.__dshCluster !== true) {
        sendText(res, 403, 'cluster only\n')
        return
      }
      await handleSessionPromote(res)
      return
    }
    if (pathname === '/__gate/health') {
      handleHealth(req, res)
      return
    }
    sendText(res, 404, 'not found\n')
    return
  }

  // The gate password is the single admission rule. Any browser-facing Host
  // is accepted here; the private DSH listener always sees a canonical
  // loopback authority, so its own Host/Origin fence cannot reject the request.

  // Application metadata answers before the password check: the browser asks
  // for it on any navigation, including the login page itself. An admitted
  // browser follows the target like every other request.
  if (PUBLIC_ASSETS.has(pathname) && !isAdmitted(req)) {
    proxyRequest(req, res)
    return
  }

  if (!isAdmitted(req)) {
    // A browser navigation goes to the form; everything else (an API call, an
    // asset, a script) gets the plain 401 so a client cannot mistake HTML for
    // its own payload.
    const accept = String(req.headers.accept ?? '')
    const wantsDocument = req.method === 'GET'
      && (accept.includes('text/html') || req.headers['sec-fetch-mode'] === 'navigate')
    if (wantsDocument) {
      const next = safeNext(`${pathname}${url.search}`)
      res.writeHead(303, {
        'cache-control': 'no-store',
        location: `/__gate/login?next=${encodeURIComponent(next)}`,
        'referrer-policy': 'no-referrer',
      })
      res.end()
      return
    }
    sendText(res, 401, 'dsh-web-gate: authentication required\n')
    return
  }

  // The target cookie is the only routing input. `local` keeps the original
  // single-upstream behaviour; a peer is proxied through its gate with a
  // signed cluster request, and an unreachable peer gets a page with a way
  // back to the local DSH instead of a dead end.
  const target = await members.resolveTarget(req)
  if (target.kind === 'remote') {
    await members.proxyRemote(req, res, target.member)
    return
  }
  if (target.kind === 'unavailable') {
    members.sendUnavailable(res, target.id, target.reason)
    return
  }

  // A browser holding the gate cookie but no DSH cookie yet (first visit,
  // another authority, or a DSH restart) goes through the launch-token
  // exchange before anything else; DSH then sets its own session cookie.
  if (req.method === 'GET' && pathname === '/') {
    const expected = dshCookieName(upstreamAuthority())
    const held = expected !== undefined && cookieFrom(req, expected) !== undefined
    const hasToken = url.searchParams.has('token')
    if (!held && !hasToken) {
      if (!upstream.ready || upstream.token === undefined) {
        sendStarting(res)
        return
      }
      res.writeHead(303, {
        'cache-control': 'no-store',
        location: `/?token=${encodeURIComponent(upstream.token)}`,
        'referrer-policy': 'no-referrer',
      })
      res.end()
      return
    }
  }

  proxyRequest(req, res)
}

/** The one request listener every public listener shares. */
function requestListener(req, res) {
  dispatch(req, res).catch((error) => {
    log(`dispatch failed: ${error instanceof Error ? error.message : String(error)}`)
    if (!res.headersSent) sendText(res, 500, 'internal gate error\n')
    else res.destroy()
  })
}

/**
 * Attach upgrade, error, and timeout behaviour to one listener.
 * @param instance - an HTTP or HTTPS server.
 */
function wire(instance) {
  instance.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://gate.invalid')
    if (url.pathname === CLUSTER_PREFIX || url.pathname.startsWith(`${CLUSTER_PREFIX}/`)) {
      members.handleClusterUpgrade(req, socket, head, proxyUpgradeLocal)
      return
    }
    if (isGatePath(url.pathname)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    void proxyUpgrade(req, socket, head)
  })
  instance.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    if (CONFIG.accessLog) log(`client error: ${error.message}`)
  })
  // Long-lived streams (SSE, uploads) own their own lifetime.
  instance.requestTimeout = 0
  instance.headersTimeout = 60_000
  instance.keepAliveTimeout = 65_000
  instance.timeout = 0
}

const server = http.createServer(requestListener)
wire(server)

/** Every bound listener, so shutdown can close them all. */
const listeners = [{ instance: server, port: CONFIG.port, scheme: 'http' }]

if (CONFIG.tls.certFile !== '' || CONFIG.tls.keyFile !== '') {
  if (CONFIG.tls.certFile === '' || CONFIG.tls.keyFile === '') {
    log('refusing to start: DSH_GATE_TLS_CERT and DSH_GATE_TLS_KEY must be set together')
    process.exit(1)
  }
  let cert
  let key
  try {
    cert = readFileSync(CONFIG.tls.certFile)
    key = readFileSync(CONFIG.tls.keyFile)
  } catch (error) {
    log(`cannot read the TLS material: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  const tlsServer = createSecureServer({ cert, key }, requestListener)
  wire(tlsServer)
  listeners.push({ instance: tlsServer, port: CONFIG.tls.port, scheme: 'https' })
}

/** Bind one listener, preferring dual-stack, reporting failures precisely. */
function bindListener(entry) {
  const { instance, port, scheme } = entry
  const onListen = () => {
    const address = instance.address()
    const where = typeof address === 'object' && address !== null ? `${address.address}:${String(address.port)}` : String(address)
    log(`${scheme.toUpperCase()} listening on ${where} (password required)`)
    log(`open ${scheme}://<this-host>:${String(port)}/ and enter the deployment password`)
  }
  const attempt = (host) => {
    const onError = (error) => {
      if (host === '::' && (error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL')) {
        log('IPv6 unavailable; binding 0.0.0.0 instead')
        attempt('0.0.0.0')
        return
      }
      if (error.code === 'EACCES' && port < 1024) {
        log(`cannot bind port ${String(port)}: permission denied (ports below 1024 need root or CAP_NET_BIND_SERVICE)`)
        process.exit(1)
      }
      log(`cannot bind ${host}:${String(port)}: ${error.message}`)
      process.exit(1)
    }
    instance.once('error', onError)
    instance.once('listening', () => {
      instance.off('error', onError)
      onListen()
    })
    instance.listen(port, host)
  }
  attempt(CONFIG.bind)
}

// ─── lifecycle ─────────────────────────────────────────────────────────────

/** Stop the child, then the listener, then exit. */
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutting down (${signal})`)
  const child = upstream.child
  if (child !== undefined && child.exitCode === null) {
    child.kill('SIGTERM')
    const forced = setTimeout(() => {
      child.kill('SIGKILL')
    }, 10_000)
    forced.unref()
  }
  server.close(() => {
    process.exit(0)
  })
  for (const entry of listeners) {
    if (entry.instance !== server) entry.instance.close()
  }
  setTimeout(() => {
    process.exit(0)
  }, 12_000).unref()
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM')
})
process.on('SIGINT', () => {
  shutdown('SIGINT')
})
process.on('unhandledRejection', (reason) => {
  log(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`)
})
process.on('exit', () => {
  rmSync(PID_FILE, { force: true })
  rmSync(CHILD_PID_FILE, { force: true })
})

if (CONFIG.password.length < 8) {
  log('refusing to start: DSH_GATE_PASSWORD must be at least 8 characters')
  process.exit(1)
}

log(`package root ${PACKAGE_ROOT}`)
log(`workdir ${CONFIG.workdir}`)
log(`trusted authorities: ${trustedAuthorities().join(', ')}`)
if (CONFIG.redirectHttps) log(`plain HTTP redirects to HTTPS on :${String(CONFIG.tls.port)}`)
log(`member clustering enabled (peer requests sign with a secret derived from the gateway password); peers reach this gate on port ${String(CONFIG.memberPort)}`)
log(CONFIG.heapMb > 0
  ? `dsh web heap ceiling: ${String(CONFIG.heapMb)} MB (machine has ${String(Math.round(os.totalmem() / 1024 / 1024))} MB)`
  : 'dsh web heap ceiling: none (set DSH_WEB_HEAP_MB to cap it)')
// One pid file lets stop.sh target this process, and only this process.
mkdirSync(CONFIG.dataDir, { recursive: true, mode: 0o700 })
await writeFile(PID_FILE, `${String(process.pid)}\n`, { mode: 0o644 })
for (const entry of listeners) bindListener(entry)
startUpstream()
