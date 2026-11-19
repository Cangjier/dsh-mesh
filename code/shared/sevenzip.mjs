/**
 * The 7-Zip binary that ships with dsh-mesh.
 *
 * Packages are `.7z` archives. LZMA2 compresses the ~1.2 GiB app tree to a
 * fraction of what the old gzip/zip archives produced, and the multithreaded
 * encoder is faster than the single-threaded deflate the old path used.
 *
 * 7-Zip is not a dependency of Node, so the binary travels with this
 * repository and is served by the gate as a static asset:
 *
 *   GET /__gate/assets/7z                      index entry
 *   GET /__gate/assets/7z/<file>               the binary
 *
 * Three builds are committed: Linux x64/arm64 (the static `7zzs` build, so a
 * member needs no matching glibc/libstdc++) and Windows x64 (`7za.exe`). The
 * build engine uses the copy for its own host to create archives; the deploy
 * plan uploads the copy for the target and extracts there.
 *
 * @module dsh-mesh/shared/sevenzip
 */

import { existsSync } from 'node:fs'
import { chmod, readFile } from 'node:fs/promises'
import path from 'node:path'

/** The upstream 7-Zip release the committed binaries come from. */
export const SEVEN_ZIP_VERSION = '25.01'

/** Suffix of a 7-Zip package archive. */
export const SEVEN_ZIP_SUFFIX = '.7z'

/** Directory name under `code/gate/assets/`. */
export const SEVEN_ZIP_ASSET_NAME = '7z'

/**
 * Asset file for one target platform.
 * @param {string} os `linux` or `windows` (a `win32`/`win` prefix is accepted).
 * @param {string} [arch] `x64` or `arm64`.
 * @returns {string} file name under `code/gate/assets/7z/`.
 */
export function sevenZipAssetFile(os, arch = 'x64') {
  const text = String(os ?? '').toLowerCase()
  if (text.startsWith('win')) return '7za-windows-x64.exe'
  return arch === 'arm64' ? '7zz-linux-arm64' : '7zz-linux-x64'
}

/**
 * Absolute path of one bundled 7-Zip binary.
 * @param {string} repositoryRoot package or checkout root.
 * @param {string} os target OS.
 * @param {string} [arch] target architecture.
 * @returns {string} absolute file path.
 */
export function sevenZipAssetPath(repositoryRoot, os, arch = 'x64') {
  return path.join(repositoryRoot, 'code', 'gate', 'assets', SEVEN_ZIP_ASSET_NAME, sevenZipAssetFile(os, arch))
}

/**
 * Find the bundled binary from wherever the caller's root happens to point.
 *
 * Three layouts run this code and each keeps the asset somewhere else:
 *
 *   - a checkout / a build host:    <root>/code/gate/assets/7z/<file>
 *   - an installed release:         <root>/gate/assets/7z/<file>
 *   - a plugin inside a release:    <root>/../../gate/assets/7z/<file>
 *
 * The first existing candidate wins; the first candidate is returned when none
 * exists so the error names the path the caller expected.
 * @param {string} repositoryRoot package, release, plugin, or checkout root.
 * @param {string} os target OS.
 * @param {string} [arch] target architecture.
 * @returns {string} absolute path.
 */
export function resolveSevenZipAssetPath(repositoryRoot, os, arch = 'x64') {
  const file = sevenZipAssetFile(os, arch)
  const roots = [
    path.join(repositoryRoot, 'code', 'gate', 'assets', SEVEN_ZIP_ASSET_NAME),
    path.join(repositoryRoot, 'gate', 'assets', SEVEN_ZIP_ASSET_NAME),
    path.join(repositoryRoot, '..', 'gate', 'assets', SEVEN_ZIP_ASSET_NAME),
    path.join(repositoryRoot, '..', '..', 'gate', 'assets', SEVEN_ZIP_ASSET_NAME),
  ]
  for (const root of roots) {
    const candidate = path.join(root, file)
    if (existsSync(candidate)) return candidate
  }
  return path.join(roots[0], file)
}

/**
 * The OS/arch pair of the machine running this code.
 * @returns {{os: 'linux'|'windows', arch: 'x64'|'arm64'}} platform.
 */
export function hostSevenZipPlatform() {
  return {
    os: process.platform === 'win32' ? 'windows' : 'linux',
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
  }
}

/**
 * Absolute path of the bundled binary for the machine running this code.
 * @param {string} repositoryRoot package or checkout root.
 * @returns {string} absolute file path.
 */
export function hostSevenZipPath(repositoryRoot) {
  const { os, arch } = hostSevenZipPlatform()
  return resolveSevenZipAssetPath(repositoryRoot, os, arch)
}

/**
 * Verify that one bundled binary exists and is executable.
 *
 * The copy inside a package can lose its executable bit (an archive created on
 * Windows, or a filesystem without modes), so the permission is restored here
 * instead of relying on how the file was unpacked.
 * @param {string} file absolute path.
 * @returns {Promise<string>} the same path.
 */
export async function ensureSevenZipBinary(file) {
  if (!existsSync(file)) {
    throw new Error(
      `7-Zip binary is missing: ${file}\n` +
      'The package must carry code/gate/assets/7z/ (a package built before the 7z switch has no copy); ' +
      'rebuild or copy the asset, then retry.',
    )
  }
  if (process.platform !== 'win32') {
    try {
      await chmod(file, 0o755)
    } catch {
      // A read-only filesystem is still fine when the mode is already 0755.
    }
  }
  return file
}

/**
 * Parse one 7-Zip asset manifest and return one entry.
 *
 * The gate serves the same manifest; this lets the build engine and the deploy
 * plan pick a file without hard-coding hashes in two places.
 * @param {string} repositoryRoot package or checkout root.
 * @param {string} os target OS.
 * @param {string} [arch] target architecture.
 * @returns {Promise<{file: string, bytes: number, sha256: string, path: string}|null>} entry.
 */
export async function readSevenZipAsset(repositoryRoot, os, arch = 'x64') {
  const directory = path.join(repositoryRoot, 'code', 'gate', 'assets', SEVEN_ZIP_ASSET_NAME)
  const file = sevenZipAssetFile(os, arch)
  try {
    const raw = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))
    const entry = Array.isArray(raw.assets) ? raw.assets.find(item => item?.file === file) : undefined
    if (entry === undefined) return null
    return {
      file,
      bytes: Number(entry.bytes),
      sha256: String(entry.sha256 ?? '').toLowerCase(),
      path: path.join(directory, file),
    }
  } catch {
    return null
  }
}

/**
 * Whether a package name is a 7-Zip archive.
 * @param {string} file archive path or name.
 * @returns {boolean} true for `.7z`.
 */
export function isSevenZipArchive(file) {
  return String(file ?? '').toLowerCase().endsWith(SEVEN_ZIP_SUFFIX)
}
