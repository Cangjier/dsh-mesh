import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cookieValue,
  memberCookiePrefix,
  namespaceSetCookie,
  rewriteCookieHeader,
  stripCookieHeader,
} from '../code/shared/cookies.mjs'

test('namespaceSetCookie renames, drops Domain, and keeps attributes', () => {
  const header = 'dsh_gate=abc; Domain=example.com; Path=/; HttpOnly; SameSite=Lax'
  const out = namespaceSetCookie('10.66.66.2', header)
  assert.equal(out, 'dsh_m_10.66.66.2_dsh_gate=abc; Path=/; HttpOnly; SameSite=Lax')
})

test('namespaceSetCookie adds Path when the upstream omitted it', () => {
  const out = namespaceSetCookie('10.66.66.2', 'dsh_x=1; HttpOnly')
  assert.equal(out, 'dsh_m_10.66.66.2_dsh_x=1; HttpOnly; Path=/')
})

test('namespaceSetCookie is idempotent', () => {
  const once = namespaceSetCookie('local', 'dsh_gate=abc; Path=/')
  const twice = namespaceSetCookie('local', once)
  assert.equal(twice, once)
})

test('rewriteCookieHeader keeps only the selected member namespace', () => {
  const prefix = memberCookiePrefix('10.66.66.2')
  const header = [
    'dsh_gate=outer',
    'dsh_gate_target=10.66.66.2',
    `${prefix}dsh_gate=member-gate`,
    `${prefix}dsh_session=member-dsh`,
    'dsh_m_10.66.66.3_dsh_gate=other',
  ].join('; ')
  assert.equal(rewriteCookieHeader('10.66.66.2', header), 'dsh_gate=member-gate; dsh_session=member-dsh')
})

test('rewriteCookieHeader returns an empty header when the member has no cookies', () => {
  assert.equal(rewriteCookieHeader('10.66.66.2', 'dsh_gate=outer; dsh_gate_target=local'), '')
  assert.equal(rewriteCookieHeader('10.66.66.2', ''), '')
})

test('stripCookieHeader removes exactly the named cookies', () => {
  const header = 'a=1; dsh_gate=2; dsh_gate_target=3; b=4'
  assert.equal(stripCookieHeader(header, ['dsh_gate', 'dsh_gate_target']), 'a=1; b=4')
})

test('cookieValue reads a value and ignores lookalikes', () => {
  const header = 'dsh_gate=one; dsh_gate_target=two; xdsh_gate=three'
  assert.equal(cookieValue(header, 'dsh_gate_target'), 'two')
  assert.equal(cookieValue(header, 'dsh_gate'), 'one')
  assert.equal(cookieValue(header, 'missing'), undefined)
})
