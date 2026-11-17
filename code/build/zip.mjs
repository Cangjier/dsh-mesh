/**
 * A small, dependency-free ZIP reader.
 *
 * The deployment package cannot assume `unzip`, `bsdtar`, or any npm module on
 * a member: a test upgrade may be the first thing that runs on a minimal Linux
 * host. ZIP is a simple container around deflate, and Node already ships the
 * inflater, so the browser download can extract itself with the runtime it was
 * started with.
 *
 * Only the parts a Chrome for Testing archive uses are supported: stored and
 * deflated regular files, directories, and symbolic links (macOS bundles).
 * ZIP64 and encryption are rejected with a clear error instead of producing a
 * half-extracted tree.
 *
 * @module dsh-mesh/build/zip
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, open, rm, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw, inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_SIZE = 22
const MAX_COMMENT = 65_535

/** ZIP entry type bits from the Unix mode stored in the central directory. */
const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

/**
 * Find the end-of-central-directory record in the archive tail.
 * @param {Buffer} tail last bytes of the archive.
 * @returns {number} offset inside `tail`, or -1.
 */
function findEndOfCentralDirectory(tail) {
  for (let offset = tail.length - EOCD_SIZE; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue
    const commentLength = tail.readUInt16LE(offset + 20)
    if (offset + EOCD_SIZE + commentLength === tail.length) return offset
  }
  return -1
}

/**
 * Resolve an archive entry below one destination directory.
 *
 * A ZIP name is attacker-controlled when the archive is not trusted; `..` and
 * absolute paths must never write outside the destination.
 * @param {string} destination extraction root.
 * @param {string} name entry name.
 * @returns {string} absolute safe path.
 */
function safeEntryPath(destination, name) {
  const normalized = name.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) {
    throw new Error(`zip entry has an absolute path: ${name}`)
  }
  const segments = normalized.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.includes('..')) throw new Error(`zip entry escapes the destination: ${name}`)
  const root = path.resolve(destination)
  const target = path.resolve(root, ...segments)
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`zip entry escapes the destination: ${name}`)
  }
  return target
}

/**
 * Read one entry's bytes fully. Used for symbolic links, which are tiny.
 * @param {import('node:fs/promises').FileHandle} handle archive.
 * @param {number} offset entry data offset.
 * @param {number} compressedSize bytes in the archive.
 * @param {number} method compression method.
 * @returns {Promise<Buffer>} entry bytes.
 */
async function readEntry(handle, offset, compressedSize, method) {
  const compressed = Buffer.alloc(compressedSize)
  await handle.read(compressed, 0, compressedSize, offset)
  if (method === 0) return compressed
  if (method === 8) return inflateRawSync(compressed)
  throw new Error(`zip compression method ${String(method)} is not supported`)
}

/**
 * Extract a ZIP archive into an empty destination directory.
 *
 * @param {string} archive archive path.
 * @param {string} destination directory to create (removed first).
 * @returns {Promise<string[]>} extracted file and directory paths.
 */
export async function extractZip(archive, destination) {
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  const handle = await open(archive, 'r')
  const extracted = []
  try {
    const size = (await handle.stat()).size
    if (size < EOCD_SIZE) throw new Error(`not a zip archive: ${archive}`)
    const tailLength = Math.min(size, EOCD_SIZE + MAX_COMMENT)
    const tail = Buffer.alloc(tailLength)
    await handle.read(tail, 0, tailLength, size - tailLength)
    const eocd = findEndOfCentralDirectory(tail)
    if (eocd < 0) throw new Error(`not a zip archive (no central directory): ${archive}`)
    const disk = tail.readUInt16LE(eocd + 4)
    const centralDisk = tail.readUInt16LE(eocd + 6)
    const entryCount = tail.readUInt16LE(eocd + 10)
    const centralSize = tail.readUInt32LE(eocd + 12)
    const centralOffset = tail.readUInt32LE(eocd + 16)
    if (disk !== 0 || centralDisk !== 0) throw new Error('zip64 and multi-disk archives are not supported')
    if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new Error('zip64 archives are not supported')
    }
    const central = Buffer.alloc(centralSize)
    await handle.read(central, 0, centralSize, centralOffset)

    let cursor = 0
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
        throw new Error(`zip central directory is corrupt at entry ${String(index)}`)
      }
      const flags = central.readUInt16LE(cursor + 8)
      const method = central.readUInt16LE(cursor + 10)
      const compressedSize = central.readUInt32LE(cursor + 20)
      const uncompressedSize = central.readUInt32LE(cursor + 24)
      const nameLength = central.readUInt16LE(cursor + 28)
      const extraLength = central.readUInt16LE(cursor + 30)
      const commentLength = central.readUInt16LE(cursor + 32)
      const externalAttributes = central.readUInt32LE(cursor + 38)
      const localOffset = central.readUInt32LE(cursor + 42)
      const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
      cursor += 46 + nameLength + extraLength + commentLength
      if ((flags & 0x0001) !== 0) throw new Error(`zip entry is encrypted: ${name}`)
      if (name === '') throw new Error('zip entry has no name')

      const local = Buffer.alloc(30)
      await handle.read(local, 0, local.length, localOffset)
      if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new Error(`zip local header is corrupt: ${name}`)
      const localNameLength = local.readUInt16LE(26)
      const localExtraLength = local.readUInt16LE(28)
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength
      const mode = (externalAttributes >>> 16) & 0xffff
      const kind = mode & S_IFMT
      const target = safeEntryPath(destination, name)
      const directory = name.endsWith('/') || kind === S_IFDIR
      if (directory) {
        await mkdir(target, { recursive: true })
        extracted.push(target)
        continue
      }
      await mkdir(path.dirname(target), { recursive: true })
      if (kind === S_IFLNK) {
        const linkTarget = (await readEntry(handle, dataOffset, compressedSize, method)).toString('utf8')
        const resolved = path.resolve(path.dirname(target), linkTarget)
        const root = path.resolve(destination)
        if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
          throw new Error(`zip symlink escapes the destination: ${name} -> ${linkTarget}`)
        }
        await symlink(linkTarget, target)
        extracted.push(target)
        continue
      }
      if (compressedSize === 0) {
        await writeFile(target, Buffer.alloc(0))
      } else if (method === 0 || method === 8) {
        const source = createReadStream(archive, { start: dataOffset, end: dataOffset + compressedSize - 1 })
        const sink = createWriteStream(target)
        if (method === 8) await pipeline(source, createInflateRaw(), sink)
        else await pipeline(source, sink)
      } else {
        throw new Error(`zip compression method ${String(method)} is not supported: ${name}`)
      }
      const written = (await stat(target)).size
      if (uncompressedSize !== 0xffffffff && written !== uncompressedSize) {
        throw new Error(`zip entry has the wrong size: ${name} (${String(written)} != ${String(uncompressedSize)})`)
      }
      const permissions = mode & 0o777
      if (permissions !== 0) await chmod(target, permissions).catch(() => {})
      extracted.push(target)
    }
    return extracted
  } finally {
    await handle.close()
  }
}
