/**
 * Package uploads into the gateway's `~/.dsh/packages`.
 *
 * A member that compiles a package usually has the fastest internet in the
 * mesh, and its artifacts are large (hundreds of megabytes). Pulling them over
 * the gateway's SSH channel works but is slow; letting the member push the
 * archive to the gate is a single stream with no client-side tools beyond
 * `curl`.
 *
 * The endpoint is deliberately narrow:
 *
 *   - only the VPN peer range (and loopback) may call it, because the public
 *     listener is exposed to the internet;
 *   - the deployment password is required in `x-dsh-gate-token`, so a peer
 *     cannot use it as a free file drop;
 *   - only `.zip`, `.tar.gz`, and `.tgz` names without path separators, and
 *     the body is streamed to a `.part` file and renamed only after its
 *     SHA-256 matches (when the caller sends one).
 *
 * @module dsh-mesh/gate/packages
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'

/** Largest archive the gate accepts, in bytes. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024

/**
 * Write a JSON response.
 * @param {import('node:http').ServerResponse} res response.
 * @param {number} status status.
 * @param {unknown} value body.
 * @returns {void}
 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/**
 * Whether one address belongs to the mesh (or loopback).
 * @param {string} address socket remote address.
 * @param {string[]} prefixes accepted IPv4 prefixes.
 * @returns {boolean} true when the peer may upload.
 */
export function isMeshPeer(address, prefixes) {
  const bare = String(address ?? '').replace(/^::ffff:/u, '')
  if (bare === '::1' || bare === '127.0.0.1') return true
  return prefixes.some(prefix => bare.startsWith(prefix))
}

/**
 * Validate an upload name.
 * @param {string} name query value.
 * @returns {string} normalized name.
 */
export function packageName(name) {
  const value = String(name ?? '').trim()
  if (value === '' || value !== path.basename(value) || value.startsWith('.')) {
    throw new Error('name must be a plain file name')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*\.(?:zip|tar\.gz|tgz)$/iu.test(value)) {
    throw new Error('name must end in .zip, .tar.gz, or .tgz')
  }
  return value
}

/** One upload endpoint bound to its gate configuration. */
export class PackageUploads {
  /**
   * @param {{password: string, packagesDir: string, log?: (line: string) => void}} options options.
   */
  constructor(options) {
    this.password = String(options.password ?? '')
    this.packagesDir = options.packagesDir ?? path.join(os.homedir(), '.dsh', 'packages')
    this.logLine = options.log ?? (() => {})
    this.digest = createHash('sha256').update(this.password, 'utf8').digest()
    /** Mesh prefixes; the WireGuard state is the source of truth, so a custom CIDR works. */
    this.prefixes = ['10.66.66.']
  }

  /**
   * Replace the accepted mesh prefixes.
   * @param {string} cidr `10.66.66.0/24`.
   * @returns {void}
   */
  setCidr(cidr) {
    const value = String(cidr ?? '').trim()
    const match = /^(\d+\.\d+\.\d+)\.\d+\/(\d+)$/u.exec(value)
    if (match === null) return
    this.prefixes = [`${match[1]}.`]
  }

  /**
   * Whether the caller knows the deployment password.
   * @param {import('node:http').IncomingMessage} req request.
   * @returns {boolean} true when admitted.
   */
  #tokenMatches(req) {
    const raw = req.headers['x-dsh-gate-token']
    const value = Array.isArray(raw) ? raw[0] : raw
    if (typeof value !== 'string' || value === '') return false
    const digest = createHash('sha256').update(value, 'utf8').digest()
    return digest.length === this.digest.length && timingSafeEqual(digest, this.digest)
  }

  /**
   * Handle one `/__gate/packages/*` request.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {import('node:http').ServerResponse} res response.
   * @param {URL} url request URL.
   * @returns {Promise<boolean>} true when the path belonged to this module.
   */
  async handle(req, res, url) {
    const pathname = url.pathname
    if (!pathname.startsWith('/__gate/packages')) return false
    try {
      if (req.method === 'GET' && pathname === '/__gate/packages') {
        const entries = await this.#list()
        sendJson(res, 200, { ok: true, dir: this.packagesDir, packages: entries })
        return true
      }
      if (req.method === 'POST' && pathname === '/__gate/packages/upload') {
        await this.#upload(req, res, url)
        return true
      }
      sendJson(res, 404, { ok: false, error: 'unknown packages endpoint' })
    } catch (error) {
      if (!res.headersSent) sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
    return true
  }

  /**
   * Stream one archive into the packages directory.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {import('node:http').ServerResponse} res response.
   * @param {URL} url request URL.
   * @returns {Promise<void>}
   */
  async #upload(req, res, url) {
    if (!isMeshPeer(req.socket.remoteAddress, this.prefixes)) {
      // The public listener shares this path; a non-mesh source gets nothing.
      sendJson(res, 403, { ok: false, error: 'uploads are only accepted from the mesh' })
      return
    }
    if (!this.#tokenMatches(req)) {
      sendJson(res, 401, { ok: false, error: 'missing or wrong x-dsh-gate-token' })
      return
    }
    const name = packageName(url.searchParams.get('name') ?? '')
    const expected = (url.searchParams.get('sha256') ?? '').toLowerCase()
    if (expected !== '' && !/^[0-9a-f]{64}$/u.test(expected)) throw new Error('sha256 must be 64 hex characters')
    const declared = Number.parseInt(String(req.headers['content-length'] ?? ''), 10)
    if (Number.isSafeInteger(declared) && declared > MAX_UPLOAD_BYTES) {
      sendJson(res, 413, { ok: false, error: `archive is larger than ${String(MAX_UPLOAD_BYTES)} bytes` })
      return
    }
    await mkdir(this.packagesDir, { recursive: true })
    const target = path.join(this.packagesDir, name)
    const temporary = path.join(this.packagesDir, `.upload-${randomBytes(4).toString('hex')}.part`)
    const hash = createHash('sha256')
    let bytes = 0
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length
        if (bytes > MAX_UPLOAD_BYTES) {
          callback(new Error('upload exceeded the size limit'))
          return
        }
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    try {
      await pipeline(req, meter, createWriteStream(temporary))
      const digest = hash.digest('hex')
      if (expected !== '' && digest !== expected) throw new Error(`sha256 mismatch: expected ${expected}, got ${digest}`)
      if (bytes === 0) throw new Error('upload body was empty')
      await rename(temporary, target)
      await writeFile(`${target}.sha256`, `${digest}  ${name}\n`, 'utf8')
      this.logLine(`package uploaded: ${name} (${String(bytes)} bytes, sha256 ${digest.slice(0, 12)}…)`)
      sendJson(res, 200, { ok: true, name, bytes, sha256: digest, path: target })
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  /**
   * List the packages already on disk.
   * @returns {Promise<object[]>} entries.
   */
  async #list() {
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(this.packagesDir, { withFileTypes: true }).catch(() => [])
    const packages = []
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(?:zip|tar\.gz|tgz)$/iu.test(entry.name)) continue
      const info = await stat(path.join(this.packagesDir, entry.name)).catch(() => null)
      if (info === null) continue
      packages.push({ name: entry.name, bytes: info.size, mtime: info.mtime.toISOString() })
    }
    return packages.sort((left, right) => right.mtime.localeCompare(left.mtime))
  }
}
