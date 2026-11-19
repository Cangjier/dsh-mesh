/**
 * Archiving for the build engine: a `.tar.gz` produced with more than one core.
 *
 * Two things made the old path slow on a Windows build host, which is where
 * the panel builds by default:
 *
 *   1. `tar -czf` compresses with one thread. A ~1 GiB package tree spends
 *      minutes there while seven cores sit idle.
 *   2. Windows' bsdtar writes every entry with mode 0666, so a Linux package
 *      built on Windows then had its whole archive gunzipped into memory,
 *      patched block by block, and re-gzipped at level 9 — in one thread, with
 *      a multi-gigabyte peak.
 *
 * This module writes the tar uncompressed, patches the header blocks while it
 * streams (never holding the tree in memory), and compresses independent
 * chunks on worker threads. Concatenated gzip members are a valid `.tar.gz`
 * and both GNU tar (Linux members) and bsdtar (Windows members) read them; the
 * build tests extract the result with GNU tar.
 *
 * A single-thread run still emits one ordinary gzip stream, so nothing depends
 * on the parallel path when the host is small.
 *
 * @module dsh-mesh/build/archive
 */

import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { open, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Worker } from 'node:worker_threads'
import { createGzip } from 'node:zlib'

/** Never read less than this per chunk: worker round trips would dominate. */
const MIN_CHUNK = 2 * 1024 * 1024
/** Never read more than this per chunk: bounds the memory of one worker. */
const MAX_CHUNK = 32 * 1024 * 1024
/** The tar format is a sequence of 512-byte blocks. */
const BLOCK = 512
/** gzip level used for packages; 6 is the format default and a fair size/speed point. */
const DEFAULT_LEVEL = 6

/**
 * How many compression workers to use.
 * @param {{cpus?: number, env?: NodeJS.ProcessEnv}} [options] inputs.
 * @returns {number} 1..8.
 */
export function archiveThreads(options = {}) {
  const env = options.env ?? process.env
  const requested = Number(env.DSH_MESH_ARCHIVE_THREADS)
  if (Number.isSafeInteger(requested) && requested > 0) return Math.min(8, requested)
  const cpus = Number(options.cpus) || os.availableParallelism?.() || os.cpus().length || 1
  return Math.max(1, Math.min(8, cpus))
}

/**
 * Run one command and capture its tail.
 * @param {string} command executable.
 * @param {string[]} args arguments.
 * @param {{cwd?: string, log?: (line: string) => void}} [options] input.
 * @returns {Promise<{ok: boolean, code: number|null, tail: string[]}>} result.
 */
function run(command, args, options = {}) {
  const log = options.log ?? (() => {})
  const tail = []
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, code: null, tail: [error instanceof Error ? error.message : String(error)] })
      return
    }
    const onData = chunk => {
      for (const line of String(chunk).split(/\r?\n/u)) {
        if (line === '') continue
        tail.push(line)
        if (tail.length > 80) tail.shift()
        log(line)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', error => resolve({ ok: false, code: null, tail: [...tail, String(error)] }))
    child.on('close', code => resolve({ ok: code === 0, code, tail }))
  })
}

/**
 * Write an uncompressed tar of one directory.
 * @param {string} packageDir directory to archive (archived under its basename).
 * @param {string} tarPath destination.
 * @param {{log?: (line: string) => void}} [options] input.
 * @returns {Promise<void>}
 */
export async function createTar(packageDir, tarPath, options = {}) {
  await rm(tarPath, { force: true })
  const result = await run('tar', ['-cf', tarPath, '-C', path.dirname(packageDir), path.basename(packageDir)], options)
  if (!result.ok) throw new Error(`cannot create ${tarPath}: ${result.tail.join('\n')}`)
}

/**
 * Whether one 512-byte block is all zeroes (the end-of-archive marker).
 * @param {Buffer} block block.
 * @returns {boolean} true when zero.
 */
function isZeroBlock(block) {
  for (const byte of block) if (byte !== 0) return false
  return true
}

/**
 * Parse an octal field from a tar header.
 * @param {Buffer} field field bytes.
 * @returns {number} value or 0.
 */
function parseOctal(field) {
  const text = field.toString('ascii').replace(/\0.*$/u, '').trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}

/**
 * Rewrite one tar header to mode 0755 and fix its checksum.
 * @param {Buffer} header 512-byte header.
 * @returns {void}
 */
function patchHeader(header) {
  // Mode is an 8-byte octal field: six digits, NUL, space.
  header.write('0000755\0', 100, 8, 'ascii')
  // The checksum is computed with its own field treated as spaces.
  header.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
}

/**
 * Patch every tar header inside one run of bytes that starts on a block edge.
 *
 * `state.dataLeft` carries the payload length from a header into the following
 * chunks. `state.remainder` is only used by the single-stream path, where file
 * reads are not block aligned: bytes after the last complete block are kept
 * for the next chunk so a header is never cut in half.
 * @param {Buffer} chunk bytes starting on a 512-byte boundary.
 * @param {{dataLeft: number}} state parser state.
 * @returns {void}
 */
function patchChunk(chunk, state) {
  let offset = 0
  while (offset + BLOCK <= chunk.length) {
    if (state.dataLeft > 0) {
      const take = Math.min(state.dataLeft, chunk.length - offset)
      offset += take
      state.dataLeft -= take
      continue
    }
    const header = chunk.subarray(offset, offset + BLOCK)
    if (isZeroBlock(header)) {
      offset += BLOCK
      continue
    }
    patchHeader(header)
    state.dataLeft = Math.ceil(parseOctal(header.subarray(124, 136)) / BLOCK) * BLOCK
    offset += BLOCK
  }
}

/**
 * Worker source: compress one chunk into its own gzip member.
 * @type {string}
 */
const COMPRESS_WORKER = `
const { parentPort } = require('node:worker_threads')
const { gzipSync } = require('node:zlib')
parentPort.on('message', message => {
  const input = Buffer.from(message.chunk)
  const compressed = gzipSync(input, { level: message.level })
  const exact = compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength)
  parentPort.postMessage({ seq: message.seq, chunk: exact }, [exact])
})
`

/**
 * Compress one file to gzip using several worker threads.
 *
 * The file is split into fixed-size, block-aligned chunks; each chunk becomes
 * an independent gzip member and the members are concatenated in order. gzip
 * explicitly allows that, and every consumer in this project (`tar -xzf` on
 * Linux, `tar.exe -xzf` on Windows) reads it — the build tests extract the
 * result, and the Windows path was checked against the member's bsdtar.
 * @param {{source: string, destination: string, threads: number, patchModes: boolean, log?: (line: string) => void, level?: number}} options input.
 * @returns {Promise<{members: number, bytes: number}>} outcome.
 */
export async function gzipParallel(options) {
  const log = options.log ?? (() => {})
  const info = await stat(options.source)
  const level = Number.isSafeInteger(options.level) ? options.level : DEFAULT_LEVEL
  const wanted = Math.max(1, Math.min(options.threads, Math.floor(info.size / MIN_CHUNK) || 1))
  const threads = Math.max(1, Math.min(wanted, 8))
  const chunkSize = Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, Math.ceil(info.size / threads / BLOCK) * BLOCK))
  await rm(options.destination, { force: true })

  const input = await open(options.source, 'r')
  const output = await open(options.destination, 'w')
  const workers = []
  const idle = []
  const waiting = []
  const acquire = () => (idle.length > 0
    ? Promise.resolve(idle.pop())
    : new Promise(resolve => waiting.push(resolve)))
  const release = worker => {
    const next = waiting.shift()
    if (next !== undefined) next(worker)
    else idle.push(worker)
  }
  let seqDispatched = 0
  const compressed = new Map()
  let nextWrite = 0
  let written = 0
  let drainChain = Promise.resolve()
  let failure = null
  let received = 0
  let settle = null

  // Resolves once every dispatched chunk has been compressed and written.
  const finished = new Promise(resolve => {
    settle = resolve
  })
  const maybeSettled = () => {
    if (received === seqDispatched && nextWrite === received) settle?.()
  }

  const writeAll = async buffer => {
    let done = 0
    while (done < buffer.length) {
      const result = await output.write(buffer, done, buffer.length - done)
      if (result.bytesWritten <= 0) throw new Error(`cannot write ${options.destination}`)
      done += result.bytesWritten
    }
  }

  const drain = () => {
    drainChain = drainChain.then(async () => {
      while (compressed.has(nextWrite)) {
        const buffer = compressed.get(nextWrite)
        compressed.delete(nextWrite)
        await writeAll(buffer)
        written += buffer.length
        nextWrite += 1
        maybeSettled()
      }
    }).catch(error => {
      failure = failure ?? (error instanceof Error ? error : new Error(String(error)))
      // Release blocked producers so the loop can observe the failure instead
      // of waiting forever for a worker that will never return a chunk.
      waiting.splice(0).forEach(resolve => resolve(null))
    })
    return drainChain
  }

  try {
    for (let index = 0; index < threads; index += 1) {
      const worker = new Worker(COMPRESS_WORKER, { eval: true })
      worker.on('message', message => {
        compressed.set(message.seq, Buffer.from(message.chunk))
        received += 1
        release(worker)
        void drain()
        maybeSettled()
      })
      worker.on('error', error => {
        failure = failure ?? (error instanceof Error ? error : new Error(String(error)))
        log(`compression worker failed: ${failure.message}`)
        waiting.splice(0).forEach(resolve => resolve(null))
      })
      idle.push(worker)
      workers.push(worker)
    }

    const state = { dataLeft: 0 }
    let offset = 0
    while (offset < info.size) {
      const length = Math.min(chunkSize, info.size - offset)
      const buffer = Buffer.allocUnsafeSlow(length)
      let filled = 0
      while (filled < length) {
        const read = await input.read(buffer, filled, length - filled, offset + filled)
        if (read.bytesRead === 0) break
        filled += read.bytesRead
      }
      if (filled < length) throw new Error(`short read from ${options.source} at ${String(offset)}: ${String(filled)} of ${String(length)} bytes`)
      if (options.patchModes === true) patchChunk(buffer, state)
      const worker = await acquire()
      if (worker === null) throw failure ?? new Error('compression worker failed')
      worker.postMessage({ seq: seqDispatched, chunk: buffer.buffer, level }, [buffer.buffer])
      seqDispatched += 1
      offset += filled
    }
    await finished
    await drain()
    if (failure !== null) throw failure
    if (nextWrite !== seqDispatched) {
      throw new Error(`compression lost chunks: wrote ${String(nextWrite)} of ${String(seqDispatched)}`)
    }
    await output.sync()
  } finally {
    await output.close().catch(() => {})
    await input.close().catch(() => {})
    await Promise.all(workers.map(worker => worker.terminate().catch(() => {})))
  }
  return { members: nextWrite, bytes: written }
}

/**
 * Compress one file with a single gzip stream (no parallel members).
 * @param {string} source file.
 * @param {string} destination file.
 * @param {boolean} patchModes whether to rewrite tar headers.
 * @returns {Promise<{members: number, bytes: number}>} outcome.
 */
async function gzipSingle(source, destination, patchModes) {
  const steps = [createReadStream(source)]
  if (patchModes) {
    const state = { dataLeft: 0, remainder: Buffer.alloc(0) }
    steps.push(new Transform({
      transform(chunk, _encoding, callback) {
        state.remainder = Buffer.concat([state.remainder, chunk])
        const usable = state.remainder.length - (state.remainder.length % BLOCK)
        if (usable > 0) {
          const body = state.remainder.subarray(0, usable)
          patchChunk(body, state)
          this.push(body)
          state.remainder = state.remainder.subarray(usable)
        }
        callback()
      },
      flush(callback) {
        if (state.remainder.length > 0) this.push(state.remainder)
        callback()
      },
    }))
  }
  steps.push(createGzip({ level: DEFAULT_LEVEL }), createWriteStream(destination))
  await pipeline(...steps)
  return { members: 1, bytes: (await stat(destination)).size }
}

/**
 * Turn one package directory into a 7-Zip archive.
 *
 * LZMA2 compresses the ~1.2 GiB package tree far better than deflate, and the
 * encoder is multithreaded (`-mmt`), so this replaces both the gzip/zip
 * creation and the old single-threaded post-passes. `-snl` stores symlinks as
 * symlinks; without it 7-Zip follows them and a Linux package would ship the
 * target's contents instead of the link (npm trees on Linux use `.bin` links).
 * @param {{packageDir: string, destination: string, binary: string, level?: number, threads?: number, log?: (line: string) => void}} options input.
 * @returns {Promise<{bytes: number}>} outcome.
 */
export async function createSevenZip(options) {
  const log = options.log ?? (() => {})
  const level = Number.isSafeInteger(options.level) ? options.level : Number(process.env.DSH_MESH_7Z_LEVEL ?? 0) || 5
  const threads = Math.max(1, Number(options.threads) || 1)
  await rm(options.destination, { force: true })
  const args = [
    'a',
    '-t7z',
    `-mx=${Math.max(0, Math.min(9, level))}`,
    `-mmt=${threads}`,
    '-bd',
    '-snl',
    options.destination,
    path.basename(options.packageDir),
  ]
  log(`7z ${args.slice(0, 5).join(' ')} ${path.basename(options.destination)}`)
  const result = await run(options.binary, args, { cwd: path.dirname(options.packageDir), log })
  if (!result.ok) throw new Error(`7z could not create ${options.destination}: ${result.tail.join('\n')}`)
  const info = await stat(options.destination)
  if (!info.isFile() || info.size <= 0) throw new Error(`7z created no usable archive: ${options.destination}`)
  return { bytes: info.size }
}

/**
 * Turn one package directory into a gzip tar, parallel when it is worth it.
 * @param {{packageDir: string, destination: string, patchModes?: boolean, threads?: number, log?: (line: string) => void}} options input.
 * @returns {Promise<{members: number, bytes: number}>} outcome.
 */
export async function createTarGz(options) {
  const log = options.log ?? (() => {})
  const tarPath = `${options.destination}.tar`
  const threads = Math.max(1, Number(options.threads) || 1)
  try {
    log(`creating tar for ${path.basename(options.packageDir)}`)
    await createTar(options.packageDir, tarPath, { log })
    const size = (await stat(tarPath)).size
    if (threads <= 1 || size < MIN_CHUNK) {
      return await gzipSingle(tarPath, options.destination, options.patchModes === true)
    }
    const started = Date.now()
    const result = await gzipParallel({
      source: tarPath,
      destination: options.destination,
      threads,
      patchModes: options.patchModes === true,
      log,
    })
    log(`compressed ${path.basename(options.destination)} on ${String(threads)} threads ` +
      `(${String(result.members)} gzip members, ${String(Math.max(1, Math.round((Date.now() - started) / 1000)))}s)`)
    return result
  } finally {
    await rm(tarPath, { force: true }).catch(() => {})
  }
}
