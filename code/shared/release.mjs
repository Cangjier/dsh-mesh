/**
 * Publish the newest deployment packages to GitHub and Gitee releases.
 *
 * The compile host is the only machine that has the archives, and the whole
 * point of this module is that other members never pull hundreds of megabytes
 * through the gateway. So the build host uploads here, and a member later
 * reads `latest.json` and downloads the archive itself.
 *
 * The release layout is deliberately boring and stable:
 *
 *   tag `latest`
 *     latest.json                         small, the source of truth
 *     <archive>                           GitHub only: whole file, 2 GB limit
 *     <archive>.part001 … partNNN         Gitee only: <100 MB attachments
 *
 * Gitee caps one attachment at ~100 MB and one repository at ~1 GB, so the
 * archive is split for Gitee. The split is only a transport detail: the
 * downloader concatenates the parts and verifies the archive's SHA-256.
 * GitHub keeps the whole file, because it does not need the workaround.
 *
 * "Only the latest version" is enforced by deleting every asset that is not
 * part of the build being published. Gitee is cleaned *before* the new parts
 * go up (the quota cannot hold both revisions); GitHub is cleaned after the
 * new assets are complete, so GitHub never has a gap.
 *
 * @module dsh-mesh/shared/release
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import {
  isSuccess,
  multipartFileBody,
  openResponse,
  readText,
  requestJson,
  uploadFile,
} from './http-client.mjs'

/** One fixed tag keeps every download URL stable across builds. */
export const DEFAULT_RELEASE_TAG = 'latest'
/** Gitee rejects attachments over 100 MB; 85 MiB leaves room for accounting. */
export const DEFAULT_PART_BYTES = 85 * 1024 * 1024
/** Hard ceiling regardless of configuration: a part above this cannot land. */
export const MAX_PART_BYTES = 95 * 1024 * 1024
/** The manifest every client reads first. */
export const LATEST_MANIFEST_NAME = 'latest.json'
/** Gitee's repository-wide attachment budget, with a safety margin. */
export const GITEE_REPO_QUOTA_BYTES = 950 * 1024 * 1024

/**
 * Default config file: the gateway's durable mesh directory.
 * @returns {string} absolute path.
 */
export function defaultReleaseConfigFile() {
  // Match the plugin's data directory: DSH_HOME can move the whole home, and
  // the panel and the CLI must agree on where the tokens live.
  const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : path.join(homedir(), '.dsh')
  return path.join(home, 'mesh', 'release.json')
}

/**
 * Normalize one owner/repo pair.
 * @param {unknown} value candidate.
 * @returns {{owner: string, repo: string}} normalized, empty when invalid.
 */
function normalizeRepo(value) {
  if (value === null || typeof value !== 'object') return { owner: '', repo: '' }
  const owner = String(value.owner ?? '').trim()
  const repo = String(value.repo ?? '').trim()
  const valid = (part) => /^[A-Za-z0-9_.-]+$/u.test(part)
  return { owner: valid(owner) ? owner : '', repo: valid(repo) ? repo : '' }
}

/**
 * Read the release config from disk, with environment tokens on top.
 *
 * The file is the durable place (`~/.dsh/mesh/release.json`, mode 0600) because
 * the panel runs as one user and the tokens must not end up in the profile
 * config, which is copied to every member. Environment variables are an escape
 * hatch for a one-off build.
 * @param {{file?: string, env?: NodeJS.ProcessEnv}} [options] options.
 * @returns {Promise<object>} normalized config; `enabled` is false when nothing usable is configured.
 */
export async function loadReleaseConfig(options = {}) {
  const file = options.file ?? defaultReleaseConfigFile()
  const env = options.env ?? process.env
  let parsed = {}
  let fileError = null
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {}
  } catch (error) {
    // A missing file is the normal first-run state; only a malformed or
    // unreadable file is worth showing the operator.
    if (error?.code !== 'ENOENT') fileError = error instanceof Error ? error.message : String(error)
    parsed = {}
  }
  const github = normalizeRepo(parsed.github)
  const gitee = normalizeRepo(parsed.gitee)
  const githubToken = String(env.DSH_MESH_GITHUB_TOKEN ?? parsed.github?.token ?? '').trim()
  const giteeToken = String(env.DSH_MESH_GITEE_TOKEN ?? parsed.gitee?.token ?? '').trim()
  const requestedTag = String(parsed.tag ?? DEFAULT_RELEASE_TAG).trim()
  const tag = /^[A-Za-z0-9._-]{1,64}$/u.test(requestedTag) ? requestedTag : DEFAULT_RELEASE_TAG
  const requestedPart = Number(parsed.partBytes)
  const partBytes = Number.isSafeInteger(requestedPart) && requestedPart >= 1024 * 1024
    ? Math.min(requestedPart, MAX_PART_BYTES)
    : DEFAULT_PART_BYTES
  const enabled = parsed.enabled !== false
  const result = {
    file,
    fileError,
    enabled,
    tag,
    partBytes,
    github: {
      ...github,
      token: githubToken,
      enabled: enabled && github.owner !== '' && github.repo !== '' && githubToken !== '',
    },
    gitee: {
      ...gitee,
      token: giteeToken,
      enabled: enabled && gitee.owner !== '' && gitee.repo !== '' && giteeToken !== '',
      // Gitee needs a real commit-ish to point the `latest` tag at.
      branch: typeof parsed.gitee?.branch === 'string' && parsed.gitee.branch.trim() !== ''
        ? parsed.gitee.branch.trim()
        : 'main',
    },
  }
  return result
}

/**
 * The config shape the panel may see: tokens become booleans.
 * @param {object} config loaded config.
 * @returns {object} sanitized config.
 */
export function sanitizeReleaseConfig(config) {
  return {
    file: config.file,
    fileError: config.fileError ?? null,
    enabled: config.enabled === true,
    tag: config.tag,
    partBytes: config.partBytes,
    github: {
      owner: config.github?.owner ?? '',
      repo: config.github?.repo ?? '',
      enabled: config.github?.enabled === true,
      hasToken: String(config.github?.token ?? '') !== '',
    },
    gitee: {
      owner: config.gitee?.owner ?? '',
      repo: config.gitee?.repo ?? '',
      branch: config.gitee?.branch ?? 'main',
      enabled: config.gitee?.enabled === true,
      hasToken: String(config.gitee?.token ?? '') !== '',
    },
  }
}

/**
 * Persist a release config edited in the panel.
 *
 * An empty token field keeps the stored token: the panel only ever receives
 * `hasToken`, so a round-trip must not silently erase a working credential.
 * The file is written 0600 because it contains two access tokens.
 * @param {{file?: string, input: object, env?: NodeJS.ProcessEnv}} options save input.
 * @returns {Promise<object>} normalized config after the save.
 */
export async function saveReleaseConfig(options) {
  const file = options.file ?? defaultReleaseConfigFile()
  const input = options.input ?? {}
  const existing = await loadReleaseConfig({ file, env: options.env ?? {} })
  const github = normalizeRepo(input.github ?? {})
  const gitee = normalizeRepo(input.gitee ?? {})
  const githubToken = typeof input.github?.token === 'string' && input.github.token.trim() !== ''
    ? input.github.token.trim()
    : existing.github?.token ?? ''
  const giteeToken = typeof input.gitee?.token === 'string' && input.gitee.token.trim() !== ''
    ? input.gitee.token.trim()
    : existing.gitee?.token ?? ''
  const tag = String(input.tag ?? existing.tag ?? DEFAULT_RELEASE_TAG).trim()
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(tag)) throw new Error(`release tag is invalid: ${tag}`)
  const requestedPart = Number(input.partBytes ?? existing.partBytes)
  if (Number.isFinite(requestedPart) && (requestedPart < 1024 * 1024 || requestedPart > MAX_PART_BYTES)) {
    throw new Error(`part size must be between 1 MiB and ${String(MAX_PART_BYTES)} bytes`)
  }
  const branch = String(input.gitee?.branch ?? existing.gitee?.branch ?? 'main').trim()
  if (!/^[A-Za-z0-9._/-]{1,120}$/u.test(branch)) throw new Error(`Gitee branch is invalid: ${branch}`)
  const stored = {
    enabled: input.enabled === undefined ? existing.enabled !== false : input.enabled === true,
    tag,
    partBytes: Number.isFinite(requestedPart) ? Math.min(Math.round(requestedPart), MAX_PART_BYTES) : DEFAULT_PART_BYTES,
    github: { owner: github.owner, repo: github.repo, token: githubToken },
    gitee: { owner: gitee.owner, repo: gitee.repo, token: giteeToken, branch },
  }
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(file, 0o600).catch(() => {
    // Best effort: the content is already on disk; a chmod failure on an
    // exotic filesystem must not throw away the operator's edit.
  })
  return loadReleaseConfig({ file, env: options.env ?? {} })
}

/**
 * Strip credentials from an asset URL.
 *
 * The download URL is written into a public manifest. Gitee normally returns a
 * plain release URL, but a provider that echoes the request's `access_token`
 * would otherwise publish the token.
 * @param {string} value URL.
 * @returns {string} URL without token-like query parameters.
 */
function publicAssetUrl(value) {
  try {
    const url = new URL(value)
    for (const name of ['access_token', 'token', 'access-token']) url.searchParams.delete(name)
    return url.href
  } catch {
    return value
  }
}

/**
 * The latest.json locations a client should try, in order.
 *
 * GitHub is first: through the egress proxy it is the more reliable of the
 * two, and the whole file is downloaded in one shot. Gitee follows as the
 * domestic fallback.
 * @param {object} config loaded config.
 * @returns {string[]} absolute manifest URLs.
 */
export function latestManifestSources(config) {
  const sources = { github: null, gitee: null }
  if (config?.enabled !== false && config.github?.owner && config.github?.repo) {
    sources.github = `${config.github.webBase ?? 'https://github.com'}/${config.github.owner}/${config.github.repo}/releases/download/${config.tag}/${LATEST_MANIFEST_NAME}`
  }
  if (config?.enabled !== false && config.gitee?.owner && config.gitee?.repo) {
    sources.gitee = `${config.gitee.webBase ?? 'https://gitee.com'}/${config.gitee.owner}/${config.gitee.repo}/releases/download/${config.tag}/${LATEST_MANIFEST_NAME}`
  }
  return sources
}

/**
 * The latest.json locations in the order a client tries them (GitHub first).
 * @param {object} config loaded config.
 * @returns {string[]} URLs.
 */
export function latestManifestUrls(config) {
  const sources = latestManifestSources(config)
  return [sources.github, sources.gitee].filter(url => typeof url === 'string')
}

/**
 * Assets a client may open for one build in one repository.
 * @param {object} config loaded config.
 * @param {'github'|'gitee'} repo repository.
 * @param {string} name asset name.
 * @returns {string} URL.
 */
export function releaseAssetUrl(config, repo, name) {
  const target = config[repo]
  const base = target.webBase ?? (repo === 'github' ? 'https://github.com' : 'https://gitee.com')
  return `${base}/${target.owner}/${target.repo}/releases/download/${config.tag}/${encodeURIComponent(name)}`
}

/**
 * Streaming SHA-256 of one file.
 * @param {string} file path.
 * @returns {Promise<string>} hex digest.
 */
export async function sha256File(file) {
  const hash = createHash('sha256')
  await finished(createReadStream(file).on('data', chunk => hash.update(chunk)))
  return hash.digest('hex')
}

/**
 * Copy one byte range of a file into another file.
 * @param {string} source source path.
 * @param {string} destination destination path.
 * @param {number} start first byte.
 * @param {number} end last byte (inclusive).
 * @returns {Promise<void>} done.
 */
async function copyRange(source, destination, start, end) {
  const input = createReadStream(source, { start, end })
  const output = createWriteStream(destination)
  input.once('error', error => output.destroy(error))
  input.pipe(output)
  await finished(output)
}

/**
 * Split one archive into transport parts.
 *
 * The split is not resumable and not compressed further: each part is a byte
 * range of the original archive, so the client can concatenate them in name
 * order and verify the original digest.
 * @param {string} file archive path.
 * @param {{partBytes?: number, dir?: string, log?: (line: string) => void}} [options] split options.
 * @returns {Promise<{file: string, dir: string, partBytes: number, parts: Array<{name: string, path: string, bytes: number, sha256: string}>}>} split result.
 */
export async function splitArchive(file, options = {}) {
  const log = options.log ?? (() => {})
  const partBytes = Number.isSafeInteger(options.partBytes) ? Math.min(Math.max(options.partBytes, 1024 * 1024), MAX_PART_BYTES) : DEFAULT_PART_BYTES
  const info = await stat(file)
  if (!info.isFile()) throw new Error(`not a file: ${file}`)
  const dir = options.dir ?? await mkdtemp(path.join(tmpdir(), 'dsh-mesh-release-'))
  await mkdir(dir, { recursive: true })
  const name = path.basename(file)
  const count = Math.max(1, Math.ceil(info.size / partBytes))
  const parts = []
  for (let index = 0; index < count; index += 1) {
    const start = index * partBytes
    const end = Math.min(info.size, start + partBytes) - 1
    const partName = `${name}.part${String(index + 1).padStart(3, '0')}`
    const partPath = path.join(dir, partName)
    await rm(partPath, { force: true })
    await copyRange(file, partPath, start, end)
    const partInfo = await stat(partPath)
    parts.push({ name: partName, path: partPath, bytes: partInfo.size })
    log(`split ${name}: ${partName} (${formatBytes(partInfo.size)})`)
  }
  return { file, dir, partBytes, parts }
}

/**
 * Remove a split directory.
 * @param {string} dir directory returned by {@link splitArchive}.
 * @returns {Promise<void>} done.
 */
export async function removeSplit(dir) {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

/**
 * Human byte size for logs.
 * @param {number} value bytes.
 * @returns {string} formatted.
 */
function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${amount >= 100 || unit === 0 ? String(Math.round(amount)) : amount.toFixed(1)} ${units[unit]}`
}

/**
 * Retry a small API call on 429/5xx and transient transport errors.
 * @template T
 * @param {() => Promise<T>} run one attempt.
 * @param {{retries?: number, log?: (line:string)=>void, label?: string}} [options] retry options.
 * @returns {Promise<T>} result.
 */
async function withRetry(run, options = {}) {
  const retries = Number.isSafeInteger(options.retries) ? Math.max(0, options.retries) : 2
  const log = options.log ?? (() => {})
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      const delay = 1000 * 2 ** (attempt - 1)
      log(`${options.label ?? 'request'} retry ${String(attempt)}/${String(retries)} in ${String(delay)}ms (${lastError === null ? '' : lastError.message})`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
    try {
      return await run()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (lastError.retryable !== true) throw lastError
    }
  }
  throw lastError ?? new Error('request failed')
}

/**
 * Mark an error as retryable.
 * @param {Error} error error.
 * @returns {Error} same error.
 */
function retryable(error) {
  error.retryable = true
  return error
}

/**
 * GitHub release API client.
 */
export class GitHubRelease {
  /**
   * @param {{owner: string, repo: string, token: string}} options repository.
   * @param {{proxy?: string|null, log?: (line:string)=>void}} [options] options.
   */
  constructor(options, shared = {}) {
    this.owner = options.owner
    this.repo = options.repo
    this.token = options.token
    this.proxy = shared.proxy ?? null
    this.log = shared.log ?? (() => {})
    this.apiBase = shared.apiBase ?? 'https://api.github.com'
    this.uploadBase = shared.uploadBase ?? 'https://uploads.github.com'
    this.webBase = shared.webBase ?? 'https://github.com'
  }

  /** @returns {string} API root. */
  get apiRoot() {
    return `${this.apiBase}/repos/${this.owner}/${this.repo}`
  }

  /** @returns {string} human-readable release page. */
  get htmlUrl() {
    return `${this.webBase}/${this.owner}/${this.repo}/releases/tag/${this.tag ?? DEFAULT_RELEASE_TAG}`
  }

  /**
   * One API request.
   * @param {string} endpoint path below the repo root, or an absolute URL.
   * @param {{method?: string, json?: unknown, headers?: Record<string,string>}} [options] request.
   * @returns {Promise<{status:number, json:any, text:string, headers:object}>} response.
   */
  async #api(endpoint, options = {}) {
    const url = endpoint.startsWith('https://') ? endpoint : `${this.apiRoot}${endpoint}`
    const response = await withRetry(async () => {
      const result = await requestJson(url, {
        method: options.method ?? (options.json === undefined ? 'GET' : 'POST'),
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...options.headers,
        },
        json: options.json,
        proxy: this.proxy,
        timeoutMs: 60_000,
        idleTimeoutMs: 120_000,
      })
      if (result.status === 429 || result.status >= 500) {
        throw retryable(new Error(`GitHub API ${options.method ?? 'GET'} ${url} returned HTTP ${String(result.status)}: ${result.text.slice(0, 300)}`))
      }
      return result
    }, { log: this.log, label: `github ${options.method ?? 'GET'} ${url.replace(/^https:\/\/api\.github\.com/u, '')}` })
    return response
  }

  /**
   * Find the rolling release or create it.
   * @param {string} tag release tag.
   * @param {{name?: string, body?: string}} [options] release metadata.
   * @returns {Promise<{id: number, tag_name: string, upload_url: string, assets: Array<object>}>} release.
   */
  async ensureRelease(tag, options = {}) {
    this.tag = tag
    const found = await this.#api(`/releases/tags/${encodeURIComponent(tag)}`)
    if (found.status === 200 && found.json !== null) return await this.#releaseWithAssets(found.json)
    if (found.status !== 404) {
      throw new Error(`GitHub release lookup failed: HTTP ${String(found.status)} ${found.text.slice(0, 300)}`)
    }
    const created = await this.#api('/releases', {
      json: {
        tag_name: tag,
        name: options.name ?? `latest packages (${tag})`,
        body: options.body ?? 'The newest dsh-mesh deployment packages. Older assets are replaced on every build.',
        draft: false,
        prerelease: false,
      },
    })
    if (!isSuccess(created.status) || created.json === null) {
      throw new Error(`GitHub release creation failed: HTTP ${String(created.status)} ${created.text.slice(0, 300)}`)
    }
    return await this.#releaseWithAssets(created.json)
  }

  /**
   * Normalize a release object and include its assets.
   * @param {object} release API release.
   * @returns {Promise<object>} release with assets.
   */
  async #releaseWithAssets(release) {
    const assets = Array.isArray(release.assets) ? release.assets : []
    return {
      id: release.id,
      tag_name: release.tag_name,
      html_url: release.html_url,
      assets: assets.map(asset => ({ id: asset.id, name: asset.name, size: asset.size, url: asset.browser_download_url })),
    }
  }

  /**
   * Re-read the release's asset list.
   * @param {number} id release id.
   * @returns {Promise<Array<{id:number,name:string,size:number,url:string}>>} assets.
   */
  async listAssets(id) {
    const assets = []
    for (let page = 1; page <= 10; page += 1) {
      const response = await this.#api(`/releases/${String(id)}/assets?per_page=100&page=${String(page)}`)
      if (!isSuccess(response.status) || !Array.isArray(response.json)) {
        throw new Error(`GitHub asset list failed: HTTP ${String(response.status)} ${response.text.slice(0, 300)}`)
      }
      for (const asset of response.json) {
        assets.push({ id: asset.id, name: asset.name, size: asset.size, url: asset.browser_download_url })
      }
      if (response.json.length < 100) break
    }
    this.assetCache = assets
    return assets
  }

  /**
   * Upload one asset, replacing an asset with the same name.
   * @param {number} releaseId release id.
   * @param {string} file local file.
   * @param {(progress: object) => void} [onProgress] progress.
   * @returns {Promise<object>} uploaded asset.
   */
  async uploadAsset(releaseId, file, onProgress) {
    const name = path.basename(file)
    // `listAssets` caches the first answer: a publish uploads several assets
    // and a fresh list per upload is both slow and, on Gitee, rate-limited.
    const known = this.assetCache ?? await this.listAssets(releaseId)
    const existing = known.find(asset => asset.name === name)
    if (existing !== undefined) await this.deleteAsset(existing.id)
    const url = `${this.uploadBase}/repos/${this.owner}/${this.repo}/releases/${String(releaseId)}/assets?name=${encodeURIComponent(name)}`
    const result = await uploadFile(url, {
      file,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/octet-stream',
      },
      proxy: this.proxy,
      onProgress,
      retries: 2,
      log: this.log,
    })
    if (result.status !== 201 && !isSuccess(result.status)) {
      throw new Error(`GitHub asset upload failed for ${name}: HTTP ${String(result.status)} ${result.text.slice(0, 300)}`)
    }
    this.assetCache = [...(this.assetCache ?? []).filter(asset => asset.name !== name), { name, size: (await stat(file)).size }]
    return result.json ?? {}
  }

  /**
   * Delete one asset.
   * @param {number} assetId asset id.
   * @returns {Promise<void>} done.
   */
  async deleteAsset(assetId) {
    const response = await this.#api(`/releases/assets/${String(assetId)}`, { method: 'DELETE' })
    if (!isSuccess(response.status) && response.status !== 404) {
      throw retryable(new Error(`GitHub asset delete failed: HTTP ${String(response.status)} ${response.text.slice(0, 200)}`))
    }
    this.assetCache = this.assetCache?.filter(asset => asset.id !== assetId)
  }
}

/**
 * Gitee release API client.
 *
 * Gitee's v5 API authenticates with `access_token` (query or form field), not
 * a bearer header. The token is never logged: every message names the endpoint
 * only.
 */
export class GiteeRelease {
  /**
   * @param {{owner: string, repo: string, token: string, branch?: string}} options repository.
   * @param {{proxy?: string|null, log?: (line:string)=>void}} [options] options.
   */
  constructor(options, shared = {}) {
    this.owner = options.owner
    this.repo = options.repo
    this.token = options.token
    this.branch = options.branch ?? 'main'
    // Gitee is reached directly. The egress proxy exists to get around the
    // GitHub path that is slow or unreachable from mainland China; routing a
    // domestic download through an overseas member would only make it slower.
    this.proxy = null
    this.log = shared.log ?? (() => {})
    this.apiBase = shared.apiBase ?? 'https://gitee.com/api/v5'
    this.webBase = shared.webBase ?? 'https://gitee.com'
  }

  /** @returns {string} API root. */
  get apiRoot() {
    return `${this.apiBase}/repos/${this.owner}/${this.repo}`
  }

  /** @returns {string} human-readable release page. */
  get htmlUrl() {
    return `${this.webBase}/${this.owner}/${this.repo}/releases/tag/${this.tag ?? DEFAULT_RELEASE_TAG}`
  }

  /**
   * One API request. The token travels in the query for GET/DELETE and in the
   * JSON body for writes.
   * @param {string} endpoint path below the repo root.
   * @param {{method?: string, json?: unknown, query?: Record<string,string>}} [options] request.
   * @returns {Promise<{status:number, json:any, text:string}>} response.
   */
  async #api(endpoint, options = {}) {
    const url = new URL(`${this.apiRoot}${endpoint}`)
    url.searchParams.set('access_token', this.token)
    for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value)
    const method = options.method ?? (options.json === undefined ? 'GET' : 'POST')
    const response = await withRetry(async () => {
      const result = await requestJson(url.href, {
        method,
        json: options.json === undefined ? undefined : { ...options.json, access_token: this.token },
        proxy: this.proxy,
        timeoutMs: 60_000,
        idleTimeoutMs: 180_000,
      })
      if (result.status === 429 || result.status >= 500) {
        throw retryable(new Error(`Gitee API ${method} ${endpoint} returned HTTP ${String(result.status)}: ${result.text.slice(0, 300)}`))
      }
      return result
    }, { log: this.log, label: `gitee ${method} ${endpoint}` })
    return response
  }

  /**
   * Find the rolling release or create it.
   * @param {string} tag release tag.
   * @param {{name?: string, body?: string}} [options] release metadata.
   * @returns {Promise<{id:number, tag_name:string}>} release.
   */
  async ensureRelease(tag, options = {}) {
    this.tag = tag
    const found = await this.#api(`/releases/tags/${encodeURIComponent(tag)}`)
    if (found.status === 200 && found.json !== null) {
      return { id: found.json.id, tag_name: found.json.tag_name, html_url: found.json.html_url }
    }
    if (found.status !== 404) {
      throw new Error(`Gitee release lookup failed: HTTP ${String(found.status)} ${found.text.slice(0, 300)}`)
    }
    const created = await this.#api('/releases', {
      json: {
        tag_name: tag,
        name: options.name ?? `latest packages (${tag})`,
        body: options.body ?? 'The newest dsh-mesh deployment packages. Older assets are replaced on every build.',
        target_commitish: this.branch,
        prerelease: false,
      },
    })
    if (!isSuccess(created.status) || created.json === null) {
      const detail = created.json?.message ?? created.text.slice(0, 300)
      const hint = /not found|404/iu.test(detail) ? '（Gitee 仓库不存在或 token 无权限：请先在 Gitee 创建公开仓库并给 token projects 权限）' : ''
      throw new Error(`Gitee release creation failed: HTTP ${String(created.status)} ${detail}${hint}`)
    }
    return { id: created.json.id, tag_name: created.json.tag_name, html_url: created.json.html_url }
  }

  /**
   * List the release's attachments.
   * @param {number} releaseId release id.
   * @returns {Promise<Array<{id:number,name:string,size:number,url:string}>>} attachments.
   */
  async listAssets(releaseId) {
    const assets = []
    for (let page = 1; page <= 10; page += 1) {
      const response = await this.#api(`/releases/${String(releaseId)}/attach_files`, {
        query: { page: String(page), per_page: '100' },
      })
      let list = Array.isArray(response.json)
        ? response.json
        : Array.isArray(response.json?.attach_files) ? response.json.attach_files : null
      // Older Gitee deployments only expose the attachments on the release
      // object itself; the dedicated endpoint 404s there.
      if (response.status === 404 && page === 1) {
        const release = await this.#api(`/releases/${String(releaseId)}`)
        list = Array.isArray(release.json?.attach_files) ? release.json.attach_files : null
      }
      if (!isSuccess(response.status) && response.status !== 404) {
        throw new Error(`Gitee attachment list failed: HTTP ${String(response.status)} ${response.text.slice(0, 300)}`)
      }
      if (list === null) throw new Error(`Gitee attachment list failed: HTTP ${String(response.status)} ${response.text.slice(0, 300)}`)
      for (const file of list) {
        assets.push({
          id: file.id,
          name: file.name ?? file.file_name ?? '',
          size: file.size ?? 0,
          url: publicAssetUrl(file.browser_download_url ?? `${this.webBase}/${this.owner}/${this.repo}/releases/download/${this.tag ?? DEFAULT_RELEASE_TAG}/${encodeURIComponent(file.name ?? '')}`),
        })
      }
      if (list.length < 100) break
    }
    this.assetCache = assets
    return assets
  }

  /**
   * Upload one attachment.
   * @param {number} releaseId release id.
   * @param {string} file local file.
   * @param {(progress: object) => void} [onProgress] progress.
   * @returns {Promise<{id:number,name:string,url:string}>} uploaded attachment.
   */
  async uploadAsset(releaseId, file, onProgress) {
    const name = path.basename(file)
    const known = this.assetCache ?? await this.listAssets(releaseId)
    const existing = known.find(asset => asset.name === name)
    if (existing !== undefined) await this.deleteAsset(releaseId, existing.id)
    const url = new URL(`${this.apiRoot}/releases/${String(releaseId)}/attach_files`)
    url.searchParams.set('access_token', this.token)
    const form = await multipartFileBody({ name, file })
    let lastError = null
    for (let attempt = 0; attempt <= 2; attempt += 1) {
      if (attempt > 0) {
        const delay = 1000 * 2 ** (attempt - 1)
        this.log(`gitee upload retry ${String(attempt)}/2 in ${String(delay)}ms (${lastError === null ? '' : lastError.message})`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
      const body = attempt === 0 ? form : await multipartFileBody({ name, file })
      try {
        const response = await openResponse(url.href, {
          method: 'POST',
          headers: { 'content-type': body.contentType, 'content-length': String(body.length) },
          body: body.body,
          length: body.length,
          proxy: this.proxy,
          timeoutMs: 60_000,
          idleTimeoutMs: 300_000,
          followRedirects: false,
        })
        const text = await readText(response.stream, 512 * 1024)
        let json = null
        try {
          json = text === '' ? null : JSON.parse(text)
        } catch {
          json = null
        }
        if (isSuccess(response.statusCode) && json !== null) {
          onProgress?.({ bytes: body.length, totalBytes: body.length, percent: 100, speed: 0 })
          const asset = {
            id: json.id,
            name: json.name ?? name,
            url: publicAssetUrl(json.browser_download_url ?? `${this.webBase}/${this.owner}/${this.repo}/releases/download/${this.tag ?? DEFAULT_RELEASE_TAG}/${encodeURIComponent(name)}`),
          }
          this.assetCache = [...(this.assetCache ?? []).filter(candidate => candidate.name !== asset.name), asset]
          return asset
        }
        const detail = json?.message ?? text.slice(0, 300)
        lastError = new Error(`Gitee attachment upload failed for ${name}: HTTP ${String(response.statusCode)} ${detail}`)
        if (response.statusCode === 429 || response.statusCode >= 500) continue
        throw lastError
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt >= 2) throw lastError
      }
    }
    throw lastError ?? new Error(`Gitee attachment upload failed for ${name}`)
  }

  /**
   * Delete one attachment.
   * @param {number} releaseId release id.
   * @param {number} assetId attachment id.
   * @returns {Promise<void>} done.
   */
  async deleteAsset(releaseId, assetId) {
    const response = await this.#api(`/releases/${String(releaseId)}/attach_files/${String(assetId)}`, { method: 'DELETE' })
    if (!isSuccess(response.status) && response.status !== 404) {
      throw retryable(new Error(`Gitee attachment delete failed: HTTP ${String(response.status)} ${response.text.slice(0, 200)}`))
    }
    this.assetCache = this.assetCache?.filter(asset => asset.id !== assetId)
  }
}

/**
 * Build the latest.json document from the artifacts being published.
 *
 * Gitee part URLs come from the upload responses when the provider exposes
 * them; otherwise the standard release-download shape is used, which is what
 * Gitee serves for a public attachment.
 * @param {{artifacts: Array<object>, config: object, partResults: Record<string, Array<object>>, publishedAt?: string}} options manifest input.
 * @returns {object} manifest.
 */
export function buildLatestManifest(options) {
  const { artifacts, config, partResults } = options
  const first = artifacts[0]?.manifest ?? null
  const assets = {}
  for (const artifact of artifacts) {
    const target = String(artifact.target ?? '')
    if (target === '') continue
    const name = path.basename(String(artifact.archive ?? ''))
    const parts = Array.isArray(partResults[target]) ? partResults[target] : []
    const entry = {
      archive: name,
      bytes: Number(artifact.bytes ?? 0),
      sha256: artifact.sha256 ?? null,
      github: config.github?.enabled === true
        ? { url: releaseAssetUrl(config, 'github', name), bytes: Number(artifact.bytes ?? 0) }
        : null,
      gitee: config.gitee?.enabled === true
        ? {
            partBytes: config.partBytes,
            parts: parts.map(part => ({ name: part.name, bytes: part.bytes, sha256: part.sha256 ?? null })),
            urls: parts.map(part => part.url ?? releaseAssetUrl(config, 'gitee', part.name)),
          }
        : null,
    }
    assets[target] = entry
  }
  return {
    format: 1,
    tag: config.tag,
    version: first?.version ?? null,
    buildStamp: first?.buildStamp ?? null,
    source: first?.source ?? null,
    ref: first?.ref ?? null,
    builtAt: first?.builtAt ?? null,
    publishedAt: options.publishedAt ?? new Date().toISOString(),
    assets,
  }
}

/**
 * Upload the newest archives and manifest, replacing everything else.
 *
 * The two providers are independent: one failing does not stop the other, and
 * the returned status reports exactly what happened. The build itself stays a
 * success, because a local archive that failed to reach a release can still be
 * deployed from the gateway; the panel surfaces `publish.status` separately.
 * @param {{artifacts: Array<object>, config: object, proxy?: string|null, log?: (line:string)=>void, now?: Date}} options publish input.
 * @returns {Promise<object>} publish result.
 */
export async function publishRelease(options) {
  const log = options.log ?? (() => {})
  const config = options.config
  const startedAt = new Date().toISOString()
  const proxy = typeof options.proxy === 'string' && options.proxy.trim() !== '' ? options.proxy.trim() : null
  const artifacts = (Array.isArray(options.artifacts) ? options.artifacts : [])
    .filter(artifact => typeof artifact?.archive === 'string' && artifact.archive !== '')
  if (config?.enabled !== true) {
    return { status: 'skipped', reason: 'release publishing is not configured', startedAt, finishedAt: new Date().toISOString() }
  }
  if (artifacts.length === 0) {
    return { status: 'skipped', reason: 'build produced no archive', startedAt, finishedAt: new Date().toISOString() }
  }
  const now = options.now ?? new Date()
  const prepared = []
  const splits = []
  const result = {
    status: 'running',
    startedAt,
    tag: config.tag,
    version: artifacts[0]?.manifest?.version ?? null,
    buildStamp: artifacts[0]?.manifest?.buildStamp ?? null,
    github: { enabled: config.github.enabled, status: config.github.enabled ? 'pending' : 'disabled', assets: [], removed: [] },
    gitee: { enabled: config.gitee.enabled, status: config.gitee.enabled ? 'pending' : 'disabled', assets: [], removed: [] },
    manifest: null,
  }
  try {
    for (const artifact of artifacts) {
      const file = path.resolve(artifact.archive)
      const info = await stat(file)
      const digest = artifact.sha256 ?? await sha256File(file)
      prepared.push({ ...artifact, archive: file, bytes: info.size, sha256: digest })
      log(`release asset ${path.basename(file)} (${formatBytes(info.size)}, sha256 ${digest.slice(0, 12)}…)`)
    }

    // Gitee cannot hold one archive over ~100 MB; split before any upload so a
    // packaging problem fails before the release is touched.
    const partResults = {}
    if (config.gitee.enabled) {
      let total = 0
      for (const artifact of prepared) {
        const split = await splitArchive(artifact.archive, { partBytes: config.partBytes, log })
        splits.push(split.dir)
        const parts = []
        for (const part of split.parts) {
          total += part.bytes
          parts.push({ ...part, sha256: await sha256File(part.path) })
        }
        partResults[artifact.target] = parts
        log(`gitee ${artifact.target}: ${String(parts.length)} part(s), ${formatBytes(parts.reduce((sum, part) => sum + part.bytes, 0))}`)
      }
      if (total > GITEE_REPO_QUOTA_BYTES) {
        result.gitee.warning = `本次分片共 ${formatBytes(total)}，超过 Gitee 仓库附件预算 ${formatBytes(GITEE_REPO_QUOTA_BYTES)}；上传可能因配额失败`
        log(`warning: ${result.gitee.warning}`)
      }
    }

    const manifest = buildLatestManifest({ artifacts: prepared, config, partResults, publishedAt: now.toISOString() })
    const manifestFile = path.join(splits[0] ?? await mkdtemp(path.join(tmpdir(), 'dsh-mesh-release-')), LATEST_MANIFEST_NAME)
    if (splits.length === 0) splits.push(path.dirname(manifestFile))
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    result.manifest = { ...manifest, assets: manifest.assets }

    if (config.github.enabled) {
      try {
        const github = new GitHubRelease(config.github, { proxy, log, apiBase: config.github.apiBase, uploadBase: config.github.uploadBase, webBase: config.github.webBase })
        const release = await github.ensureRelease(config.tag, { name: `dsh-mesh ${manifest.version ?? ''} ${manifest.buildStamp ?? ''}`.trim() })
        result.github.releaseUrl = release.html_url ?? github.htmlUrl
        for (const artifact of prepared) {
          const name = path.basename(artifact.archive)
          log(`github upload ${name}`)
          let nextReport = 10
          await github.uploadAsset(release.id, artifact.archive, progress => {
            const percent = Number(progress.percent ?? 0)
            if (percent < nextReport) return
            nextReport = Math.min(100, percent + 10)
            log(`github upload ${name} ${String(percent)}%`)
          })
          result.github.assets.push({ name, bytes: artifact.bytes })
        }
        log(`github upload ${LATEST_MANIFEST_NAME}`)
        await github.uploadAsset(release.id, manifestFile)
        result.github.assets.push({ name: LATEST_MANIFEST_NAME, bytes: (await stat(manifestFile)).size })
        const keep = new Set(result.github.assets.map(asset => asset.name))
        for (const asset of await github.listAssets(release.id)) {
          if (keep.has(asset.name)) continue
          log(`github remove old asset ${asset.name}`)
          await github.deleteAsset(asset.id)
          result.github.removed.push(asset.name)
        }
        result.github.status = 'done'
      } catch (error) {
        result.github.status = 'failed'
        result.github.error = error instanceof Error ? error.message : String(error)
        log(`github publish failed: ${result.github.error}`)
      }
    }

    if (config.gitee.enabled) {
      try {
        const gitee = new GiteeRelease(config.gitee, { proxy, log, apiBase: config.gitee.apiBase, webBase: config.gitee.webBase })
        const release = await gitee.ensureRelease(config.tag, { name: `dsh-mesh ${manifest.version ?? ''} ${manifest.buildStamp ?? ''}`.trim() })
        result.gitee.releaseUrl = release.html_url ?? gitee.htmlUrl
        const newNames = new Set([LATEST_MANIFEST_NAME, ...Object.values(partResults).flat().map(part => part.name)])
        // The 1 GB repository quota cannot hold both revisions: clear the old
        // parts first, keep the old manifest until the new one is ready.
        for (const asset of await gitee.listAssets(release.id)) {
          if (newNames.has(asset.name) || asset.name === LATEST_MANIFEST_NAME) continue
          log(`gitee remove old asset ${asset.name}`)
          await gitee.deleteAsset(release.id, asset.id)
          result.gitee.removed.push(asset.name)
        }
        const uploaded = {}
        for (const artifact of prepared) {
          uploaded[artifact.target] = []
          for (const part of partResults[artifact.target] ?? []) {
            log(`gitee upload ${part.name}`)
            let nextReport = 10
            const response = await gitee.uploadAsset(release.id, part.path, progress => {
              const percent = Number(progress.percent ?? 0)
              if (percent < nextReport) return
              nextReport = Math.min(100, percent + 10)
              log(`gitee upload ${part.name} ${String(percent)}%`)
            })
            const url = response.url ?? releaseAssetUrl(config, 'gitee', part.name)
            uploaded[artifact.target].push({ ...part, url })
            result.gitee.assets.push({ name: part.name, bytes: part.bytes, url })
          }
        }
        // Part responses can carry the authoritative URL; rebuild the manifest
        // before it is uploaded so clients never have to guess.
        const finalManifest = buildLatestManifest({ artifacts: prepared, config, partResults: uploaded, publishedAt: now.toISOString() })
        result.manifest = finalManifest
        await writeFile(manifestFile, `${JSON.stringify(finalManifest, null, 2)}\n`, 'utf8')
        log(`gitee upload ${LATEST_MANIFEST_NAME}`)
        await gitee.uploadAsset(release.id, manifestFile)
        result.gitee.assets.push({ name: LATEST_MANIFEST_NAME, bytes: (await stat(manifestFile)).size })
        for (const asset of await gitee.listAssets(release.id)) {
          if (newNames.has(asset.name)) continue
          log(`gitee remove old asset ${asset.name}`)
          await gitee.deleteAsset(release.id, asset.id)
          result.gitee.removed.push(asset.name)
        }
        result.gitee.status = 'done'
        // GitHub's latest.json was uploaded before the authoritative Gitee
        // part URLs were known; replace it when they differ. A failure here
        // must not turn a successful Gitee publish into a failed one.
        if (config.github.enabled && result.github.status === 'done') {
          try {
            const github = new GitHubRelease(config.github, { proxy, log, apiBase: config.github.apiBase, uploadBase: config.github.uploadBase, webBase: config.github.webBase })
            const releaseInfo = await github.ensureRelease(config.tag)
            log(`github refresh ${LATEST_MANIFEST_NAME} with the final Gitee URLs`)
            await github.uploadAsset(releaseInfo.id, manifestFile)
          } catch (error) {
            result.github.warning = `GitHub 的 ${LATEST_MANIFEST_NAME} 未能刷新为 Gitee 分片地址：${error instanceof Error ? error.message : String(error)}`
            log(`warning: ${result.github.warning}`)
          }
        }
      } catch (error) {
        result.gitee.status = 'failed'
        result.gitee.error = error instanceof Error ? error.message : String(error)
        log(`gitee publish failed: ${result.gitee.error}`)
      }
    }

    const states = [result.github.status, result.gitee.status].filter(state => state !== 'disabled')
    result.status = states.length === 0
      ? 'skipped'
      : states.every(state => state === 'done')
        ? 'done'
        : states.some(state => state === 'done')
          ? 'partial'
          : 'failed'
    result.finishedAt = new Date().toISOString()
    log(`release publish ${result.status} (tag ${config.tag})`)
    return result
  } catch (error) {
    result.status = 'failed'
    result.error = error instanceof Error ? error.message : String(error)
    result.finishedAt = new Date().toISOString()
    log(`release publish failed: ${result.error}`)
    return result
  } finally {
    for (const dir of splits) await removeSplit(dir)
  }
}

/**
 * Download `latest.json` from the first reachable URL.
 * @param {{urls: string[], proxy?: string|null, timeoutMs?: number, log?: (line:string)=>void}} options options.
 * @returns {Promise<{manifest: object, url: string}>} manifest and the URL that answered.
 */
export async function fetchLatestManifest(options) {
  const log = options.log ?? (() => {})
  const errors = []
  for (const url of options.urls ?? []) {
    try {
      let host = ''
      try { host = new URL(url).hostname } catch { host = '' }
      // Only GitHub needs the egress proxy; a Gitee manifest is domestic.
      const proxy = /(?:^|\.)github\.com$|githubusercontent\.com$/iu.test(host) ? options.proxy ?? null : null
      const response = await requestJson(url, {
        proxy,
        timeoutMs: options.timeoutMs ?? 30_000,
        idleTimeoutMs: options.timeoutMs ?? 30_000,
        headers: { accept: 'application/json' },
      })
      if (!isSuccess(response.status) || response.json === null || typeof response.json !== 'object') {
        errors.push(`${url}: HTTP ${String(response.status)}`)
        continue
      }
      log(`release manifest ${url}`)
      return { manifest: response.json, url }
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`no release manifest is reachable\n${errors.join('\n')}`)
}
