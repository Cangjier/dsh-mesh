#!/usr/bin/env node
/**
 * Pointer-layout upgrade: the single implementation used for the gateway and
 * for Linux members.
 *
 * Layout (root defaults to ~/.dsh, or DSH_MESH_LAYOUT_ROOT):
 *
 *   <root>/dsh-mesh.mjs      stable launcher (reads the pointer)
 *   <root>/dsh-mesh.mjs.bak  previous launcher, written before each replace
 *   <root>/dsh-mesh.json     {"active":"releases/<id>","previous":...}
 *   <root>/releases/<id>/    extracted once, never overwritten
 *   <root>/shared/           config, data, home (DSH_HOME), workspace
 *
 * The package is moved (not copied) into releases/<id>, the pointer is flipped
 * and the units — which all name the launcher — are restarted. Restarting is
 * what makes the upgrade visible.
 *
 * The layout is pointer-only: an upgrade installs a release, seeds the shared
 * directories on a first run and never copies anything from an older install.
 *
 *   node upgrade-local.mjs --stage <package tree> [--layout-root ~/.dsh]
 *        [--port 80]
 *        [--gate-port 80] [--gate-password <pw>]
 *        [--interop-bind IP] [--interop-port 8765] [--interop-provider p]
 *        [--interop-model m] [--llm-provider p] [--llm-model m] [--llm-effort e]
 *        [--services unit=role,...] [--credentials <file>]
 *        [--release <id>] [--no-restart]
 *
 * @module dsh-mesh/deploy/upgrade-local
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROLE_ORDER = { control: 0, dsh: 1, gate: 2, interop: 3 }
/** Units of the split gateway layout; a member passes its own list. */
const DEFAULT_SERVICES = [
  { unit: 'dsh-wireguard-control.service', role: 'control' },
  { unit: 'dsh-web-app.service', role: 'dsh' },
  { unit: 'dsh-web-gate.service', role: 'gate' },
  { unit: 'dsh-interop.service', role: 'interop' },
]

/** Read `--flag value` pairs. */
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

function readJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Write JSON atomically (same-directory temp + rename). */
function writeJson(file, value, mode = 0o600) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${String(process.pid)}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode })
  renameSync(temporary, file)
}

/** Read one KEY=VALUE file. */
function readEnv(file) {
  const values = {}
  if (!existsSync(file)) return values
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const at = line.indexOf('=')
    if (at <= 0) continue
    values[line.slice(0, at).trim()] = line.slice(at + 1)
  }
  return values
}

/**
 * Point a fresh profile's agent at the deployer's route. Without this a member
 * that only received shared credentials still defaults to the API-key route
 * and fails with MISSING_CREDENTIAL on its first conversation.
 * @param {string} text current cordis.patch.yml.
 * @param {Array<[string, string]>} pairs keys to set.
 * @returns {string} patched text.
 */
function mergeModelRoute(text, pairs) {
  const trailing = text === '' || text.endsWith('\n') ? '' : '\n'
  const lines = text.split('\n')
  const scalar = value => (/^[A-Za-z0-9._-]+$/u.test(value) ? value : JSON.stringify(value))
  let start = lines.findIndex(line => line.trim() === '- id: agent-default-model')
  if (start === -1) {
    const block = ['- id: agent-default-model', '  name: "@deepseek-ai/dsh-agent-default-model"', '  config:']
    for (const [key, value] of pairs) block.push(`    ${key}: ${scalar(value)}`)
    const body = lines.filter(line => line !== '').join('\n')
    return `${body === '' ? '' : `${body}\n`}${block.join('\n')}\n`
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('- ')) {
      end = index
      break
    }
  }
  const block = lines.slice(start, end)
  let configAt = block.findIndex(line => line.trim() === 'config:')
  if (configAt === -1) {
    block.push('  config:')
    configAt = block.length - 1
  }
  for (const [key, value] of pairs) {
    const at = block.findIndex(line => line.startsWith(`    ${key}:`))
    if (at !== -1) {
      block[at] = `    ${key}: ${scalar(value)}`
      continue
    }
    let insertAt = configAt + 1
    for (let index = block.length - 1; index > configAt; index -= 1) {
      if (block[index].startsWith('    ') && block[index].trim() !== '') {
        insertAt = index + 1
        break
      }
    }
    block.splice(insertAt, 0, `    ${key}: ${scalar(value)}`)
  }
  return `${[...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n')}${trailing}`
}

/** Windows cannot spawn a bare executable from a shell-free context reliably. */
const isWindows = process.platform === 'win32'

/** Run a command, inheriting stdio; true on exit 0. */
function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', windowsHide: true })
  return result.status === 0 && !result.error
}

/** Run a command and return its output ('' on failure). */
function output(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', windowsHide: true })
  return result.status === 0 ? result.stdout.trim() : ''
}

const log = line => process.stdout.write(`${line}\n`)

const args = parseArgs(process.argv.slice(2))
const stage = typeof args.stage === 'string' && args.stage !== '' ? path.resolve(args.stage) : ''
if (stage === '' || !existsSync(path.join(stage, 'manifest.json'))) {
  process.stderr.write('[upgrade] --stage must point at an extracted package with manifest.json\n')
  process.exit(2)
}
if (!existsSync(path.join(stage, 'dsh-mesh.mjs'))) {
  process.stderr.write('[upgrade] package is missing dsh-mesh.mjs\n')
  process.exit(2)
}

const root = path.resolve(
  typeof args['layout-root'] === 'string' && args['layout-root'] !== ''
    ? args['layout-root']
    : process.env.DSH_MESH_LAYOUT_ROOT
      ? process.env.DSH_MESH_LAYOUT_ROOT
      : path.join(os.homedir(), '.dsh'),
)
const noRestart = args['no-restart'] === 'true'
const gatePort = typeof args['gate-port'] === 'string' ? args['gate-port'] : (typeof args.port === 'string' ? args.port : '80')

/** Parse `unit=role` service specs; default to the split gateway units. */
function parseServices(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_SERVICES
  return raw.split(',').map(item => item.trim()).filter(Boolean).map(item => {
    const eq = item.indexOf('=')
    return eq === -1
      ? { unit: item, role: 'gate' }
      : { unit: item.slice(0, eq).trim(), role: item.slice(eq + 1).trim() }
  }).sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9))
}
const services = parseServices(args.services)

log(`[upgrade] layout root ${root}`)

const manifestBody = readFileSync(path.join(stage, 'manifest.json'))
const manifest = readJson(path.join(stage, 'manifest.json')) ?? {}
const buildStamp = typeof manifest.buildStamp === 'string' && manifest.buildStamp !== ''
  ? manifest.buildStamp
  : new Date().toISOString().replace(/[-:TZ.]/gu, '').slice(0, 14)
const release = typeof args.release === 'string' && args.release !== ''
  ? args.release
  : `${buildStamp}-${createHash('sha256').update(manifestBody).digest('hex').slice(0, 8)}`
const releaseDir = path.join(root, 'releases', release)

mkdirSync(path.join(root, 'releases'), { recursive: true })
const pointerFile = path.join(root, 'dsh-mesh.json')
const pointerBefore = readJson(pointerFile)
const previous = typeof pointerBefore?.active === 'string' && pointerBefore.active !== '' ? pointerBefore.active : ''

// ── shared directories ─────────────────────────────────────────────────────
const shared = path.join(root, 'shared')
for (const dir of ['config', 'data', 'home', 'workspace']) mkdirSync(path.join(shared, dir), { recursive: true })

// ── seed the shared env files on a first install ────────────────────────────
const envFile = path.join(shared, 'config', 'gate.env')
if (!existsSync(envFile)) {
  writeFileSync(envFile, [
    '# dsh-mesh: generated by the pointer-layout installer',
    'DSH_GATE_BIND=::',
    `DSH_GATE_PORT=${gatePort}`,
    `DSH_GATE_PASSWORD=${typeof args['gate-password'] === 'string' && args['gate-password'] !== '' ? args['gate-password'] : 'ChangeMe-Please-2026'}`,
    'DSH_GATE_COOKIE_DAYS=30',
    'DSH_WEB_PORT=31280',
    '',
  ].join('\n'), { mode: 0o600 })
  log('[upgrade] seeded shared/config/gate.env')
}
if (typeof args['interop-port'] === 'string' && args['interop-port'] !== '') {
  const interopEnv = path.join(shared, 'config', 'interop.env')
  writeFileSync(interopEnv, [
    '# generated by the dsh-mesh deploy',
    `DSH_HOME=${path.join(shared, 'home')}`,
    `DSH_WORKDIR=${path.join(shared, 'workspace')}`,
    `DSH_INTEROP_BIND=${typeof args['interop-bind'] === 'string' ? args['interop-bind'] : '127.0.0.1'}`,
    `DSH_INTEROP_PORT=${args['interop-port']}`,
    `DSH_INTEROP_PROVIDER=${typeof args['interop-provider'] === 'string' ? args['interop-provider'] : 'deepseek-account'}`,
    `DSH_INTEROP_MODEL=${typeof args['interop-model'] === 'string' ? args['interop-model'] : 'deepseek-flash'}`,
    'DSH_INTEROP_APPROVE=1',
    'DSH_INTEROP_USE_GATE_PASSWORD=1',
    '',
  ].join('\n'), { mode: 0o600 })
}

// ── install the release tree once ───────────────────────────────────────────
// A package extracted directly into releases/<id> is already in place; that is
// how install.sh runs. Everything else is moved (or copied across filesystems).
const stageDir = path.resolve(stage)
if (stageDir === releaseDir) {
  if (previous === `releases/${release}`) {
    process.stderr.write(`[upgrade] ${release} is already the active release\n`)
    process.exit(1)
  }
  log(`[upgrade] using the release already at ${releaseDir}`)
} else {
  if (existsSync(releaseDir)) {
    if (previous === `releases/${release}`) {
      process.stderr.write(`[upgrade] ${release} is already the active release\n`)
      process.exit(1)
    }
    rmSync(releaseDir, { recursive: true, force: true })
  }
  mkdirSync(path.dirname(releaseDir), { recursive: true })
  try {
    renameSync(stage, releaseDir)
  } catch {
    cpSync(stage, releaseDir, { recursive: true, force: true })
  }
  log(`[upgrade] installed release ${release}`)
}

// The stage has just been moved into releases/: `process.execPath` may point
// inside it (the activate script runs the staged node), so it no longer exists.
// Pick a node that does before spawning the layout helper.
const node = [
  process.execPath,
  path.join(releaseDir, 'runtime', 'node', 'bin', 'node'),
  path.join(releaseDir, 'runtime', 'node', 'node.exe'),
  path.join(root, 'runtime', 'node', 'bin', 'node'),
  path.join(root, 'runtime', 'node', 'node.exe'),
].find(candidate => existsSync(candidate)) ?? process.execPath
const layoutScript = path.join(releaseDir, 'code', 'install', 'layout.mjs')
if (!existsSync(layoutScript)) {
  process.stderr.write(`[upgrade] ${layoutScript} is missing\n`)
  process.exit(2)
}
const layoutRun = layoutArgs => {
  const result = spawnSync(node, [layoutScript, ...layoutArgs], { stdio: 'inherit', windowsHide: true })
  return result.status === 0 && !result.error
}
const serviceList = services.map(service => `${service.unit}=${service.role}`).join(',')
const prepareArgs = ['prepare', '--root', root, '--release', release, '--release-dir', releaseDir, '--services', serviceList]
// Sandbox/testing escape hatch: prepare the tree without touching systemd.
if (process.env.DSH_MESH_NO_UNITS === '1') prepareArgs.push('--no-units')
if (!layoutRun(prepareArgs)) {
  process.stderr.write('[upgrade] layout prepare failed; nothing was switched\n')
  process.exit(1)
}
if (!layoutRun(['activate', '--root', root, '--release', release, '--port', gatePort])) {
  process.stderr.write('[upgrade] writing the pointer failed\n')
  process.exit(1)
}

// ── point the profile at the deployer's model route ────────────────────────
const llmProvider = typeof args['llm-provider'] === 'string' ? args['llm-provider'] : ''
if (llmProvider !== '') {
  const patchFile = path.join(shared, 'home', 'profiles', 'web', 'cordis.patch.yml')
  const pairs = [['provider', llmProvider]]
  if (typeof args['llm-model'] === 'string' && args['llm-model'] !== '') pairs.push(['model', args['llm-model']])
  if (typeof args['llm-effort'] === 'string' && args['llm-effort'] !== '') pairs.push(['reasoningEffort', args['llm-effort']])
  const before = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  writeFileSync(patchFile, mergeModelRoute(before, pairs))
  log(`[upgrade] agent route ${pairs.map(([key, value]) => `${key}=${value}`).join(' ')}`)
}

// ── share the deployer's sign-in, when one travelled with the deploy ────────
const credentials = typeof args.credentials === 'string' && args.credentials !== '' ? path.resolve(args.credentials) : ''
if (credentials !== '' && existsSync(credentials)) {
  const mergeHelper = path.join(releaseDir, 'shared', 'credentials-merge.mjs')
  const mergeScript = existsSync(mergeHelper) ? mergeHelper : path.join(releaseDir, 'code', 'shared', 'credentials-merge.mjs')
  if (existsSync(mergeScript)) {
    const merged = spawnSync(node, [mergeScript, path.join(shared, 'home', '.credentials.yaml'), credentials], { stdio: 'inherit' })
    if (merged.status === 0) rmSync(credentials, { force: true })
  }
}
// ── retention: exactly the active release and its rollback target ───────────
// Members keep only these two extracted trees. Anything older is dead weight:
// it can no longer be started (the pointer never names it) and the next upgrade
// replaces `previous` anyway. A missing pointer is not a reason to wipe the
// directory, so pruning is skipped when there is no active release to keep.
const pointer = readJson(pointerFile) ?? {}
const activeNow = typeof pointer.active === 'string' ? pointer.active : ''
const previousNow = typeof pointer.previous === 'string' ? pointer.previous : ''
if (activeNow !== '') {
  const keep = new Set([activeNow, previousNow].filter(name => name !== ''))
  const releases = readdirSync(path.join(root, 'releases'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
  let removed = 0
  for (const name of releases) {
    if (keep.has(`releases/${name}`)) continue
    rmSync(path.join(root, 'releases', name), { recursive: true, force: true })
    removed += 1
  }
  log(`[upgrade] active=${activeNow} previous=${previousNow || '<none>'} kept releases=${String(keep.size)} removed=${String(removed)}`)
}

if (noRestart) {
  log('[upgrade] --no-restart: pointer flipped, services untouched')
  process.exit(0)
}

// ── restart the units, gateway last ─────────────────────────────────────────
const env = readEnv(envFile)
const port = gatePort !== '' ? gatePort : (env.DSH_GATE_PORT || '80')
const interopEnvFile = path.join(shared, 'config', 'interop.env')
const interopEnv = readEnv(interopEnvFile)
const hasInterop = existsSync(interopEnvFile)
const interopPort = interopEnv.DSH_INTEROP_PORT || '8765'
const interopHost = interopEnv.DSH_INTEROP_BIND !== undefined && interopEnv.DSH_INTEROP_BIND !== '' && interopEnv.DSH_INTEROP_BIND !== '0.0.0.0'
  ? interopEnv.DSH_INTEROP_BIND
  : '127.0.0.1'
const tokenFile = path.join(shared, 'data', 'dsh-web.json')

async function waitFor(check, attempts, delayMs) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      if (await check()) return true
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  return false
}

async function responds(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
  return response.ok
}

async function interopResponds() {
  const response = await fetch(`http://${interopHost}:${interopPort}/healthz`, { signal: AbortSignal.timeout(3000) })
  return response.ok && (await response.text()).includes('dsh-mesh-embedded-interop-v1')
}

/** Restart every unit in role order; interop is only stopped (embedded). */
function restartUnits() {
  if (isWindows) {
    // Stop everything before starting anything: the control panel must not keep
    // running while the release it reads is being replaced, and the gateway has
    // to come up last so it never advertises a half-restarted mesh.
    // Old members may not have the control-panel service installed yet; the
    // deploy adds it, so a missing service is skipped instead of failing the
    // upgrade. sc.exe returns before the stop has finished, so wait before the
    // starts; there is no synchronous sleep in Node without this.
    const owned = services.filter(entry => entry.role !== 'interop' && run('sc.exe', ['query', entry.unit]))
    if (!owned.some(entry => entry.role === 'gate')) return false
    for (const service of owned) run('sc.exe', ['stop', service.unit])
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000)
    for (const service of owned) {
      if (!run('sc.exe', ['start', service.unit])) return false
    }
    return true
  }
  run('systemctl', ['daemon-reload'])
  for (const service of services) {
    if (service.role === 'interop') continue
    // layout prepare wrote the unit a moment ago; enabling it here is what
    // makes the control panel survive a reboot without an operator login.
    if (service.role === 'control') run('systemctl', ['enable', service.unit])
    if (!run('systemctl', ['restart', service.unit])) return false
    if (service.role === 'dsh') {
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline && !existsSync(tokenFile)) spawnSync('sleep', ['1'])
    }
  }
  const interopUnit = services.find(service => service.role === 'interop')
  if (interopUnit !== undefined) {
    run('systemctl', ['stop', interopUnit.unit])
    run('systemctl', ['disable', interopUnit.unit])
  }
  return true
}

async function healthy() {
  if (!await waitFor(() => responds(`http://127.0.0.1:${port}/__gate/health`), 45, 2000)) return false
  // Installs without the embedded listener have no interop.env; do not make
  // their upgrade fail on an endpoint they never had.
  if (hasInterop && !await waitFor(interopResponds, 30, 2000)) return false
  if (services.some(service => service.role === 'control')) {
    return waitFor(() => responds('http://127.0.0.1:51821/api/dsh-wireguard/health'), 30, 2000)
  }
  return true
}

// The units are rewritten by prepare; keep their previous contents so a first
// conversion (which has no previous release) can still be undone.
const unitBackup = path.join(root, '.legacy-backup', new Date().toISOString().replace(/[-:TZ.]/gu, '').slice(0, 14))
if (!isWindows) {
  mkdirSync(unitBackup, { recursive: true })
  for (const service of services) {
    const unitFile = `/etc/systemd/system/${service.unit}`
    if (existsSync(unitFile)) copyFileSync(unitFile, path.join(unitBackup, service.unit))
    if (existsSync(`${unitFile}.d`)) cpSync(`${unitFile}.d`, path.join(unitBackup, `${service.unit}.d`), { recursive: true })
  }
}

/** Put the pre-conversion units back (first conversion only). */
function restoreUnits() {
  if (isWindows || !existsSync(unitBackup)) return
  for (const service of services) {
    const dropin = `/etc/systemd/system/${service.unit}.d`
    rmSync(dropin, { recursive: true, force: true })
    const savedUnit = path.join(unitBackup, service.unit)
    if (existsSync(savedUnit)) copyFileSync(savedUnit, `/etc/systemd/system/${service.unit}`)
    const savedDropin = path.join(unitBackup, `${service.unit}.d`)
    if (existsSync(savedDropin)) cpSync(savedDropin, dropin, { recursive: true })
  }
  run('systemctl', ['daemon-reload'])
  for (const service of services) run('systemctl', ['restart', service.unit])
}

/** Undo a failed activation: pointer flip when there is a previous release,
 *  otherwise the units (the old tree is still complete). */
async function undo() {
  if (previous !== '') {
    layoutRun(['rollback', '--root', root])
    restartUnits()
  } else {
    restoreUnits()
  }
  const ok = await waitFor(() => responds(`http://127.0.0.1:${port}/__gate/health`), 45, 2000)
  log(ok ? '[upgrade] rolled back and healthy' : '[upgrade] rolled back, gateway still unhealthy')
}

if (!restartUnits()) {
  log('[upgrade] a unit failed to restart; rolling back')
  await undo()
  process.exit(1)
}
if (!await healthy()) {
  if (!isWindows) spawnSync('journalctl', ['-u', 'dsh-web-gate.service', '-n', '60', '--no-pager'], { stdio: 'inherit' })
  log('[upgrade] health check failed; rolling back')
  await undo()
  process.exit(1)
}
log('[upgrade] gateway, interop and control panel are healthy')
