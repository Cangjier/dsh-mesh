import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ClusterReplayCache,
  signClusterRequest,
  verifyClusterRequest,
} from '../code/shared/cluster.mjs'

const secret = 'test-cluster-secret'
const base = {
  method: 'GET',
  path: '/__gate/cluster/api/status?x=1',
  timestamp: 1_700_000_000_000,
  nonce: '0123456789abcdef0123456789abcdef',
}

test('a signed request verifies for the same method and path', () => {
  const header = signClusterRequest(secret, base)
  const verdict = verifyClusterRequest(secret, header, {
    method: base.method,
    path: base.path,
    now: base.timestamp,
  })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.nonce, base.nonce)
})

test('changing the path invalidates the signature', () => {
  const header = signClusterRequest(secret, base)
  const verdict = verifyClusterRequest(secret, header, {
    method: base.method,
    path: '/__gate/cluster/api/other',
    now: base.timestamp,
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /signature/u)
})

test('an old header is rejected', () => {
  const header = signClusterRequest(secret, base)
  const verdict = verifyClusterRequest(secret, header, {
    method: base.method,
    path: base.path,
    now: base.timestamp + 120_000,
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /clock skew/u)
})

test('a reused nonce is rejected when a replay cache is supplied', () => {
  const header = signClusterRequest(secret, base)
  const replay = new ClusterReplayCache()
  const first = verifyClusterRequest(secret, header, {
    method: base.method,
    path: base.path,
    now: base.timestamp,
    replay,
  })
  const second = verifyClusterRequest(secret, header, {
    method: base.method,
    path: base.path,
    now: base.timestamp,
    replay,
  })
  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.match(second.reason, /already used/u)
})

test('a missing or malformed header never verifies', () => {
  for (const header of [undefined, '', 'v1.1.2', 'v2.1.abc.def', 'v1.abc.0123456789abcdef.0123456789abcdef']) {
    const verdict = verifyClusterRequest(secret, header, {
      method: base.method,
      path: base.path,
      now: base.timestamp,
    })
    assert.equal(verdict.ok, false, String(header))
  }
})
