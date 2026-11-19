/**
 * Standalone CLI for the deterministic build engine.
 *
 * The plugin tool uses the same functions from `job.mjs`; this entry exists so
 * a human (or a work order) can run and inspect a build without DSH.
 *
 * @module dsh-mesh/build/cli
 */

import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createJob,
  defaultJobRoot,
  learnJob,
  readLogTail,
  readState,
  resumeJob,
  runJob,
} from './job.mjs'
import { defaultStampFile, isValidBuildStamp, nextBuildStamp } from './stamp.mjs'
import { defaultReleaseConfigFile, loadReleaseConfig } from '../shared/release.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(HERE, '..', '..')

/**
 * Parse `--name value` and `--flag` arguments.
 * @param {string[]} argv command arguments.
 * @returns {{command: string, values: Map<string, string|true>, positionals: string[]}} parsed.
 */
function parseArgs(argv) {
  const values = new Map()
  const positionals = []
  let command = ''
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      if (command === '') command = arg
      else positionals.push(arg)
      continue
    }
    const equals = arg.indexOf('=')
    if (equals !== -1) {
      values.set(arg.slice(2, equals), arg.slice(equals + 1))
      continue
    }
    const name = arg.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      values.set(name, next)
      index += 1
    } else {
      values.set(name, true)
    }
  }
  return { command, values, positionals }
}

/**
 * Read the recipe manifest defaults.
 * @returns {Promise<{source: string, ref: string, tree: string|null}>} defaults.
 */
async function recipeDefaults() {
  try {
    const parsed = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, 'build', 'recipes.json'), 'utf8'))
    return {
      source: typeof parsed.source === 'string' ? parsed.source : '',
      ref: typeof parsed.ref === 'string' ? parsed.ref : 'master',
      tree: typeof parsed.tree === 'string' ? parsed.tree : null,
    }
  } catch {
    return { source: '', ref: 'master', tree: null }
  }
}

/**
 * Split one optional command argument.
 * @param {string|true|undefined} value argument.
 * @returns {string[]|undefined} argv or undefined.
 */
function commandArg(value) {
  if (value === undefined || value === true) return undefined
  return value.split(/\s+/u).filter(Boolean)
}

/**
 * Parse one positive integer option.
 * @param {Map<string, string|true>} values parsed arguments.
 * @param {string} name option name.
 * @returns {number|undefined} value.
 */
function numberArg(values, name) {
  const value = values.get(name)
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return undefined
  return Number(value)
}

/**
 * Load the release config for this build.
 *
 * A build always carries a publish decision: `--no-publish` turns it off, and
 * otherwise the file (or the environment tokens) decides whether there is
 * anything to publish. Publishing never blocks a build from finishing.
 * @param {Map<string, string|true>} values parsed arguments.
 * @returns {Promise<object|false>} publish config or false.
 */
async function publishOptions(values) {
  if (values.get('no-publish') === true) return false
  const file = typeof values.get('release-config') === 'string' ? values.get('release-config') : defaultReleaseConfigFile()
  const config = await loadReleaseConfig({ file })
  return { config, proxy: typeof values.get('proxy') === 'string' ? values.get('proxy') : null }
}

/**
 * Cache and parallelism switches shared by `build` and `resume`.
 * @param {Map<string, string|true>} values parsed arguments.
 * @returns {{cache?: boolean, refreshAppCache: boolean, refreshWebCache: boolean, concurrency?: number, archiveThreads?: number}} options.
 */
function speedOptions(values) {
  return {
    cache: values.get('no-cache') === true ? false : undefined,
    refreshAppCache: values.get('refresh-app-cache') === true,
    refreshWebCache: values.get('refresh-web-cache') === true,
    concurrency: numberArg(values, 'concurrency'),
    archiveThreads: numberArg(values, 'archive-threads'),
    archiveFormat: typeof values.get('archive-format') === 'string' ? values.get('archive-format') : undefined,
  }
}

async function main() {
  const { command, values } = parseArgs(process.argv.slice(2))
  const defaults = await recipeDefaults()
  const source = typeof values.get('source') === 'string' ? values.get('source') : defaults.source
  const ref = typeof values.get('ref') === 'string' ? values.get('ref') : defaults.ref
  const targets = typeof values.get('targets') === 'string'
    ? values.get('targets').split(',').map(value => value.trim()).filter(Boolean)
    : ['linux-x64', 'win-x64']

  if (command === 'status') {
    const dir = String(values.get('job') ?? '')
    if (dir === '') throw new Error('status needs --job <dir>')
    const state = await readState(dir)
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
    return
  }
  if (command === 'learn') {
    const dir = String(values.get('job') ?? '')
    if (dir === '') throw new Error('learn needs --job <dir>')
    const state = await learnJob(dir, { repositoryRoot: REPOSITORY_ROOT })
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
    return
  }
  if (command === 'resume') {
    const dir = String(values.get('job') ?? '')
    if (dir === '') throw new Error('resume needs --job <dir>')
    const state = await resumeJob(dir, {
      repositoryRoot: REPOSITORY_ROOT,
      proxy: typeof values.get('proxy') === 'string' ? values.get('proxy') : undefined,
      publish: await publishOptions(values),
      version: typeof values.get('version') === 'string' ? values.get('version') : undefined,
      smoke: values.get('no-smoke') === true ? false : undefined,
      smokeRequired: values.get('require-smoke') === true,
      smokeChrome: typeof values.get('smoke-chrome') === 'string' ? values.get('smoke-chrome') : undefined,
      smokeStartTimeoutMs: numberArg(values, 'smoke-start-timeout'),
      smokePageTimeoutMs: numberArg(values, 'smoke-page-timeout'),
      ...speedOptions(values),
    })
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
    return
  }
  if (command === 'logs') {
    const dir = String(values.get('job') ?? '')
    if (dir === '') throw new Error('logs needs --job <dir>')
    const tail = await readLogTail(dir, Number(values.get('lines') ?? 80))
    process.stdout.write(`${tail.join('\n')}\n`)
    return
  }
  if (command === 'build' || command === 'plan') {
    const requestedStamp = typeof values.get('build-stamp') === 'string' ? values.get('build-stamp') : ''
    const buildStamp = requestedStamp !== ''
      ? requestedStamp
      : await nextBuildStamp({
          stateFile: defaultStampFile(),
          packagesDir: path.join(os.homedir(), '.dsh', 'packages'),
        })
    if (!isValidBuildStamp(buildStamp)) throw new Error(`invalid --build-stamp: ${buildStamp}`)
    const job = await createJob({
      root: typeof values.get('out') === 'string' ? values.get('out') : defaultJobRoot(),
      source,
      ref,
      targets,
      buildStamp,
    })
    const prepareCommand = commandArg(values.get('prepare'))
    const state = await runJob(job.dir, {
      repositoryRoot: REPOSITORY_ROOT,
      proxy: typeof values.get('proxy') === 'string' ? values.get('proxy') : undefined,
      publish: await publishOptions(values),
      planOnly: command === 'plan',
      full: values.get('web-only') === true ? false : undefined,
      prebuild: values.get('no-prebuild') === true ? false : undefined,
      prepare: prepareCommand === undefined ? undefined : [prepareCommand],
      onLog: values.get('stream') === true ? line => process.stdout.write(`${line}\n`) : undefined,
      install: values.get('no-install') === true ? null : undefined,
      build: commandArg(values.get('build-command')),
      version: typeof values.get('version') === 'string' ? values.get('version') : undefined,
      buildStamp,
      smoke: values.get('no-smoke') === true ? false : undefined,
      smokeRequired: values.get('require-smoke') === true,
      smokeChrome: typeof values.get('smoke-chrome') === 'string' ? values.get('smoke-chrome') : undefined,
      smokeStartTimeoutMs: numberArg(values, 'smoke-start-timeout'),
      smokePageTimeoutMs: numberArg(values, 'smoke-page-timeout'),
      ...speedOptions(values),
    })
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
    return
  }
  process.stderr.write([
    'usage: node code/build/cli.mjs <command> [options]',
    '',
    'commands:',
    '  build   prepare, apply overlays, build the web app, package targets',
    '  plan    prepare and apply overlays only; write a work order on mismatch',
    '  status  print one job state',
    '  logs    print one job log tail',
    '  learn   turn the corrected worktree of a job into new overlays',
    '  resume  continue a job from its existing worktree',
    '',
    'options:',
    '  --source <url|dir>       default: build/recipes.json source',
    '  --ref <branch|tag|sha>   default: master',
    '  --targets <list>         default: linux-x64,win-x64',
    '  --out <dir>              job root (default: ~/.dsh/mesh/build)',
    '  --proxy <url>            send downloads and npm through an HTTP proxy',
    '  --release-config <file>  release tokens/config (default: ~/.dsh/mesh/release.json)',
    '  --no-publish             build only; do not upload to GitHub/Gitee releases',
    '  --web-only               package the web payload without app/node/runtime',
    '  --no-install             skip pnpm install',
    '  --no-prebuild            skip the workspace tsdown prebuild',
    '  --prepare <cmd>          run one command before the web build',
    '  --stream                 mirror the build log to stdout',
    '  --build-command <cmd>    override the web build command',
    '  --version <version>      package version override',
    '  --build-stamp <stamp>    daily build stamp, default YYYYMMDD + next letter',
    '  --no-smoke               skip the headless-Chrome package smoke test',
    '  --require-smoke           fail when Chrome is missing (no verified target also fails)',
    '  --smoke-chrome <path>    Chrome/Chromium/Edge used by the smoke test',
    '  --smoke-start-timeout <ms>  DSH startup budget (default 180000)',
    '  --smoke-page-timeout <ms>   browser boot budget (default 180000)',
    '  --concurrency <n>        targets packaged in parallel (default: auto by CPU/memory)',
    '  --archive-threads <n>    gzip/7z worker threads (default: CPU count, max 8)',
    '  --archive-format <fmt>   7z (default), legacy (tar.gz on Linux / zip on Windows), tar.gz, zip',
    '  --no-cache               do not reuse the built web shell or the app tree',
    '  --refresh-app-cache      re-run npm install for the target app instead of cloning the cache',
    '  --refresh-web-cache      rebuild the web shell even when the cache matches',
    '',
  ].join('\n'))
  process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
