/**
 * Host inventory for the member interop HTTP service.
 *
 * All values are read from Node's OS APIs; disk usage uses `statfs` per
 * filesystem/mount. CPU utilisation is sampled over a short window so a single
 * HTTP call returns a meaningful percentage instead of a lifetime average.
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statfsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const PSEUDO_FILESYSTEMS = new Set([
  'proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'cgroup', 'cgroup2',
  'pstore', 'securityfs', 'debugfs', 'tracefs', 'configfs', 'fusectl',
  'mqueue', 'hugetlbfs', 'rpc_pipefs', 'autofs', 'binfmt_misc', 'nsfs',
  'squashfs', 'ramfs',
])

function round(value, digits = 1) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function safeNumber(value) {
  return Number.isFinite(value) ? value : 0
}

/**
 * Decode the octal escapes the kernel uses in /proc/mounts.
 * @param {string} text raw mount field.
 * @returns {string} decoded path.
 */
function decodeMount(text) {
  return text.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)))
}

function diskEntry(mount, fs = '', type = '') {
  try {
    const stats = statfsSync(mount)
    const blockSize = safeNumber(stats.bsize)
    const total = blockSize * safeNumber(stats.blocks)
    const free = blockSize * safeNumber(stats.bfree)
    const available = blockSize * safeNumber(stats.bavail)
    if (total <= 0) return null
    return {
      mount,
      fs,
      type,
      totalBytes: total,
      freeBytes: free,
      availableBytes: available,
      usedBytes: Math.max(0, total - free),
      usedPercent: total === 0 ? 0 : round(((total - free) / total) * 100, 1),
    }
  } catch {
    return null
  }
}

async function linuxDisks() {
  const mounts = []
  try {
    const text = readFileSync('/proc/mounts', 'utf8')
    for (const raw of text.split('\n')) {
      if (raw.trim() === '') continue
      const [device, mountRaw, type] = raw.split(' ')
      if (device === undefined || mountRaw === undefined || type === undefined) continue
      if (PSEUDO_FILESYSTEMS.has(type)) continue
      const mount = decodeMount(mountRaw)
      if (!mount.startsWith('/')) continue
      if (mounts.some(item => item.mount === mount)) continue
      mounts.push({ mount, type })
    }
  } catch { }
  if (!mounts.some(item => item.mount === '/')) mounts.unshift({ mount: '/', type: '' })
  return mounts.map(item => diskEntry(item.mount, '', item.type)).filter(Boolean)
}

function windowsDisks() {
  const result = []
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`
    if (!existsSync(root)) continue
    const entry = diskEntry(root, '', '')
    if (entry !== null) result.push(entry)
  }
  return result
}

async function posixDisks() {
  try {
    const { stdout } = await execFileAsync('df', ['-P', '-k'], { timeout: 5_000 })
    const result = []
    const lines = stdout.trim().split('\n').slice(1)
    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 6) continue
      const mount = parts[5]
      if (!mount.startsWith('/')) continue
      const entry = diskEntry(mount, parts[0], '')
      if (entry !== null) result.push(entry)
    }
    return result
  } catch {
    return []
  }
}

async function collectDisks() {
  if (process.platform === 'win32') return windowsDisks()
  if (process.platform === 'linux') {
    const linux = await linuxDisks()
    if (linux.length > 0) return linux
  }
  return posixDisks()
}

function cpuSnapshot() {
  return os.cpus().map(cpu => ({ ...cpu.times }))
}

function cpuUsage(before, after) {
  let idleDelta = 0
  let userDelta = 0
  let systemDelta = 0
  let totalDelta = 0
  for (let index = 0; index < Math.min(before.length, after.length); index += 1) {
    const a = before[index]
    const b = after[index]
    const user = (b.user - a.user) + (b.nice - a.nice)
    const system = (b.sys - a.sys) + (b.irq - a.irq)
    const idle = b.idle - a.idle
    userDelta += user
    systemDelta += system
    idleDelta += idle
    totalDelta += user + system + idle
  }
  if (totalDelta <= 0) return { usagePercent: 0, idlePercent: 100, userPercent: 0, systemPercent: 0 }
  const idlePercent = (idleDelta / totalDelta) * 100
  return {
    usagePercent: round(100 - idlePercent, 1),
    idlePercent: round(idlePercent, 1),
    userPercent: round((userDelta / totalDelta) * 100, 1),
    systemPercent: round((systemDelta / totalDelta) * 100, 1),
  }
}

function networkInfo() {
  const result = []
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      result.push({
        name,
        address: address.address,
        family: address.family,
        internal: address.internal,
        mac: address.mac,
        cidr: address.cidr ?? null,
      })
    }
  }
  return result
}

/**
 * Fast CPU/memory/root-disk snapshot for member discovery. It never enumerates
 * every mount or samples CPU, so it cannot stall a member probe.
 * @returns {object} system summary.
 */
export function quickSystemInfo() {
  const cpus = os.cpus()
  const total = os.totalmem()
  const free = os.freemem()
  const used = Math.max(0, total - free)
  let cpuTotal = 0
  let cpuIdle = 0
  for (const cpu of cpus) {
    const times = cpu.times
    cpuTotal += times.user + times.nice + times.sys + times.irq + times.idle
    cpuIdle += times.idle
  }
  const cpuUsage = cpuTotal === 0 ? 0 : round((1 - cpuIdle / cpuTotal) * 100, 1)
  const root = process.platform === 'win32'
    ? `${(process.env.SystemDrive ?? 'C:').replace(/\\$/u, '')}\\`
    : '/'
  const disks = []
  try {
    const stats = statfsSync(root)
    const blockSize = safeNumber(stats.bsize)
    const totalBytes = blockSize * safeNumber(stats.blocks)
    const freeBytes = blockSize * safeNumber(stats.bfree)
    if (totalBytes > 0) {
      disks.push({
        mount: root,
        totalBytes,
        freeBytes,
        availableBytes: blockSize * safeNumber(stats.bavail),
        usedBytes: Math.max(0, totalBytes - freeBytes),
        usedPercent: round(((totalBytes - freeBytes) / totalBytes) * 100, 1),
      })
    }
  } catch { }
  return {
    sampledAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    cpu: { model: cpus[0]?.model ?? 'unknown', cores: cpus.length, usagePercent: cpuUsage },
    memory: {
      totalBytes: total,
      freeBytes: free,
      usedBytes: used,
      usedPercent: total === 0 ? 0 : round((used / total) * 100, 1),
    },
    disks,
  }
}

/**
 * Collect one host inventory snapshot.
 * @param {{sampleMs?: number}} [options] options.
 * @returns {Promise<object>} inventory.
 */
export async function collectSystemInfo(options = {}) {
  const requested = Number.isSafeInteger(options.sampleMs) ? options.sampleMs : 200
  const sampleMs = Math.max(50, Math.min(requested, 1000))
  const before = cpuSnapshot()
  const disksPromise = collectDisks()
  await new Promise(resolve => setTimeout(resolve, sampleMs))
  const after = cpuSnapshot()
  const cpuTimes = cpuUsage(before, after)
  const cpus = os.cpus()
  const totalMemory = os.totalmem()
  const freeMemory = os.freemem()
  const memoryUsed = Math.max(0, totalMemory - freeMemory)
  const load = os.loadavg()
  return {
    sampledAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    uptimeSeconds: Math.floor(os.uptime()),
    node: process.version,
    cpu: {
      model: cpus[0]?.model ?? 'unknown',
      cores: cpus.length,
      speedMHz: cpus[0]?.speed ?? 0,
      ...cpuTimes,
      loadAverage: load.map(value => round(value, 2)),
      sampleMs,
    },
    memory: {
      totalBytes: totalMemory,
      freeBytes: freeMemory,
      usedBytes: memoryUsed,
      usedPercent: totalMemory === 0 ? 0 : round((memoryUsed / totalMemory) * 100, 1),
    },
    disks: await disksPromise,
    network: networkInfo(),
    process: {
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      memory: process.memoryUsage(),
    },
  }
}
