#!/usr/bin/env node
/**
 * Independent DSH Web service.
 *
 * This process owns `dsh web` (a loopback-only listener). It writes the launch
 * URL/token to data/dsh-web.json, which the separate gateway service watches.
 * The gateway never spawns DSH, so restarting either service does not restart
 * the other.
 *
 * Runs under the packaged Node runtime; DSH_HOME/DSH_WORKDIR come from
 * config/gate.env so it reads the same profile and data as the gateway.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const DATA = path.join(ROOT, 'data')
const TOKEN_FILE = path.join(DATA, 'dsh-web.json')
const LOG_FILE = path.join(DATA, 'dsh-service.log')
const DSH_ENTRY = path.join(ROOT, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const PATCH_FILE = path.join(ROOT, 'config', 'browse-picker.patch.yml')
const ENV_FILE = path.join(ROOT, 'config', 'gate.env')

mkdirSync(DATA, { recursive: true })

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`
  try { writeFileSync(LOG_FILE, `${text}\n`, { encoding: 'utf8', flag: 'a' }) } catch { }
  console.log(text)
}

function readEnvFile(file) {
  const values = {}
  if (!existsSync(file)) return values
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return values
}

const envFile = readEnvFile(ENV_FILE)
const dshHome = process.env.DSH_HOME || envFile.DSH_HOME || path.join(DATA, 'home')
const workdir = process.env.DSH_WORKDIR || envFile.DSH_WORKDIR || path.join(ROOT, 'workspace')
const agentsHome = process.env.DSH_AGENTS_HOME || envFile.DSH_AGENTS_HOME || path.join(DATA, 'agents')
const heapMb = Number.parseInt(process.env.DSH_WEB_HEAP_MB || envFile.DSH_WEB_HEAP_MB || '0', 10)
mkdirSync(workdir, { recursive: true })
mkdirSync(dshHome, { recursive: true })

function trustedAuthorities() {
  const values = new Set(['localhost', '127.0.0.1', '[::1]', os.hostname()])
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal) continue
      values.add(address.family === 'IPv6' ? `[${address.address}]` : address.address)
    }
  }
  const extra = process.env.DSH_TRUSTED_HOSTS || envFile.DSH_TRUSTED_HOSTS || ''
  for (const value of extra.split(',').map(item => item.trim()).filter(Boolean)) values.add(value)
  return [...values]
}

let stopping = false
let child = null
let restartTimer = null
let restartDelayMs = 2_000

function removeToken() {
  try { rmSync(TOKEN_FILE, { force: true }) } catch { }
}

function writeToken(launchUrl) {
  const url = new URL(launchUrl)
  const token = url.searchParams.get('token') ?? ''
  const port = Number.parseInt(url.port || '80', 10)
  const payload = {
    pid: child?.pid ?? null,
    port,
    token,
    launchUrl,
    startedAt: new Date().toISOString(),
  }
  const temporary = `${TOKEN_FILE}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, TOKEN_FILE)
  log(`dsh web ready on 127.0.0.1:${String(port)}; token file written`)
}

function startChild() {
  if (stopping) return
  if (!existsSync(DSH_ENTRY)) {
    log(`missing ${DSH_ENTRY}`)
    scheduleRestart()
    return
  }
  const args = []
  if (existsSync(PATCH_FILE)) args.push('--patch', PATCH_FILE)
  args.push('--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0')
  for (const authority of trustedAuthorities()) args.push('--trusted-host', authority)
  const env = {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_AGENTS_HOME: agentsHome,
  }
  if (Number.isSafeInteger(heapMb) && heapMb > 0) {
    env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=${String(heapMb)}`.trim()
  }
  log(`spawning dsh web (workdir ${workdir}, home ${dshHome})`)
  child = spawn(process.execPath, [DSH_ENTRY, ...args], {
    cwd: workdir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const timer = setTimeout(() => {
    if (!stopping && !existsSync(TOKEN_FILE)) log('dsh web has not printed a launch URL yet')
  }, 180_000)
  timer.unref?.()
  let buffered = ''
  const consume = chunk => {
    const text = String(chunk)
    buffered = (buffered + text).slice(-64_000)
    process.stdout.write(text)
    const match = /dsh web: (https?:\/\/\S+)/u.exec(buffered)
    if (match?.[1] !== undefined) {
      if (!existsSync(TOKEN_FILE)) writeToken(match[1])
    }
  }
  child.stdout.on('data', consume)
  child.stderr.on('data', consume)
  child.once('error', error => {
    log(`dsh web spawn failed: ${error.message}`)
    scheduleRestart()
  })
  child.once('exit', (code, signal) => {
    clearTimeout(timer)
    log(`dsh web exited (${signal ?? String(code)})`)
    child = null
    removeToken()
    scheduleRestart()
  })
}

function scheduleRestart() {
  if (stopping || restartTimer !== null) return
  log(`restarting dsh web in ${String(restartDelayMs)}ms`)
  restartTimer = setTimeout(() => {
    restartTimer = null
    restartDelayMs = Math.min(restartDelayMs * 2, 30_000)
    startChild()
  }, restartDelayMs)
}

async function shutdown(signal) {
  if (stopping) return
  stopping = true
  log(`${signal}; stopping dsh web`)
  if (restartTimer !== null) clearTimeout(restartTimer)
  if (child && !child.killed) {
    child.kill('SIGTERM')
    await new Promise(resolve => {
      const timer = setTimeout(() => { try { child?.kill('SIGKILL') } catch { } resolve() }, 8_000)
      child?.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
  removeToken()
  process.exit(0)
}

process.once('SIGTERM', () => { void shutdown('SIGTERM') })
process.once('SIGINT', () => { void shutdown('SIGINT') })

removeToken()
startChild()
