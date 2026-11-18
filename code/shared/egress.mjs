/**
 * Outbound HTTP proxy hosted on a member.
 *
 * A member with good access to GitHub can lend it to another machine: the
 * gateway (or a detached deploy runner) starts a small HTTP proxy *on* that
 * member, bound to its WireGuard address, and hands `http://<member-ip>:<port>`
 * to whatever needs to download. The remote side never has to install
 * anything: the script is the same Node runtime the member already runs.
 *
 * The proxy lives exactly as long as the job that started it: `close()` drops
 * the SSH channel, and the remote process exits on its next heartbeat.
 *
 * This module deliberately does not import the deploy engine: the deploy
 * engine imports it (a deploy downloads through it), and a cycle would make
 * the shipped `code/` graph unresolvable.
 *
 * @module dsh-mesh/shared/egress
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * Locate the proxy script both from `src/lib` and from the bundled `index.js`.
 * @param {string} start directory to start from.
 * @returns {string} absolute path to the script.
 */
export function resolveEgressScript(start) {
  let current = start
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(current, 'code', 'shared', 'egress-proxy.mjs')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return path.resolve(start, '..', '..', 'code', 'shared', 'egress-proxy.mjs')
}

const SCRIPT_PATH = resolveEgressScript(HERE)
const REMOTE_SCRIPT = '$HOME/.dsh/mesh/egress-proxy.mjs'
const LISTEN_TIMEOUT_MS = 20_000

/**
 * Candidate Node binaries on a member, in the order members ship them.
 * @param {string|undefined} appRoot the member's install root, when known.
 * @returns {string[]} absolute paths.
 */
function nodeCandidates(appRoot) {
  const root = String(appRoot ?? '').trim().replace(/[\\/]+$/u, '')
  return [
    '$HOME/.dsh/dsh-mesh/current/runtime/node/bin/node',
    '$HOME/.dsh/dsh-person-web/runtime/node/bin/node',
    ...(root === '' ? [] : [`${root}/runtime/node/bin/node`]),
    '/usr/local/bin/node',
    '/usr/bin/node',
  ]
}

/**
 * SSH option list for one member plan.
 * @param {{user?: string|null, port?: number, identityFile?: string|null}} plan member plan.
 * @returns {string[]} options.
 */
function sshOptions(plan) {
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', '-p', String(plan.port ?? 22)]
  if (typeof plan.identityFile === 'string' && plan.identityFile !== '') args.push('-i', plan.identityFile)
  return args
}

/**
 * Run one SSH command and collect its output.
 * @param {object} plan member plan.
 * @param {string} command remote command.
 * @param {string|undefined} input stdin.
 * @returns {Promise<{stdout: string, stderr: string, code: number|null}>} result.
 */
function sshRun(plan, command, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...sshOptions(plan), targetOf(plan), command], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', code => resolve({ stdout, stderr, code }))
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

/**
 * Build `user@host`.
 * @param {{user?: string|null, host: string}} plan member plan.
 * @returns {string} destination.
 */
function targetOf(plan) {
  return plan.user === undefined || plan.user === null || plan.user === '' ? plan.host : `${plan.user}@${plan.host}`
}

/**
 * One live proxy on one member.
 */
export class EgressProxy {
  /**
   * @param {{log?: (line: string) => void}} [options] options.
   */
  constructor(options = {}) {
    this.log = options.log ?? (() => {})
    /** @type {Set<{url: string, close: () => void}>} */
    this.live = new Set()
  }

  /** Stop every proxy this manager started. */
  closeAll() {
    for (const entry of [...this.live]) entry.close()
    this.live.clear()
  }

  /**
   * Start a proxy on one member.
   * @param {{plan: {host: string, user?: string|null, port?: number, identityFile?: string|null, appRoot?: string}, member?: string}} options target.
   * @returns {Promise<{url: string, member: string, close: () => void}>} running proxy.
   */
  async start(options) {
    const plan = { port: 22, ...options.plan }
    if (plan.host === undefined || plan.host === '') throw new Error('egress proxy needs a member address')
    await this.#install(plan)
    if (!/^[0-9a-f.:]+$/iu.test(plan.host)) throw new Error(`member address is not an IP: ${plan.host}`)
    const candidates = ['"$(command -v node 2>/dev/null || true)"', ...nodeCandidates(plan.appRoot).map(value => `"${value}"`)]
    const command = [
      'mkdir -p "$HOME/.dsh/mesh"',
      'for candidate in \\',
      ...candidates.map(value => `  ${value} \\`),
      '  ; do',
      '  if [ -n "$candidate" ] && [ -x "$candidate" ]; then',
      `    exec "$candidate" "$HOME/.dsh/mesh/egress-proxy.mjs" "${plan.host}" 0`,
      '  fi',
      'done',
      'echo "no node runtime on this member" >&2',
      'exit 3',
      '',
    ].join('\n')
    const child = spawn('ssh', [...sshOptions(plan), targetOf(plan), 'bash -s'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdin.end(command)
    const url = await this.#waitForListen(child, plan.host)
    const entry = {
      url,
      close: () => {
        this.live.delete(entry)
        try { child.kill('SIGTERM') } catch { /* already gone */ }
      },
    }
    this.live.add(entry)
    this.log(`egress proxy for ${plan.host} is ${url}`)
    return { ...entry, member: String(options.member ?? plan.host) }
  }

  /**
   * Copy the current proxy script to the member when it is missing or stale.
   * @param {object} plan member plan.
   * @returns {Promise<void>}
   */
  async #install(plan) {
    const local = await readFile(SCRIPT_PATH, 'utf8')
    const info = await stat(SCRIPT_PATH)
    const stamp = `${String(info.size)}-${String(info.mtimeMs)}`
    const check = await sshRun(plan, `test -f ${REMOTE_SCRIPT} && cat ${REMOTE_SCRIPT}`).catch(() => ({ stdout: '' }))
    if (check.stdout === local) return
    this.log(`uploading egress proxy to ${plan.host} (${stamp})`)
    await sshRun(plan, `mkdir -p "$HOME/.dsh/mesh" && cat > ${REMOTE_SCRIPT}`, local)
  }

  /**
   * Wait for the proxy's LISTEN line or an early exit.
   * @param {import('node:child_process').ChildProcess} child ssh process.
   * @param {string} host member address.
   * @returns {Promise<string>} proxy URL.
   */
  #waitForListen(child, host) {
    return new Promise((resolve, reject) => {
      let buffer = ''
      let errors = ''
      const timer = setTimeout(() => {
        cleanup()
        try { child.kill('SIGTERM') } catch { /* ignore */ }
        reject(new Error(`egress proxy on ${host} did not report its port within ${String(LISTEN_TIMEOUT_MS)}ms\n${errors.trim()}`))
      }, LISTEN_TIMEOUT_MS)
      const cleanup = () => {
        clearTimeout(timer)
        child.stdout?.off('data', onOut)
        child.stderr?.off('data', onErr)
        child.off('exit', onExit)
      }
      const onOut = (chunk) => {
        buffer += String(chunk)
        const match = /LISTEN (\d+)/u.exec(buffer)
        if (match === null) return
        cleanup()
        resolve(`http://${host}:${match[1]}`)
      }
      const onErr = (chunk) => { errors += String(chunk) }
      const onExit = (code) => {
        cleanup()
        reject(new Error(`egress proxy on ${host} exited with ${String(code)}\n${errors.trim()}`))
      }
      child.stdout?.on('data', onOut)
      child.stderr?.on('data', onErr)
      child.once('exit', onExit)
    })
  }
}
