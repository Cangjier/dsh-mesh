#!/usr/bin/env node
/**
 * Detached deployment runner.
 *
 * The panel starts one of these for every deploy or upgrade and returns the
 * job id immediately. The runner lives in its own process — and, when systemd
 * is available, in its own transient unit — so the deployment keeps going when
 * the thing it is upgrading restarts dsh-web and the gateway. Everything the
 * panel shows comes from the job directory; nothing is kept in the panel's
 * memory, so a restarted panel picks the job back up and paints it from disk.
 *
 *   node code/deploy/runner.mjs --job /root/.dsh/mesh/deploy/deploy-xxxx
 *
 * The job directory carries `request.json` (what to do) and receives
 * `job.json`, `deploy.log` and `runner.json` (heartbeat) while it runs.
 *
 * @module @local/dsh-mesh/deploy/runner
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appendDeployLog,
  DeployManager,
  initialDeploySteps,
  jobPaths,
  readDeployState,
  RUNNER_HEARTBEAT_MS,
  writeDeployState,
} from './engine.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(HERE, '..', '..')
/**
 * Read `--flag value` pairs.
 * @param {string[]} argv arguments without the node prefix.
 * @returns {Record<string, string>} values.
 */
function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) continue
    const eq = item.indexOf('=')
    if (eq !== -1) {
      values[item.slice(2, eq)] = item.slice(eq + 1)
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      values[item.slice(2)] = 'true'
      continue
    }
    values[item.slice(2)] = next
    index += 1
  }
  return values
}

/**
 * Format bytes for a log line.
 * @param {number} value bytes.
 * @returns {string} text.
 */
function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${amount >= 10 || unit === 0 ? String(Math.round(amount)) : amount.toFixed(1)} ${units[unit]}`
}

/**
 * Run one process and stream its output.
 * @param {string} command executable.
 * @param {string[]} args arguments.
 * @param {(line: string) => void} onLine stdout/stderr callback.
 * @returns {Promise<{stdout: string, stderr: string}>} captured output.
 */
function run(command, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const buffers = { out: '', err: '' }
    const emit = (key, chunk) => {
      const text = buffers[key] + String(chunk)
      const lines = text.split(/\r?\n/u)
      buffers[key] = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed !== '') onLine(trimmed)
      }
    }
    const flush = () => {
      for (const key of ['out', 'err']) {
        const trimmed = buffers[key].trim()
        if (trimmed !== '') onLine(trimmed)
        buffers[key] = ''
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
      flush()
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${path.basename(command)} exited with ${String(code)}: ${(stderr.trim() || stdout.trim()).split('\n').slice(-4).join(' ')}`))
    })
  })
}

/**
 * In-place upgrade of the machine the panel runs on.
 *
 * A flat install (`<root>/config/gate.env` next to `start.sh`, no `current`
 * symlink) cannot switch a release symlink atomically: the package's own
 * upgrade script copies the new tree over the old one, rewires the profile and
 * reinstalls the units. The runner only mirrors that script's output into the
 * job directory, so the panel keeps showing progress while dsh-web restarts.
 * @param {object} context run context.
 * @returns {Promise<void>} completion.
 */
async function runInplace(context) {
  const { jobDir, request, save, note, mark, meter } = context
  const settings = request.inplace ?? {}
  const packagePath = String(settings.package ?? '')
  if (packagePath === '') throw new Error('request.inplace.package is missing')
  const info = await stat(packagePath)
  if (!info.isFile()) throw new Error(`package is not a file: ${packagePath}`)
  await note(`local upgrade of ${String(settings.appRoot ?? '')} from ${path.basename(packagePath)}`)
  meter('准备本地升级', { percent: 100, indeterminate: false })
  await mark('upload', 'succeeded', '本地部署包，无需上传')

  const stage = path.join(jobDir, 'stage')
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })
  await mark('prepare', 'running')
  let entries = 0
  try {
    const counted = await run('bash', ['-c', `tar -tzf ${JSON.stringify(packagePath)} | wc -l`], line => {
      if (/^\d+$/u.test(line.trim())) entries = Number.parseInt(line.trim(), 10)
    })
    entries = Number.parseInt(counted.stdout.trim(), 10)
  } catch {
    entries = 0
  }
  await note(`extracting to ${stage}${entries > 0 ? ` (${String(entries)} entries)` : ''}`)
  let extracted = 0
  const tar = spawn('tar', ['-xzf', packagePath, '-C', stage, '--strip-components=1', '--checkpoint=1000', '--checkpoint-action=echo=DSH-MESH-EXTRACT %u'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  tar.stdout.resume()
  const tarDone = new Promise((resolve, reject) => {
    let buffer = ''
    tar.stderr.on('data', chunk => {
      buffer += String(chunk)
      const lines = buffer.split(/\r?\n/u)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const tick = /DSH-MESH-EXTRACT (\d+)$/u.exec(line.trim().replace(/^tar:\s*/u, ''))
        if (tick !== null) {
          extracted = Number.parseInt(tick[1], 10) * 1000
          continue
        }
        if (line.trim() !== '') note(`tar: ${line.trim()}`).catch(() => {})
      }
    })
    tar.once('error', reject)
    tar.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`tar exited with ${String(code)}`))
    })
  })
  const ticker = setInterval(() => {
    const percent = entries > 0 ? Math.min(99, Math.round((extracted / entries) * 100)) : 0
    meter('解压安装包', { done: extracted, total: entries, percent, indeterminate: entries === 0 })
  }, 500)
  ticker.unref()
  try {
    await tarDone
  } finally {
    clearInterval(ticker)
  }
  meter('解压安装包', { done: entries, total: entries, percent: 100 })
  await mark('prepare', 'succeeded', entries > 0 ? `${String(entries)} 项` : '已解压')

  const script = path.join(stage, 'code', 'deploy', 'upgrade-local.sh')
  await stat(script).catch(() => {
    throw new Error(`upgrade script is missing in the package: code/deploy/upgrade-local.sh`)
  })
  await mark('activate', 'running')
  meter('重启服务并检查', { percent: 99, indeterminate: true })
  const args = ['--app-root', String(settings.appRoot ?? ''), '--job-dir', jobDir]
  // Escape hatch for validating the script against a sandbox root: copy and
  // rewire only, no service is touched.
  if (process.env.DSH_MESH_UPGRADE_NO_RESTART === '1') args.push('--no-restart')
  if (typeof settings.dshHome === 'string' && settings.dshHome !== '') args.push('--dsh-home', settings.dshHome)
  if (typeof settings.port === 'string' && settings.port !== '') args.push('--port', settings.port)
  if (typeof settings.interopToken === 'string' && settings.interopToken !== '') args.push('--interop-token', settings.interopToken)
  await note(`running ${path.relative(stage, script)}`)
  await run('bash', [script, ...args], line => {
    if (/^DSH-MESH-EXTRACT /u.test(line)) return
    note(line).catch(() => {})
  })
  await mark('activate', 'succeeded')
  meter('重启服务并检查', { percent: 100, indeterminate: false })
  await rm(stage, { recursive: true, force: true }).catch(() => {})
  await save()
}

/**
 * Run one job to completion and persist its final state.
 * @param {string} jobDir job directory.
 * @returns {Promise<number>} process exit code.
 */
async function main(jobDir) {
  const request = JSON.parse(await readFile(path.join(jobDir, 'request.json'), 'utf8'))
  const kind = request.kind === 'inplace' ? 'inplace' : 'engine'
  const startedAt = new Date().toISOString()
  const unit = process.env.DSH_MESH_JOB_UNIT ?? null
  const runnerFile = path.join(jobDir, 'runner.json')
  const heartbeat = async () => {
    await writeFile(runnerFile, `${JSON.stringify({
      pid: process.pid,
      ppid: process.ppid,
      host: hostname(),
      unit,
      startedAt,
      heartbeatAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8').catch(() => {})
  }
  await heartbeat()
  const timer = setInterval(() => { void heartbeat() }, RUNNER_HEARTBEAT_MS)
  timer.unref()

  const state = await readDeployState(jobDir) ?? {
    id: request.id,
    createdAt: startedAt,
    updatedAt: startedAt,
    member: request.member ?? null,
    release: 'local',
    status: 'queued',
    phase: 'starting',
    error: null,
    steps: initialDeploySteps(),
    progress: {},
  }
  if (!Array.isArray(state.steps) || state.steps.length === 0) state.steps = initialDeploySteps()
  state.status = 'running'
  state.phase = 'starting'
  state.updatedAt = new Date().toISOString()

  let lastSave = 0
  const save = async (force = true) => {
    const now = Date.now()
    if (!force && now - lastSave < 300) return
    lastSave = now
    state.updatedAt = new Date().toISOString()
    await writeDeployState(jobDir, state).catch(() => {})
  }
  const note = async line => {
    await appendDeployLog(jobDir, line).catch(() => {})
  }
  const stepOf = key => state.steps.find(item => item.key === key)
  const mark = async (key, status, detail) => {
    const step = stepOf(key)
    if (step !== undefined) {
      step.status = status
      if (status === 'running' && step.startedAt === null) step.startedAt = new Date().toISOString()
      if (status === 'succeeded' || status === 'failed') step.finishedAt = new Date().toISOString()
      if (typeof detail === 'string' && detail !== '') step.detail = detail
    }
    await save()
  }
  const meter = (label, patch) => {
    state.progress = { label, percent: 0, bytes: 0, totalBytes: 0, speed: 0, done: 0, total: 0, indeterminate: false, ...patch }
    void save(false)
  }
  await save()

  let code = 0
  /** True once the engine branch has written its own terminal state. */
  let engineOwnsState = false
  try {
    if (kind === 'engine') {
      // The engine writes `deploy.log` itself; a log callback here would
      // duplicate every line.
      const manager = new DeployManager({
        repositoryRoot: REPOSITORY_ROOT,
        dataDir: path.dirname(jobDir),
      })
      const started = await manager.start({ ...request.options, id: request.id })
      const settled = await manager.wait(started.job.id)
      code = settled?.status === 'succeeded' ? 0 : 1
      // The engine owns `job.json` for an engine job: it wrote the terminal
      // state with the last meter label and the real step details. Writing our
      // copy of the queued state over it would resurrect "启动独立升级进程
      // 100%".
      engineOwnsState = true
    } else {
      await runInplace({ jobDir, request, save, note, mark, meter })
      if (code === 0) {
        state.status = 'succeeded'
        state.phase = 'done'
        state.progress = { ...(state.progress ?? {}), percent: 100, indeterminate: false }
        for (const step of state.steps) {
          if (step.status === 'running' || step.status === 'pending') {
            step.status = 'succeeded'
            step.finishedAt = step.finishedAt ?? new Date().toISOString()
          }
        }
        await note('deployment succeeded')
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Only claim the failure when the state on disk has not already been
    // settled by the engine, which knows more about the phase than we do.
    const current = engineOwnsState ? await readDeployState(jobDir) : null
    const settledElsewhere = current !== null && (current.status === 'succeeded' || current.status === 'failed')
    if (!engineOwnsState || !settledElsewhere) {
      state.status = 'failed'
      state.phase = 'failed'
      state.error = message
      const active = state.steps.find(item => item.status === 'running')
      if (active !== undefined) {
        active.status = 'failed'
        active.finishedAt = new Date().toISOString()
      }
      await save()
    }
    await note(`deployment failed: ${message}`)
    code = 1
  } finally {
    clearInterval(timer)
    // Inplace jobs (and failures) own their state: persist the terminal
    // snapshot before the heartbeat file is closed out.
    if (!engineOwnsState) await save()
    await writeFile(runnerFile, `${JSON.stringify({
      pid: process.pid,
      ppid: process.ppid,
      host: hostname(),
      unit,
      startedAt,
      heartbeatAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: code,
    }, null, 2)}\n`, 'utf8').catch(() => {})
  }
  return code
}

const args = parseArgs(process.argv.slice(2))
const jobDir = typeof args.job === 'string' && args.job !== '' ? path.resolve(args.job) : ''
if (jobDir === '') {
  process.stderr.write('usage: node code/deploy/runner.mjs --job <job directory>\n')
  process.exit(2)
}
const { dir, request: requestFile } = jobPaths(jobDir)
if (dir !== jobDir) {
  process.stderr.write(`invalid job directory: ${jobDir}\n`)
  process.exit(2)
}
await stat(requestFile).catch(() => {
  process.stderr.write(`missing ${requestFile}\n`)
  process.exit(2)
})

const stop = signal => {
  void appendDeployLog(jobDir, `runner received ${signal}; the job is left as interrupted`).finally(() => process.exit(3))
}
process.once('SIGTERM', () => stop('SIGTERM'))
process.once('SIGINT', () => stop('SIGINT'))

main(jobDir).then(code => process.exit(code)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(2)
})
