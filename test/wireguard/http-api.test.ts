import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { API_PREFIX } from '../../src/wireguard/lib/constants';
import { createControlExtraHandler } from '../../src/wireguard/lib/http-api';

/**
 * Start a listener that mimics the standalone control service: the extra
 * handler runs first, and anything it declines is answered as a panel route.
 * @returns {Promise<{ base: string; close: () => Promise<void> }>} listener.
 */
async function startPanel() {
  const service = {
    getState: async () => ({ role: 'idle' }),
    snapshot: () => ({ role: 'idle' }),
  };
  const extra = createControlExtraHandler(service as never);
  const server = createServer((request, response) => {
    void extra(request, response).then((handled) => {
      if (handled) return;
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('panel');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('the control-service extra handler owns only its own API prefix on loopback', async () => {
  const panel = await startPanel();
  try {
    const state = await fetch(`${panel.base}${API_PREFIX}/state`);
    assert.equal(state.status, 200);
    assert.deepEqual(await state.json(), { ok: true, state: { role: 'idle' } });

    for (const [method, path] of [
      ['GET', '/health'],
      ['GET', '/client.sh'],
      ['GET', '/'],
      ['POST', '/join'],
      ['POST', '/leave'],
    ] as const) {
      const answer = await fetch(`${panel.base}${path}`, { method });
      assert.equal(answer.status, 200, `${method} ${path} must reach the control panel`);
      assert.equal(await answer.text(), 'panel', `${method} ${path} must reach the control panel`);
    }
  } finally {
    await panel.close();
  }
});

test('the control-service extra handler ignores requests from other hosts', async () => {
  const extra = createControlExtraHandler({
    getState: async () => {
      throw new Error('the panel API must not run for a remote peer');
    },
  } as never);
  for (const path of [`${API_PREFIX}/state`, `${API_PREFIX}/server/stop`]) {
    const handled = await extra(
      { url: path, socket: { remoteAddress: '203.0.113.9' } } as never,
      {} as never,
    );
    assert.equal(handled, false, `${path} must fall through to the control panel`);
  }
});
