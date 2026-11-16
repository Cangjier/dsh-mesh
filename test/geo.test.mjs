import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  GeoLookup,
  endpointAddress,
  isForeignCountry,
  isPrivateAddress,
} from '../code/shared/geo.mjs'
import { normalizePeer } from '../code/shared/wireguard.mjs'

test('endpointAddress accepts IPv4:port and bracketed IPv6:port', () => {
  assert.equal(endpointAddress('36.213.175.106:57917'), '36.213.175.106')
  assert.equal(endpointAddress('[240d:c000:f07f:4100:b6c6:45be:ece6:0]:37590'), '240d:c000:f07f:4100:b6c6:45be:ece6:0')
  assert.equal(endpointAddress('[2409:8c85:2021:bd23:6bc4:2d4a:fd28:4143]:43094'), '2409:8c85:2021:bd23:6bc4:2d4a:fd28:4143')
  assert.equal(endpointAddress('8.8.8.8'), '8.8.8.8')
  assert.equal(endpointAddress('wireguard.example:51820'), '')
  assert.equal(endpointAddress(''), '')
  assert.equal(endpointAddress(null), '')
})

test('normalizePeer keeps the public endpoint for the country lookup', () => {
  const peer = normalizePeer({
    name: 'VM-0-2-ubuntu',
    ip: '10.66.66.2',
    endpoint: '[240d:c000:f07f:4100:b6c6:45be:ece6:0]:37590',
  })
  assert.equal(peer.endpoint, '[240d:c000:f07f:4100:b6c6:45be:ece6:0]:37590')
  assert.equal(peer.publicIp, '240d:c000:f07f:4100:b6c6:45be:ece6:0')
  assert.equal(normalizePeer({ name: 'host-only', ip: '10.66.66.3' }).publicIp, '')
})

test('private and foreign helpers cover the ranges that matter', () => {
  for (const address of ['127.0.0.1', '10.66.66.2', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateAddress(address), true, address)
  }
  for (const address of ['8.8.8.8', '43.172.94.59', '2001:4860:4860::8888']) {
    assert.equal(isPrivateAddress(address), false, address)
  }
  assert.equal(isForeignCountry('CN'), false)
  assert.equal(isForeignCountry('cn'), false)
  assert.equal(isForeignCountry('US'), true)
  assert.equal(isForeignCountry('HK'), true)
  assert.equal(isForeignCountry(''), false)
})

test('country lookups are cached and shared for the same address', async () => {
  const calls = []
  const geo = new GeoLookup({
    cacheFile: null,
    fetchImpl: async url => {
      calls.push(String(url))
      return {
        ok: true,
        json: async () => ({ success: true, country_code: 'US', country: 'United States' }),
      }
    },
  })
  const first = await geo.country('43.172.94.59')
  const second = await geo.country('43.172.94.59')
  assert.deepEqual(first, { countryCode: 'US', country: 'United States' })
  assert.deepEqual(second, first)
  assert.equal(calls.length, 1)
  assert.match(calls[0], /43\.172\.94\.59/u)
  assert.ok(calls[0].startsWith('https://ipwho.is/'))
})

test('a failed lookup is negative-cached and private addresses are never sent', async () => {
  let calls = 0
  let now = 1_000
  const geo = new GeoLookup({
    cacheFile: null,
    failureTtlMs: 60_000,
    now: () => now,
    fetchImpl: async () => {
      calls += 1
      throw new Error('offline')
    },
  })
  assert.equal(await geo.country('10.66.66.2'), null)
  assert.equal(calls, 0)
  assert.equal(await geo.country('8.8.8.8'), null)
  assert.equal(await geo.country('8.8.8.8'), null)
  assert.equal(calls, 1)
  now += 61_000
  assert.equal(await geo.country('8.8.8.8'), null)
  assert.equal(calls, 2)
})

test('enrichment attaches the country to every member with a public endpoint', async () => {
  const geo = new GeoLookup({
    cacheFile: null,
    fetchImpl: async url => {
      const ip = decodeURIComponent(String(url).match(/ipwho\.is\/([^?]+)/u)?.[1] ?? '')
      return {
        ok: true,
        json: async () => ({
          success: true,
          country_code: ip === '36.213.175.106' ? 'CN' : 'US',
          country: ip === '36.213.175.106' ? 'China' : 'United States',
        }),
      }
    },
  })
  const members = [
    { id: '10.66.66.4', publicIp: '36.213.175.106' },
    { id: '10.66.66.2', publicIp: '43.172.94.59' },
    { id: 'local', publicIp: '' },
  ]
  await geo.enrich(members)
  assert.equal(members[0].countryCode, 'CN')
  assert.equal(members[1].countryCode, 'US')
  assert.equal(members[2].countryCode, undefined)
})

test('the cache survives a restart on disk', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-geo-'))
  const cacheFile = path.join(dir, 'geo.json')
  const first = new GeoLookup({
    cacheFile,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ success: true, country_code: 'US', country: 'United States' }),
    }),
  })
  try {
    assert.equal((await first.country('43.172.94.59'))?.countryCode, 'US')
    await first.flush()
    assert.match(await readFile(cacheFile, 'utf8'), /43\.172\.94\.59/u)
    let calls = 0
    const second = new GeoLookup({
      cacheFile,
      fetchImpl: async () => {
        calls += 1
        return { ok: false, json: async () => ({}) }
      },
    })
    assert.equal((await second.country('43.172.94.59'))?.countryCode, 'US')
    assert.equal(calls, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
