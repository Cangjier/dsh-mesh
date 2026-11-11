/** Same-origin proxy from the person-web panel to the WireGuard control service. */

import { request as httpRequest } from 'node:http'

const API_PREFIX = '/api/dsh-wireguard'

/**
 * Forward one panel API request to the standalone control service on 51821.
 * @param {import('node:http').IncomingMessage} request incoming request.
 * @param {import('node:http').ServerResponse} response response.
 * @returns {Promise<void>}
 */
function proxy(request, response) {
  const port = Number(process.env.DSH_WIREGUARD_CONTROL_PORT ?? '51821')
  return new Promise(resolve => {
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: Number.isSafeInteger(port) && port > 0 ? port : 51821,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, host: `127.0.0.1:${String(port)}` },
    }, answer => {
      response.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(response)
      answer.once('end', resolve)
    })
    upstream.once('error', () => {
      if (!response.headersSent) {
        const body = JSON.stringify({
          ok: false,
          error: {
            code: 'control_panel_unavailable',
            message: 'The standalone WireGuard control service is not reachable on 51821.',
          },
        })
        response.writeHead(503, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store',
        })
        response.end(body)
      }
      resolve()
    })
    request.pipe(upstream)
  })
}

/**
 * Register the WireGuard panel API on the Harness web server.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host context.
 * @returns {void}
 */
export function registerWireGuardApi(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: proxy,
  }), 'person-web wireguard api')
}
