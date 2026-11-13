/**
 * Collect `gate/assets/<name>/manifest.json` into the package manifest.
 *
 * The package manifest is metadata for humans and for the deploy UI; the gate
 * and the control service read the same per-asset manifests at runtime. Keeping
 * this scan generic means adding an asset never needs a new branch in the build
 * engine again.
 *
 * @module dsh-mesh/build/static-assets
 */

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u
const FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

/**
 * Read the static assets under one `gate/` directory.
 * @param {string} gateDirectory path to the package's `gate/` directory.
 * @returns {Promise<Array<{name: string, version: string, manifest: string, assets: object[]}>>} entries.
 */
export async function collectStaticAssets(gateDirectory) {
  const assetsDirectory = path.join(gateDirectory, 'assets')
  if (!existsSync(assetsDirectory)) return []
  const directories = await readdir(assetsDirectory, { withFileTypes: true }).catch(() => [])
  const result = []
  for (const directory of directories) {
    if (!directory.isDirectory()) continue
    try {
      const manifestPath = path.join(assetsDirectory, directory.name, 'manifest.json')
      const raw = JSON.parse(await readFile(manifestPath, 'utf8'))
      const entries = Array.isArray(raw.assets)
        ? raw.assets
        : typeof raw.file === 'string'
          ? [{ os: 'windows', arch: 'x64', file: raw.file, sha256: raw.sha256, bytes: raw.bytes }]
          : []
      const assets = []
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
        const file = typeof entry.file === 'string' ? entry.file : ''
        const sha256 = typeof entry.sha256 === 'string' ? entry.sha256.toLowerCase() : ''
        const bytes = Number(entry.bytes)
        if (!FILE_PATTERN.test(file) || !SHA256_PATTERN.test(sha256)) continue
        if (!Number.isSafeInteger(bytes) || bytes <= 0) continue
        if (!existsSync(path.join(assetsDirectory, directory.name, file))) continue
        assets.push({
          os: typeof entry.os === 'string' ? entry.os : '',
          arch: typeof entry.arch === 'string' ? entry.arch : '',
          kind: typeof entry.kind === 'string' ? entry.kind : 'file',
          file,
          sha256,
          bytes,
        })
      }
      if (assets.length === 0) continue
      const name = typeof raw.name === 'string' && NAME_PATTERN.test(raw.name) ? raw.name : directory.name
      result.push({
        name,
        version: typeof raw.version === 'string' ? raw.version : 'unknown',
        manifest: `gate/assets/${directory.name}/manifest.json`,
        assets,
      })
    } catch {
      // Optional asset: keep building the rest of the package.
    }
  }
  result.sort((left, right) => left.name.localeCompare(right.name))
  return result
}
