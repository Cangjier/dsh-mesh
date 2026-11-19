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

import { existsSync, readFileSync } from 'node:fs'
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
 * The install root holds `dsh-mesh.json`; a release directory inside
 * `releases/` resolves through its grandparent's pointer. A source checkout
 * has no pointer, so it is described by its own `manifest.json` or plugin
 * package when one exists.
 * @param {string} packageRoot install root or release directory.
 * @returns {{version: string|null, buildStamp: string|null, builtAt: string|null, release: string|null, layout: 'pointer', target: object|null}} deployment info.
 */
export function readDeployment(packageRoot) {
  const root = path.resolve(packageRoot)
  const pointerRoot = existsSync(path.join(root, 'dsh-mesh.json'))
    ? root
    : path.basename(path.dirname(root)) === 'releases'
      ? path.dirname(path.dirname(root))
      : root
  const pointer = readJson(path.join(pointerRoot, 'dsh-mesh.json'))
  const active = typeof pointer?.active === 'string' && pointer.active !== '' ? pointer.active : ''
  const resolved = active === ''
    ? root
    : path.isAbsolute(active) ? active : path.join(pointerRoot, active)
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
    release: active === '' ? null : path.basename(resolved),
    layout: 'pointer',
    target: manifest?.target !== null && typeof manifest?.target === 'object' ? manifest.target : null,
  }
}
