#!/usr/bin/env node
/**
 * Refresh an already assembled offline package from this repository.
 *
 * Rebuilding a package from scratch downloads the DSH app dependencies and the
 * Node runtime again; those parts do not change between plugin releases. This
 * script keeps `app/`, `web/`, `runtime/` and the rest of the payload as they
 * are and replaces only the files this repository owns:
 *
 *   - gate/, shared/, config/          (the gateway and its helpers)
 *   - code/{windows-service,interop-service,wireguard}
 *   - the root scripts and VERSION
 *   - plugins/dsh-mesh/                (host bundle, client bundle, recipes)
 *   - docs/
 *
 * Usage: node scripts/repack.mjs <extracted-package-dir> [<package-dir> ...]
 *
 * @module dsh-mesh/scripts/repack
 */

import { cp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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
 * Refresh one extracted package.
 * @param {string} packageDir extracted package root (the directory holding manifest.json).
 * @returns {Promise<object>} summary.
 */
export async function repack(packageDir) {
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
  manifest.repackedFrom = 'scripts/repack.mjs'
  manifest.files = await countFiles(packageDir)
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const size = (await stat(path.join(packageDir, 'plugins', 'dsh-mesh', 'client.js'))).size
  return { packageDir, version: manifest.version, target: manifest.target, files: manifest.files, clientBytes: size }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const targets = process.argv.slice(2)
  if (targets.length === 0) {
    console.error('usage: repack.mjs <extracted-package-dir> [...]')
    process.exit(2)
  }
  for (const target of targets) {
    const summary = await repack(path.resolve(target))
    console.log(JSON.stringify(summary))
  }
}
