/**
 * Make the app's own 登录 button open the扫码 helper as an in-page overlay.
 *
 * The shipped client calls `account/startSignIn` with `window.location.origin`,
 * which the platform rejects for any non-loopback origin, so on this deployment
 * that path can only fail. In web mode it now injects an overlay that frames the
 * gate's helper page; the helper posts a message when the account is signed in,
 * the overlay closes and the app reloads. Desktop mode is untouched.
 *
 * Idempotent: running it twice reports "already patched".
 * Usage: node patch-login.mjs <path-to-client.js>
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'

const file = process.argv[2]
if (file === undefined) throw new Error('usage: node patch-login.mjs <client.js>')

const OVERLAY = `(function () {
						const id = "dsh-gate-account-login";
						const existing = document.getElementById(id);
						if (existing !== null) {
							existing.remove();
							return;
						}
						const wrap = document.createElement("div");
						wrap.id = id;
						wrap.style.cssText = "position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(15,17,21,.45)";
						const box = document.createElement("div");
						box.style.cssText = "position:relative;width:min(640px,100%);max-height:min(560px,calc(100vh - 48px));display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-text-1,#0f1115);border:1px solid rgba(0,0,0,.10);border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.28);overflow:hidden";
						const bar = document.createElement("div");
						bar.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid rgba(0,0,0,.08);font:600 14px/1.4 var(--dsw-font-family,system-ui)";
						bar.textContent = "登录 DeepSeek 账号";
						const close = document.createElement("button");
						close.type = "button";
						close.textContent = "关闭";
						close.style.cssText = "border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;opacity:.6;padding:4px 6px";
						bar.appendChild(close);
						const frame = document.createElement("iframe");
						frame.src = "/__gate/account-login?embed=1";
						frame.style.cssText = "display:block;width:100%;height:min(326px,calc(100vh - 110px));border:0;background:transparent";
						box.append(bar, frame);
						wrap.append(box);
						document.body.append(wrap);
						const done = () => {
							window.removeEventListener("message", onMessage);
							wrap.remove();
							fetch("/__gate/account-login/stop", { method: "POST" }).catch(() => {});
						};
						const onMessage = (event) => {
							if (event.origin !== location.origin) return;
							if (!event.data || event.data.type !== "dsh-gate-account") return;
							done();
							if (event.data.status === "signed-in") setTimeout(() => location.reload(), 400);
						};
						close.addEventListener("click", done);
						wrap.addEventListener("click", (event) => {
							if (event.target === wrap) done();
						});
						window.addEventListener("message", onMessage);
					})();`

const original = readFileSync(file, 'utf8')
if (original.includes('dsh-gate-account-login')) {
  console.log('already patched')
  process.exit(0)
}

// Minified release bundles collapse whitespace: the same two edits use compact
// anchors. Desktop mode and the surrounding account state are untouched.
const minifiedBranch = 'if(desktop)await request();else await browser.start(request,()=>snapshot.view)'
const minifiedVisible = 'loginVisible:true,loginFailed:false'
if (original.includes(minifiedBranch)) {
  const branchCount = original.split(minifiedBranch).length - 1
  if (branchCount !== 1) {
    console.error(`expected exactly one match, found ${String(branchCount)}`)
    process.exit(1)
  }
  if (!original.includes(minifiedVisible)) {
    console.error('could not find the login-visible publish')
    process.exit(1)
  }
  let patchedMin = original.replace(minifiedBranch, `if(desktop)await request();else ${OVERLAY}`)
  patchedMin = patchedMin.replace(minifiedVisible, 'loginVisible:false,loginFailed:false')
  copyFileSync(file, `${file}.orig`)
  writeFileSync(file, patchedMin, 'utf8')
  console.log('patched (minified); backup at', `${file}.orig`)
  process.exit(0)
}

// 1. The hosted overlay replaces the platform pop-up flow.
const pattern = /([ \t]*)if \(desktop\) await request\(\);\r?\n([ \t]*)else await browser\.start\(request, \(\) => snapshot\.view\);/
const matches = [...original.matchAll(new RegExp(pattern.source, 'g'))]
if (matches.length !== 1) {
  console.error(`expected exactly one match, found ${matches.length}`)
  process.exit(1)
}
const match = matches[0]
const innerIndent = match[2]
let patched = original.replace(pattern, `${match[1]}if (desktop) await request();\n${innerIndent}else ${OVERLAY}`)

// 2. The app's own "waiting for the browser" panel must not appear on top of
//    the overlay; the overlay is the whole interaction.
const visible = /loginVisible: true,(\r?\n[ \t]*)loginFailed: false/
if (!visible.test(patched)) {
  console.error('could not find the login-visible publish')
  process.exit(1)
}
patched = patched.replace(visible, 'loginVisible: false,$1loginFailed: false')

copyFileSync(file, `${file}.orig`)
writeFileSync(file, patched, 'utf8')
console.log('patched; backup at', `${file}.orig`)
