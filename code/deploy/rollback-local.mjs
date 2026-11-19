#!/usr/bin/env node
/**
 * Pointer-layout rollback.
 *
 * Run it by hand (or from a panel action): it restarts the gateway it is run
 * from, so it must not be started inside that gateway's own cgroup.
 *
 * The rollback is three steps:
 *
 *   1. flip the pointer back to `previous` (and restore `dsh-mesh.mjs` from
 *      the `.bak` written by the upgrade),
 *   2. restart the units, which all run the stable launcher,
 *   3. health-check the gateway, the embedded interop listener and the
 *      WireGuard control panel.
 *
 * If the health check fails the log keeps the reason and the process exits
 * non-zero, so the operator (or the panel) sees the rollback did not work.
 *
 *   node code/deploy/rollback-local.mjs --root /root/.dsh [--no-restart]
 *
 * @module dsh-mesh/deploy/rollback-local
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

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

const args = parseArgs(process.argv.slice(2))
const root = path.resolve(typeof args.root === 'string' && args.root !== '' ? args.root : process.env.DSH_MESH_ROOT ?? '')
if (root === '' || !existsSync(root)) {
  process.stderr.write('[rollback] --root is required and must exist\n')
  process.exit(2)
}
const noRestart = args['no-restart'] === 'true'
const pointerFile = path.join(root, 'dsh-mesh.json')
const logFile = path.join(root, 'shared', 'data', 'upgrade-rollback.log')

mkdirSync(path.dirname(logFile), { recursive: true })
const log = line => {
  appendFileSync(logFile, `${line}\n`)
  process.stdout.write(`${line}\n`)
}

if (!existsSync(pointerFile)) {
  process.stderr.write(`[rollback] not a pointer install: ${pointerFile} is missing\n`)
  process.exit(2)
}
const pointer = readJson(pointerFile)
const previous = typeof pointer?.previous === 'string' ? pointer.previous : ''
const active = typeof pointer?.active === 'string' ? pointer.active : ''
if (previous === '') {
  process.stderr.write('[rollback] no previous release in the pointer\n')
  process.exit(1)
}
log(`[rollback ${new Date().toISOString()}] layout=pointer root=${root}`)
log(`[rollback] ${active} -> ${previous}`)

const previousDir = path.isAbsolute(previous) ? previous : path.join(root, previous)
const activeDir = path.isAbsolute(active) ? active : path.join(root, active)
// layout.mjs ships with every release; prefer the previous one (the release we
// are switching to) and fall back to the active tree for a partial upgrade.
const layoutScript = [previousDir, activeDir]
  .map(dir => path.join(dir, 'code', 'install', 'layout.mjs'))
  .find(file => existsSync(file))
if (layoutScript === undefined) {
  process.stderr.write('[rollback] no code/install/layout.mjs in either release\n')
  process.exit(1)
}
const node = process.execPath
const flip = spawnSync(node, [layoutScript, 'rollback', '--root', root], { encoding: 'utf8' })
if (flip.status !== 0) {
  log(`[rollback] pointer flip failed: ${(flip.stderr || flip.stdout || '').trim()}`)
  process.exit(1)
}
log(`[rollback] pointer now ${previous}`)

if (noRestart) {
  log('[rollback] --no-restart: pointer flipped, services untouched')
  process.exit(0)
}

/** Run one command, returning true on exit 0. */
function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8' })
  return result.status === 0
}

/** Poll an URL until it answers or the deadline passes. */
async function waitFor(check, attempts, delayMs) {
  for (let index = 0; index < attempts; index += 1) {
    if (await check()) return true
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  return false
}

async function curlOk(url) {
  return run('curl', ['-fsS', url])
}

const env = readEnv(path.join(root, 'shared', 'config', 'gate.env'))
const interopEnv = readEnv(path.join(root, 'shared', 'config', 'interop.env'))
const port = env.DSH_GATE_PORT || '80'
const interopPort = interopEnv.DSH_INTEROP_PORT || '8765'
const interopBind = interopEnv.DSH_INTEROP_BIND && interopEnv.DSH_INTEROP_BIND !== '0.0.0.0' ? interopEnv.DSH_INTEROP_BIND : '127.0.0.1'
const tokenFile = path.join(root, 'shared', 'data', 'dsh-web.json')

const isWindows = process.platform === 'win32'
log(`[rollback] restarting services${isWindows ? ' (DSH-WireGuard-Control -> DSH-Mesh)' : ' (control -> dsh -> gate)'}`)
let gateRestarted = false
if (isWindows) {
  // The control panel is installed on every member now, so a rollback has to
  // move it back with the gateway. Old Windows installs may not have it yet:
  // only restart it when the SCM knows the service.
  const hasControl = run('sc.exe', ['query', 'DSH-WireGuard-Control'])
  if (hasControl) log('[rollback] restarting DSH-WireGuard-Control')
  if (hasControl) run('sc.exe', ['stop', 'DSH-WireGuard-Control'])
  run('sc.exe', ['stop', 'DSH-Mesh'])
  await new Promise(resolve => setTimeout(resolve, 3000))
  if (hasControl) run('sc.exe', ['start', 'DSH-WireGuard-Control'])
  gateRestarted = run('sc.exe', ['start', 'DSH-Mesh'])
} else {
  run('systemctl', ['daemon-reload'])
  run('systemctl', ['restart', 'dsh-wireguard-control.service'])
  if (existsSync('/etc/systemd/system/dsh-web-app.service')) {
    run('systemctl', ['restart', 'dsh-web-app.service'])
    await waitFor(() => Promise.resolve(existsSync(tokenFile)), 60, 1000)
  }
  gateRestarted = run('systemctl', ['restart', 'dsh-web-gate.service'])
  run('systemctl', ['stop', 'dsh-interop.service'])
  run('systemctl', ['disable', 'dsh-interop.service'])
}

const gateOk = gateRestarted && await waitFor(() => curlOk(`http://127.0.0.1:${port}/__gate/health`), 45, 2000)
const interopOk = await waitFor(() => curlOk(`http://${interopBind}:${interopPort}/healthz`), 30, 2000)
const controlOk = isWindows && !run('sc.exe', ['query', 'DSH-WireGuard-Control'])
  ? true
  : await waitFor(() => curlOk('http://127.0.0.1:51821/api/dsh-wireguard/health'), 30, 2000)

if (!gateOk || !interopOk || !controlOk) {
  const failed = [!gateOk && 'gate', !interopOk && 'interop', !controlOk && 'control'].filter(Boolean).join(', ')
  log(`[rollback] health check failed after rollback: ${failed}`)
  process.exit(1)
}
log(`[rollback ${new Date().toISOString()}] rolled back to ${previous}; healthy`)
process.exit(0)
