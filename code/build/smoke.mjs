/**
 * Build-time smoke test: start the built package and look at it in Chrome.
 *
 * A package can be byte-perfect, upgrade cleanly, and still ship a UI that
 * never boots (a client-module revision mismatch, a profile that was not
 * wired, a missing runtime). The only check that catches that is the one a
 * user performs: open the URL, log in, and see whether the DSH shell and the
 * Mesh panel actually render.
 *
 * This module does exactly that, with no npm dependency beyond the CDP driver
 * in `code/shared/chrome.mjs`:
 *
 *   1. Lay the package out as a disposable flat install (symlinks for the big
 *      directories, a fresh DSH_HOME, a free port).
 *   2. Wire the profile with the package's own `wire-profile.mjs`.
 *   3. Start the packaged supervisor and gateway.
 *   4. Drive headless Chrome over CDP: solve the password gate, wait for the
 *      DSH shell, click the "Mesh" sidebar entry, and capture screenshots.
 *
 * `runPackageSmoke` is for a freshly assembled package (used by the build
 * pipeline). `runInstallSmoke` is for an already-upgraded sandbox (used by the
 * test-upgrade rehearsal).
 *
 * @module dsh-mesh/build/smoke
 */

import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { ChromeSession } from '../shared/chrome.mjs'

/** Sidebar label the dsh-mesh client registers. */
const MESH_LABEL = 'Mesh'

/** Default viewport: wide enough for the sidebar and a desktop panel. */
const VIEWPORT = { width: 1440, height: 900 }

/** How long DSH may take to print its launch URL on a cold profile. */
const DEFAULT_START_TIMEOUT_MS = 180_000

/** How long the browser may take to finish the UI boot. */
const DEFAULT_PAGE_TIMEOUT_MS = 240_000

/** How long the Mesh panel may spend in its boot state on a cold profile. */
const DEFAULT_PANEL_TIMEOUT_MS = 150_000

/**
 * Candidate Chrome/Chromium binaries for the current platform.
 * @param {NodeJS.ProcessEnv} env environment.
 * @returns {string[]} paths, most explicit first.
 */
export function chromeCandidates(env = process.env) {
  const configured = [env.DSH_MESH_SMOKE_CHROME, env.DSH_GATE_CHROME]
    .filter(value => typeof value === 'string' && value !== '')
  const common = process.platform === 'win32'
    ? [
        path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/opt/google/chrome/chrome',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/usr/lib/chromium/chromium',
          '/snap/bin/chromium',
        ]
  return [...configured, ...common].filter(value => value !== '')
}

/**
 * First runnable Chrome/Chromium.
 * @param {NodeJS.ProcessEnv} env environment.
 * @returns {string|null} binary or null.
 */
export function findChrome(env = process.env) {
  const mode = process.platform === 'win32' ? constants.F_OK : constants.X_OK
  for (const candidate of chromeCandidates(env)) {
    try {
      accessSync(candidate, mode)
      return candidate
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

/**
 * Split a build target (`linux-x64`, `win-x64`, `darwin-arm64`).
 * @param {string} target target name.
 * @returns {{os: string, arch: string}} parsed target.
 */
export function parseSmokeTarget(target) {
  const [os, arch] = String(target ?? '').split('-')
  return { os: os ?? '', arch: arch ?? '' }
}

/**
 * Platform name used in build targets.
 * @param {NodeJS.Platform} [platform] process.platform.
 * @returns {string} `linux`, `win`, or `darwin`.
 */
export function targetOs(platform = process.platform) {
  if (platform === 'win32') return 'win'
  if (platform === 'darwin') return 'darwin'
  return 'linux'
}

/**
 * Whether a package target can run on this host.
 * @param {string} target target name.
 * @param {NodeJS.Platform} [platform] process.platform.
 * @param {string} [arch] process.arch.
 * @returns {boolean} true when the package is native.
 */
export function isNativeTarget(target, platform = process.platform, arch = process.arch) {
  const parsed = parseSmokeTarget(target)
  return parsed.os === targetOs(platform) && parsed.arch === arch
}

/**
 * Resolve `runtime/node` inside a package or install.
 * @param {string} root package or install root.
 * @returns {string} node executable.
 */
export function packageNode(root) {
  const candidates = process.platform === 'win32'
    ? [path.join(root, 'runtime', 'node', 'node.exe'), path.join(root, 'runtime', 'node', 'bin', 'node.exe')]
    : [path.join(root, 'runtime', 'node', 'bin', 'node')]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return process.execPath
}

/**
 * A child process whose output is appended to one log.
 * @param {{command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, name: string, log: (line: string) => void}} options process input.
 * @returns {{child: import('node:child_process').ChildProcess, get exited(): boolean, tail: () => string, stop: () => Promise<void>}} handle.
 */
function startProcess(options) {
  const detached = process.platform !== 'win32'
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached,
  })
  const lines = []
  let exited = false
  const consume = (chunk) => {
    const text = String(chunk)
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim() === '') continue
      lines.push(line)
      if (lines.length > 400) lines.shift()
      options.log(`[${options.name}] ${line}`)
    }
  }
  child.stdout?.on('data', consume)
  child.stderr?.on('data', consume)
  const exit = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true
      resolve({ code, signal })
    })
  })
  const signalGroup = (signal) => {
    try {
      if (detached && child.pid !== undefined) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch {
      // Already gone.
    }
  }
  return {
    child,
    get exited() {
      return exited
    },
    tail: () => lines.slice(-30).join('\n'),
    async stop() {
      if (exited) {
        // The supervisor may have exited while its DSH child stayed in the
        // process group; a group kill is still safe because the direct child
        // is gone and the pid cannot have been reused in this short window.
        signalGroup('SIGKILL')
        return
      }
      signalGroup('SIGTERM')
      const timer = setTimeout(() => signalGroup('SIGKILL'), 8_000)
      await exit
      clearTimeout(timer)
      // A supervisor that exits normally has already stopped DSH; this is the
      // belt-and-braces case for a child that ignored SIGTERM.
      signalGroup('SIGKILL')
    },
  }
}

/** Sleep without a busy loop. */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Reject when a promise does not settle in time.
 * @param {Promise<unknown>} promise work.
 * @param {number} ms deadline.
 * @param {string} label description for the error.
 * @returns {Promise<unknown>} result.
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${String(ms)}ms: ${label}`)), ms)
    promise.then((value) => {
      clearTimeout(timer)
      resolve(value)
    }, (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/**
 * Poll a reader until it returns a truthy value.
 * @param {() => Promise<unknown>} read reader.
 * @param {{timeoutMs: number, intervalMs?: number, label: string}} options deadline.
 * @returns {Promise<unknown>} first truthy value.
 */
async function waitFor(read, options) {
  const interval = options.intervalMs ?? 500
  const deadline = Date.now() + options.timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await read()
      if (value) return value
    } catch (error) {
      // A process that already exited (or a page that reported a failed boot)
      // will not fix itself by waiting; fail the smoke immediately.
      if (error !== null && typeof error === 'object' && error.fatal === true) throw error
      lastError = error
    }
    await sleep(interval)
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`timed out after ${String(options.timeoutMs)}ms: ${options.label}${detail}`)
}

/**
 * One free loopback port.
 * @returns {Promise<number>} port.
 */
async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise(resolve => server.close(resolve))
  return port
}

/**
 * Environment for a packaged child: the ambient DSH_* configuration must not
 * leak in, because the smoke test runs on a machine that is itself serving DSH.
 * @param {Record<string, string>} overrides values for this run.
 * @returns {NodeJS.ProcessEnv} environment.
 */
function cleanEnv(overrides) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('DSH_') || key === 'NODE_OPTIONS') continue
    if (value !== undefined) env[key] = value
  }
  return { ...env, ...overrides }
}

/**
 * Run a Node script to completion and fail with its tail on a non-zero exit.
 * @param {string} node node executable.
 * @param {string[]} args script and arguments.
 * @param {{cwd: string, timeoutMs?: number, log: (line: string) => void}} options run input.
 * @returns {Promise<string>} captured output.
 */
async function runNode(node, args, options) {
  const child = spawn(node, args, { cwd: options.cwd, env: cleanEnv({}), stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const consume = (chunk) => {
    const text = String(chunk)
    output = `${output}${text}`.slice(-16_000)
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim() !== '') options.log(line)
    }
  }
  child.stdout?.on('data', consume)
  child.stderr?.on('data', consume)
  const result = await withTimeout(new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  }), options.timeoutMs ?? 120_000, `${path.basename(args[0] ?? 'node')} ${String(args[1] ?? '')}`)
  if (result.code !== 0) {
    throw new Error(`${path.basename(args[0] ?? 'node')} exited ${String(result.signal ?? result.code)}: ${output.trim().slice(-1200)}`)
  }
  return output
}

/**
 * Create the disposable flat-install layout for a package.
 *
 * The heavy directories are symlinked, so this costs a few inodes rather than
 * a second copy of a 300 MiB package. Everything the run writes (data, home,
 * workspace, config/gate.env) is inside the scratch root.
 * @param {string} packageRoot assembled package directory.
 * @param {string} workDir scratch directory.
 * @returns {Promise<string>} install root.
 */
async function prepareInstallRoot(packageRoot, workDir) {
  const root = path.join(workDir, 'install')
  await rm(root, { recursive: true, force: true })
  await mkdir(path.join(root, 'config'), { recursive: true })
  await mkdir(path.join(root, 'data'), { recursive: true })
  await mkdir(path.join(root, 'home', 'profiles', 'web'), { recursive: true })
  await mkdir(path.join(root, 'workspace'), { recursive: true })
  // `shared` is imported by the gate (`../shared/wireguard.mjs`) and by the
  // plugin; it is as required as `gate` itself.
  for (const directory of ['app', 'code', 'gate', 'plugins', 'shared']) {
    const source = path.join(packageRoot, directory)
    if (!existsSync(source)) throw new Error(`package is missing ${directory}/: ${packageRoot}`)
    await symlink(source, path.join(root, directory), process.platform === 'win32' ? 'junction' : 'dir')
  }
  const runtime = path.join(packageRoot, 'runtime')
  if (!existsSync(runtime)) throw new Error(`package is missing runtime/: ${packageRoot}`)
  await symlink(runtime, path.join(root, 'runtime'), process.platform === 'win32' ? 'junction' : 'dir')
  const entry = path.join(packageRoot, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(entry)) throw new Error(`package has no DSH app entry: ${entry}`)
  const patch = path.join(packageRoot, 'config', 'browse-picker.patch.yml')
  if (existsSync(patch)) await copyFile(patch, path.join(root, 'config', 'browse-picker.patch.yml'))
  return root
}

/**
 * Write a minimal `gate.env` and wire the packaged plugin into a profile.
 * @param {{packageRoot: string, root: string, home: string, workdir: string, port: number, password: string, log: (line: string) => void}} options wiring input.
 * @returns {Promise<void>}
 */
async function wireProfile(options) {
  const candidates = [
    path.join(options.packageRoot, 'code', 'deploy', 'wire-profile.mjs'),
    path.join(options.packageRoot, 'plugins', 'dsh-mesh', 'code', 'deploy', 'wire-profile.mjs'),
  ]
  const script = candidates.find(candidate => existsSync(candidate))
  if (script === undefined) {
    throw new Error('package carries no code/deploy/wire-profile.mjs; cannot wire the DSH profile')
  }
  const envFile = path.join(options.root, 'config', 'gate.env')
  await writeFile(envFile, [
    `DSH_GATE_PORT=${String(options.port)}`,
    `DSH_GATE_PASSWORD=${options.password}`,
    `DSH_HOME=${options.home}`,
    `DSH_WORKDIR=${options.workdir}`,
    `DSH_GATE_DATA_DIR=${path.join(options.root, 'data')}`,
    '',
  ].join('\n'), { mode: 0o600 })
  const node = packageNode(options.packageRoot)
  const output = await runNode(node, [
    script,
    '--root', options.root,
    '--profile', path.join(options.home, 'profiles', 'web'),
    '--env', envFile,
    '--dsh-home', options.home,
    '--workdir', options.workdir,
    '--port', String(options.port),
    '--token', 'dsh-mesh-smoke',
  ], { cwd: options.root, log: options.log })
  options.log(`profile wired: ${output.trim().split(/\r?\n/u).slice(-1)[0] ?? ''}`)
}

/**
 * Start the packaged supervisor and gateway.
 * @param {{root: string, node: string, home: string, workdir: string, port: number, password: string, log: (line: string) => void, startTimeoutMs?: number}} options stack input.
 * @returns {Promise<{token: object, close: () => Promise<void>}>} running stack.
 */
async function startStack(options) {
  const { root, node } = options
  const tokenFile = path.join(root, 'data', 'dsh-web.json')
  await rm(tokenFile, { force: true })
  const supervisor = startProcess({
    command: node,
    // `--preserve-symlinks-main` keeps ROOT at the scratch install even when
    // the scratch `code` directory is a symlink. Older supervisors (packages
    // built before DSH_PACKAGE_ROOT was honoured) then still write their token
    // into the scratch `data/` rather than into the package being tested.
    args: ['--preserve-symlinks-main', path.join(root, 'code', 'dsh-service', 'supervisor.mjs')],
    cwd: root,
    env: cleanEnv({
      DSH_HOME: options.home,
      DSH_WORKDIR: options.workdir,
      DSH_AGENTS_HOME: path.join(options.home, 'agents'),
      DSH_WEB_PORT: '0',
      DSH_PACKAGE_ROOT: root,
    }),
    name: 'dsh',
    log: options.log,
  })
  let token
  try {
    token = await waitFor(async () => {
      if (supervisor.exited) {
        const error = new Error(`DSH supervisor exited before writing a launch URL:\n${supervisor.tail()}`)
        error.fatal = true
        throw error
      }
      if (!existsSync(tokenFile)) return null
      try {
        const parsed = JSON.parse(await readFile(tokenFile, 'utf8'))
        return Number.isInteger(parsed.port) && parsed.port > 0 ? parsed : null
      } catch {
        // The supervisor writes the token atomically, but a torn read here is
        // harmless: the next poll will see the renamed file.
        return null
      }
    }, {
      timeoutMs: options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
      intervalMs: 500,
      label: 'dsh web launch URL (the package did not start)',
    })
  } catch (error) {
    await supervisor.stop()
    throw error
  }
  options.log(`dsh web ready on 127.0.0.1:${String(token.port)}; starting the gateway`)

  const gate = startProcess({
    command: node,
    args: [path.join(root, 'gate', 'server.mjs')],
    cwd: root,
    env: cleanEnv({
      DSH_HOME: options.home,
      DSH_WORKDIR: options.workdir,
      DSH_GATE_DATA_DIR: path.join(root, 'data'),
      DSH_GATE_PORT: String(options.port),
      // Never expose the throwaway instance beyond loopback: its password is
      // fixed for the test and the build host may be on a public network.
      DSH_GATE_BIND: '127.0.0.1',
      DSH_GATE_PASSWORD: options.password,
      DSH_GATE_NO_SPAWN: '1',
      DSH_WEB_TOKEN_FILE: tokenFile,
      DSH_GATE_MEMBER_PORT: String(options.port),
      DSH_PACKAGE_ROOT: root,
      DSH_APP_DIR: path.join(root, 'app'),
      DSH_GATE_PATCH: path.join(root, 'config', 'browse-picker.patch.yml'),
    }),
    name: 'gate',
    log: options.log,
  })
  try {
    await waitFor(async () => {
      if (gate.exited) {
        const error = new Error(`gateway exited before becoming healthy:\n${gate.tail()}`)
        error.fatal = true
        throw error
      }
      const response = await fetch(`http://127.0.0.1:${String(options.port)}/__gate/health`, {
        signal: AbortSignal.timeout(2_000),
      })
      const body = await response.json().catch(() => null)
      return response.ok && body?.ok === true ? body : null
    }, {
      timeoutMs: 90_000,
      intervalMs: 500,
      label: 'gateway health (DSH did not become reachable)',
    })
  } catch (error) {
    await gate.stop()
    await supervisor.stop()
    throw error
  }
  return {
    token,
    async close() {
      await gate.stop()
      await supervisor.stop()
    },
  }
}

/**
 * Prove the password gate over plain HTTP and return its cookie.
 *
 * The browser then starts with that cookie instead of filling the form. That
 * removes the login submission from the renderer's critical path, which matters
 * on a small build host where the first bundle parse can block the main thread
 * for tens of seconds.
 * @param {string} base gateway origin.
 * @param {string} password deployment password.
 * @returns {Promise<string>} `dsh_gate` cookie value.
 */
async function loginCookie(base, password) {
  const response = await fetch(`${base}/__gate/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password, next: '/' }).toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status !== 303 && response.status !== 302 && response.status !== 200) {
    throw new Error(`gate login answered HTTP ${String(response.status)}`)
  }
  const headers = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') ?? '']
  const raw = headers.find(value => value.startsWith('dsh_gate=')) ?? ''
  const value = raw.split(';')[0]?.slice('dsh_gate='.length) ?? ''
  if (value === '') throw new Error('gate login did not return a dsh_gate cookie')
  return value
}

/**
 * Read a page snapshot from the browser.
 * @param {import('../shared/chrome.mjs').ChromeSession} session browser.
 * @returns {Promise<object>} snapshot.
 */
async function pageSnapshot(session) {
  return withTimeout(session.evaluate(`(() => {
    const text = document.body ? document.body.innerText : ''
    const root = document.querySelector('#root')
    const meshButtons = [...document.querySelectorAll('button')]
      .filter(button => button.textContent.trim() === ${JSON.stringify(MESH_LABEL)})
    const fatal = /Failed to load plugins|web boot: .*did not activate/u.test(text)
    return {
      url: location.href,
      ready: document.readyState,
      login: Boolean(document.querySelector('#password')),
      rootChildren: root ? root.children.length : -1,
      meshButtons: meshButtons.length,
      fatal,
      text: text.slice(0, 2000),
    }
  })()`), 15_000, 'read the page')
}

/**
 * Drive the login form and wait for the shell and Mesh sidebar entry.
 * @param {import('../shared/chrome.mjs').ChromeSession} session browser.
 * @param {{base: string, password: string, timeoutMs: number, log: (line: string) => void}} options login input.
 * @returns {Promise<object>} page state.
 */
async function loginAndBoot(session, options) {
  await withTimeout(session.goto(`${options.base}/`, 60_000), 65_000, 'open the gateway')
  let submitted = false
  const state = await waitFor(async () => {
    const snapshot = await pageSnapshot(session)
    if (snapshot.fatal) {
      const error = new Error(`DSH boot failed in the browser:\n${snapshot.text.slice(0, 1200)}`)
      error.fatal = true
      throw error
    }
    if (snapshot.login && !submitted) {
      const filled = await withTimeout(session.evaluate(`(() => {
        const input = document.querySelector('#password')
        const form = input ? input.form : null
        if (!input || !form) return false
        input.value = ${JSON.stringify(options.password)}
        form.submit()
        return true
      })()`), 10_000, 'submit the gate password')
      if (filled) {
        submitted = true
        options.log('gate password submitted; waiting for the DSH shell')
      }
      return null
    }
    if (snapshot.meshButtons > 0) return snapshot
    return null
  }, {
    timeoutMs: options.timeoutMs,
    intervalMs: 750,
    label: 'DSH shell with a Mesh sidebar entry',
  })
  return state
}

/**
 * Capture the shell and the opened Mesh panel.
 * @param {{base: string, password: string, chrome: string, screenshotDir: string, target: string, cookie?: string|null, timeoutMs?: number, panelTimeoutMs?: number, log: (line: string) => void}} options browser input.
 * @returns {Promise<{checks: object[], screenshots: string[], state: object}>} result.
 */
async function inspectInChrome(options) {
  const session = await ChromeSession.launch(options.chrome, VIEWPORT)
  const screenshots = []
  const checks = []
  try {
    if (typeof options.cookie === 'string' && options.cookie !== '') {
      try {
        await session.setCookie('dsh_gate', options.cookie, options.base)
      } catch (error) {
        // A cookie the browser rejects is not fatal: the form fallback in
        // `loginAndBoot` still proves the password path.
        options.log(`could not install the gate cookie: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const state = await loginAndBoot(session, {
      base: options.base,
      password: options.password,
      timeoutMs: options.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS,
      log: options.log,
    })
    checks.push({
      name: 'dsh-boot',
      ok: state.rootChildren > 0 && state.text.trim() !== '',
      detail: `${String(state.rootChildren)} root child(ren), ${String(state.text.length)} chars`,
    })
    checks.push({
      name: 'no-plugin-errors',
      ok: !state.fatal,
      detail: state.fatal ? 'the page reported failed plugins' : 'no failed-plugin banner',
    })
    checks.push({
      name: 'mesh-sidebar',
      ok: state.meshButtons > 0,
      detail: `${String(state.meshButtons)} sidebar button(s) labelled Mesh`,
    })

    const shellShot = path.join(options.screenshotDir, `dsh-${options.target}.png`)
    await mkdir(options.screenshotDir, { recursive: true })
    await writeFile(shellShot, await withTimeout(session.screenshot(), 30_000, 'screenshot the shell'))
    screenshots.push(shellShot)
    options.log(`screenshot: ${shellShot}`)

    const clicked = await withTimeout(session.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find(candidate => candidate.textContent.trim() === ${JSON.stringify(MESH_LABEL)})
      if (!button) return false
      button.click()
      return true
    })()`), 10_000, 'click the Mesh sidebar entry')
    if (!clicked) {
      checks.push({ name: 'mesh-panel', ok: false, detail: 'the Mesh sidebar entry disappeared before the click' })
    } else {
      let mode = ''
      try {
        mode = String(await waitFor(async () => {
          return withTimeout(session.evaluate(
            "document.querySelector('.dsh-pw-page') ? 'page' : ''",
          ), 15_000, 'read the Mesh panel')
        }, {
          timeoutMs: options.panelTimeoutMs ?? DEFAULT_PANEL_TIMEOUT_MS,
          intervalMs: 750,
          label: 'the Mesh panel to finish loading',
        }))
      } catch {
        // The client bundle can be on screen while the panel's first snapshot
        // is still in flight (member probing is allowed to take a while). Read
        // both markers one last time: the page may have finished loading right
        // at the deadline, and a boot spinner still proves the plugin
        // registered its main slot.
        const marker = await withTimeout(session.evaluate(`(() => {
          if (document.querySelector('.dsh-pw-page')) return 'page'
          if (document.querySelector('.dsh-pw-boot')) return 'boot'
          return ''
        })()`), 30_000, 'read the Mesh panel markers').catch(() => '')
        mode = String(marker)
        if (mode === 'boot') {
          checks.push({ name: 'mesh-panel', ok: true, detail: 'the Mesh panel is in its boot state (API still starting)' })
        }
      }
      if (mode === 'page') {
        checks.push({ name: 'mesh-panel', ok: true, detail: 'the Mesh panel finished loading' })
      } else if (mode === '') {
        checks.push({ name: 'mesh-panel', ok: false, detail: 'the Mesh panel markup never appeared' })
      }
      const panelShot = path.join(options.screenshotDir, `mesh-${options.target}.png`)
      await writeFile(panelShot, await withTimeout(session.screenshot(), 30_000, 'screenshot the Mesh panel'))
      screenshots.push(panelShot)
      options.log(`screenshot: ${panelShot}`)
    }
    return { checks, screenshots, state }
  } catch (error) {
    if (error !== null && typeof error === 'object') {
      error.checks = checks
      error.screenshots = screenshots
    }
    if (screenshots.length === 0) {
      try {
        await mkdir(options.screenshotDir, { recursive: true })
        const failure = path.join(options.screenshotDir, `failure-${options.target}.png`)
        await writeFile(failure, await withTimeout(session.screenshot(), 15_000, 'screenshot the failure'))
        screenshots.push(failure)
        options.log(`screenshot: ${failure}`)
      } catch {
        // A browser that cannot answer cannot provide a failure image either.
      }
    }
    throw error
  } finally {
    session.kill()
  }
}

/**
 * Resolve the conventional `DSH_HOME`/`DSH_WORKDIR`/password from a flat
 * install's `gate.env`.
 * @param {string} root install root.
 * @returns {Promise<Record<string, string>>} values.
 */
async function readGateEnv(root) {
  const file = path.join(root, 'config', 'gate.env')
  if (!existsSync(file)) throw new Error(`not a dsh-mesh install (missing config/gate.env): ${root}`)
  const values = {}
  for (const raw of (await readFile(file, 'utf8')).split(/\r?\n/u)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    let value = line.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[line.slice(0, index).trim()] = value
  }
  return values
}

/**
 * Validate that a directory has the files an installed stack needs.
 * @param {string} root install root.
 */
function assertInstallRoot(root) {
  for (const relative of [
    'app/node_modules/@deepseek-ai/dsh/lib/bin.js',
    'gate/server.mjs',
    'shared/wireguard.mjs',
    'code/dsh-service/supervisor.mjs',
    'plugins/dsh-mesh/package.json',
  ]) {
    if (!existsSync(path.join(root, relative))) {
      throw new Error(`not a complete dsh-mesh install (missing ${relative}): ${root}`)
    }
  }
}

/**
 * Result for a package that cannot be exercised on this host.
 * @param {string} reason why.
 * @param {object} base result fields.
 * @returns {object} skipped result.
 */
function skipped(reason, base) {
  return {
    ok: true,
    status: 'skipped',
    reason,
    ...base,
    durationMs: 0,
    checks: [],
    screenshots: [],
  }
}

/**
 * Smoke-test a freshly assembled package.
 * @param {{packageRoot: string, target: string, workDir?: string, screenshotDir?: string, chrome?: string|null, env?: NodeJS.ProcessEnv, keep?: boolean, startTimeoutMs?: number, pageTimeoutMs?: number, panelTimeoutMs?: number, required?: boolean, log?: (line: string) => void}} options package input.
 * @returns {Promise<object>} result with `status`, `checks`, and screenshot paths.
 */
export async function runPackageSmoke(options) {
  const started = Date.now()
  const target = String(options.target ?? '')
  const base = { target, packageRoot: options.packageRoot }
  if (options.packageRoot === undefined || !existsSync(options.packageRoot)) {
    return { ...skipped('package directory does not exist', base), ok: false, status: 'failed', error: `package directory does not exist: ${String(options.packageRoot)}` }
  }
  if (!isNativeTarget(target)) {
    return skipped(`${target} cannot run on ${targetOs()}-${process.arch}`, base)
  }
  const chrome = options.chrome === undefined ? findChrome(options.env ?? process.env) : options.chrome
  if (chrome === null || chrome === '') {
    const reason = 'no Chrome/Chromium found; set DSH_MESH_SMOKE_CHROME or run with --no-smoke'
    return options.required === true
      ? { ...skipped(reason, base), ok: false, status: 'failed', error: reason }
      : skipped(reason, base)
  }

  const ownsWorkDir = options.workDir === undefined
  const workDir = options.workDir ?? await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-smoke-'))
  await mkdir(workDir, { recursive: true })
  const logFile = path.join(workDir, 'smoke.log')
  const log = (line) => {
    const text = String(line)
    void appendFile(logFile, `${new Date().toISOString()} ${text}\n`).catch(() => {})
    options.log?.(text)
  }
  const screenshotDir = options.screenshotDir ?? workDir
  let root
  let stack
  try {
    log(`smoke ${target}: package ${options.packageRoot}; chrome ${chrome}`)
    root = await prepareInstallRoot(options.packageRoot, workDir)
    const home = path.join(root, 'home')
    const worktree = path.join(root, 'workspace')
    const port = await freePort()
    await wireProfile({
      packageRoot: options.packageRoot,
      root,
      home,
      workdir: worktree,
      port,
      password: 'dsh-mesh-smoke',
      log,
    })
    stack = await startStack({
      root,
      node: packageNode(options.packageRoot),
      home,
      workdir: worktree,
      port,
      password: 'dsh-mesh-smoke',
      log,
      startTimeoutMs: options.startTimeoutMs,
    })
    let cookie = null
    try {
      cookie = await loginCookie(`http://127.0.0.1:${String(port)}`, 'dsh-mesh-smoke')
    } catch (error) {
      log(`cookie login failed (falling back to the form): ${error instanceof Error ? error.message : String(error)}`)
    }
    const inspected = await inspectInChrome({
      base: `http://127.0.0.1:${String(port)}`,
      password: 'dsh-mesh-smoke',
      chrome,
      screenshotDir,
      target,
      cookie,
      timeoutMs: options.pageTimeoutMs,
      panelTimeoutMs: options.panelTimeoutMs,
      log,
    })
    const failed = inspected.checks.filter(check => !check.ok)
    const result = {
      ok: failed.length === 0,
      status: failed.length === 0 ? 'passed' : 'failed',
      target,
      packageRoot: options.packageRoot,
      checks: inspected.checks,
      screenshots: inspected.screenshots,
      logFile,
      durationMs: Date.now() - started,
      ...(failed.length === 0 ? {} : { error: failed.map(check => `${check.name}: ${check.detail}`).join('; ') }),
    }
    log(`smoke ${target}: ${result.status}${result.error === undefined ? '' : ` (${result.error})`}`)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`smoke ${target}: failed: ${message}`)
    return {
      ok: false,
      status: 'failed',
      target,
      packageRoot: options.packageRoot,
      checks: Array.isArray(error?.checks) ? error.checks : [],
      screenshots: Array.isArray(error?.screenshots) ? error.screenshots : [],
      logFile,
      error: message,
      durationMs: Date.now() - started,
    }
  } finally {
    await stack?.close().catch(() => {})
    if (root !== undefined && options.keep !== true) await rm(root, { recursive: true, force: true }).catch(() => {})
    if (ownsWorkDir && options.keep !== true) await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Smoke-test an already-upgraded install (the test-upgrade rehearsal).
 * @param {{root: string, target?: string, home?: string, workdir?: string, port?: number, password?: string, chrome?: string|null, env?: NodeJS.ProcessEnv, workDir?: string, screenshotDir?: string, keep?: boolean, startTimeoutMs?: number, pageTimeoutMs?: number, panelTimeoutMs?: number, required?: boolean, log?: (line: string) => void}} options install input.
 * @returns {Promise<object>} result.
 */
export async function runInstallSmoke(options) {
  const started = Date.now()
  const root = options.root
  const target = String(options.target ?? `${targetOs()}-${process.arch}`)
  if (root === undefined || !existsSync(root)) {
    return { ok: false, status: 'failed', target, root: String(root), error: `install root does not exist: ${String(root)}`, checks: [], screenshots: [], durationMs: 0 }
  }
  if (!isNativeTarget(target)) {
    return skipped(`${target} cannot run on ${targetOs()}-${process.arch}`, { target, root })
  }
  const chrome = options.chrome === undefined ? findChrome(options.env ?? process.env) : options.chrome
  if (chrome === null || chrome === '') {
    const reason = 'no Chrome/Chromium found; set DSH_MESH_SMOKE_CHROME'
    return options.required === true
      ? { ok: false, status: 'failed', target, root, error: reason, checks: [], screenshots: [], durationMs: 0 }
      : skipped(reason, { target, root })
  }

  const ownsWorkDir = options.workDir === undefined
  const workDir = options.workDir ?? await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-smoke-'))
  await mkdir(workDir, { recursive: true })
  const logFile = path.join(workDir, 'smoke.log')
  const log = (line) => {
    const text = String(line)
    void appendFile(logFile, `${new Date().toISOString()} ${text}\n`).catch(() => {})
    options.log?.(text)
  }
  const screenshotDir = options.screenshotDir ?? workDir
  let stack
  try {
    assertInstallRoot(root)
    const env = await readGateEnv(root)
    const home = options.home ?? env.DSH_HOME ?? path.join(root, 'home')
    const worktree = options.workdir ?? env.DSH_WORKDIR ?? path.join(root, 'workspace')
    const profile = path.join(home, 'profiles', 'web')
    if (!existsSync(path.join(profile, 'node_modules', '@local', 'dsh-mesh'))) {
      throw new Error(`the profile is not wired to this install: ${profile}`)
    }
    const port = options.port ?? await freePort()
    const password = options.password ?? env.DSH_GATE_PASSWORD ?? 'dsh-mesh-smoke'
    log(`smoke ${target}: install ${root}; home ${home}; port ${String(port)}; chrome ${chrome}`)
    stack = await startStack({
      root,
      node: packageNode(root),
      home,
      workdir: worktree,
      port,
      password,
      log,
      startTimeoutMs: options.startTimeoutMs,
    })
    let cookie = null
    try {
      cookie = await loginCookie(`http://127.0.0.1:${String(port)}`, password)
    } catch (error) {
      log(`cookie login failed (falling back to the form): ${error instanceof Error ? error.message : String(error)}`)
    }
    const inspected = await inspectInChrome({
      base: `http://127.0.0.1:${String(port)}`,
      password,
      chrome,
      screenshotDir,
      target,
      cookie,
      timeoutMs: options.pageTimeoutMs,
      panelTimeoutMs: options.panelTimeoutMs,
      log,
    })
    const failed = inspected.checks.filter(check => !check.ok)
    const result = {
      ok: failed.length === 0,
      status: failed.length === 0 ? 'passed' : 'failed',
      target,
      root,
      checks: inspected.checks,
      screenshots: inspected.screenshots,
      logFile,
      durationMs: Date.now() - started,
      ...(failed.length === 0 ? {} : { error: failed.map(check => `${check.name}: ${check.detail}`).join('; ') }),
    }
    log(`smoke ${target}: ${result.status}${result.error === undefined ? '' : ` (${result.error})`}`)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`smoke ${target}: failed: ${message}`)
    return {
      ok: false,
      status: 'failed',
      target,
      root,
      checks: Array.isArray(error?.checks) ? error.checks : [],
      screenshots: Array.isArray(error?.screenshots) ? error.screenshots : [],
      logFile,
      error: message,
      durationMs: Date.now() - started,
    }
  } finally {
    await stack?.close().catch(() => {})
    if (ownsWorkDir && options.keep !== true) await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
