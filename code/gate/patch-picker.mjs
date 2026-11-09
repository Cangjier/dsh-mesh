/**
 * Make the workspace directory dialog clearer:
 *
 * 1. the "loading…" text becomes a spinner (nothing to read, just motion);
 * 2. the Home crumb shows the real absolute path instead of the word "主目录";
 * 3. a close button sits at the dialog's top-right.
 *
 * These are text anchors in the shipped client bundle, so the patch is a set of
 * exact replacements with a hard failure when an anchor stops matching (a new
 * DSH release) — better to fail loudly than to ship a half-applied patch.
 *
 * Usage: node patch-picker.mjs <path-to-client.js>
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'

const file = process.argv[2]
if (file === undefined) throw new Error('usage: node patch-picker.mjs <client.js>')

const SPINNER = `children: (0, react_jsx_runtime.jsx)("svg", {
									width: 18,
									height: 18,
									viewBox: "0 0 24 24",
									"aria-label": t("browser.loading"),
									children: (0, react_jsx_runtime.jsx)("circle", {
										cx: 12,
										cy: 12,
										r: 9,
										fill: "none",
										stroke: "currentColor",
										strokeWidth: 2.5,
										strokeDasharray: "42 14",
										strokeLinecap: "round",
										children: (0, react_jsx_runtime.jsx)("animateTransform", {
											attributeName: "transform",
											type: "rotate",
											from: "0 12 12",
											to: "360 12 12",
											dur: "0.9s",
											repeatCount: "indefinite"
										})
									})
								})`

const CLOSE_BUTTON = `(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								"aria-label": "关闭",
								title: "关闭",
								className: DirectoryBrowser_module_css_default.crumbEditZone,
								onClick: () => {
									onClose();
								},
								style: {
									position: "absolute",
									top: 18,
									right: 13,
									height: 28,
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
									fontSize: 20,
									lineHeight: 1,
									cursor: "pointer",
									background: "transparent",
									border: 0,
									color: "inherit",
									padding: 0,
									zIndex: 2
								},
								children: "×"
							})`

let code = readFileSync(file, 'utf8')
if (code.includes('dsh-picker-patched')) {
  console.log('already patched')
  process.exit(0)
}

const steps = []

// 1. Home crumb: the label becomes the absolute path the host reported.
const homeBefore = code
code = code.replace('name: homeLabel,', 'name: listing.home,')
if (code === homeBefore) {
  console.error('anchor not found: home crumb label')
  process.exit(1)
}
steps.push('home crumb shows the full path')

// 2. Loading text becomes a spinner.
const loadBefore = code
code = code.replace('children: t("browser.loading")', SPINNER)
if (code === loadBefore) {
  console.error('anchor not found: loading indicator')
  process.exit(1)
}
steps.push('loading indicator is a spinner')

// 3. Close button in the header, pinned to its top-right corner.
//    The header becomes the offset parent; the button sits above the crumb row.
const headerAnchor = /className: DirectoryBrowser_module_css_default\.header,/
if (!headerAnchor.test(code)) {
  console.error('anchor not found: dialog header container')
  process.exit(1)
}
code = code.replace(headerAnchor, `className: DirectoryBrowser_module_css_default.header,
							style: { position: "relative" },`)

const headerPattern = /(children: t\("browser\.title"\)\s*\}\), )\(0, react_jsx_runtime\.jsx\)\("div", \{\s*className: DirectoryBrowser_module_css_default\.crumbBar,/
if (!headerPattern.test(code)) {
  console.error('anchor not found: dialog header')
  process.exit(1)
}
code = code.replace(headerPattern, (_match, head) => `${head}${CLOSE_BUTTON}, (0, react_jsx_runtime.jsx)("div", {
								className: DirectoryBrowser_module_css_default.crumbBar,`)
steps.push('close button at the top right')

code = `/* dsh-picker-patched */\n${code}`
copyFileSync(file, `${file}.orig`)
writeFileSync(file, code, 'utf8')
console.log(`patched: ${steps.join('; ')}`)
console.log('backup at', `${file}.orig`)
