/**
 * Start the account sign-in browser inside the interactive Windows session.
 *
 * A gate that runs as a Windows service (LocalSystem) cannot start a browser:
 * Edge and Chrome exit immediately in that context, so the QR never renders.
 * The service can still ask Task Scheduler to run a command as the logged-on
 * user; the browser it starts listens on loopback, where the gate connects to
 * it and drives it over CDP like a locally spawned one.
 *
 * @module dsh-mesh/gate/windows-browser
 */

import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Task Scheduler entry this module owns. */
export const LOGIN_BROWSER_TASK = 'DSH-Login-Browser'

/**
 * Run one PowerShell snippet and return its trimmed stdout.
 * @param {string} script command text.
 * @param {number} [timeout] milliseconds.
 * @returns {Promise<string>} stdout.
 */
async function powershell(script, timeout = 20_000) {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout,
    windowsHide: true,
  })
  return String(stdout).trim()
}

/**
 * Name of the user holding the console session, or an empty string.
 * @returns {Promise<string>} `DOMAIN\user`.
 */
export async function consoleUser() {
  try {
    return await powershell('(Get-CimInstance Win32_ComputerSystem).UserName')
  } catch {
    return ''
  }
}

/**
 * The launcher script the interactive task runs. It is written on every start
 * so the binary and profile path always match this gate.
 * @param {{binary: string, profileDir: string, port: number}} options launch input.
 * @returns {string} PowerShell source.
 */
function launcherScript({ binary, profileDir, port }) {
  return `$ErrorActionPreference = 'Stop'
$dir = '${profileDir}'
Write-Output ('launching ' + '${binary.replace(/'/g, "''")}' + ' as ' + $env:USERNAME)
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$dir*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 300
Start-Process -FilePath '${binary.replace(/'/g, "''")}' -ArgumentList @(
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  "--user-data-dir=$dir",
  '--remote-debugging-port=${String(port)}',
  'about:blank'
)
`
}

/**
 * Launcher for a browser that must run in the interactive session.
 */
export class InteractiveBrowser {
  /**
   * @param {object} options launcher settings.
   * @param {string} options.binary browser executable.
   * @param {string} options.directory working directory (script, profile, logs).
   * @param {number} options.port fixed debugging port.
   * @param {(line: string) => void} options.log logger.
   */
  constructor({ binary, directory, port, log }) {
    this.binary = binary
    this.directory = directory
    this.port = port
    this.log = log
  }

  /**
   * Ensure the browser runs in the logged-on user's session and wait for its
   * debugging port.
   * @returns {Promise<void>} resolves once the port answers.
   */
  async start() {
    if (process.platform !== 'win32') throw new Error('the interactive browser launcher is Windows-only')
    if (this.binary === '') throw new Error('找不到浏览器：请安装 Edge/Chrome 或设置 DSH_GATE_CHROME')
    const user = await consoleUser()
    if (user === '') throw new Error('这台机器没有已登录的交互会话；请先在控制台/RDP 登录后再扫码')
    await mkdir(this.directory, { recursive: true })
    // The browser runs as the interactive user, so that user must own the profile.
    await run('icacls', [this.directory, '/grant', '*S-1-5-32-545:(OI)(CI)M', '/T', '/Q'], { windowsHide: true })
      .catch(() => undefined)
    const scriptFile = path.join(this.directory, 'login-browser.ps1')
    await writeFile(scriptFile, launcherScript({
      binary: this.binary,
      profileDir: path.join(this.directory, 'profile'),
      port: this.port,
    }), 'utf8')
    const account = user.includes('\\') ? user.slice(user.indexOf('\\') + 1) : user
    await run('schtasks.exe', [
      '/create', '/tn', LOGIN_BROWSER_TASK,
      '/tr', `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`,
      '/sc', 'once', '/st', '00:00', '/ru', account, '/it', '/f',
    ], { windowsHide: true })
    await run('schtasks.exe', ['/run', '/tn', LOGIN_BROWSER_TASK], { windowsHide: true })
    this.log(`account sign-in: started ${LOGIN_BROWSER_TASK} in ${user}'s session`)
    await this.#waitForPort()
  }

  /** Poll the loopback debugging endpoint until it answers. */
  async #waitForPort() {
    const deadline = Date.now() + 25_000
    let lastError = 'no response'
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${String(this.port)}/json/version`, {
          signal: AbortSignal.timeout(2_000),
        })
        if (response.ok) return
        lastError = `HTTP ${String(response.status)}`
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error(`交互会话里的浏览器没有在 25 秒内就绪（${lastError}）`)
  }
}
