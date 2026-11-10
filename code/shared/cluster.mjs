/**
 * Sign and verify the request that one member gate sends to another.
 *
 * The shared secret is configured in `gate.env` on every member. The signature
 * binds method, full request target (path + query), timestamp, and a nonce, so
 * a captured header cannot be replayed for a different request and an old
 * header stops working after a minute.
 *
 * @module dsh-person-web/shared/cluster
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Header carrying the signed cluster assertion. */
export const CLUSTER_HEADER = 'x-dsh-cluster'

/** Version prefix, so the format can change without ambiguity. */
const VERSION = 'v1'

/**
 * Build the header value for one proxied request.
 * @param {string} secret shared cluster secret.
 * @param {{method: string, path: string, timestamp?: number, nonce?: string}} request request identity.
 * @returns {string} `v1.<timestamp>.<nonce>.<signature>`.
 */
export function signClusterRequest(secret, request) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('cluster secret is not configured')
  }
  const timestamp = request.timestamp ?? Date.now()
  const nonce = request.nonce ?? randomBytes(16).toString('hex')
  const payload = payloadOf(request.method, request.path, timestamp, nonce)
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${VERSION}.${String(timestamp)}.${nonce}.${signature}`
}

/**
 * Verify one incoming header.
 * @param {string} secret shared cluster secret.
 * @param {unknown} header header value from the request.
 * @param {{method: string, path: string, now?: number, maxSkewMs?: number, replay?: ClusterReplayCache}} options verification input.
 * @returns {{ok: true, timestamp: number, nonce: string} | {ok: false, reason: string}} verdict.
 */
export function verifyClusterRequest(secret, header, options) {
  if (typeof secret !== 'string' || secret.length === 0) return { ok: false, reason: 'cluster secret is not configured' }
  if (typeof header !== 'string' || header === '') return { ok: false, reason: 'missing cluster header' }
  const parts = header.split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) return { ok: false, reason: 'malformed cluster header' }
  const timestamp = Number(parts[1])
  const nonce = parts[2]
  const signature = parts[3]
  if (!Number.isSafeInteger(timestamp) || !/^[A-Za-z0-9_-]{8,64}$/u.test(nonce) || !/^[A-Za-z0-9_-]{16,128}$/u.test(signature)) {
    return { ok: false, reason: 'malformed cluster header' }
  }
  const now = options.now ?? Date.now()
  const maxSkewMs = options.maxSkewMs ?? 60_000
  if (Math.abs(now - timestamp) > maxSkewMs) return { ok: false, reason: 'cluster header is outside the allowed clock skew' }
  const expected = createHmac('sha256', secret)
    .update(payloadOf(options.method, options.path, timestamp, nonce))
    .digest()
  const actual = Buffer.from(signature, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'cluster signature does not match' }
  }
  if (options.replay !== undefined && !options.replay.accept(`${String(timestamp)}.${nonce}`, timestamp + maxSkewMs, now)) {
    return { ok: false, reason: 'cluster header was already used' }
  }
  return { ok: true, timestamp, nonce }
}

/**
 * Canonical bytes covered by the signature.
 * @param {string} method HTTP method.
 * @param {string} path request target, including the query.
 * @param {number} timestamp milliseconds.
 * @param {string} nonce random hex.
 * @returns {string} payload.
 */
function payloadOf(method, path, timestamp, nonce) {
  return [VERSION, String(method).toUpperCase(), path, String(timestamp), nonce].join('\n')
}

/**
 * Small in-memory nonce cache. Entries expire with the same window as the
 * timestamp check, so it never grows without bound.
 */
export class ClusterReplayCache {
  constructor() {
    /** @type {Map<string, number>} */
    this.entries = new Map()
  }

  /**
   * Remember one nonce.
   * @param {string} key nonce key.
   * @param {number} expiresAt epoch milliseconds.
   * @param {number} [now] clock used for sweeping.
   * @returns {boolean} false when the nonce was already present.
   */
  accept(key, expiresAt, now = Date.now()) {
    this.sweep(now)
    if (this.entries.has(key)) return false
    this.entries.set(key, expiresAt)
    return true
  }

  /**
   * Drop expired entries.
   * @param {number} now epoch milliseconds.
   * @returns {void}
   */
  sweep(now) {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(key)
    }
  }
}
