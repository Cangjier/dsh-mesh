/**
 * A minimal Chrome DevTools Protocol session.
 *
 * The account sign-in flow requires the OAuth callback to land on
 * `http://127.0.0.1:<port>`, so the browser that completes it has to run on the
 * machine hosting the deployment. This drives that browser: launch, navigate,
 * screenshot, evaluate, close — nothing else. Node's built-in WebSocket carries
 * the protocol, so the deployment gains no npm dependency.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** Resolve one CDP command against its reply id. */
class CdpSocket {
  #socket
  #nextId = 1
  #pending = new Map()

  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (typeof message.id !== 'number') return
      const entry = this.#pending.get(message.id)
      if (entry === undefined) return
      this.#pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new Error(String(message.error.message ?? 'cdp error')))
      else entry.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      for (const entry of this.#pending.values()) entry.reject(new Error('chrome closed the debug socket'))
      this.#pending.clear()
    })
  }

  /** Open one debug socket. */
  static async open(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', () => {
        resolve()
      }, { once: true })
      socket.addEventListener('error', () => {
        reject(new Error('cannot open the chrome debug socket'))
      }, { once: true })
    })
    return new CdpSocket(socket)
  }

  /**
   * Send one command.
   * @param method - CDP method name.
   * @param params - method parameters.
   * @returns the protocol result.
   */
  send(method, params = {}) {
    const id = this.#nextId
    this.#nextId += 1
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try {
      this.#socket.close()
    } catch {
      /* already closed */
    }
  }
}

/** Wait for a file to appear, with a deadline. */
async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) return
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  throw new Error(`timed out waiting for ${path.basename(file)}`)
}

/** One headless Chrome instance driven over CDP. */
export class ChromeSession {
  #child
  #cdp
  #profileDir

  /**
   * Start headless Chrome and attach to one page target.
   * @param binary - Chrome executable path.
   * @param options - viewport size and start directory.
   */
  static async launch(binary, { width = 560, height = 820 } = {}) {
    const session = new ChromeSession()
    session.#profileDir = await mkdtemp(path.join(tmpdir(), 'dsh-chrome-'))
    session.#child = spawn(binary, [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--window-size=${String(width)},${String(height)}`,
      `--user-data-dir=${session.#profileDir}`,
      '--remote-debugging-port=0',
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })

    let stderr = ''
    session.#child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4000)
    })

    const portFile = path.join(session.#profileDir, 'DevToolsActivePort')
    try {
      await waitForFile(portFile, 20_000)
    } catch (error) {
      session.kill()
      throw new Error(`chrome did not start: ${error.message}${stderr === '' ? '' : ` (${stderr.slice(-300)})`}`)
    }
    const [port, wsPath] = (await readFile(portFile, 'utf8')).split('\n')
    if (port === undefined || wsPath === undefined) throw new Error('chrome wrote no debug port')

    // One page target, created over the browser-level socket.
    const browser = await CdpSocket.open(`ws://127.0.0.1:${String(port).trim()}${wsPath.trim()}`)
    const created = await browser.send('Target.createTarget', { url: 'about:blank' })
    browser.close()
    const listed = await (await fetch(`http://127.0.0.1:${String(port).trim()}/json/list`)).json()
    const target = listed.find(entry => entry.id === created.targetId)
    if (target === undefined) throw new Error('chrome created no page target')
    session.#cdp = await CdpSocket.open(target.webSocketDebuggerUrl)
    await session.#cdp.send('Page.enable')
    await session.#cdp.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    })
    return session
  }

  /** Navigate the page and wait for the load event. */
  async goto(url, timeoutMs = 30_000) {
    await this.#cdp.send('Page.navigate', { url })
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const { result } = await this.#cdp.send('Runtime.evaluate', {
        expression: 'document.readyState', returnByValue: true,
      })
      if (result?.value === 'complete') return
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }

  /** Current document URL. */
  async url() {
    const { result } = await this.#cdp.send('Runtime.evaluate', {
      expression: 'location.href', returnByValue: true,
    })
    return String(result?.value ?? '')
  }

  /**
   * Evaluate an expression in the page and return its value.
   * @param expression - an expression evaluating to JSON-serializable data.
   */
  async evaluate(expression) {
    const { result, exceptionDetails } = await this.#cdp.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    })
    if (exceptionDetails !== undefined) {
      throw new Error(String(exceptionDetails.text ?? 'page evaluation failed'))
    }
    return result?.value
  }

  /** A PNG screenshot of the current viewport. */
  async screenshot() {
    const { data } = await this.#cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    return Buffer.from(String(data), 'base64')
  }

  /**
   * A PNG capture of one page rectangle, rendered at extra scale so a small
   * element (a QR code) still comes back at print quality.
   * @param box - page rectangle in CSS pixels.
   * @param scale - device pixel multiplier.
   */
  async screenshotClip(box, scale = 3) {
    const { data } = await this.#cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale },
    })
    return Buffer.from(String(data), 'base64')
  }

  /** Terminate the browser and drop its profile directory. */
  kill() {
    this.#cdp?.close()
    try {
      this.#child?.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    if (this.#profileDir !== undefined) {
      void rm(this.#profileDir, { recursive: true, force: true })
    }
  }
}
