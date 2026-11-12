#!/usr/bin/env node
/**
 * Shell entry for one blue-green deployment.
 *
 * The panel button and the `deploy` tool call `MeshService` in-process, so their
 * jobs already land in `$DSH_HOME/mesh/deploy/<id>/`. A deployment started from
 * a terminal must land there too, otherwise the panel shows nothing while it
 * runs — the job directory is the one place every window reads.
 *
 *   node code/deploy/cli.mjs --host 10.66.66.2 --package dsh-mesh-0.2.2-linux-x64.tar.gz
 *   node code/deploy/cli.mjs --host 10.66.66.4 --package dsh-mesh-win-x64.zip --no-wait
 *
 * @module @local/dsh-mesh/deploy-cli
 */

import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeployManager } from './engine.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Everything before the first flag is ignored so `npm run deploy -- …` works. */
function argumentList(argv) {
  const args = []
  let passthrough = false
  for (const item of argv) {
    if (passthrough) { args.push(item); continue }
    if (item === '--') { passthrough = true; continue }
    args.push(item)
  }
  return args
}

function parseArgs(argv) {
  const options = { wait: true }
  const args = argumentList(argv)
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]
    if (!item.startsWith('--')) continue
    const eq = item.indexOf('=')
    const key = eq === -1 ? item.slice(2) : item.slice(2, eq)
    const inline = eq === -1 ? undefined : item.slice(eq + 1)
    const next = inline ?? (args[index + 1]?.startsWith('--') === false ? args[++index] : '')
    switch (key) {
      case 'host': options.host = next; break
      case 'member': options.member = next; break
      case 'package': options.package = next; break
      case 'os': options.os = next; break
      case 'app-root': options.appRoot = next; break
      case 'data-dir': options.dataDir = next; break
      case 'lines': options.lines = Number.parseInt(next, 10); break
      case 'wait': options.wait = next !== 'false' && next !== '0'; break
      case 'no-wait': options.wait = false; break
      case 'json': options.json = true; break
      case 'help': options.help = true; break
      default: throw new Error(`unknown option: --${key}`)
    }
  }
  return options
}

/** `$DSH_HOME/mesh/deploy` — the same directory the plugin's service writes. */
function defaultDataDir() {
  const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : path.join(homedir(), '.dsh')
  return path.join(home, 'mesh', 'deploy')
}

/** Accept an absolute path, a `~/.dsh/packages` name, or a `dist/` name. */
function resolvePackage(input) {
  const raw = String(input ?? '').trim()
  if (raw === '') throw new Error('--package is required')
  const candidates = path.isAbsolute(raw)
    ? [raw]
    : [
      raw,
      path.join(homedir(), '.dsh', 'packages', raw),
      path.join(repositoryRoot, 'dist', raw),
      path.join(repositoryRoot, 'build', 'output', raw),
    ]
  for (const file of candidates) {
    if (existsSync(file) && statSync(file).isFile()) return path.resolve(file)
  }
  throw new Error(`package not found: ${raw}`)
}

function usage() {
  return [
    'usage: node code/deploy/cli.mjs --host <member|ip> --package <file>',
    '',
    '  --host      member id, name, VPN address, or plain SSH host',
    '  --package   absolute path, a ~/.dsh/packages name, or a dist/ name',
    '  --os        linux | windows (inferred from the package name otherwise)',
    '  --app-root  install root; defaults to the package platform',
    '  --data-dir  job directory; defaults to $DSH_HOME/mesh/deploy',
    '  --no-wait   start the job and return its id immediately',
    '  --json      print the final job as JSON',
  ].join('\n')
}

function meterLine(job) {
  const progress = job.progress ?? {}
  const label = typeof progress.label === 'string' && progress.label !== '' ? progress.label : ''
  const percent = Number.isFinite(progress.percent) ? progress.percent : 0
  const parts = []
  if (progress.totalBytes > 0) parts.push(`${Math.round(progress.bytes / 1048576)}/${Math.round(progress.totalBytes / 1048576)} MiB`)
  if (progress.total > 0) parts.push(`${progress.done}/${progress.total} 项`)
  return `${label}${label === '' ? '' : ' '}${percent}%${parts.length === 0 ? '' : ` (${parts.join(' · ')})`}`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }
  if (typeof options.host !== 'string' || options.host.trim() === '') throw new Error('--host is required')
  const file = resolvePackage(options.package)
  const dataDir = typeof options.dataDir === 'string' && options.dataDir !== '' ? path.resolve(options.dataDir) : defaultDataDir()
  const manager = new DeployManager({
    repositoryRoot,
    dataDir,
    // Progress goes to stderr so `--json` stays parseable on stdout.
    log: line => process.stderr.write(`${line}\n`),
  })
  const started = await manager.start({
    host: options.host,
    ...(typeof options.member === 'string' && options.member !== '' ? { member: options.member } : {}),
    package: file,
    ...(typeof options.os === 'string' && options.os !== '' ? { os: options.os } : {}),
    ...(typeof options.appRoot === 'string' && options.appRoot !== '' ? { appRoot: options.appRoot } : {}),
  })
  const id = started.job.id
  process.stderr.write(`job ${id} · ${dataDir}\n`)
  if (options.wait === false) {
    process.stdout.write(`${id}\n`)
    return 0
  }
  let last = ''
  let settled = await manager.status(id)
  while (settled !== null && settled.status === 'running') {
    const line = meterLine(settled)
    if (line !== last) {
      last = line
      process.stderr.write(`\r${line.padEnd(60)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 1500))
    settled = await manager.status(id)
  }
  if (last !== '') process.stderr.write('\n')
  const job = settled ?? started.job
  const lines = await manager.logs(id, Number.isSafeInteger(options.lines) ? options.lines : 40)
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify({ job, log: lines, logFile: path.join(dataDir, id, 'deploy.log') }, null, 2)}\n`)
  } else {
    process.stdout.write(`${job.status ?? 'unknown'} · ${job.release ?? ''} · ${job.error ?? 'ok'}\n`)
    process.stdout.write(`log ${path.join(dataDir, id, 'deploy.log')}\n`)
    if (lines.trim() !== '') process.stdout.write(`${lines.trimEnd()}\n`)
  }
  return job.status === 'succeeded' ? 0 : 1
}

main().then(code => process.exit(code)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(2)
})
