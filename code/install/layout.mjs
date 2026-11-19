#!/usr/bin/env node
/**
 * Pointer-layout installer for dsh-mesh.
 *
 * The layout it maintains:
 *
 *   <root>/dsh-mesh.mjs        stable launcher (this directory's parent script)
 *   <root>/dsh-mesh.mjs.bak    the previous launcher, kept before every replace
 *   <root>/dsh-mesh.json       pointer: which release is active / previous
 *   <root>/releases/<id>/      immutable package trees
 *   <root>/shared/config/      gate.env, TLS material
 *   <root>/shared/data/        secrets, tokens, pid files, logs
 *   <root>/shared/home/        DSH_HOME (sessions, profiles, credential store)
 *   <root>/shared/workspace/   agent workspace
 *
 * Service units (systemd on Linux) run the launcher with a role; the launcher
 * resolves the pointer and starts the active release. Upgrades never copy over
 * a running tree: extract a release, write the pointer, restart.
 *
 * Commands (all take --root, default `$DSH_MESH_ROOT` then `~/.dsh`):
 *
 *   prepare  --release <id> [--release-dir DIR]
 *            [--services name=role,...] [--no-units]
 *   activate --release <id> [--port 80] [--from VERSION] [--to VERSION]
 *   rollback
 *   status
 *
 * `prepare` is side-effect free for the running system: it only writes inside
 * the root and rewrites unit drop-ins. `activate` flips the pointer; a restart
 * is what makes it visible.
 *
 * @module dsh-mesh/install/layout
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const POINTER = 'dsh-mesh.json'
const LAUNCHER = 'dsh-mesh.mjs'
const BACKUP = 'dsh-mesh.mjs.bak'

/** Roles understood by the launcher, in restart order. */
const ROLE_ORDER = ['control', 'dsh', 'gate', 'interop']

/**
 * Read `--flag value` pairs.
 * @param {string[]} argv arguments.
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

/** The layout root: explicit flag, environment, then `~/.dsh`. */
function layoutRoot(args) {
  if (typeof args.root === 'string' && args.root !== '') return path.resolve(args.root)
  if (typeof process.env.DSH_MESH_ROOT === 'string' && process.env.DSH_MESH_ROOT !== '') return path.resolve(process.env.DSH_MESH_ROOT)
  return path.join(homedir(), '.dsh')
}

/** Read JSON, returning null when it is missing or broken. */
function readJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Write JSON atomically (write a sibling temp file, then rename). */
function writeJson(file, value, mode = 0o644) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${String(process.pid)}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode })
  renameSync(temporary, file)
}

/** True when a path is a symlink or a Windows junction. */
function isLink(target) {
  try {
    return lstatSync(target).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Create a directory link: a relative symlink on POSIX, a junction on Windows.
 * The target is always relative to the link's parent, so the tree can move.
 * @param {string} linkPath where the link appears.
 * @param {string} target relative target.
 */
function linkDirectory(linkPath, target) {
  rmSync(linkPath, { recursive: true, force: true })
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', linkPath, path.resolve(path.dirname(linkPath), target)], { stdio: 'ignore' })
    return
  }
  symlinkSync(target, linkPath, 'dir')
}

/**
 * Keep the SCM wrapper's support scripts reachable from the layout root.
 *
 * `dsh-mesh-service.exe` sits in `<root>` and launches `start.ps1` from there,
 * but it also runs `code/windows-service/select-session.ps1` and
 * `code/wireguard/ssh-agent-service.js` relative to its own directory. A
 * junction to the active release keeps those scripts exactly as current as the
 * release, so the wrapper never has to know which release is active.
 * @param {string} root layout root.
 * @param {string} releaseDir active release directory.
 * @returns {string} what happened.
 */
function linkRootCode(root, releaseDir, options = {}) {
  if (process.platform !== 'win32') return 'skipped'
  const target = path.join(releaseDir, 'code')
  if (!existsSync(target)) return 'absent'
  const link = path.join(root, 'code')
  if (!isLink(link) && existsSync(link)) return 'kept (real directory)'
  // Prepare runs before the pointer moves: an existing link still belongs to
  // the release that is serving traffic, so only the switch re-points it.
  if (options.onlyIfMissing === true && (isLink(link) || existsSync(link))) return 'kept'
  linkDirectory(link, target)
  return 'linked'
}

/** Copy a directory tree, keeping symlinks and modes. */
function copyTree(source, destination) {
  mkdirSync(destination, { recursive: true })
  execFileSync(process.platform === 'win32' ? 'cmd.exe' : 'cp', process.platform === 'win32'
    ? ['/d', '/c', 'xcopy', source, destination, '/E', '/I', '/Q', '/H', '/K', '/Y']
    : ['-a', `${source}/.`, destination], { stdio: 'ignore' })
}

/**
 * Write KEY=VALUE pairs into an env file, preserving comments and order.
 * @param {string} file env file.
 * @param {Array<[string, string]>} pairs values to set.
 */
function setEnv(file, pairs) {
  let lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/u) : []
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  for (const [key, value] of pairs) {
    const at = lines.findIndex(line => line.startsWith(`${key}=`))
    if (at === -1) lines.push(`${key}=${value}`)
    else lines[at] = `${key}=${value}`
  }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${lines.join('\n').replace(/\n+$/u, '')}\n`, { mode: 0o600 })
}

/** Parse `name=role` service specs. */
function parseServices(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  return raw.split(',').map(item => item.trim()).filter(item => item !== '').map(item => {
    const eq = item.indexOf('=')
    if (eq === -1) return { name: item, role: 'gate' }
    return { name: item.slice(0, eq).trim(), role: item.slice(eq + 1).trim() || 'gate' }
  }).sort((a, b) => {
    const order = role => ROLE_ORDER.indexOf(role) === -1 ? 99 : ROLE_ORDER.indexOf(role)
    return order(a.role) - order(b.role)
  })
}

/** The stable node that runs the launcher itself. */
function stableNode(root) {
  const candidates = process.platform === 'win32'
    ? [path.join(root, 'runtime', 'node', 'node.exe')]
    : [path.join(root, 'runtime', 'node', 'bin', 'node'), path.join(root, 'runtime', 'node', 'node')]
  const found = candidates.find(candidate => existsSync(candidate))
  if (found === undefined) throw new Error(`the layout has no stable node under ${path.join(root, 'runtime', 'node')}`)
  return found
}

/**
 * Point the profile at the plugin copies from this release.
 *
 * Copies, not symlinks: a rollback must not leave the profile pointing into a
 * release that is about to be deleted. Re-running prepare for the next release
 * replaces the copies.
 * @param {string} releaseDir package tree.
 * @param {string} profileDir DSH profile directory.
 */
function wireProfile(releaseDir, profileDir) {
  const pluginsRoot = path.join(releaseDir, 'plugins')
  const manifestFile = path.join(profileDir, 'package.json')
  mkdirSync(profileDir, { recursive: true })
  let manifest = readJson(manifestFile) ?? {
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }
  manifest.dependencies = manifest.dependencies !== null && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
  manifest.dsh = manifest.dsh !== null && typeof manifest.dsh === 'object' ? manifest.dsh : {}
  manifest.dsh.profile = manifest.dsh.profile !== null && typeof manifest.dsh.profile === 'object' ? manifest.dsh.profile : {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  if (!existsSync(pluginsRoot)) {
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
    return []
  }
  const wired = []
  for (const entry of readdirSync(pluginsRoot).sort()) {
    const dir = path.join(pluginsRoot, entry)
    if (!statSync(dir).isDirectory()) continue
    if (entry.startsWith('.') || /[.~_]/u.test(entry)) continue
    const pkg = readJson(path.join(dir, 'package.json'))
    if (pkg === null) continue
    const name = typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : entry
    if (path.basename(name) !== entry) continue
    const target = path.join(profileDir, 'node_modules', ...name.split('/'))
    rmSync(target, { recursive: true, force: true })
    mkdirSync(path.dirname(target), { recursive: true })
    copyTree(dir, target)
    manifest.dependencies[name] = `link:./node_modules/${name}`
    const isBundle = pkg.dsh !== null && typeof pkg.dsh === 'object' && pkg.dsh.bundle !== undefined
    if (isBundle && !bundles.includes(name)) bundles.push(name)
    wired.push(name)
  }
  manifest.dsh.profile.bundles = bundles
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  return wired
}

/**
 * Write (or extend) the systemd unit so it runs the launcher with a role.
 * @param {string} root layout root.
 * @param {string} node stable node path.
 * @param {{name: string, role: string}} service unit and role.
 */
function writeUnit(root, node, service) {
  const unit = service.name.endsWith('.service') ? service.name : `${service.name}.service`
  const unitFile = `/etc/systemd/system/${unit}`
  const dropin = `/etc/systemd/system/${unit}.d`
  const launcher = path.join(root, LAUNCHER)
  const envFile = path.join(root, 'shared', 'config', 'gate.env')
  mkdirSync(dropin, { recursive: true })
  writeFileSync(path.join(dropin, 'dsh-release.conf'), `[Service]
WorkingDirectory=${root}
EnvironmentFile=${envFile}
ExecStart=
ExecStart=${node} ${launcher} --role ${service.role}
`)
  if (!existsSync(unitFile)) {
    writeFileSync(unitFile, `[Unit]
Description=${unit} (dsh-mesh launcher)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${root}
EnvironmentFile=${envFile}
ExecStart=${node} ${launcher} --role ${service.role}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`)
  }
}

/** Shallow check that a release has everything the launcher needs. */
function assertRelease(releaseDir) {
  for (const rel of ['manifest.json', 'gate/server.mjs', LAUNCHER]) {
    if (!existsSync(path.join(releaseDir, rel))) throw new Error(`release is incomplete: ${path.join(releaseDir, rel)} is missing`)
  }
}

/** `prepare` implementation. */
function prepare(args, root) {
  const release = typeof args.release === 'string' ? args.release.trim() : ''
  if (release === '' || !/^[A-Za-z0-9._-]{3,80}$/u.test(release)) throw new Error('--release is required (3-80 chars of letters, digits, dot, underscore or dash)')
  const releaseDir = path.resolve(typeof args['release-dir'] === 'string' && args['release-dir'] !== ''
    ? args['release-dir']
    : path.join(root, 'releases', release))
  assertRelease(releaseDir)

  const shared = path.join(root, 'shared')
  for (const dir of ['config', 'data', 'home', 'workspace']) mkdirSync(path.join(shared, dir), { recursive: true })
  mkdirSync(path.join(root, 'releases'), { recursive: true })

  // The release carries no links: config/data/home/workspace live in shared/
  // and the launcher names them through the environment. Switching releases
  // therefore never has to move or unlink anything.

  // The launcher is the one file upgraded in place: keep the previous copy as
  // .bak so a broken launcher can be restored by hand.
  const newLauncher = path.join(releaseDir, LAUNCHER)
  const targetLauncher = path.join(root, LAUNCHER)
  let launcherState = 'written'
  const incoming = readFileSync(newLauncher)
  if (existsSync(targetLauncher)) {
    const current = readFileSync(targetLauncher)
    if (current.equals(incoming)) {
      launcherState = 'unchanged'
    } else {
      copyFileSync(targetLauncher, path.join(root, BACKUP))
      writeFileSync(targetLauncher, incoming, { mode: 0o755 })
      launcherState = 'replaced (previous kept as .bak)'
    }
  } else {
    writeFileSync(targetLauncher, incoming, { mode: 0o755 })
  }
  try {
    chmodSync(targetLauncher, 0o755)
  } catch {
    // a Windows filesystem has no executable bit
  }

  // Windows: the SCM service wrapper and its scheduled task launch scripts at
  // the layout root. They are stable shims that only hand over to the launcher,
  // so the wrapper never has to know which release is active.
  if (process.platform === 'win32') {
    const shim = [
      '$Root = Split-Path -Parent $MyInvocation.MyCommand.Path',
      '# A stopped scheduled task can leave node children listening on the stack',
      '# ports. The old package start.ps1 swept them, but the stable shim replaced',
      '# that script; without the sweep a pointer upgrade starts a gate that can',
      '# never bind while the previous release keeps answering the health check.',
      '$OwnedPorts = @(80, 8765, 31280)',
      'foreach ($Port in $OwnedPorts) {',
      '  $Owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)',
      '  foreach ($Owner in $Owners) {',
      '    if (-not $Owner -or $Owner -eq $PID) { continue }',
      '    $Process = Get-Process -Id $Owner -ErrorAction SilentlyContinue',
      '    if ($Process -and $Process.ProcessName -eq "node") { & cmd.exe /c "taskkill /PID $Owner /T /F >nul 2>&1" }',
      '  }',
      '}',
      'for ($Attempt = 0; $Attempt -lt 30; $Attempt++) {',
      '  $Busy = @(Get-NetTCPConnection -LocalPort $OwnedPorts -State Listen -ErrorAction SilentlyContinue)',
      '  if ($Busy.Count -eq 0) { break }',
      '  Start-Sleep -Milliseconds 500',
      '}',
      "$Node = Join-Path $Root 'runtime\\node\\node.exe'",
      'if (-not (Test-Path $Node)) { $Node = (Get-Command node -ErrorAction Stop).Source }',
      "& $Node (Join-Path $Root 'dsh-mesh.mjs') --role gate",
      '',
    ].join('\r\n')
    for (const name of ['start.ps1', 'start-stack.ps1']) writeFileSync(path.join(root, name), shim)
    linkRootCode(root, releaseDir, { onlyIfMissing: true })
    // The wrapper writes data\service.log next to itself; the data that matters
    // lives in shared/data.
    const dataLink = path.join(root, 'data')
    if (!existsSync(dataLink)) linkDirectory(dataLink, path.join(shared, 'data'))
  }

  // The rollback orchestrator is stable too: it restarts the gateway it is run
  // from, so it must live at a path that does not move with the release.
  const rollbackSource = path.join(releaseDir, 'code', 'deploy', 'rollback-local.mjs')
  let rollbackState = 'absent'
  if (existsSync(rollbackSource)) {
    copyFileSync(rollbackSource, path.join(root, 'rollback-local.mjs'))
    try { chmodSync(path.join(root, 'rollback-local.mjs'), 0o755) } catch { /* Windows */ }
    rollbackState = 'written'
  }

  // Node for the launcher itself: install once, never replace automatically.
  // The release keeps its own runtime for the services it starts.
  const runtimeNode = path.join(root, 'runtime', 'node')
  let runtimeState = 'kept'
  if (!existsSync(runtimeNode)) {
    copyTree(path.join(releaseDir, 'runtime', 'node'), runtimeNode)
    runtimeState = 'installed'
  }
  const node = stableNode(root)

  // gate.env stays in config/; shared paths are the only values we own.
  setEnv(path.join(shared, 'config', 'gate.env'), [
    ['DSH_HOME', path.join(shared, 'home')],
    ['DSH_WORKDIR', path.join(shared, 'workspace')],
    ['DSH_GATE_DATA_DIR', path.join(shared, 'data')],
    ['DSH_GATE_CONFIG_DIR', path.join(shared, 'config')],
  ])

  const units = parseServices(args.services)
  if (args['no-units'] !== 'true' && process.platform !== 'win32' && units.length > 0) {
    if (process.getuid?.() !== 0) throw new Error('writing systemd units needs root; pass --no-units when preparing a sandbox')
    for (const service of units) {
      writeUnit(root, node, service)
      if (service.role === 'interop') continue
      // A deploy now writes the control panel unit too, and a member that
      // reboots with no operator at the console must still come back with
      // 51821 listening. Preparation happens before activation, so only
      // `enable` is safe here; the upgrade restarts the unit afterwards.
      try {
        execFileSync('systemctl', ['enable', service.name.endsWith('.service') ? service.name : `${service.name}.service`], { stdio: 'ignore' })
      } catch {
        // A unit without an [Install] section cannot be enabled; not fatal.
      }
    }
    execFileSync('systemctl', ['daemon-reload'], { stdio: 'ignore' })
  }

  const wired = wireProfile(releaseDir, path.join(shared, 'home', 'profiles', 'web'))
  const summary = {
    ok: true,
    root,
    release,
    releaseDir,
    launcher: launcherState,
    rollback: rollbackState,
    runtime: runtimeState,
    node,
    shared,
    units: units.map(service => `${service.name} -> ${service.role}`),
    plugins: wired,
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}

/** `activate` implementation: flip the pointer. */
function activate(args, root) {
  const release = typeof args.release === 'string' ? args.release.trim() : ''
  if (release === '') throw new Error('--release is required')
  const releaseDir = path.join(root, 'releases', release)
  assertRelease(releaseDir)
  const pointerFile = path.join(root, POINTER)
  const previousPointer = readJson(pointerFile)
  const active = `releases/${release}`
  const previous = previousPointer !== null && typeof previousPointer.active === 'string' && previousPointer.active !== '' && previousPointer.active !== active
    ? previousPointer.active
    : (previousPointer?.previous ?? null)
  const state = {
    format: 1,
    layout: 'pointer',
    active,
    previous,
    updatedAt: new Date().toISOString(),
  }
  writeJson(pointerFile, state)
  linkRootCode(root, releaseDir)
  process.stdout.write(`${JSON.stringify({ ok: true, pointerFile, ...state }, null, 2)}\n`)
}

/** `rollback` implementation: make previous active again. */
function rollback(args, root) {
  const pointerFile = path.join(root, POINTER)
  const pointer = readJson(pointerFile)
  if (pointer === null || typeof pointer.previous !== 'string' || pointer.previous === '') {
    throw new Error(`nothing to roll back to: ${pointerFile} has no previous release`)
  }
  const previous = pointer.previous
  const active = pointer.active
  const previousDir = path.isAbsolute(previous) ? previous : path.join(root, previous)
  if (!existsSync(previousDir)) throw new Error(`the previous release is missing: ${previousDir}`)
  const state = {
    ...pointer,
    active: previous,
    previous: active,
    updatedAt: new Date().toISOString(),
  }
  writeJson(pointerFile, state)
  linkRootCode(root, previousDir)
  // Put back the launcher that was active before the upgrade. It is kept as
  // .bak on every replacement, and the failed release keeps its own copy, so
  // the next prepare can swap it again.
  let launcher = 'kept'
  const backupLauncher = path.join(root, BACKUP)
  if (existsSync(backupLauncher)) {
    copyFileSync(backupLauncher, path.join(root, LAUNCHER))
    try { chmodSync(path.join(root, LAUNCHER), 0o755) } catch { /* Windows has no mode bits */ }
    rmSync(backupLauncher, { force: true })
    launcher = 'restored from .bak'
  }
  // The profile copies plugins from the release; point them back so the old
  // release does not load the failed one's code.
  const plugins = wireProfile(previousDir, path.join(root, 'shared', 'home', 'profiles', 'web'))
  process.stdout.write(`${JSON.stringify({ ok: true, pointerFile, ...state, launcher, plugins }, null, 2)}\n`)
}

/** `status` implementation. */
function status(args, root) {
  const pointerFile = path.join(root, POINTER)
  const pointer = readJson(pointerFile)
  const active = pointer?.active ?? null
  const releaseDir = active === null ? null : path.isAbsolute(active) ? active : path.join(root, active)
  const manifest = releaseDir === null ? null : readJson(path.join(releaseDir, 'manifest.json'))
  const previous = pointer?.previous ?? null
  process.stdout.write(`${JSON.stringify({
    ok: releaseDir !== null && existsSync(releaseDir),
    root,
    pointerFile,
    layout: 'pointer',
    active,
    previous,
    release: releaseDir,
    version: manifest?.version ?? null,
    buildStamp: manifest?.buildStamp ?? null,
    exists: releaseDir === null ? false : existsSync(releaseDir),
  }, null, 2)}\n`)
}

const args = parseArgs(process.argv.slice(2))
const command = process.argv[2]
if (command === undefined || command.startsWith('--')) {
  process.stderr.write('usage: layout.mjs prepare|activate|rollback|status [--root DIR] ...\n')
  process.exit(2)
}
const root = layoutRoot(args)
try {
  if (command === 'prepare') prepare(args, root)
  else if (command === 'activate') activate(args, root)
  else if (command === 'rollback') rollback(args, root)
  else if (command === 'status') status(args, root)
  else throw new Error(`unknown command: ${command}`)
} catch (error) {
  process.stderr.write(`layout: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
