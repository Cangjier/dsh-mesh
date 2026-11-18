#!/usr/bin/env node
/**
 * dsh-mesh stable launcher.
 *
 * This file is the one entry point that never moves: it sits next to the
 * pointer (`dsh-mesh.json`), reads which release is active, and starts that
 * release's process. The releases themselves are immutable, so an upgrade is
 * "extract a new release + rewrite the pointer + restart", never a copy over
 * the running tree.
 *
 * It deliberately uses Node built-ins only. The launcher must keep working
 * when the active release is broken — that is exactly the case in which the
 * operator edits the pointer and restarts the service.
 *
 *   node dsh-mesh.mjs [--role gate|dsh|control|interop]
 *                     [--root <dir>] [--release <id|path>]
 *                     [--status] [--print-release] [--list] [--rollback]
 *
 * The root defaults to the directory holding this file, so the service unit
 * only ever names the launcher:
 *
 *   ~/.dsh/dsh-mesh.mjs
 *   ~/.dsh/dsh-mesh.json          {"format":1,"active":"releases/<id>",...}
 *   ~/.dsh/releases/<id>/         extracted package
 *   ~/.dsh/shared/                config, data, home, workspace
 *
 * @module dsh-mesh/launcher
 */

import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const POINTER_NAME = 'dsh-mesh.json'

/** What each role starts inside the active release. */
const ROLES = {
  // The gateway. In the split layout it watches DSH's token file instead of
  // spawning it; on a member it spawns DSH itself.
  gate: { entry: 'gate/server.mjs', kind: 'node' },
  // The private `dsh web` supervisor (split layout only).
  dsh: { entry: 'code/dsh-service/supervisor.mjs', kind: 'node' },
  // The WireGuard control panel on :51821.
  control: { entry: 'code/wireguard/control-service.js', kind: 'node' },
  // Standalone interop listener, only for releases that predate the embedded
  // one. Embedded releases keep this unit stopped.
  interop: { entry: 'start-interop.sh', kind: 'shell' },
}

/**
 * Read `--flag value` pairs. `--flag` alone becomes 'true'.
 * @param {string[]} argv arguments after the script name.
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

/** Strip one layer of surrounding quotes, like the shell start scripts do. */
function stripQuotes(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Parse one KEY=VALUE file.
 * @param {string} file env file.
 * @returns {Record<string, string>} values.
 */
function readEnvFile(file) {
  const values = {}
  if (!existsSync(file)) return values
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const at = line.indexOf('=')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue
    values[key] = stripQuotes(line.slice(at + 1))
  }
  return values
}

/**
 * Load KEY=VALUE files without overriding values the service manager already
 * set. Later files win over earlier ones, matching start-stack.ps1.
 * @param {string[]} files env files in priority order.
 * @param {NodeJS.ProcessEnv} env target.
 */
function loadEnvFiles(files, env) {
  for (const file of files) {
    const values = readEnvFile(file)
    for (const [key, value] of Object.entries(values)) {
      if (env[key] !== undefined && env[key] !== '') continue
      env[key] = value
    }
  }
}

/** The node binary that should run the release's scripts. */
function releaseNode(root, releaseDir) {
  const candidates = [
    path.join(releaseDir, 'runtime', 'node', 'bin', 'node'),
    path.join(releaseDir, 'runtime', 'node', 'node.exe'),
    path.join(root, 'runtime', 'node', 'bin', 'node'),
    path.join(root, 'runtime', 'node', 'node.exe'),
  ]
  const override = process.env.DSH_MESH_NODE
  if (override !== undefined && override !== '' && existsSync(override)) return override
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // keep looking
    }
  }
  return process.execPath
}

/**
 * Read the pointer. A missing file is an error: silently falling back would
 * hide a half-finished upgrade.
 * @param {string} root layout root.
 * @returns {{pointerFile: string, pointer: object}} parsed state.
 */
function readPointer(root) {
  const pointerFile = path.join(root, POINTER_NAME)
  if (!existsSync(pointerFile)) {
    throw new Error(`no pointer at ${pointerFile}; install or upgrade this machine first (it holds which release is active)`)
  }
  const parsed = JSON.parse(readFileSync(pointerFile, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.active !== 'string' || parsed.active === '') {
    throw new Error(`${pointerFile} has no "active" release; edit it or roll back`)
  }
  return { pointerFile, pointer: parsed }
}

/**
 * Resolve the active release directory. Absolute paths are accepted so an
 * operator can point at any tree while debugging.
 * @param {string} root layout root.
 * @param {string} active pointer value.
 * @returns {string} absolute release directory.
 */
function resolveRelease(root, active) {
  return path.isAbsolute(active) ? active : path.join(root, active)
}

/** Read a release's manifest without assuming it is valid JSON. */
function readManifest(releaseDir) {
  try {
    return JSON.parse(readFileSync(path.join(releaseDir, 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

/** Print the layout state as JSON, for scripts and support. */
function printStatus(root, extra = {}) {
  const { pointerFile, pointer } = readPointer(root)
  const releaseDir = resolveRelease(root, pointer.active)
  const manifest = readManifest(releaseDir)
  const previousDir = typeof pointer.previous === 'string' && pointer.previous !== ''
    ? resolveRelease(root, pointer.previous)
    : null
  const previousManifest = previousDir === null ? null : readManifest(previousDir)
  process.stdout.write(`${JSON.stringify({
    ok: existsSync(releaseDir),
    root,
    pointerFile,
    layout: 'pointer',
    active: pointer.active,
    release: releaseDir,
    version: manifest?.version ?? null,
    buildStamp: manifest?.buildStamp ?? null,
    previous: pointer.previous ?? null,
    previousVersion: previousManifest?.version ?? null,
    updatedAt: pointer.updatedAt ?? null,
    ...extra,
  }, null, 2)}\n`)
}

/** List releases as `id<TAB>version<TAB>buildStamp`, newest first. */
function printReleases(root) {
  const dir = path.join(root, 'releases')
  if (!existsSync(dir)) return
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
    .reverse()
  for (const id of entries) {
    const manifest = readManifest(path.join(dir, id))
    const version = manifest?.version ?? '?'
    const build = manifest?.buildStamp ?? '?'
    process.stdout.write(`${id}\t${version}\t${build}\n`)
  }
}

/**
 * Start the requested role and stay in front of it, so the service manager
 * (systemd or the Windows service) owns exactly one stable PID.
 * @param {object} options resolved launch options.
 * @returns {Promise<never>} resolves only on child exit.
 */
function runRole(options) {
  const { root, releaseDir, role } = options
  const spec = ROLES[role]
  if (spec === undefined) {
    throw new Error(`unknown role "${role}"; expected one of ${Object.keys(ROLES).join(', ')}`)
  }
  const entry = path.join(releaseDir, spec.entry)
  if (!existsSync(entry)) {
    throw new Error(`${releaseDir} has no ${spec.entry}; the release looks incomplete`)
  }
  const node = releaseNode(root, releaseDir)
  const env = { ...process.env }
  loadEnvFiles([
    path.join(root, 'shared', 'config', 'gate.env'),
    path.join(root, 'shared', 'config', 'interop.env'),
  ], env)
  // The release is the package root for everything it starts: its config/,
  // data/ and workspace/ already point into shared/.
  env.DSH_PACKAGE_ROOT = releaseDir
  // The layout root never moves: deploys must plan against it, not against the
  // release directory they happen to be running from.
  env.DSH_INSTALL_ROOT = root
  env.DSH_APP_DIR = env.DSH_APP_DIR || path.join(releaseDir, 'app')
  // The layout owns these three paths: a stale value inherited from the
  // caller's shell must not move DSH's home or data outside shared/.
  const gateEnv = readEnvFile(path.join(root, 'shared', 'config', 'gate.env'))
  env.DSH_HOME = gateEnv.DSH_HOME || path.join(root, 'shared', 'home')
  env.DSH_WORKDIR = gateEnv.DSH_WORKDIR || path.join(root, 'shared', 'workspace')
  env.DSH_GATE_DATA_DIR = gateEnv.DSH_GATE_DATA_DIR || path.join(root, 'shared', 'data')
  // The control service prefers this variable over PATH; point it at the same
  // node that runs the rest of the release.
  if (role === 'control') env.DSH_WIREGUARD_NODE = env.DSH_WIREGUARD_NODE || node

  const command = spec.kind === 'shell'
    ? (process.platform === 'win32' ? 'bash.exe' : 'bash')
    : node
  const args = spec.kind === 'shell' ? [entry] : [entry]
  const child = spawn(command, args, {
    cwd: releaseDir,
    env,
    stdio: 'inherit',
    windowsHide: false,
  })
  const forward = signal => {
    try {
      child.kill(signal)
    } catch {
      // the child may already be gone
    }
  }
  process.on('SIGTERM', () => forward('SIGTERM'))
  process.on('SIGINT', () => forward('SIGINT'))
  if (process.platform !== 'win32') process.on('SIGHUP', () => forward('SIGHUP'))
  child.once('error', error => {
    process.stderr.write(`dsh-mesh: cannot start ${role}: ${error.message}\n`)
    process.exit(1)
  })
  child.once('exit', (code, signal) => {
    process.exit(code === null ? (signal === 'SIGTERM' ? 143 : 1) : code)
  })
  return new Promise(() => {})
}

/**
 * Entry point.
 * @returns {Promise<void>} completion.
 */
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === 'true') {
    process.stdout.write('usage: node dsh-mesh.mjs [--role gate|dsh|control|interop] [--root DIR] [--release ID] [--status] [--print-release] [--list] [--rollback]\n')
    return
  }
  let root = process.env.DSH_MESH_ROOT || path.dirname(realpathSync(fileURLToPath(import.meta.url)))
  if (typeof args.root === 'string' && args.root !== '') root = path.resolve(args.root)

  if (args.list === 'true') {
    printReleases(root)
    return
  }
  if (args.status === 'true') {
    printStatus(root)
    return
  }
  if (args.rollback === 'true') {
    // The one primitive the rollback script needs: make `previous` active.
    // Launcher and profile follow-up stay in layout.mjs, which is versioned
    // with the package; this file must not depend on it.
    const pointerFile = path.join(root, POINTER_NAME)
    const pointer = JSON.parse(readFileSync(pointerFile, 'utf8'))
    if (typeof pointer.previous !== 'string' || pointer.previous === '') {
      throw new Error(`${pointerFile} has no previous release to roll back to`)
    }
    const next = {
      ...pointer,
      active: pointer.previous,
      previous: pointer.active,
      updatedAt: new Date().toISOString(),
    }
    const temporary = `${pointerFile}.${String(process.pid)}.tmp`
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`)
    renameSync(temporary, pointerFile)
    process.stdout.write(`${JSON.stringify({ ok: true, pointerFile, ...next }, null, 2)}\n`)
    return
  }
  const { pointer } = readPointer(root)
  const active = typeof args.release === 'string' && args.release !== '' ? args.release : pointer.active
  const releaseDir = resolveRelease(root, active)
  if (!existsSync(releaseDir)) {
    throw new Error(`active release is missing: ${releaseDir}; edit ${path.join(root, POINTER_NAME)} or use --release`)
  }
  if (args['print-release'] === 'true') {
    process.stdout.write(`${releaseDir}\n`)
    return
  }
  const role = typeof args.role === 'string' && args.role !== '' ? args.role : 'gate'
  await runRole({ root, releaseDir, role })
}

main().catch(error => {
  process.stderr.write(`dsh-mesh: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(2)
})
