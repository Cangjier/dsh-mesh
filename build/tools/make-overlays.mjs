/**
 * Regenerate the source overlays from a pristine DSH source tree.
 *
 * The overlays are full replacement files. The build engine records the
 * pristine file's SHA-256; if the upstream file changes, the build stops with a
 * work order instead of guessing where the change went.
 *
 * Usage:
 *   node build/tools/make-overlays.mjs --source <dsh-source-root> --out build/overlays
 *
 * This script is a development aid, not part of a build. It applies the same
 * source-level changes documented in `docs/Step 003` and `docs/Step 005`.
 *
 * @module dsh-mesh/build/tools/make-overlays
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const args = process.argv.slice(2)
const sourceIndex = args.indexOf('--source')
const outIndex = args.indexOf('--out')
const source = sourceIndex === -1 ? '' : args[sourceIndex + 1]
const out = outIndex === -1 ? path.resolve('build/overlays') : path.resolve(args[outIndex + 1])
if (source === '') {
  console.error('usage: node build/tools/make-overlays.mjs --source <dsh-source-root> [--out <overlays>]')
  process.exit(1)
}

const PICKER = 'packages/client/ui-directory-picker-browse/src/client/DirectoryBrowser.tsx'
const ACCOUNT = 'packages/client/ui-settings-account/src/client/index.ts'
const OVERLAY = 'packages/client/ui-settings-account/src/client/gate-login-overlay.ts'

const SPINNER = `{loading && slowScan
          && <div className={css.status} role="status" style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            margin: 0,
            boxSizing: 'border-box',
            pointerEvents: 'none',
            zIndex: 3,
          }}>
            <svg width={18} height={18} viewBox="0 0 24 24" aria-label={t('browser.loading')}>
              <circle cx={12} cy={12} r={9} fill="none" stroke="currentColor" strokeWidth={2.5} strokeDasharray="42 14" strokeLinecap="round">
                <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
              </circle>
            </svg>
          </div>}`

const CLOSE_BUTTON = `          <h2 className={css.title}>{t('browser.title')}</h2>
          <button
            type="button"
            aria-label="关闭"
            title="关闭"
            onClick={onClose}
            style={{
              position: 'absolute',
              top: 18,
              right: 13,
              height: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 20,
              lineHeight: 1,
              cursor: 'pointer',
              background: 'transparent',
              border: 0,
              color: 'inherit',
              padding: 0,
              zIndex: 2,
            }}
          >×</button>`

const EMPTY_HINT = `      {visible.length === 0 && busy !== true ? (
        <div className={css.status} style={{ padding: '18px 14px', opacity: 0.55, fontSize: 13 }}>
          {filterPrefix ? '没有匹配的文件夹' : '此文件夹为空'}
        </div>
      ) : null}
      {visible.map((entry) => {`

const LOGIN_OVERLAY = `/**
 * In-page account sign-in helper for the hosted web deployment.
 *
 * The platform only accepts a loopback callback, so the gate runs the browser
 * flow next to DSH and hands back a QR image. This overlay frames the gate's
 * helper page; desktop mode keeps the original flow.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-account/gate-login-overlay
 */

/**
 * Open the gate-hosted account sign-in overlay.
 * @returns {void}
 */
export function openGateLoginOverlay(): void {
  const id = 'dsh-gate-account-login'
  const existing = document.getElementById(id)
  if (existing !== null) {
    existing.remove()
    return
  }
  const wrap = document.createElement('div')
  wrap.id = id
  wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(15,17,21,.45)'
  const box = document.createElement('div')
  box.style.cssText = 'position:relative;width:min(640px,100%);max-height:min(560px,calc(100vh - 48px));display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-text-1,#0f1115);border:1px solid rgba(0,0,0,.10);border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.28);overflow:hidden'
  const bar = document.createElement('div')
  bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid rgba(0,0,0,.08);font:600 14px/1.4 var(--dsw-font-family,system-ui)'
  bar.textContent = '登录 DeepSeek 账号'
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = '关闭'
  close.style.cssText = 'border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;opacity:.6;padding:4px 6px'
  bar.appendChild(close)
  const frame = document.createElement('iframe')
  frame.src = '/__gate/account-login?embed=1'
  frame.style.cssText = 'display:block;width:100%;height:min(326px,calc(100vh - 110px));border:0;background:transparent'
  box.append(bar, frame)
  wrap.append(box)
  document.body.append(wrap)
  function done(): void {
    window.removeEventListener('message', onMessage)
    wrap.remove()
    fetch('/__gate/account-login/stop', { method: 'POST' }).catch(() => {})
  }
  function onMessage(event: MessageEvent): void {
    if (event.origin !== location.origin) return
    if (!event.data || event.data.type !== 'dsh-gate-account') return
    done()
    if (event.data.status === 'signed-in') setTimeout(() => location.reload(), 400)
  }
  close.addEventListener('click', done)
  wrap.addEventListener('click', (event) => {
    if (event.target === wrap) done()
  })
  window.addEventListener('message', onMessage)
}
`

/**
 * Replace exactly one occurrence, failing loudly otherwise.
 * @param {string} text source text.
 * @param {string} find exact anchor.
 * @param {string} replace replacement.
 * @param {string} label what the anchor is.
 * @returns {string} updated text.
 */
function replaceOnce(text, find, replace, label) {
  const at = text.indexOf(find)
  if (at === -1) throw new Error(`anchor not found: ${label}`)
  if (text.indexOf(find, at + 1) !== -1) throw new Error(`anchor is not unique: ${label}`)
  return text.slice(0, at) + replace + text.slice(at + find.length)
}

/**
 * Read a source file.
 * @param {string} relative repo-relative path.
 * @returns {Promise<string>} content.
 */
async function read(relative) {
  return readFile(path.join(source, relative), 'utf8')
}

/**
 * Write an overlay file, creating parent directories.
 * @param {string} relative repo-relative path.
 * @param {string} content file content.
 * @returns {Promise<void>}
 */
async function write(relative, content) {
  const target = path.join(out, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
}

/**
 * SHA-256 of a string.
 * @param {string} text input.
 * @returns {string} hex digest.
 */
function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

let picker = await read(PICKER)
picker = replaceOnce(picker, 'return [{ name: homeLabel, path: listing.home, hidden: false }, ...tail]', 'return [{ name: listing.home, path: listing.home, hidden: false }, ...tail]', 'home crumb label')
picker = replaceOnce(picker, 'function displayCrumbs(listing: DirectoryListing, homeLabel: string)', 'function displayCrumbs(listing: DirectoryListing, _homeLabel: string)', 'home crumb parameter')
picker = replaceOnce(picker, '<div className={css.content}>', '<div className={css.content} style={{ position: \'relative\' }}>', 'content container')
picker = replaceOnce(picker,
  `{loading && slowScan
          && <div className={clsx(css.status, css.loadingFloat)} role="status">{t('browser.loading')}</div>}`,
  SPINNER,
  'loading indicator')
picker = replaceOnce(picker, '<div className={css.header}>', '<div className={css.header} style={{ position: \'relative\' }}>', 'header container')
picker = replaceOnce(picker, `          <h2 className={css.title}>{t('browser.title')}</h2>`, CLOSE_BUTTON, 'header title')
picker = replaceOnce(picker, '      {visible.map((entry) => {', EMPTY_HINT, 'level column children')
picker = replaceOnce(picker,
  `    setPathDraft(null)
    setSelected(entry)
    setChild(null)
    setLoading(true)`,
  `    setPathDraft(null)
    setSelected(entry)
    // Keep the previous level rendered until the next listing is ready.
    setLoading(true)`,
  'select child reset')
picker = `/* dsh-mesh overlay: picker (generated by build/tools/make-overlays.mjs) */\n${picker}`
await write(PICKER, picker)

let account = await read(ACCOUNT)
account = replaceOnce(account,
  `        if (desktop) await request()
        else await browser.start(request, () => snapshot.view)`,
  `        if (desktop) await request()
        else openGateLoginOverlay()`,
  'account start branch')
account = replaceOnce(account,
  'publish({ ...snapshot, loginVisible: true, loginFailed: false })',
  'publish({ ...snapshot, loginVisible: false, loginFailed: false })',
  'login visible publish')
account = replaceOnce(account,
  "import type {} from '@deepseek-ai/dsh-client-product-analytics/client'",
  `import { openGateLoginOverlay } from './gate-login-overlay'
import type {} from '@deepseek-ai/dsh-client-product-analytics/client'`,
  'first import')
account = `/* dsh-mesh overlay: login (generated by build/tools/make-overlays.mjs) */\n${account}`
await write(ACCOUNT, account)
await write(OVERLAY, LOGIN_OVERLAY)

console.log(JSON.stringify({
  source,
  out,
  files: [
    { path: PICKER, sha256: sha256(picker) },
    { path: ACCOUNT, sha256: sha256(account) },
    { path: OVERLAY, sha256: sha256(LOGIN_OVERLAY) },
  ],
}, null, 2))
