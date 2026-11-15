import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildStampDate, isValidBuildStamp, letterFor, letterIndex, nextBuildStamp } from '../code/build/stamp.mjs'

test('daily stamps use local date and Excel-style letters', () => {
  assert.equal(buildStampDate(new Date(2026, 10, 15)), '20261115')
  assert.equal(letterFor(1), 'A')
  assert.equal(letterFor(26), 'Z')
  assert.equal(letterFor(27), 'AA')
  assert.equal(letterFor(52), 'AZ')
  assert.equal(letterFor(53), 'BA')
  assert.equal(letterIndex('A'), 1)
  assert.equal(letterIndex('Z'), 26)
  assert.equal(letterIndex('AA'), 27)
  assert.equal(isValidBuildStamp('20261115A'), true)
  assert.equal(isValidBuildStamp('20261115AA'), true)
  assert.equal(isValidBuildStamp('20261115'), false)
  assert.equal(isValidBuildStamp('2026-11-15A'), false)
})

test('nextBuildStamp increments per day and persists the counter', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-stamp-'))
  try {
    const stateFile = path.join(dir, 'build-stamp.json')
    const packagesDir = path.join(dir, 'packages')
    await mkdir(packagesDir, { recursive: true })
    const now = new Date(2026, 10, 15, 10, 0, 0)
    assert.equal(await nextBuildStamp({ stateFile, packagesDir, now }), '20261115A')
    assert.equal(await nextBuildStamp({ stateFile, packagesDir, now }), '20261115B')
    // The next day resets to A, even though the state file still holds a
    // different date.
    const tomorrow = new Date(2026, 10, 16, 9, 0, 0)
    assert.equal(await nextBuildStamp({ stateFile, packagesDir, now: tomorrow }), '20261116A')
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.equal(state.date, '20261116')
    assert.equal(state.next, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('nextBuildStamp also respects stamps already present in package names', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mesh-stamp-scan-'))
  try {
    const stateFile = path.join(dir, 'build-stamp.json')
    const packagesDir = path.join(dir, 'packages')
    await mkdir(packagesDir, { recursive: true })
    await writeFile(path.join(packagesDir, 'dsh-mesh-0.2.2-rc.3-20261115C-linux-x64.tar.gz'), 'x')
    await writeFile(path.join(packagesDir, 'dsh-mesh-0.2.2-rc.3-20261115A-win-x64.zip'), 'x')
    await writeFile(path.join(packagesDir, 'dsh-mesh-0.2.2-rc.3-20261114Z-linux-x64.tar.gz'), 'x')
    const now = new Date(2026, 10, 15, 12, 0, 0)
    assert.equal(await nextBuildStamp({ stateFile, packagesDir, now }), '20261115D')
    // The state counter is now E, and it wins over the names even if the
    // package that carried D is deleted.
    assert.equal(await nextBuildStamp({ stateFile, packagesDir, now }), '20261115E')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
