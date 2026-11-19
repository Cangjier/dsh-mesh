/**
 * Same-origin Host API consumed by the panel and by direct HTTP clients.
 *
 * Mutating calls require the `x-dsh-mesh: 1` header, matching the
 * plugin's other local APIs: the header is not a secret, it is a CSRF guard a
 * cross-site form cannot set.
 *
 * @module @local/dsh-mesh/http-api
 */

import { EventHub } from '../../code/shared/event-stream.mjs'
import { startJobEvents } from './job-events.mjs'

const API_PREFIX = '/api/dsh-mesh'
const AGENT_HEADER = 'x-dsh-mesh'
const MAX_BODY_BYTES = 64 * 1024

/**
 * Write a JSON response.
 * @param {import('node:http').ServerResponse} response response.
 * @param {number} status status.
 * @param {unknown} value body.
 * @returns {void}
 */
function writeJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

/**
 * Read a bounded JSON object.
 * @param {import('node:http').IncomingMessage} request request.
 * @returns {Promise<Record<string, unknown>>} body.
 */
async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request body must be a JSON object')
  return parsed
}

/**
 * Register the local API on the Harness web server.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host context.
 * @param {import('./service.mjs').MeshService} service service.
 * @param {import('./scheduler.mjs').Scheduler|null} [scheduler] timed build/upgrade scheduler.
 * @returns {void}
 */
export function registerApi(ctx, service, scheduler = null) {
  const hub = new EventHub({ log: line => ctx.logger?.info?.(`mesh events: ${line}`) })
  const jobEvents = startJobEvents({ service, hub, log: line => ctx.logger?.warn?.(`mesh events: ${line}`) })
  ctx.effect(() => () => {
    jobEvents.close()
    hub.close()
  }, 'mesh events')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (request, response) => {
      try {
        const method = request.method ?? 'GET'
        const url = new URL(request.url ?? '/', 'http://local.invalid')
        const path = url.pathname.slice(API_PREFIX.length) || '/'
        if (method === 'GET' && path === '/status') {
          writeJson(response, 200, await service.status())
          return
        }
        if (method === 'GET' && path === '/members') {
          writeJson(response, 200, await service.members())
          return
        }
        if (method === 'GET' && path === '/member-tags') {
          writeJson(response, 200, { ok: true, tags: await service.memberTags() })
          return
        }
        if (method === 'GET' && path === '/schedule') {
          if (scheduler === null) {
            writeJson(response, 503, { ok: false, error: { code: 'unavailable', message: '定时任务还没有启动。' } })
            return
          }
          const member = url.searchParams.get('member') ?? ''
          writeJson(response, 200, { ok: true, schedule: scheduler.status(member === '' ? undefined : member) })
          return
        }
        if (method === 'POST' && path === '/packages/delete') {
          const body = await readJson(request)
          writeJson(response, 200, await service.removePackage({ name: typeof body.name === 'string' ? body.name : '' }))
          return
        }
        if (method === 'GET' && path === '/events') {
          hub.subscribe(request, response)
          return
        }
        if (method === 'GET' && path === '/jobs') {
          writeJson(response, 200, { ok: true, jobs: await service.jobs() })
          return
        }
        if (method === 'GET' && path === '/packages') {
          writeJson(response, 200, await service.packages())
          return
        }
        if (method === 'GET' && path === '/release/latest') {
          writeJson(response, 200, await service.latestRelease({
            refresh: url.searchParams.get('refresh') === '1',
          }))
          return
        }
        if (method === 'GET' && path === '/member-packages') {
          writeJson(response, 200, await service.memberPackages(url.searchParams.get('member') ?? ''))
          return
        }
        if (method === 'GET' && path === '/release') {
          writeJson(response, 200, await service.releaseSettings())
          return
        }
        if (method === 'GET' && path === '/deploy/jobs') {
          writeJson(response, 200, { ok: true, jobs: await service.deployJobs(30) })
          return
        }
        if (method === 'GET') {
          const deployRead = /^\/deploy\/([^/]+)(\/log)?$/u.exec(path)
          if (deployRead !== null) {
            const lines = Number.parseInt(url.searchParams.get('lines') ?? '200', 10)
            const job = await service.deployStatus(deployRead[1])
            if (job === null) {
              writeJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Unknown deploy job.' } })
              return
            }
            const tail = await service.deployLogs(deployRead[1], Number.isSafeInteger(lines) ? Math.min(Math.max(lines, 1), 500) : 200)
            writeJson(response, 200, {
              ok: true,
              job,
              // Match the build log endpoint: the panel expects an array.
              lines: tail.trimEnd() === '' ? [] : tail.trimEnd().split(/\r?\n/u),
            })
            return
          }
          const read = /^\/build\/([^/]+)(\/log)?$/u.exec(path)
          if (read !== null) {
            if (read[2] === '/log') {
              const lines = Number.parseInt(url.searchParams.get('lines') ?? '80', 10)
              writeJson(response, 200, {
                ok: true,
                lines: await service.log(read[1], Number.isSafeInteger(lines) ? Math.min(Math.max(lines, 1), 500) : 80),
              })
              return
            }
            writeJson(response, 200, { ok: true, job: await service.job(read[1]) })
            return
          }
        }
        if (method !== 'POST') {
          writeJson(response, 405, { ok: false, error: { code: 'method_not_allowed', message: 'Use GET or POST.' } })
          return
        }
        if (request.headers[AGENT_HEADER] !== '1') {
          writeJson(response, 403, { ok: false, error: { code: 'forbidden', message: `Missing the ${AGENT_HEADER} header.` } })
          return
        }
        if (method === 'POST' && path === '/release') {
          const body = await readJson(request)
          writeJson(response, 200, await service.saveReleaseSettings(body))
          return
        }
        if (path === '/deploy') {
          const body = await readJson(request)
          const result = await service.deployMember({
            member: typeof body.member === 'string' ? body.member : undefined,
            package: typeof body.package === 'string' ? body.package : undefined,
            release: body.release !== null && typeof body.release === 'object' ? body.release : undefined,
            targetPackage: body.targetPackage !== null && typeof body.targetPackage === 'object' ? body.targetPackage : undefined,
          })
          writeJson(response, 202, result)
          return
        }
        if (path === '/session/promote') {
          const body = await readJson(request)
          writeJson(response, 200, await service.promoteSession(String(body.member ?? '')))
          return
        }
        if (path === '/member-tags') {
          const body = await readJson(request)
          writeJson(response, 200, await service.setMemberTag(
            typeof body.id === 'string' ? body.id : '',
            typeof body.tag === 'string' ? body.tag : '',
          ))
          return
        }
        const clearLog = /^\/build\/([^/]+)\/log\/clear$/u.exec(path)
        if (clearLog !== null) {
          writeJson(response, 200, await service.clearBuildLog(clearLog[1]))
          return
        }
        if (path === '/build/logs/clear') {
          writeJson(response, 200, await service.clearFinishedBuilds())
          return
        }
        if (path === '/deploy/cancel') {
          const body = await readJson(request)
          const job = await service.cancelDeploy(typeof body.id === 'string' ? body.id : '')
          if (job === null) {
            writeJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Unknown deploy job.' } })
            return
          }
          writeJson(response, 200, { ok: true, job })
          return
        }
        if (path === '/deploy/rollback') {
          const body = await readJson(request)
          writeJson(response, 202, await service.rollbackMember({
            member: typeof body.member === 'string' ? body.member : '',
          }))
          return
        }
        if (path === '/upgrade' || path === '/test-upgrade') {
          const body = await readJson(request)
          const request_ = {
            member: typeof body.member === 'string' ? body.member : undefined,
            package: typeof body.package === 'string' ? body.package : undefined,
            // The two extra package sources: the public latest tag and an
            // archive already on the target member.
            ...(body.release !== null && typeof body.release === 'object' ? { release: body.release } : {}),
            ...(body.targetPackage !== null && typeof body.targetPackage === 'object' ? { targetPackage: body.targetPackage } : {}),
            // Upgrade downloads default to the external proxy; the panel can
            // pick a different member or ask for a direct download.
            ...(typeof body.proxyMember === 'string' && body.proxyMember.trim() !== '' ? { proxyMember: body.proxyMember.trim() } : {}),
            ...(body.direct === true ? { direct: true } : {}),
          }
          // `/test-upgrade` runs the same upgrade on another member, plus a
          // rehearsal of the flat (local) path in a sandbox there.
          const test = path === '/test-upgrade' || body.test === true
          writeJson(response, 202, test
            ? await service.testUpgradeMember(request_)
            : await service.upgradeMember(request_))
          return
        }
        if (path === '/schedule') {
          if (scheduler === null) {
            writeJson(response, 503, { ok: false, error: { code: 'unavailable', message: '定时任务还没有启动。' } })
            return
          }
          const body = await readJson(request)
          const member = typeof body.member === 'string' ? body.member.trim() : ''
          const patch = member === ''
            ? {
                build: body.build !== null && typeof body.build === 'object'
                  ? {
                      ...(typeof body.build.enabled === 'boolean' ? { enabled: body.build.enabled } : {}),
                      ...(typeof body.build.time === 'string' ? { time: body.build.time } : {}),
                    }
                  : undefined,
              }
            : {
                member,
                upgrade: body.upgrade !== null && typeof body.upgrade === 'object'
                  ? {
                      ...(typeof body.upgrade.enabled === 'boolean' ? { enabled: body.upgrade.enabled } : {}),
                      ...(typeof body.upgrade.time === 'string' ? { time: body.upgrade.time } : {}),
                    }
                  : undefined,
              }
          writeJson(response, 200, { ok: true, schedule: await scheduler.update(patch) })
          return
        }
        if (path === '/build') {
          const body = await readJson(request)
          const job = await service.startBuild({
            source: typeof body.source === 'string' ? body.source : undefined,
            ref: typeof body.ref === 'string' ? body.ref : undefined,
            targets: Array.isArray(body.targets) ? body.targets.filter(value => typeof value === 'string') : undefined,
            planOnly: body.planOnly === true,
            version: typeof body.version === 'string' ? body.version : undefined,
            member: typeof body.member === 'string' ? body.member : undefined,
            proxy: typeof body.proxy === 'string' ? body.proxy : undefined,
            proxyMember: typeof body.proxyMember === 'string' ? body.proxyMember : undefined,
            direct: body.direct === true,
            pullBack: typeof body.pullBack === 'boolean' ? body.pullBack : undefined,
            autoUpgrade: typeof body.autoUpgrade === 'boolean' ? body.autoUpgrade : undefined,
          })
          writeJson(response, 202, { ok: true, job })
          return
        }
        const resume = /^\/build\/([^/]+)\/resume$/u.exec(path)
        if (resume !== null) {
          writeJson(response, 202, { ok: true, job: await service.resumeBuild(resume[1]) })
          return
        }
        const match = /^\/build\/([^/]+)\/learn$/u.exec(path)
        if (match !== null) {
          writeJson(response, 200, { ok: true, job: await service.learn(match[1]) })
          return
        }
        writeJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Unknown mesh endpoint.' } })
      } catch (error) {
        writeJson(response, 400, {
          ok: false,
          error: {
            code: 'request_failed',
            message: error instanceof Error ? error.message : String(error),
          },
        })
      }
    },
  }), 'mesh local api')
}
