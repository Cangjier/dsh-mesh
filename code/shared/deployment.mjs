/**
 * Which deployment a running install serves from.
 *
 * The gate and the panel both need the same answer: the version every member
 * currently runs. Reading the plugin's `package.json` alone is not enough — a
 * packaged install has no `package.json` at its root, which is why every
 * member used to report `0.0.0`. The packager writes `manifest.json` next to
 * `gate/`, so that manifest is the source of truth for the version and build
 * stamp, and the release directory name identifies the exact tree.
 *
 * @module dsh-mesh/shared/deployment
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

/** Read one JSON file, or null when it is missing or malformed. */
function readJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Describe the release behind one install directory.
 *
 * Accepts either the directory that owns `current/` (a blue-green install root
 * or the flat gateway) or the release directory itself (the gate's own
 * `PACKAGE_ROOT`).
 * Supports the pointer layout too: the root holding `dsh-mesh.json` resolves
 * to the active release, and a release directory inside `releases/` resolves
 * through its grandparent's pointer.
 * @param {string} packageRoot install root or release directory.
 * @returns {{version: string|null, buildStamp: string|null, builtAt: string|null, release: string|null, layout: 'flat'|'bluegreen'|'pointer', target: object|null}} deployment info.
 */
export function readDeployment(packageRoot) {
  const root = path.resolve(packageRoot)
  let resolved = root
  let layout = 'flat'
  const current = path.join(root, 'current')
  // Pointer install: <root>/dsh-mesh.json names the active release. A release
  // directory itself has no pointer, so look one level up as well (the gate
  // runs with DSH_PACKAGE_ROOT=<release>).
  const pointerRoot = existsSync(path.join(root, 'dsh-mesh.json'))
    ? root
    : path.basename(path.dirname(root)) === 'releases' && existsSync(path.join(path.dirname(path.dirname(root)), 'dsh-mesh.json'))
      ? path.dirname(path.dirname(root))
      : null
  if (pointerRoot !== null) {
    const pointer = readJson(path.join(pointerRoot, 'dsh-mesh.json'))
    const active = typeof pointer?.active === 'string' && pointer.active !== '' ? pointer.active : ''
    if (active !== '') {
      resolved = path.isAbsolute(active) ? active : path.join(pointerRoot, active)
      layout = 'pointer'
    }
  }
  if (layout === 'flat' && existsSync(current)) {
    try {
      resolved = realpathSync(current)
      layout = 'bluegreen'
    } catch {
      // A dangling `current` is a broken install; report the root instead.
    }
  } else if (layout === 'flat' && path.basename(path.dirname(root)) === 'releases') {
    layout = 'bluegreen'
  }
  const manifest = readJson(path.join(resolved, 'manifest.json'))
  const plugin = manifest === null ? readJson(path.join(resolved, 'plugins', 'dsh-mesh', 'package.json')) : null
  const manifestVersion = typeof manifest?.version === 'string' && manifest.version.trim() !== ''
    ? manifest.version.trim()
    : null
  const pluginVersion = typeof plugin?.version === 'string' && plugin.version.trim() !== '' ? plugin.version.trim() : null
  return {
    version: manifestVersion ?? pluginVersion,
    buildStamp: typeof manifest?.buildStamp === 'string' && manifest.buildStamp.trim() !== ''
      ? manifest.buildStamp.trim()
      : null,
    builtAt: typeof manifest?.builtAt === 'string' && manifest.builtAt.trim() !== '' ? manifest.builtAt.trim() : null,
    // The release id only means something for blue-green installs; the flat
    // gateway's directory name is the operator's choice, not a version.
    release: layout === 'flat' ? null : path.basename(resolved),
    layout,
    target: manifest?.target !== null && typeof manifest?.target === 'object' ? manifest.target : null,
  }
}
