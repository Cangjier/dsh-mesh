/**
 * Build one offline package per target from the already-installed DSH web
 * shell plus the repo's built-bundle client patches.
 *
 * This is the fast, reproducible path when a full source `pnpm install` is not
 * available on the build machine. It is not a substitute for the source build:
 * the web shell comes from the installed `@deepseek-ai/dsh-web-frontend`, and
 * the directory-picker/login UI is applied to the client plugin bundles with
 * `code/gate/patch-*.mjs`.
 *
 * Usage:
 *   node build/tools/package-prebuilt.mjs --targets linux-x64,win-x64
 *
 * @module dsh-mesh/build/tools/package-prebuilt
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { archivePackage, assembleRuntimePackage } from '../../code/build/engine.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(HERE, '..', '..')
const args = process.argv.slice(2)

/**
 * Read a `--name value` argument.
 * @param {string} name argument name.
 * @param {string} fallback default.
 * @returns {string} value.
 */
function value(name, fallback) {
  const at = args.indexOf(`--${name}`)
  if (at === -1 || args[at + 1] === undefined) return fallback
  return args[at + 1]
}

const dshVersion = value('dsh-version', '0.2.2-rc.1')
const targets = value('targets', 'linux-x64,win-x64').split(',').map(item => item.trim()).filter(Boolean)
const out = path.resolve(value('out', path.join(REPOSITORY_ROOT, 'dist')))
const asar = path.resolve(value('app-asar', path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
  'Programs',
  'DeepSeek Harness',
  'resources',
  'app.asar',
)))
const nodeVersion = value('node-version', process.versions.node)
const cacheDir = path.join(os.homedir(), '.dsh', 'mesh', 'cache')
const frontendCache = path.join(cacheDir, 'prebuilt-frontend', dshVersion)

/**
 * Extract `@deepseek-ai/dsh-web-frontend/dist` from app.asar.
 * @param {string} archive asar path.
 * @param {string} destination output directory.
 * @returns {Promise<string>} destination.
 */
async function extractFrontend(archive, destination) {
  if (fs.existsSync(path.join(destination, 'index.html'))) return destination
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  const handle = fs.openSync(archive, 'r')
  const head = Buffer.alloc(16)
  fs.readSync(handle, head, 0, 16, 0)
  const jsonSize = head.readUInt32LE(12)
  const jsonBuf = Buffer.alloc(jsonSize)
  fs.readSync(handle, jsonBuf, 0, jsonSize, 16)
  const header = JSON.parse(jsonBuf.toString('utf8'))
  const base = 16 + jsonSize
  const prefix = '/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/'
  let count = 0
  const walk = (node, current) => {
    if (node.files) {
      for (const [name, child] of Object.entries(node.files)) walk(child, `${current}/${name}`)
      return
    }
    if (!current.startsWith(prefix)) return
    const relative = current.slice(prefix.length)
    const target = path.join(destination, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (node.link !== undefined) return
    const size = Number(node.size)
    const offset = base + Number(node.offset)
    const buf = Buffer.alloc(size)
    fs.readSync(handle, buf, 0, size, offset)
    fs.writeFileSync(target, buf)
    count += 1
  }
  walk(header, '')
  fs.closeSync(handle)
  if (!fs.existsSync(path.join(destination, 'index.html'))) {
    throw new Error(`app.asar has no web frontend at ${prefix}`)
  }
  console.log(`extracted ${count} frontend files to ${destination}`)
  return destination
}

/**
 * Format one artifact size.
 * @param {number} bytes size.
 * @returns {string} human readable.
 */
function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

await mkdir(out, { recursive: true })
const dist = await extractFrontend(asar, frontendCache)
const artifacts = []
for (const target of targets) {
  console.log(`\n=== ${target} ===`)
  const assembled = await assembleRuntimePackage({
    dist,
    target,
    outputDir: out,
    version: dshVersion,
    dshVersion,
    repositoryRoot: REPOSITORY_ROOT,
    source: `prebuilt:@deepseek-ai/dsh@${dshVersion}`,
    ref: dshVersion,
    tree: null,
    nodeVersion,
    cacheDir,
    log: line => console.log(line),
  })
  const archive = await archivePackage(assembled.packageDir, target, { log: line => console.log(line) })
  const size = fs.statSync(archive).size
  const sha = createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
  await writeFile(`${archive}.sha256`, `${sha}  ${path.basename(archive)}\n`, 'utf8')
  artifacts.push({ target, archive, bytes: size, sha256: sha })
  console.log(`artifact ${archive} (${mb(size)})`)
}

await writeFile(path.join(out, 'artifacts.json'), JSON.stringify({
  dshVersion,
  nodeVersion,
  generatedAt: new Date().toISOString(),
  artifacts,
}, null, 2), 'utf8')
console.log(`\nwrote ${path.join(out, 'artifacts.json')}`)
