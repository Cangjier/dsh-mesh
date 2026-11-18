/**
 * Blue-green SSH deployment for dsh-mesh.
 *
 * The deployment is deliberately split into two remote phases:
 *
 *   1. prepare  — upload/extract into `releases/<release>`, point shared
 *                 config/data/home/workspace at the stable `shared` directory,
 *                 update service definitions, and validate the new tree.
 *   2. activate — switch `current` to the new release, restart services with
 *                 the gateway last, and health-check. On failure the previous
 *                 release is switched back and the services are restarted.
 *
 * The gateway is always the final service to restart: a user may be reaching
 * member A through member B's gateway, so B's gateway must survive the deploy
 * for as long as possible.
 *
 * @module @local/dsh-mesh/deploy
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { homedir, hostname, tmpdir } from 'node:os'
import path from 'node:path'

/** The prepare script emits one extraction marker per this many entries. */
const EXTRACT_CHECKPOINT = 1000

const DEFAULT_APP_ROOT = {
  linux: '/opt/dsh-mesh',
  windows: 'C:\\dsh-mesh',
}

/** Services used by the split package: DSH first, gateway last. */
const DEFAULT_SERVICES = {
  linux: [
    // The package's start.sh runs the gate, which spawns the private DSH; the
    // split services belong to the hand-installed layout, not to a package.
    { name: 'dsh-web-gate.service', role: 'gate', command: 'start.sh' },
  ],
  windows: [
    // The supervisor service owns the whole stack: it runs start-stack.ps1
    // (gate + interop) in the interactive session when it can, and in session 0
    // otherwise. The old split DSH-Web-App service duplicated the gate's own
    // DSH spawn and is removed by the deploy.
    { name: 'DSH-Mesh', role: 'gate', command: 'dsh-mesh-service.exe' },
  ],
}

const ROLE_ORDER = { control: 0, dsh: 1, gate: 2 }

/**
 * Quote one value for a POSIX shell single-quoted string.
 * @param {string} value raw value.
 * @returns {string} quoted value.
 */
function sh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Quote one value for a PowerShell single-quoted string.
 * @param {string} value raw value.
 * @returns {string} quoted value.
 */
function ps(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** Escape a value for a .NET regex replacement string. */
function psReplacement(value) {
  return ps(String(value).replace(/\$/g, '$$$$'))
}

/** Escape a value for a sed replacement that uses `|` as its delimiter. */
function sedReplacement(value) {
  return String(value).replace(/[\\|&]/g, match => `\\${match}`)
}

/**
 * Wire the packaged dsh-mesh plugin into the DSH profile so the member's own
 * DSH loads the panel. Runs on the target with its bundled Node: it copies the
 * release plugin into the profile and appends the bundle, creating the profile
 * manifest when DSH has not booted on this member yet.
 *
 * Idempotent: a second deploy replaces the copy and keeps the bundle entry.
 */
export const PROFILE_WIRE_SCRIPT = `
import fs from 'node:fs'
import path from 'node:path'
const [profileDir, pluginDir] = process.argv.slice(2)
if (typeof profileDir !== 'string' || profileDir === '' || typeof pluginDir !== 'string' || pluginDir === '') {
  console.error('profile-wire: expected <profileDir> <pluginDir>')
  process.exit(2)
}
if (!fs.existsSync(pluginDir)) {
  console.log('profile-wire: the release has no plugins/dsh-mesh; profile left untouched')
  process.exit(0)
}
const manifestFile = path.join(profileDir, 'package.json')
let manifest = {
  name: 'dsh-profile-' + path.basename(profileDir),
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
}
if (fs.existsSync(manifestFile)) {
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  } catch {
    console.error('profile-wire: ' + manifestFile + ' is not valid JSON; left untouched')
    process.exit(1)
  }
}
manifest.dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
manifest.dsh = manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh : {}
manifest.dsh.profile = manifest.dsh.profile && typeof manifest.dsh.profile === 'object' ? manifest.dsh.profile : {}
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
if (!bundles.includes('@local/dsh-mesh')) bundles.push('@local/dsh-mesh')
manifest.dsh.profile.bundles = bundles
manifest.dependencies['@local/dsh-mesh'] = 'link:./node_modules/@local/dsh-mesh'
const target = path.join(profileDir, 'node_modules', '@local', 'dsh-mesh')
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.rmSync(target, { recursive: true, force: true })
fs.cpSync(pluginDir, target, { recursive: true })
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\\n')
console.log('profile-wire: dsh loads @local/dsh-mesh from ' + target)

// Every other plugin shipped next to dsh-mesh (today: xl) is wired the same
// way: copy it into the profile, link the dependency, and add its bundle when
// the package declares one. Skipping this would leave the files in the release
// without DSH ever loading them.
const pluginsRoot = path.dirname(pluginDir)
const wired = new Set()
for (const entry of fs.readdirSync(pluginsRoot).sort()) {
  if (entry === path.basename(pluginDir)) continue
  // Backup copies (dsh-mesh.bak-20261111-1541) keep the original package
  // name; wiring one would load stale code instead of the release.
  if (entry.startsWith('.') || /[.~_]/u.test(entry)) continue
  const dir = path.join(pluginsRoot, entry)
  const manifestPath = path.join(dir, 'package.json')
  if (!fs.existsSync(manifestPath)) continue
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    console.error('profile-wire: ' + manifestPath + ' is not valid JSON; skipped')
    continue
  }
  const name = typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : entry
  if (path.basename(name) !== entry || wired.has(name)) continue
  wired.add(name)
  const parts = name.split('/')
  const linkTarget = path.join(profileDir, 'node_modules', ...parts)
  fs.mkdirSync(path.dirname(linkTarget), { recursive: true })
  fs.rmSync(linkTarget, { recursive: true, force: true })
  fs.cpSync(dir, linkTarget, { recursive: true })
  manifest.dependencies[name] = 'link:./node_modules/' + name
  const isBundle = pkg.dsh && typeof pkg.dsh === 'object' && pkg.dsh.bundle
  if (isBundle && !bundles.includes(name)) bundles.push(name)
  console.log('profile-wire: dsh loads ' + name + ' from ' + linkTarget)
}
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\\n')

// The member inherits the deployer's account grants, but a fresh profile still
// defaults to the API-key route and then fails with MISSING_CREDENTIAL. Point
// its default model at the same provider route the deployer uses.
const [providerArg, modelArg, effortArg] = process.argv.slice(4)
if (typeof providerArg === 'string' && providerArg !== '') {
  const pairs = [['provider', providerArg], ['model', modelArg || ''], ['reasoningEffort', effortArg || '']]
    .filter(pair => pair[1] !== '')
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  const before = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : ''
  const after = mergeModelRoute(before, pairs)
  fs.writeFileSync(patchFile, after)
  console.log('profile-wire: agent-default-model ' + pairs.map(pair => pair[0] + '=' + pair[1]).join(' '))
}

function mergeModelRoute(text, pairs) {
  const trailing = text === '' || text.endsWith('\\n') ? '' : '\\n'
  const lines = text.split('\\n')
  const scalar = value => (/^[A-Za-z0-9._-]+$/.test(value) ? value : JSON.stringify(value))
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === '- id: agent-default-model') {
      start = index
      break
    }
  }
  if (start === -1) {
    const block = ['- id: agent-default-model', '  name: "@deepseek-ai/dsh-agent-default-model"', '  config:']
    for (const [key, value] of pairs) block.push('    ' + key + ': ' + scalar(value))
    const body = lines.filter(line => line !== '').join('\\n')
    return (body === '' ? '' : body + '\\n') + block.join('\\n') + '\\n'
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('- ')) {
      end = index
      break
    }
  }
  const block = lines.slice(start, end)
  let configAt = -1
  for (let index = 0; index < block.length; index += 1) {
    if (block[index].trim() === 'config:') {
      configAt = index
      break
    }
  }
  if (configAt === -1) {
    block.push('  config:')
    configAt = block.length - 1
  }
  for (const [key, value] of pairs) {
    const at = block.findIndex(line => line.startsWith('    ' + key + ':'))
    if (at !== -1) {
      block[at] = '    ' + key + ': ' + scalar(value)
      continue
    }
    // Append after the last existing key so the block keeps a natural order.
    let insertAt = configAt + 1
    for (let index = block.length - 1; index > configAt; index -= 1) {
      if (block[index].startsWith('    ') && block[index].trim() !== '') {
        insertAt = index + 1
        break
      }
    }
    block.splice(insertAt, 0, '    ' + key + ': ' + scalar(value))
  }
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\\n') + trailing
}
`

/**
 * The model route the deployer uses (`provider`, `model`, `reasoningEffort`).
 *
 * A member gets the deployer's account grants, but a fresh profile still
 * defaults to the API-key provider route, so the first conversation there
 * fails with `MISSING_CREDENTIAL`. Mirroring this entry makes the member call
 * the same route — for an account provider that is exactly the shared login.
 *
 * @returns {{provider: string, model?: string, reasoningEffort?: string}|null} route or null.
 */
export function deployerModelRoute() {
  if (process.env.DSH_DEPLOY_SYNC_MODEL === '0') return null
  const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : path.join(homedir(), '.dsh')
  const file = path.join(home, 'profiles', 'web', 'cordis.patch.yml')
  if (!existsSync(file)) return null
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const lines = text.split('\n')
  const start = lines.findIndex(line => /^- id:\s*agent-default-model\s*$/u.test(line))
  if (start === -1) return null
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^- /u.test(lines[index])) {
      end = index
      break
    }
  }
  const block = lines.slice(start, end)
  const read = key => {
    const line = block.find(candidate => new RegExp(`^\\s+${key}:`, 'u').test(candidate))
    if (line === undefined) return undefined
    let value = line.slice(line.indexOf(':') + 1).trim()
    const hash = value.indexOf(' #')
    if (hash !== -1) value = value.slice(0, hash).trim()
    value = value.replace(/^(["'])(.*)\1$/u, '$2')
    return value === '' ? undefined : value
  }
  const provider = read('provider')
  if (provider === undefined) return null
  return { provider, model: read('model'), reasoningEffort: read('reasoningEffort') }
}

/**
 * The deployer's DSH credentials file, or null when this host has no account.
 * @returns {string|null} absolute path.
 */
export function deployerCredentialsFile() {
  if (process.env.DSH_DEPLOY_SHARE_ACCOUNT === '0') return null
  const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : path.join(homedir(), '.dsh')
  const file = path.join(home, '.credentials.yaml')
  return existsSync(file) ? file : null
}

/** Human-readable byte count for progress details. */
export function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let amount = bytes
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${amount >= 10 || unit === 0 ? String(Math.round(amount)) : amount.toFixed(1)} ${units[unit]}`
}

/** Add an actionable hint when SSH refused a changed host key. */
export function describeDeployFailure(message) {
  const text = String(message ?? '')
  if (!/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/iu.test(text)) return text
  return `${text}

SSH 主机密钥与 known_hosts 中的记录不一致：目标机可能重装过系统，或这个 VPN 地址已经属于另一台机器。请在 WireGuard 面板对该成员重新执行一次「SSH 授权」（生成命令时会同时刷新本机 known_hosts），或者手动执行 ssh-keygen -R <目标地址> 后重试。`
}

/** Deployment steps reported by the panel while a job runs. */
export function initialDeploySteps(options = {}) {
  const steps = [
    { key: 'upload', label: '上传安装包', status: 'pending', startedAt: null, finishedAt: null, detail: '', progress: null },
  ]
  // The rehearsal is a bash script for a flat Linux install; a Windows member
  // has no flat layout to rehearse, so its test upgrade is the normal upgrade.
  if (options.test === true && options.os !== 'windows') {
    // The rehearsal runs before prepare: prepare rewrites the member's live
    // profile and gate.env, and a bad package must fail before that.
    steps.push({ key: 'rehearse', label: '平铺流程演练（沙箱）', status: 'pending', startedAt: null, finishedAt: null, detail: '', progress: null })
  }
  steps.push({ key: 'prepare', label: '解压并准备新版本', status: 'pending', startedAt: null, finishedAt: null, detail: '', progress: null })
  steps.push({ key: 'activate', label: '切换并重启服务', status: 'pending', startedAt: null, finishedAt: null, detail: '', progress: null })
  return steps
}

/** A job whose runner has not written its heartbeat yet still counts as alive. */
export const RUNNER_START_GRACE_MS = 45_000
/** A runner that stops heartbeating for this long is gone. */
export const RUNNER_STALE_MS = 120_000
/** How often the detached runner rewrites `runner.json`. */
export const RUNNER_HEARTBEAT_MS = 5_000

/** @returns {string} fresh deployment job id. */
export function newJobId() {
  return `deploy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Paths owned by one job directory.
 *
 * A job is a directory with four files; every process that touches it (the
 * panel, the detached runner, the CLI) reads the same ones.
 * @param {string} dir job directory.
 * @returns {{dir: string, state: string, log: string, runner: string, request: string}} paths.
 */
export function jobPaths(dir) {
  return {
    dir,
    state: path.join(dir, 'job.json'),
    log: path.join(dir, 'deploy.log'),
    runner: path.join(dir, 'runner.json'),
    request: path.join(dir, 'request.json'),
  }
}

/**
 * Write one job state atomically.
 *
 * The panel and the runner are separate processes: a reader must never see a
 * half-written `job.json`, so the text lands in a sibling temp file and is
 * renamed over the target.
 * @param {string} dir job directory.
 * @param {object} state job state.
 * @returns {Promise<void>} completion.
 */
export async function writeDeployState(dir, state) {
  const file = path.join(dir, 'job.json')
  const tmp = `${file}.${process.pid}.tmp`
  await mkdir(dir, { recursive: true })
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/**
 * Read one job state, or null when it is missing or unreadable.
 * @param {string} dir job directory.
 * @returns {Promise<object|null>} state.
 */
export async function readDeployState(dir) {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, 'job.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Append one line to a job log.
 * @param {string} dir job directory.
 * @param {string} line text.
 * @returns {Promise<void>} completion.
 */
export async function appendDeployLog(dir, line) {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'deploy.log'), `[${new Date().toISOString()}] ${line}\n`, { encoding: 'utf8', flag: 'a' })
}

/**
 * Is the detached runner that owns this job still working?
 *
 * A job started by another process (the runner is spawned detached so it
 * survives a dsh-web/gate restart) is only "running" while that process lives.
 * Same-host jobs are checked by pid; a job directory copied from another host
 * falls back to the heartbeat timestamp.
 * @param {string} dir job directory.
 * @returns {Promise<{alive: boolean, runner: object|null}>} verdict.
 */
export async function runnerStatus(dir) {
  // The runner rewrites runner.json on every heartbeat. A plain truncate+write
  // could be read back half-written, which would read as "no runner" and make
  // a healthy job look dead — so the writer renames into place and this reader
  // retries once before drawing that conclusion.
  const file = path.join(dir, 'runner.json')
  let runner = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      runner = JSON.parse(await readFile(file, 'utf8'))
      break
    } catch {
      runner = null
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  if (runner === null || typeof runner !== 'object') return { alive: false, runner: null }
  const pid = Number(runner.pid)
  if (runner.host === hostname() && Number.isInteger(pid) && pid > 0) {
    // Same host: the pid is the best evidence, and it is immediate. A pid that
    // is gone means the job is gone, even if its last heartbeat is seconds old.
    try {
      process.kill(pid, 0)
      return { alive: true, runner }
    } catch (error) {
      return { alive: error?.code === 'EPERM', runner }
    }
  }
  // Another host (a copied job directory): only the heartbeat can tell.
  const beat = Date.parse(String(runner.heartbeatAt ?? runner.startedAt ?? ''))
  if (Number.isFinite(beat) && Date.now() - beat < RUNNER_STALE_MS) return { alive: true, runner }
  return { alive: false, runner }
}

/** Encode a PowerShell script that copies stdin to one file (Windows upload). */
function windowsStdinWriter(remote) {
  const script = `$ErrorActionPreference = 'Stop'
$stdin = [Console]::OpenStandardInput()
$file = [IO.File]::Open(${ps(remote)}, [IO.FileMode]::Create)
try { $stdin.CopyTo($file) } finally { $file.Dispose() }`
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * Hash a file without loading it into memory.
 * @param {string} file path.
 * @returns {Promise<string>} hex sha256.
 */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', chunk => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Normalize a target OS name.
 * @param {string} value raw os.
 * @returns {'linux'|'windows'} canonical OS.
 */
export function normalizeOs(value) {
  const text = String(value ?? '').toLowerCase()
  if (text === 'linux' || text === 'win' || text === 'windows') {
    return text.startsWith('win') ? 'windows' : 'linux'
  }
  throw new Error('os must be "linux" or "windows"')
}

/**
 * Strip a release symlink from an install root.
 *
 * A healthy member reports the release it is running from (`<root>/current`),
 * and the unit's WorkingDirectory is that symlink too. Every deployment path
 * needs the stable root instead: it is the directory that owns `releases/` and
 * `shared/`, and pointing a deploy at `current` would nest a second install.
 * @param {string} value reported root.
 * @returns {string} stable install root ('' when empty).
 */
export function normalizeInstallRoot(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  return text.replace(/[\\/]+current$/iu, '').replace(/[\\/]+$/u, '')
}

/**
 * Infer a service role from its name.
 * @param {string} name service/unit name.
 * @returns {'control'|'dsh'|'gate'} role.
 */
function inferRole(name) {
  const text = String(name).toLowerCase()
  if (text.includes('wireguard') || text.includes('wg-') || text.includes('control')) return 'control'
  if (text.includes('gate')) return 'gate'
  return 'dsh'
}

/**
 * Validate and order services: control, DSH, then the gateway last.
 * @param {Array<string|{name:string,role?:string,command?:string}>|undefined} input services.
 * @param {'linux'|'windows'} os target OS.
 * @returns {Array<{name:string,role:'control'|'dsh'|'gate',command:string}>} ordered services.
 */
export function normalizeServices(input, os) {
  const source = input === undefined ? DEFAULT_SERVICES[os] : input
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error('at least one service is required')
  }
  const seen = new Set()
  const services = source.map((entry, index) => {
    const raw = typeof entry === 'string' ? { name: entry } : entry
    if (raw === null || typeof raw !== 'object' || typeof raw.name !== 'string' || raw.name.trim() === '') {
      throw new Error(`service #${String(index + 1)} needs a name`)
    }
    const name = raw.name.trim()
    if (seen.has(name)) throw new Error(`duplicate service ${name}`)
    seen.add(name)
    const role = raw.role ?? inferRole(name)
    if (!(role in ROLE_ORDER)) throw new Error(`service ${name} has unknown role ${String(role)}`)
    const command = typeof raw.command === 'string' && raw.command.trim() !== ''
      ? raw.command.trim()
      : os === 'linux' ? 'start.sh' : 'dsh-mesh-service.exe'
    return { name, role, command }
  })
  if (!services.some(service => service.role === 'gate')) {
    throw new Error('the service list must include one gateway service (role "gate")')
  }
  if (services.filter(service => service.role === 'gate').length > 1) {
    throw new Error('the service list must include exactly one gateway service')
  }
  services.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role])
  if (services[services.length - 1].role !== 'gate') {
    throw new Error('the gateway must be the last service to restart')
  }
  return services
}

/**
 * Find the newest matching package in `dist` when the caller omits a path.
 * @param {string} repositoryRoot package root.
 * @param {'linux'|'windows'} os target OS.
 * @returns {Promise<string>} archive path.
 */
export async function findLatestPackage(repositoryRoot, os) {
  const dist = path.join(repositoryRoot, 'dist')
  const suffix = os === 'linux' ? '.tar.gz' : '.zip'
  const prefix = `dsh-mesh-`
  const marker = `-${os === 'linux' ? 'linux' : 'win'}-x64`
  const entries = await readdir(dist).catch(() => [])
  const candidates = []
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(suffix) || !entry.includes(marker)) continue
    const file = path.join(dist, entry)
    const info = await stat(file).catch(() => null)
    if (info?.isFile()) candidates.push({ file, mtimeMs: info.mtimeMs })
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (candidates.length === 0) {
    throw new Error(`no ${os} package found in ${dist}; build one or pass --package`)
  }
  return candidates[0].file
}

/**
 * Build the immutable deployment plan.
 * @param {object} options deployment input.
 * @param {string} options.host SSH host.
 * @param {string} [options.user] SSH user.
 * @param {number} [options.port] SSH port.
 * @param {string} [options.identityFile] private key.
 * @param {'linux'|'windows'} [options.os] target OS.
 * @param {string} [options.package] local archive.
 * @param {string} [options.appRoot] stable application root.
 * @param {string} [options.release] release id.
 * @param {Array} [options.services] service manifest.
 * @param {'all'|'dsh'} [options.scope] which services to restart.
 * @param {string} [options.gatePort] health-check port.
 * @param {string} [options.repositoryRoot] package root.
 * @param {boolean} [options.sudo] use sudo on Linux.
 * @returns {Promise<object>} plan.
 */
export async function buildDeployPlan(options) {
  if (typeof options.host !== 'string' || options.host.trim() === '') throw new Error('host is required')
  const os = normalizeOs(options.os ?? 'linux')
  const repositoryRoot = options.repositoryRoot ?? process.cwd()
  let packagePath = ''
  let packageInfo = null
  let sha256 = ''
  if (options.skipPackage !== true) {
    packagePath = options.package
      ? path.resolve(options.package)
      : await findLatestPackage(repositoryRoot, os)
    packageInfo = await stat(packagePath)
    if (!packageInfo.isFile()) throw new Error(`package is not a file: ${packagePath}`)
    sha256 = await hashFile(packagePath)
  }
  const release = options.skipPackage === true
    ? 'rollback'
    : typeof options.release === 'string' && options.release.trim() !== ''
      ? options.release.trim()
      : `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${sha256.slice(0, 8)}`
  if (!/^[A-Za-z0-9._-]{3,80}$/.test(release)) {
    throw new Error('release must be 3-80 chars of letters, digits, dot, underscore or dash')
  }
  const appRoot = normalizeInstallRoot(options.appRoot) || DEFAULT_APP_ROOT[os]
  const services = normalizeServices(options.services, os)
  const scope = options.scope === 'dsh' ? 'dsh' : 'all'
  const gatePort = String(options.gatePort ?? '80')
  if (!/^\d{1,5}$/.test(gatePort) || Number(gatePort) > 65535) throw new Error('gatePort is invalid')
  const retention = Number.isSafeInteger(options.retention) ? options.retention : 3
  if (retention < 2) throw new Error('retention must be at least 2 (current plus previous)')
  const llm = options.llm === false ? null : deployerModelRoute()
  const vpnAddress = isIP(String(options.host ?? '').trim()) === 0 ? '0.0.0.0' : String(options.host).trim()
  const interop = {
    port: Number.isSafeInteger(options.interopPort) ? options.interopPort : 8765,
    // Only the VPN address: the token is the gateway password, so the service
    // must not be reachable from the member's public interface.
    bind: vpnAddress,
    provider: llm?.provider ?? 'deepseek-account',
    model: llm?.model ?? 'deepseek-flash',
  }
  const serviceUser = typeof options.serviceUser === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/u.test(options.serviceUser.trim())
    ? options.serviceUser.trim()
    : undefined
  return {
    host: options.host.trim(),
    // The local host runs the same phases without SSH: the gateway upgrading
    // itself must not depend on its own sshd being reachable.
    local: options.local === true,
    // Copied from the deployer so every member shares one gateway password;
    // empty means "generate on the target".
    gatePassword: typeof options.gatePassword === 'string' ? options.gatePassword : '',
    user: typeof options.user === 'string' && options.user.trim() !== '' ? options.user.trim() : undefined,
    port: Number.isSafeInteger(options.port) ? options.port : 22,
    identityFile: typeof options.identityFile === 'string' && options.identityFile.trim() !== ''
      ? path.resolve(options.identityFile)
      : undefined,
    os,
    package: { path: packagePath, bytes: packageInfo?.size ?? 0, sha256 },
    release,
    appRoot,
    serviceUser,
    shared: `${appRoot}${os === 'linux' ? '/shared' : '\\shared'}`,
    current: `${appRoot}${os === 'linux' ? '/current' : '\\current'}`,
    previous: `${appRoot}${os === 'linux' ? '/previous' : '\\previous'}`,
    releases: `${appRoot}${os === 'linux' ? '/releases' : '\\releases'}`,
    services,
    scope,
    gatePort,
    retention,
    sudo: options.sudo !== false,
    // BBR + fq on the member: the one step that makes a high-latency, lossy
    // mesh link usable. Set DSH_DEPLOY_NET_TUNE=0 to leave the host alone.
    tuneNetwork: options.tuneNetwork !== false && process.env.DSH_DEPLOY_NET_TUNE !== '0',
    // The provider route the member's agent should use. Without it a fresh
    // profile falls back to the API-key route and cannot spend the deployer's
    // shared login. Set DSH_DEPLOY_SYNC_MODEL=0 to leave the member's own.
    llm,
    // The interop service is what lets other members drive a conversation here
    // (call_member, the panel's conversation list), so the deploy installs and
    // starts it instead of leaving it to a manual script.
    interop: options.interop === false || process.env.DSH_DEPLOY_INTEROP === '0' ? null : interop,
    // Named by content, not by release, so a retried deploy of the same package
    // reuses the upload instead of pushing hundreds of megabytes again.
    remotePackage: os === 'linux'
      ? `/tmp/dsh-mesh-${sha256.slice(0, 12)}${path.extname(packagePath)}`
      : `C:\\Windows\\Temp\\dsh-mesh-${sha256.slice(0, 12)}${path.extname(packagePath)}`,
    // A test upgrade rehearses the *flat* upgrade (the path the gateway uses
    // on itself) in a sandbox on the member before touching it, then runs the
    // normal blue-green upgrade. Without this a member test proves nothing
    // about the local path.
    test: options.test === true,
    // The deployer's account grants travel with the deploy so a fresh member
    // needs no QR scan of its own.
    remoteCredentials: os === 'linux'
      ? `/tmp/dsh-mesh-${sha256.slice(0, 12)}.account`
      : `C:\\Windows\\Temp\\dsh-mesh-${sha256.slice(0, 12)}.account`,
  }
}

/**
 * Read the member's existing install root and service user.
 *
 * A member may have been installed by root under `/root/.dsh`, by a normal
 * user under `/home/<user>/.dsh`, or anywhere else. The systemd unit (or the
 * Windows service) is the source of truth; only when it cannot be read does
 * this fall back to the SSH user's home.
 *
 * @param {{host:string,user?:string,port?:number,identityFile?:string,os?:string}} options target.
 * @returns {Promise<{appRoot:string,serviceUser:string|undefined}>} detected install.
 */
export async function probeTarget(options) {
  if (typeof options.host !== 'string' || options.host.trim() === '') throw new Error('host is required')
  const os = normalizeOs(options.os ?? 'linux')
  const user = typeof options.user === 'string' && options.user.trim() !== '' ? options.user.trim() : undefined
  const plan = {
    host: options.host.trim(),
    user,
    port: Number.isSafeInteger(options.port) ? options.port : 22,
    identityFile: typeof options.identityFile === 'string' && options.identityFile.trim() !== ''
      ? path.resolve(options.identityFile)
      : undefined,
    os,
  }
  const runner = new SshRunner(plan)
  if (os === 'windows') {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$svc = Get-CimInstance Win32_Service -Filter \"Name='DSH-Mesh'\"",
      "$root = ''",
      'if ($svc -and $svc.PathName) {',
      '  if ($svc.PathName -match \'^"([^"]+)"\') { $exe = $matches[1] } else { $exe = ($svc.PathName -split \' \')[0] }',
      '  $root = Split-Path -Parent $exe',
      '}',
      'if (-not $root) { $root = Join-Path $env:USERPROFILE \'.dsh\\dsh-mesh\' }',
      '$root = $root -replace \'(?i)\\\\current$\', \'\'',
      'Write-Output $root',
      'Write-Output $env:USERNAME',
    ].join('\n')
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const { stdout } = await runner.runProcess('ssh', [
      ...runner.sshOptions(),
      runner.target(),
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
    ])
    const [root = ''] = stdout.split(/\r?\n/u)
    const appRoot = normalizeInstallRoot(root) !== ''
      ? normalizeInstallRoot(root)
      : `C:\\Users\\${user ?? 'Public'}\\.dsh\\dsh-mesh`
    return { appRoot, serviceUser: undefined }
  }
  const script = `#!/usr/bin/env bash
set -u
root=''
runuser=''
for unit in dsh-web-gate.service dsh-web.service dsh-mesh.service; do
  if command -v systemctl >/dev/null 2>&1; then
    root=$(systemctl show "$unit" -p WorkingDirectory --value 2>/dev/null || true)
  fi
  if [ -n "$root" ]; then
    runuser=$(systemctl show "$unit" -p User --value 2>/dev/null || true)
    break
  fi
done
if [ -z "$root" ]; then
  root="\${HOME:-/root}/.dsh/dsh-mesh"
fi
case "$root" in
  */current) root=$(dirname "$root") ;;
esac
printf '%s\\n%s\\n' "$root" "$runuser"
`
  const { stdout } = await runner.runProcess('ssh', [
    ...runner.sshOptions(),
    runner.target(),
    'bash -s',
  ], script)
  const [root = '', serviceUser = ''] = stdout.split(/\r?\n/u)
  const fallback = user !== undefined && user !== 'root'
    ? `/home/${user}/.dsh/dsh-mesh`
    : '/root/.dsh/dsh-mesh'
  return {
    appRoot: root.trim() !== '' ? root.trim() : fallback,
    serviceUser: serviceUser.trim() !== '' ? serviceUser.trim() : undefined,
  }
}

/**
 * Build the Linux prepare script.
 * @param {object} plan deployment plan.
 * @returns {string} shell script.
 */
export function buildLinuxPrepareScript(plan) {
  const serviceBlocks = plan.services.map(service => {
    const unit = sh(service.name)
    const command = service.command.startsWith('/') ? service.command : `${plan.appRoot}/current/${service.command}`
    return `write_unit ${unit} ${sh(command)}`
  }).join('\n')
  // Files created by the sudo prepare belong to the user the existing unit
  // runs as; otherwise a per-user member gets a root-owned tree.
  const chown = plan.serviceUser === undefined || plan.serviceUser === 'root'
    ? ''
    : `chown -R ${sh(`${plan.serviceUser}:`)} "$APP_ROOT" 2>/dev/null || true\n`
  // Peers are often continents apart: 150 ms RTT with a few percent loss is
  // enough for cubic to collapse to a few hundred Kbps, while BBR keeps the
  // same link above 10 Mbps. Idempotent, non-fatal, and skipped when the
  // kernel has no bbr module.
  // provider/model/reasoningEffort travel as extra argv so the member's agent
  // calls the same route the deployer does (an account route needs no API key).
  const llmArgs = plan.llm === null || plan.llm === undefined
    ? ''
    : `${[plan.llm.provider, plan.llm.model ?? '', plan.llm.reasoningEffort ?? ''].map(value => sh(value)).join(' ')} `
  const netTune = plan.tuneNetwork === false
    ? ''
    : `if command -v sysctl >/dev/null 2>&1; then
  mkdir -p /etc/sysctl.d
  modprobe tcp_bbr 2>/dev/null || true
  modprobe sch_fq 2>/dev/null || true
  if grep -qw bbr /proc/sys/net/ipv4/tcp_available_congestion_control 2>/dev/null; then
    printf '%s\\n' 'net.core.default_qdisc=fq' 'net.ipv4.tcp_congestion_control=bbr' > /etc/sysctl.d/99-dsh-mesh-net.conf
    sysctl --system >/dev/null 2>&1 || true
    echo 'network tuning: bbr + fq enabled'
  else
    echo 'network tuning: bbr unavailable on this kernel, skipped'
  fi
fi
`
  // A member that only joined the mesh has no boot persistence: `wg-quick` was
  // brought up by hand, so after a reboot it comes back without a tunnel and
  // the whole mesh sees it as offline. The config is ours, so enable the unit
  // (enable only — the live interface must survive the deploy).
  const wgPersist = plan.os === 'linux'
    ? `for conf in /etc/wireguard/*.conf; do
  [ -f "$conf" ] || continue
  grep -q '^# Managed by the dsh-wireguard client bootstrap' "$conf" || continue
  iface=$(basename "$conf" .conf)
  systemctl enable "wg-quick@$iface" >/dev/null 2>&1 || true
  echo "wg-quick@$iface enabled for boot"
done
`
    : ''
  return `#!/usr/bin/env bash
set -euo pipefail
APP_ROOT=${sh(plan.appRoot)}
RELEASE=${sh(plan.release)}
PACKAGE=${sh(plan.remotePackage)}
NEW="$APP_ROOT/releases/$RELEASE"
SHARED="$APP_ROOT/shared"
CURRENT="$APP_ROOT/current"
PREVIOUS="$APP_ROOT/previous"
mkdir -p "$APP_ROOT/releases" "$SHARED"
# A failed prepare or activate can leave a whole release tree behind (about
# 1.3 GB each). Keep only the running release and the rollback target; $NEW
# does not exist yet unless this is a retry, and that case is refused below.
CURRENT_REAL=$(readlink -f "$CURRENT" 2>/dev/null || true)
PREVIOUS_REAL=$(readlink -f "$PREVIOUS" 2>/dev/null || true)
for old in "$APP_ROOT"/releases/*; do
  [ -d "$old" ] || continue
  if [ "$old" = "$CURRENT_REAL" ] || [ "$old" = "$PREVIOUS_REAL" ] || [ "$old" = "$NEW" ]; then
    continue
  fi
  rm -rf "$old" 2>/dev/null || true
done
if [ -e "$NEW" ]; then
  echo "release already exists: $NEW" >&2
  exit 1
fi
mkdir -p "$NEW"
# One marker per ${String(EXTRACT_CHECKPOINT)} extracted entries: the deploy engine turns
# these into the panel's extraction progress. Counting first costs a gzip pass
# but gives an honest denominator; printing every path would flood the job log
# with 78k lines.
#
# Do not use tar's --checkpoint-action here: %u is the number of 10 KiB records
# read, not entries, so multiplying it by the checkpoint interval produced
# numbers far larger than the archive's entry count (and a bar stuck at 99%).
printf 'DSH-MESH-EXTRACT-TOTAL %s\n' "$(tar -tzf "$PACKAGE" | wc -l | tr -d ' ')"
tar -xzf "$PACKAGE" -C "$NEW" --strip-components=1 -v | {
  extracted=0
  while IFS= read -r _entry; do
    extracted=$((extracted + 1))
    if [ $((extracted % ${String(EXTRACT_CHECKPOINT)})) -eq 0 ]; then printf 'DSH-MESH-EXTRACT %s\n' "$extracted"; fi
  done
}

# Drop the archive as soon as it is expanded: it is 300+ MiB, /tmp on a member
# is often a small tmpfs, and one copy left behind per job eventually fills it
# so the next upload dies halfway with a bare scp "Failure".
rm -f "$PACKAGE"

# Shared mutable state stays outside every release. The first deploy copies it
# from the currently running tree; later deploys inherit it untouched.
for dir in config data home workspace; do
  if [ ! -e "$SHARED/$dir" ]; then
    if [ -e "$CURRENT/$dir" ]; then
      cp -a "$CURRENT/$dir" "$SHARED/$dir"
    else
      mkdir -p "$SHARED/$dir"
    fi
  fi
  rm -rf "$NEW/$dir"
  ln -s "$SHARED/$dir" "$NEW/$dir"
done
${chown}
ENV_FILE="$SHARED/config/gate.env"
if [ ! -f "$ENV_FILE" ]; then
  # A member that was never installed has no shared config yet. The deploy
  # already carries the package, the units and the password, so seed the same
  # fields install.sh writes instead of refusing the first deploy.
  mkdir -p "$SHARED/config" "$SHARED/home" "$SHARED/workspace"
  cat > "$ENV_FILE" <<'DSH_MESH_ENV'
# dsh-mesh：由首次 SSH 部署生成的网关配置（与 install.sh 的模板等价）
DSH_GATE_BIND=::
DSH_GATE_COOKIE_DAYS=30
DSH_WEB_PORT=31280
DSH_MESH_ENV
  printf 'DSH_GATE_PORT=%s\\n' ${sh(plan.gatePort)} >> "$ENV_FILE"
  printf 'DSH_GATE_PASSWORD=%s\\n' ${sh(plan.gatePassword || 'ChangeMe-Please-2026')} >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "seeded $ENV_FILE for a first deploy"
fi
${plan.serviceUser === undefined || plan.serviceUser === 'root' ? '' : `chown ${sh(`${plan.serviceUser}:`)} "$ENV_FILE" 2>/dev/null || true`}
sed -i "s|^DSH_HOME=.*|DSH_HOME=$SHARED/home|" "$ENV_FILE"
sed -i "s|^DSH_WORKDIR=.*|DSH_WORKDIR=$SHARED/workspace|" "$ENV_FILE"
grep -q '^DSH_HOME=' "$ENV_FILE" || echo "DSH_HOME=$SHARED/home" >> "$ENV_FILE"
grep -q '^DSH_WORKDIR=' "$ENV_FILE" || echo "DSH_WORKDIR=$SHARED/workspace" >> "$ENV_FILE"
# The gateway password belongs to the deployer: peer requests are signed with a
# secret derived from it, so members only need to share this password.
${plan.gatePassword ? `sed -i ${sh(`s|^DSH_GATE_PASSWORD=.*|DSH_GATE_PASSWORD=${sedReplacement(plan.gatePassword)}|`)} "$ENV_FILE"
grep -q '^DSH_GATE_PASSWORD=' "$ENV_FILE" || echo ${sh(`DSH_GATE_PASSWORD=${plan.gatePassword}`)} >> "$ENV_FILE"
echo 'gateway password synced from the deployer'
` : ''}sed -i '/^DSH_GATE_CLUSTER_KEY=/d' "$ENV_FILE"
# An archive written on a filesystem without modes (or an old package) can lose
# the executable bit on the launch scripts.
chmod +x "$NEW"/*.sh 2>/dev/null || true
# The runtime ships as runtime/node/bin/node; older packages used runtime/node/node.
NODE_BIN="$NEW/runtime/node/bin/node"
if [ ! -x "$NODE_BIN" ]; then NODE_BIN="$NEW/runtime/node/node"; fi
if [ ! -x "$NODE_BIN" ]; then echo "missing the node binary under $NEW/runtime/node" >&2; exit 1; fi
chmod +x "$NODE_BIN" 2>/dev/null || true
"$NODE_BIN" --check "$NEW/gate/server.mjs"
${netTune}${wgPersist}"$NODE_BIN" - "$SHARED/home/profiles/web" "$NEW/plugins/dsh-mesh" ${llmArgs}<<'DSH_MESH_PROFILE_WIRE'
${PROFILE_WIRE_SCRIPT}
DSH_MESH_PROFILE_WIRE
# The deployer's account grants make this member signed in without a QR scan.
CREDENTIALS_FILE=${sh(plan.remoteCredentials)}
if [ -f "$CREDENTIALS_FILE" ]; then
  MERGE_HELPER="$NEW/shared/credentials-merge.mjs"
  if [ -f "$CREDENTIALS_FILE.mjs" ]; then MERGE_HELPER="$CREDENTIALS_FILE.mjs"; fi
  if "$NODE_BIN" "$MERGE_HELPER" "$SHARED/home/.credentials.yaml" "$CREDENTIALS_FILE"; then
    rm -f "$CREDENTIALS_FILE" "$CREDENTIALS_FILE.mjs"
  else
    echo "could not copy the deployer account sign-in" >&2
  fi
fi
test -f "$NEW/manifest.json"

write_unit() {
  local unit="$1"
  local command="$2"
  local dropin="/etc/systemd/system/$unit.d"
  mkdir -p "$dropin"
  cat > "$dropin/dsh-release.conf" <<EOF
[Service]
WorkingDirectory=$APP_ROOT/current
ExecStart=
ExecStart=$command
EOF
  # A machine that never ran install.sh has no unit to extend; write a minimal
  # one so the drop-in above has something to override.
  if [ ! -f "/etc/systemd/system/$unit" ]; then
    cat > "/etc/systemd/system/$unit" <<EOF
[Unit]
Description=$unit (dsh-mesh)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_ROOT/current
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
  fi
  systemctl enable "$unit" >/dev/null 2>&1 || true
}
${serviceBlocks}
${plan.interop === null || plan.interop === undefined ? '' : `# The interop listener now runs inside DSH Web (the dsh-mesh plugin owns
# :8765 and drives sessions through the host's own agent registry). The
# configuration stays here: the plugin reads this file, and the gateway's
# control service / member task tool authenticate with the gateway password.
INTEROP_ENV="$SHARED/config/interop.env"
cat > "$INTEROP_ENV" <<EOF
# generated by the dsh-mesh deploy
DSH_HOME=$SHARED/home
DSH_WORKDIR=$SHARED/workspace
DSH_INTEROP_BIND=${plan.interop.bind}
DSH_INTEROP_PORT=${plan.interop.port}
DSH_INTEROP_PROVIDER=${plan.interop.provider}
DSH_INTEROP_MODEL=${plan.interop.model}
DSH_INTEROP_APPROVE=1
DSH_INTEROP_USE_GATE_PASSWORD=1
EOF
chmod 600 "$INTEROP_ENV"
# Keep the standalone unit on disk for a rollback to a release that predates
# the embedded listener, but never start it: DSH Web binds the same port.
write_unit dsh-interop.service "$APP_ROOT/current/start-interop.sh"
systemctl disable --now dsh-interop.service >/dev/null 2>&1 || true
echo "embedded interop in DSH Web on ${plan.interop.bind}:${plan.interop.port}; standalone unit disabled"
`}systemctl daemon-reload
echo "prepared $RELEASE at $NEW"
`
}

/**
 * Build the Linux activate script.
 * @param {object} plan deployment plan.
 * @returns {string} shell script.
 */
export function buildLinuxActivateScript(plan) {
  const restart = plan.services
    .filter(service => plan.scope === 'all' || service.role !== 'gate')
    .map(service => `systemctl restart ${sh(service.name)}`)
    .join('\n')
  const rollbackRestart = plan.services
    .filter(service => plan.scope === 'all' || service.role !== 'gate')
    .map(service => `systemctl restart ${sh(service.name)}`)
    .join('\n')
  const interopHost = plan.interop === null || plan.interop === undefined
    ? null
    : plan.interop.bind === '0.0.0.0' ? '127.0.0.1' : plan.interop.bind
  // The gate health only proves the Web page booted. The embedded interop has
  // to bind :8765 in that same process before member delegation and panel
  // launches actually work, so the deploy waits for both.
  const interopHealth = interopHost === null
    ? '  return 0'
    : `  # The old stack may still own :8765 while its service stops; wait out the
  # handover before accepting the new process's marker.
  sleep 10
  for _ in $(seq 1 30); do
    if curl -fsS "http://${interopHost}:${plan.interop.port}/healthz" 2>/dev/null | grep -q "dsh-mesh-embedded-interop-v1"; then
      return 0
    fi
    sleep 2
  done
  return 1`
  // A rollback to a release that predates the embedded listener starts the
  // standalone again; that endpoint has no marker, so the loose probe accepts
  // any interop health. The initial activate stays strict so an old process on
  // :8765 cannot make a failed embedded start look healthy.
  const interopHealthLoose = interopHost === null
    ? '  return 0'
    : `  sleep 10
  for _ in $(seq 1 30); do
    if curl -fsS "http://${interopHost}:${plan.interop.port}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1`
  return `#!/usr/bin/env bash
set -euo pipefail
APP_ROOT=${sh(plan.appRoot)}
RELEASE=${sh(plan.release)}
NEW="$APP_ROOT/releases/$RELEASE"
SHARED="$APP_ROOT/shared"
CURRENT="$APP_ROOT/current"
PREVIOUS="$APP_ROOT/previous"
PORT=$(sed -n 's/^DSH_GATE_PORT=//p' "$SHARED/config/gate.env" | tail -n1)
PORT=\${PORT:-${plan.gatePort}}
OLD=$(readlink -f "$CURRENT" 2>/dev/null || true)
if [ -n "$OLD" ]; then
  ln -sfn "$OLD" "$PREVIOUS"
fi
ln -sfn "$NEW" "$CURRENT"

# After an upgrade the member's gate shows the acceptance page first. A first
# install has no previous release and nothing to accept, so it writes nothing.
PENDING="$SHARED/data/upgrade-pending.json"
rm -f "$PENDING" 2>/dev/null || true
if [ -n "$OLD" ] && grep -q '__gate/fallback' "$NEW/gate/server.mjs" 2>/dev/null; then
  MARKER_NODE="$NEW/runtime/node/bin/node"
  [ -x "$MARKER_NODE" ] || MARKER_NODE="$NEW/runtime/node/node"
  [ -x "$MARKER_NODE" ] || MARKER_NODE=$(command -v node || true)
  if [ -n "$MARKER_NODE" ]; then
    FROM_VERSION=$("$MARKER_NODE" -e 'try{process.stdout.write(String(require(process.argv[1]).version||""))}catch(e){}' "$OLD/manifest.json" 2>/dev/null || true)
    TO_VERSION=$("$MARKER_NODE" -e 'try{process.stdout.write(String(require(process.argv[1]).version||""))}catch(e){}' "$NEW/manifest.json" 2>/dev/null || true)
    FROM_VERSION=\${FROM_VERSION:-unknown}
    TO_VERSION=\${TO_VERSION:-unknown}
    mkdir -p "$SHARED/data"
    "$MARKER_NODE" - "$PENDING" "$APP_ROOT" "$NEW" "$OLD" "$FROM_VERSION" "$TO_VERSION" "$PORT" "$SHARED/home" <<'DSH_MESH_PENDING'
const fs = require('fs')
const [file, root, release, previous, from, to, port, dshHome] = process.argv.slice(2)
const state = {
  format: 1,
  status: 'pending',
  layout: 'bluegreen',
  root,
  release,
  previous,
  from,
  to,
  port: Number(port) || 80,
  dshHome,
  upgradedAt: new Date().toISOString(),
}
fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\\n", { mode: 0o600 })
DSH_MESH_PENDING
  fi
fi

# A failing systemctl restart must not abort the script: with set -e that
# used to exit *after* current had already moved, leaving the member on a
# release whose services never came up — and no rollback. Collect the failures
# and let the single rollback path below decide.
restart_services() {
  local failed=0
${restart.split('\n').map(line => `  ${line} || failed=1`).join('\n')}
  return "$failed"
}
health() {
  local gate_ok=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/__gate/health" >/dev/null 2>&1; then
      gate_ok=1
      break
    fi
    sleep 2
  done
  if [ "$gate_ok" != "1" ]; then return 1; fi
${interopHealth}
}
health_loose() {
  local gate_ok=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/__gate/health" >/dev/null 2>&1; then
      gate_ok=1
      break
    fi
    sleep 2
  done
  if [ "$gate_ok" != "1" ]; then return 1; fi
${interopHealthLoose}
}
ROLLED_BACK=0
rollback() {
  if [ "$ROLLED_BACK" = "1" ]; then return 0; fi
  ROLLED_BACK=1
  rm -f "$SHARED/data/upgrade-pending.json" 2>/dev/null || true
  if [ -z "$OLD" ]; then
    echo "no previous release to roll back to; $CURRENT stays on $RELEASE" >&2
    return 1
  fi
  echo "rolling back to $OLD" >&2
  ln -sfn "$OLD" "$CURRENT"
${rollbackRestart.split('\n').map(line => `  ${line} || true`).join('\n')}
  # A release that shipped before the embedded listener still needs the
  # standalone unit; an embedded release must keep it stopped or the plugin
  # cannot bind :8765.
  if { [ -f "$OLD/manifest.json" ] && grep -q "embedded-interop" "$OLD/manifest.json"; } || grep -q "dsh-mesh-embedded-interop-v1" "$OLD/plugins/dsh-mesh/index.js" 2>/dev/null; then
    systemctl stop dsh-interop.service 2>/dev/null || true
    systemctl disable dsh-interop.service 2>/dev/null || true
  else
    systemctl enable --now dsh-interop.service 2>/dev/null || true
  fi
  if health_loose; then
    echo "rollback finished: $OLD answers the health check" >&2
  else
    echo "rollback finished but $OLD did not answer the health check; it needs a manual look" >&2
  fi
  # A failed release is no longer referenced, but it is a full package tree
  # (about 1.3 GB); leaving one behind per failed attempt fills the disk. Keep
  # it when the rollback did not actually move current away from it.
  if [ -n "$NEW" ] && [ "$(readlink -f "$CURRENT" 2>/dev/null || true)" != "$(readlink -f "$NEW" 2>/dev/null || true)" ]; then
    rm -rf "$NEW" 2>/dev/null || true
    echo "removed the failed release $NEW" >&2
  fi
  return 0
}
# Any unexpected failure after the switch (a missing binary, a full disk) takes
# the same rollback path instead of leaving the release half-applied.
set -E
trap 'rollback || true' ERR
if ! restart_services; then
  echo "a service failed to restart on $RELEASE; rolling back" >&2
  rollback || true
  exit 1
fi
# DSH Web hosts the interop listener; never let the standalone unit race it.
systemctl stop dsh-interop.service >/dev/null 2>&1 || true
systemctl disable dsh-interop.service >/dev/null 2>&1 || true
if ! health; then
  echo "health check failed on $RELEASE; rolling back" >&2
  rollback || true
  exit 1
fi
trap - ERR
# Retention: keep the newest N releases and never the current/previous target.
mapfile -t RELEASES < <(ls -1dt "$APP_ROOT/releases"/* 2>/dev/null || true)
for ((i=${plan.retention}; i<\${#RELEASES[@]}; i++)); do
  old="\${RELEASES[$i]}"
  [ "$(readlink -f "$CURRENT")" = "$old" ] && continue
  [ "$(readlink -f "$PREVIOUS")" = "$old" ] && continue
  rm -rf "$old" || true
done
echo "activated $RELEASE"
`
}

/**
 * Build the Linux rehearsal script for a test upgrade.
 *
 * A gateway upgrade runs `code/deploy/upgrade-local.sh` because a flat install
 * has no release symlink to switch; runner.mjs prefers the copy shipped in the
 * package being installed and falls back to the installed plugin's copy.
 * Members are blue-green, so testing there would exercise a different code
 * path entirely — the gap that let a flat-only breakage ship. This script
 * therefore rebuilds a flat install inside a sandbox on the member: the
 * package is extracted, the member's *current* release files and its real
 * `gate.env` / profile manifest are copied in, and the same script source the
 * gateway uses is run from a copy with `--stage`. A second, deliberately
 * failing run proves `restore()` puts the files back.
 *
 * It runs before `prepare`, so a package that cannot do a flat upgrade fails
 * the job before the member's live profile or `gate.env` are touched.
 * @param {object} plan deployment plan.
 * @returns {string} shell script.
 */
export function buildLinuxRehearseScript(plan) {
  return `set -Eeuo pipefail
APP_ROOT=${sh(plan.appRoot)}
CURRENT="$APP_ROOT/current"
SHARED=${sh(plan.shared)}
PKG=${sh(plan.remotePackage)}
RELEASE=${sh(plan.release)}
TEST_PARENT="$APP_ROOT/../.dsh-mesh-test"
TEST_ROOT="$TEST_PARENT/$RELEASE"
APP="$TEST_ROOT/app"
TEST_HOME="$TEST_ROOT/home"
STAGE="$TEST_ROOT/stage"
say() { printf '==> %s\\n' "$*"; }
fail() { printf '[演练失败] %s\\n' "$*" >&2; exit 1; }
cleanup() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '[演练失败] 沙箱保留在 %s 供排查（下次演练会先清掉）\\n' "$TEST_ROOT" >&2
    return 0
  fi
  rm -rf "$TEST_ROOT"
  rmdir "$TEST_PARENT" 2>/dev/null || true
}
trap cleanup EXIT
[ -f "$PKG" ] || fail "包不在目标机上：$PKG"
[ -d "$CURRENT/plugins/dsh-mesh" ] || fail "目标成员当前版本里没有 plugins/dsh-mesh，无法构造升级前状态"
[ -f "$SHARED/config/gate.env" ] || fail "目标成员没有 $SHARED/config/gate.env，不是 dsh-mesh 安装"
# 上一次失败留下的沙箱先清掉，避免永久堆积。
rm -rf "$TEST_PARENT"
mkdir -p "$APP/config" "$APP/plugins" "$TEST_HOME/profiles/web" "$TEST_ROOT/tools" "$STAGE"
# 解析成绝对路径：wire-profile 写的是绝对 link: 目标，带 .. 的路径永远比不相等。
TEST_ROOT=$(CDPATH= cd -- "$TEST_ROOT" && pwd)
APP="$TEST_ROOT/app"
TEST_HOME="$TEST_ROOT/home"
STAGE="$TEST_ROOT/stage"
say "平铺升级演练：解压新包并复刻目标成员当前版本（沙箱 $TEST_ROOT）"
tar -xzf "$PKG" -C "$STAGE" --strip-components=1
NODE="$STAGE/runtime/node/bin/node"
[ -x "$NODE" ] || NODE=$(command -v node || true)
[ -n "$NODE" ] || fail '演练需要 node（包内 runtime 或系统 node）'
# 升级前的状态尽量用目标成员的真实文件，而不是只造一个 plugins 目录：
# 备份范围（code/gate/manifest/start.sh）、真实 gate.env、真实 profile 清单都要能测到。
cp -a "$CURRENT/plugins/." "$APP/plugins/"
for item in code gate locale manifest.json start.sh start-dsh.sh start-interop.sh; do
  if [ -e "$CURRENT/$item" ]; then cp -a "$CURRENT/$item" "$APP/"; fi
done
if [ -d "$CURRENT/config" ]; then cp -a "$CURRENT/config/." "$APP/config/"; fi
cp -a "$SHARED/config/gate.env" "$APP/config/gate.env"
PROFILE_SRC="$SHARED/home/profiles/web"
for file in package.json cordis.patch.yml; do
  if [ -f "$PROFILE_SRC/$file" ]; then cp -a "$PROFILE_SRC/$file" "$TEST_HOME/profiles/web/"; fi
done
# 沙箱用自己的 DSH_HOME 和空闲端口，别碰成员真实的 80/8765。
sed -i -e "s|^DSH_HOME=.*|DSH_HOME=$TEST_HOME|" -e "s|^DSH_GATE_PORT=.*|DSH_GATE_PORT=18080|" "$APP/config/gate.env"
grep -q '^DSH_GATE_PORT=' "$APP/config/gate.env" || printf 'DSH_GATE_PORT=18080\\n' >> "$APP/config/gate.env"
grep -q '^DSH_HOME=' "$APP/config/gate.env" || printf 'DSH_HOME=%s\\n' "$TEST_HOME" >> "$APP/config/gate.env"
BEFORE=$("$NODE" -p "require('$APP/plugins/dsh-mesh/package.json').version" 2>/dev/null || echo unknown)
say "升级前的沙箱版本：$BEFORE（以文件内容判断是否真的覆盖）"
# 脚本来源与生产一致：优先用新包里的那份（runner.mjs 也是这么做的），
# 这样新包的备份范围/回退逻辑在它自己的升级里就生效；只有老包不带
# code/deploy 时才退回已安装插件里的那份。
PLUGIN_DEPLOY="$CURRENT/plugins/dsh-mesh/code/deploy"
if [ -f "$STAGE/code/deploy/upgrade-local.sh" ]; then
  SCRIPT_SRC="$STAGE/code/deploy/upgrade-local.sh"
  say '脚本来源：新包（与「升级」同源）'
  if [ -f "$PLUGIN_DEPLOY/upgrade-local.sh" ]; then
    A=$(sha256sum "$SCRIPT_SRC" | cut -d' ' -f1)
    B=$(sha256sum "$PLUGIN_DEPLOY/upgrade-local.sh" | cut -d' ' -f1)
    if [ "$A" != "$B" ]; then say '注意：新包里的脚本与已安装插件的不一致，按生产行为以新包为准'; fi
  fi
else
  SCRIPT_SRC="$PLUGIN_DEPLOY/upgrade-local.sh"
  say '脚本来源：已安装插件（新包是早于修复的版本，没有 code/deploy）'
fi
[ -f "$SCRIPT_SRC" ] || fail '已安装插件和新包里都没有 code/deploy/upgrade-local.sh，这个包做不了平铺升级'
cp "$SCRIPT_SRC" "$TEST_ROOT/tools/upgrade-local.sh"
if [ -f "$(dirname "$SCRIPT_SRC")/wire-profile.mjs" ]; then
  cp "$(dirname "$SCRIPT_SRC")/wire-profile.mjs" "$TEST_ROOT/tools/wire-profile.mjs"
elif [ -f "$STAGE/code/deploy/wire-profile.mjs" ]; then
  cp "$STAGE/code/deploy/wire-profile.mjs" "$TEST_ROOT/tools/wire-profile.mjs"
else
  fail '找不到 wire-profile.mjs（脚本目录和新包里都没有）'
fi
chmod +x "$TEST_ROOT/tools/upgrade-local.sh"
say '第一步：正常升级沙箱（--no-restart：备份、覆盖、接线；不碰任何服务）'
bash "$TEST_ROOT/tools/upgrade-local.sh" --app-root "$APP" --stage "$STAGE" --dsh-home "$TEST_HOME" --port 18080 --no-restart
say '核对升级结果'
BACKUP_DIR=$(ls -1d "$APP/.upgrade-backup"/* 2>/dev/null | head -n1 || true)
[ -n "$BACKUP_DIR" ] || fail '升级没有留下 .upgrade-backup 备份'
for item in plugins code gate manifest.json; do
  if [ -e "$CURRENT/$item" ]; then
    [ -e "$BACKUP_DIR/$item" ] || fail "备份缺 $item：平铺升级的备份范围不对"
  fi
done
cmp -s "$BACKUP_DIR/plugins/dsh-mesh/index.js" "$CURRENT/plugins/dsh-mesh/index.js" || fail '备份里的插件不是升级前那一份'
cmp -s "$APP/plugins/dsh-mesh/index.js" "$STAGE/plugins/dsh-mesh/index.js" || fail '覆盖后的插件不是新包那一份'
AFTER=$("$NODE" -p "require('$APP/plugins/dsh-mesh/package.json').version")
say "升级后的沙箱版本：$AFTER；备份与覆盖逐字节核对过"
LINK=$("$NODE" -e "const p=require('$TEST_HOME/profiles/web/package.json');process.stdout.write(String((p.dependencies||{})['@local/dsh-mesh']||''))")
[ "$LINK" = "link:$APP/plugins/dsh-mesh" ] || fail "profile 的 @local/dsh-mesh 接线不对：$LINK"
say "profile 接线：$LINK"
if [ -d "$STAGE/plugins/xl" ]; then
  [ -e "$TEST_HOME/profiles/web/node_modules/xl" ] || fail '新包带了 xl，但 profile 没有接上 xl'
  say '随包插件 xl 已接入 profile'
fi
say '第二步：Chrome headless 抓屏确认升级后的 DSH 能启动、Mesh 面板能出现'
SMOKE_SCRIPT="$APP/plugins/dsh-mesh/code/build/smoke-cli.mjs"
[ -f "$SMOKE_SCRIPT" ] || SMOKE_SCRIPT="$STAGE/plugins/dsh-mesh/code/build/smoke-cli.mjs"
[ -f "$SMOKE_SCRIPT" ] || fail '新包里没有 code/build/smoke-cli.mjs，无法验证 DSH 启动与 Mesh 面板'
# 截图留在沙箱外面：成功会删 TEST_ROOT，失败要留证据。
SMOKE_SHOT="$APP_ROOT/.dsh-mesh-test-$RELEASE"
rm -rf "$SMOKE_SHOT"
mkdir -p "$SMOKE_SHOT"
# 成员没有 Chrome/Chromium/Edge 时，smoke-cli 会下载 Chrome for Testing 的
# chrome-headless-shell（缓存到运行用户的 ~/.cache/dsh-mesh/chrome）。下载或
# 启动失败不应让升级演练失败：那只是这台成员暂时没有可用的浏览器。
if "$NODE" "$SMOKE_SCRIPT" --install --root "$APP" --port 18081 --home "$TEST_HOME" \
    --workdir "$TEST_ROOT/workspace" --screenshot-dir "$SMOKE_SHOT" --download-chrome; then
  say "抓屏通过：DSH 已启动，Mesh 面板已出现（截图 $SMOKE_SHOT）"
else
  smoke_rc=$?
  if [ "$smoke_rc" = "3" ]; then
    say '抓屏跳过：没有可用的 Chrome/Chromium/Edge，自动下载或启动也失败（详见上面的 [smoke] 日志；构建机上的「构建后抓屏」仍会执行）'
  else
    fail "升级后的沙箱没有通过 Chrome 抓屏冒烟（退出码 $smoke_rc）；截图与日志在 $SMOKE_SHOT"
  fi
fi

# 第三步：注入一次“接线”失败，验证 upgrade-local.sh 的 restore() 能把
# 已经覆盖过的文件还原。注入方式是把 wire-profile 换成必定失败的小脚本，
# 它会留下一个标记，证明覆盖已经发生、失败点在接线。
say '第三步：注入接线失败，验证 restore() 能还原'
cp -a "$STAGE/." "$TEST_ROOT/bad/"
printf '// bad stage\n' > "$TEST_ROOT/bad/plugins/dsh-mesh/index.js"
mv "$TEST_ROOT/tools/wire-profile.mjs" "$TEST_ROOT/tools/wire-profile.real"
cat > "$TEST_ROOT/tools/wire-profile.mjs" <<'DSH_MESH_REHEARSE_STUB'
import { writeFileSync } from 'node:fs'
writeFileSync(new URL('../wiring-ran', import.meta.url), 'ran')
process.exit(3)
DSH_MESH_REHEARSE_STUB
chmod +x "$TEST_ROOT/tools/wire-profile.mjs"
MARK_BEFORE=$(sha256sum "$APP/plugins/dsh-mesh/index.js" "$APP/manifest.json" "$APP/config/gate.env")
if bash "$TEST_ROOT/tools/upgrade-local.sh" --app-root "$APP" --stage "$TEST_ROOT/bad" --dsh-home "$TEST_HOME" --port 18080 --no-restart; then
  fail '注入失败后脚本居然成功了：restore() 路径没有被执行'
fi
mv "$TEST_ROOT/tools/wire-profile.real" "$TEST_ROOT/tools/wire-profile.mjs"
[ -f "$TEST_ROOT/wiring-ran" ] || fail '注入的失败没有走到接线步骤：备份/覆盖没有被验证'
MARK_AFTER=$(sha256sum "$APP/plugins/dsh-mesh/index.js" "$APP/manifest.json" "$APP/config/gate.env")
[ "$MARK_BEFORE" = "$MARK_AFTER" ] || fail 'restore() 没有把覆盖过的文件还原'
[ -f "$APP/plugins/dsh-mesh/index.js" ] || fail 'restore() 之后 index.js 没有被还原成文件'
say 'restore() 已验证：接线失败后文件回到升级前'
say '演练通过：备份、覆盖、接线、失败还原都按本机「升级」的脚本走了一遍；沙箱已清理'
`
}

/**
 * Build the Linux rollback script.
 * @param {object} plan deployment plan.
 * @returns {string} shell script.
 */
export function buildLinuxRollbackScript(plan) {
  const restart = plan.services
    .filter(service => plan.scope === 'all' || service.role !== 'gate')
    .map(service => `systemctl restart ${sh(service.name)}`)
    .join('\n')
  return `#!/usr/bin/env bash
set -euo pipefail
APP_ROOT=${sh(plan.appRoot)}
CURRENT="$APP_ROOT/current"
PREVIOUS="$APP_ROOT/previous"
OLD=$(readlink -f "$PREVIOUS" 2>/dev/null || true)
if [ -z "$OLD" ]; then
  echo "no previous release to roll back to" >&2
  exit 1
fi
ln -sfn "$OLD" "$CURRENT"
${restart}
if { [ -f "$OLD/manifest.json" ] && grep -q "embedded-interop" "$OLD/manifest.json"; } || grep -q "dsh-mesh-embedded-interop-v1" "$OLD/plugins/dsh-mesh/index.js" 2>/dev/null; then
  systemctl stop dsh-interop.service 2>/dev/null || true
  systemctl disable dsh-interop.service 2>/dev/null || true
else
  systemctl enable --now dsh-interop.service 2>/dev/null || true
fi
echo "rolled back to $OLD"
`
}

/**
 * Build the Windows prepare script.
 * @param {object} plan deployment plan.
 * @returns {string} PowerShell script.
 */
export function buildWindowsPrepareScript(plan) {
  const serviceLines = `# The gate spawns DSH itself, so a leftover split service would run a second
# copy on another port. Retire it once.
$legacy = Get-Service -Name 'DSH-Web-App' -ErrorAction SilentlyContinue
if ($null -ne $legacy) {
  Stop-Service -Name 'DSH-Web-App' -Force -ErrorAction SilentlyContinue
  & sc.exe delete 'DSH-Web-App' | Out-Null
  Write-Output 'removed the legacy DSH-Web-App service'
}
# A split install may have the standalone interop registered as its own
# service. DSH Web now binds :8765 in-process, so that service must not race it.
$legacyInterop = Get-Service -Name 'DSH-Interop' -ErrorAction SilentlyContinue
if ($null -ne $legacyInterop) {
  Stop-Service -Name 'DSH-Interop' -Force -ErrorAction SilentlyContinue
  Set-Service -Name 'DSH-Interop' -StartupType Disabled -ErrorAction SilentlyContinue
  Write-Output 'disabled the legacy DSH-Interop service'
}
function Ensure-DshService([string]$Name, [string]$Display, [string]$Description, [string]$ExePath) {
  $binPath = '"' + $ExePath + '"'
  if ($null -eq (Get-Service -Name $Name -ErrorAction SilentlyContinue)) {
    & sc.exe create $Name binPath= $binPath start= auto DisplayName= $Display | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc create failed for $Name" }
    & sc.exe description $Name $Description | Out-Null
    & sc.exe failure $Name reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
    Write-Output "created service $Name"
  }
  & sc.exe config $Name binPath= $binPath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc config failed for $Name" }
}
` + plan.services.map(service => {
    const command = service.command
    const display = service.role === 'dsh' ? 'DSH Web App' : 'DSH Mesh Gateway'
    const description = service.role === 'dsh' ? 'Independent DSH Web process' : 'DSH gateway, login and member proxy'
    const source = service.role === 'dsh' ? 'DshWebAppService.cs' : 'DshMeshService.cs'
    return `$exe = Join-Path $New ${ps(command)}
if (-not (Test-Path $exe)) {
  # The package ships the C# service sources, not the binaries, so compile the
  # wrapper into this release with the .NET Framework compiler.
  $serviceSource = Join-Path $New ${ps('code\\windows-service\\' + source)}
  if (-not (Test-Path $serviceSource)) { throw "missing service source: $serviceSource" }
  $csc = Join-Path ([System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
  if (-not (Test-Path $csc)) { throw 'cannot find csc.exe' }
  & $csc /nologo /target:exe /out:$exe /r:System.ServiceProcess.dll $serviceSource
  if ($LASTEXITCODE -ne 0) { throw "csc failed for $exe" }
}
Ensure-DshService ${ps(service.name)} ${ps(display)} ${ps(description)} ($AppRoot + '\\current\\' + ${ps(command)})`
  }).join('\n')
  return `$ErrorActionPreference = 'Stop'
$AppRoot = ${ps(plan.appRoot)}
$Release = ${ps(plan.release)}
$Package = ${ps(plan.remotePackage)}
$New = Join-Path $AppRoot "releases\\$Release"
$Shared = Join-Path $AppRoot 'shared'
$Current = Join-Path $AppRoot 'current'
$Previous = Join-Path $AppRoot 'previous'
New-Item -ItemType Directory -Force -Path (Join-Path $AppRoot 'releases') | Out-Null
New-Item -ItemType Directory -Force -Path $Shared | Out-Null
# A failed prepare or activate can leave a whole release tree behind (about
# 1.3 GB each). Keep only the running release and the rollback target; $New is
# excluded because a retry refuses to overwrite it below anyway.
$pruneCurrent = $null
$prunePrevious = $null
if (Test-Path -LiteralPath $Current) {
  $pruneCurrent = (Get-Item -LiteralPath $Current -Force).Target
  if ($pruneCurrent -is [array]) { $pruneCurrent = $pruneCurrent[0] }
}
if (Test-Path -LiteralPath $Previous) {
  $prunePrevious = (Get-Item -LiteralPath $Previous -Force).Target
  if ($prunePrevious -is [array]) { $prunePrevious = $prunePrevious[0] }
}
$pruneTool = Join-Path $Current 'runtime\\node\\node.exe'
Get-ChildItem -LiteralPath (Join-Path $AppRoot 'releases') -Directory |
  Where-Object { $_.FullName -ne $pruneCurrent -and $_.FullName -ne $prunePrevious -and $_.FullName -ne $New } |
  ForEach-Object {
    if (Test-Path -LiteralPath $pruneTool) {
      & $pruneTool -e "const fs=require('fs');fs.rmSync(process.argv[1],{recursive:true,force:true,maxRetries:5,retryDelay:200})" $_.FullName 2>$null
    }
    if (Test-Path -LiteralPath $_.FullName) {
      Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $_.FullName) { Write-Host ("could not remove old release " + $_.Name) }
  }
${plan.preExtracted
  ? 'if (-not (Test-Path $New)) { throw "release directory missing: $New" }'
  : 'if (Test-Path $New) { throw "release already exists: $New" }'}
New-Item -ItemType Directory -Force -Path $New | Out-Null
${plan.preExtracted ? '' : 'Expand-Archive -LiteralPath $Package -DestinationPath $New -Force'}
$inner = Get-ChildItem -LiteralPath $New -Directory | Select-Object -First 1
if ($inner -and (Test-Path (Join-Path $inner.FullName 'manifest.json'))) {
  Get-ChildItem -LiteralPath $inner.FullName -Force | Move-Item -Destination $New -Force
  Remove-Item -LiteralPath $inner.FullName -Recurse -Force
}
foreach ($dir in @('config','data','home','workspace')) {
  $sharedPath = Join-Path $Shared $dir
  if (-not (Test-Path $sharedPath)) {
    $oldPath = Join-Path $Current $dir
    if (Test-Path $oldPath) { Copy-Item $oldPath $sharedPath -Recurse -Force } else { New-Item -ItemType Directory -Force -Path $sharedPath | Out-Null }
  }
  $newPath = Join-Path $New $dir
  if (Test-Path $newPath) { Remove-Item $newPath -Recurse -Force }
  & cmd.exe /c mklink /J "$newPath" "$sharedPath" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "could not link $newPath" }
}
$envFile = Join-Path $Shared 'config\\gate.env'
if (-not (Test-Path $envFile)) {
  # First deploy of a fresh machine: create the gateway config that install.ps1
  # would have written, with random secrets, so the split services can start.
  $alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  $password = ${plan.gatePassword ? ps(plan.gatePassword) : '(-join (1..24 | ForEach-Object { $alphabet[(Get-Random -Maximum $alphabet.Length)] }))'}
  $lines = @(
    '# DeepSeek Harness Web gateway (generated by the first deploy)',
    'DSH_GATE_PORT=${plan.gatePort}',
    'DSH_GATE_BIND=0.0.0.0',
    "DSH_GATE_PASSWORD=$password",
    'DSH_GATE_COOKIE_DAYS=30',
    'DSH_WEB_PORT=31280',
    'DSH_GATE_MEMBER_PORT=${plan.gatePort}',
    'DSH_TRUSTED_HOSTS='
  )
  [System.IO.File]::WriteAllText($envFile, (($lines -join [Environment]::NewLine) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
  Write-Output "generated $envFile (${plan.gatePassword ? 'gateway password copied from the deployer' : 'gateway password: $password'})"
  try {
    if (-not (Get-NetFirewallRule -DisplayName 'DSH Mesh ${plan.gatePort}' -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName 'DSH Mesh ${plan.gatePort}' -Direction Inbound -Protocol TCP -LocalPort ${plan.gatePort} -Action Allow | Out-Null
    }
  } catch { Write-Warning "could not add the firewall rule: $($_.Exception.Message)" }
}
$text = Get-Content -LiteralPath $envFile -Raw
$text = [regex]::Replace($text, '(?m)^DSH_HOME=.*$', "DSH_HOME=$Shared\\home")
$text = [regex]::Replace($text, '(?m)^DSH_WORKDIR=.*$', "DSH_WORKDIR=$Shared\\workspace")
if ($text -notmatch '(?m)^DSH_HOME=') { $text += "\`r\`nDSH_HOME=$Shared\\home" }
if ($text -notmatch '(?m)^DSH_WORKDIR=') { $text += "\`r\`nDSH_WORKDIR=$Shared\\workspace" }
${plan.gatePassword ? `$text = [regex]::Replace($text, '(?m)^DSH_GATE_PASSWORD=.*$', ${psReplacement(`DSH_GATE_PASSWORD=${plan.gatePassword}`)})
if ($text -notmatch '(?m)^DSH_GATE_PASSWORD=') { $text += [Environment]::NewLine + ${ps(`DSH_GATE_PASSWORD=${plan.gatePassword}`)} }
Write-Output 'gateway password synced from the deployer'
` : ''}$text = [regex]::Replace($text, '(?m)^DSH_GATE_CLUSTER_KEY=.*\r?\n?', '')
Set-Content -LiteralPath $envFile -Value $text -Encoding utf8 -NoNewline
$node = Join-Path $New 'runtime\\node\\node.exe'
if (-not (Test-Path $node)) { throw "missing $node" }
& $node --check (Join-Path $New 'gate\\server.mjs')
if ($LASTEXITCODE -ne 0) { throw 'gate syntax check failed' }
$wireScript = Join-Path $env:TEMP 'dsh-mesh-profile-wire.mjs'
[IO.File]::WriteAllText($wireScript, ${ps(PROFILE_WIRE_SCRIPT)}, [Text.UTF8Encoding]::new($false))
& $node $wireScript (Join-Path $Shared 'home\\profiles\\web') (Join-Path $New 'plugins\\dsh-mesh')${plan.llm === null || plan.llm === undefined ? '' : ' ' + [plan.llm.provider, plan.llm.model ?? '', plan.llm.reasoningEffort ?? ''].map(value => ps(value)).join(' ')}
if ($LASTEXITCODE -ne 0) { throw 'could not wire the dsh-mesh plugin into the DSH profile' }
Remove-Item $wireScript -Force -ErrorAction SilentlyContinue
$credentialsFile = '${plan.remoteCredentials}'
if (Test-Path $credentialsFile) {
  $mergeHelper = Join-Path $New 'shared\\credentials-merge.mjs'
  if (Test-Path ($credentialsFile + '.mjs')) { $mergeHelper = $credentialsFile + '.mjs' }
  & $node $mergeHelper (Join-Path $Shared 'home\\.credentials.yaml') $credentialsFile
  if ($LASTEXITCODE -eq 0) { Remove-Item $credentialsFile, ($credentialsFile + '.mjs') -Force -ErrorAction SilentlyContinue } else { Write-Warning 'could not copy the deployer account sign-in' }
}
${serviceLines}
${plan.interop === null || plan.interop === undefined ? '' : `# DSH Web hosts the interop listener now; only its configuration belongs
# here: bind the VPN address, reuse the gateway password as the token, and use
# the same model route the deployer uses.
$interopEnv = Join-Path $Shared 'config\\interop.env'
$interopLines = @(
  '# generated by the dsh-mesh deploy',
  "DSH_HOME=$Shared\\home",
  "DSH_WORKDIR=$Shared\\workspace",
  "DSH_INTEROP_BIND=${plan.interop.bind}",
  "DSH_INTEROP_PORT=${plan.interop.port}",
  "DSH_INTEROP_PROVIDER=${plan.interop.provider}",
  "DSH_INTEROP_MODEL=${plan.interop.model}",
  'DSH_INTEROP_APPROVE=1',
  'DSH_INTEROP_USE_GATE_PASSWORD=1'
)
[System.IO.File]::WriteAllText($interopEnv, (($interopLines -join [Environment]::NewLine) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
Write-Output 'wrote config\\interop.env'
`}Write-Output "prepared $Release at $New"
`
}

/**
 * Build the Windows activate script.
 * @param {object} plan deployment plan.
 * @returns {string} PowerShell script.
 */
export function buildWindowsActivateScript(plan) {
  const interopHost = plan.interop === null || plan.interop === undefined
    ? null
    : plan.interop.bind === '0.0.0.0' ? '127.0.0.1' : plan.interop.bind
  const interopUrl = interopHost === null ? '' : `http://${interopHost}:${plan.interop.port}/healthz`
  const restart = plan.services
    .filter(service => plan.scope === 'all' || service.role !== 'gate')
    .map(service => `Restart-Service -Name ${ps(service.name)} -Force`)
    .join('\n')
  const rollbackRestart = plan.services
    .filter(service => plan.scope === 'all' || service.role !== 'gate')
    .map(service => `Restart-Service -Name ${ps(service.name)} -Force -ErrorAction SilentlyContinue`)
    .join('\n')
  return `$ErrorActionPreference = 'Stop'
$AppRoot = ${ps(plan.appRoot)}
$Release = ${ps(plan.release)}
$New = Join-Path $AppRoot "releases\\$Release"
$Current = Join-Path $AppRoot 'current'
$Previous = Join-Path $AppRoot 'previous'
$port = ${ps(plan.gatePort)}
$interopUrl = ${ps(interopUrl)}
$old = $null
if (Test-Path $Current) {
  $item = Get-Item -LiteralPath $Current -Force
  $old = $item.Target
  if ($old -is [array]) { $old = $old[0] }
}
if ($old) {
  if (Test-Path $Previous) { & cmd.exe /c rmdir "$Previous" | Out-Null }
  & cmd.exe /c mklink /J "$Previous" "$old" | Out-Null
}
if (Test-Path $Current) { & cmd.exe /c rmdir "$Current" | Out-Null }
& cmd.exe /c mklink /J "$Current" "$New" | Out-Null
if ($LASTEXITCODE -ne 0) {
  # Without the junction the member has no current link at all: put the old one
  # back before failing, or every service definition points at nothing.
  if ($old) { & cmd.exe /c mklink /J "$Current" "$old" | Out-Null }
  throw "could not switch current to $New"
}
function Test-Health {
  $gateOk = $false
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/__gate/health" -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -eq 200) { $gateOk = $true; break }
    } catch { }
    Start-Sleep -Seconds 2
  }
  if (-not $gateOk) { return $false }
  if ($interopUrl -ne '') {
    # Let the old stack release :8765 before accepting the new process's marker.
    Start-Sleep -Seconds 10
    for ($i = 0; $i -lt 30; $i++) {
      try {
        $response = Invoke-WebRequest -Uri $interopUrl -UseBasicParsing -TimeoutSec 3
        if ($response.StatusCode -eq 200 -and $response.Content -match 'dsh-mesh-embedded-interop-v1') { return $true }
      } catch { }
      Start-Sleep -Seconds 2
    }
    return $false
  }
  return $true
}
function Test-Health-Loose {
  # A rollback to a release without the embedded listener starts the standalone
  # interop, whose health has no marker. Only the rollback uses this probe.
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/__gate/health" -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -eq 200) {
        if ($interopUrl -eq '') { return $true }
        try {
          $interop = Invoke-WebRequest -Uri $interopUrl -UseBasicParsing -TimeoutSec 3
          if ($interop.StatusCode -eq 200) { return $true }
        } catch { }
      }
    } catch { }
    Start-Sleep -Seconds 2
  }
  return $false
}
function Remove-Release([string]$Path) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return }
  # Never remove the release current points at: a rollback that failed to
  # switch must leave the member on something runnable.
  $active = $null
  if (Test-Path -LiteralPath $Current) {
    $active = (Get-Item -LiteralPath $Current -Force).Target
    if ($active -is [array]) { $active = $active[0] }
  }
  if ($active -eq $Path) { return }
  # Remove-Item cannot delete node_modules paths past MAX_PATH and stops
  # halfway through. Use the active release's Node runtime, never the tree
  # being removed (a running exe cannot delete its own directory).
  $tool = Join-Path $Current 'runtime\\node\\node.exe'
  if (-not (Test-Path -LiteralPath $tool)) { $tool = Join-Path $AppRoot 'current\\runtime\\node\\node.exe' }
  if (Test-Path -LiteralPath $tool) {
    & $tool -e "const fs=require('fs');fs.rmSync(process.argv[1],{recursive:true,force:true,maxRetries:5,retryDelay:200})" $Path 2>$null
  }
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $Path) { Write-Host "could not remove $Path" } else { Write-Host "removed $Path" }
}
# A restart that throws must not skip the health check and the rollback: with
# ErrorActionPreference=Stop it used to abort the script right here, after
# current had already moved.
$restartFailed = $false
try {
${restart}
} catch {
  $restartFailed = $true
  Write-Host ("a service failed to restart on " + $Release + ": " + $_.Exception.Message)
}
function Invoke-Rollback {
  # Logging must not throw here: with ErrorActionPreference=Stop a Write-Error
  # would abort the rollback itself.
  $ErrorActionPreference = 'Continue'
  if (-not $old) {
    Write-Host "no previous release to roll back to; current stays on $Release"
    return
  }
  Write-Host "rolling back to $old"
  if (Test-Path $Current) { & cmd.exe /c rmdir "$Current" | Out-Null }
  & cmd.exe /c mklink /J "$Current" "$old" | Out-Null
  try {
${rollbackRestart.split('\n').map(line => `    ${line}`).join('\n')}
  } catch { Write-Host "rollback restart failed: $($_.Exception.Message)" }
  if (Test-Health-Loose) { Write-Host "rollback finished: $old answers the health check" }
  else { Write-Host "rollback finished but $old did not answer the health check; it needs a manual look" }
  # The failed release is no longer referenced; keeping it would leave a full
  # package tree (about 1.3 GB) behind after every failed attempt.
  Remove-Release $New
}
if ($restartFailed -or -not (Test-Health)) {
  if (-not $restartFailed) { Write-Host "health check failed on $Release; rolling back" }
  Invoke-Rollback
  exit 1
}
# Retention: keep the newest N releases and never the current/previous target.
$keep = ${plan.retention}
$currentTarget = $null
$previousTarget = $null
if (Test-Path $Current) { $currentTarget = (Get-Item -LiteralPath $Current -Force).Target }
if (Test-Path $Previous) { $previousTarget = (Get-Item -LiteralPath $Previous -Force).Target }
if ($currentTarget -is [array]) { $currentTarget = $currentTarget[0] }
if ($previousTarget -is [array]) { $previousTarget = $previousTarget[0] }
Get-ChildItem -LiteralPath (Join-Path $AppRoot 'releases') -Directory |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip $keep |
  ForEach-Object {
    if ($_.FullName -ne $currentTarget -and $_.FullName -ne $previousTarget) {
      Remove-Release $_.FullName
    }
  }
Write-Output "activated $Release"
`
}

/**
 * Build the Windows rollback script.
 * @param {object} plan deployment plan.
 * @returns {string} PowerShell script.
 */
export function buildWindowsRollbackScript(plan) {
  const restart = plan.services
    .filter(service => plan.scope === 'all' || service.role !== 'gate')
    .map(service => `Restart-Service -Name ${ps(service.name)} -Force`)
    .join('\n')
  return `$ErrorActionPreference = 'Stop'
$AppRoot = ${ps(plan.appRoot)}
$Current = Join-Path $AppRoot 'current'
$Previous = Join-Path $AppRoot 'previous'
if (-not (Test-Path $Previous)) { throw 'no previous release to roll back to' }
$old = (Get-Item -LiteralPath $Previous -Force).Target
if ($old -is [array]) { $old = $old[0] }
if (Test-Path $Current) { & cmd.exe /c rmdir "$Current" | Out-Null }
& cmd.exe /c mklink /J "$Current" "$old" | Out-Null
${restart}
Write-Output "rolled back to $old"
`
}

/**
 * Build a deploy job plan without touching the network.
 * @param {object} plan deployment plan.
 * @returns {object} plan summary.
 */
export function describePlan(plan) {
  return {
    target: {
      host: plan.host,
      user: plan.user ?? null,
      port: plan.port,
      os: plan.os,
      appRoot: plan.appRoot,
      sudo: plan.sudo,
    },
    release: plan.release,
    package: plan.package,
    services: plan.services,
    scope: plan.scope,
    steps: [
      `upload ${path.basename(plan.package.path)} to ${plan.remotePackage}`,
      `extract and prepare ${plan.releases}/${plan.release} (no service switch)`,
      `update shared config and service definitions for ${plan.appRoot}/current`,
      `switch ${plan.current} to ${plan.release}`,
      ...plan.services
        .filter(service => plan.scope === 'all' || service.role !== 'gate')
        .map(service => `restart ${service.name} (${service.role})`),
      `health check http://127.0.0.1:${plan.gatePort}/__gate/health`,
      `keep the newest ${plan.retention} releases (current/previous are never deleted)`,
      'on failure switch back to the previous release and restart',
    ],
  }
}

/**
 * SSH/SCP runner. Commands are executed directly (no local shell) so host
 * names and paths cannot be reinterpreted by a shell.
 */
export class SshRunner {
  /**
   * @param {object} plan deployment plan.
   * @param {{log?: (line: string) => void}} [options] options.
   */
  constructor(plan, options = {}) {
    this.plan = plan
    this.log = options.log ?? (() => {})
  }

  /** @returns {string[]} common SSH options. */
  sshOptions() {
    const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', '-p', String(this.plan.port)]
    if (this.plan.identityFile) args.push('-i', this.plan.identityFile)
    return args
  }

  /** @returns {string} user@host. */
  target() {
    return this.plan.user ? `${this.plan.user}@${this.plan.host}` : this.plan.host
  }

  /**
   * Upload a local file and report byte progress.
   *
   * The file is streamed through the SSH connection when the target can accept
   * stdin (POSIX `cat` or a PowerShell stdin writer). scp stays as a fallback
   * when streaming fails, so an exotic target still deploys even without a
   * progress meter.
   * @param {string} local local path.
   * @param {string} remote remote path.
   * @param {(progress: {bytes:number,totalBytes:number,percent:number,speed:number,indeterminate?:boolean}) => void} [onProgress] progress callback.
   * @returns {Promise<void>}
   */
  async upload(local, remote, onProgress) {
    const totalBytes = (await stat(local)).size
    try {
      await this.#uploadStream(local, remote, totalBytes, onProgress)
    } catch (error) {
      this.log(`streamed upload failed (${error instanceof Error ? error.message : String(error)}); retrying with scp`)
      onProgress?.({ bytes: 0, totalBytes, percent: 0, speed: 0, indeterminate: true })
      const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-P', String(this.plan.port)]
      if (this.plan.identityFile) args.push('-i', this.plan.identityFile)
      args.push(local, `${this.target()}:${remote}`)
      try {
        await this.runProcess('scp', args)
      } catch (scpError) {
        // A half-written archive is worse than none: it occupies the target's
        // free space and the next attempt has to fit beside it.
        await this.runProcess('ssh', [...this.sshOptions(), this.target(), `rm -f -- ${sh(remote)}`]).catch(() => {})
        throw scpError
      }
      onProgress?.({ bytes: totalBytes, totalBytes, percent: 100, speed: 0, indeterminate: false })
    }
  }

  /**
   * Count the entries in a remote archive.
   * @param {string} remote remote archive path.
   * @returns {Promise<number>} entry count.
   */
  async archiveEntries(remote) {
    const { stdout } = await this.runProcess('ssh', [...this.sshOptions(), this.target(), `tar -tf "${remote}"`])
    return String(stdout).split(/\r?\n/u).filter(line => line.trim() !== '').length
  }

  /**
   * Extract a remote archive with the tar that ships with Windows, reporting
   * one callback per extracted entry.
   * @param {string} remote remote archive path.
   * @param {string} target remote directory.
   * @param {() => void} [onEntry] called for every extracted entry.
   * @returns {Promise<void>}
   */
  async extractArchive(remote, target, onEntry) {
    await this.runProcess('ssh', [...this.sshOptions(), this.target(), `cmd /c if not exist "${target}" mkdir "${target}"`])
    await this.runProcess('ssh', [...this.sshOptions(), this.target(), `tar -xf "${remote}" -C "${target}" -v`], undefined, onEntry, { countOnly: true })
  }

  /**
   * Read a remote file's size, or null when it cannot be read.
   * @param {string} remote remote path.
   * @returns {Promise<number|null>} size in bytes.
   */
  async remoteSize(remote) {
    try {
      const args = [...this.sshOptions(), this.target()]
      let command
      if (this.plan.os === 'windows') {
        const encoded = Buffer.from(`(Get-Item -LiteralPath ${ps(remote)}).Length`, 'utf16le').toString('base64')
        command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
      } else {
        command = `stat -c %s -- ${sh(remote)}`
      }
      const { stdout } = await this.runProcess('ssh', [...args, command])
      const size = Number.parseInt(String(stdout).trim(), 10)
      return Number.isSafeInteger(size) ? size : null
    } catch {
      return null
    }
  }

  /**
   * Free bytes on the filesystem that holds `remote`, or null when it cannot be
   * measured (Windows targets, or a host without `df`).
   * @param {string} remote remote path.
   * @returns {Promise<number|null>} free bytes.
   */
  async remoteFreeBytes(remote) {
    if (this.plan.os !== 'linux') return null
    try {
      const dir = path.posix.dirname(remote)
      const { stdout } = await this.runProcess('ssh', [...this.sshOptions(), this.target(), `df -Pk -- ${sh(dir)} | awk 'NR==2 {print $4}'`])
      const kib = Number.parseInt(String(stdout).trim(), 10)
      return Number.isSafeInteger(kib) && kib >= 0 ? kib * 1024 : null
    } catch {
      return null
    }
  }

  /**
   * Delete the package archives earlier deploys left beside `remote`.
   *
   * The archive is 300+ MiB and members commonly mount /tmp as a tmpfs (1.7 GB
   * on a 4 GB ECS). Leaving one per job behind made the third or fourth upgrade
   * fail mid-upload with only scp's `write remote ...: Failure` to show for it.
   * @param {string} remote remote path this job is about to upload to.
   * @returns {Promise<boolean>} whether the cleanup command ran.
   */
  async discardStalePackages(remote) {
    if (this.plan.os !== 'linux') return false
    const dir = path.posix.dirname(remote)
    const keep = path.posix.basename(remote)
    const script = [
      `cd ${sh(dir)} 2>/dev/null || exit 0`,
      'for f in dsh-mesh-*.gz dsh-mesh-*.tar.gz dsh-mesh-*.zip; do',
      '  [ -e "$f" ] || continue',
      `  [ "$f" = ${sh(keep)} ] && continue`,
      '  rm -f -- "$f"',
      'done',
      'exit 0',
    ].join('\n')
    try {
      await this.runProcess('ssh', [...this.sshOptions(), this.target(), script])
      return true
    } catch {
      return false
    }
  }

  /**
   * Stream one file to the remote path through `ssh` stdin.
   * @param {string} local local path.
   * @param {string} remote remote path.
   * @param {number} totalBytes file size.
   * @param {Function} [onProgress] progress callback.
   * @returns {Promise<void>}
   */
  async #uploadStream(local, remote, totalBytes, onProgress) {
    // PowerShell cannot drain a piped stdin reliably over Windows OpenSSH (it
    // blocks after a few hundred KiB), so Windows uses the tar that ships with
    // Windows 10+ as the remote writer: `tar -xf -` reads the archive from
    // stdin and writes the exact file bytes.
    const windows = this.plan.os === 'windows'
    const remoteCommand = windows
      ? `tar -xf - -C "${path.win32.dirname(remote)}"`
      : `cat > ${sh(remote)}`
    const args = [...this.sshOptions(), this.target(), remoteCommand]
    // tar extracts under the archive's own entry name, so stage a hard link
    // named like the remote file instead of the local package name.
    let tarDir = null
    let tarName = null
    if (windows) {
      tarName = path.win32.basename(remote)
      tarDir = await mkdtemp(path.join(tmpdir(), 'dsh-mesh-upload-'))
      const staged = path.join(tarDir, tarName)
      try {
        try {
          await link(local, staged)
        } catch {
          await copyFile(local, staged)
        }
      } catch (error) {
        await rm(tarDir, { recursive: true, force: true }).catch(() => {})
        throw error
      }
    }
    return new Promise((resolve, reject) => {
      const ssh = spawn('ssh', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      const tar = windows
        ? spawn('tar', ['-cf', '-', '-C', tarDir, tarName], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        : null
      const source = tar !== null ? tar.stdout : createReadStream(local)
      let sent = 0
      let stderr = ''
      let settled = false
      let lastAt = Date.now()
      let lastBytes = 0
      let lastDataAt = Date.now()
      let speed = 0
      const finish = error => {
        if (settled) return
        settled = true
        clearInterval(watchdog)
        source.destroy()
        tar?.kill('SIGKILL')
        ssh.kill('SIGKILL')
        if (tarDir !== null) void rm(tarDir, { recursive: true, force: true }).catch(() => {})
        if (error) reject(error)
        else resolve()
      }
      // A remote that stops reading leaves the pipe full and the socket idle;
      // fail instead of waiting forever.
      const watchdog = setInterval(() => {
        if (Date.now() - lastDataAt > 30_000) {
          finish(new Error('upload stalled: the remote stopped reading stdin (30s without progress)'))
        }
      }, 5_000)
      watchdog.unref?.()
      const report = (force = false) => {
        const now = Date.now()
        if (!force && now - lastAt < 200) return
        const seconds = Math.max(1, now - lastAt) / 1000
        speed = Math.max(0, (sent - lastBytes) / seconds)
        lastAt = now
        lastBytes = sent
        const percent = totalBytes > 0
          ? Math.min(windows ? 99 : 100, Math.round((sent / totalBytes) * 100))
          : 0
        onProgress?.({ bytes: sent, totalBytes, percent, speed, indeterminate: false })
      }
      source.on('data', chunk => {
        sent += chunk.length
        lastDataAt = Date.now()
        report()
      })
      source.once('error', error => finish(error))
      ssh.stdout.resume()
      ssh.stderr.on('data', chunk => { stderr += String(chunk) })
      ssh.once('error', error => finish(error))
      ssh.once('exit', code => {
        if (code === 0) {
          report(true)
          finish()
        } else {
          finish(new Error(`ssh upload exited with ${String(code)}: ${stderr.trim()}`))
        }
      })
      ssh.stdin.once('error', () => {})
      if (tar !== null) {
        let tarError = ''
        tar.stderr.on('data', chunk => { tarError += String(chunk) })
        tar.once('error', error => finish(error))
        tar.once('exit', code => {
          if (code !== 0) finish(new Error(`local tar exited with ${String(code)}: ${tarError.trim()}`))
        })
      }
      source.pipe(ssh.stdin)
    })
  }

  /**
   * Run a local process and reject on a non-zero exit.
   * @param {string} command command.
   * @param {string[]} args arguments.
   * @param {string} [input] stdin.
   * @returns {Promise<{stdout:string,stderr:string}>} output.
   */
  runProcess(command, args, input, onLine, options = {}) {
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
          if (trimmed !== '') onLine?.(options.countOnly === true ? '' : trimmed)
        }
      }
      const flush = () => {
        for (const key of ['out', 'err']) {
          const trimmed = buffers[key].trim()
          if (trimmed !== '') onLine?.(trimmed)
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
        else reject(new Error(`${command} exited with ${String(code)}: ${stderr.trim() || stdout.trim()}`))
      })
      if (input !== undefined) child.stdin.end(input)
      else child.stdin.end()
    })
  }

  /**
   * Run a script over SSH.
   * @param {string} script bash or PowerShell script.
   * @param {'linux'|'windows'} os target OS.
   * @returns {Promise<void>}
   */
  async script(script, os, onLine) {
    const base = this.sshOptions()
    if (os === 'linux') {
      const remote = this.plan.sudo ? 'sudo -n bash -s' : 'bash -s'
      await this.runProcess('ssh', [...base, this.target(), remote], script, onLine)
      return
    }
    // -EncodedCommand is UTF-16LE base64 (2.7x the source) and cmd.exe rejects
    // command lines over 8191 characters, which the prepare script exceeds.
    // Ship it as a temp .ps1 and run it with -File instead.
    const name = `dsh-deploy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.ps1`
    const remotePath = `C:\\Windows\\Temp\\${name}`
    const localPath = path.join(tmpdir(), name)
    await writeFile(localPath, `\uFEFF${script}`, 'utf8')
    try {
      await this.upload(localPath, remotePath)
      await this.runProcess(
        'ssh',
        [...base, this.target(), `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${remotePath}"`],
        undefined,
        onLine,
      )
    } finally {
      await rm(localPath, { force: true }).catch(() => {})
      await this.runProcess('ssh', [...base, this.target(), `cmd /c del /f "${remotePath}"`]).catch(() => {})
    }
  }
}

/**
 * Run one local process and stream its output line by line.
 * @param {string} command executable.
 * @param {string[]} args arguments.
 * @param {string|undefined} input stdin text.
 * @param {(line: string) => void} [onLine] line callback.
 * @returns {Promise<{stdout: string, stderr: string}>} captured output.
 */
function runLocalProcess(command, args, input, onLine) {
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
        if (trimmed !== '') onLine?.(trimmed)
      }
    }
    const flush = () => {
      for (const key of ['out', 'err']) {
        const trimmed = buffers[key].trim()
        if (trimmed !== '') onLine?.(trimmed)
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
      else reject(new Error(`${command} exited with ${String(code)}: ${stderr.trim() || stdout.trim()}`))
    })
    child.stdin.end(input ?? '')
  })
}

/**
 * Runner for the machine the panel runs on.
 *
 * The gateway deploying itself is the one case SSH cannot cover: the target
 * address may not be reachable from inside, and the deploy must keep working
 * while its own sshd is restarting. Same phases, same scripts, no network.
 */
export class LocalRunner {
  /**
   * @param {object} plan deployment plan.
   * @param {{log?: (line: string) => void}} [options] options.
   */
  constructor(plan, options = {}) {
    this.plan = plan
    this.log = options.log ?? (() => {})
  }

  /**
   * Copy one file into place, reporting the copy as one finished upload.
   * @param {string} local source path.
   * @param {string} remote destination path.
   * @param {(progress: object) => void} [onProgress] progress callback.
   * @returns {Promise<void>} completion.
   */
  async upload(local, remote, onProgress) {
    const info = await stat(local)
    await mkdir(path.dirname(remote), { recursive: true })
    await copyFile(local, remote)
    onProgress?.({ bytes: info.size, totalBytes: info.size, percent: 100, speed: 0 })
  }

  /**
   * Size of a local file, or null.
   * @param {string} remote path.
   * @returns {Promise<number|null>} bytes.
   */
  async remoteSize(remote) {
    try {
      const info = await stat(remote)
      return info.isFile() ? info.size : null
    } catch {
      return null
    }
  }

  /**
   * Run a bash script in place.
   * @param {string} script script text.
   * @param {'linux'|'windows'} os target OS.
   * @param {(line: string) => void} [onLine] line callback.
   * @returns {Promise<void>} completion.
   */
  async script(script, os, onLine) {
    if (os !== 'linux') throw new Error('本地部署只支持 Linux：本机没有可用的 Windows 运行时')
    await runLocalProcess('bash', ['-s'], script, onLine)
  }
}

/**
 * One deployment job store and runner.
 */
export class DeployManager {
  /**
   * @param {{repositoryRoot: string, dataDir: string, log?: (line:string)=>void, runnerFactory?: Function}} options options.
   */
  constructor(options) {
    this.repositoryRoot = options.repositoryRoot
    this.dataDir = options.dataDir
    this.logLine = options.log ?? (() => {})
    this.runnerFactory = options.runnerFactory ?? (plan => (plan.local === true
      ? new LocalRunner(plan, { log: line => this.logLine(line) })
      : new SshRunner(plan, { log: line => this.logLine(line) })))
    /** @type {Map<string, Promise<object>>} */
    this.running = new Map()
    /** @type {Map<string, object>} live job state, so progress reads skip the disk */
    this.states = new Map()
    /** @type {Map<string, number>} last progress flush per job */
    this.saves = new Map()
    /** @type {Map<string, Promise<void>>} per-file write chain, so a late progress write cannot win */
    this.writes = new Map()
  }

  /** @returns {Promise<void>} no owned process. */
  async dispose() {}

  /**
   * Detect the member's existing install root without changing anything.
   * @param {object} request SSH target.
   * @returns {Promise<{appRoot:string,serviceUser:string|undefined}>} detected install.
   */
  async inspectTarget(request) {
    return probeTarget({ ...request })
  }

  /**
   * Plan only; no network.
   * @param {object} request deploy options.
   * @returns {Promise<object>} plan summary.
   */
  async plan(request) {
    const plan = await buildDeployPlan({
      ...request,
      gatePassword: typeof request.gatePassword === 'string' ? request.gatePassword : process.env.DSH_GATE_PASSWORD,
      repositoryRoot: this.repositoryRoot,
    })
    return { ok: true, plan: describePlan(plan), scripts: request.includeScripts === true ? this.scripts(plan) : undefined }
  }

  /**
   * Produce all remote scripts for a plan.
   * @param {object} plan plan.
   * @returns {object} scripts.
   */
  scripts(plan) {
    if (plan.os === 'linux') {
      return {
        prepare: buildLinuxPrepareScript(plan),
        rehearse: plan.test === true ? buildLinuxRehearseScript(plan) : null,
        activate: buildLinuxActivateScript(plan),
        rollback: buildLinuxRollbackScript(plan),
      }
    }
    return {
      prepare: buildWindowsPrepareScript(plan),
      activate: buildWindowsActivateScript(plan),
      rollback: buildWindowsRollbackScript(plan),
    }
  }

  /**
   * Start a deployment or rollback job.
   *
   * `request.plan` skips the planning step when the caller already built it
   * (the panel does: it needs the release name to write the job that the
   * detached runner then adopts). `request.id` adopts an existing job id the
   * same way, so a spawned runner continues the job the panel created.
   * @param {object} request deploy options.
   * @returns {Promise<object>} job state.
   */
  async start(request) {
    const plan = request.plan !== null && typeof request.plan === 'object'
      ? request.plan
      : await buildDeployPlan({
        ...request,
        gatePassword: typeof request.gatePassword === 'string' ? request.gatePassword : process.env.DSH_GATE_PASSWORD,
        repositoryRoot: this.repositoryRoot,
      })
    const id = typeof request.id === 'string' && /^deploy-[A-Za-z0-9-]+$/u.test(request.id) ? request.id : newJobId()
    const dir = path.join(this.dataDir, id)
    await mkdir(dir, { recursive: true })
    const stateFile = path.join(dir, 'job.json')
    const logFile = path.join(dir, 'deploy.log')
    const state = {
      id,
      // `install`, `upgrade` and `test` run the same phases; the panel only
      // changes the wording, and a job keeps the label it was queued with.
      mode: request.mode === 'upgrade' ? 'upgrade' : request.mode === 'test' ? 'test' : 'install',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      member: typeof request.member === 'string' && request.member !== '' ? request.member : null,
      target: { host: plan.host, user: plan.user ?? null, port: plan.port, os: plan.os, appRoot: plan.appRoot },
      release: plan.release,
      package: plan.package.path,
      services: plan.services.map(service => service.name),
      status: 'running',
      phase: 'starting',
      error: null,
      steps: initialDeploySteps({ test: plan.test === true, os: plan.os }),
      progress: { bytes: 0, totalBytes: plan.package.bytes, percent: 0, speed: 0, indeterminate: false },
    }
    if (this.states.size >= 100) {
      const oldest = this.states.keys().next()
      if (!oldest.done) this.states.delete(oldest.value)
    }
    this.states.set(id, state)
    await writeDeployState(dir, state)
    const log = async line => {
      const stamp = new Date().toISOString()
      await writeFile(logFile, `[${stamp}] ${line}\n`, { encoding: 'utf8', flag: 'a' })
      this.logLine(line)
    }
    const task = this.#run(plan, state, stateFile, log)
    this.running.set(id, task)
    task.finally(() => this.running.delete(id)).catch(() => {})
    return { ok: true, job: state }
  }

  async #run(plan, state, stateFile, log) {
    const stamp = () => new Date().toISOString()
    const stepOf = key => state.steps.find(item => item.key === key)
    const mark = async (key, status, detail) => {
      const step = stepOf(key)
      if (step !== undefined) {
        step.status = status
        if (status === 'running' && step.startedAt === null) step.startedAt = stamp()
        if (status === 'succeeded' || status === 'failed') step.finishedAt = stamp()
        if (typeof detail === 'string' && detail !== '') step.detail = detail
      }
      state.updatedAt = stamp()
      await this.#save(stateFile, state)
    }
    const note = (key, text) => {
      const step = stepOf(key)
      if (step !== undefined) step.detail = text
      state.updatedAt = stamp()
      void log(text).catch(() => {})
    }
    // One bar for the whole job, not one per phase: `label` says what the
    // number means, so the panel reuses the same meter for the upload and for
    // the extraction instead of stacking two bars.
    const meter = (label, patch) => {
      state.progress = {
        label,
        percent: 0,
        bytes: 0,
        totalBytes: 0,
        speed: 0,
        done: 0,
        total: 0,
        indeterminate: false,
        ...patch,
      }
      state.updatedAt = stamp()
      this.#saveThrottled(stateFile, state)
    }
    try {
      const runner = this.runnerFactory(plan)
      await log(`target ${plan.host} (${plan.os}), release ${plan.release}`)
      await log(`package ${plan.package.path} (${plan.package.sha256.slice(0, 12)}…)`)
      await log(`uploading to ${plan.remotePackage}`)
      await mark('upload', 'running')
      const uploadStarted = Date.now()
      const existingBytes = typeof runner.remoteSize === 'function'
        ? await runner.remoteSize(plan.remotePackage).catch(() => null)
        : null
      if (existingBytes === plan.package.bytes) {
        await log(`package already present on the target (${formatBytes(existingBytes)}), skipping upload`)
        meter('上传安装包', { bytes: existingBytes, totalBytes: plan.package.bytes, percent: 100 })
        await mark('upload', 'succeeded', `${formatBytes(existingBytes)} · 已存在，跳过上传`)
      } else {
        // /tmp on a member is often a small tmpfs and every job leaves its
        // archive there: clear the leftovers and make sure the upload fits
        // before spending ten minutes on a transfer that dies at 70%.
        if (typeof runner.discardStalePackages === 'function') {
          if (await runner.discardStalePackages(plan.remotePackage).catch(() => false)) {
            await log('pruned package archives left by earlier deploys on the target')
          }
        }
        const freeBytes = typeof runner.remoteFreeBytes === 'function'
          ? await runner.remoteFreeBytes(plan.remotePackage).catch(() => null)
          : null
        if (freeBytes !== null) {
          await log(`target free space ${formatBytes(freeBytes)}, package ${formatBytes(plan.package.bytes)}`)
          if (freeBytes < plan.package.bytes + 64 * 1024 * 1024) {
            throw new Error(`目标剩余空间不足：${plan.remotePackage} 所在分区只剩 ${formatBytes(freeBytes)}，安装包需要 ${formatBytes(plan.package.bytes)}；清理后重试`)
          }
        }
        await runner.upload(plan.package.path, plan.remotePackage, progress => {
          const totalBytes = progress.totalBytes ?? plan.package.bytes
          meter('上传安装包', {
            bytes: progress.bytes ?? 0,
            totalBytes,
            percent: progress.percent ?? (totalBytes > 0 ? Math.min(100, Math.round(((progress.bytes ?? 0) / totalBytes) * 100)) : 0),
            speed: progress.speed ?? 0,
            indeterminate: progress.indeterminate === true,
          })
        })
        const uploadSeconds = Math.max(0.1, (Date.now() - uploadStarted) / 1000)
        meter('上传安装包', {
          bytes: plan.package.bytes,
          totalBytes: plan.package.bytes,
          percent: 100,
          speed: plan.package.bytes / uploadSeconds,
        })
        await mark('upload', 'succeeded', `${formatBytes(plan.package.bytes)} · ${uploadSeconds.toFixed(1)}s · ${formatBytes(plan.package.bytes / uploadSeconds)}/s`)
      }
      // Sign the member in with the deployer's account: the account grants in
      // `.credentials.yaml` are all a member needs, so no QR scan is required.
      const credentialsFile = deployerCredentialsFile()
      if (credentialsFile !== null) {
        try {
          await runner.upload(credentialsFile, plan.remoteCredentials)
          // The helper rides along so a package built before this feature can
          // still merge the account instead of skipping it.
          const helperFile = path.join(this.repositoryRoot, 'code', 'shared', 'credentials-merge.mjs')
          if (existsSync(helperFile)) await runner.upload(helperFile, `${plan.remoteCredentials}.mjs`)
          await log('shared the deployer\'s account sign-in')
        } catch (error) {
          await log(`account sign-in was not shared: ${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        await log('no deployer account to share (DSH_HOME/.credentials.yaml is missing)')
      }
      // Rehearse *before* prepare: prepare rewrites the member's live profile
      // and gate.env, so a package that cannot do a flat upgrade must fail the
      // job before any of that happens.
      if (plan.test === true && plan.os === 'linux') {
        state.phase = 'rehearse'
        meter('演练平铺升级', { percent: 99, indeterminate: true })
        await mark('rehearse', 'running')
        await log('rehearse: run the flat upgrade (backup, copy, wiring, restore) in a sandbox on the member')
        const rehearsed = this.scripts({ ...plan, preExtracted: false })
        await runner.script(rehearsed.rehearse, plan.os, line => note('rehearse', line))
        await mark('rehearse', 'succeeded')
      }
      state.phase = 'prepare'
      await mark('prepare', 'running')
      await log('prepare: extract, shared dirs, service definitions (no switch)')
      // Expand-Archive needs minutes for a 78k-entry package; Windows tar does
      // it in under a minute and reports one line per extracted entry.
      let preExtracted = false
      const prepareStep = stepOf('prepare')
      // Extracted entries are the only honest denominator once the upload is
      // done: the byte meter would sit at 100% through the whole extraction.
      let entries = 0
      const extractProgress = (done, total, finished = false) => {
        const percent = total > 0
          ? (finished ? 100 : Math.min(99, Math.round((done / total) * 100)))
          : 0
        if (prepareStep !== undefined) prepareStep.progress = { done, total, percent }
        meter('解压安装包', { done, total, percent, indeterminate: total === 0 })
      }
      // Counting every extracted path would push 78k lines through the SSH
      // stream, so the prepare script counts on the member and emits one
      // marker per EXTRACT_CHECKPOINT entries. The marker carries the absolute
      // entry count, which is the same unit as the total above it.
      const trackExtract = (line) => {
        const text = line.trim()
        const head = /^DSH-MESH-EXTRACT-TOTAL (\d+)$/u.exec(text)
        if (head !== null) {
          entries = Number.parseInt(head[1], 10)
          extractProgress(0, entries)
          return true
        }
        const tick = /^DSH-MESH-EXTRACT (\d+)$/u.exec(text)
        if (tick !== null) {
          const done = Number.parseInt(tick[1], 10)
          extractProgress(entries > 0 ? Math.min(done, entries) : done, entries)
          return true
        }
        return false
      }
      if (plan.os === 'windows' && typeof runner.archiveEntries === 'function' && typeof runner.extractArchive === 'function') {
        const newDir = `${plan.releases}\\${plan.release}`
        const total = await runner.archiveEntries(plan.remotePackage).catch(() => 0)
        if (total > 0) {
          await log(`extracting ${total} archive entries with tar`)
          let done = 0
          await runner.extractArchive(plan.remotePackage, newDir, () => {
            done += 1
            if (done % 500 === 0 || done === total) extractProgress(done, total)
          })
          extractProgress(total, total, true)
          preExtracted = true
        }
      }
      const scripts = this.scripts({ ...plan, preExtracted })
      await runner.script(scripts.prepare, plan.os, (line) => {
        if (trackExtract(line)) return
        note('prepare', line)
      })
      if (plan.os === 'linux' && entries > 0) extractProgress(entries, entries, true)
      await mark('prepare', 'succeeded')
      state.phase = 'activate'
      meter('切换并重启服务', { percent: 99, indeterminate: true })
      await mark('activate', 'running')
      await log('activate: switch current, restart services with the gateway last')
      await runner.script(scripts.activate, plan.os, line => note('activate', line))
      await mark('activate', 'succeeded')
      // The job is done: leave the shared meter at 100% instead of the
      // indeterminate value the last phase left behind.
      meter('切换并重启服务', { ...state.progress, percent: 100, indeterminate: false })
      state.status = 'succeeded'
      state.phase = 'done'
      state.updatedAt = stamp()
      await this.#save(stateFile, state)
      await log('deployment succeeded')
    } catch (error) {
      state.status = 'failed'
      state.phase = 'failed'
      state.error = describeDeployFailure(error instanceof Error ? error.message : String(error))
      state.updatedAt = stamp()
      const active = state.steps.find(item => item.status === 'running')
      if (active !== undefined) {
        active.status = 'failed'
        active.finishedAt = stamp()
      }
      await this.#save(stateFile, state).catch(() => {})
      await log(`deployment failed: ${state.error}`).catch(() => {})
    } finally {
      this.running.delete(state.id)
    }
  }

  /**
   * Persist upload progress at most a few times per second.
   * @param {string} stateFile job state file.
   * @param {object} state job state.
   * @returns {void}
   */
  #saveThrottled(stateFile, state) {
    const now = Date.now()
    if (now - (this.saves.get(state.id) ?? 0) < 300) return
    this.saves.set(state.id, now)
    void this.#save(stateFile, state).catch(() => {})
  }

  async #save(stateFile, state) {
    const text = `${JSON.stringify(state, null, 2)}\n`
    const tmp = `${stateFile}.${process.pid}.tmp`
    // Writes are chained per file: progress flushes are fire-and-forget, and
    // without ordering a slow one can land after the final snapshot and turn a
    // finished job back into "running". The rename makes the swap atomic, so a
    // reader in another process (the panel watching a detached runner) never
    // parses half a state file.
    const previous = this.writes.get(stateFile) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(async () => {
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, stateFile)
    })
    this.writes.set(stateFile, next.catch(() => {}))
    await next
  }

  /**
   * Finalize a job whose runner is gone: the process restarted, or a stale
   * snapshot survived a crash.
   *
   * A job is live while its promise is tracked *in this process*, and also
   * while the runner that owns it is still alive: jobs started by the panel run
   * in a detached process on purpose, so this process (the panel) usually does
   * not hold their promise. Only when both are gone is the job reported as
   * interrupted instead of a failure.
   * @param {object} state job state read from disk.
   * @returns {Promise<object>} settled state.
   */
  async #settle(state) {
    if (state === null || typeof state !== 'object') return state
    if (state.status !== 'running' && state.status !== 'queued') return state
    if (this.running.has(state.id)) return state
    const dir = path.join(this.dataDir, state.id)
    const runner = await runnerStatus(dir)
    if (runner.alive) return state
    // No readable heartbeat is not immediate proof of death: the runner may be
    // between the temporary file and the rename. Give a young job the same
    // grace as a queued one and let its own final write settle it; a job old
    // enough to have started without ever reporting is interrupted.
    if (runner.runner === null) {
      const created = Date.parse(String(state.createdAt ?? ''))
      if (!Number.isFinite(created) || Date.now() - created < RUNNER_START_GRACE_MS) return state
    }
    if (state.status === 'queued') {
      // The spawn happens right after the job directory is written; the runner
      // needs a moment to report in, and that must not read as "unknown job".
      const created = Date.parse(String(state.createdAt ?? ''))
      if (Number.isFinite(created) && Date.now() - created < RUNNER_START_GRACE_MS) return state
    }
    const log = await this.logs(state.id, 400).catch(() => '')
    const tail = log.split('\n').filter(line => line.trim() !== '').slice(-5).join('\n')
    if (/deployment succeeded/u.test(tail)) {
      state.status = 'succeeded'
      state.phase = 'done'
      state.progress = { ...(state.progress ?? {}), percent: 100, indeterminate: false }
      for (const step of state.steps ?? []) {
        if (step?.status === 'running') step.status = 'succeeded'
      }
    } else if (/deployment failed: (?<reason>.+)$/mu.test(tail)) {
      state.status = 'failed'
      state.phase = 'failed'
      state.error = state.error ?? (/deployment failed: (?<reason>.+)$/mu.exec(tail)?.groups?.reason?.trim() ?? 'deployment failed')
    } else {
      state.status = 'failed'
      state.phase = 'failed'
      state.error = state.error ?? 'deployment was interrupted before it finished'
      const why = runner.runner === null
        ? 'runner.json was unreadable'
        : `runner pid ${String(runner.runner.pid)} is gone`
      await appendDeployLog(dir, `settle: no live runner (${why}); the job is marked failed`).catch(() => {})
    }
    state.updatedAt = new Date().toISOString()
    await this.#save(path.join(dir, 'job.json'), state).catch(() => {})
    return state
  }

  /**
   * Wait for one running deployment or rollback job to settle.
   * @param {string} id job id.
   * @returns {Promise<object|null>} final job state.
   */
  async wait(id) {
    const running = this.running.get(id)
    if (running !== undefined) await running
    return this.status(id)
  }

  /**
   * Read a job.
   * @param {string} id job id.
   * @returns {Promise<object|null>} state.
   */
  async status(id) {
    if (typeof id !== 'string' || !/^deploy-[A-Za-z0-9-]+$/.test(id)) return null
    const live = this.states.get(id)
    if (live !== undefined) return live
    try {
      const stored = JSON.parse(await readFile(path.join(this.dataDir, id, 'job.json'), 'utf8'))
      return await this.#settle(stored)
    } catch {
      return null
    }
  }

  /**
   * List recent deployment jobs, newest first.
   * @param {number} [limit] maximum number of jobs.
   * @returns {Promise<object[]>} jobs.
   */
  async list(limit = 20) {
    const jobs = []
    let entries = []
    try {
      entries = await readdir(this.dataDir, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('deploy-')) continue
      try {
        const stored = JSON.parse(await readFile(path.join(this.dataDir, entry.name, 'job.json'), 'utf8'))
        jobs.push(await this.#settle(stored))
      } catch {
        // A job directory without a readable state is not worth reporting.
      }
    }
    for (const [id, live] of this.states) {
      if (!jobs.some(job => job.id === id)) jobs.push(live)
    }
    jobs.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    return jobs.slice(0, Math.max(1, Math.min(limit, 100)))
  }

  /**
   * Tail a job log.
   * @param {string} id job id.
   * @param {number} lines line count.
   * @returns {Promise<string>} log tail.
   */
  async logs(id, lines = 80) {
    if (typeof id !== 'string' || !/^deploy-[A-Za-z0-9-]+$/.test(id)) return ''
    try {
      const text = await readFile(path.join(this.dataDir, id, 'deploy.log'), 'utf8')
      return text.split('\n').slice(-Math.max(1, Math.min(lines, 500))).join('\n')
    } catch {
      return ''
    }
  }

  /**
   * Roll back to the previous release.
   * @param {object} request deploy options (target and appRoot are enough).
   * @returns {Promise<object>} job.
   */
  async rollback(request) {
    const plan = await buildDeployPlan({ ...request, repositoryRoot: this.repositoryRoot, skipPackage: true })
    const id = `deploy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const dir = path.join(this.dataDir, id)
    await mkdir(dir, { recursive: true })
    const stateFile = path.join(dir, 'job.json')
    const logFile = path.join(dir, 'deploy.log')
    const state = {
      id,
      createdAt: new Date().toISOString(),
      target: { host: plan.host, user: plan.user ?? null, port: plan.port, os: plan.os, appRoot: plan.appRoot },
      release: 'rollback',
      status: 'running',
      phase: 'rollback',
      error: null,
    }
    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    const log = async line => {
      const stamp = new Date().toISOString()
      await writeFile(logFile, `[${stamp}] ${line}\n`, { encoding: 'utf8', flag: 'a' })
      this.logLine(line)
    }
    const task = (async () => {
      try {
        const runner = this.runnerFactory(plan)
        await log('rolling back to the previous release')
        await runner.script(this.scripts(plan).rollback, plan.os)
        state.status = 'succeeded'
        state.phase = 'done'
      } catch (error) {
        state.status = 'failed'
        state.phase = 'failed'
        state.error = describeDeployFailure(error instanceof Error ? error.message : String(error))
      }
      await this.#save(stateFile, state)
      await log(state.status === 'succeeded' ? 'rollback succeeded' : `rollback failed: ${state.error}`)
    })()
    this.running.set(id, task)
    task.finally(() => this.running.delete(id)).catch(() => {})
    return { ok: true, job: state }
  }
}
