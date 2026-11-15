/**
 * Daily build stamps for package filenames.
 *
 * The DSH version in a package name is immutable: it must be exactly the
 * version the app was installed from (for example `0.2.2-rc.3`). Build
 * revisions are separate: `YYYYMMDD` plus a per-day letter (`A`, `B`, ...,
 * `Z`, `AA`, ...), so two packages built from the same DSH version on the same
 * day do not collide.
 *
 * The counter is kept on disk and also reconciled with the package names
 * already present, so deleting a package does not make the next build reuse a
 * letter.
 *
 * @module dsh-mesh/build/stamp
 */

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Default counter file for CLI builds. */
export function defaultStampFile() {
  return path.join(os.homedir(), '.dsh', 'mesh', 'build-stamp.json')
}

/**
 * Local calendar date as `YYYYMMDD`.
 * @param {Date} [date] date.
 * @returns {string} date stamp.
 */
export function buildStampDate(date = new Date()) {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

/**
 * Excel-style column letters: 1 -> A, 26 -> Z, 27 -> AA.
 * @param {number} index positive index.
 * @returns {string} letters.
 */
export function letterFor(index) {
  if (!Number.isSafeInteger(index) || index < 1) throw new Error(`invalid build sequence: ${String(index)}`)
  let value = index
  let letters = ''
  while (value > 0) {
    value -= 1
    letters = String.fromCharCode(65 + (value % 26)) + letters
    value = Math.floor(value / 26)
  }
  return letters
}

/**
 * Inverse of {@link letterFor}.
 * @param {string} letters one or more A-Z letters.
 * @returns {number} index.
 */
export function letterIndex(letters) {
  let value = 0
  for (const char of String(letters)) value = value * 26 + (char.charCodeAt(0) - 64)
  return value
}

/**
 * Whether a string looks like `20261115A`.
 * @param {string} value candidate.
 * @returns {boolean} true when valid.
 */
export function isValidBuildStamp(value) {
  return typeof value === 'string' && /^\d{8}[A-Z]+$/u.test(value)
}

/**
 * Extract today's highest stamp index from package file names.
 * @param {string[]} names file names.
 * @param {string} date `YYYYMMDD`.
 * @returns {number} highest index, or 0.
 */
function highestFromNames(names, date) {
  let highest = 0
  for (const name of names) {
    const match = new RegExp(`-${date}([A-Z]+)-(?:linux|win|darwin)-`, 'u').exec(name)
    if (match !== null) highest = Math.max(highest, letterIndex(match[1]))
  }
  return highest
}

/**
 * Allocate the next daily build stamp and persist the counter.
 * @param {{stateFile?: string, packagesDir?: string, now?: Date}} [options] allocation input.
 * @returns {Promise<string>} stamp such as `20261115A`.
 */
export async function nextBuildStamp(options = {}) {
  const now = options.now ?? new Date()
  const date = buildStampDate(now)
  const stateFile = options.stateFile ?? defaultStampFile()
  const packagesDir = options.packagesDir ?? path.join(os.homedir(), '.dsh', 'packages')
  let state = {}
  try {
    state = JSON.parse(await readFile(stateFile, 'utf8'))
  } catch {
    state = {}
  }
  let next = state?.date === date && Number.isSafeInteger(state.next) && state.next > 0 ? state.next : 1
  const names = await readdir(packagesDir).catch(() => [])
  next = Math.max(next, highestFromNames(names, date) + 1)
  const stamp = `${date}${letterFor(next)}`
  await mkdir(path.dirname(stateFile), { recursive: true })
  const temporary = `${stateFile}.${String(process.pid)}.tmp`
  await writeFile(temporary, `${JSON.stringify({
    format: 1,
    date,
    next: next + 1,
    last: stamp,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8')
  await rename(temporary, stateFile)
  return stamp
}
