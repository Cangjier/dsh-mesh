import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { repackArchive, repackDirectory } from '../code/build/repack.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Build a throwaway package directory with a manifest, app payload and stale gate. */
function fixture(root) {
  const dir = path.join(root, 'dsh-mesh-0.0.1-linux-x64')
  mkdirSync(path.join(dir, 'app'), { recursive: true })
  mkdirSync(path.join(dir, 'gate'), { recursive: true })
  writeFileSync(path.join(dir, 'app', 'keep.txt'), 'the dsh app payload')
  writeFileSync(path.join(dir, 'gate', 'server.mjs'), '// stale gate\n')
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ format: 1, version: '0.0.1', target: { os: 'linux', arch: 'x64' } }, null, 2))
  return dir
}

test('repacking a directory keeps the app payload and replaces the owned files', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-repack-'))
  try {
    const dir = fixture(root)
    const summary = await repackDirectory(dir, repositoryRoot)
    assert.equal(summary.version, '0.0.1')
    assert.equal(readFileSync(path.join(dir, 'app', 'keep.txt'), 'utf8'), 'the dsh app payload')
    assert.ok(readFileSync(path.join(dir, 'gate', 'server.mjs'), 'utf8').includes('MemberService'))
    assert.ok(existsSync(path.join(dir, 'gate', 'windows-browser.mjs')))
    assert.ok(existsSync(path.join(dir, 'shared', 'credentials-merge.mjs')))
    assert.ok(existsSync(path.join(dir, 'plugins', 'dsh-mesh', 'client.js')))
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.repackedFrom, 'code/build/repack.mjs')
    assert.ok(manifest.files > 10)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('repacking an archive rewrites it in place and updates the checksum', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-repack-'))
  try {
    const dir = fixture(root)
    const archive = path.join(root, 'dsh-mesh-0.0.1-linux-x64.tar.gz')
    execFileSync('tar', ['-czf', archive, path.basename(dir)], { cwd: root })
    const before = execFileSync('tar', ['-xzOf', archive, `${path.basename(dir)}/app/keep.txt`], { encoding: 'utf8' })
    assert.equal(before, 'the dsh app payload')
    const summary = await repackArchive(archive, { repositoryRoot })
    assert.match(summary.sha256, /^[0-9a-f]{64}$/u)
    assert.ok(summary.bytes > 0)
    const gate = execFileSync('tar', ['-xzOf', archive, `${path.basename(dir)}/gate/server.mjs`], { encoding: 'utf8' })
    assert.ok(gate.includes('MemberService'))
    const app = execFileSync('tar', ['-xzOf', archive, `${path.basename(dir)}/app/keep.txt`], { encoding: 'utf8' })
    assert.equal(app, 'the dsh app payload')
    const sidecar = readFileSync(`${archive}.sha256`, 'utf8')
    assert.match(sidecar, new RegExp(`^${summary.sha256}  `, 'u'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
