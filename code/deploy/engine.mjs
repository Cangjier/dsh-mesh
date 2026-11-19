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
import { EgressProxy } from '../shared/egress.mjs'

/** The prepare script emits one extraction marker per this many entries. */
const EXTRACT_CHECKPOINT = 1000

const DEFAULT_APP_ROOT = {
  linux: '/opt/dsh-mesh',
  windows: 'C:\\dsh-mesh',
}

/**
 * Services every member runs: control panel first, gateway last.
 *
 * The control panel is not a gateway-only component. In the mesh every host is
 * a member and the panel is what tells that member whether it joined as the
 * server or as a client, so a deploy installs and starts it on all of them.
 * The role itself lives in the member's own state; the unit only starts the
 * launcher with `--role control`.
 */
const DEFAULT_SERVICES = {
  linux: [
    // The package's start.sh runs the gate, which spawns the private DSH; the
    // split services belong to the hand-installed layout, not to a package.
    { name: 'dsh-wireguard-control.service', role: 'control', command: 'start-control.sh' },
    { name: 'dsh-web-gate.service', role: 'gate', command: 'start.sh' },
  ],
  windows: [
    // The supervisor service owns the whole stack: it runs start-stack.ps1
    // (gate + interop) in the interactive session when it can, and in session 0
    // otherwise. The old split DSH-Web-App service duplicated the gate's own
    // DSH spawn and is removed by the deploy. The control panel is its own SCM
    // service so restarting the gateway never takes 51821 down with it.
    { name: 'DSH-WireGuard-Control', role: 'control', command: 'dsh-wireguard-control-service.exe' },
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
    { key: 'upload', label: '获取安装包', status: 'pending', startedAt: null, finishedAt: null, detail: '', progress: null },
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
 * The stable install root that owns `releases/`, `shared/` and the pointer.
 *
 * A member may report the directory it currently runs from: the release
 * (`…/releases/<id>`), or the `current` link of a legacy blue-green install
 * (`…/releases/<id>/current` after one nested itself into a pointer release).
 * Releases always live in `<root>/releases`, so the segment before it is the
 * stable root; anything else keeps the historical "parent of the directory"
 * rule that maps `<home>/.dsh/dsh-mesh` to `<home>/.dsh`.
 * @param {string} appRoot reported application root.
 * @param {'linux'|'windows'} os target OS, for path syntax.
 * @returns {string} layout root.
 */
export function layoutRootFor(appRoot, os) {
  const root = normalizeInstallRoot(appRoot)
  if (root === '') return root
  const separator = os === 'linux' ? '/' : '\\'
  const parts = root.split(os === 'linux' ? /\/+/u : /[\\/]+/u)
  const index = parts.lastIndexOf('releases')
  if (index > 0) {
    const prefix = parts.slice(0, index).join(separator)
    return /^[A-Za-z]:$/u.test(prefix) ? `${prefix}${separator}` : prefix
  }
  const base = os === 'linux' ? path.posix.basename(root) : path.win32.basename(root)
  if (base === '.dsh') return root
  return os === 'linux' ? path.posix.dirname(root) : path.win32.dirname(root)
}

/**
 * The extension a package should keep when it is copied to a temp path.
 *
 * `path.extname('foo.tar.gz')` is `.gz`, which still extracts correctly but
 * makes logs and stale-package cleanup harder to read. Keep the full suffix.
 * @param {string} file archive path or name.
 * @returns {string} `.tar.gz`, `.tgz`, `.zip`, or the last extension.
 */
function archiveSuffix(file) {
  const name = path.basename(String(file ?? ''))
  if (name.endsWith('.tar.gz')) return '.tar.gz'
  if (name.endsWith('.tgz')) return '.tgz'
  const extension = path.extname(name)
  return extension === '' ? '.tar.gz' : extension
}

/**
 * The basename of an archive path on the target's own OS.
 *
 * The gateway is usually Linux even when it deploys Windows, so `path.basename`
 * would keep the whole `C:\Users\...` path as one "name".
 * @param {string} file archive path.
 * @param {'linux'|'windows'} os target OS.
 * @returns {string} basename.
 */
function archiveNameFor(file, os) {
  const text = String(file ?? '')
  return os === 'windows' ? path.win32.basename(text) : path.posix.basename(text)
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
 * @param {{path: string, bytes: number, sha256: string}} [options.packageOnTarget] archive already on the target (used by the post-build upgrade).
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
  // An archive the build host already produced (and staged for its own
  // upgrade) is described by path + size + digest; there is no local file to
  // stat or hash, and the deploy must not upload it again.
  const onTarget = options.packageOnTarget !== null && typeof options.packageOnTarget === 'object'
    ? options.packageOnTarget
    : null
  // A package selected from a release has no file on this machine either. The
  // descriptor carries the archive name, size and digest the target-side
  // downloader needs; `local: false` tells the upload step that falling back to
  // a local upload is impossible.
  const descriptor = options.packageDescriptor !== null && typeof options.packageDescriptor === 'object'
    ? options.packageDescriptor
    : null
  let packagePath = ''
  let packageInfo = null
  let sha256 = ''
  let packageLocal = true
  let packageKeep = false
  if (onTarget !== null) {
    packagePath = typeof onTarget.path === 'string' ? onTarget.path.trim() : ''
    const bytes = Number(onTarget.bytes)
    sha256 = typeof onTarget.sha256 === 'string' ? onTarget.sha256.trim().toLowerCase() : ''
    if (packagePath === '') throw new Error('packageOnTarget.path is required')
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('packageOnTarget.bytes must be a positive integer')
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error('packageOnTarget.sha256 must be a 64-character hex digest')
    packageInfo = { size: bytes }
    // A build-host staging archive is deleted after extraction. An archive the
    // operator picked from the member's own package cache is not: it belongs to
    // the member and may be needed again.
    packageKeep = onTarget.keep === true
  } else if (descriptor !== null) {
    packagePath = typeof descriptor.name === 'string' ? descriptor.name.trim() : ''
    const bytes = Number(descriptor.bytes)
    sha256 = typeof descriptor.sha256 === 'string' ? descriptor.sha256.trim().toLowerCase() : ''
    if (packagePath === '' || packagePath !== path.basename(packagePath)) throw new Error('packageDescriptor.name must be an archive name')
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('packageDescriptor.bytes must be a positive integer')
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error('packageDescriptor.sha256 must be a 64-character hex digest')
    packageInfo = { size: bytes }
    packageLocal = descriptor.local !== false
  } else if (options.skipPackage !== true) {
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
  const layoutRoot = layoutRootFor(appRoot, os)
  const services = normalizeServices(options.services, os)
  const scope = options.scope === 'dsh' ? 'dsh' : 'all'
  const gatePort = String(options.gatePort ?? '80')
  if (!/^\d{1,5}$/.test(gatePort) || Number(gatePort) > 65535) throw new Error('gatePort is invalid')
  // Every install keeps exactly two extracted trees: the active release and
  // the one the pointer can roll back to. Everything older is pruned by
  // upgrade-local.mjs after the pointer flips.
  const retention = 2
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
    package: {
      path: packagePath,
      archive: archiveNameFor(packagePath, os),
      bytes: packageInfo?.size ?? 0,
      sha256,
      local: packageLocal,
      keep: packageKeep,
      onTarget: onTarget !== null,
    },
    // The archive is already on the target, so upload/download must be skipped
    // and the target path doubles as `remotePackage`.
    packageOnTarget: onTarget !== null,
    release,
    appRoot,
    layoutRoot,
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
    remotePackage: onTarget !== null
      ? packagePath
      : os === 'linux'
        ? `/tmp/dsh-mesh-${sha256.slice(0, 12)}${archiveSuffix(packagePath)}`
        : `C:\\Windows\\Temp\\dsh-mesh-${sha256.slice(0, 12)}${archiveSuffix(packagePath)}`,
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
    // When the gateway has a release configured, an upgrade may fetch the
    // archive on the member instead of receiving it through the gateway. The
    // plan carries only URLs and the proxy's SSH coordinates; tokens never
    // leave the gateway.
    download: options.download === null || options.download === undefined ? null : options.download,
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
  // Peers are often continents apart: 150 ms RTT with a few percent loss is
  // enough for cubic to collapse to a few hundred Kbps. Idempotent, non-fatal.
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
  // brought up by hand. Enable the unit (enable only — the live interface must
  // survive the deploy).
  const wgPersist = `for conf in /etc/wireguard/*.conf; do
  [ -f "$conf" ] || continue
  grep -q '^# Managed by the dsh-wireguard client bootstrap' "$conf" || continue
  iface=$(basename "$conf" .conf)
  systemctl enable "wg-quick@$iface" >/dev/null 2>&1 || true
  echo "wg-quick@$iface enabled for boot"
done
`
  // Prepare is deliberately side-effect free for the running install: it only
  // unpacks the package into a staging directory. Activate moves it into
  // releases/ and flips the pointer in one step, so a failed prepare cannot
  // leave a half-switched member.
  return `#!/usr/bin/env bash
set -euo pipefail
LAYOUT_ROOT=${sh(plan.layoutRoot)}
STAGE="$LAYOUT_ROOT/.staging/${plan.release}"
PACKAGE=${sh(plan.remotePackage)}
[ -f "$PACKAGE" ] || { echo "package is missing: $PACKAGE" >&2; exit 1; }
rm -rf "$STAGE"
mkdir -p "$STAGE" "$LAYOUT_ROOT/releases"
# One marker per ${String(EXTRACT_CHECKPOINT)} extracted entries: the deploy engine turns
# these into the panel's extraction progress.
printf 'DSH-MESH-EXTRACT-TOTAL %s\\n' "$(tar -tzf "$PACKAGE" | wc -l | tr -d ' ')"
tar -xzf "$PACKAGE" -C "$STAGE" --strip-components=1 -v | {
  extracted=0
  while IFS= read -r _entry; do
    extracted=$((extracted + 1))
    if [ $((extracted % ${String(EXTRACT_CHECKPOINT)})) -eq 0 ]; then printf 'DSH-MESH-EXTRACT %s\\n' "$extracted"; fi
  done
}
# The archive is 300+ MiB and /tmp is often a small tmpfs; a temp copy is
# deleted after extraction. A package chosen from the member's own cache is
# not a temp copy and is kept.
${plan.package?.keep === true ? '# keep the package: it was selected from the member\'s own cache' : 'rm -f "$PACKAGE"'}
chmod +x "$STAGE"/*.sh "$STAGE/dsh-mesh.mjs" 2>/dev/null || true
chmod +x "$STAGE/runtime/node/bin/node" 2>/dev/null || true
NODE="$STAGE/runtime/node/bin/node"
[ -x "$NODE" ] || NODE=$(command -v node || true)
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "the package has no usable node" >&2; exit 1; }
"$NODE" --check "$STAGE/gate/server.mjs"
${netTune}${wgPersist}echo "prepared ${plan.release} at $STAGE"
`
}

/**
 * Build the Linux activate script.
 * @param {object} plan deployment plan.
 * @returns {string} shell script.
 */
export function buildLinuxActivateScript(plan) {
  const serviceList = plan.services.map(service => `${service.name}=${service.role}`).join(',')
  const interop = plan.interop === null || plan.interop === undefined
    ? ''
    : ` --interop-bind ${sh(plan.interop.bind)} --interop-port ${sh(String(plan.interop.port))} --interop-provider ${sh(plan.interop.provider)} --interop-model ${sh(plan.interop.model)}`
  const credentials = typeof plan.remoteCredentials === 'string' && plan.remoteCredentials !== ''
    ? ` --credentials ${sh(plan.remoteCredentials)}`
    : ''
  const llm = plan.llm === null || plan.llm === undefined
    ? ''
    : ` --llm-provider ${sh(plan.llm.provider)}${plan.llm.model ? ` --llm-model ${sh(plan.llm.model)}` : ''}${plan.llm.reasoningEffort ? ` --llm-effort ${sh(plan.llm.reasoningEffort)}` : ''}`
  // One implementation for the gateway and for members: upgrade-local.mjs
  // moves the staged tree into releases/, rewrites the pointer, restarts the
  // units in role order, health-checks and rolls back on failure.
  return `#!/usr/bin/env bash
set -euo pipefail
LAYOUT_ROOT=${sh(plan.layoutRoot)}
STAGE="$LAYOUT_ROOT/.staging/${plan.release}"
[ -f "$STAGE/manifest.json" ] || { echo "prepare did not leave $STAGE behind" >&2; exit 1; }
NODE="$STAGE/runtime/node/bin/node"
[ -x "$NODE" ] || NODE=$(command -v node || true)
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo 'no usable node on the target' >&2; exit 1; }
exec "$NODE" "$STAGE/code/deploy/upgrade-local.mjs" \
  --stage "$STAGE" \
  --layout-root "$LAYOUT_ROOT" \
  --release ${sh(plan.release)} \
  --app-root ${sh(plan.appRoot)} \
  --port ${sh(plan.gatePort)} \
  --gate-port ${sh(plan.gatePort)} \
  --gate-password ${sh(plan.gatePassword || '')} \
  --services ${sh(serviceList)}${interop}${credentials}${llm}
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
  // The pointer layout has no separate flat rehearsal: every upgrade goes
  // through the same extract/pointer/restart path, and a failed activation
  // rolls back to the previous release automatically.
  return `#!/usr/bin/env bash
set -euo pipefail
echo 'test upgrade is retired: the pointer layout rehearses on every real upgrade and rolls back on failure' >&2
exit 3
`
}

/**
 * Build the Linux rollback script.
 * @param {object} plan deployment plan.
 * @returns {string} shell script.
 */
export function buildLinuxRollbackScript(plan) {
  return `#!/usr/bin/env bash
set -euo pipefail
LAYOUT_ROOT=${sh(plan.layoutRoot)}
[ -f "$LAYOUT_ROOT/rollback-local.mjs" ] || { echo "no rollback orchestrator at $LAYOUT_ROOT/rollback-local.mjs" >&2; exit 1; }
NODE="$LAYOUT_ROOT/runtime/node/bin/node"
[ -x "$NODE" ] || NODE=$(command -v node || true)
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo 'no usable node on the target' >&2; exit 1; }
exec "$NODE" "$LAYOUT_ROOT/rollback-local.mjs" --root "$LAYOUT_ROOT"
`
}

/**
 * Build the Windows prepare script.
 * @param {object} plan deployment plan.
 * @returns {string} PowerShell script.
 */
export function buildWindowsPrepareScript(plan) {
  // Prepare only unpacks: nothing about the running install changes. The
  // engine pre-extracts with tar when it can, so this is often a no-op plus
  // the single-directory flatten every dsh-mesh archive needs.
  return `$ErrorActionPreference = 'Stop'
$LayoutRoot = ${ps(plan.layoutRoot)}
$Stage = Join-Path $LayoutRoot ${ps(`.staging\\${plan.release}`)}
$Package = ${ps(plan.remotePackage)}
Write-Output "layout root $LayoutRoot"
New-Item -ItemType Directory -Force -Path $LayoutRoot, (Join-Path $LayoutRoot 'releases') | Out-Null
if (-not (Test-Path -LiteralPath $Stage)) {
  if (-not (Test-Path -LiteralPath $Package)) { throw "package is missing: $Package" }
  New-Item -ItemType Directory -Force -Path $Stage | Out-Null
  Expand-Archive -LiteralPath $Package -DestinationPath $Stage -Force
  if ($LASTEXITCODE -ne 0) { throw 'Expand-Archive failed' }
}
$inner = Get-ChildItem -LiteralPath $Stage -Directory | Select-Object -First 1
if ($inner -and (Test-Path (Join-Path $inner.FullName 'manifest.json'))) {
  Get-ChildItem -LiteralPath $inner.FullName -Force | Move-Item -Destination $Stage -Force
  Remove-Item -LiteralPath $inner.FullName -Recurse -Force
}
if (-not (Test-Path (Join-Path $Stage 'dsh-mesh.mjs'))) { throw 'package is missing dsh-mesh.mjs' }
$node = Join-Path $Stage 'runtime\\node\\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction Stop).Source }
& $node --check (Join-Path $Stage 'gate\\server.mjs')
if ($LASTEXITCODE -ne 0) { throw 'gate/server.mjs failed node --check' }
# One 300–420 MiB archive per upgrade must not pile up in the temp directory.
# A staging archive is deleted after extraction; a package chosen from the
# member's own cache is kept.
$KeepPackage = ${plan.package?.keep === true ? '$true' : '$false'}
if (-not $KeepPackage) { Remove-Item -LiteralPath $Package -Force -ErrorAction SilentlyContinue }
Write-Output "prepared ${plan.release} at $Stage"
`
}

/**
 * Build the Windows activate script.
 * @param {object} plan deployment plan.
 * @returns {string} PowerShell script.
 */
export function buildWindowsActivateScript(plan) {
  const serviceList = plan.services.map(service => `${service.name}=${service.role}`).join(',')
  const interop = plan.interop === null || plan.interop === undefined
    ? ''
    : ` --interop-bind ${ps(plan.interop.bind)} --interop-port ${ps(String(plan.interop.port))} --interop-provider ${ps(plan.interop.provider)} --interop-model ${ps(plan.interop.model)}`
  const credentials = typeof plan.remoteCredentials === 'string' && plan.remoteCredentials !== ''
    ? ` --credentials ${ps(plan.remoteCredentials)}`
    : ''
  const llm = plan.llm === null || plan.llm === undefined
    ? ''
    : ` --llm-provider ${ps(plan.llm.provider)}${plan.llm.model ? ` --llm-model ${ps(plan.llm.model)}` : ''}${plan.llm.reasoningEffort ? ` --llm-effort ${ps(plan.llm.reasoningEffort)}` : ''}`
  // Switch the pointer without restarting, then re-register the SCM service
  // against the new layout root (the C# wrapper is compiled there and only
  // ever launches the stable launcher). Starting the service is what makes the
  // new release visible.
  return `$ErrorActionPreference = 'Stop'
$LayoutRoot = ${ps(plan.layoutRoot)}
$Stage = Join-Path $LayoutRoot ${ps(`.staging\\${plan.release}`)}
$ReleaseDir = Join-Path (Join-Path $LayoutRoot 'releases') ${ps(plan.release)}
# Before the switch the package lives in $Stage, so that is where the staged
# node and the upgrade entry point are.
$stageNode = Join-Path $Stage 'runtime\\node\\node.exe'
if (-not (Test-Path $stageNode)) { $stageNode = (Get-Command node -ErrorAction Stop).Source }
$port = ${ps(plan.gatePort)}
& $stageNode (Join-Path $Stage 'code\\deploy\\upgrade-local.mjs') --stage $Stage --layout-root $LayoutRoot --release ${ps(plan.release)} --app-root ${ps(plan.appRoot)} --port $port --gate-port $port --gate-password ${ps(plan.gatePassword || '')} --services ${ps(serviceList)}${interop}${credentials}${llm} --no-restart
if ($LASTEXITCODE -ne 0) { throw "pointer switch failed (exit $LASTEXITCODE)" }
# upgrade-local.mjs moved the staging tree into $ReleaseDir (and deleted it on
# a rename), so nothing below may resolve through the staging path. Keep a node
# that survives the move: the layout's stable runtime, then the release copy.
$node = Join-Path $LayoutRoot 'runtime\\node\\node.exe'
if (-not (Test-Path $node)) { $node = Join-Path $ReleaseDir 'runtime\\node\\node.exe' }
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction Stop).Source }
# The pointer now names the new release and the root code junction points at
# it. Read the installer there (never from the stage) and roll back when it is
# missing instead of leaving a half-switched install with an old service.
$installer = Join-Path $LayoutRoot 'code\\windows-service\\install-service.ps1'
if (-not (Test-Path $installer)) { $installer = Join-Path $ReleaseDir 'code\\windows-service\\install-service.ps1' }
if (-not (Test-Path $installer)) {
  & $node (Join-Path $LayoutRoot 'rollback-local.mjs') --root $LayoutRoot
  if ($LASTEXITCODE -ne 0) { Write-Output 'rollback after a missing service installer also failed' }
  throw "missing $installer"
}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Root $LayoutRoot
if ($LASTEXITCODE -ne 0) {
  & $node (Join-Path $LayoutRoot 'rollback-local.mjs') --root $LayoutRoot
  if ($LASTEXITCODE -ne 0) { Write-Output 'rollback after a failed service install also failed' }
  throw 'service installation failed after the pointer switch; rolled back'
}
# The control panel is a per-member service, not a gateway extra: register it
# against the stable layout root and let the launcher pick the active release,
# so an upgrade never leaves 51821 pointing at a release that is about to go.
# The stage may already be gone (a successful rename moves it into releases/),
# so read the installer through the stable code junction when it exists.
$controlInstaller = Join-Path $LayoutRoot 'code\\wireguard\\windows-service\\install-control-service.ps1'
if (-not (Test-Path $controlInstaller)) { $controlInstaller = Join-Path $ReleaseDir 'code\\wireguard\\windows-service\\install-control-service.ps1' }
if (-not (Test-Path $controlInstaller)) {
  & $node (Join-Path $LayoutRoot 'rollback-local.mjs') --root $LayoutRoot
  if ($LASTEXITCODE -ne 0) { Write-Output 'rollback after a missing control panel installer also failed' }
  throw 'missing the control panel installer in the new release'
}
$stableNode = Join-Path $LayoutRoot 'runtime\\node\\node.exe'
if (-not (Test-Path $stableNode)) { $stableNode = Join-Path $ReleaseDir 'runtime\\node\\node.exe' }
if (-not (Test-Path $stableNode)) { $stableNode = $node }
$dshHome = Join-Path $LayoutRoot 'shared\\home'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $controlInstaller -Root $LayoutRoot -NodePath $stableNode -DshHome $dshHome
if ($LASTEXITCODE -ne 0) {
  & $node (Join-Path $LayoutRoot 'rollback-local.mjs') --root $LayoutRoot
  if ($LASTEXITCODE -ne 0) { Write-Output 'rollback after a failed control panel install also failed' }
  throw 'control panel installation failed after the pointer switch; rolled back'
}
$deadline = (Get-Date).AddSeconds(180)
$gateHealthy = $false
while ((Get-Date) -lt $deadline) {
  try {
    $response = Invoke-WebRequest -Uri ("http://127.0.0.1:" + $port + "/__gate/health") -UseBasicParsing -TimeoutSec 3
    if ($response.StatusCode -eq 200) { $gateHealthy = $true; break }
  } catch { }
  Start-Sleep -Seconds 3
}
if (-not $gateHealthy) {
  & $node (Join-Path $LayoutRoot 'rollback-local.mjs') --root $LayoutRoot
  if ($LASTEXITCODE -ne 0) { Write-Output 'rollback after a failed health check also failed' }
  throw 'gateway health check failed after the pointer switch; rolled back'
}
$controlDeadline = (Get-Date).AddSeconds(120)
$controlHealthy = $false
while ((Get-Date) -lt $controlDeadline) {
  try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:51821/api/dsh-wireguard/health' -UseBasicParsing -TimeoutSec 3
    if ($response.StatusCode -eq 200) { $controlHealthy = $true; break }
  } catch { }
  Start-Sleep -Seconds 3
}
if (-not $controlHealthy) {
  & $node (Join-Path $LayoutRoot 'rollback-local.mjs') --root $LayoutRoot
  if ($LASTEXITCODE -ne 0) { Write-Output 'rollback after a failed control panel health check also failed' }
  throw 'control panel health check on 51821 failed after the pointer switch; rolled back'
}
Write-Output 'gateway and control panel are healthy'
`
}

/**
 * Build the Windows rollback script.
 * @param {object} plan deployment plan.
 * @returns {string} PowerShell script.
 */
export function buildWindowsRollbackScript(plan) {
  return `$ErrorActionPreference = 'Stop'
$LayoutRoot = ${ps(plan.layoutRoot)}
$node = Join-Path $LayoutRoot 'runtime\\node\\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction Stop).Source }
& $node (Join-Path $LayoutRoot 'rollback-local.mjs') --root $LayoutRoot
if ($LASTEXITCODE -ne 0) { throw 'rollback failed' }
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
      plan.packageOnTarget === true
        ? `use the package already on the target (${plan.package.path}); no download or upload`
        : `obtain ${plan.package.archive ?? path.basename(plan.package.path)}: download from the release when configured, else upload to ${plan.remotePackage}`,
      `extract and prepare ${plan.releases}/${plan.release} (no service switch)`,
      `update shared config and service definitions for ${plan.appRoot}/current`,
      `switch ${plan.current} to ${plan.release}`,
      ...plan.services
        .filter(service => plan.scope === 'all' || service.role !== 'gate')
        .map(service => `restart ${service.name} (${service.role})`),
      `health check http://127.0.0.1:${plan.gatePort}/__gate/health`,
      ...(plan.services.some(service => service.role === 'control')
        ? ['health check http://127.0.0.1:51821/api/dsh-wireguard/health']
        : []),
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
 * Bash snippet that finds a Node runtime on a Linux member.
 * @param {string} appRoot install root reported by the member.
 * @returns {string} script.
 */
export function linuxNodeProbeScript(appRoot) {
  const root = String(appRoot ?? '').replace(/[\\/]+$/u, '')
  const candidates = [
    ...(root === '' ? [] : [`${root}/current/runtime/node/bin/node`, `${root}/current/runtime/node/node`, `${root}/runtime/node/bin/node`, `${root}/runtime/node/node`]),
    '$HOME/.dsh/dsh-mesh/current/runtime/node/bin/node',
    '$HOME/.dsh/dsh-mesh/current/runtime/node/node',
    '$HOME/.dsh/dsh-person-web/current/runtime/node/bin/node',
  ]
  return [
    'for candidate in \\',
    ...candidates.map(value => `  "${value}" \\`),
    '  ; do',
    '  if [ -x "$candidate" ]; then echo "DSH-MESH-NODE=$candidate"; exit 0; fi',
    'done',
    'found=$(command -v node 2>/dev/null || true)',
    'if [ -n "$found" ]; then echo "DSH-MESH-NODE=$found"; fi',
    '',
  ].join('\n')
}

/**
 * PowerShell snippet that finds a Node runtime on a Windows member.
 * @param {string} appRoot install root reported by the member.
 * @returns {string} script.
 */
export function windowsNodeProbeScript(appRoot) {
  const root = String(appRoot ?? '').replace(/[\\/]+$/u, '')
  const quoted = root === '' ? [] : [ps(`${root}\\current\\runtime\\node\\node.exe`), ps(`${root}\\runtime\\node\\node.exe`)]
  const candidates = [
    ...quoted,
    "(Join-Path $env:USERPROFILE '.dsh\\dsh-mesh\\current\\runtime\\node\\node.exe')",
    "(Join-Path $env:USERPROFILE '.dsh\\dsh-person-web\\current\\runtime\\node\\node.exe')",
  ]
  return `$ErrorActionPreference = 'Stop'
$candidates = @(
${candidates.map(value => `  ${value}`).join(',\n')}
)
foreach ($candidate in $candidates) {
  if ($candidate -and (Test-Path -LiteralPath $candidate)) { Write-Output ("DSH-MESH-NODE=" + $candidate); exit 0 }
}
$cmd = Get-Command node.exe -ErrorAction SilentlyContinue
if ($cmd) { Write-Output ("DSH-MESH-NODE=" + $cmd.Source) }
`
}

/**
 * Normalize the release manifest list carried by a deploy plan.
 *
 * New plans carry `{provider, url}` entries so the downloader knows that
 * GitHub (and only GitHub) goes through the egress proxy. A plan queued by an
 * older build may still have `manifestUrls`; the hostname is enough to classify
 * those.
 * @param {object} download plan download spec.
 * @returns {Array<{provider: 'github'|'gitee', url: string}>} manifests.
 */
export function normalizeDownloadManifests(download) {
  if (download === null || typeof download !== 'object') return []
  const entries = Array.isArray(download.manifests) ? download.manifests : []
  const normalized = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const provider = entry.provider === 'github' ? 'github' : entry.provider === 'gitee' ? 'gitee' : ''
    if (provider === '' || typeof entry.url !== 'string' || entry.url === '') continue
    normalized.push({ provider, url: entry.url })
  }
  if (normalized.length > 0) return normalized
  for (const url of Array.isArray(download.manifestUrls) ? download.manifestUrls : []) {
    if (typeof url !== 'string' || url === '') continue
    let host = ''
    try { host = new URL(url).hostname } catch { host = '' }
    normalized.push({ provider: /(?:^|\.)github\.com$|githubusercontent\.com$/iu.test(host) ? 'github' : 'gitee', url })
  }
  return normalized
}

/**
 * The command that runs the target-side downloader.
 * @param {object} plan deployment plan.
 * @param {{node: string, remoteDir: string, manifests: string[], proxyUrl: string|null, prefer?: 'github'|'gitee'}} options options.
 * @returns {string} bash or PowerShell script.
 */
export function releaseDownloadScript(plan, options) {
  const archive = plan.package.archive ?? path.basename(plan.package.path)
  const prefer = options.prefer === 'gitee' ? '--prefer gitee' : ''
  const manifestArgs = options.manifests
    .map(entry => `--manifest-${entry.provider} ${plan.os === 'windows' ? ps(entry.url) : sh(entry.url)}`)
    .join(' ')
  if (plan.os === 'windows') {
    const script = `${options.remoteDir}\\deploy\\release-download.mjs`
    const args = [
      manifestArgs,
      `--archive ${ps(archive)}`,
      `--sha256 ${ps(plan.package.sha256)}`,
      `--output ${ps(plan.remotePackage)}`,
      options.proxyUrl === null ? '' : `--proxy ${ps(options.proxyUrl)}`,
      `--workdir ${ps(`${options.remoteDir}\\parts`)}`,
      prefer,
    ].filter(Boolean).join(' ')
    return `$ErrorActionPreference = 'Stop'
& ${ps(options.node)} ${ps(script)} ${args}
exit $LASTEXITCODE
`
  }
  const script = `${options.remoteDir}/deploy/release-download.mjs`
  const args = [
    manifestArgs,
    `--archive ${sh(archive)}`,
    `--sha256 ${sh(plan.package.sha256)}`,
    `--output ${sh(plan.remotePackage)}`,
    options.proxyUrl === null ? '' : `--proxy ${sh(options.proxyUrl)}`,
    `--workdir ${sh(`${options.remoteDir}/parts`)}`,
    prefer,
  ].filter(Boolean).join(' ')
  return `set -u
${sh(options.node)} ${sh(script)} ${args}
exit $?
`
}

/**
 * Create the downloader's remote directory tree.
 * @param {object} plan deployment plan.
 * @param {string} remoteDir remote root.
 * @returns {string} script.
 */
export function ensureDownloadDirScript(plan, remoteDir) {
  if (plan.os === 'windows') {
    return `New-Item -ItemType Directory -Force -Path ${ps(`${remoteDir}\\deploy`)},${ps(`${remoteDir}\\shared`)} | Out-Null
`
  }
  return `mkdir -p ${sh(`${remoteDir}/deploy`)} ${sh(`${remoteDir}/shared`)}
`
}

/**
 * Remove the downloader's remote directory tree.
 * @param {object} plan deployment plan.
 * @param {string} remoteDir remote root.
 * @returns {string} shell command (SSH) for the member.
 */
export function removeDownloadDirCommand(plan, remoteDir) {
  return plan.os === 'windows' ? `cmd /c rmdir /s /q "${remoteDir}"` : `rm -rf ${sh(remoteDir)}`
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
      packageOnTarget: plan.packageOnTarget === true,
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
      await mark('upload', 'running')
      const uploadStarted = Date.now()
      const existingBytes = typeof runner.remoteSize === 'function'
        ? await runner.remoteSize(plan.remotePackage).catch(() => null)
        : null
      if (plan.packageOnTarget === true) {
        // A post-build upgrade reads the archive the build host just produced.
        // There is no local copy to upload (and none may be deleted as a stale
        // temp file), so the only two outcomes are "usable" and "gone".
        if (existingBytes !== plan.package.bytes) {
          throw new Error(`编译机上的安装包不可用：${plan.package.path} ${existingBytes === null ? '不存在' : `只有 ${formatBytes(existingBytes)}，应为 ${formatBytes(plan.package.bytes)}`}`)
        }
        const localLabel = plan.package.keep === true ? '目标成员本地包' : '编译机本地包'
        meter(`使用${localLabel}`, { bytes: existingBytes, totalBytes: plan.package.bytes, percent: 100 })
        await mark('upload', 'succeeded', `${formatBytes(existingBytes)} · ${localLabel}，跳过下载/上传`)
        await log(`using the package already on the target (${plan.package.path}), skipping download and upload`)
      } else if (existingBytes === plan.package.bytes) {
        await log(`package already present on the target (${formatBytes(existingBytes)}), skipping download and upload`)
        meter('获取安装包', { bytes: existingBytes, totalBytes: plan.package.bytes, percent: 100 })
        await mark('upload', 'succeeded', `${formatBytes(existingBytes)} · 已存在，跳过下载/上传`)
      } else {
        // /tmp on a member is often a small tmpfs and every job leaves its
        // archive there: clear the leftovers and make sure the package fits
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
          // A release download may assemble Gitee parts beside the output; the
          // downloader deletes parts as it goes, so one part of headroom is
          // enough. The plain upload path needs only the archive itself.
          const headroom = plan.download === null ? 64 * 1024 * 1024 : 96 * 1024 * 1024 + 64 * 1024 * 1024
          const needed = plan.package.bytes + headroom
          await log(`target free space ${formatBytes(freeBytes)}, package ${formatBytes(plan.package.bytes)}, needed ${formatBytes(needed)}`)
          if (freeBytes < needed) {
            throw new Error(`目标剩余空间不足：${plan.remotePackage} 所在分区只剩 ${formatBytes(freeBytes)}，本次需要 ${formatBytes(needed)}；清理后重试`)
          }
        }
        // An upgrade prefers the release: the member downloads the package
        // itself (through a member with good internet), so hundreds of
        // megabytes never cross the gateway. Any failure falls back to the
        // existing gateway upload instead of failing the upgrade.
        const downloaded = await this.#downloadFromRelease(plan, runner, { log, meter, mark })
        if (!downloaded) {
          // A release-only plan carries an archive *name*, not a file. Uploading
          // it would scp a path that does not exist on the gateway and hide the
          // real reason behind an SSH error.
          if (plan.package.local === false) {
            throw Object.assign(
              new Error('Release 下载失败，且网关没有这个包的本地副本；请改用「目标成员已有包」，或把包放到本机 ~/.dsh/packages 后重试'),
              { code: 'release_download_failed' },
            )
          }
          await log(`uploading to ${plan.remotePackage}`)
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
        const newDir = `${plan.layoutRoot}\\.staging\\${plan.release}`
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
   * Try to fetch the package on the member from the configured release.
   *
   * Nothing here is fatal: a missing runtime, an unreachable release, a bad
   * proxy, or a checksum mismatch all return false and the caller falls back
   * to the gateway upload. That keeps a release outage from blocking an
   * upgrade while still making the release the default path.
   * @param {object} plan deployment plan.
   * @param {object} runner SSH runner.
   * @param {{log: Function, meter: Function, mark: Function}} hooks progress sinks.
   * @returns {Promise<boolean>} whether the verified package is on the target.
   */
  async #downloadFromRelease(plan, runner, hooks) {
    const { log, meter, mark } = hooks
    const download = plan.download
    if (download === null || typeof download !== 'object') return false
    const manifests = normalizeDownloadManifests(download)
    if (manifests.length === 0) return false
    const suffix = plan.package.sha256.slice(0, 12)
    const remoteDir = plan.os === 'windows'
      ? `C:\\Windows\\Temp\\dsh-mesh-release-${suffix}`
      : `/tmp/dsh-mesh-release-${suffix}`
    let egress = null
    let proxyUrl = null
    try {
      const node = await this.#findTargetNode(plan, runner)
      if (node === '') {
        await log('release download skipped: the target has no Node runtime to run the downloader')
        return false
      }
      const localDownloader = path.join(this.repositoryRoot, 'code', 'deploy', 'release-download.mjs')
      const localClient = path.join(this.repositoryRoot, 'code', 'shared', 'http-client.mjs')
      if (!existsSync(localDownloader) || !existsSync(localClient)) {
        await log('release download skipped: the downloader files are missing from this plugin installation')
        return false
      }
      if (plan.os === 'windows') {
        await runner.script(ensureDownloadDirScript(plan, remoteDir), 'windows')
      } else {
        await runner.runProcess('ssh', [...runner.sshOptions(), runner.target(), ensureDownloadDirScript(plan, remoteDir)])
      }
      const join = (name) => plan.os === 'windows' ? `${remoteDir}\\${name.replace(/\//gu, '\\')}` : `${remoteDir}/${name}`
      await runner.upload(localDownloader, join('deploy/release-download.mjs'))
      await runner.upload(localClient, join('shared/http-client.mjs'))
      const needsProxy = manifests.some(entry => entry.provider === 'github')
      if (download.proxy !== null && typeof download.proxy === 'object' && needsProxy) {
        if (download.proxy.kind === 'link' && typeof download.proxy.url === 'string' && download.proxy.url !== '') {
          // The link's HTTP proxy runs on the target itself and forwards over
          // hysteria2, so there is no egress process to start here.
          proxyUrl = download.proxy.url
          await log(`release download through direct link ${download.proxy.name ?? ''} (${proxyUrl}); Gitee is fetched directly`)
        } else {
          try {
            egress = new EgressProxy({ log: line => { void log(`download proxy: ${line}`) } })
            const started = await egress.start({ plan: download.proxy, member: download.proxy.name ?? download.proxy.host })
            proxyUrl = started.url
            await log(`release download through ${download.proxy.name ?? download.proxy.host} proxy (${proxyUrl}); Gitee is fetched directly`)
          } catch (error) {
            egress?.closeAll()
            egress = null
            proxyUrl = null
            await log(`download proxy unavailable (${error instanceof Error ? error.message : String(error)}); trying a direct release download`)
          }
        }
      } else if (download.proxy !== null && typeof download.proxy === 'object') {
        await log('release download has only Gitee manifests; the proxy is not used')
      } else {
        await log('release download has no proxy configured; GitHub and Gitee are both fetched directly')
      }
      meter('从 Release 下载安装包', { percent: 0, indeterminate: true })
      if (download.prefer === 'gitee') {
        await log('release download prefers Gitee; GitHub is the fallback (and may use the proxy)')
      }
      const script = releaseDownloadScript(plan, { node, remoteDir, manifests, proxyUrl, prefer: download.prefer })
      let total = plan.package.bytes
      let bytes = 0
      let source = ''
      let speed = 0
      let lastAt = Date.now()
      let lastBytes = 0
      const startedAt = Date.now()
      let failure = null
      try {
        await runner.script(script, plan.os, (line) => {
          const planMatch = /^DSH-MESH-DOWNLOAD-PLAN (\d+)$/u.exec(line)
          if (planMatch !== null) {
            total = Number.parseInt(planMatch[1], 10) || total
            return
          }
          const manifestMatch = /^DSH-MESH-DOWNLOAD-MANIFEST (\S+) (\S+)$/u.exec(line)
          if (manifestMatch !== null) {
            void log(`release manifest ${manifestMatch[1]}: ${manifestMatch[2]}`)
            return
          }
          const sourceMatch = /^DSH-MESH-DOWNLOAD-SOURCE (github|gitee)$/u.exec(line)
          if (sourceMatch !== null) {
            source = sourceMatch[1] === 'gitee' ? 'Gitee Release' : 'GitHub Release'
            return
          }
          const progressMatch = /^DSH-MESH-DOWNLOAD (\d+) (\d+)$/u.exec(line)
          if (progressMatch !== null) {
            bytes = Number.parseInt(progressMatch[1], 10)
            total = Number.parseInt(progressMatch[2], 10) || total
            const now = Date.now()
            const seconds = Math.max(0.001, (now - lastAt) / 1000)
            speed = bytes >= lastBytes ? (bytes - lastBytes) / seconds : 0
            lastAt = now
            lastBytes = bytes
            meter('从 Release 下载安装包', {
              bytes,
              totalBytes: total,
              percent: total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : 0,
              speed,
            })
            return
          }
          if (/^DSH-MESH-DOWNLOAD-(?:OK|PART|DONE|PROGRESS) /u.test(line)) return
          void log(line)
        })
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      // The exit code is only half the truth: check what actually landed.
      const landed = typeof runner.remoteSize === 'function'
        ? await runner.remoteSize(plan.remotePackage).catch(() => null)
        : null
      if (failure === null && landed === plan.package.bytes) {
        const seconds = Math.max(0.1, (Date.now() - startedAt) / 1000)
        // Only GitHub uses the proxy; Gitee is always direct.
        const via = source === 'Gitee Release'
          ? 'Gitee 直连'
          : proxyUrl === null
            ? 'GitHub 直连'
            : `GitHub 经 ${download.proxy?.name ?? download.proxy?.host ?? '外网主机'} 代理`
        meter('从 Release 下载安装包', { bytes: landed, totalBytes: landed, percent: 100, speed: landed / seconds })
        await mark('upload', 'succeeded', `${formatBytes(landed)} · ${source === '' ? 'Release' : source} 下载（${via}）${seconds.toFixed(1)}s · ${formatBytes(landed / seconds)}/s`)
        await log(`downloaded the package from ${source === '' ? 'the release' : source} (${via})`)
        return true
      }
      await log(`release download did not produce a usable package (${failure ?? `size ${String(landed)} instead of ${String(plan.package.bytes)}`}); ${plan.package.local === false ? 'there is no local copy to upload' : 'falling back to a gateway upload'}`)
      return false
    } catch (error) {
      await log(`release download failed (${error instanceof Error ? error.message : String(error)}); ${plan.package.local === false ? 'there is no local copy to upload' : 'falling back to a gateway upload'}`)
      return false
    } finally {
      egress?.closeAll()
      await runner.runProcess('ssh', [...runner.sshOptions(), runner.target(), removeDownloadDirCommand(plan, remoteDir)]).catch(() => {})
    }
  }

  /**
   * Locate a Node runtime on the target without assuming the service user's home.
   * @param {object} plan deployment plan.
   * @param {object} runner SSH runner.
   * @returns {Promise<string>} absolute path or ''.
   */
  async #findTargetNode(plan, runner) {
    let node = ''
    const script = plan.os === 'windows' ? windowsNodeProbeScript(plan.appRoot) : linuxNodeProbeScript(plan.appRoot)
    await runner.script(script, plan.os, (line) => {
      const match = /^DSH-MESH-NODE=(.+)$/u.exec(line.trim())
      if (match !== null && node === '') node = match[1].trim()
    }).catch(() => {})
    return node
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
