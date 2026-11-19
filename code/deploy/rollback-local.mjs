#!/usr/bin/env node
/**
 * Pointer-layout rollback.
 *
 * The gateway's acceptance page ("回退") starts `rollback-local.mjs` in its own
 * transient systemd unit, because the script restarts the gateway it is
 * talking to. That shim delegates here when the install uses the pointer
 * layout (`<root>/dsh-mesh.json`).
 *
 * The rollback is three steps:
 *
 *   1. flip the pointer back to `previous` (and restore `dsh-mesh.mjs` from
 *      the `.bak` written by the upgrade),
 *   2. restart the units, which all run the stable launcher,
 *   3. health-check the gateway, the embedded interop listener and the
 *      WireGuard control panel.
 *
 * If the health check fails the acceptance marker is put back with
 * `status: "failed"` so the page tells the operator instead of silently
 * forgetting that the rollback did not work.
 *
 *   node code/deploy/rollback-local.mjs --root /root/.dsh [--no-restart]
 *
 * @module dsh-mesh/deploy/rollback-local
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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

/** Write atomically so a crash cannot leave a half marker. */
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

const args = parseArgs(process.argv.slice(2))
const root = path.resolve(typeof args.root === 'string' && args.root !== '' ? args.root : process.env.DSH_MESH_ROOT ?? '')
if (root === '' || !existsSync(root)) {
  process.stderr.write('[rollback] --root is required and must exist\n')
  process.exit(2)
}
const noRestart = args['no-restart'] === 'true'
const pointerFile = path.join(root, 'dsh-mesh.json')
const markerFile = path.join(root, 'shared', 'data', 'upgrade-pending.json')
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
const markerBefore = readJson(markerFile) ?? {}
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
  writeJson(markerFile, { ...markerBefore, status: 'failed', error: '指针回退失败', rollbackFinishedAt: new Date().toISOString() })
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
const port = env.DSH_GATE_PORT || markerBefore.port || '80'
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
  } else {
    run('systemctl', ['restart', 'dsh-web.service'])
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
  writeJson(markerFile, { ...markerBefore, status: 'failed', error: `回退后健康检查失败：${failed}`, rollbackFinishedAt: new Date().toISOString() })
  process.exit(1)
}
log(`[rollback ${new Date().toISOString()}] rolled back to ${previous}; healthy`)
process.exit(0)
