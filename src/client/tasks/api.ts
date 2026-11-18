/** Browser API for the 任务 tab: one shared task list behind the panel. */

import type {
  TaskDoc,
  TaskRun,
  TaskRunSummary,
  TaskSnapshot,
  TaskTemplate,
} from '../../wireguard/lib/task-model';

export type { TaskChildRef, TaskDoc, TaskNode, TaskRun, TaskRunSummary, TaskSnapshot, TaskTemplate } from '../../wireguard/lib/task-model';

const PREFIX = '/api/dsh-wireguard/tasks';

/** Workspaces a member exposes below `~/.dsh/workspaces`. */
export interface WorkspaceListing {
  dir: string;
  workspaces: Array<{ name: string }>;
}

/** A failure the panel can show as-is. */
export class TaskApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'TaskApiError';
    this.status = status;
    this.code = code;
  }
}

const OFFLINE = '连不上控制服务，可能正在重启，请稍后重试。';

/**
 * One JSON request against the task API.
 * @param path path below the tasks prefix.
 * @param init fetch options.
 * @returns parsed body.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET';
  let response: Response;
  try {
    response = await fetch(`${PREFIX}${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(method === 'POST' ? { 'content-type': 'application/json', 'x-dsh-wireguard': '1' } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new TaskApiError(OFFLINE, 0, 'offline');
  }
  const text = await response.text();
  let body: Record<string, any>;
  try {
    body = text === '' ? {} : JSON.parse(text) as Record<string, any>;
  } catch {
    throw new TaskApiError(`服务返回了无法解析的内容（HTTP ${String(response.status)}）。`, response.status, 'invalid_body');
  }
  if (!response.ok || body.ok === false) {
    const message = typeof body?.error?.message === 'string' ? body.error.message : `HTTP ${String(response.status)}`;
    throw new TaskApiError(message, response.status, typeof body?.error?.code === 'string' ? body.error.code : 'failed');
  }
  return body as T;
}

/**
 * Read one run's full definition.
 * @param id run id.
 * @returns the run.
 */
async function readRun(id: string): Promise<TaskRun> {
  const body = await request<{ run: TaskRun }>(`/runs/${encodeURIComponent(id)}`);
  return body.run;
}

export const taskApi = {
  /** Draft, templates and recent launches. */
  async snapshot(): Promise<TaskSnapshot> {
    return (await request<{ tasks: TaskSnapshot }>('')).tasks;
  },

  /** Persist the object being edited. */
  async setDraft(doc: TaskDoc): Promise<TaskSnapshot> {
    return (await request<{ tasks: TaskSnapshot }>('/draft', { method: 'POST', body: JSON.stringify({ doc }) })).tasks;
  },

  /** Save the current document under a name. */
  async createTemplate(name: string, doc: TaskDoc): Promise<TaskSnapshot> {
    return (await request<{ tasks: TaskSnapshot }>('/templates/create', { method: 'POST', body: JSON.stringify({ name, doc }) })).tasks;
  },

  /** Rename a template. */
  async renameTemplate(id: string, name: string): Promise<TaskSnapshot> {
    return (await request<{ tasks: TaskSnapshot }>('/templates/rename', { method: 'POST', body: JSON.stringify({ id, name }) })).tasks;
  },

  /** Overwrite a template with the current document. */
  async updateTemplate(id: string, doc: TaskDoc): Promise<TaskSnapshot> {
    return (await request<{ tasks: TaskSnapshot }>('/templates/update', { method: 'POST', body: JSON.stringify({ id, doc }) })).tasks;
  },

  /** Delete a template. */
  async deleteTemplate(id: string): Promise<TaskSnapshot> {
    return (await request<{ tasks: TaskSnapshot }>('/templates/delete', { method: 'POST', body: JSON.stringify({ id }) })).tasks;
  },

  /** Workspaces below the target member's `~/.dsh/workspaces`. */
  async workspaces(member: string): Promise<WorkspaceListing> {
    const query = new URLSearchParams({ member }).toString();
    return request<WorkspaceListing>(`/workspaces?${query}`);
  },

  /** Render the task on the gateway and launch it. */
  async launch(input: { doc: TaskDoc; title: string; member: string; workspace: string }): Promise<{ run: TaskRunSummary; tasks: TaskSnapshot }> {
    return request<{ run: TaskRunSummary; tasks: TaskSnapshot }>('/launch', { method: 'POST', body: JSON.stringify(input) });
  },

  /** Remove the finished launches from 历史. */
  async clearRuns(): Promise<TaskSnapshot> {
    return (await request<{ tasks: TaskSnapshot }>('/runs/clear', { method: 'POST', body: JSON.stringify({}) })).tasks;
  },

  /** One historical run with its full snapshot. */
  readRun,
};
