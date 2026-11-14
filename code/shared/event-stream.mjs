/**
 * Server-sent events and change watches shared by the mesh host API and the
 * gateway.
 *
 * The panel used to refresh build/deploy/hysteria progress on a 1–4 second
 * timer. That is a poll: it spends a request per tick whether or not anything
 * changed, and it shows the change one tick late. The replacement is one SSE
 * connection per panel plus a filesystem watch on the job directories: the
 * service pushes the job state (and the log tail) the moment it changes.
 *
 * `JobDirectoryWatcher` watches a root non-recursively and every immediate
 * subdirectory too. A recursive watch would fire for every file inside a build
 * checkout (`src/` can hold a whole DSH tree), which is exactly the kind of
 * noise a change feed must not carry.
 *
 * @module @local/dsh-mesh/shared/event-stream
 */

import { mkdirSync, readdirSync, watch } from 'node:fs'
import path from 'node:path'

/** How often an idle SSE connection sends a comment line to survive proxies. */
const HEARTBEAT_MS = 15_000
/** How long watcher callbacks are batched before one change notification. */
const DEBOUNCE_MS = 120

/**
 * A set of SSE responses that can be written to from anywhere.
 */
export class EventHub {
  /**
   * @param {{log?: (line: string) => void, heartbeatMs?: number}} [options] options.
   */
  constructor(options = {}) {
    this.log = options.log ?? (() => {})
    this.heartbeatMs = Number.isSafeInteger(options.heartbeatMs) ? options.heartbeatMs : HEARTBEAT_MS
    /** @type {Set<import('node:http').ServerResponse>} */
    this.clients = new Set()
  }

  /** How many panels are currently subscribed. */
  get size() {
    return this.clients.size
  }

  /**
   * Turn one HTTP response into a long-lived event stream.
   *
   * The caller must not write to the response afterwards. The returned
   * unsubscribe function is idempotent, so both request and response `close`
   * handlers can call it.
   * @param {import('node:http').IncomingMessage} request request.
   * @param {import('node:http').ServerResponse} response response.
   * @returns {() => void} unsubscribe.
   */
  subscribe(request, response) {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // Reconnect delay, then a ready frame so the panel can refresh once and
    // treat every later frame as a change.
    try {
      response.write('retry: 3000\n\n')
      response.write(`event: ready\ndata: ${JSON.stringify({ type: 'ready' })}\n\n`)
    } catch {
      try { response.end() } catch { }
      return () => { }
    }
    this.clients.add(response)

    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      this.clients.delete(response)
    }
    const heartbeat = setInterval(() => {
      try {
        response.write(': ping\n\n')
      } catch {
        close()
      }
    }, this.heartbeatMs)
    heartbeat.unref?.()
    request.once('close', close)
    response.once('close', close)
    return close
  }

  /**
   * Send one named event to every subscriber.
   * @param {string} type event name.
   * @param {object} payload JSON payload.
   * @returns {void}
   */
  send(type, payload) {
    if (this.clients.size === 0) return
    const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
    for (const client of [...this.clients]) {
      try {
        client.write(frame)
      } catch {
        this.clients.delete(client)
      }
    }
  }

  /** Close every stream, e.g. when the plugin is unloaded. */
  close() {
    for (const client of [...this.clients]) {
      try { client.end() } catch { }
    }
    this.clients.clear()
  }
}

/**
 * Watches a job root: its immediate subdirectories (one job per directory) and
 * the files directly inside them.
 *
 * Deliberately not recursive. A build job keeps the whole checked-out source
 * tree under its directory; watching that would deliver events for every file
 * `pnpm install` writes.
 */
export class JobDirectoryWatcher {
  /**
   * @param {{root: string, onChange: (dir: string, file: string) => void, log?: (line: string) => void}} options options.
   */
  constructor(options) {
    this.root = options.root
    this.onChange = options.onChange
    this.log = options.log ?? (() => {})
    /** @type {Map<string, import('node:fs').FSWatcher>} */
    this.watchers = new Map()
    /** @type {Map<string, {dir: string, file: string}>} */
    this.pending = new Map()
    this.rootWatcher = null
    this.timer = null
    this.started = false
  }

  /** Start watching. Safe to call twice. */
  start() {
    if (this.started) return
    this.started = true
    try {
      mkdirSync(this.root, { recursive: true })
      this.rootWatcher = watch(this.root, { persistent: false }, (_event, file) => {
        // A new job directory appears here before it has any files.
        this.#scan()
        this.#queue('', String(file ?? ''))
      })
      this.rootWatcher.on('error', (error) => this.#fail(error))
    } catch (error) {
      this.#fail(error)
      return
    }
    this.#scan()
  }

  /** Stop every watcher and drop pending callbacks. */
  stop() {
    this.started = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending.clear()
    this.rootWatcher?.close()
    this.rootWatcher = null
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }

  /** Add a watcher for every immediate subdirectory not seen yet. */
  #scan() {
    let entries = []
    try {
      entries = readdirSync(this.root, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || this.watchers.has(entry.name)) continue
      try {
        const watcher = watch(path.join(this.root, entry.name), { persistent: false }, (_event, file) => {
          this.#queue(entry.name, String(file ?? ''))
        })
        watcher.on('error', () => {
          // A job directory removed under us: forget it, the root watch will
          // see it again if it comes back.
          this.watchers.delete(entry.name)
        })
        this.watchers.set(entry.name, watcher)
      } catch {
        // The directory vanished between readdir and watch.
      }
    }
  }

  /** Batch one change and deliver it after a short debounce. */
  #queue(dir, file) {
    this.pending.set(`${dir}\u0000${file}`, { dir, file })
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      const changes = [...this.pending.values()]
      this.pending.clear()
      for (const change of changes) {
        try {
          this.onChange(change.dir, change.file)
        } catch (error) {
          this.log(`event watcher callback failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }, DEBOUNCE_MS)
    this.timer.unref?.()
  }

  /** Report a watcher that could not even be created. */
  #fail(error) {
    this.log(`cannot watch ${this.root}: ${error instanceof Error ? error.message : String(error)}`)
    this.rootWatcher?.close()
    this.rootWatcher = null
  }
}
