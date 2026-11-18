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
async function startPanel(overrides: Record<string, unknown> = {}) {
  const service = {
    getState: async () => ({ role: 'idle' }),
    snapshot: () => ({ role: 'idle' }),
    ...overrides,
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

test('task routes expose a member workspace list and clear 历史', async () => {
  const calls: Array<[string, unknown]> = [];
  const tasks = {
    async workspaces(member: string) {
      calls.push(['workspaces', member]);
      return { dir: '/home/dsh/.dsh/workspaces', workspaces: [{ name: 'demo' }] };
    },
    async clearRuns() {
      calls.push(['clear', null]);
      return { draft: { nodes: [] }, templates: [], runs: [] };
    },
  };
  const panel = await startPanel({ tasks });
  try {
    const listing = await fetch(`${panel.base}${API_PREFIX}/tasks/workspaces?member=10.66.66.2`);
    assert.equal(listing.status, 200);
    assert.deepEqual(await listing.json(), {
      ok: true,
      dir: '/home/dsh/.dsh/workspaces',
      workspaces: [{ name: 'demo' }],
    });

    const cleared = await fetch(`${panel.base}${API_PREFIX}/tasks/runs/clear`, {
      method: 'POST',
      headers: { 'x-dsh-wireguard': '1', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), {
      ok: true,
      tasks: { draft: { nodes: [] }, templates: [], runs: [] },
    });
    assert.deepEqual(calls, [['workspaces', '10.66.66.2'], ['clear', null]]);
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
