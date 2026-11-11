/**
 * Standalone CLI for the deterministic build engine.
 *
 * The plugin tool uses the same functions from `job.mjs`; this entry exists so
 * a human (or a work order) can run and inspect a build without DSH.
 *
 * @module dsh-mesh/build/cli
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createJob,
  defaultJobRoot,
  readLogTail,
  readState,
  runJob,
} from './job.mjs'

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
  if (command === 'logs') {
    const dir = String(values.get('job') ?? '')
    if (dir === '') throw new Error('logs needs --job <dir>')
    const tail = await readLogTail(dir, Number(values.get('lines') ?? 80))
    process.stdout.write(`${tail.join('\n')}\n`)
    return
  }
  if (command === 'build' || command === 'plan') {
    const job = await createJob({
      root: typeof values.get('out') === 'string' ? values.get('out') : defaultJobRoot(),
      source,
      ref,
      targets,
    })
    const state = await runJob(job.dir, {
      repositoryRoot: REPOSITORY_ROOT,
      planOnly: command === 'plan',
      full: values.get('web-only') === true ? false : undefined,
      install: values.get('no-install') === true ? null : undefined,
      build: commandArg(values.get('build-command')),
      version: typeof values.get('version') === 'string' ? values.get('version') : undefined,
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
    '',
    'options:',
    '  --source <url|dir>       default: build/recipes.json source',
    '  --ref <branch|tag|sha>   default: master',
    '  --targets <list>         default: linux-x64,win-x64',
    '  --out <dir>              job root (default: ~/.dsh/mesh/build)',
    '  --web-only               package the web payload without app/node/runtime',
    '  --no-install             skip pnpm install',
    '  --build-command <cmd>    override the web build command',
    '  --version <version>      package version override',
    '',
  ].join('\n'))
  process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
