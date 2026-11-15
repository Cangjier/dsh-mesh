#!/usr/bin/env node
/**
 * Command-line entry point for the headless-Chrome smoke test.
 *
 *   # a freshly assembled package (the build pipeline does this in-process)
 *   node code/build/smoke-cli.mjs --root dist/dsh-mesh-0.2.2-rc.3-20261115A-linux-x64 \
 *        --target linux-x64 --screenshot-dir smoke/linux-x64
 *
 *   # an already-upgraded sandbox (the test-upgrade rehearsal)
 *   node code/build/smoke-cli.mjs --install --root /path/to/sandbox \
 *        --port 18081 --home /path/to/sandbox-home \
 *        --screenshot-dir /var/tmp/rehearsal-shots
 *
 * Exit codes: 0 passed, 1 failed, 3 skipped (for example no Chrome).
 *
 * @module dsh-mesh/build/smoke-cli
 */

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { runInstallSmoke, runPackageSmoke } from './smoke.mjs'

/**
 * Parse `--flag value` and `--flag` arguments.
 * @param {string[]} argv arguments.
 * @returns {{values: Map<string, string|true>, positionals: string[]}} parsed.
 */
function parseArgs(argv) {
  const values = new Map()
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      positionals.push(arg)
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
  return { values, positionals }
}

/**
 * Read a string argument.
 * @param {Map<string, string|true>} values arguments.
 * @param {string} name flag.
 * @returns {string|undefined} value.
 */
function text(values, name) {
  const value = values.get(name)
  return typeof value === 'string' && value !== '' ? value : undefined
}

async function main() {
  const { values } = parseArgs(process.argv.slice(2))
  const root = text(values, 'root')
  if (root === undefined) {
    process.stderr.write('usage: smoke-cli.mjs --root <package-or-install> [--install] [--target linux-x64]\n')
    process.exit(2)
  }
  const install = values.get('install') === true
  const screenshotDirValue = text(values, 'screenshot-dir')
  const screenshotDir = screenshotDirValue === undefined
    ? path.resolve(process.cwd(), 'smoke')
    : path.resolve(screenshotDirValue)
  const workDir = path.join(screenshotDir, '.work')
  await mkdir(workDir, { recursive: true })
  const log = values.get('quiet') === true
    ? undefined
    : line => process.stderr.write(`[smoke] ${line}\n`)
  const common = {
    root: path.resolve(root),
    target: text(values, 'target'),
    chrome: text(values, 'chrome') ?? (values.get('no-chrome') === true ? null : undefined),
    port: text(values, 'port') === undefined ? undefined : Number(text(values, 'port')),
    home: text(values, 'home') === undefined ? undefined : path.resolve(text(values, 'home')),
    workdir: text(values, 'workdir') === undefined ? undefined : path.resolve(text(values, 'workdir')),
    workDir,
    screenshotDir,
    keep: values.get('keep') === true,
    required: values.get('require') === true,
    log,
  }
  const result = install
    ? await runInstallSmoke(common)
    : await runPackageSmoke({
        ...common,
        packageRoot: common.root,
      })
  if (values.get('json') === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`smoke ${result.status}${result.target === undefined ? '' : ` (${result.target})`}\n`)
    for (const check of result.checks ?? []) {
      process.stdout.write(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}\n`)
    }
    for (const screenshot of result.screenshots ?? []) {
      process.stdout.write(`  screenshot: ${screenshot}\n`)
    }
    if (result.reason !== undefined) process.stdout.write(`  reason: ${result.reason}\n`)
    if (result.error !== undefined) process.stdout.write(`  error: ${result.error}\n`)
  }
  if (result.status === 'failed') process.exit(1)
  if (result.status === 'skipped') process.exit(3)
}

await main()
