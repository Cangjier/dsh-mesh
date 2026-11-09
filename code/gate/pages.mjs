/**
 * HTML for the gate-owned pages: the login form, the account sign-in helper,
 * and short status pages.
 *
 * Everything is inline and self-contained — a deployment may sit on a network
 * with no reachable CDN, and the gate must render before DSH is up. The palette
 * and typography mirror the DSH client (`packages/client/ui-theme`): the same
 * neutral-bluish scale, the same 12/16px radii, and the same inverted primary
 * button, so a password prompt does not look like a different product.
 */

/** Escape text for HTML text and attribute positions. */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const STYLE = `
  :root {
    color-scheme: light;
    --bg: #f9fafb;
    --surface: #ffffff;
    --surface-2: #f4f5f7;
    --border: rgba(0, 0, 0, 0.08);
    --border-strong: rgba(0, 0, 0, 0.16);
    --text: #0f1115;
    --muted: #61666b;
    --faint: #81858c;
    --primary: #0f1115;
    --primary-text: #ffffff;
    --accent: #4176e6;
    --danger: #d92d20;
    --radius: 16px;
    --radius-sm: 12px;
    --shadow: 0 1px 2px rgba(15, 17, 21, 0.04), 0 12px 32px rgba(15, 17, 21, 0.08);
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --bg: #232324;
      --surface: #2c2c2e;
      --surface-2: #353536;
      --border: rgba(255, 255, 255, 0.10);
      --border-strong: rgba(255, 255, 255, 0.20);
      --text: #f9fafb;
      --muted: #a6abb3;
      --faint: #81858c;
      --primary: #f9fafb;
      --primary-text: #0f1115;
      --accent: #7aaaff;
      --danger: #ff6b81;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 12px 32px rgba(0, 0, 0, 0.45);
    }
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 15px/1.6 var(--font);
    display: grid; place-items: center;
    min-height: 100%;
    padding: 24px;
    overflow-y: auto;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: min(400px, 100%);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 28px 26px 24px;
  }
  .brand { display: flex; align-items: center; gap: 6px; margin-bottom: 22px; }
  .brand .wordmark { font-size: 19px; font-weight: 700; letter-spacing: -0.02em; }
  .brand .badge {
    font-size: 9.5px; font-weight: 600; letter-spacing: 0.08em;
    border: 1px solid var(--text); border-radius: 4px; padding: 2px 5px; line-height: 1;
    transform: translateY(-1px);
  }
  h1 { font-size: 19px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.01em; }
  p.sub { color: var(--muted); margin: 0 0 20px; font-size: 14px; }
  label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 8px; }
  input[type=password] {
    width: 100%; padding: 11px 13px; border-radius: var(--radius-sm);
    border: 1px solid var(--border-strong); background: var(--surface); color: var(--text);
    font: inherit; font-size: 15px; outline: none;
    transition: border-color .15s var(--ease, ease), box-shadow .15s ease;
  }
  input[type=password]:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
  button {
    width: 100%; margin-top: 18px; padding: 11px 14px; border: 1px solid transparent;
    border-radius: var(--radius-sm); background: var(--primary); color: var(--primary-text);
    font: inherit; font-size: 15px; font-weight: 600; cursor: pointer;
    transition: opacity .15s ease;
  }
  button:hover { opacity: .88; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.secondary {
    background: var(--surface-2); color: var(--text); border-color: var(--border);
    font-weight: 500;
  }
  .error {
    margin: 0 0 16px; padding: 10px 12px; border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
    color: var(--danger); font-size: 13.5px;
  }
  .foot { margin-top: 18px; font-size: 12px; color: var(--faint); text-align: center; }
  .body-text { color: var(--muted); margin: 0; font-size: 14.5px; }
  .spinner {
    width: 16px; height: 16px; border-radius: 50%;
    border: 2px solid color-mix(in srgb, var(--text) 20%, transparent);
    border-top-color: var(--text);
    display: inline-block; vertical-align: -2px; margin-right: 8px;
    animation: spin 900ms linear infinite;
  }
  .spinner-lg { width: 30px; height: 30px; border-width: 3px; margin: 0; }
  .qrwrap { display: flex; align-items: center; justify-content: center; min-height: 280px; }
  .qrwrap img {
    max-width: 260px; max-height: 260px; width: auto; height: auto; display: block;
    border-radius: 8px; background: #fff;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Embedded mode: the same page inside the app's sign-in overlay. */
  body.embed { padding: 0; background: transparent; align-items: stretch; }
  body.embed .card {
    width: 100%; box-shadow: none; border: 0; background: transparent;
    padding: 4px 0 0; display: flex; flex-direction: column;
  }
  body.embed .brand, body.embed h1, body.embed p.sub { display: none; }
  body.embed .card { justify-content: center; }
  body.embed .qrwrap { min-height: auto; }
  body.embed #frame { margin-bottom: 10px; }
  /* The overlay is height-constrained, so the picture shrinks to fit instead of
     forcing a scroll — the QR stays whole and scannable. */
  body.embed #shot { max-height: calc(100vh - 210px); width: auto; }
  body.embed .foot { display: none; }
`

/** The shared document shell. */
function shell({ title, body, refresh, bodyClass }) {
  const refreshTag = refresh === undefined
    ? ''
    : `<meta http-equiv="refresh" content="${String(refresh)}">`
  const classAttribute = bodyClass === undefined ? '' : ` class="${bodyClass}"`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${refreshTag}
<title>${escapeHtml(title)} · DeepSeek Harness</title>
<style>${STYLE}</style>
</head>
<body${classAttribute}>
${body}
</body>
</html>
`
}

/** CSP every gate-rendered page is served with unless it asks for its own. */
export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

/** The DSH wordmark, typographic only so the gate ships no image asset. */
const BRAND = '<div class="brand"><span class="wordmark">deepseek</span><span class="badge">HARNESS</span></div>'

/**
 * The login form.
 * @param options - post-login destination, current lockout wait, error text, and uptime.
 */
export function loginPage(options) {
  const { next = '/', error, wait = 0 } = options
  const errorHtml = error === undefined ? '' : `<div class="error" role="alert">${escapeHtml(error)}</div>`
  const disabled = wait > 0 ? ' disabled' : ''
  const waitNote = wait > 0
    ? `<div class="error" role="alert">请等待 ${String(Math.ceil(wait))} 秒后再试</div>`
    : ''
  return shell({
    title: '访问验证',
    body: `<main class="card">
  ${BRAND}
  <h1>输入访问密码</h1>
  <p class="sub">这个工作台需要密码才能进入</p>
  ${errorHtml}${waitNote}
  <form method="post" action="/__gate/login">
    <label for="password">访问密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password"
           placeholder="请输入密码" required autofocus${disabled}>
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <button type="submit"${disabled}>进入工作台</button>
  </form>
</main>`,
  })
}

/**
 * The account sign-in page: one call asks the host for the QR code, and the page
 * shows a spinner until the image exists — nothing else, so it reads like a
 * native sign-in rather than a remote browser.
 * @param options - CSP nonce, and whether the page is inside the app's overlay.
 */
export function accountLoginPage(options) {
  const { nonce, embedded = false } = options
  const csp = `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'`
  const html = shell({
    title: '登录 DeepSeek 账号',
    bodyClass: embedded ? 'embed' : undefined,
    body: `<main class="card" ${embedded ? '' : 'style="width:min(420px,100%)"'}>
  ${BRAND}
  <h1>登录 DeepSeek 账号</h1>
  <p class="sub">用微信扫一扫下面的二维码</p>
  <div class="qrwrap">
    <div id="spin" class="spinner spinner-lg" role="status" aria-label="正在获取二维码"></div>
    <img id="qr" alt="微信扫码登录" hidden>
  </div>
  <p id="hint" class="foot" hidden></p>
</main>
<script nonce="${nonce}">const embedded = ${embedded ? 'true' : 'false'}
const spin = document.getElementById('spin')
const qr = document.getElementById('qr')
const hint = document.getElementById('hint')
let stopped = false

function say(text) {
  hint.textContent = text
  hint.hidden = text === ''
}
function done() {
  stopped = true
  if (embedded && window.parent !== window) {
    window.parent.postMessage({ type: 'dsh-gate-account', status: 'signed-in' }, location.origin)
  } else if (window.opener) {
    try { window.close() } catch (_error) {}
  } else {
    qr.hidden = true
    spin.hidden = true
    say('已登录，可以关闭此页')
  }
}
function loadQr() {
  spin.hidden = false
  qr.hidden = true
  qr.src = '/__gate/account-login/qr.png?t=' + Date.now()
}
qr.addEventListener('load', () => {
  spin.hidden = true
  qr.hidden = false
  say('')
})
qr.addEventListener('error', () => {
  spin.hidden = true
  say('二维码获取失败，请关闭后重试')
})

// One held-open call answers when the account lands. When the host reports the
// attempt expired, the page fetches a fresh code instead of leaving a dead one
// on screen.
async function waitForLogin(attempt) {
  if (stopped) return
  let result
  try {
    result = await fetch('/__gate/account-login/await').then(r => r.json())
  } catch (_error) {
    return
  }
  if (result.signedIn === true) { done(); return }
  if (result.expired === true && attempt < 3) {
    say('二维码已过期，正在刷新…')
    loadQr()
    waitForLogin(attempt + 1)
  }
}

loadQr()
waitForLogin(0)

// Closing the overlay or the tab must not leave a browser running on the host.
window.addEventListener('pagehide', () => {
  if (stopped) return
  try { navigator.sendBeacon('/__gate/account-login/stop') } catch (_error) {}
})</script>`,
  })
  return { html, csp }
}

/**
 * A short status page: a heading, one paragraph, and optionally auto-refresh.
 * @param options - page title, heading, body text, and refresh interval in seconds.
 */
export function page(options) {
  const { title, heading, body, refresh } = options
  const spinner = refresh === undefined ? '' : '<span class="spinner"></span>'
  return shell({
    title,
    refresh,
    body: `<main class="card">
  ${BRAND}
  <h1>${spinner}${escapeHtml(heading)}</h1>
  <p class="body-text">${escapeHtml(body)}</p>
</main>`,
  })
}
