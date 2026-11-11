import assert from 'node:assert/strict';
import test from 'node:test';
import { api, API_PREFIX } from '../../src/client/wireguard/api';

test('parameterless mutations are POSTed with the agent header and an empty body', async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const path = new URL(String(input), 'http://local.invalid').pathname;
    calls.push({ path, init });
    return new Response(JSON.stringify({ ok: true, state: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await api.stopServer();
    await api.retryClient();
    await api.disconnectClient();
  } finally {
    globalThis.fetch = original;
  }

  assert.deepEqual(calls.map((call) => call.path), [
    `${API_PREFIX}/server/stop`,
    `${API_PREFIX}/client/retry`,
    `${API_PREFIX}/client/disconnect`,
  ]);
  for (const { init } of calls) {
    assert.equal(init.method, 'POST');
    assert.equal((init.headers as Record<string, string>)['x-dsh-wireguard'], '1');
    assert.equal(init.body, '{}');
  }
});

test('state reads stay cache-free GET requests', async () => {
  let call: { init: RequestInit } | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init: RequestInit = {}) => {
    call = { init };
    return new Response(JSON.stringify({ ok: true, state: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await api.state();
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(call?.init.method, 'GET');
  assert.equal(call?.init.cache, 'no-store');
  assert.equal((call?.init.headers as Record<string, string>)['x-dsh-wireguard'], undefined);
});
