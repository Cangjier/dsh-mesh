/**
 * Copy the deployer's DeepSeek account grants into a member's credentials.
 *
 * A deployed member starts without an account, so the operator would have to
 * scan a QR code on every machine. The account lives in
 * `$DSH_HOME/.credentials.yaml` as `deepseek-account-platform/*` records, so
 * those records alone are enough to sign the member in: everything else in the
 * file (the browser-session grant, member-specific entries) is left untouched.
 *
 * @module dsh-mesh/shared/credentials
 */

import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Records that carry the account sign-in. */
export const ACCOUNT_RECORD_PREFIX = 'deepseek-account-platform/'

/**
 * Split a credentials file into its header, named records, and tail.
 * @param {string} text file contents.
 * @returns {{header: string[], records: Array<{name: string, lines: string[]}>, tail: string[]}} parts.
 */
export function splitCredentials(text) {
  const lines = String(text).split('\n')
  const header = []
  const records = []
  const tail = []
  let index = 0
  while (index < lines.length && !/^records:\s*$/u.test(lines[index])) {
    header.push(lines[index])
    index += 1
  }
  if (index >= lines.length) return { header: lines, records, tail }
  header.push(lines[index])
  index += 1
  let current
  for (; index < lines.length; index += 1) {
    const match = /^ {2}([^\s].*?):\s*$/u.exec(lines[index])
    if (match !== null) {
      if (current !== undefined) records.push(current)
      current = { name: match[1], lines: [lines[index]] }
      continue
    }
    if (current !== undefined) current.lines.push(lines[index])
    else tail.push(lines[index])
  }
  if (current !== undefined) records.push(current)
  return { header, records, tail }
}

/**
 * Render split parts back into a credentials file.
 * @param {{header: string[], records: Array<{name: string, lines: string[]}>, tail: string[]}} parts parts.
 * @returns {string} file contents ending with one newline.
 */
export function renderCredentials(parts) {
  const lines = [...parts.header]
  for (const record of parts.records) {
    const body = [...record.lines]
    while (body.length > 1 && body[body.length - 1].trim() === '') body.pop()
    lines.push(...body, '')
  }
  for (const line of parts.tail) if (line.trim() !== '') lines.push(line)
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return `${lines.join('\n')}\n`
}

/**
 * Merge the account records of one credentials file into another.
 *
 * Without a target file the source is written as-is. Otherwise the target's
 * own records survive: only `deepseek-account-platform/*` blocks are replaced
 * (or added), and the target's key order is kept.
 *
 * @param {string|null} targetText current member credentials, or null.
 * @param {string} sourceText deployer credentials.
 * @returns {string} merged credentials.
 */
export function mergeAccountCredentials(targetText, sourceText) {
  const source = splitCredentials(sourceText)
  const account = source.records.filter(record => record.name.startsWith(ACCOUNT_RECORD_PREFIX))
  if (typeof targetText !== 'string' || targetText.trim() === '') return renderCredentials({
    header: source.header,
    records: account,
    tail: source.tail,
  })
  const target = splitCredentials(targetText)
  const merged = target.records.map(record => ({ ...record, lines: [...record.lines] }))
  for (const record of account) {
    const at = merged.findIndex(existing => existing.name === record.name)
    if (at === -1) merged.push({ name: record.name, lines: [...record.lines] })
    else merged[at] = { name: record.name, lines: [...record.lines] }
  }
  const header = target.header.some(line => /^records:\s*$/u.test(line)) ? target.header : [...target.header, 'records:']
  return renderCredentials({ header, records: merged, tail: target.tail })
}

/**
 * Read both files and write the merged result.
 * @param {string} targetFile member credentials path.
 * @param {string} sourceFile deployer credentials path.
 * @returns {{merged: boolean, records: number}} outcome.
 */
export function mergeCredentialsFile(targetFile, sourceFile) {
  const source = readFileSync(sourceFile, 'utf8')
  let target = null
  try {
    target = readFileSync(targetFile, 'utf8')
  } catch {
    target = null
  }
  const merged = mergeAccountCredentials(target, source)
  writeFileSync(targetFile, merged, { mode: 0o600 })
  const { records } = splitCredentials(merged)
  return { merged: true, records: records.filter(record => record.name.startsWith(ACCOUNT_RECORD_PREFIX)).length }
}

/**
 * Whether this module was started as a script rather than imported.
 *
 * `import.meta.url` is already canonical, while `argv[1]` keeps the path the
 * caller typed; on Windows `current\shared` is a junction to the release, so
 * both sides are resolved and compared case-insensitively.
 * @returns {boolean} true when run directly.
 */
function isMain() {
  if (process.argv[1] === undefined) return false
  try {
    const self = realpathSync(fileURLToPath(import.meta.url))
    const entry = realpathSync(process.argv[1])
    return process.platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry
  } catch {
    return false
  }
}

if (isMain()) {
  const [targetFile, sourceFile] = process.argv.slice(2)
  if (targetFile === undefined || sourceFile === undefined) {
    console.error('usage: credentials-merge.mjs <target> <source>')
    process.exit(2)
  }
  try {
    const result = mergeCredentialsFile(targetFile, sourceFile)
    console.log(`credentials-merge: ${String(result.records)} account record(s) copied into ${targetFile}`)
  } catch (error) {
    console.error(`credentials-merge: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
