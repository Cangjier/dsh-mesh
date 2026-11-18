import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { addNode, normalizeDoc, type TaskDoc } from '../../src/wireguard/lib/task-model';
import { TaskService } from '../../src/wireguard/lib/task-service';
import { WireGuardError } from '../../src/wireguard/lib/errors';

/** One recorded upstream call. */
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A fetch stand-in that answers from a routing table.
 * @param routes function returning `{ status, body }` for a call.
 * @returns fetch implementation plus the recorded calls.
 */
function fakeFetch(routes: (call: Call) => { status: number; body: unknown }): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    };
    calls.push(call);
    const answer = routes(call);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

/**
 * One service over a temporary directory.
 * @param options extra options.
 * @returns service plus its directory.
 */
async function serviceOf(options: Partial<ConstructorParameters<typeof TaskService>[0]> = {}): Promise<{ service: TaskService; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-tasks-'));
  const service = new TaskService({
    dir,
    log: () => {},
    members: () => [
      { id: 'local', name: 'gateway', ip: '10.66.66.1' },
      { id: '10.66.66.2', name: 'build-1', ip: '10.66.66.2' },
    ],
    interopToken: () => 'secret',
    selfName: 'gateway',
    ...options,
  });
  await service.init();
  return { service, dir };
}

/**
 * A two-object task.
 * @returns document.
 */
function sampleDoc(): TaskDoc {
  const first = addNode({ nodes: [] }, { source: 'src/a.ts', define: '读一遍' });
  const second = addNode(first.doc, { parentId: 0, source: 'src/b.ts', define: '再改' });
  return second.doc;
}

test('the draft survives a restart', async () => {
  const { service, dir } = await serviceOf();
  try {
    await service.setDraft(sampleDoc());
    const reopened = new TaskService({ dir, members: () => [], interopToken: () => 'secret' });
    await reopened.init();
    const snapshot = await reopened.snapshot();
    assert.deepEqual(snapshot.draft.nodes.map((node) => node.id), [0, 1]);
    assert.equal(snapshot.draft.nodes[1].children.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('templates create, rename, overwrite and delete', async () => {
  const { service, dir } = await serviceOf();
  try {
    await service.createTemplate('重建', sampleDoc());
    let snapshot = await service.snapshot();
    assert.equal(snapshot.templates.length, 1);
    const id = snapshot.templates[0].id;

    // A second template with the same name gets a suffix instead of a clash.
    await service.createTemplate('重建', { nodes: [] });
    snapshot = await service.snapshot();
    assert.deepEqual(snapshot.templates.map((template) => template.name), ['重建', '重建 (2)']);

    await service.renameTemplate(id, '重构');
    snapshot = await service.snapshot();
    assert.equal(snapshot.templates[0].name, '重构');
    await assert.rejects(() => service.renameTemplate(id, '重建 (2)'), (error: unknown) => (
      error instanceof WireGuardError && error.code === 'template_name_taken'
    ));

    await service.updateTemplate(id, { nodes: [{ id: 0, source: 'x', define: '', children: [] }] });
    snapshot = await service.snapshot();
    assert.equal(snapshot.templates[0].doc.nodes.length, 1);

    await service.deleteTemplate(id);
    snapshot = await service.snapshot();
    assert.deepEqual(snapshot.templates.map((template) => template.name), ['重建 (2)']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('launching opens a local coordinator that delegates to the executor', async () => {
  const { fetch, calls } = fakeFetch((call) => {
    if (call.method === 'POST' && call.url.endsWith('/v1/conversations')) return { status: 201, body: { ok: true, conversation: { id: 'c-1' } } };
    if (call.method === 'GET' && call.url.endsWith('/v1/conversations/c-1')) return { status: 200, body: { ok: true, conversation: { id: 'c-1', status: 'idle' } } };
    if (call.method === 'GET' && call.url.endsWith('/v1/conversations/c-1/result')) return { status: 200, body: { ok: true, finalText: '验收通过' } };
    return { status: 404, body: { ok: false, error: { message: 'nope' } } };
  });
  const { service, dir } = await serviceOf({ fetchImpl: fetch });
  try {
    const launched = await service.launch({ doc: sampleDoc(), title: '重建面板', workspace: 'demo' });
    assert.equal(launched.run.status, 'running');
    // The conversation is the local coordinator's, not the member's.
    assert.equal(launched.run.conversationId, 'c-1');
    assert.equal(launched.run.member?.ip, '10.66.66.2');
    assert.equal(launched.run.manager?.ip, '10.66.66.1');
    assert.equal(launched.run.workspace, 'demo');
    assert.equal(launched.run.cwd, '~/.dsh/workspaces/demo');
    assert.equal(launched.tasks.runs.length, 1);

    const created = calls[0];
    assert.equal(created.url, 'http://10.66.66.1:8765/v1/conversations');
    assert.equal(created.headers.authorization, 'Bearer secret');
    const payload = created.body as Record<string, unknown>;
    assert.equal(payload.title, '重建面板 · 协调');
    assert.equal(payload.workspace, 'demo');
    assert.equal(payload.cwd, undefined);
    const prompt = String(payload.prompt);
    assert.match(prompt, /管理者、协调者和验收者/u);
    assert.match(prompt, /build-1（10\.66\.66\.2）/u);
    assert.match(prompt, /workspace="demo"/u);
    assert.match(prompt, /~\/\.dsh\/workspaces\/demo/u);
    assert.match(prompt, /### #0 · src\/a\.ts/u);

    // The stored snapshot is what the panel shows in 历史.
    const run = await service.run(launched.run.id);
    assert.equal(run.status, 'completed');
    assert.equal(run.result, '验收通过');
    assert.equal(run.doc.nodes.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the local member cannot be the executor', async () => {
  const { fetch, calls } = fakeFetch(() => ({ status: 500, body: {} }));
  const { service, dir } = await serviceOf({ fetchImpl: fetch });
  try {
    await assert.rejects(() => service.launch({ doc: sampleDoc(), member: 'local' }), (error: unknown) => (
      error instanceof WireGuardError && error.code === 'local_member_not_allowed'
    ));
    assert.equal(calls.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('workspaces are read from the selected member', async () => {
  const { fetch, calls } = fakeFetch((call) => {
    if (call.method === 'GET' && call.url.endsWith('/v1/workspaces')) {
      return { status: 200, body: { ok: true, dir: '/home/dsh/.dsh/workspaces', workspaces: [{ name: 'demo', path: '/home/dsh/.dsh/workspaces/demo' }, { name: 'web', path: '/home/dsh/.dsh/workspaces/web' }] } };
    }
    return { status: 404, body: {} };
  });
  const { service, dir } = await serviceOf({ fetchImpl: fetch });
  try {
    const listing = await service.workspaces('10.66.66.2');
    assert.equal(calls[0].url, 'http://10.66.66.2:8765/v1/workspaces');
    assert.equal(calls[0].headers.authorization, 'Bearer secret');
    assert.equal(listing.dir, '/home/dsh/.dsh/workspaces');
    assert.deepEqual(listing.workspaces.map((item) => item.name), ['demo', 'web']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('clearing 历史 keeps running launches', async () => {
  const { fetch } = fakeFetch((call) => {
    if (call.method === 'POST' && call.url.endsWith('/v1/conversations')) return { status: 201, body: { ok: true, conversation: { id: `c-${String(Date.now())}` } } };
    if (call.method === 'GET' && call.url.includes('/v1/conversations/')) return { status: 200, body: { ok: true, conversation: { id: 'c', status: 'running' } } };
    return { status: 404, body: {} };
  });
  const { service, dir } = await serviceOf({ fetchImpl: fetch });
  try {
    await service.launch({ doc: sampleDoc(), workspace: 'demo' });
    await service.launch({ doc: sampleDoc(), workspace: 'demo' });
    // One run finished; the other is still in flight.
    service.store.data.runs[0].status = 'completed';
    const snapshot = await service.clearRuns();
    assert.equal(snapshot.runs.length, 1);
    assert.equal(snapshot.runs[0].status, 'running');
    assert.equal(snapshot.runs[0].workspace, 'demo');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a launch on a missing member fails before touching the network', async () => {
  const { fetch, calls } = fakeFetch(() => ({ status: 500, body: {} }));
  const { service, dir } = await serviceOf({ fetchImpl: fetch });
  try {
    await assert.rejects(() => service.launch({ doc: sampleDoc(), member: '10.9.9.9' }), (error: unknown) => (
      error instanceof WireGuardError && error.code === 'member_not_found'
    ));
    assert.equal(calls.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an empty task is refused', async () => {
  const { service, dir } = await serviceOf();
  try {
    await assert.rejects(() => service.launch({ doc: { nodes: [] } }), (error: unknown) => (
      error instanceof WireGuardError && error.code === 'task_empty'
    ));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed conversation marks the run failed', async () => {
  const { fetch } = fakeFetch((call) => {
    if (call.method === 'POST') return { status: 201, body: { ok: true, conversation: { id: 'c-2' } } };
    if (call.url.endsWith('/v1/conversations/c-2')) return { status: 200, body: { ok: true, conversation: { id: 'c-2', status: 'unavailable', error: 'SDK runtime exited' } } };
    return { status: 404, body: {} };
  });
  const { service, dir } = await serviceOf({ fetchImpl: fetch });
  try {
    const launched = await service.launch({ doc: sampleDoc() });
    const run = await service.run(launched.run.id);
    assert.equal(run.status, 'failed');
    assert.equal(run.error, 'SDK runtime exited');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an empty final text is retried before it is believed', async () => {
  let results = 0;
  const { fetch } = fakeFetch((call) => {
    if (call.method === 'POST') return { status: 201, body: { ok: true, conversation: { id: 'c-3' } } };
    if (call.url.endsWith('/v1/conversations/c-3')) return { status: 200, body: { ok: true, conversation: { id: 'c-3', status: 'idle' } } };
    if (call.url.endsWith('/v1/conversations/c-3/result')) {
      results += 1;
      return { status: 200, body: { ok: true, finalText: results === 1 ? '' : '第二次读到了' } };
    }
    return { status: 404, body: {} };
  });
  const { service, dir } = await serviceOf({ fetchImpl: fetch });
  try {
    const launched = await service.launch({ doc: sampleDoc() });
    const run = await service.run(launched.run.id);
    assert.equal(run.status, 'completed');
    assert.equal(run.result, '第二次读到了');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a member forwards everything to the gateway with its agent token', async () => {
  const { fetch, calls } = fakeFetch((call) => {
    if (call.url.endsWith('/tasks') && call.method === 'GET') {
      return { status: 200, body: { ok: true, tasks: { draft: normalizeDoc(sampleDoc()), templates: [], runs: [] } } };
    }
    if (call.url.endsWith('/tasks/draft')) {
      return { status: 200, body: { ok: true, tasks: { draft: normalizeDoc(sampleDoc()), templates: [], runs: [] } } };
    }
    return { status: 200, body: { ok: true, tasks: { draft: { nodes: [] }, templates: [], runs: [] } } };
  });
  const { service, dir } = await serviceOf({
    fetchImpl: fetch,
    remote: () => ({ baseUrl: 'http://10.66.66.1:51821/', token: 'peer-token' }),
  });
  try {
    const snapshot = await service.snapshot();
    assert.equal(snapshot.draft.nodes.length, 2);
    assert.equal(calls[0].url, 'http://10.66.66.1:51821/api/dsh-wireguard/tasks');
    assert.equal(calls[0].headers['x-dsh-peer-token'], 'peer-token');
    await service.setDraft(sampleDoc());
    assert.equal(calls[1].url, 'http://10.66.66.1:51821/api/dsh-wireguard/tasks/draft');
    // The member never writes its own copy while delegated.
    await assert.rejects(() => readFile(path.join(dir, 'tasks.json'), 'utf8'), /ENOENT/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a member forwards workspace listing and 历史 clearing to the gateway', async () => {
  const { fetch, calls } = fakeFetch((call) => {
    if (call.url.includes('/tasks/workspaces')) {
      return { status: 200, body: { ok: true, dir: '/home/dsh/.dsh/workspaces', workspaces: [{ name: 'demo' }] } };
    }
    if (call.url.endsWith('/tasks/runs/clear')) {
      return { status: 200, body: { ok: true, tasks: { draft: { nodes: [] }, templates: [], runs: [] } } };
    }
    return { status: 200, body: { ok: true, tasks: { draft: { nodes: [] }, templates: [], runs: [] } } };
  });
  const { service, dir } = await serviceOf({
    fetchImpl: fetch,
    remote: () => ({ baseUrl: 'http://10.66.66.1:51821/', token: 'peer-token' }),
  });
  try {
    const listing = await service.workspaces('10.66.66.2');
    assert.equal(calls[0].url, 'http://10.66.66.1:51821/api/dsh-wireguard/tasks/workspaces?member=10.66.66.2');
    assert.equal(calls[0].headers['x-dsh-peer-token'], 'peer-token');
    assert.deepEqual(listing.workspaces, [{ name: 'demo' }]);
    const snapshot = await service.clearRuns();
    assert.equal(calls[1].url, 'http://10.66.66.1:51821/api/dsh-wireguard/tasks/runs/clear');
    assert.deepEqual(snapshot.runs, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('secrets never land in the state file', async () => {
  const { service, dir } = await serviceOf();
  try {
    await service.createTemplate('t', sampleDoc());
    const raw = await readFile(path.join(dir, 'tasks.json'), 'utf8');
    assert.doesNotMatch(raw, /secret/u);
    assert.doesNotMatch(raw, /Bearer/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
