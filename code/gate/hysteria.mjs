/**
 * Hysteria2 direct links configured from the gateway.
 *
 * The gateway resolves two members, opens SSH to each of them with the same
 * keys the deploy engine uses, installs the bundled hysteria2 binary, writes a
 * server/client pair and reports progress as a job. The browser only talks to
 * this module through `/__gate/hysteria/*`.
 *
 * A link is one-directional in configuration but symmetric in use:
 *
 *   server  hysteria2 server on a member with a reachable UDP port
 *   client  hysteria2 client on the other member; TUN routes the server's VPN
 *           address through it, with a SOCKS5 fallback when TUN cannot start
 *
 * Nothing here opens cloud security groups. The caller is told which UDP port
 * to allow; the client's handshake is the proof that it is open.
 *
 * @module dsh-mesh/gate/hysteria
 */

import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isIP } from 'node:net'
import { readWireGuardState } from '../shared/wireguard.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = path.join(HERE, 'assets', 'hysteria2')
const DEFAULT_PORT = 8443
const DEFAULT_BANDWIDTH = 30
const SSH_PORT = 22
const MAX_BODY = 64 * 1024
const JOB_LIMIT = 50

/** Short, single-line text for one thrown value. */
function errorMessage(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/gu, ' ').trim().slice(0, 240)
}
const STEPS = [
  { key: 'preflight', label: '解析成员与资源' },
  { key: 'server', label: '配置服务端' },
  { key: 'client', label: '配置客户端' },
  { key: 'verify', label: '验证直连' },
]

/** Quote one value for a POSIX shell single-quoted string. */
function sh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** Quote one value for a PowerShell single-quoted string. */
function ps(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** Human byte count. */
function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${String(Math.round(bytes))} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

/** Host part of a WireGuard endpoint such as `1.2.3.4:51820` or `[v6]:51820`. */
function hostFromEndpoint(endpoint) {
  const text = typeof endpoint === 'string' ? endpoint.trim() : ''
  if (text === '') return ''
  if (text.startsWith('[')) {
    const close = text.indexOf(']')
    return close > 0 ? text.slice(1, close) : ''
  }
  const colon = text.lastIndexOf(':')
  if (colon > 0 && text.indexOf(':') === colon) return text.slice(0, colon)
  return text
}

/** Join a host and port for a YAML `server:` value. */
function hostPort(host, port) {
  return host.includes(':') ? `[${host}]:${String(port)}` : `${host}:${String(port)}`
}

/** Last `count` lines of a text. */
function tail(text, count) {
  const lines = String(text).replace(/\r\n/gu, '\n').split('\n')
  return lines.slice(-Math.max(1, count)).join('\n')
}

/** Stream one local file to a remote path. */
async function uploadFile(target, local, remote, onProgress) {
  const totalBytes = (await stat(local)).size
  let sent = 0
  let lastAt = Date.now()
  let lastBytes = 0
  const report = force => {
    const now = Date.now()
    if (!force && now - lastAt < 250) return
    const seconds = Math.max(0.1, (now - lastAt) / 1000)
    const speed = Math.max(0, (sent - lastBytes) / seconds)
    lastAt = now
    lastBytes = sent
    onProgress?.({
      bytes: sent,
      totalBytes,
      percent: totalBytes > 0 ? Math.min(100, Math.round((sent / totalBytes) * 100)) : 0,
      speed,
      indeterminate: false,
    })
  }
  if (target.os === 'windows') {
    const name = path.win32.basename(remote)
    const dir = await mkdtemp(path.join(tmpdir(), 'hy-upload-'))
    const staged = path.join(dir, name)
    await copyFile(local, staged)
    try {
      await new Promise((resolve, reject) => {
        const ssh = spawn('ssh', [...sshArgs(target), `tar -xf - -C "${path.win32.dirname(remote)}"`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        const tar = spawn('tar', ['-cf', '-', '-C', dir, name], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        let stderr = ''
        tar.stderr.on('data', chunk => { stderr += String(chunk) })
        ssh.stderr.on('data', chunk => { stderr += String(chunk) })
        tar.stdout.on('data', chunk => {
          sent += chunk.length
          report()
        })
        tar.stdout.pipe(ssh.stdin)
        tar.once('error', reject)
        ssh.once('error', reject)
        ssh.once('exit', code => {
          if (code === 0) {
            report(true)
            resolve()
          } else {
            reject(new Error(`upload failed (${String(code)}): ${stderr.trim()}`))
          }
        })
      })
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    return
  }
  await new Promise((resolve, reject) => {
    const ssh = spawn('ssh', [...sshArgs(target), `cat > ${sh(remote)}`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const source = createReadStream(local)
    let stderr = ''
    ssh.stderr.on('data', chunk => { stderr += String(chunk) })
    source.on('data', chunk => {
      sent += chunk.length
      report()
    })
    source.once('error', reject)
    ssh.once('error', reject)
    ssh.once('exit', code => {
      if (code === 0) {
        report(true)
        resolve()
      } else {
        reject(new Error(`upload failed (${String(code)}): ${stderr.trim()}`))
      }
    })
    source.pipe(ssh.stdin)
  })
}

/** SSH options for one target. */
function sshArgs(target) {
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', '-p', String(target.port ?? SSH_PORT)]
  if (target.identityFile) args.push('-i', target.identityFile)
  args.push(target.user ? `${target.user}@${target.host}` : target.host)
  return args
}

/** Run one local process and stream its output lines. */
function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const buffers = { out: '', err: '' }
    const emit = (key, chunk) => {
      const text = buffers[key] + String(chunk)
      const lines = text.split(/\r?\n/u)
      buffers[key] = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed !== '') options.onLine?.(trimmed)
      }
    }
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
      emit('out', chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
      emit('err', chunk)
    })
    child.once('error', reject)
    child.once('exit', code => {
      for (const key of ['out', 'err']) {
        const trimmed = buffers[key].trim()
        if (trimmed !== '') options.onLine?.(trimmed)
      }
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} exited with ${String(code)}: ${(stderr.trim() || stdout.trim()).slice(-600)}`))
    })
    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

/** Run a shell/PowerShell script on one target. */
async function runScript(target, script, onLine) {
  if (target.os === 'linux') {
    return runProcess('ssh', [...sshArgs(target), 'bash -s'], { input: script, onLine })
  }
  const name = `hysteria-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}.ps1`
  const local = path.join(tmpdir(), name)
  const remote = `C:\\Windows\\Temp\\${name}`
  await writeFile(local, `\uFEFF${script}`, 'utf8')
  try {
    await uploadFile(target, local, remote)
    return await runProcess('ssh', [...sshArgs(target), `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${remote}"`], { onLine })
  } finally {
    await rm(local, { force: true }).catch(() => {})
    await runProcess('ssh', [...sshArgs(target), `cmd /c del /f "${remote}"`]).catch(() => {})
  }
}

/** Read a remote file's tail over SSH. */
async function readRemoteTail(target, file, lines = 40) {
  const command = target.os === 'windows'
    ? `powershell.exe -NoProfile -Command "if (Test-Path ${ps(file)}) { Get-Content ${ps(file)} -Tail ${String(lines)} }"`
    : `if [ -f ${sh(file)} ]; then tail -n ${String(lines)} ${sh(file)}; fi`
  const { stdout } = await runProcess('ssh', [...sshArgs(target), command])
  return stdout
}

/** Wait until a predicate over a log tail is true. */
async function waitFor(target, file, match, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    last = await readRemoteTail(target, file, 40).catch(() => '')
    if (match.test(last)) return { ok: true, text: last }
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  return { ok: false, text: last }
}

/**
 * One hysteria job store and runner.
 */
export class HysteriaService {
  /**
   * @param {object} options dependencies.
   * @param {string} options.home DSH home.
   * @param {string} options.stateFile WireGuard state file.
   * @param {(line: string) => void} options.log gateway logger.
   * @param {(req: import('node:http').IncomingMessage) => boolean} options.isAdmitted admission check.
   * @param {() => Promise<object>} options.snapshot member snapshot.
   */
  constructor(options) {
    this.home = options.home
    this.stateFile = options.stateFile
    this.log = options.log ?? (() => {})
    this.isAdmitted = options.isAdmitted
    this.snapshot = options.snapshot
    this.dataDir = path.join(this.home, 'hysteria')
    /** @type {Map<string, object>} */
    this.states = new Map()
    /** @type {Map<string, Promise<object>>} */
    this.running = new Map()
  }

  /** Read the bundled asset manifest. */
  async assets() {
    try {
      const raw = await readFile(path.join(ASSETS_DIR, 'manifest.json'), 'utf8')
      const manifest = JSON.parse(raw)
      return { ok: true, ...manifest, dir: ASSETS_DIR }
    } catch (error) {
      return { ok: false, error: `hysteria assets are missing: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** One asset for an OS, or null. */
  async #asset(os) {
    const manifest = await this.assets()
    if (!manifest.ok) throw new Error(manifest.error)
    const asset = (manifest.assets ?? []).find(item => item.os === os)
    if (!asset) throw new Error(`no hysteria2 asset for ${os}`)
    const file = path.join(ASSETS_DIR, asset.file)
    const info = await stat(file).catch(() => null)
    if (info === null) throw new Error(`hysteria2 asset is missing: ${asset.file}`)
    return { ...asset, path: file }
  }

  /** List jobs, newest first. */
  async jobs(limit = 20) {
    const entries = await readdir(this.dataDir, { withFileTypes: true }).catch(() => [])
    const jobs = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('hy-')) continue
      try {
        jobs.push(JSON.parse(await readFile(path.join(this.dataDir, entry.name, 'job.json'), 'utf8')))
      } catch {
        // Ignore a job that is being written right now.
      }
    }
    jobs.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    return jobs.slice(0, Math.max(1, Math.min(limit, JOB_LIMIT)))
  }

  /** One job state. */
  async status(id) {
    if (!/^hy-[A-Za-z0-9-]+$/u.test(String(id))) return null
    const live = this.states.get(id)
    if (live !== undefined) return live
    try {
      return JSON.parse(await readFile(path.join(this.dataDir, id, 'job.json'), 'utf8'))
    } catch {
      return null
    }
  }

  /** Tail one job log. */
  async logs(id, lines = 200) {
    if (!/^hy-[A-Za-z0-9-]+$/u.test(String(id))) return ''
    try {
      const text = await readFile(path.join(this.dataDir, id, 'job.log'), 'utf8')
      return tail(text, lines)
    } catch {
      return ''
    }
  }

  /** Persisted link summaries, minus records a rejoin invalidated. */
  async links() {
    let stored
    try {
      stored = JSON.parse(await readFile(path.join(this.dataDir, 'links.json'), 'utf8'))
    } catch {
      return { ok: true, links: [] }
    }
    const all = Array.isArray(stored.links) ? stored.links : []
    let peers
    try {
      const state = await readWireGuardState({ file: this.stateFile })
      peers = state.state?.server?.peers ?? []
    } catch {
      return { ok: true, links: all }
    }
    // A member that rejoined after a link was written no longer runs the
    // hysteria server or client: reinstalling it wipes /etc/hysteria while the
    // VPN address stays the same, so the stored record must be dropped.
    const live = all.filter(link => {
      const created = Date.parse(String(link?.updatedAt ?? ''))
      if (!Number.isFinite(created)) return false
      for (const side of [link?.server, link?.client]) {
        const peer = peers.find(candidate => candidate?.ip === side?.ip)
        if (!peer) return false
        const joined = Date.parse(String(peer.createdAt ?? ''))
        if (Number.isFinite(joined) && joined > created) return false
      }
      return true
    })
    if (live.length !== all.length) {
      await writeFile(path.join(this.dataDir, 'links.json'), `${JSON.stringify({ ok: true, links: live }, null, 2)}\n`, 'utf8').catch(() => {})
    }
    return { ok: true, links: live }
  }

  /** Tear down one link on both members and forget it. */
  async remove(request) {
    if (this.running.size > 0) throw new Error('another hysteria job is running; wait for it to finish')
    const serverIp = typeof request.server === 'string' ? request.server.trim() : ''
    const clientIp = typeof request.client === 'string' ? request.client.trim() : ''
    if (serverIp === '' || clientIp === '') throw new Error('server and client are required')
    const links = await this.links()
    const match = item =>
      (item.server?.ip === serverIp && item.client?.ip === clientIp)
      || (item.server?.ip === clientIp && item.client?.ip === serverIp)
    const stored = (links.links ?? []).find(match)
    if (!stored) throw new Error('that direct link is no longer stored')
    const peerList = await readWireGuardState({ file: this.stateFile })
      .then(state => state.state?.server?.peers ?? [])
      .catch(() => [])
    const errors = []
    const stopSide = async (side, role) => {
      try {
        const os = side.os === 'windows' ? 'windows' : 'linux'
        const target = await this.#sshTarget({ name: side.name, ip: side.ip }, peerList, os)
        target.os = os
        if (role === 'client') await this.#restoreClientRoute(target, stored.server.ip)
        await stopHysteria(target, role)
      } catch (error) {
        errors.push(`${side.name ?? side.ip}: ${errorMessage(error)}`)
      }
    }
    // The client goes first so its tun route stops steering traffic before the
    // server disappears underneath it.
    await stopSide(stored.client, 'client')
    await stopSide(stored.server, 'server')
    const remaining = (links.links ?? []).filter(item => !match(item))
    await writeFile(path.join(this.dataDir, 'links.json'), `${JSON.stringify({ ok: true, links: remaining }, null, 2)}\n`, 'utf8')
    this.log(`hysteria link ${stored.server.name} -> ${stored.client.name} removed`)
    return { ok: true, links: remaining, errors }
  }

  /** Drop the tun route that pointed at the hysteria client. */
  async #restoreClientRoute(target, serverIp) {
    if (target.os === 'linux') {
      await runScript(target, `ip route replace ${serverIp}/32 dev dshwg0 2>/dev/null || true`, () => {}).catch(() => {})
      return
    }
    await runScript(target, `$ErrorActionPreference='Continue'
$route=Get-NetRoute -DestinationPrefix '${serverIp}/32' -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -eq 'hysteria2' }
if ($route) { $route | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue }
`, () => {}).catch(() => {})
  }

  /** Start one link configuration job. */
  async start(request) {
    const serverId = typeof request.server === 'string' ? request.server.trim() : ''
    const clientId = typeof request.client === 'string' ? request.client.trim() : ''
    if (serverId === '' || clientId === '') throw new Error('server and client are required')
    if (serverId === clientId) throw new Error('server and client must be different members')
    const running = [...this.running.keys()]
    if (running.length > 0) throw new Error(`another hysteria job is running: ${running[0]}`)
    const snapshot = await this.snapshot()
    const all = [snapshot.local, ...(snapshot.members ?? [])].filter(Boolean)
    const server = all.find(member => member.id === serverId || member.ip === serverId)
    const client = all.find(member => member.id === clientId || member.ip === clientId)
    if (!server) throw new Error(`member not found: ${serverId}`)
    if (!client) throw new Error(`member not found: ${clientId}`)
    if (server.id === 'local' || client.id === 'local') throw new Error('both sides must be remote members; the gateway host cannot take either role')
    const port = Number.parseInt(String(request.port ?? DEFAULT_PORT), 10)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('port must be between 1 and 65535')
    const mode = request.mode === 'socks' ? 'socks' : 'tun'
    const bandwidth = Math.max(1, Math.min(200, Number.parseInt(String(request.bandwidth ?? DEFAULT_BANDWIDTH), 10) || DEFAULT_BANDWIDTH))
    const id = `hy-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    const dir = path.join(this.dataDir, id)
    await mkdir(dir, { recursive: true })
    const stateFile = path.join(dir, 'job.json')
    const logFile = path.join(dir, 'job.log')
    const state = {
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'running',
      phase: 'preflight',
      mode,
      port,
      bandwidth,
      server: { id: server.id, name: server.name, ip: server.ip, os: '', host: '' },
      client: { id: client.id, name: client.name, ip: client.ip, os: '', host: '' },
      error: null,
      warning: null,
      steps: STEPS.map(step => ({ ...step, status: 'pending', startedAt: null, finishedAt: null, detail: '' })),
      progress: { label: '准备', bytes: 0, totalBytes: 0, percent: 0, speed: 0, indeterminate: true },
    }
    this.states.set(id, state)
    await this.#save(stateFile, state)
    const task = this.#run({ state, stateFile, logFile, server, client, port, mode, bandwidth, serverHost: typeof request.serverHost === 'string' ? request.serverHost.trim() : '' })
    this.running.set(id, task)
    task.catch(() => {}).finally(() => { this.running.delete(id) })
    return { ok: true, job: state }
  }

  /** Job body. */
  async #run(context) {
    const { state, stateFile, logFile, server, client, port, mode, bandwidth } = context
    const stamp = () => new Date().toISOString()
    const log = async line => {
      const text = `[${stamp()}] ${line}\n`
      await writeFile(logFile, text, { encoding: 'utf8', flag: 'a' }).catch(() => {})
      this.log(`hysteria ${state.id}: ${line}`)
    }
    const step = key => state.steps.find(item => item.key === key)
    const mark = async (key, status, detail) => {
      const item = step(key)
      if (item) {
        item.status = status
        if (status === 'running' && item.startedAt === null) item.startedAt = stamp()
        if (status === 'succeeded' || status === 'failed') item.finishedAt = stamp()
        if (typeof detail === 'string' && detail !== '') item.detail = detail
      }
      state.updatedAt = stamp()
      await this.#save(stateFile, state)
    }
    const meter = (label, patch) => {
      state.progress = { label, bytes: 0, totalBytes: 0, percent: 0, speed: 0, indeterminate: false, ...patch }
      state.updatedAt = stamp()
      void this.#save(stateFile, state).catch(() => {})
    }
    const shutdown = async (target, role) => {
      await stopHysteria(target, role)
    }
    let serverTarget
    let clientTarget
    let certDir
    try {
      await mark('preflight', 'running')
      await log(`hysteria2 ${mode} link: ${server.name}(${server.ip}) -> ${client.name}(${client.ip}), udp/${String(port)}`)
      const stateFileJson = await readWireGuardState({ file: this.stateFile })
      const peers = stateFileJson.state?.server?.peers ?? []
      // Prefer the OS the member itself reported, then the one recorded when its
      // SSH access was configured, and only then probe over SSH.
      const peerOf = member => peers.find(candidate => candidate?.ip === member.ip) ?? null
      const recordedOs = member => {
        const platform = String(peerOf(member)?.platform ?? '').toLowerCase()
        if (platform === 'windows' || platform === 'linux') return platform
        return ''
      }
      let serverOs = memberOs(server) || recordedOs(server)
      let clientOs = memberOs(client) || recordedOs(client)
      serverTarget = await this.#sshTarget(server, peers, serverOs || 'linux')
      clientTarget = await this.#sshTarget(client, peers, clientOs || 'linux')
      const serverDiag = {}
      const clientDiag = {}
      if (serverOs === '') serverOs = await detectOs(serverTarget, serverDiag)
      if (clientOs === '') clientOs = await detectOs(clientTarget, clientDiag)
      if (serverOs === '' || clientOs === '') {
        const failures = []
        if (serverOs === '') failures.push(`${server.name}: ${serverDiag.error ?? 'no shell answered'}`)
        if (clientOs === '') failures.push(`${client.name}: ${clientDiag.error ?? 'no shell answered'}`)
        throw new Error(`cannot detect the member OS over SSH (${failures.join('; ')})`)
      }
      serverTarget.os = serverOs
      clientTarget.os = clientOs
      state.server.os = serverOs
      state.client.os = clientOs
      state.server.host = serverTarget.host
      state.client.host = clientTarget.host
      await log(`platforms: ${serverOs} / ${clientOs}`)
      const serverAsset = await this.#asset(serverOs)
      const clientAsset = await this.#asset(clientOs)
      await log(`assets: hysteria ${serverAsset.sha256.slice(0, 12)}… (${formatBytes(serverAsset.bytes)})`)
      let publicHost = context.serverHost
      if (publicHost === '') publicHost = await detectPublicHost(serverTarget, serverOs)
      if (publicHost === '') publicHost = hostFromEndpoint(peers.find(peer => peer?.ip === server.ip)?.endpoint)
      if (publicHost === '') throw new Error(`cannot determine the public address of ${server.name}; fill it in the form`)
      await log(`public endpoint: ${hostPort(publicHost, port)}`)
      const password = randomBytes(18).toString('base64url')
      certDir = await mkdtemp(path.join(tmpdir(), 'hy-cert-'))
      const cert = path.join(certDir, 'cert.pem')
      const key = path.join(certDir, 'key.pem')
      await runProcess('openssl', ['req', '-x509', '-nodes', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-keyout', key, '-out', cert, '-days', '3650', '-subj', '/CN=bing.com', '-addext', 'subjectAltName=DNS:bing.com'])
      await mark('preflight', 'succeeded', `${serverOs} → ${clientOs}, udp/${String(port)}`)

      // ── server ────────────────────────────────────────────────────────
      await mark('server', 'running')
      state.phase = 'server'
      const serverDir = serverOs === 'windows' ? 'C:\\ProgramData\\hysteria2' : '/etc/hysteria'
      const serverConf = serverOs === 'windows' ? `${serverDir}\\server.yaml` : `${serverDir}/server.yaml`
      const serverCert = serverOs === 'windows' ? `${serverDir}\\cert.pem` : `${serverDir}/cert.pem`
      const serverKey = serverOs === 'windows' ? `${serverDir}\\key.pem` : `${serverDir}/key.pem`
      const serverYaml = [
        `listen: :${String(port)}`,
        'tls:',
        `  cert: ${serverCert}`,
        `  key: ${serverKey}`,
        'auth:',
        '  type: password',
        `  password: ${password}`,
        'bandwidth:',
        '  up: 100 mbps',
        '  down: 100 mbps',
        'ignoreClientBandwidth: false',
        'quic:',
        '  disablePathMTUDiscovery: true',
        '',
      ].join('\n')
      await runScript(serverTarget, serverOs === 'linux'
        ? 'set -e\nmkdir -p /etc/hysteria\n'
        : `$ErrorActionPreference='Stop'\nNew-Item -ItemType Directory -Force 'C:\\ProgramData\\hysteria2' | Out-Null\nGet-Process hysteria -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue\n`, line => log(`[server] ${line}`))
      meter('上传服务端', { indeterminate: true })
      await uploadFile(serverTarget, serverAsset.path, serverOs === 'linux' ? '/tmp/hysteria2-server' : `${serverDir}\\hysteria.exe`, progress => meter('上传服务端', { ...progress }))
      await uploadFile(serverTarget, cert, serverCert, progress => meter('上传服务端证书', { ...progress }))
      await uploadFile(serverTarget, key, serverKey, progress => meter('上传服务端密钥', { ...progress }))
      const localServerConf = path.join(certDir, 'server.yaml')
      await writeFile(localServerConf, serverYaml, { mode: 0o600 })
      await uploadFile(serverTarget, localServerConf, serverConf, progress => meter('上传服务端配置', { ...progress }))
      await log(`server config written to ${serverConf}`)
      if (serverOs === 'linux') {
        await runScript(serverTarget, `set -e
install -m 0755 /tmp/hysteria2-server /usr/local/bin/hysteria2
cat > /etc/systemd/system/hysteria2-server.service <<'UNIT'
[Unit]
Description=hysteria2 server
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=/usr/local/bin/hysteria2 server -c /etc/hysteria/server.yaml
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable hysteria2-server.service >/dev/null 2>&1 || true
systemctl restart hysteria2-server.service
sleep 2
systemctl is-active hysteria2-server.service
`, line => log(`[server] ${line}`))
        const check = await runScript(serverTarget, `ss -lun | grep -q ':${String(port)} ' && echo LISTENING || (journalctl -u hysteria2-server -n 20 --no-pager; exit 1)`, line => log(`[server] ${line}`))
        if (!String(check.stdout).includes('LISTENING')) throw new Error('hysteria2 server is not listening')
      } else {
        await runScript(serverTarget, `$ErrorActionPreference='Stop'
$d='C:\\ProgramData\\hysteria2'
@'
@echo off
"C:\\ProgramData\\hysteria2\\hysteria.exe" server -c "C:\\ProgramData\\hysteria2\\server.yaml" >> "C:\\ProgramData\\hysteria2\\server.out" 2>> "C:\\ProgramData\\hysteria2\\server.err"
'@ | Set-Content "$d\\server.cmd" -Encoding ascii
Stop-ScheduledTask -TaskName 'hysteria2-server' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'hysteria2-server' -Confirm:$false -ErrorAction SilentlyContinue
Get-Process hysteria -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c "C:\\ProgramData\\hysteria2\\server.cmd"'
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'hysteria2-server' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName 'hysteria2-server'
Start-Sleep -Seconds 4
Get-Process hysteria -ErrorAction SilentlyContinue | Select-Object Id,Path | Format-Table -AutoSize | Out-String
`, line => log(`[server] ${line}`))
      }
      await mark('server', 'succeeded', hostPort(publicHost, port))

      // ── client ────────────────────────────────────────────────────────
      await mark('client', 'running')
      state.phase = 'client'
      const clientDir = clientOs === 'windows' ? 'C:\\ProgramData\\hysteria2' : '/etc/hysteria'
      const clientConf = clientOs === 'windows' ? `${clientDir}\\client.yaml` : `${clientDir}/client.yaml`
      const clientCert = clientOs === 'windows' ? `${clientDir}\\ca.pem` : `${clientDir}/ca.pem`
      await runScript(clientTarget, clientOs === 'linux'
        ? 'set -e\nmkdir -p /etc/hysteria\n'
        : `$ErrorActionPreference='Stop'\nNew-Item -ItemType Directory -Force 'C:\\ProgramData\\hysteria2' | Out-Null\nGet-Process hysteria -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue\n`, line => log(`[client] ${line}`))
      meter('上传客户端', { indeterminate: true })
      await uploadFile(clientTarget, clientAsset.path, clientOs === 'linux' ? '/tmp/hysteria2-client' : `${clientDir}\\hysteria.exe`, progress => meter('上传客户端', { ...progress }))
      await uploadFile(clientTarget, cert, clientCert, progress => meter('上传客户端证书', { ...progress }))

      const clientYaml = (tun) => [
        `server: ${hostPort(publicHost, port)}`,
        `auth: ${password}`,
        'tls:',
        '  sni: bing.com',
        `  ca: ${clientCert}`,
        'bandwidth:',
        `  up: ${String(bandwidth)} mbps`,
        `  down: ${String(bandwidth)} mbps`,
        'quic:',
        '  disablePathMTUDiscovery: true',
        ...(tun ? ['tun:', '  name: hysteria2', '  mtu: 1500', '  routes:', `    - ${server.ip}/32`] : []),
        'socks5:',
        '  listen: 127.0.0.1:1080',
        '',
      ].join('\n')
      const localClientConf = path.join(certDir, 'client.yaml')
      const writeClientConfig = async tun => {
        await writeFile(localClientConf, clientYaml(tun), { mode: 0o600 })
        await uploadFile(clientTarget, localClientConf, clientConf, progress => meter('上传客户端配置', { ...progress }))
      }
      const installClient = async withTun => {
        if (clientOs === 'linux') {
          await runScript(clientTarget, `set -e
install -m 0755 /tmp/hysteria2-client /usr/local/bin/hysteria2
cat > /etc/systemd/system/hysteria2-client.service <<'UNIT'
[Unit]
Description=hysteria2 client
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=/usr/local/bin/hysteria2 client -c /etc/hysteria/client.yaml
${withTun ? `ExecStartPost=-/bin/sh -c 'for i in $(seq 1 40); do ip route replace ${server.ip}/32 dev hysteria2 2>/dev/null && exit 0; sleep 0.5; done; exit 0'
ExecStopPost=-/usr/bin/ip route replace ${server.ip}/32 dev dshwg0
` : ''}Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable hysteria2-client.service >/dev/null 2>&1 || true
systemctl restart hysteria2-client.service
`, line => log(`[client] ${line}`))
        } else {
          await runScript(clientTarget, `$ErrorActionPreference='Stop'
$d='C:\\ProgramData\\hysteria2'
if (Test-Path 'C:\\Program Files\\WireGuard\\wintun.dll') { Copy-Item 'C:\\Program Files\\WireGuard\\wintun.dll' "$d\\wintun.dll" -Force }
@'
@echo off
"C:\\ProgramData\\hysteria2\\hysteria.exe" client -c "C:\\ProgramData\\hysteria2\\client.yaml" >> "C:\\ProgramData\\hysteria2\\client.out" 2>> "C:\\ProgramData\\hysteria2\\client.err"
'@ | Set-Content "$d\\client.cmd" -Encoding ascii
Stop-ScheduledTask -TaskName 'hysteria2-client' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'hysteria2-client' -Confirm:$false -ErrorAction SilentlyContinue
Get-Process hysteria -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
# The wintun adapter outlives the old process for a moment; creating a new one
# too early fails with "Cannot create a file when that file already exists".
for ($i = 0; $i -lt 30; $i++) {
  if (-not (Get-NetAdapter -Name 'hysteria2' -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 500
}
Remove-Item "$d\\client.out","$d\\client.err" -Force -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c "C:\\ProgramData\\hysteria2\\client.cmd"'
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'hysteria2-client' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName 'hysteria2-client'
${withTun ? `# Wait for the tun adapter, restarting once if it died on a stale wintun device.
$ready=$false
for ($i = 0; $i -lt 25; $i++) {
  if (Get-NetAdapter -Name 'hysteria2' -ErrorAction SilentlyContinue) { $ready=$true; break }
  if (-not (Get-Process hysteria -ErrorAction SilentlyContinue)) { Start-ScheduledTask -TaskName 'hysteria2-client' }
  Start-Sleep -Milliseconds 1000
}
Write-Output "tun-ready=$ready"` : ''}
`, line => log(`[client] ${line}`))
        }
      }
      const clientLog = clientOs === 'linux' ? 'journalctl -u hysteria2-client -n 60 --no-pager' : ''
      const clientLogFile = clientOs === 'linux' ? '/dev/null' : `${clientDir}\\client.err`
      const waitConnected = async () => {
        if (clientOs === 'linux') {
          const deadline = Date.now() + 30_000
          while (Date.now() < deadline) {
            const { stdout } = await runProcess('ssh', [...sshArgs(clientTarget), clientLog], { onLine: () => {} }).catch(() => ({ stdout: '' }))
            if (/connected to server/iu.test(stdout)) return true
            await new Promise(resolve => setTimeout(resolve, 1500))
          }
          return false
        }
        const result = await waitFor(clientTarget, clientLogFile, /connected to server/iu, 30_000)
        if (!result.ok) {
          const out = await readRemoteTail(clientTarget, `${clientDir}\\client.out`, 40).catch(() => '')
          if (/connected to server/iu.test(out)) return true
        }
        return result.ok
      }
      const testDirect = async (viaSocks) => {
        const target = `http://${hostPort(server.ip, 80)}/`
        const command = viaSocks
          ? `curl -s -o /dev/null -w '%{http_code}' --max-time 10 --socks5-hostname 127.0.0.1:1080 ${sh(target)}`
          : `curl -s -o /dev/null -w '%{http_code}' --max-time 10 ${sh(target)}`
        const { stdout } = await runProcess('ssh', [...sshArgs(clientTarget), clientOs === 'linux' ? command : `curl.exe -s -o NUL -w "%{http_code}" --max-time 10 ${viaSocks ? '--socks5-hostname 127.0.0.1:1080 ' : ''}${target}`])
        return { code: String(stdout).trim(), viaSocks }
      }

      // The hysteria tun ignores a per-address `routes` list on Windows, so the
      // gateway points the server's VPN address at the tun itself. The WireGuard
      // client owns 10.66.66.0/24, and the longer /32 prefix wins over it.
      const applyRoute = async () => {
        if (clientOs === 'linux') {
          await runProcess('ssh', [...sshArgs(clientTarget), `ip route replace ${server.ip}/32 dev hysteria2`]).catch(() => {})
          return
        }
        await runScript(clientTarget, `$ErrorActionPreference='Stop'
$idx=(Get-NetAdapter -Name 'hysteria2' -ErrorAction SilentlyContinue).ifIndex
if (-not $idx) { Write-Output 'no-tun'; exit 0 }
if (-not (Get-NetRoute -DestinationPrefix '${server.ip}/32' -InterfaceIndex $idx -ErrorAction SilentlyContinue)) {
  New-NetRoute -DestinationPrefix '${server.ip}/32' -InterfaceIndex $idx -NextHop 0.0.0.0 -RouteMetric 1 -PolicyStore ActiveStore | Out-Null
}
Write-Output 'route-ready'
`, () => {}).catch(() => {})
      }
      const restoreRoute = async () => {
        if (!clientTarget) return
        if (clientOs === 'linux') {
          await runScript(clientTarget, `ip route replace ${server.ip}/32 dev dshwg0 2>/dev/null || true`, () => {}).catch(() => {})
          return
        }
        await runScript(clientTarget, `$ErrorActionPreference='Continue'
$route=Get-NetRoute -DestinationPrefix '${server.ip}/32' -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -eq 'hysteria2' }
if ($route) { $route | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue }
`, () => {}).catch(() => {})
      }
      // TUN works when the client routes the server's VPN address through the
      // hysteria interface. An HTTP probe cannot prove that: the server member
      // may simply not listen on port 80.
      const tunRoute = async () => {
        if (clientOs === 'linux') {
          const route = await runProcess('ssh', [...sshArgs(clientTarget), `ip route get ${server.ip}`]).catch(() => ({ stdout: '' }))
          return /dev hysteria2/u.test(route.stdout)
        }
        const probe = await runProcess('ssh', [...sshArgs(clientTarget), `powershell.exe -NoProfile -Command "Get-NetRoute -DestinationPrefix '${server.ip}/32' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty InterfaceAlias"`]).catch(() => ({ stdout: '' }))
        return /hysteria/iu.test(probe.stdout)
      }
      // SSH is the one port every member is guaranteed to serve, so a TCP
      // connect to it over the tun proves the direct path actually carries data.
      const tunnelReachable = async () => {
        if (clientOs === 'linux') {
          try {
            await runProcess('ssh', [...sshArgs(clientTarget), `curl -s -m 8 -o /dev/null telnet://${server.ip}:22`])
            return true
          } catch {
            return false
          }
        }
        const { stdout } = await runProcess('ssh', [...sshArgs(clientTarget), `powershell.exe -NoProfile -Command "Test-NetConnection -ComputerName ${server.ip} -Port 22 -InformationLevel Quiet | Out-String"`]).catch(() => ({ stdout: '' }))
        return /true/iu.test(stdout)
      }
      let usedMode = mode
      let warning = null
      await writeClientConfig(mode === 'tun')
      await installClient(mode === 'tun')
      let connected = await waitConnected()
      if (mode === 'tun') {
        let routed = false
        if (connected) {
          for (let attempt = 0; attempt < 24; attempt += 1) {
            // The tun device appears a moment after the handshake, so both the
            // route insert and the check are retried together.
            await applyRoute()
            if (await tunRoute()) {
              routed = true
              break
            }
            await new Promise(resolve => setTimeout(resolve, 1000))
          }
          routed = routed && (await tunnelReachable())
        }
        if (!connected) {
          warning = 'TUN 模式未建立，已回退 SOCKS5'
          await log(warning)
          usedMode = 'socks'
          await restoreRoute()
          await writeClientConfig(false)
          await installClient(false)
          connected = await waitConnected()
        } else if (!routed) {
          warning = 'TUN 直连不通，已回退 SOCKS5'
          await log(warning)
          usedMode = 'socks'
          await restoreRoute()
          await writeClientConfig(false)
          await installClient(false)
          connected = await waitConnected()
        }
      }
      if (!connected) {
        throw new Error('hysteria2 client did not connect; check the server UDP port and firewall')
      }
      await mark('client', 'succeeded', usedMode === 'tun' ? 'TUN + SOCKS5' : 'SOCKS5')
      if (warning !== null) state.warning = warning

      // ── verify ────────────────────────────────────────────────────────
      await mark('verify', 'running')
      state.phase = 'verify'
      const test = await testDirect(usedMode === 'socks').catch(() => ({ code: '000' }))
      await log(`verify: http ${server.ip}:80 -> ${test.code} (${usedMode})`)
      if (test.code === '000') {
        await mark('verify', 'succeeded', usedMode === 'tun' ? 'hysteria 已连接，TUN 已接管；目标 80 端口未开放' : 'hysteria 已连接；目标 80 端口未开放')
      } else {
        await mark('verify', 'succeeded', `HTTP ${test.code} via ${usedMode}`)
      }
      state.mode = usedMode
      state.status = 'succeeded'
      state.phase = 'done'
      state.updatedAt = stamp()
      state.progress = { ...state.progress, percent: 100, indeterminate: false }
      await this.#save(stateFile, state)
      await log('hysteria2 link is up')
      const links = await this.links()
      const next = {
        ok: true,
        links: [
          { server: state.server, client: state.client, publicHost, port, mode: usedMode, bandwidth, updatedAt: stamp() },
          ...(links.links ?? []).filter(item => item.server?.ip !== server.ip || item.client?.ip !== client.ip),
        ],
      }
      await writeFile(path.join(this.dataDir, 'links.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8').catch(() => {})
    } catch (error) {
      state.status = 'failed'
      state.phase = 'failed'
      state.error = error instanceof Error ? error.message : String(error)
      const active = state.steps.find(item => item.status === 'running')
      if (active) {
        active.status = 'failed'
        active.finishedAt = stamp()
      }
      state.updatedAt = stamp()
      await this.#save(stateFile, state).catch(() => {})
      await log(`failed: ${state.error}`).catch(() => {})
      if (clientTarget) await restoreRoute().catch(() => {})
      if (serverTarget) await shutdown(serverTarget, 'server')
      if (clientTarget) await shutdown(clientTarget, 'client')
    } finally {
      if (certDir) await rm(certDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** Resolve one member's SSH target. */
  async #sshTarget(member, peers, os) {
    if (member.ip === '') throw new Error(`member ${member.name} has no VPN address`)
    const peer = peers.find(candidate => candidate?.ip === member.ip) ?? null
    if (peer === null) throw new Error(`member ${member.name} is not in the WireGuard peer list`)
    const user = typeof peer.sshUser === 'string' && peer.sshUser !== '' ? peer.sshUser : os === 'windows' ? 'admin' : 'root'
    let identityFile
    if (typeof peer.publicKey === 'string' && peer.publicKey !== '') {
      const digest = createHash('sha256').update(peer.publicKey).digest('hex')
      const candidate = path.join(this.home, 'wireguard', 'ssh', `${digest}.key`)
      if (existsSync(candidate)) identityFile = candidate
    }
    if (identityFile === undefined) throw new Error(`no SSH key for ${member.name}; deploy to it once to learn the key`)
    return { host: member.ip, user, port: SSH_PORT, identityFile, os }
  }

  /** Persist one job state. */
  async #save(file, state) {
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  /** Handle one `/__gate/hysteria/*` request. */
  async handle(req, res, url) {
    try {
      return await this.#handle(req, res, url)
    } catch (error) {
      if (!res.headersSent) sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return true
    }
  }

  /** Inner handler, so a thrown error becomes a JSON response. */
  async #handle(req, res, url) {
    const pathname = url.pathname
    if (!this.isAdmitted(req)) {
      sendJson(res, 401, { ok: false, error: 'login required' })
      return true
    }
    if (req.method === 'GET' && pathname === '/__gate/hysteria/jobs') {
      sendJson(res, 200, { ok: true, jobs: await this.jobs(30) })
      return true
    }
    if (req.method === 'GET' && pathname === '/__gate/hysteria/links') {
      sendJson(res, 200, await this.links())
      return true
    }
    const read = /^\/__gate\/hysteria\/jobs\/([^/]+)$/u.exec(pathname)
    if (req.method === 'GET' && read !== null) {
      const job = await this.status(read[1])
      if (job === null) {
        sendJson(res, 404, { ok: false, error: 'unknown job' })
        return true
      }
      const lines = Number.parseInt(url.searchParams.get('lines') ?? '200', 10)
      const log = await this.logs(read[1], Number.isSafeInteger(lines) ? Math.min(Math.max(lines, 1), 500) : 200)
      sendJson(res, 200, { ok: true, job, lines: log === '' ? [] : log.split('\n') })
      return true
    }
    if (req.method === 'POST' && pathname === '/__gate/hysteria/remove') {
      if (req.headers['x-dsh-gate'] !== '1') {
        sendJson(res, 403, { ok: false, error: 'missing x-dsh-gate header' })
        return true
      }
      const body = await readJson(req)
      sendJson(res, 200, await this.remove(body))
      return true
    }
    if (req.method === 'POST' && pathname === '/__gate/hysteria/configure') {
      if (req.headers['x-dsh-gate'] !== '1') {
        sendJson(res, 403, { ok: false, error: 'missing x-dsh-gate header' })
        return true
      }
      const body = await readJson(req)
      const result = await this.start(body)
      sendJson(res, 202, result)
      return true
    }
    sendJson(res, 404, { ok: false, error: 'unknown hysteria endpoint' })
    return true
  }
}

/** Stop and unregister the hysteria2 service or scheduled task for one role. */
async function stopHysteria(target, role) {
  try {
    if (target.os === 'linux') {
      await runScript(target, `systemctl stop hysteria2-${role}.service 2>/dev/null || true\nsystemctl disable hysteria2-${role}.service 2>/dev/null || true\nrm -f /etc/systemd/system/hysteria2-${role}.service\nsystemctl daemon-reload 2>/dev/null || true\n`, () => {})
      return
    }
    await runScript(target, `$ErrorActionPreference='Continue'
Stop-ScheduledTask -TaskName 'hysteria2-${role}' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'hysteria2-${role}' -Confirm:$false -ErrorAction SilentlyContinue
Get-Process hysteria -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
`, () => {})
  } catch {
    // Best effort only: the member may already be gone.
  }
}

/** Detect a target's OS over SSH. */
async function detectOs(target, diag = {}) {
  const errors = []
  try {
    const { stdout } = await runProcess('ssh', [...sshArgs(target), 'uname -s'])
    if (/linux/iu.test(stdout)) return 'linux'
    errors.push(`uname: ${stdout.trim() || 'empty'}`)
  } catch (error) {
    errors.push(`uname: ${errorMessage(error)}`)
  }
  // Windows opensshd runs the command through cmd.exe, which mangles a nested
  // bare `cmd /c ...`; the full `cmd.exe` name keeps the quoting intact.
  try {
    const { stdout } = await runProcess('ssh', [...sshArgs(target), 'cmd.exe /c ver'])
    if (/windows/iu.test(stdout)) return 'windows'
    errors.push(`ver: ${stdout.trim() || 'empty'}`)
  } catch (error) {
    errors.push(`ver: ${errorMessage(error)}`)
  }
  diag.error = errors.join(' / ').slice(0, 400)
  return ''
}

/** Ask a target for its IPv4 egress address. */
async function detectPublicHost(target, os) {
  const command = os === 'windows'
    ? 'curl.exe -4 -s -m 8 http://ifconfig.me'
    : 'curl -4 -s -m 8 http://ifconfig.me || curl -4 -s -m 8 https://ifconfig.co'
  try {
    const { stdout } = await runProcess('ssh', [...sshArgs(target), command])
    for (const token of String(stdout).split(/\s+/u)) {
      if (isIP(token) === 4) return token
    }
  } catch {
    // Fall back to the WireGuard endpoint below.
  }
  return ''
}

/** OS name of one member. */
function memberOs(member) {
  const platform = String(member.system?.platform ?? member.gate?.system?.platform ?? '').toLowerCase()
  if (platform.startsWith('win')) return 'windows'
  if (platform.startsWith('linux')) return 'linux'
  return ''
}

/** Read a bounded JSON body. */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object')
  return parsed
}

/** Write one JSON response. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}
