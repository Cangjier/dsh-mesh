/**
 * One static-asset store for every downloadable artifact the gateway hosts.
 *
 * The layout is intentionally boring:
 *
 *   gate/assets/<name>/manifest.json
 *   gate/assets/<name>/<file>
 *
 * A manifest names a version and lists one or more platform files, each with a
 * SHA-256 and a byte count. The store exposes a single public read API:
 *
 *   GET /__gate/assets              index of every known asset
 *   GET /__gate/assets/<name>       one manifest
 *   GET /__gate/assets/<name>/<f>   one file
 *
 * Installation binaries are not secrets and a fresh member must fetch the
 * WireGuard installer before it has joined WireGuard, so these routes are
 * deliberately readable without the gate login cookie. Configuration and
 * member endpoints remain behind the normal admission check.
 *
 * @module dsh-mesh/gate/static-assets
 */

import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets')
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u
const FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

const CONTENT_TYPES = new Map([
  ['.exe', 'application/vnd.microsoft.portable-executable'],
  ['.msi', 'application/x-msi'],
  ['.zip', 'application/zip'],
  ['.gz', 'application/gzip'],
  ['.tgz', 'application/gzip'],
  ['.tar', 'application/x-tar'],
  ['.deb', 'application/vnd.debian.binary-package'],
  ['.rpm', 'application/x-rpm'],
  ['.bin', 'application/octet-stream'],
])

/** Send one small JSON response. */
function sendJson(res, status, value, headOnly = false) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  if (headOnly) res.end()
  else res.end(body)
}

/** Content type for a file name, preferring the manifest value. */
function contentTypeFor(file, fallback) {
  if (typeof fallback === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/iu.test(fallback)) return fallback
  return CONTENT_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream'
}

/**
 * Normalize one manifest and reject entries a downloader cannot verify.
 * @param {unknown} raw parsed JSON.
 * @param {string} folder directory name.
 * @returns {object} normalized manifest.
 */
function normalizeManifest(raw, folder) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('manifest must be a JSON object')
  }
  const legacy = !Array.isArray(raw.assets) && typeof raw.file === 'string'
  const entries = legacy
    ? [{ os: 'windows', arch: 'x64', file: raw.file, sha256: raw.sha256, bytes: raw.bytes }]
    : raw.assets
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('manifest has no assets')
  const assets = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const file = typeof entry.file === 'string' ? entry.file : ''
    const sha256 = typeof entry.sha256 === 'string' ? entry.sha256.toLowerCase() : ''
    const bytes = Number(entry.bytes)
    if (!FILE_PATTERN.test(file) || !SHA256_PATTERN.test(sha256)) continue
    if (!Number.isSafeInteger(bytes) || bytes <= 0) continue
    assets.push({
      os: typeof entry.os === 'string' ? entry.os : '',
      arch: typeof entry.arch === 'string' ? entry.arch : '',
      kind: typeof entry.kind === 'string' ? entry.kind : 'file',
      file,
      sha256,
      bytes,
      contentType: contentTypeFor(file, entry.contentType),
    })
  }
  if (assets.length === 0) throw new Error('manifest has no usable assets')
  const name = typeof raw.name === 'string' && NAME_PATTERN.test(raw.name) ? raw.name : folder
  return {
    format: 1,
    name,
    version: typeof raw.version === 'string' && raw.version.trim() !== '' ? raw.version.trim() : 'unknown',
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : null,
    assets,
  }
}

/** Serve the gateway's bundled static assets. */
export class StaticAssets {
  /**
   * @param {object} [options] dependencies.
   * @param {string} [options.root] assets directory.
   * @param {(line: string) => void} [options.log] diagnostic sink.
   */
  constructor(options = {}) {
    this.root = options.root ?? DEFAULT_ROOT
    this.log = options.log ?? (() => {})
  }

  /** Directory for one valid asset name, or null. */
  #directory(name) {
    if (!NAME_PATTERN.test(name)) return null
    return path.join(this.root, name)
  }

  /**
   * Read and normalize one asset directory.
   * @param {string} folder directory name.
   * @returns {Promise<object>} normalized manifest with its directory.
   */
  async #read(folder) {
    const directory = this.#directory(folder)
    if (directory === null) throw new Error('invalid asset name')
    const raw = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))
    const manifest = normalizeManifest(raw, folder)
    return { ...manifest, directory, manifestPath: path.join(directory, 'manifest.json') }
  }

  /**
   * List every valid asset directory. A broken optional manifest is skipped.
   * @returns {Promise<Array<{name: string, version: string, manifest: string, assets: object[]}>>} index.
   */
  async index() {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => [])
    const result = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const manifest = await this.#read(entry.name)
        result.push({
          name: manifest.name,
          version: manifest.version,
          manifest: `/__gate/assets/${encodeURIComponent(manifest.name)}`,
          assets: manifest.assets.map(asset => ({
            ...asset,
            url: `/__gate/assets/${encodeURIComponent(manifest.name)}/${encodeURIComponent(asset.file)}`,
          })),
        })
      } catch (error) {
        this.log(`static asset ${entry.name} skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    result.sort((left, right) => left.name.localeCompare(right.name))
    return result
  }

  /**
   * One normalized manifest.
   * @param {string} name asset name.
   * @returns {Promise<object>} manifest.
   */
  async manifest(name) {
    const manifest = await this.#read(name)
    return {
      format: manifest.format,
      name: manifest.name,
      version: manifest.version,
      generatedAt: manifest.generatedAt,
      assets: manifest.assets,
    }
  }

  /**
   * Resolve one file and verify its byte count against the manifest.
   * @param {string} name asset name.
   * @param {string} file file name.
   * @returns {Promise<{path: string, name: string, size: number, sha256: string, contentType: string}>} file.
   */
  async file(name, file) {
    const manifest = await this.#read(name)
    const asset = manifest.assets.find(item => item.file === file)
    if (asset === undefined) {
      const error = new Error(`unknown file for ${name}: ${file}`)
      error.status = 404
      throw error
    }
    const target = path.join(manifest.directory, asset.file)
    const info = await stat(target).catch(() => null)
    if (info === null || !info.isFile()) {
      const error = new Error(`asset file is missing: ${asset.file}`)
      error.status = 503
      throw error
    }
    if (info.size !== asset.bytes) {
      const error = new Error(`asset size mismatch: ${asset.file} (${info.size} != ${asset.bytes})`)
      error.status = 503
      throw error
    }
    return {
      path: target,
      name: asset.file,
      size: asset.bytes,
      sha256: asset.sha256,
      contentType: asset.contentType,
    }
  }

  /**
   * First asset for an OS/arch pair, used by the legacy single-file aliases.
   * @param {string} name asset name.
   * @param {string} os operating system.
   * @param {string} arch architecture.
   * @returns {Promise<object>} asset metadata.
   */
  async #first(name, os = '', arch = '') {
    const manifest = await this.manifest(name)
    const asset = manifest.assets.find(item => (os === '' || item.os === os) && (arch === '' || item.arch === arch))
    if (asset === undefined) {
      const error = new Error(`no ${os}/${arch} asset for ${name}`)
      error.status = 404
      throw error
    }
    return asset
  }

  /**
   * Stream one resolved file.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {import('node:http').ServerResponse} res response.
   * @param {{path: string, name: string, size: number, sha256: string, contentType: string}} file resolved file.
   * @returns {Promise<void>} completion.
   */
  async #sendFile(req, res, file) {
    res.writeHead(200, {
      'content-type': file.contentType,
      'content-length': file.size,
      'content-disposition': `attachment; filename="${file.name.replace(/["\\]/g, '')}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-dsh-asset-sha256': file.sha256,
      'x-dsh-asset-name': file.name,
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    await new Promise((resolve, reject) => {
      const stream = createReadStream(file.path)
      stream.once('error', reject)
      stream.once('end', resolve)
      stream.pipe(res)
    })
  }

  /**
   * Serve one asset request, or return false when the path is not ours.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {import('node:http').ServerResponse} res response.
   * @param {URL} url parsed URL.
   * @returns {Promise<boolean>} whether the request was handled.
   */
  async handle(req, res, url) {
    const pathname = url.pathname
    const method = req.method ?? 'GET'
    const isRead = method === 'GET' || method === 'HEAD'
    let name = ''
    let file = ''
    let legacyIndex = false
    let legacySingle = false

    if (pathname === '/__gate/assets') {
      legacyIndex = true
    } else if (pathname.startsWith('/__gate/assets/')) {
      const rest = pathname.slice('/__gate/assets/'.length)
      const parts = rest.split('/')
      if (parts.length > 2 || parts.some(part => part === '')) return false
      try {
        name = decodeURIComponent(parts[0])
        if (parts.length === 2) file = decodeURIComponent(parts[1])
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid asset path' }, method === 'HEAD')
        return true
      }
    } else if (pathname === '/__gate/hysteria/assets') {
      name = 'hysteria2'
      legacyIndex = true
    } else if (pathname.startsWith('/__gate/hysteria/asset/')) {
      name = 'hysteria2'
      file = pathname.slice('/__gate/hysteria/asset/'.length)
    } else if (pathname === '/__gate/openssh/manifest') {
      name = 'openssh'
      legacyIndex = true
    } else if (pathname === '/__gate/openssh/asset' || pathname.startsWith('/__gate/openssh/asset/')) {
      name = 'openssh'
      legacySingle = pathname === '/__gate/openssh/asset'
      file = legacySingle ? '' : pathname.slice('/__gate/openssh/asset/'.length)
    } else {
      return false
    }

    if (!isRead) {
      sendJson(res, 405, { ok: false, error: 'read only' }, method === 'HEAD')
      return true
    }
    try {
      if (legacyIndex) {
        if (name === '') {
          sendJson(res, 200, { ok: true, assets: await this.index() }, method === 'HEAD')
        } else {
          sendJson(res, 200, { ok: true, ...(await this.manifest(name)) }, method === 'HEAD')
        }
        return true
      }
      if (name !== '') {
        if (file === '' && !legacySingle) {
          sendJson(res, 200, { ok: true, ...(await this.manifest(name)) }, method === 'HEAD')
          return true
        }
        const target = legacySingle ? (await this.#first(name, 'windows', 'x64')).file : file
        await this.#sendFile(req, res, await this.file(name, target))
        return true
      }
    } catch (error) {
      const status = Number(error?.status) || 500
      if (!res.headersSent) sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) }, method === 'HEAD')
      else res.destroy()
      return true
    }
    return false
  }
}
