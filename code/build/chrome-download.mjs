/**
 * Download a headless Chromium for the smoke test when a member has none.
 *
 * A test upgrade runs on the member, and the member may be a minimal Linux
 * server with no Chrome, Chromium, or Edge. The rehearsal is exactly the check
 * that catches a package which boots but cannot render, so skipping it on those
 * hosts leaves the flat-upgrade path unverified. This module fetches the
 * official Chrome for Testing build (`chrome-headless-shell`) for the member's
 * own platform, extracts it with the packaged Node runtime, and caches it under
 * the user's cache directory. It is deliberately not a package dependency:
 * only a host that needs the browser touches the network.
 *
 * Configuration (all optional):
 *
 *   DSH_MESH_SMOKE_CHROME_CACHE     cache directory; default `~/.cache/dsh-mesh/chrome`
 *   DSH_MESH_SMOKE_CHROME_MANIFEST  Chrome for Testing manifest URL
 *   DSH_MESH_SMOKE_CHROME_URL       direct archive URL (used by air-gapped mirrors)
 *
 * @module dsh-mesh/build/chrome-download
 */

import { createWriteStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { extractZip } from './zip.mjs'

/** Official manifest for the current Stable Chrome for Testing build. */
export const CHROME_FOR_TESTING_MANIFEST = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'

/** Artifact name inside a Chrome for Testing archive. */
const ARTIFACT = 'chrome-headless-shell'

/** Download budget: a 128 MiB archive over a slow member link. */
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000

/**
 * Chrome for Testing platform key.
 * @param {NodeJS.Platform|string} [platform] process.platform.
 * @param {string} [arch] process.arch.
 * @returns {string|null} `linux64`, `linux-arm64`, `mac-x64`, `mac-arm64`, `win64`, `win32`, or null when Chrome for Testing has no build.
 */
export function chromeForTestingPlatform(platform = process.platform, arch = process.arch) {
  if (platform === 'linux') {
    if (arch === 'x64') return 'linux64'
    if (arch === 'arm64') return 'linux-arm64'
    return null
  }
  if (platform === 'darwin') {
    if (arch === 'x64') return 'mac-x64'
    if (arch === 'arm64') return 'mac-arm64'
    return null
  }
  if (platform === 'win32') {
    if (arch === 'x64') return 'win64'
    if (arch === 'ia32') return 'win32'
    return null
  }
  return null
}

/**
 * Default cache root for a downloaded browser.
 * @param {NodeJS.ProcessEnv} [env] environment.
 * @param {NodeJS.Platform|string} [platform] process.platform.
 * @returns {string} absolute cache directory.
 */
export function defaultChromeDownloadDir(env = process.env, platform = process.platform) {
  const configured = typeof env.DSH_MESH_SMOKE_CHROME_CACHE === 'string' ? env.DSH_MESH_SMOKE_CHROME_CACHE.trim() : ''
  if (configured !== '') return path.resolve(configured)
  if (platform === 'win32') {
    const localAppData = typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA !== ''
      ? env.LOCALAPPDATA
      : path.join(os.homedir(), 'AppData', 'Local')
    return path.join(localAppData, 'dsh-mesh', 'chrome')
  }
  const xdg = typeof env.XDG_CACHE_HOME === 'string' && env.XDG_CACHE_HOME !== ''
    ? env.XDG_CACHE_HOME
    : path.join(os.homedir(), '.cache')
  return path.join(xdg, 'dsh-mesh', 'chrome')
}

/**
 * Binary name for one platform.
 * @param {NodeJS.Platform|string} platform platform.
 * @returns {string} executable name.
 */
function binaryName(platform) {
  return platform === 'win32' ? `${ARTIFACT}.exe` : ARTIFACT
}

/**
 * Find an already extracted browser in the cache.
 *
 * A cache hit avoids the manifest request too, so a member that ran a test
 * upgrade once can rehearse again with no network at all.
 * @param {string} cacheDir cache root.
 * @param {string} platformKey Chrome for Testing platform.
 * @param {NodeJS.Platform|string} platform running platform.
 * @returns {Promise<{binary: string, version: string}|null>} cached browser.
 */
async function findCachedChrome(cacheDir, platformKey, platform) {
  let entries
  try {
    entries = await readdir(cacheDir, { withFileTypes: true })
  } catch {
    return null
  }
  const versions = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
  for (const version of versions) {
    const binary = path.join(cacheDir, version, platformKey, binaryName(platform))
    const info = await stat(binary).catch(() => null)
    if (info?.isFile() === true && info.size > 0) return { binary, version }
  }
  return null
}

/**
 * Download one URL to a file, logging coarse progress.
 * @param {string} url source.
 * @param {string} file destination (written through a `.part` file).
 * @param {{fetchImpl?: typeof fetch, log?: (line: string) => void, timeoutMs?: number}} options dependencies.
 * @returns {Promise<void>}
 */
async function downloadFile(url, file, options) {
  const fetchImpl = options.fetchImpl ?? fetch
  const log = options.log ?? (() => {})
  log(`GET ${url}`)
  const response = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS),
  })
  if (!response.ok || response.body === null) {
    throw new Error(`download failed: ${url} -> HTTP ${String(response.status)}`)
  }
  const total = Number(response.headers.get('content-length') ?? 0)
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.part`
  let received = 0
  let nextPercent = 10
  const source = Readable.fromWeb(response.body)
  source.on('data', (chunk) => {
    received += chunk.length
    if (total <= 0) return
    const percent = Math.floor((received / total) * 100)
    if (percent < nextPercent) return
    nextPercent = Math.min(100, percent + 10)
    log(`downloading Chrome: ${String(percent)}% (${String(Math.round(received / 1_048_576))} MiB)`)
  })
  try {
    await pipeline(source, createWriteStream(temporary))
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  if (total > 0 && received !== total) {
    throw new Error(`download incomplete: ${url} (${String(received)} of ${String(total)} bytes)`)
  }
}

/**
 * Read the Stable chrome-headless-shell archive URL from the manifest.
 * @param {string} manifestUrl manifest.
 * @param {string} platformKey Chrome for Testing platform.
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} options dependencies.
 * @returns {Promise<{version: string, url: string}>} archive coordinates.
 */
async function resolveArchive(manifestUrl, platformKey, options) {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(manifestUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  })
  if (!response.ok) throw new Error(`cannot read the Chrome for Testing manifest: HTTP ${String(response.status)}`)
  const body = await response.json()
  const stable = body?.channels?.Stable
  const version = typeof stable?.version === 'string' ? stable.version : ''
  const downloads = Array.isArray(stable?.downloads?.[ARTIFACT]) ? stable.downloads[ARTIFACT] : []
  const entry = downloads.find(candidate => candidate?.platform === platformKey)
  if (version === '' || typeof entry?.url !== 'string') {
    throw new Error(`Chrome for Testing has no ${ARTIFACT} build for ${platformKey}`)
  }
  return { version, url: entry.url }
}

/**
 * Find a headless Chromium for this host, downloading Chrome for Testing when
 * no browser is installed.
 * @param {{env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform|string, arch?: string, cacheDir?: string, manifestUrl?: string, archiveUrl?: string, fetchImpl?: typeof fetch, log?: (line: string) => void}} [options] dependencies and overrides.
 * @returns {Promise<{binary: string, version: string, platform: string, cacheDir: string, cached: boolean}>} browser.
 */
export async function ensureDownloadedChrome(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const log = options.log ?? (() => {})
  const platformKey = chromeForTestingPlatform(platform, arch)
  if (platformKey === null) {
    throw new Error(`Chrome for Testing has no build for ${platform}-${arch}`)
  }
  const cacheDir = options.cacheDir ?? defaultChromeDownloadDir(env, platform)
  const cached = await findCachedChrome(cacheDir, platformKey, platform)
  if (cached !== null) {
    log(`using cached Chrome for Testing ${cached.version} (${platformKey}): ${cached.binary}`)
    return { ...cached, platform: platformKey, cacheDir, cached: true }
  }

  const archiveOverride = options.archiveUrl
    ?? (typeof env.DSH_MESH_SMOKE_CHROME_URL === 'string' ? env.DSH_MESH_SMOKE_CHROME_URL.trim() : '')
  const manifestUrl = options.manifestUrl
    ?? (typeof env.DSH_MESH_SMOKE_CHROME_MANIFEST === 'string' && env.DSH_MESH_SMOKE_CHROME_MANIFEST.trim() !== ''
      ? env.DSH_MESH_SMOKE_CHROME_MANIFEST.trim()
      : CHROME_FOR_TESTING_MANIFEST)
  const resolved = archiveOverride === ''
    ? await resolveArchive(manifestUrl, platformKey, options)
    : { version: 'custom', url: archiveOverride }
  const version = resolved.version.replace(/[^0-9A-Za-z._-]/gu, '_')
  log(`no browser found; downloading Chrome for Testing ${version} (${platformKey})`)
  log(`archive: ${resolved.url}`)

  await mkdir(cacheDir, { recursive: true })
  const temporary = await mkdtemp(path.join(cacheDir, '.download-'))
  try {
    const archive = path.join(temporary, `${ARTIFACT}.zip`)
    await downloadFile(resolved.url, archive, options)
    log(`extracting Chrome for Testing ${version}`)
    const extracted = path.join(temporary, 'extract')
    await extractZip(archive, extracted)
    const binary = path.join(temporary, 'extract', `${ARTIFACT}-${platformKey}`, binaryName(platform))
    const info = await stat(binary).catch(() => null)
    if (info?.isFile() !== true) {
      throw new Error(`the ${platformKey} archive did not contain ${ARTIFACT}-${platformKey}/${binaryName(platform)}`)
    }
    await chmod(binary, 0o755)
    const finalDir = path.join(cacheDir, version, platformKey)
    await mkdir(path.dirname(finalDir), { recursive: true })
    await rm(finalDir, { recursive: true, force: true })
    await rename(path.dirname(binary), finalDir)
    const installed = path.join(finalDir, binaryName(platform))
    // Keep one browser per member: a new Stable release replaces the old tree
    // instead of growing the cache by ~277 MiB every few weeks.
    for (const entry of await readdir(cacheDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === version) continue
      await rm(path.join(cacheDir, entry.name), { recursive: true, force: true }).catch(() => {})
    }
    log(`Chrome for Testing ${version} ready: ${installed}`)
    return { binary: installed, version, platform: platformKey, cacheDir, cached: false }
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => {})
  }
}
