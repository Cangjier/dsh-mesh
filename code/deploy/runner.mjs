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
import { existsSync } from 'node:fs'
import { chmod, cp, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureSevenZipBinary, hostSevenZipPath, SEVEN_ZIP_SUFFIX } from '../shared/sevenzip.mjs'
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
function run(command, args, onLine = () => {}) {
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
 * Fetch the selected release archive on the machine running this job.
 *
 * A local (`self`) upgrade used to require a file in `~/.dsh/packages`. The
 * latest-tag source has no such file yet; download it here, in the detached
 * job, so the panel stays responsive and the progress is visible. The archive
 * is cached in `~/.dsh/packages`, which also makes it available to the
 * "target member has this package" source afterwards.
 * @param {object} context run context.
 * @returns {Promise<void>} completion.
 */
async function acquireRelease(context) {
  const { request, note, mark, meter } = context
  const settings = request.inplace ?? {}
  const acquire = settings.acquire
  const output = String(settings.package ?? '')
  if (acquire === null || typeof acquire !== 'object') throw new Error('request.inplace.acquire is missing')
  if (output === '') throw new Error('request.inplace.package is missing')
  const name = typeof acquire.name === 'string' ? acquire.name.trim() : ''
  const sha256 = typeof acquire.sha256 === 'string' ? acquire.sha256.trim().toLowerCase() : ''
  if (name === '' || name !== path.basename(name) || !/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error('request.inplace.acquire has an invalid archive or digest')
  }
  const downloader = path.join(REPOSITORY_ROOT, 'code', 'deploy', 'release-download.mjs')
  if (!existsSync(downloader)) throw new Error(`release downloader is missing: ${downloader}`)
  const args = []
  for (const entry of Array.isArray(acquire.manifests) ? acquire.manifests : []) {
    if (entry !== null && typeof entry === 'object' && typeof entry.url === 'string' && entry.url !== '') {
      const provider = entry.provider === 'gitee' ? 'gitee' : entry.provider === 'github' ? 'github' : ''
      if (provider === '') continue
      args.push(`--manifest-${provider}`, entry.url)
    } else if (typeof entry === 'string' && entry !== '') {
      args.push(/gitee\./iu.test(entry) ? '--manifest-gitee' : '--manifest-github', entry)
    }
  }
  args.push('--archive', name, '--sha256', sha256, '--output', output)
  if (acquire.prefer === 'gitee') args.push('--prefer', 'gitee')
  if (typeof acquire.proxy === 'string' && acquire.proxy !== '') args.push('--proxy', acquire.proxy)
  await mkdir(path.dirname(output), { recursive: true })
  await mark('upload', 'running')
  meter('从 latest tag 下载安装包', { percent: 0, indeterminate: true })
  await note(`downloading ${name} from the latest tag`)
  let total = Number(acquire.bytes) || 0
  let bytes = 0
  let source = ''
  try {
    await run(process.execPath, [downloader, ...args], (line) => {
      const planMatch = /^DSH-MESH-DOWNLOAD-PLAN (\d+)$/u.exec(line)
      if (planMatch !== null) {
        total = Number.parseInt(planMatch[1], 10) || total
        return
      }
      const sourceMatch = /^DSH-MESH-DOWNLOAD-SOURCE (github|gitee)$/u.exec(line)
      if (sourceMatch !== null) {
        source = sourceMatch[1] === 'gitee' ? 'Gitee' : 'GitHub'
        return
      }
      const progressMatch = /^DSH-MESH-DOWNLOAD (\d+) (\d+)$/u.exec(line)
      if (progressMatch !== null) {
        bytes = Number.parseInt(progressMatch[1], 10)
        total = Number.parseInt(progressMatch[2], 10) || total
        meter('从 latest tag 下载安装包', {
          bytes,
          totalBytes: total,
          percent: total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : 0,
          indeterminate: total <= 0,
        })
        return
      }
      if (/^DSH-MESH-DOWNLOAD-(?:MANIFEST|PART|PROGRESS|OK|DONE) /u.test(line)) return
      void note(line)
    })
  } catch (error) {
    throw new Error(`latest tag 下载失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const info = await stat(output)
  if (!info.isFile() || info.size <= 0) throw new Error(`latest tag 下载没有生成可用文件：${output}`)
  await mark('upload', 'succeeded', `${formatBytes(info.size)} · ${source === '' ? 'Release' : source} 下载`)
  meter('从 latest tag 下载安装包', { bytes: info.size, totalBytes: info.size, percent: 100, indeterminate: false })
  await note(`downloaded ${name} from ${source === '' ? 'the release' : source} (${formatBytes(info.size)})`)
}

/**
 * In-place upgrade of the machine the panel runs on.
 *
 * The local install (`<root>/dsh-mesh.json` + `releases/`) runs the same
 * `upgrade-local.mjs` as a member: the package is moved into a new release, the
 * pointer is rewritten, the units restart and a failed check rolls back. The
 * runner only mirrors that script's output into the job directory, so the panel
 * keeps showing progress while dsh-web restarts.
 * @param {object} context run context.
 * @returns {Promise<void>} completion.
 */
/**
 * Give the extracted tree the executable bits a 7z archive cannot carry.
 *
 * A package built on Windows stores no Unix mode, so `runtime/node/bin/node`
 * and every shell script arrive as 0644. The gateway's own upgrade restarts
 * the services from this tree, and a non-executable node makes the gate exit
 * with EACCES until the health check rolls the whole upgrade back.
 * @param {string} stage extraction root.
 * @returns {Promise<void>} completion.
 */
async function restoreExecutableBits(stage) {
  const fixed = [
    path.join(stage, 'dsh-mesh.mjs'),
    path.join(stage, 'runtime', 'node', 'bin', 'node'),
  ]
  const sevenDir = path.join(stage, 'code', 'gate', 'assets', '7z')
  for (const name of await readdir(sevenDir).catch(() => [])) {
    if (name.startsWith('7zz-')) fixed.push(path.join(sevenDir, name))
  }
  for (const target of fixed) await chmod(target, 0o755).catch(() => {})
  const stack = [stage]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name.endsWith('.sh')) await chmod(full, 0o755).catch(() => {})
    }
  }
}

/**
 * Recreate the node runtime's bin shims after a 7-Zip extraction.
 *
 * A 7-Zip archive created on Windows packs `runtime/node/bin/npm` and its
 * siblings as symlinks to `../lib/node_modules/...`. 7-Zip refuses to restore
 * a link whose target contains `..` and leaves an empty file behind, so the
 * three shims are relinked from the runtime layout. Only an empty file whose
 * target exists is touched.
 * @param {string} stage extraction root.
 * @param {(line: string) => Promise<void>} note log callback.
 * @returns {Promise<void>} completion.
 */
async function restoreRuntimeLinks(stage, note) {
  const bin = path.join(stage, 'runtime', 'node', 'bin')
  const modules = path.join(stage, 'runtime', 'node', 'lib', 'node_modules')
  if (!existsSync(bin) || !existsSync(modules)) return
  const links = [
    ['npm', 'npm/bin/npm-cli.js'],
    ['npx', 'npm/bin/npx-cli.js'],
    ['corepack', 'corepack/dist/corepack.js'],
  ]
  for (const [name, relative] of links) {
    const target = path.join(bin, name)
    const source = path.join(modules, relative)
    const info = await stat(target).catch(() => null)
    if (info === null || !info.isFile() || info.size !== 0 || !existsSync(source)) continue
    await rm(target, { force: true })
    await symlink(`../lib/node_modules/${relative}`, target).catch(() => {})
    await note(`restored runtime link ${name}`)
  }
}

async function runInplace(context) {
  const { jobDir, request, save, note, mark, meter } = context
  const settings = request.inplace ?? {}
  const packagePath = String(settings.package ?? '')
  if (packagePath === '') throw new Error('request.inplace.package is missing')
  if (settings.acquire !== null && typeof settings.acquire === 'object') await acquireRelease(context)
  const info = await stat(packagePath)
  if (!info.isFile()) throw new Error(`package is not a file: ${packagePath}`)
  await note(`local upgrade of ${String(settings.appRoot ?? '')} from ${path.basename(packagePath)}`)
  meter('准备本地升级', { percent: 100, indeterminate: false })
  if (settings.acquire === null || typeof settings.acquire !== 'object') {
    await mark('upload', 'succeeded', '本地部署包，无需上传')
  }

  const stage = path.join(jobDir, 'stage')
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })
  await mark('prepare', 'running')
  const sevenZipPackage = packagePath.toLowerCase().endsWith(SEVEN_ZIP_SUFFIX)
  let entries = 0
  try {
    if (sevenZipPackage) {
      const binary = await ensureSevenZipBinary(hostSevenZipPath(REPOSITORY_ROOT))
      const listed = await run(binary, ['l', '-ba', packagePath])
      entries = listed.stdout.split(/\r?\n/u).filter(line => line.trim() !== '').length
    } else {
      const counted = await run('bash', ['-c', `tar -tzf ${JSON.stringify(packagePath)} | wc -l`], line => {
        if (/^\d+$/u.test(line.trim())) entries = Number.parseInt(line.trim(), 10)
      })
      entries = Number.parseInt(counted.stdout.trim(), 10)
    }
  } catch {
    entries = 0
  }
  await note(`extracting to ${stage}${entries > 0 ? ` (${String(entries)} entries)` : ''}`)
  if (sevenZipPackage) {
    // 7-Zip keeps the package's own top-level directory; the rest of the
    // upgrade expects the tree at the stage root.
    const binary = await ensureSevenZipBinary(hostSevenZipPath(REPOSITORY_ROOT))
    meter('解压安装包', { done: 0, total: entries, percent: 0, indeterminate: entries === 0 })
    try {
      await run(binary, ['x', '-y', '-bd', `-o${stage}`, packagePath], line => note(`7z: ${line}`))
    } catch (error) {
      // 7-Zip exits with 2 when it refuses a link whose target uses '..' (the
      // node runtime's bin shims); every other entry still landed and the
      // links are recreated below.
      if (!/exited with 2\b/u.test(String(error?.message ?? ''))) throw error
      await note('7-Zip refused parent-relative links; recreating them after extraction')
    }
    const inner = (await readdir(stage)).find(name => existsSync(path.join(stage, name, 'manifest.json')))
    if (inner !== undefined) {
      for (const name of await readdir(path.join(stage, inner))) {
        await rename(path.join(stage, inner, name), path.join(stage, name))
      }
      await rm(path.join(stage, inner), { recursive: true, force: true })
    }
    await restoreRuntimeLinks(stage, note)
    await restoreExecutableBits(stage)
    meter('解压安装包', { done: entries, total: entries, percent: 100 })
  } else {
    let extracted = 0
    // `-v` prints one line per extracted entry. Counting those newlines gives
    // the real entry count; tar's --checkpoint-action=`%u` reports records
    // (10 KiB blocks), not entries, which used to show numbers far larger than
    // the archive's entry total.
    const tar = spawn('tar', ['-xzf', packagePath, '-C', stage, '--strip-components=1', '-v'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let endsWithNewline = true
    tar.stdout.on('data', chunk => {
      const text = String(chunk)
      const lines = text.split('\n')
      extracted += lines.length - 1
      endsWithNewline = text.endsWith('\n')
    })
    const tarDone = new Promise((resolve, reject) => {
      let buffer = ''
      tar.stderr.on('data', chunk => {
        buffer += String(chunk)
        const lines = buffer.split(/\r?\n/u)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim() !== '') note(`tar: ${line.trim()}`).catch(() => {})
        }
      })
      tar.once('error', reject)
      // `close`, not `exit`: it fires after stdout has been drained, so the last
      // names are counted before the final total is reported.
      tar.once('close', code => {
        if (!endsWithNewline) extracted += 1
        if (code === 0) resolve()
        else reject(new Error(`tar exited with ${String(code)}`))
      })
    })
    const ticker = setInterval(() => {
      // `-v` can also print the archive's root entry, so the running count may
      // be one above the listing count; never show more than the total.
      const done = entries > 0 ? Math.min(extracted, entries) : extracted
      const percent = entries > 0 ? Math.min(99, Math.round((done / entries) * 100)) : 0
      meter('解压安装包', { done, total: entries, percent, indeterminate: entries === 0 })
    }, 500)
    ticker.unref()
    try {
      await tarDone
    } finally {
      clearInterval(ticker)
    }
    meter('解压安装包', { done: entries, total: entries, percent: 100 })
  }
  await mark('prepare', 'succeeded', entries > 0 ? `${String(entries)} 项` : '已解压')

  // The package carries exactly one upgrade implementation.
  const source = path.join(stage, 'code', 'deploy', 'upgrade-local.mjs')
  if (!existsSync(source)) throw new Error(`upgrade script is missing: ${source}`)
  // Copy it out of the install before running: the step below replaces
  // plugins/dsh-mesh, so running the in-place file would edit it under the
  // interpreter's feet.
  const tools = path.join(jobDir, 'tools')
  await rm(tools, { recursive: true, force: true })
  await mkdir(tools, { recursive: true })
  const script = path.join(tools, 'upgrade-local.mjs')
  await cp(source, script)
  await chmod(script, 0o755)
  await mark('activate', 'running')
  meter('重启服务并检查', { percent: 99, indeterminate: true })
  const args = ['--stage', stage, '--layout-root', String(settings.appRoot ?? '')]
  // Escape hatch for validating the script against a sandbox root: copy and
  // rewire only, no service is touched.
  if (process.env.DSH_MESH_UPGRADE_NO_RESTART === '1') args.push('--no-restart')
  if (typeof settings.port === 'string' && settings.port !== '') args.push('--port', settings.port)
  if (typeof settings.interopToken === 'string' && settings.interopToken !== '') args.push('--interop-token', settings.interopToken)
  await note(`running ${path.relative(stage, script)}`)
  await run(process.execPath, [script, ...args], line => {
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
    // Write-then-rename: a reader must never see a half-written heartbeat and
    // conclude the job died.
    const body = `${JSON.stringify({
      pid: process.pid,
      ppid: process.ppid,
      host: hostname(),
      unit,
      startedAt,
      heartbeatAt: new Date().toISOString(),
    }, null, 2)}\n`
    await writeFile(`${runnerFile}.tmp`, body, 'utf8')
      .then(() => rename(`${runnerFile}.tmp`, runnerFile))
      .catch(() => {})
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
  // Upgrading *this* machine restarts dsh-web, and systemd kills the whole
  // cgroup of the unit it restarts. A runner that is not in its own transient
  // unit would be killed halfway through the copy — the worst possible state.
  // Refuse before touching anything; the panel shows this message.
  const localTarget = kind === 'inplace' || request?.options?.local === true
  const noRestart = process.env.DSH_MESH_UPGRADE_NO_RESTART === '1'
  const localWithoutIsolation = localTarget && unit === null && !noRestart
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
    if (localWithoutIsolation) {
      throw new Error('本机升级需要 systemd 临时单元保护（systemd-run 不可用或不是 root），否则重启 dsh-web 会把升级进程一起杀掉；未做任何修改，请改用成员部署或修复 systemd 后重试')
    }
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
