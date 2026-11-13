/**
 * Outbound build proxy hosted on a member.
 *
 * Some members have fast access to GitHub and the npm registry while the
 * gateway's own uplink is slow or unreliable. Rather than teach every download
 * about a tunnel, the gateway starts a small HTTP proxy *on* the member (the
 * member's own network does the fetching), binds it to that member's WireGuard
 * address, and points the build at `http://<member-ip>:<port>`.
 *
 * The proxy lives exactly as long as one build: it is started here, and
 * `close()` drops the SSH channel, which makes the remote process exit on its
 * next heartbeat.
 *
 * @module @local/dsh-mesh/egress
 */

import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SshRunner } from '../../code/deploy/engine.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = path.resolve(HERE, '..', '..', 'code', 'shared', 'egress-proxy.mjs')
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
   * @param {{plan: {host: string, user?: string|null, port?: number, identityFile?: string|null, appRoot?: string}, member?: object}} options target.
   * @returns {Promise<{url: string, member: string, close: () => void}>} running proxy.
   */
  async start(options) {
    const plan = { port: 22, ...options.plan }
    if (plan.host === undefined || plan.host === '') throw new Error('egress proxy needs a member address')
    const runner = new SshRunner(plan, { log: line => this.log(`egress ${plan.host}: ${line}`) })
    await this.#install(runner, plan)
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
    const child = spawn('ssh', [...runner.sshOptions(), runner.target(), 'bash -s'], {
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
    return { ...entry, member: plan.host }
  }

  /**
   * Copy the current proxy script to the member when it is missing or stale.
   * @param {SshRunner} runner ssh runner.
   * @param {{host: string}} plan plan.
   * @returns {Promise<void>}
   */
  async #install(runner, plan) {
    const local = await readFile(SCRIPT_PATH, 'utf8')
    const info = await stat(SCRIPT_PATH)
    const stamp = `${String(info.size)}-${String(info.mtimeMs)}`
    const check = await runner.runProcess('ssh', [...runner.sshOptions(), runner.target(),
      `test -f ${REMOTE_SCRIPT} && cat ${REMOTE_SCRIPT}`]).catch(() => ({ stdout: '' }))
    if (check.stdout === local) return
    this.log(`uploading egress proxy to ${plan.host} (${stamp})`)
    await runner.runProcess('ssh', [...runner.sshOptions(), runner.target(),
      `mkdir -p "$HOME/.dsh/mesh" && cat > ${REMOTE_SCRIPT}`], local)
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
