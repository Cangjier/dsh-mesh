/** The LAN-facing WireGuard control-panel HTTP service. */

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { secretsMatch } from './access';
import { LINUX_CLIENT_SCRIPT } from './client-script';
import { MAX_REQUEST_BYTES } from './constants';
import { WireGuardError } from './errors';

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;
const COOKIE_NAME = 'dsh_wg_panel';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_BODY_LIMIT = 4096;

/**
 * Escape text placed in the small server-rendered status page.
 * @param {unknown} value text.
 * @returns {string} HTML-safe text.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Read and parse a bounded JSON request body.
 * @param {import('node:http').IncomingMessage} request incoming request.
 * @param {number} limit byte limit.
 * @returns {Promise<Record<string, unknown>>} parsed object.
 */
async function readJson(request: import('node:http').IncomingMessage, limit = MAX_REQUEST_BYTES): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      throw new WireGuardError('request_too_large', 'Request body is too large.', { status: 413 });
    }
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
 * Read a bounded URL-encoded form body.
 * @param {import('node:http').IncomingMessage} request incoming request.
 * @param {number} limit byte limit.
 * @returns {Promise<URLSearchParams>} decoded form fields.
 */
async function readForm(request: import('node:http').IncomingMessage, limit = LOGIN_BODY_LIMIT): Promise<URLSearchParams> {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      throw new WireGuardError('request_too_large', 'Request body is too large.', { status: 413 });
    }
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} response response.
 * @param {number} status HTTP status.
 * @param {unknown} value JSON value.
 * @returns {void}
 */
function writeJson(response: import('node:http').ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

export interface ControlPanelOptions {
  getServerInfo: () => Record<string, unknown>;
  getPeers: () => Array<Record<string, unknown>>;
  getAccessCode: () => string;
  onJoin: (request: Record<string, unknown>, remoteAddress: string) => Promise<Record<string, unknown>>;
  onLeave: (request: Record<string, unknown>, remoteAddress: string) => Promise<Record<string, unknown>>;
  extraHandler?: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<boolean> | boolean;
  log?: (message: string) => void;
}

/**
 * The HTTP service clients call to join a server. It is deliberately separate
 * from the Harness web server so a remote client can reach it on the LAN.
 */
export class ControlPanel {
  private readonly options: ControlPanelOptions;
  private server: import('node:http').Server | null;
  private port: number | null;
  private readonly attempts: Map<string, number[]>;
  private readonly sessions: Map<string, number>;
  private readonly log: (message: string) => void;

  constructor(options: ControlPanelOptions) {
    this.options = options;
    this.server = null;
    this.port = null;
    this.attempts = new Map();
    this.sessions = new Map();
    this.log = options.log ?? (() => {});
  }

  async start(port: number, host = '0.0.0.0'): Promise<{ port: number; host: string }> {
    if (this.server) throw new WireGuardError('already_running', 'The control panel is already running.', { status: 409 });
    const server = createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        this.log(`control panel request failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!response.headersSent) writeJson(response, 500, { ok: false, error: { code: 'internal_error', message: 'The control panel request failed.' } });
        else response.destroy();
      });
    });
    server.keepAliveTimeout = 10_000;
    server.headersTimeout = 15_000;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          reject(new WireGuardError('port_in_use', `Control-panel port ${port} is already in use.`, {
            status: 409,
            hint: 'Choose another control-panel port on the Service tab and start again.',
          }));
        } else {
          reject(new WireGuardError('control_error', `Could not start the control panel: ${error.message}`, { status: 500, cause: error }));
        }
      };
      server.once('error', onError);
      server.listen({ port, host, ipv6Only: false }, () => {
        server.off('error', onError);
        resolve();
      });
    });
    this.server = server;
    this.port = port;
    this.log(`control panel listening on ${host}:${port}`);
    return { port, host };
  }

  /**
   * Stop the listener and every retained connection.
   * @returns {Promise<void>}
   */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
      setTimeout(resolve, 1500).unref?.();
    });
  }

  /**
   * @param {import('node:http').IncomingMessage} request incoming request.
   * @param {import('node:http').ServerResponse} response response.
   * @returns {Promise<void>}
   */
  async handle(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://control-panel.invalid');
    const remoteAddress = request.socket.remoteAddress ?? 'unknown';
    if (!this.allow(remoteAddress)) {
      writeJson(response, 429, { ok: false, error: { code: 'rate_limited', message: 'Too many requests. Try again in a minute.' } });
      return;
    }

    if (this.options.extraHandler) {
      const handled = await this.options.extraHandler(request, response);
      if (handled) return;
    }

    if (method === 'POST' && url.pathname === '/login') {
      await this.handleLogin(request, response);
      return;
    }
    if (method === 'POST' && url.pathname === '/logout') {
      this.handleLogout(request, response);
      return;
    }
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (!this.authed(request)) {
        this.writeLogin(response);
        return;
      }
      this.writePage(response);
      return;
    }
    if (method === 'GET' && url.pathname === '/health') {
      const { joinCode: _joinCode, ...publicInfo } = this.options.getServerInfo();
      writeJson(response, 200, { ok: true, service: 'dsh-wireguard', ...publicInfo });
      return;
    }
    if (method === 'GET' && url.pathname === '/client.sh') {
      response.writeHead(200, {
        'content-type': 'text/x-shellscript; charset=utf-8',
        'content-length': Buffer.byteLength(LINUX_CLIENT_SCRIPT),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      response.end(LINUX_CLIENT_SCRIPT);
      return;
    }
    if (method === 'GET' && url.pathname === '/peers') {
      try {
        if (!this.authed(request)) this.assertCode(url.searchParams.get('code') ?? '');
        writeJson(response, 200, { ok: true, peers: this.options.getPeers() });
      } catch (error) {
        this.writeError(response, error);
      }
      return;
    }
    if (method === 'POST' && url.pathname === '/join') {
      try {
        const body = await readJson(request);
        if (!body.code && url.searchParams.get('code')) body.code = url.searchParams.get('code');
        const result = await this.options.onJoin(body, remoteAddress);
        writeJson(response, 200, { ok: true, ...result });
      } catch (error) {
        this.writeError(response, error);
      }
      return;
    }
    if (method === 'POST' && url.pathname === '/leave') {
      try {
        const body = await readJson(request);
        const result = await this.options.onLeave(body, remoteAddress);
        writeJson(response, 200, { ok: true, ...result });
      } catch (error) {
        this.writeError(response, error);
      }
      return;
    }
    writeJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Unknown control-panel endpoint.' } });
  }

  /**
   * Whether the request carries a valid panel session.
   * @param {import('node:http').IncomingMessage} request incoming request.
   * @returns {boolean} whether the request is authenticated.
   */
  authed(request: import('node:http').IncomingMessage): boolean {
    const code = this.options.getAccessCode();
    if (!code) return true;
    const token = this.cookieToken(request);
    if (!token) return false;
    const expires = this.sessions.get(token);
    if (expires === undefined) return false;
    if (expires <= Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  /**
   * Read the panel session token from the cookie header.
   * @param {import('node:http').IncomingMessage} request incoming request.
   * @returns {string} token or an empty string.
   */
  cookieToken(request: import('node:http').IncomingMessage): string {
    const header = request.headers.cookie;
    if (typeof header !== 'string') return '';
    for (const part of header.split(';')) {
      const item = part.trim();
      const separator = item.indexOf('=');
      if (separator <= 0) continue;
      if (item.slice(0, separator) === COOKIE_NAME) return item.slice(separator + 1);
    }
    return '';
  }

  /**
   * Validate the password from the login form and start a session.
   * @param {import('node:http').IncomingMessage} request incoming request.
   * @param {import('node:http').ServerResponse} response response.
   * @returns {Promise<void>}
   */
  async handleLogin(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    const code = this.options.getAccessCode();
    if (!code) {
      response.writeHead(303, { location: '/', 'cache-control': 'no-store', 'content-length': 0 });
      response.end();
      return;
    }
    let form: URLSearchParams;
    try {
      form = await readForm(request);
    } catch {
      this.writeLogin(response, true, 400);
      return;
    }
    if (!secretsMatch(form.get('password') ?? '', code)) {
      this.writeLogin(response, true, 401);
      return;
    }
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    if (this.sessions.size > 128) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    response.writeHead(303, {
      location: '/',
      'set-cookie': `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      'cache-control': 'no-store',
      'content-length': 0,
    });
    response.end();
  }

  /**
   * Clear the session and return to the login page.
   * @param {import('node:http').IncomingMessage} request incoming request.
   * @param {import('node:http').ServerResponse} response response.
   * @returns {void}
   */
  handleLogout(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): void {
    const token = this.cookieToken(request);
    if (token) this.sessions.delete(token);
    response.writeHead(303, {
      location: '/',
      'set-cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      'cache-control': 'no-store',
      'content-length': 0,
    });
    response.end();
  }

  /**
   * Render the in-page login form. No Basic-auth challenge is sent, so browsers
   * never show their native credentials dialog.
   * @param {import('node:http').ServerResponse} response response.
   * @param {boolean} [failed] whether the last attempt failed.
   * @param {number} [status] HTTP status.
   * @returns {void}
   */
  writeLogin(response: import('node:http').ServerResponse, failed = false, status = 200): void {
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'">
<title>WireGuard 控制面板 · 登录</title>
<style>
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f7fb; color: #152033; }
main { width: min(420px, calc(100vw - 40px)); margin: 40px 0; padding: 28px; border-radius: 18px; background: #fff; box-shadow: 0 18px 60px rgba(23, 44, 75, .12); }
h1 { margin: 0 0 6px; font-size: 24px; letter-spacing: -.02em; }
p { color: #5b6b82; line-height: 1.55; }
.badge { display: inline-block; padding: 3px 9px; border-radius: 999px; background: #eef3fa; color: #27456f; font-size: 12px; font-weight: 600; }
label { display: block; margin: 22px 0 8px; color: #5b6b82; font-size: 13px; }
input { width: 100%; box-sizing: border-box; padding: 11px 12px; border: 1px solid #cbd7e6; border-radius: 9px; background: #fff; color: #152033; font: inherit; }
input:focus { outline: 2px solid #2f7cff; outline-offset: 1px; border-color: transparent; }
button { width: 100%; margin-top: 14px; padding: 11px 14px; border: 0; border-radius: 9px; background: #2f7cff; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
button:hover { background: #1f6ae5; }
.error { margin: 14px 0 0; padding: 10px 12px; border-radius: 8px; background: #fff1f0; color: #b42318; font-size: 13px; }
.note { margin: 18px 0 0; font-size: 12px; color: #7a8aa0; }
@media (prefers-color-scheme: dark) { body { background: #0d1420; color: #e6edf7; } main { background: #151f2e; box-shadow: none; } p, label { color: #9babc2; } .badge { background: #17263b; color: #c1d4ef; } input { background: #0f1927; border-color: #2a3a52; color: #e6edf7; } .error { background: #3a1717; color: #ffb4ab; } .note { color: #7f90a8; } }
</style>
</head>
<body>
<main>
  <span class="badge">WIREGUARD</span>
  <h1>控制面板登录</h1>
  <p>请输入加入码。加入码同时作为控制面板密码。</p>
  <form method="post" action="/login">
    <label for="password">加入码 / 控制面板密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">登录</button>
  </form>
  ${failed ? '<p class="error">密码错误，请重试。 / Incorrect password.</p>' : ''}
  <p class="note">The join code is also the control-panel password.</p>
</main>
</body>
</html>`;
    response.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(html);
  }

  /**
   * Validate the optional join code against the live server configuration.
   * @param {string} supplied code from a request.
   * @returns {void}
   */
  assertCode(supplied: string): void {
    const info = this.options.getServerInfo();
    const required = info.joinRequired === true;
    if (required && !secretsMatch(supplied, String(info.joinCode ?? ''))) {
      throw new WireGuardError('invalid_join_code', 'The join code is missing or incorrect.', { status: 401 });
    }
  }

  /**
   * Fixed-window per-IP rate limit. LAN join traffic is tiny; this only stops
   * runaway retries and casual probing.
   * @param {string} key remote address.
   * @returns {boolean} whether the request is admitted.
   */
  allow(key: string): boolean {
    const now = Date.now();
    const recent = (this.attempts.get(key) ?? []).filter((stamp) => now - stamp < RATE_WINDOW_MS);
    recent.push(now);
    this.attempts.set(key, recent);
    if (this.attempts.size > 512) {
      for (const [address, stamps] of this.attempts) {
        if (stamps.every((stamp) => now - stamp >= RATE_WINDOW_MS)) this.attempts.delete(address);
      }
    }
    return recent.length <= RATE_LIMIT;
  }

  /**
   * @param {import('node:http').ServerResponse} response response.
   * @param {unknown} error failure.
   * @returns {void}
   */
  writeError(response, error) {
    if (error instanceof WireGuardError) {
      writeJson(response, error.status, { ok: false, error: error.toJSON() });
      return;
    }
    this.log(`control panel operation failed: ${error instanceof Error ? error.message : String(error)}`);
    writeJson(response, 500, { ok: false, error: { code: 'internal_error', message: 'The control-panel operation failed.' } });
  }

  /**
   * Render the status page shown when the port is opened in a browser. It is
   * password-protected when configured and never includes the join code or
   * peer identities.
   * @param {import('node:http').ServerResponse} response response.
   * @returns {void}
   */
  writePage(response) {
    const info = this.options.getServerInfo();
    const peers = this.options.getPeers();
    const protectedPage = Boolean(this.options.getAccessCode());
    const endpoint = escapeHtml(info.endpoint ?? 'not available');
    const control = escapeHtml(String(info.controlUrl ?? `http://${info.endpointHost ?? 'server'}:${info.controlPort ?? ''}`));
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'">
<title>WireGuard control panel</title>
<style>
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f7fb; color: #152033; }
main { width: min(640px, calc(100vw - 40px)); margin: 40px 0; padding: 28px; border-radius: 18px; background: #fff; box-shadow: 0 18px 60px rgba(23, 44, 75, .12); }
h1 { margin: 0 0 6px; font-size: 24px; letter-spacing: -.02em; }
p { color: #5b6b82; line-height: 1.55; }
.badge { display: inline-block; padding: 3px 9px; border-radius: 999px; background: #e6f7ee; color: #147a4b; font-size: 12px; font-weight: 600; }
dl { display: grid; grid-template-columns: 150px 1fr; gap: 10px 16px; margin: 22px 0; }
dt { color: #5b6b82; font-size: 13px; }
dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; overflow-wrap: anywhere; }
code { background: #eef3fa; padding: 2px 6px; border-radius: 5px; }
.note { padding: 12px 14px; border-radius: 10px; background: #f0f6ff; color: #27456f; font-size: 13px; }
.logout { margin-top: 18px; }
.logout button { border: 0; border-radius: 8px; padding: 7px 11px; background: #eef3fa; color: #27456f; font: inherit; cursor: pointer; }
@media (prefers-color-scheme: dark) { body { background: #0d1420; color: #e6edf7; } main { background: #151f2e; box-shadow: none; } p, dt { color: #9babc2; } .badge { background: #123a2a; color: #72e4ad; } .note { background: #17263b; color: #c1d4ef; } code { background: #202e42; } .logout button { background: #202e42; color: #c1d4ef; } }
</style>
</head>
<body>
<main>
  <span class="badge">RUNNING</span>
  <h1>WireGuard control panel</h1>
  <p>This machine is running a DSH WireGuard server. Open the WireGuard panel in a DSH client, choose <strong>Client</strong>, and enter this server's address.</p>
  <dl>
    <dt>Control address</dt><dd><code>${control}</code></dd>
    <dt>WireGuard endpoint</dt><dd>${endpoint}</dd>
    <dt>VPN subnet</dt><dd>${escapeHtml(info.vpnCidr ?? '')}</dd>
    <dt>Server public key</dt><dd>${escapeHtml(info.publicKey ?? '')}</dd>
    <dt>Connected peers</dt><dd>${peers.length}</dd>
    <dt>Join code / password</dt><dd>${info.joinRequired ? 'required — ask the server operator' : 'not required — anyone who can reach this port may join'}</dd>
    <dt>Panel access</dt><dd>${protectedPage ? 'join code / password protected' : 'open — no join code is set'}</dd>
  </dl>
  <div class="note">Client address example: <code>${endpoint}</code> in the Client tab. ${protectedPage ? 'This page is protected by the join code, which is also the control-panel password.' : 'This page has no password. Set a join code in the WireGuard plugin before exposing this port.'} The control panel uses plain HTTP and never exposes a private key.</div>
  ${protectedPage ? '<form method="post" action="/logout" class="logout"><button type="submit">退出登录 / Sign out</button></form>' : ''}
</main>
</body>
</html>`;
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(html);
  }
}
