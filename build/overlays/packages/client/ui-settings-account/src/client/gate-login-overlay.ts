/**
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
