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
 * @returns {void}
 */
export function registerApi(ctx, service) {
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
        if (method === 'POST' && path === '/packages/delete') {
          const body = await readJson(request)
          writeJson(response, 200, await service.removePackage({ name: typeof body.name === 'string' ? body.name : '' }))
          return
        }
        if (method === 'POST' && path === '/conversations/send') {
          const body = await readJson(request)
          writeJson(response, 200, await service.sendConversation({
            text: typeof body.text === 'string' ? body.text : '',
            members: Array.isArray(body.members) ? body.members.filter(item => typeof item === 'string') : [],
          }))
          return
        }
        if (method === 'POST' && path === '/conversations/clear') {
          writeJson(response, 200, await service.clearConversations())
          return
        }
        if (method === 'GET' && path === '/conversations') {
          writeJson(response, 200, await service.conversations())
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
        if (path === '/deploy') {
          const body = await readJson(request)
          const result = await service.deployMember({
            member: typeof body.member === 'string' ? body.member : undefined,
            package: typeof body.package === 'string' ? body.package : undefined,
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
