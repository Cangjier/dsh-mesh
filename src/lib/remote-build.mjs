/**
 * Build on a member instead of on the gateway.
 *
 * The panel's 编译 button has two jobs: keep the deterministic engine as the
 * only thing that produces a package, and let the machine with the best
 * internet access do the downloading. A member build therefore
 *
 *   1. updates a dsh-mesh checkout on the member (git fetch + reset --hard),
 *   2. runs the same `code/build/cli.mjs build` a human would run, streaming
 *      its output into the gateway's job log,
 *   3. reads the member-side `state.json` for the real outcome, and
 *   4. copies the finished archives into `~/.dsh/packages` on the gateway,
 *      which is what the deploy panel already lists.
 *
 * Nothing is decided by parsing the log: the log is only there to show
 * progress. The member's state file is the source of truth.
 *
 * @module @local/dsh-mesh/remote-build
 */

import { createHash } from 'node:crypto'
import { open, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { appendLog, readState, updateState } from '../../code/build/job.mjs'
import { SshRunner } from '../../code/deploy/engine.mjs'

/** Repository the member builds from. */
export const DEFAULT_MESH_REPO = 'https://github.com/Cangjier/dsh-mesh.git'

/** Where the member keeps its checkout and its build jobs. */
const REMOTE_SRC = '$HOME/.dsh/mesh/build-src'
const REMOTE_JOBS = '$HOME/.dsh/mesh/build'
const REMOTE_BIN = '$HOME/.dsh/mesh/bin'
const REMOTE_NODE_DIR = '$HOME/.dsh/dsh-mesh/current/runtime/node/bin'

/**
 * Map one build-log line to a job phase and a rough percentage.
 *
 * The engine prints stable markers (`extracting`, `$ pnpm …`, `packaged …`),
 * so the panel can show movement during an otherwise silent ten-minute step.
 * @param {string} line log line.
 * @returns {{phase: string, percent: number, status?: string}|null} update.
 */
export function phaseFromLine(line) {
  const text = String(line)
  if (text.includes('job created') || text.includes('extracting')) return { phase: 'prepare', percent: 4 }
  if (text.includes('applied ') || text.includes('skipped ')) return { phase: 'apply', percent: 12 }
  if (text.includes('needs-fix')) return { phase: 'apply', percent: 15, status: 'needs-fix' }
  if (text.includes('$ pnpm install') || text.includes('$ pnpm i')) return { phase: 'build', percent: 20 }
  if (text.includes('installing')) return { phase: 'build', percent: 25 }
  if (text.includes('$ pnpm run build:web') || text.includes('$ pnpm build')) return { phase: 'build', percent: 45 }
  if (text.includes('frontend installed') || text.includes('patching ')) return { phase: 'package', percent: 70 }
  if (text.includes('packaged ')) return { phase: 'package', percent: 85 }
  if (text.includes('build complete')) return { phase: 'done', percent: 100 }
  if (text.includes('failed:')) return { phase: 'failed', percent: 100, status: 'failed' }
  return null
}

/**
 * Build the bash script that runs one job on a member.
 *
 * The member's checkout is kept up to date by hard resetting to `origin/main`:
 * a build must reflect what is on main, not whatever a previous run left in
 * the tree. A local checkout that is behind main would otherwise silently
 * build old overlays.
 * @param {{jobId: string, ref: string, targets: string[], proxyUrl?: string|null, repoUrl?: string, heapMb?: number}} options script input.
 * @returns {string} bash script.
 */
export function remoteBuildScript(options) {
  const ref = String(options.ref)
  const targets = options.targets.join(',')
  const out = `${REMOTE_JOBS}/${options.jobId}`
  const heap = Number.isSafeInteger(options.heapMb) && options.heapMb > 0 ? options.heapMb : 2048
  const lines = [
    'set -u',
    `export PATH="${REMOTE_BIN}:${REMOTE_NODE_DIR}:$PATH"`,
    'export COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
    'export CI=1',
    `export NODE_OPTIONS="--max-old-space-size=${String(heap)}"`,
    options.proxyUrl ? `export HTTP_PROXY=${quote(options.proxyUrl)} HTTPS_PROXY=${quote(options.proxyUrl)} npm_config_proxy=${quote(options.proxyUrl)} npm_config_https_proxy=${quote(options.proxyUrl)}` : '',
    `mkdir -p ${REMOTE_BIN} ${out}`,
    `if [ ! -d "${REMOTE_SRC}/.git" ]; then`,
    `  echo "cloning ${options.repoUrl ?? DEFAULT_MESH_REPO}"`,
    `  git clone --depth 1 --branch main ${quote(options.repoUrl ?? DEFAULT_MESH_REPO)} "${REMOTE_SRC}" || { echo "mesh clone failed" >&2; exit 3; }`,
    'else',
    `  git -C "${REMOTE_SRC}" fetch --depth 1 origin main && git -C "${REMOTE_SRC}" reset --hard FETCH_HEAD || { echo "mesh update failed" >&2; exit 3; }`,
    'fi',
    'corepack enable --install-directory "$HOME/.dsh/mesh/bin" >/dev/null 2>&1 || true',
    `cd "${REMOTE_SRC}" || { echo "mesh checkout is missing" >&2; exit 3; }`,
    'echo "mesh head $(git rev-parse --short HEAD)"',
    `"${REMOTE_NODE_DIR}/node" code/build/cli.mjs build --out "${out}" --ref ${quote(ref)} --targets ${quote(targets)}${options.proxyUrl ? ` --proxy ${quote(options.proxyUrl)}` : ''}`,
    'code=$?',
    `ls -1d "${out}"/* 2>/dev/null | head -n 5`,
    'exit $code',
    '',
  ]
  return lines.filter(line => line !== '').join('\n')
}

/**
 * Single-quote a value for bash.
 * @param {string} value text.
 * @returns {string} quoted.
 */
function quote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`
}

/**
 * SHA-256 of a file.
 * @param {string} file path.
 * @returns {Promise<string>} hex digest.
 */
async function sha256File(file) {
  const hash = createHash('sha256')
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

/**
 * One member build.
 */
export class RemoteBuilder {
  /**
   * @param {{log?: (line: string) => void, packagesDir: string}} options options.
   */
  constructor(options) {
    this.log = options.log ?? (() => {})
    this.packagesDir = options.packagesDir
  }

  /**
   * Run one job on a member and settle the local job state.
   * @param {string} jobDir local job directory.
   * @param {{plan: object, memberName: string, proxyUrl?: string|null, repoUrl?: string, heapMb?: number}} options run options.
   * @returns {Promise<object>} final local state.
   */
  async run(jobDir, options) {
    const state = await readState(jobDir)
    const runner = new SshRunner({ port: 22, ...options.plan }, { log: line => this.log(`remote ${state.member ?? ''}: ${line}`) })
    const script = remoteBuildScript({
      jobId: state.id,
      ref: state.ref,
      targets: state.targets,
      proxyUrl: options.proxyUrl,
      repoUrl: options.repoUrl,
      heapMb: options.heapMb,
    })
    const onLine = (line) => {
      void appendLog(jobDir, line)
      const update = phaseFromLine(line)
      if (update !== null) void this.#progress(jobDir, update)
    }
    try {
      await runner.script(script, 'linux', onLine)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await appendLog(jobDir, `member build did not finish: ${message}`)
      return updateState(jobDir, { status: 'failed', phase: 'failed', error: message, percent: 100 })
    }
    const remote = await this.#readRemoteState(runner, state.id)
    if (remote === null) {
      const message = 'the member finished without writing a job state; see the log for its output'
      await appendLog(jobDir, message)
      return updateState(jobDir, { status: 'failed', phase: 'failed', error: message, percent: 100 })
    }
    if (remote.status !== 'done') {
      const message = typeof remote.error === 'string' && remote.error !== '' ? remote.error : `member build ended with status ${String(remote.status)}`
      await appendLog(jobDir, `member job ${String(remote.status)}: ${message}`)
      const status = remote.status === 'needs-fix' ? 'needs-fix' : 'failed'
      return updateState(jobDir, {
        status,
        phase: remote.phase ?? 'failed',
        error: status === 'failed' ? message : null,
        percent: 100,
        remoteJob: remote.id ?? null,
        remoteWorktree: remote.worktree ?? null,
        workOrder: remote.workOrder ?? null,
        mismatches: remote.mismatches ?? [],
      })
    }
    const directories = Array.isArray(remote.artifacts) ? remote.artifacts : []
    const artifacts = []
    for (const artifact of directories) {
      const archive = typeof artifact.archive === 'string' ? artifact.archive : ''
      if (archive === '') continue
      const local = await this.#pull(runner, archive)
      const info = await stat(local)
      const digest = await sha256File(local)
      await writeSidecar(local, digest)
      artifacts.push({
        target: artifact.target,
        archive: local,
        remoteArchive: archive,
        bytes: info.size,
        sha256: digest,
        manifest: artifact.manifest ?? null,
      })
      await appendLog(jobDir, `pulled ${path.basename(local)} (${String(info.size)} bytes, sha256 ${digest.slice(0, 12)}…)`)
    }
    return updateState(jobDir, {
      status: 'done',
      phase: 'done',
      percent: 100,
      artifacts,
      remoteJob: remote.id ?? null,
      version: remote.version ?? null,
    })
  }

  /**
   * Copy one remote archive into the packages directory.
   * @param {SshRunner} runner ssh runner.
   * @param {string} remote remote path.
   * @returns {Promise<string>} local path.
   */
  async #pull(runner, remote) {
    const name = path.basename(remote)
    const local = path.join(this.packagesDir, name)
    const temporary = `${local}.part`
    const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-P', String(runner.plan.port ?? 22)]
    if (runner.plan.identityFile) args.push('-i', runner.plan.identityFile)
    args.push(`${runner.target()}:${remote}`, temporary)
    await runner.runProcess('scp', args)
    await rm(local, { force: true })
    await rename(temporary, local)
    return local
  }

  /**
   * Read the member-side job state.
   * @param {SshRunner} runner ssh runner.
   * @param {string} jobId gateway job id (also the remote directory name).
   * @returns {Promise<object|null>} state.
   */
  async #readRemoteState(runner, jobId) {
    try {
      const { stdout } = await runner.runProcess('ssh', [...runner.sshOptions(), runner.target(),
        `cat "${REMOTE_JOBS}/${jobId}"/*/state.json`])
      const parsed = JSON.parse(stdout)
      if (parsed === null || typeof parsed !== 'object') return null
      return parsed
    } catch {
      return null
    }
  }

  /**
   * Record a phase change without rewriting state on every log line.
   * @param {string} jobDir job directory.
   * @param {{phase: string, percent: number, status?: string}} update update.
   * @returns {Promise<void>}
   */
  async #progress(jobDir, update) {
    const state = await readState(jobDir).catch(() => null)
    if (state === null) return
    const current = typeof state.percent === 'number' ? state.percent : 0
    if (update.percent <= current && update.status === undefined) return
    await updateState(jobDir, {
      phase: state.phase === 'failed' ? state.phase : update.phase,
      percent: Math.max(current, update.percent),
    }).catch(() => {})
  }
}

/**
 * Write `<archive>.sha256` next to a package.
 * @param {string} file archive path.
 * @param {string} digest sha-256.
 * @returns {Promise<void>}
 */
async function writeSidecar(file, digest) {
  await writeFile(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`, 'utf8')
}
