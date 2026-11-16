/**
 * Where a member's public address is, as far as its WireGuard endpoint says.
 *
 * The build panel wants to borrow a member's internet for the downloads, and
 * the useful members are the ones whose public address is outside mainland
 * China. WireGuard already reports every peer's current public endpoint, so
 * this module turns that `host:port` (including bracketed IPv6) into a bare
 * address and asks a small geolocation service for its country.
 *
 * Lookups are cached for a month in memory and on disk: an address rarely
 * changes country, and a panel refresh must not hit a third party every time.
 * A failed lookup is cached briefly so an offline gateway does not pay the
 * timeout on every discovery either. Every caller degrades to "unknown" — the
 * build panel still works, it just cannot prefer a foreign proxy.
 *
 * @module @local/dsh-mesh/geo
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'

/** `{ip}` is replaced with the address to look up. */
export const DEFAULT_GEO_PROVIDER = 'https://ipwho.is/{ip}?fields=success,country,country_code'
/** A country lookup must never hold a member snapshot for long. */
const DEFAULT_TIMEOUT_MS = 2_500
/** Countries change rarely; an address changing country is even rarer. */
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60_000
/** A blocked third party must not be retried on every panel refresh. */
const DEFAULT_FAILURE_TTL_MS = 10 * 60_000

/**
 * Extract the bare address from a WireGuard endpoint.
 *
 * `state.json` stores endpoints as `1.2.3.4:51820` or `[2001:db8::1]:51820`.
 * A bare address and a bracketed IPv6 literal without a port are accepted too;
 * anything else (a hostname, a malformed value) yields an empty string rather
 * than a bogus geolocation query.
 * @param {unknown} endpoint endpoint text.
 * @returns {string} bare IP address, or ''.
 */
export function endpointAddress(endpoint) {
  if (typeof endpoint !== 'string') return ''
  const text = endpoint.trim()
  if (text === '') return ''
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end < 0) return ''
    const inner = text.slice(1, end)
    return isIP(inner) > 0 ? inner : ''
  }
  if (isIP(text) > 0) return text
  // Only IPv4 has an unambiguous `address:port` form without brackets.
  const colon = text.lastIndexOf(':')
  if (colon <= 0) return ''
  const host = text.slice(0, colon)
  return isIP(host) === 4 ? host : ''
}

/**
 * Whether an address is not routable on the public internet.
 *
 * Geolocation services return junk for private endpoints, so the lookup is
 * skipped for loopback, RFC1918, CGNAT, link-local, and other local ranges.
 * @param {string} address bare IP address.
 * @returns {boolean} true when the address is local or reserved.
 */
export function isPrivateAddress(address) {
  if (address === '127.0.0.1' || address === '::1' || address === '::') return true
  const lower = address.toLowerCase()
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true
  if (lower.startsWith('ff')) return true
  if (lower.startsWith('2001:db8:')) return true
  const parts = address.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map(part => Number(part))
  if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  if (octets[0] === 0 || octets[0] === 10 || octets[0] === 127) return true
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true
  if (octets[0] === 192 && octets[1] === 168) return true
  if (octets[0] === 169 && octets[1] === 254) return true
  if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true
  if (octets[0] >= 224) return true
  return false
}

/**
 * Whether a country code means "outside mainland China".
 *
 * This drives the default outbound proxy: the gateway and its operators are in
 * mainland China, so any other country is a better place to fetch GitHub and
 * the npm registry from. A missing code is deliberately not foreign.
 * @param {unknown} countryCode ISO 3166-1 alpha-2 code.
 * @returns {boolean} true when the country is not CN.
 */
export function isForeignCountry(countryCode) {
  const code = typeof countryCode === 'string' ? countryCode.trim().toUpperCase() : ''
  return /^[A-Z]{2}$/u.test(code) && code !== 'CN'
}

/**
 * One cached country lookup.
 */
export class GeoLookup {
  /**
   * @param {object} [options] lookup options.
   * @param {string|null} [options.cacheFile] JSON cache path; null disables persistence.
   * @param {string} [options.provider] URL template containing `{ip}`.
   * @param {typeof fetch} [options.fetchImpl] fetch implementation (tests).
   * @param {number} [options.timeoutMs] per-request budget.
   * @param {number} [options.ttlMs] successful lookup lifetime.
   * @param {number} [options.failureTtlMs] failed lookup lifetime.
   * @param {boolean} [options.enabled] false turns every lookup into a miss.
   * @param {() => number} [options.now] clock (tests).
   * @param {(line: string) => void} [options.log] logger.
   */
  constructor(options = {}) {
    this.enabled = options.enabled !== false
    this.cacheFile = typeof options.cacheFile === 'string' && options.cacheFile !== '' ? options.cacheFile : null
    this.provider = typeof options.provider === 'string' && options.provider.includes('{ip}')
      ? options.provider
      : DEFAULT_GEO_PROVIDER
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
    this.ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS
    this.failureTtlMs = Number.isFinite(options.failureTtlMs) && options.failureTtlMs > 0
      ? options.failureTtlMs
      : DEFAULT_FAILURE_TTL_MS
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.log = typeof options.log === 'function' ? options.log : () => {}
    /** @type {Map<string, {ok: boolean, countryCode: string, country: string, at: number}>} */
    this.cache = new Map()
    /** @type {Map<string, Promise<{countryCode: string, country: string}|null>>} */
    this.inflight = new Map()
    /** @type {Promise<void>|null} */
    this.loaded = null
    /** @type {Promise<void>} */
    this.saving = Promise.resolve()
  }

  /**
   * Country for one public address, from cache or the provider.
   * @param {unknown} ip bare IP address.
   * @returns {Promise<{countryCode: string, country: string}|null>} country or null.
   */
  async country(ip) {
    if (!this.enabled || typeof ip !== 'string') return null
    const address = ip.trim()
    if (isIP(address) === 0 || isPrivateAddress(address)) return null
    await this.#load()
    const cached = this.cache.get(address)
    if (cached !== undefined) {
      const ttl = cached.ok ? this.ttlMs : this.failureTtlMs
      if (this.now() - cached.at < ttl) {
        return cached.ok ? { countryCode: cached.countryCode, country: cached.country } : null
      }
    }
    const running = this.inflight.get(address)
    if (running !== undefined) return running
    const promise = this.#lookup(address).finally(() => {
      this.inflight.delete(address)
    })
    this.inflight.set(address, promise)
    return promise
  }

  /**
   * Attach `countryCode` / `country` to every member that has a public IP.
   *
   * Mutates the member objects the discovery snapshot is built from, so the
   * panel receives the country on the same row it renders. A failed lookup is
   * not an error: the fields simply stay absent.
   * @template {object} T member shape.
   * @param {T[]} members member rows.
   * @returns {Promise<T[]>} the same rows.
   */
  async enrich(members) {
    if (!this.enabled) return members
    await Promise.all(members.map(async member => {
      const ip = typeof member?.publicIp === 'string' ? member.publicIp : ''
      if (ip === '') return
      try {
        const found = await this.country(ip)
        if (found === null) return
        member.countryCode = found.countryCode
        member.country = found.country
      } catch {
        // Enrichment is best effort; discovery must not fail because of it.
      }
    }))
    return members
  }

  /**
   * Wait for the pending cache write to finish.
   * @returns {Promise<void>} when the cache is on disk.
   */
  async flush() {
    await this.saving
  }

  /**
   * Load the persisted cache once.
   * @returns {Promise<void>} when loaded.
   */
  async #load() {
    if (this.loaded !== null) return this.loaded
    this.loaded = (async () => {
      if (this.cacheFile === null) return
      try {
        const parsed = JSON.parse(await readFile(this.cacheFile, 'utf8'))
        if (parsed === null || typeof parsed !== 'object') return
        for (const [address, entry] of Object.entries(parsed)) {
          if (entry === null || typeof entry !== 'object') continue
          const at = Number(entry.at)
          const countryCode = typeof entry.countryCode === 'string' ? entry.countryCode.toUpperCase() : ''
          const country = typeof entry.country === 'string' ? entry.country : ''
          if (!Number.isFinite(at) || !/^[A-Z]{2}$/u.test(countryCode)) continue
          this.cache.set(address, { ok: true, countryCode, country, at })
        }
      } catch {
        // First run or a corrupt file: the next lookup repopulates it.
      }
    })()
    return this.loaded
  }

  /**
   * Ask the provider once and cache the answer.
   * @param {string} address public IP address.
   * @returns {Promise<{countryCode: string, country: string}|null>} country or null.
   */
  async #lookup(address) {
    const url = this.provider.replaceAll('{ip}', encodeURIComponent(address))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`geo provider answered ${String(response.status)}`)
      const payload = await response.json()
      const countryCode = typeof payload?.country_code === 'string' ? payload.country_code.trim().toUpperCase() : ''
      const country = typeof payload?.country === 'string' ? payload.country.trim() : ''
      if (payload?.success === false || !/^[A-Z]{2}$/u.test(countryCode)) {
        throw new Error('geo provider returned no country code')
      }
      this.cache.set(address, { ok: true, countryCode, country, at: this.now() })
      void this.#persist()
      return { countryCode, country }
    } catch (error) {
      // Negative-cache the failure so a blocked provider costs one timeout per
      // failure window, not one per panel refresh.
      this.cache.set(address, { ok: false, countryCode: '', country: '', at: this.now() })
      void this.#persist()
      this.log(`country lookup for ${address} failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Persist the cache without blocking the caller.
   * @returns {Promise<void>} when written.
   */
  #persist() {
    if (this.cacheFile === null) return Promise.resolve()
    const snapshot = Object.fromEntries(this.cache)
    this.saving = this.saving.then(async () => {
      try {
        await mkdir(path.dirname(this.cacheFile), { recursive: true })
        await writeFile(this.cacheFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
      } catch {
        // Best effort: the in-memory cache still serves this process.
      }
    })
    return this.saving
  }
}
