#!/usr/bin/env node
/**
 * Refresh a prebuilt offline package from this repository.
 *
 * Accepts either an extracted package directory or a package archive. An
 * archive is extracted to a temporary directory, refreshed, and written back
 * in place with a fresh `.sha256` sidecar.
 *
 * Usage: node scripts/repack.mjs <package-dir-or-archive> [...]
 *
 * @module dsh-mesh/scripts/repack
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { repackArchive, repackDirectory } from '../code/build/repack.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  const targets = process.argv.slice(2)
  if (targets.length === 0) {
    console.error('usage: repack.mjs <package-dir-or-archive> [...]')
    process.exit(2)
  }
  for (const target of targets) {
    const resolved = path.resolve(target)
    const summary = /\.(tar\.gz|tgz|zip)$/u.test(resolved)
      ? await repackArchive(resolved, { repositoryRoot, log: line => console.error(line) })
      : await repackDirectory(resolved, repositoryRoot)
    console.log(JSON.stringify(summary))
  }
}
