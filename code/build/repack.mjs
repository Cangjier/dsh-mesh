/**
 * Refresh a prebuilt offline package from the repository.
 *
 * A package is mostly the DSH app and the Node runtime, which do not change
 * between plugin releases. Rebuilding them downloads everything again; this
 * module keeps them and replaces only the files the repository owns:
 *
 *   - `gate/`, `shared/`, `config/`
 *   - `code/{windows-service,interop-service,wireguard}`
 *   - the root scripts and `VERSION`
 *   - `plugins/dsh-mesh/`
 *   - `docs/`
 *
 * @module dsh-mesh/build/repack
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Root-level scripts copied out of `code/`. */
const CODE_SCRIPTS = ['install.sh', 'start.sh', 'stop.sh', 'status.sh', 'doctor.sh', 'install.ps1', 'start.ps1', 'stop.ps1', 'start.cmd', 'stop.cmd']
/** Scripts that live at the repository root. */
const ROOT_SCRIPTS = ['start-interop.sh', 'install-interop-service.sh', 'uninstall-interop-service.sh']
/** Plugin files copied from the repository root. */
const PLUGIN_FILES = ['index.js', 'client.js', 'cordis.patch.yml', 'package.json']
/** Plugin directories copied from the repository root. */
const PLUGIN_DIRS = ['locale', 'build', 'code/build', 'code/shared']
/** Directories copied from `code/` into the package's `code/`. */
const CODE_DIRS = ['windows-service', 'interop-service', 'wireguard']

/**
 * Remove a path if it exists.
 * @param {string} target absolute path.
 * @returns {Promise<void>} completion.
 */
async function clear(target) {
  await rm(target, { recursive: true, force: true })
}

/**
 * Replace one directory with a fresh copy.
 * @param {string} from source directory.
 * @param {string} to destination directory.
 * @returns {Promise<void>} completion.
 */
async function replaceDirectory(from, to) {
  if (!existsSync(from)) return
  await clear(to)
  await cp(from, to, { recursive: true })
}

/**
 * Replace one file with a fresh copy.
 * @param {string} from source file.
 * @param {string} to destination file.
 * @returns {Promise<void>} completion.
 */
async function replaceFile(from, to) {
  if (!existsSync(from)) return
  await clear(to)
  await cp(from, to)
}

/**
 * Count every file below a directory.
 * @param {string} dir root.
 * @returns {Promise<number>} file count.
 */
async function countFiles(dir) {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += await countFiles(path.join(dir, entry.name))
    else if (entry.isFile()) total += 1
  }
  return total
}

/**
 * Rewrite one extracted package in place.
 * @param {string} packageDir extracted package root (holds `manifest.json`).
 * @param {string} repositoryRoot repository root.
 * @returns {Promise<{packageDir: string, version: string, target: object, files: number, clientBytes: number}>} summary.
 */
export async function repackDirectory(packageDir, repositoryRoot) {
  const manifestFile = path.join(packageDir, 'manifest.json')
  if (!existsSync(manifestFile)) throw new Error(`${packageDir} is not an extracted package (no manifest.json)`)
  await replaceDirectory(path.join(repositoryRoot, 'code', 'gate'), path.join(packageDir, 'gate'))
  await replaceDirectory(path.join(repositoryRoot, 'code', 'shared'), path.join(packageDir, 'shared'))
  await replaceDirectory(path.join(repositoryRoot, 'code', 'config'), path.join(packageDir, 'config'))
  for (const name of CODE_DIRS) {
    await replaceDirectory(path.join(repositoryRoot, 'code', name), path.join(packageDir, 'code', name))
  }
  await replaceDirectory(path.join(repositoryRoot, 'docs'), path.join(packageDir, 'docs'))
  for (const name of CODE_SCRIPTS) {
    await replaceFile(path.join(repositoryRoot, 'code', name), path.join(packageDir, name))
  }
  for (const name of ROOT_SCRIPTS) {
    await replaceFile(path.join(repositoryRoot, name), path.join(packageDir, name))
  }
  for (const name of PLUGIN_FILES) {
    await replaceFile(path.join(repositoryRoot, name), path.join(packageDir, 'plugins', 'dsh-mesh', name))
  }
  for (const name of PLUGIN_DIRS) {
    await replaceDirectory(path.join(repositoryRoot, name), path.join(packageDir, 'plugins', 'dsh-mesh', name))
  }
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  manifest.builtAt = new Date().toISOString()
  manifest.repackedFrom = 'code/build/repack.mjs'
  manifest.files = await countFiles(packageDir)
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const clientBytes = (await stat(path.join(packageDir, 'plugins', 'dsh-mesh', 'client.js'))).size
  return { packageDir, version: manifest.version, target: manifest.target, files: manifest.files, clientBytes }
}

/**
 * Hash every byte of a file.
 * @param {string} file absolute path.
 * @returns {Promise<string>} hex sha256.
 */
async function sha256File(file) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  return hash.digest('hex')
}

/**
 * The top-level directory an archive extracts to.
 * @param {string} file archive path.
 * @returns {string} directory name.
 */
function archiveRootName(file) {
  return path.basename(file).replace(/\.(tar\.gz|tgz|zip)$/u, '')
}

/**
 * Extract one archive into a directory.
 * @param {string} file archive path.
 * @param {string} directory destination (parent of the top-level dir).
 * @returns {Promise<string>} extracted package directory.
 */
async function extractArchive(file, directory) {
  await mkdir(directory, { recursive: true })
  if (file.endsWith('.zip')) {
    try {
      await run('unzip', ['-q', file, '-d', directory])
    } catch {
      // Windows ships bsdtar, which also reads zip archives.
      await run('tar', ['-xf', file, '-C', directory])
    }
  } else {
    await run('tar', ['-xzf', file, '-C', directory])
  }
  const root = path.join(directory, archiveRootName(file))
  if (!existsSync(path.join(root, 'manifest.json'))) {
    throw new Error(`archive ${path.basename(file)} has no ${archiveRootName(file)}/manifest.json`)
  }
  return root
}

/**
 * Compress a directory back into an archive.
 * @param {string} parent directory holding the top-level dir.
 * @param {string} name top-level dir name.
 * @param {string} file destination archive.
 * @returns {Promise<void>} completion.
 */
async function compressDirectory(parent, name, file) {
  await clear(file)
  if (file.endsWith('.zip')) {
    try {
      await run('zip', ['-qr', '-X', file, name], { cwd: parent })
    } catch {
      await run('tar', ['-a', '-cf', file, name], { cwd: parent })
    }
  } else {
    await run('tar', ['-czf', file, name], { cwd: parent })
  }
}

/**
 * Refresh one archive in place: extract, replace the owned files, repack.
 * @param {string} file archive path.
 * @param {{repositoryRoot: string, log?: (line: string) => void}} options context.
 * @returns {Promise<{package: string, version: string, target: object, bytes: number, sha256: string, files: number}>} summary.
 */
export async function repackArchive(file, { repositoryRoot, log = () => {} }) {
  // A package unpacks to more than a gigabyte, and a host's `/tmp` is often a
  // small tmpfs, so work beside the archive on the same filesystem.
  const work = await mkdtemp(path.join(path.dirname(file), '.repack-'))
  try {
    log(`extracting ${path.basename(file)}`)
    const packageDir = await extractArchive(file, work)
    const summary = await repackDirectory(packageDir, repositoryRoot)
    log(`replaced gateway, scripts and plugin files (${String(summary.files)} files in the package)`)
    const parent = path.dirname(packageDir)
    const name = path.basename(packageDir)
    await compressDirectory(parent, name, file)
    const bytes = (await stat(file)).size
    const sha256 = await sha256File(file)
    await writeFile(`${file}.sha256`, `${sha256}  ${path.basename(file)}\n\n`, 'utf8')
    log(`wrote ${path.basename(file)} (${String(bytes)} bytes)`)
    return { package: file, version: summary.version, target: summary.target, bytes, sha256, files: summary.files }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
