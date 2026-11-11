/**
 * Sign the deployment's DeepSeek account in without a tunnel.
 *
 * The platform accepts only a loopback `redirect_uri` (measured: a public
 * `https://…/oauth/callback` is answered with `50005 PAYLOAD_SCHEMA_MISMATCH`),
 * and DSH refuses any callback origin but `http://127.0.0.1:<port>`. A browser
 * running on this host satisfies both: it opens the authorize page and — once
 * the phone approves — lands on `http://127.0.0.1:<port>/oauth/callback` here,
 * where DSH exchanges the code and stores the grant.
 *
 * The operator never sees that browser. This module pulls the QR code itself
 * out of the page (data URL, canvas, or a scaled element capture) and serves it
 * as one image resource, so the app can show a native-looking login.
 */

import { existsSync } from 'node:fs'
import { ChromeSession } from './chrome.mjs'

/** How long a started browser keeps running without a successful sign-in. */
const SESSION_LIFETIME_MS = 10 * 60_000

/** How long one captured QR picture is reused before the page is read again. */
const QR_LIFETIME_MS = 90_000

/**
 * Smallest plausible element capture for a QR code. A blank or half-painted
 * rectangle compresses to a few kilobytes; a real code at 3x is far larger.
 */
const MIN_CAPTURE_BYTES = 12_000

/**
 * Find the QR code on the platform's sign-in page.
 *
 * WeChat's `qrconnect` runs in its own iframe, so the QR is not in the main
 * document at all: the iframe's rectangle is the picture. An `<img>`, `<canvas>`
 * or `<svg>` in the main document is still preferred when it carries its own
 * pixels, because that is native resolution rather than a capture.
 */
const FIND_QR = `(() => {
  const hidden = (el) => {
    const style = getComputedStyle(el);
    return style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.1;
  };
  const square = (r) => r.width / r.height >= 0.85 && r.width / r.height <= 1.18 && r.width >= 80 && r.height >= 80;
  const box = (r) => ({ x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height });

  // 1. The QR element itself, when the page draws one in this document.
  const items = [];
  for (const el of document.querySelectorAll("img,canvas,svg")) {
    if (hidden(el)) continue;
    const r = el.getBoundingClientRect();
    if (!square(r)) continue;
    items.push({ el, r, area: r.width * r.height });
  }
  items.sort((a, b) => b.area - a.area);
  const first = items[0];
  if (first !== undefined) {
    const { el, r } = first;
    if (el.tagName === "CANVAS") {
      try {
        const url = el.toDataURL("image/png");
        if (url.startsWith("data:image/png;base64,")) return { kind: "data", url };
      } catch (error) {}
    }
    if (el.tagName === "IMG") {
      const src = el.currentSrc || el.src || "";
      if (src.startsWith("data:image/")) return { kind: "data", url: src };
    }
    if (el.tagName === "svg") {
      try {
        const text = new XMLSerializer().serializeToString(el);
        return { kind: "data", url: "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(text))) };
      } catch (error) {}
    }
  }

  // 2. WeChat's qrconnect iframe, which is the QR for the account sign-in.
  const frames = [...document.querySelectorAll("iframe")]
    .filter((el) => !hidden(el))
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter((entry) => square(entry.r));
  const wechat = frames.filter((entry) => (entry.el.src || "").includes("open.weixin.qq.com/connect/qrconnect"));
  const chosen = (wechat.length > 0 ? wechat : frames)
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
  if (chosen !== undefined) return { kind: "element", box: box(chosen.r) };

  // 3. Any other square picture the page painted.
  if (first !== undefined) return { kind: "element", box: box(first.r) };
  return { kind: "none" };
})()`

/**
 * Trim a captured frame down to the code itself plus a narrow white margin.
 *
 * WeChat's iframe pads the code with its own tinted background, which reads as
 * a coloured frame around the picture. The page decodes the capture, finds the
 * bounding box of dark modules, and re-emits a crop on white — image work the
 * browser can do natively without adding an image library to the deployment.
 * @param base64 - the captured PNG.
 */
function cropExpression(base64) {
  return `(async () => {
    const blob = await (await fetch("data:image/png;base64,${base64}")).blob();
    const bitmap = await createImageBitmap(blob);
    const source = new OffscreenCanvas(bitmap.width, bitmap.height);
    const sourceContext = source.getContext("2d", { willReadFrequently: true });
    sourceContext.drawImage(bitmap, 0, 0);
    const { data } = sourceContext.getImageData(0, 0, bitmap.width, bitmap.height);
    let minX = bitmap.width, minY = bitmap.height, maxX = -1, maxY = -1;
    for (let y = 0; y < bitmap.height; y += 1) {
      for (let x = 0; x < bitmap.width; x += 1) {
        const index = (y * bitmap.width + x) * 4;
        if (data[index + 3] < 32) continue;
        const luminance = 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];
        if (luminance >= 110) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null;
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    if (width < 40 || height < 40) return null;
    const margin = Math.round(Math.max(width, height) * 0.10);
    const sx = Math.max(0, minX - margin);
    const sy = Math.max(0, minY - margin);
    const ex = Math.min(bitmap.width, maxX + margin + 1);
    const ey = Math.min(bitmap.height, maxY + margin + 1);
    const target = new OffscreenCanvas(ex - sx, ey - sy);
    const targetContext = target.getContext("2d");
    targetContext.fillStyle = "#ffffff";
    targetContext.fillRect(0, 0, target.width, target.height);
    targetContext.drawImage(bitmap, sx, sy, ex - sx, ey - sy, 0, 0, ex - sx, ey - sy);
    // The platform paints even the code's quiet zone with its own light tint.
    // Binarising removes it (and sharpens module edges) so the result is pure
    // black on pure white, independent of the page's theme.
    const image = targetContext.getImageData(0, 0, target.width, target.height);
    const pixels = image.data;
    for (let i = 0; i < pixels.length; i += 4) {
      const luminance = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      const value = luminance >= 180 ? 255 : 0;
      pixels[i] = value;
      pixels[i + 1] = value;
      pixels[i + 2] = value;
      pixels[i + 3] = 255;
    }
    targetContext.putImageData(image, 0, 0);
    const cropped = await target.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await cropped.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  })()`
}

/** The account Remote namespace, reached exactly as a browser reaches it. */
export class AccountLogin {
  #running = undefined
  #error = undefined
  #signedIn = false
  #phase = 'idle'
  #qr = undefined
  #lastUrl = ''

  /**
   * @param options - DSH listener port, its launch token, the Chrome binary, and a logger.
   */
  constructor({ port, token, chromeBinary, log, browserLauncher }) {
    this.port = port
    this.token = token
    this.chromeBinary = chromeBinary
    this.log = log
    // Present on Windows: starts the browser in the logged-on user's session
    // when this service account is not allowed to start one itself.
    this.browserLauncher = browserLauncher
  }

  /** Whether a sign-in browser is currently up. */
  get busy() {
    return this.#running !== undefined
  }

  /** Last error, for the page. */
  get error() {
    return this.#error
  }

  /** Coarse phase shown to the operator. */
  get phase() {
    return this.#phase
  }

  /** Exchange the process launch token for a browser cookie on the DSH listener. */
  async #cookie() {
    const response = await fetch(`http://127.0.0.1:${String(this.port)}/?token=${String(this.token)}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    })
    const cookies = response.headers.getSetCookie?.() ?? []
    const cookie = cookies.map(entry => entry.split(';')[0]).filter(entry => entry !== '').join('; ')
    if (cookie === '') throw new Error('DSH did not mint a browser cookie for the sign-in helper')
    return cookie
  }

  /** Call one account Remote method. */
  async #rpc(method, args) {
    const cookie = await this.#cookie()
    const response = await fetch(`http://127.0.0.1:${String(this.port)}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, host: `127.0.0.1:${String(this.port)}` },
      body: JSON.stringify({ type: 'client-request', rpcId: `account-login-${Date.now().toString(36)}`, method, payload: { args } }),
      // A hung Host must not hang the sign-in page with it.
      signal: AbortSignal.timeout(10_000),
    })
    const text = await response.text()
    let envelope
    try {
      envelope = JSON.parse(text)
    } catch {
      throw new Error(`account ${method} answered non-JSON (${String(response.status)})`)
    }
    if (envelope?.result?.ok !== true) {
      const message = envelope?.result?.error?.message ?? `account ${method} failed`
      throw new Error(String(message))
    }
    return envelope.result.value
  }

  /**
   * Current account and attempt state; a successful sign-in ends the browser.
   *
   * `AccountView.status` is exactly `'signed-out' | 'credential-stored'` — a
   * stored grant IS the signed-in state; there is no `'signed-in'` member.
   */
  async state() {
    const value = await this.#rpc('account/getState', {})
    this.#signedIn = value?.status === 'credential-stored'
    const running = this.#running
    if (this.#signedIn && running !== undefined) {
      this.#running = undefined
      this.#phase = 'done'
      this.#qr = undefined
      running.session.kill()
      this.log('account sign-in: succeeded, browser closed')
    }
    return value
  }

  /** Launch the local browser on a fresh attempt bound to this listener. */
  async #launch() {
    if (!existsSync(this.chromeBinary)) {
      throw new Error(`找不到 Chrome：${this.chromeBinary}（运行 sudo ./install.sh --with-chrome 安装）`)
    }
    const current = await this.state()
    if (this.#signedIn) return
    const leftover = current?.attempt
    if (leftover != null) {
      await this.#rpc('account/cancelSignIn', { attemptId: leftover.id }).catch(() => undefined)
    }
    const view = await this.#rpc('account/startSignIn', {
      client: { version: '0.2.2-rc.1', locale: 'zh-CN', timezoneOffsetSeconds: 8 * 3600 },
      callbackOrigin: `http://127.0.0.1:${String(this.port)}`,
      loginSource: 'web',
    })
    let authorizeUrl = view?.attempt?.authorizeUrl
    const attemptId = view?.attempt?.id
    if (authorizeUrl === undefined) {
      for (let i = 0; i < 20 && authorizeUrl === undefined; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 250))
        const next = await this.state().catch(() => undefined)
        authorizeUrl = next?.attempt?.authorizeUrl
      }
    }
    if (authorizeUrl === undefined) {
      throw new Error('DSH 没有返回授权链接（可能上一个登录尝试还在收尾，请重试）')
    }
    const session = await this.#startBrowser()
    this.#running = { session, attemptId, startedAt: Date.now() }
    this.#phase = 'browser'
    this.log(`account sign-in: opened ${String(authorizeUrl).slice(0, 80)}…`)
    await session.goto(String(authorizeUrl)).catch((error) => {
      this.log(`account sign-in: navigation failed: ${error.message}`)
    })
  }

  /**
   * Start the sign-in browser, falling back to the interactive Windows
   * session when this service account is not allowed to start one.
   * @returns {Promise<import('./chrome.mjs').ChromeSession>} browser session.
   */
  async #startBrowser() {
    try {
      return await ChromeSession.launch(this.chromeBinary, { width: 560, height: 900 })
    } catch (error) {
      if (this.browserLauncher === undefined) throw error
      this.log(`account sign-in: ${error instanceof Error ? error.message : String(error)}`)
      this.log('account sign-in: retrying in the interactive session')
      await this.browserLauncher.start()
      const session = await ChromeSession.attach(this.browserLauncher.port, { width: 560, height: 900 })
      this.log('account sign-in: attached to the interactive browser')
      return session
    }
  }

  /**
   * The one call the UI needs: make sure the flow runs and hand back the QR.
   *
   * Answers `ready: false` while the browser is still starting so the caller
   * keeps spinning instead of showing half a page, and `signedIn: true` the
   * moment the account lands. The captured image is reused for a while: it is
   * a still picture, and re-capturing on every poll would make the `<img>`
   * reload (and flicker) several times a second.
   * @returns whether the image exists, and whether the account is signed in.
   */
  async requestQr() {
    this.#error = undefined
    await this.state().catch(() => undefined)
    if (this.#signedIn) return { ready: false, signedIn: true }

    if (this.#running === undefined) {
      this.#phase = 'starting'
      try {
        await this.#launch()
      } catch (error) {
        this.#phase = 'failed'
        this.#error = error instanceof Error ? error.message : String(error)
        throw error
      }
      if (this.#signedIn) return { ready: false, signedIn: true }
      if (this.#running === undefined) return { ready: false, signedIn: false }
    }

    if (this.#qr !== undefined && Date.now() - this.#qr.at < QR_LIFETIME_MS) {
      await this.#trackUrl(this.#running.session)
      return { ready: true, signedIn: false }
    }

    // The page paints the QR a moment after navigation; poll briefly.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await this.#trackUrl(this.#running.session)
      const found = await this.#capture(this.#running.session).catch(() => undefined)
      if (found !== undefined) {
        this.#qr = { bytes: found, at: Date.now() }
        this.#phase = 'ready'
        return { ready: true, signedIn: false }
      }
      await new Promise(resolve => setTimeout(resolve, 400))
      await this.state().catch(() => undefined)
      if (this.#signedIn) return { ready: false, signedIn: true }
    }
    return { ready: this.#qr !== undefined, signedIn: false }
  }

  /**
   * Log each navigation the helper browser makes, so a stuck approval becomes
   * visible in the journal: the page either reaches the callback or it does not.
   * @param session - the driving browser session.
   */
  async #trackUrl(session) {
    const url = await session.url().catch(() => '')
    if (url === '' || url === this.#lastUrl) return
    this.#lastUrl = url
    this.log(`account sign-in: page ${url.slice(0, 140)}`)
  }

  /** Extract the QR pixels from the page. */
  async #capture(session) {
    const found = await session.evaluate(FIND_QR)
    if (found === undefined || found === null) return undefined
    if (found.kind === 'data' && typeof found.url === 'string') {
      const comma = found.url.indexOf(',')
      if (comma === -1) return undefined
      const payload = found.url.slice(comma + 1)
      const bytes = found.url.slice(0, comma).includes('base64')
        ? Buffer.from(payload, 'base64')
        : Buffer.from(decodeURIComponent(payload), 'utf8')
      return bytes.length > 500 ? bytes : undefined
    }
    if (found.kind === 'element' && found.box !== undefined) {
      const box = found.box
      if (box.width < 60 || box.height < 60) return undefined
      const frame = await session.screenshotClip(box, 3)
      // A QR captured before the cross-origin iframe painted is a flat blank
      // rectangle that compresses to a few kilobytes; a real one is far denser.
      if (frame.length < MIN_CAPTURE_BYTES) return undefined
      const cropped = await this.#crop(session, frame).catch(() => undefined)
      return cropped ?? frame
    }
    return undefined
  }

  /**
   * Keep only the code plus a narrow white margin, so the platform's tinted
   * padding does not travel with the picture.
   * @param session - the page that captured the frame.
   * @param frame - the captured PNG.
   * @returns the cropped PNG, or undefined when the frame has no code in it.
   */
  async #crop(session, frame) {
    const result = await session.evaluate(cropExpression(frame.toString('base64')))
    if (typeof result !== 'string' || result === '') return undefined
    const bytes = Buffer.from(result, 'base64')
    return bytes.length > 500 ? bytes : undefined
  }

  /** The cached QR image, or undefined when none was captured yet. */
  get qr() {
    return this.#qr?.bytes
  }

  /** When the cached image was captured, used as a cache-busting version. */
  get qrAt() {
    return this.#qr?.at ?? 0
  }

  /** A snapshot for the operator page. */
  snapshot() {
    const running = this.#running
    return {
      running: running !== undefined,
      phase: this.#phase,
      signedIn: this.#signedIn,
      hasQr: this.#qr !== undefined,
      error: this.#error,
      startedAt: running?.startedAt,
      expiresAt: running === undefined ? undefined : running.startedAt + SESSION_LIFETIME_MS,
    }
  }

  /** Drop the browser; the attempt is cancelled so DSH stops waiting. */
  async stop() {
    const running = this.#running
    this.#running = undefined
    this.#phase = 'idle'
    this.#qr = undefined
    if (running === undefined) return
    running.session.kill()
    await this.#rpc('account/cancelSignIn', { attemptId: running.attemptId }).catch(() => undefined)
  }

  /** Expire a stale session without operator action. */
  async reap() {
    const running = this.#running
    if (running === undefined) return
    if (Date.now() - running.startedAt < SESSION_LIFETIME_MS) return
    this.log('account sign-in: session expired')
    await this.stop()
  }
}
