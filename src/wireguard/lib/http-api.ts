/** Same-origin Host API consumed by the WireGuard panel. */

import { request as httpRequest } from 'node:http';
import { API_PREFIX, MAX_REQUEST_BYTES } from './constants';
import { WireGuardError } from './errors';

const AGENT_HEADER = 'x-dsh-wireguard';

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} value
 * @returns {void}
 */
function writeJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

/**
 * Read a bounded JSON body.
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new WireGuardError('request_too_large', 'Request body is too large.', { status: 413 });
    chunks.push(buffer);
  }
  if (size === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new WireGuardError('invalid_json', 'Request body is not valid JSON.', { status: 400 });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WireGuardError('invalid_json', 'Request body must be a JSON object.', { status: 400 });
  }
  return parsed;
}

/**
 * Build the local panel API handler over one service instance.
 * @param {import('./service').WireGuardService} service service instance.
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>} handler.
 */
export function createHttpApiHandler(service) {
  return async (request, response) => {
    try {
      const method = request.method ?? 'GET';
      const url = new URL(request.url ?? '/', 'http://local.invalid');
      const path = url.pathname;

      if (method === 'GET' && path === `${API_PREFIX}/state`) {
        writeJson(response, 200, { ok: true, state: await service.getState() });
        return;
      }
      if (method === 'GET' && path === `${API_PREFIX}/health`) {
        writeJson(response, 200, { ok: true, service: 'dsh-wireguard' });
        return;
      }
      if (method !== 'POST') {
        writeJson(response, 405, { ok: false, error: { code: 'method_not_allowed', message: 'Use GET or POST.' } });
        return;
      }
      if (request.headers[AGENT_HEADER] !== '1') {
        writeJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'Missing the local WireGuard request header.' } });
        return;
      }
      const body = await readJson(request);
      let result;
      if (path === `${API_PREFIX}/install`) result = await service.installWireGuard();
      else if (path === `${API_PREFIX}/server/start`) result = await service.startServer(body);
      else if (path === `${API_PREFIX}/server/stop`) result = await service.stopServer();
      else if (path === `${API_PREFIX}/peers/remove`) result = await service.removePeer(String(body.publicKey ?? ''));
      else if (path === `${API_PREFIX}/peers/ssh`) result = await service.configurePeerSsh(body);
      else if (path === `${API_PREFIX}/client/connect`) result = await service.connectClient(body);
      else if (path === `${API_PREFIX}/client/retry`) result = await service.retryClient();
      else if (path === `${API_PREFIX}/client/disconnect`) result = await service.disconnectClient();
      else if (path === `${API_PREFIX}/refresh`) result = await service.getState({ force: true });
      else {
        writeJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Unknown WireGuard endpoint.' } });
        return;
      }
      if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'state')) {
        writeJson(response, 200, { ok: true, ...result });
      } else {
        writeJson(response, 200, { ok: true, state: result });
      }
    } catch (error) {
      const state = service.snapshot();
      if (error instanceof WireGuardError) {
        writeJson(response, error.status, { ok: false, error: error.toJSON(), state });
        return;
      }
      writeJson(response, 500, {
        ok: false,
        error: {
          code: 'internal_error',
          message: error instanceof Error ? error.message : 'The WireGuard operation failed.',
        },
        state,
      });
    }
  };
}

/**
 * Proxy the DSH host API to the standalone control service on 51821. The
 * built-in panel therefore reads and mutates exactly the service-owned state,
 * and DSH exiting cannot take the control listener with it.
 * @param {import('./service').WireGuardService} service local service.
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>} handler.
 */
function createExternalControlProxy(service) {
  return async (request, response) => {
    const port = service.state.server.controlPort || service.state.settings.controlPort;
    await new Promise<void>((resolve) => {
      const upstream = httpRequest({
        host: '127.0.0.1',
        port,
        method: request.method,
        path: request.url,
        headers: { ...request.headers, host: `127.0.0.1:${port}` },
      }, (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
        answer.once('end', resolve);
      });
      upstream.once('error', () => {
        if (!response.headersSent) {
          writeJson(response, 503, {
            ok: false,
            error: {
              code: 'control_panel_unavailable',
              message: 'The standalone WireGuard control service is not reachable on 51821.',
            },
          });
        }
        resolve();
      });
      request.pipe(upstream);
    });
  };
}

/**
 * Whether an address belongs to the loopback interface. The panel API is only
 * for the local DSH plugin proxy; the control listener itself is public.
 * @param {string | undefined} address socket peer address.
 * @returns {boolean} whether the peer is local.
 */
function isLoopbackAddress(address) {
  if (!address) return false;
  const text = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (text === '::1') return true;
  return /^127\./.test(text) && text.split('.').length === 4;
}

/**
 * Build the extra handler the standalone control service installs on its
 * listener. That listener also serves the public join routes, so this handler
 * must claim only its own API prefix on loopback requests and let everything
 * else fall through to the control panel. The prefix carries no secrets, but
 * it includes the join code, so it must never answer the public interface.
 * @param {import('./service').WireGuardService} service service instance.
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<boolean>} handler that reports whether it handled the request.
 */
export function createControlExtraHandler(service) {
  const api = createHttpApiHandler(service);
  return async (request, response) => {
    if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
    const path = new URL(request.url ?? '/', 'http://local.invalid').pathname;
    if (path !== API_PREFIX && !path.startsWith(`${API_PREFIX}/`)) return false;
    await api(request, response);
    return true;
  };
}

/**
 * Register the panel's local HTTP API on the Harness web server.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host context.
 * @param {import('./service').WireGuardService} service service instance.
 * @returns {void}
 */
export function registerHttpApi(ctx, service) {
  const handler = service.config.externalControlPanel === true
    ? createExternalControlProxy(service)
    : createHttpApiHandler(service);
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler,
  }), 'wireguard local api');
}
