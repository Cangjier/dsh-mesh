import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_BUILD_TARGETS,
  canBuildOn,
  canProxyThrough,
  isForeignMember,
  pickBuildMember,
  pickProxyMember,
} from '../src/lib/build-defaults.mjs'

const GiB = 1024 ** 3

/** One member row shaped like the discovery snapshot. */
function member(id, options = {}) {
  return {
    id,
    name: options.name ?? id,
    online: options.online ?? true,
    dsh: options.dsh ?? true,
    latencyMs: options.latencyMs ?? 10,
    countryCode: options.countryCode ?? '',
    tag: options.tag ?? null,
    system: {
      platform: options.platform ?? 'linux',
      cpu: { cores: options.cores ?? 2, usagePercent: options.usage ?? 5 },
      memory: { totalBytes: (options.gib ?? 4) * GiB },
    },
  }
}

test('the panel builds both platforms by default', () => {
  assert.deepEqual([...DEFAULT_BUILD_TARGETS], ['linux-x64', 'win-x64'])
})

test('the richest online build member wins, local included', () => {
  const local = member('local', { name: 'gateway', cores: 4, gib: 8 })
  const windows = member('10.66.66.4', { name: 'DESKTOP', platform: 'win32', cores: 16, gib: 32, countryCode: 'CN' })
  const small = member('10.66.66.2', { name: 'VM', cores: 2, gib: 4, countryCode: 'US' })
  assert.equal(pickBuildMember([local, windows, small]), '10.66.66.4')
})

test('memory breaks a CPU-core tie and offline members never win', () => {
  const local = member('local', { cores: 8, gib: 8 })
  const biggerMemory = member('a', { cores: 8, gib: 32 })
  const offline = member('b', { cores: 32, gib: 128, online: false })
  assert.equal(pickBuildMember([local, biggerMemory, offline]), 'a')
  assert.equal(canBuildOn(offline), false)
})

test('a machine with unknown resources does not beat the local row', () => {
  const local = member('local', { cores: 4, gib: 8 })
  const unknown = { id: 'peer', name: 'new', online: true, dsh: false, system: null }
  assert.equal(pickBuildMember([unknown, local]), 'local')
  assert.equal(pickBuildMember([]), 'local')
})

test('the default proxy is a foreign Linux member, never local or Windows', () => {
  const local = member('local', { cores: 32, gib: 128, countryCode: 'CN' })
  const cn = member('10.66.66.3', { name: 'ecs', countryCode: 'CN' })
  const foreignWindows = member('10.66.66.4', { name: 'DESKTOP', platform: 'win32', countryCode: 'US' })
  const foreignLinux = member('10.66.66.2', { name: 'VM', countryCode: 'US', latencyMs: 30 })
  const members = [local, cn, foreignWindows, foreignLinux]
  assert.equal(pickProxyMember(members), '10.66.66.2')
  assert.equal(canProxyThrough(local), false)
  assert.equal(canProxyThrough(foreignWindows), false)
})

test('the lowest-latency foreign member is picked, then the bigger one', () => {
  const slow = member('slow', { countryCode: 'US', latencyMs: 120 })
  const fast = member('fast', { countryCode: 'JP', latencyMs: 20 })
  const fastSmall = member('fast-small', { countryCode: 'JP', latencyMs: 20, cores: 2, gib: 2 })
  assert.equal(pickProxyMember([slow, fast]), 'fast')
  assert.equal(pickProxyMember([fastSmall, fast]), 'fast')
})

test('country lookup failure falls back to an explicit tag; otherwise no proxy', () => {
  const tagged = member('tagged', { countryCode: '', tag: '海外' })
  const plain = member('plain', { countryCode: '' })
  assert.equal(isForeignMember(tagged), true)
  assert.equal(isForeignMember(plain), false)
  assert.equal(pickProxyMember([tagged]), 'tagged')
  assert.equal(pickProxyMember([plain]), null)
  assert.equal(pickProxyMember([]), null)
  // 「可访问外网」 is the operator's explicit hint when geolocation is missing.
  const external = member('external', { countryCode: '', tag: '可访问外网' })
  assert.equal(isForeignMember(external), true)
  assert.equal(pickProxyMember([external]), 'external')
})

test('a country code is authoritative over a tag', () => {
  const taggedButCn = member('x', { countryCode: 'CN', tag: '海外' })
  const codeFromTag = member('y', { countryCode: 'us' })
  assert.equal(isForeignMember(taggedButCn), false)
  assert.equal(isForeignMember(codeFromTag), true)
})
