import assert from 'node:assert/strict'
import test from 'node:test'
import { collectSystemInfo } from '../code/shared/system-info.mjs'

test('system inventory reports CPU, memory and disk facts', async () => {
  const info = await collectSystemInfo({ sampleMs: 50 })
  assert.equal(typeof info.hostname, 'string')
  assert.equal(info.platform, process.platform)
  assert.equal(info.arch, process.arch)
  assert.ok(info.cpu.cores >= 1)
  assert.ok(info.cpu.usagePercent >= 0 && info.cpu.usagePercent <= 100)
  assert.ok(info.memory.totalBytes > 0)
  assert.ok(info.memory.usedBytes >= 0)
  assert.ok(info.memory.usedPercent >= 0 && info.memory.usedPercent <= 100)
  assert.ok(Array.isArray(info.disks))
  for (const disk of info.disks) {
    assert.equal(typeof disk.mount, 'string')
    assert.ok(disk.totalBytes > 0)
    assert.ok(disk.usedBytes >= 0)
    assert.ok(disk.usedPercent >= 0 && disk.usedPercent <= 100)
  }
  assert.ok(Array.isArray(info.network))
  assert.equal(typeof info.sampledAt, 'string')
})
