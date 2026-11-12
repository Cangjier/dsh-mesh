import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { mergeAccountCredentials, splitCredentials } from '../code/shared/credentials-merge.mjs'

const deployer = `version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: deployer-browser
  deepseek-account-platform/device:
    kind: grant
    payload:
      id: device-1
  deepseek-account-platform/default:
    kind: grant
    payload:
      version: 1
      token: token-1
      issuer: https://platform.deepseek.com
`

test('an empty target receives only the account records', () => {
  const merged = mergeAccountCredentials(null, deployer)
  assert.match(merged, /deepseek-account-platform\/default/u)
  assert.match(merged, /token: token-1/u)
  assert.doesNotMatch(merged, /deployer-browser/u, 'the deployer browser grant is not copied')
  assert.deepEqual(splitCredentials(merged).records.map(record => record.name), [
    'deepseek-account-platform/device',
    'deepseek-account-platform/default',
  ])
})

test('the member keeps its own records and gains the account ones', () => {
  const member = `version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: member-browser
`
  const merged = mergeAccountCredentials(member, deployer)
  assert.match(merged, /secret: member-browser/u, 'the member browser grant survives')
  assert.match(merged, /token: token-1/u)
  assert.doesNotMatch(merged, /deployer-browser/u)
})

test('an existing account token is replaced, not duplicated', () => {
  const stale = `version: 1
records:
  deepseek-account-platform/default:
    kind: grant
    payload:
      version: 1
      token: old-token
      issuer: https://platform.deepseek.com
`
  const merged = mergeAccountCredentials(stale, deployer)
  assert.doesNotMatch(merged, /old-token/u)
  assert.equal(merged.match(/deepseek-account-platform\/default:/gu).length, 1)
  assert.match(merged, /token: token-1/u)
})

test('a credentials file without a records section gains one', () => {
  const merged = mergeAccountCredentials('version: 1\n', deployer)
  assert.match(merged, /^records:$/mu)
  assert.match(merged, /token: token-1/u)
})

test('the cli merges files and keeps the file private', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-cred-'))
  try {
    const source = path.join(dir, 'source.yaml')
    const target = path.join(dir, 'target.yaml')
    writeFileSync(source, deployer)
    writeFileSync(target, 'version: 1\nrecords:\n  client-connection/browser-session:\n    kind: grant\n')
    execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'code', 'shared', 'credentials-merge.mjs'), target, source], { encoding: 'utf8' })
    const merged = readFileSync(target, 'utf8')
    assert.match(merged, /token: token-1/u)
    assert.match(merged, /client-connection\/browser-session/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
