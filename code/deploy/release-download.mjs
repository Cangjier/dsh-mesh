#!/usr/bin/env node
/**
 * Fetch one deployment package from the GitHub/Gitee release, on the member
 * that is about to be upgraded.
 *
 * This script is uploaded next to `http-client.mjs` and run with the member's
 * own Node runtime, so a 300–420 MB package never crosses the gateway. It is
 * deliberately independent of the deployed dsh-mesh tree: the old release is
 * what is being replaced, and its code may not know about releases at all.
 *
 * It reads `latest.json` (GitHub first, Gitee second), downloads the whole
 * archive from GitHub or the split parts from Gitee, concatenates the parts,
 * and verifies the archive's SHA-256 from the manifest. Exit codes tell the
 * deploy engine whether falling back to a server upload makes sense:
 *
 *   0  downloaded and verified
 *   3  the release is reachable but does not contain this exact package
 *   4  download or verification failed
 *   5  the arguments are unusable
 *
 * @module dsh-mesh/deploy/release-download
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { downloadToFile, requestJson } from '../shared/http-client.mjs'

/**
 * Parse `--name value` arguments.
 * @param {string[]} argv arguments.
 * @returns {Map<string, string[]>} values per name.
 */
function parseArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const name = arg.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      values.set(name, [...(values.get(name) ?? []), ''])
      continue
    }
    values.set(name, [...(values.get(name) ?? []), value])
    index += 1
  }
  return values
}

/**
 * First value of one argument.
 * @param {Map<string,string[]>} values parsed args.
 * @param {string} name argument name.
 * @returns {string} value or ''.
 */
function valueOf(values, name) {
  return values.get(name)?.[0] ?? ''
}

/** Print one machine-readable marker. */
function marker(line) {
  process.stdout.write(`${line}\n`)
}

/**
 * Human progress line for the deploy log, throttled by the caller.
 * @param {object} progress http-client progress.
 * @param {string} label what is being downloaded.
 * @returns {void}
 */
function reportProgress(progress, label, offset = 0, overallTotal = 0) {
  const bytes = offset + Number(progress.bytes ?? 0)
  const total = overallTotal > 0 ? overallTotal : Number(progress.totalBytes ?? 0)
  marker(`DSH-MESH-DOWNLOAD ${String(bytes)} ${String(total)}`)
  const percent = total > 0 ? Math.floor((bytes / total) * 100) : 0
  marker(`DSH-MESH-DOWNLOAD-PROGRESS ${label} ${String(percent)}`)
}

/**
 * Streaming SHA-256 of one file.
 * @param {string} file path.
 * @returns {Promise<string>} hex digest.
 */
async function sha256File(file) {
  const hash = createHash('sha256')
  await finished(createReadStream(file).on('data', chunk => hash.update(chunk)))
  return hash.digest('hex')
}

/**
 * Whether a file exists and has a given digest.
 * @param {string} file path.
 * @param {string} expected digest.
 * @returns {Promise<boolean>} match.
 */
async function fileMatches(file, expected) {
  try {
    const info = await stat(file)
    if (!info.isFile()) return false
    return (await sha256File(file)) === expected
  } catch {
    return false
  }
}

/**
 * Download one URL with a few retries, reusing a file that already verifies.
 * @param {string} url remote URL.
 * @param {string} destination local file.
 * @param {{proxy: string, sha256?: string, label: string, retries?: number, offset?: number, overallTotal?: number}} options options.
 * @returns {Promise<{file: string, sha256: string, bytes: number}>} downloaded file.
 */
async function fetchFile(url, destination, options) {
  const retries = Number.isSafeInteger(options.retries) ? Math.max(0, options.retries) : 2
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (options.sha256 !== undefined && options.sha256 !== '' && await fileMatches(destination, options.sha256)) {
      const info = await stat(destination)
      return { file: destination, sha256: options.sha256, bytes: info.size }
    }
    if (attempt > 0) {
      const delay = 1500 * 2 ** (attempt - 1)
      process.stderr.write(`retry ${String(attempt)}/${String(retries)} for ${options.label} in ${String(delay)}ms (${lastError?.message ?? ''})\n`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
    try {
      const result = await downloadToFile(url, destination, {
        proxy: options.proxy === '' ? null : options.proxy,
        sha256: options.sha256,
        timeoutMs: 60_000,
        idleTimeoutMs: 120_000,
        onProgress: progress => reportProgress(progress, options.label, options.offset ?? 0, options.overallTotal ?? 0),
      })
      marker(`DSH-MESH-DOWNLOAD-OK ${options.label} ${String(result.bytes)} ${result.sha256}`)
      return result
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      await rm(destination, { force: true }).catch(() => {})
    }
  }
  throw lastError ?? new Error(`could not download ${options.label}`)
}

/**
 * Concatenate parts into the final archive and verify the archive digest.
 * @param {Array<{file: string, name: string}>} parts part files in order.
 * @param {string} output final path.
 * @param {string} expectedSha archive digest.
 * @returns {Promise<{bytes: number, sha256: string}>} result.
 */
async function concatenate(parts, output, expectedSha) {
  const temporary = `${output}.part`
  await rm(temporary, { force: true })
  const hash = createHash('sha256')
  let bytes = 0
  const sink = createWriteStream(temporary)
  try {
    for (const part of parts) {
      for await (const chunk of createReadStream(part.file)) {
        bytes += chunk.length
        hash.update(chunk)
        if (!sink.write(chunk)) await new Promise(resolve => sink.once('drain', resolve))
      }
      // Free each part as it is consumed: a member's /tmp is often a small
      // tmpfs, and holding all parts plus the assembled archive doubles the
      // requirement. A retry re-downloads what was already removed.
      await rm(part.file, { force: true }).catch(() => {})
    }
    sink.end()
    await finished(sink)
  } catch (error) {
    sink.destroy()
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  const digest = hash.digest('hex')
  if (expectedSha !== '' && digest !== expectedSha) {
    await rm(temporary, { force: true }).catch(() => {})
    throw new Error(`assembled archive checksum mismatch: expected ${expectedSha}, got ${digest}`)
  }
  await rm(output, { force: true })
  await rename(temporary, output)
  return { bytes, sha256: digest }
}

/**
 * Find the asset for one archive name in a manifest.
 * @param {object} manifest parsed latest.json.
 * @param {string} archive archive filename.
 * @returns {object|null} asset entry.
 */
function selectAsset(manifest, archive) {
  const assets = manifest?.assets
  if (assets === null || typeof assets !== 'object') return null
  for (const entry of Object.values(assets)) {
    if (entry !== null && typeof entry === 'object' && entry.archive === archive) return entry
  }
  return null
}

async function main() {
  const values = parseArgs(process.argv.slice(2))
  const manifests = values.get('manifest') ?? []
  const archive = valueOf(values, 'archive')
  const output = valueOf(values, 'output')
  const proxy = valueOf(values, 'proxy')
  const expected = valueOf(values, 'sha256')
  const workdir = valueOf(values, 'workdir')
  if (manifests.length === 0 || archive === '' || output === '') {
    process.stderr.write('usage: release-download.mjs --manifest <url> [--manifest <url>] --archive <name> --output <file> [--sha256 <hex>] [--proxy <url>] [--workdir <dir>]\n')
    process.exitCode = 5
    return
  }

  const errors = []
  let asset = null
  for (const manifestUrl of manifests) {
    try {
      const response = await requestJson(manifestUrl, {
        proxy: proxy === '' ? null : proxy,
        timeoutMs: 30_000,
        idleTimeoutMs: 30_000,
        headers: { accept: 'application/json' },
      })
      if (response.status < 200 || response.status >= 300 || response.json === null) {
        errors.push(`${manifestUrl}: HTTP ${String(response.status)}`)
        continue
      }
      asset = selectAsset(response.json, archive)
      if (asset === null) {
        errors.push(`${manifestUrl}: release has no asset named ${archive}`)
        continue
      }
      marker(`DSH-MESH-DOWNLOAD-MANIFEST ${manifestUrl}`)
      break
    } catch (error) {
      errors.push(`${manifestUrl}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (asset === null) {
    process.stderr.write(`release does not offer ${archive}\n${errors.join('\n')}\n`)
    process.exitCode = 3
    return
  }
  const manifestSha = String(asset.sha256 ?? '')
  if (expected !== '' && manifestSha !== '' && expected !== manifestSha) {
    process.stderr.write(`release has ${archive} with sha256 ${manifestSha}, but this deploy is for ${expected}\n`)
    process.exitCode = 3
    return
  }
  const sha256 = manifestSha !== '' ? manifestSha : expected
  const totalBytes = Number(asset.bytes ?? 0)
  marker(`DSH-MESH-DOWNLOAD-PLAN ${String(totalBytes)}`)
  await mkdir(path.dirname(output), { recursive: true })

  if (sha256 !== '' && await fileMatches(output, sha256)) {
    const info = await stat(output)
    marker(`DSH-MESH-DOWNLOAD-DONE ${String(info.size)} ${sha256}`)
    return
  }

  // GitHub first: one whole file, no assembly. Gitee is the split fallback.
  const githubUrl = typeof asset.github?.url === 'string' ? asset.github.url : ''
  if (githubUrl !== '') {
    try {
      const result = await fetchFile(githubUrl, output, { proxy, sha256, label: 'github', retries: 2, offset: 0, overallTotal: totalBytes })
      marker(`DSH-MESH-DOWNLOAD-DONE ${String(result.bytes)} ${result.sha256}`)
      return
    } catch (error) {
      errors.push(`github: ${error instanceof Error ? error.message : String(error)}`)
      await rm(output, { force: true }).catch(() => {})
    }
  }

  const parts = Array.isArray(asset.gitee?.parts) ? asset.gitee.parts : []
  const urls = Array.isArray(asset.gitee?.urls) ? asset.gitee.urls : []
  if (parts.length === 0 || urls.length === 0) {
    process.stderr.write(`no usable download for ${archive}\n${errors.join('\n')}\n`)
    process.exitCode = 4
    return
  }
  const base = workdir === '' ? await mkdtemp(path.join(tmpdir(), 'dsh-mesh-download-')) : workdir
  await mkdir(base, { recursive: true })
  try {
    const files = []
    let offset = 0
    const overallTotal = totalBytes > 0 ? totalBytes : parts.reduce((sum, part) => sum + Number(part?.bytes ?? 0), 0)
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]
      const name = part?.name ?? `part${String(index + 1).padStart(3, '0')}`
      const url = urls[index] ?? urls[0]
      const file = path.join(base, path.basename(name))
      const downloaded = await fetchFile(url, file, {
        proxy,
        sha256: typeof part?.sha256 === 'string' ? part.sha256 : '',
        label: name,
        retries: 2,
        offset,
        overallTotal,
      })
      files.push({ file, name })
      offset += downloaded.bytes
      marker(`DSH-MESH-DOWNLOAD-PART ${String(index + 1)}/${String(parts.length)}`)
    }
    const assembled = await concatenate(files, output, sha256)
    marker(`DSH-MESH-DOWNLOAD-DONE ${String(assembled.bytes)} ${assembled.sha256}`)
  } finally {
    if (workdir === '') await rm(base, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  process.stderr.write(`release download failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 4
})
