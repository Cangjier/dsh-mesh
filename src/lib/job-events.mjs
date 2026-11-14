/**
 * Push build and deploy job changes to the panel.
 *
 * Both job families are directories under `data/` (`build/<id>`, `deploy/<id>`)
 * whose files change while the job runs, so one watcher per root is enough:
 *
 *   state.json / job.json  → the job summary (`build` / `deploy` event)
 *   build.log / deploy.log → the log tail (`build-log` / `deploy-log` event)
 *
 * The panel merges the summary into its table and replaces the log it is
 * showing, so no request is spent while nothing happens.
 *
 * @module @local/dsh-mesh/job-events
 */

import path from 'node:path'

import { JobDirectoryWatcher } from '../../code/shared/event-stream.mjs'

/** At most one log frame per job in this window; the tail is cumulative. */
const LOG_THROTTLE_MS = 400
/** Lines of log tail sent per frame. */
const LOG_LINES = 200
/** Job ids come from our own generators, never from a request. */
const JOB_ID = /^[A-Za-z0-9._-]+$/u

/**
 * Watch the build and deploy roots and push changes into `hub`.
 * @param {{service: object, hub: {send: (type: string, payload: object) => void}, log?: (line: string) => void}} options options.
 * @returns {{close: () => void}} handle.
 */
export function startJobEvents(options) {
  const { service, hub } = options
  const log = options.log ?? (() => {})
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const logTimers = new Map()
  /** @type {Map<string, boolean>} one summary read at a time per job */
  const reading = new Map()
  if (typeof service.dataDir !== 'string' || service.dataDir === '') {
    // A service without a data directory has no job roots to watch (tests and
    // embedded callers); the API still works, it just pushes nothing.
    log('job events disabled: the service has no dataDir')
    return { close() { } }
  }

  const watchers = [
    new JobDirectoryWatcher({
      root: path.join(service.dataDir, 'build'),
      log,
      onChange: (dir, file) => handle('build', dir, file),
    }),
    new JobDirectoryWatcher({
      root: path.join(service.dataDir, 'deploy'),
      log,
      onChange: (dir, file) => handle('deploy', dir, file),
    }),
  ]
  for (const watcher of watchers) watcher.start()

  /**
   * Map one filesystem change onto an event.
   * @param {'build'|'deploy'} kind job family.
   * @param {string} dir job directory name, or '' for a change in the root.
   * @param {string} file changed file name ('' when only the directory is known).
   * @returns {void}
   */
  function handle(kind, dir, file) {
    const id = dir !== '' ? dir : file
    if (typeof id !== 'string' || id === '' || !JOB_ID.test(id)) return
    if (dir === '') {
      // A new job directory (or one just removed): the summary read decides.
      void emit(kind, id)
      return
    }
    if (file === '' || file === 'state.json' || file === 'job.json') {
      void emit(kind, id)
      return
    }
    if (file.endsWith('.log')) scheduleLog(kind, id)
  }

  /**
   * Push the current summary of one job.
   * @param {'build'|'deploy'} kind job family.
   * @param {string} id job id.
   * @returns {Promise<void>} completion.
   */
  async function emit(kind, id) {
    const key = `${kind}:${id}`
    if (reading.get(key) === true) return
    reading.set(key, true)
    try {
      const job = kind === 'build'
        ? await service.buildSummary(id)
        : await service.deployStatus(id)
      if (job === null || job === undefined) return
      hub.send(kind, { type: kind, id, job })
    } catch (error) {
      log(`job event for ${key} failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      reading.delete(key)
    }
  }

  /**
   * Push the log tail of one job, at most once per throttle window.
   *
   * The tail is cumulative, so dropping the frames in between loses nothing:
   * the last one carries every line that matters.
   * @param {'build'|'deploy'} kind job family.
   * @param {string} id job id.
   * @returns {void}
   */
  function scheduleLog(kind, id) {
    const key = `${kind}:${id}`
    if (logTimers.has(key)) return
    const timer = setTimeout(() => {
      logTimers.delete(key)
      void sendLog(kind, id)
    }, LOG_THROTTLE_MS)
    timer.unref?.()
    logTimers.set(key, timer)
  }

  /**
   * Read and send one log tail.
   * @param {'build'|'deploy'} kind job family.
   * @param {string} id job id.
   * @returns {Promise<void>} completion.
   */
  async function sendLog(kind, id) {
    try {
      const text = kind === 'build'
        ? await service.log(id, LOG_LINES)
        : await service.deployLogs(id, LOG_LINES)
      const lines = typeof text === 'string' && text.trim() !== '' ? text.trimEnd().split(/\r?\n/u) : []
      hub.send(`${kind}-log`, { type: `${kind}-log`, id, lines })
    } catch (error) {
      log(`job log for ${kind}:${id} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    close() {
      for (const watcher of watchers) watcher.stop()
      for (const timer of logTimers.values()) clearTimeout(timer)
      logTimers.clear()
      reading.clear()
    },
  }
}
