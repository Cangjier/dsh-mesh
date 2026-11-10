import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PersonWebService } from '../src/lib/service.mjs'
import { sha256Text } from '../code/build/engine.mjs'

/**
 * Wait for a job to leave the running phase.
 * @param {PersonWebService} service service.
 * @param {string} id job id.
 * @returns {Promise<object>} final job.
 */
async function waitForJob(service, id) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const job = await service.job(id)
    if (job.status !== 'running' && job.status !== 'created') return job
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('job did not finish in time')
}

test('service exposes status, recipes, members, and a plan job', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-person-web-service-'))
  const source = path.join(dir, 'source')
  try {
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ version: '9.9.9' }), 'utf8')
    const picker = '/* dsh-person-web overlay: picker */\n// picker\n'
    const account = '/* dsh-person-web overlay: login */\n// account\n'
    const overlay = 'export function openGateLoginOverlay() {}\n'
    await mkdir(path.join(source, 'packages/client/ui-directory-picker-browse/src/client'), { recursive: true })
    await mkdir(path.join(source, 'packages/client/ui-settings-account/src/client'), { recursive: true })
    await writeFile(path.join(source, 'packages/client/ui-directory-picker-browse/src/client/DirectoryBrowser.tsx'), picker, 'utf8')
    await writeFile(path.join(source, 'packages/client/ui-settings-account/src/client/index.ts'), account, 'utf8')
    await writeFile(path.join(source, 'packages/client/ui-settings-account/src/client/gate-login-overlay.ts'), overlay, 'utf8')

    const service = new PersonWebService({
      dataDir: path.join(dir, 'person-web'),
      config: {
        build: { source, ref: 'master', targets: ['linux-x64'] },
      },
      log: () => {},
    })
    const status = await service.status()
    assert.equal(status.ok, true)
    assert.equal(status.host.version, '0.2.0')

    const recipes = await service.recipes()
    assert.equal(recipes.steps.length, 2)

    const members = await service.members()
    assert.equal(members.self.id, 'local')
    assert.ok(Array.isArray(members.members))

    const started = await service.startBuild({ source, planOnly: true, targets: ['linux-x64'] })
    assert.ok(started.id)
    const job = await waitForJob(service, started.id)
    assert.equal(job.status, 'planned')
    assert.equal(job.phase, 'apply')
    assert.equal(job.targets[0], 'linux-x64')

    const jobs = await service.jobs()
    assert.ok(jobs.some(entry => entry.id === started.id))
    const log = await service.log(started.id, 20)
    assert.ok(Array.isArray(log))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
