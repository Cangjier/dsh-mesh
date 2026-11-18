/**
 * The 发起任务 feature: one shared task list, its templates, and the launches
 * that were started from it.
 *
 * Storage is the gateway control service. A member delegates every task
 * request to the gateway over the WireGuard tunnel, authorized by its own
 * per-peer agent token, so all members edit the same templates and read the
 * same history. Launching renders the task as markdown and creates a
 * **coordinator conversation on the gateway itself**; that conversation
 * delegates the work to the chosen member, accepts the result, and is what the
 * run tracks to completion.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { API_PREFIX } from './constants';
import { WireGuardError } from './errors';
import {
  MAX_TITLE_CHARS,
  cleanText,
  normalizeDoc,
  renderTaskMarkdown,
  summarize,
  type TaskDoc,
  type TaskRun,
  type TaskRunSummary,
  type TaskSnapshot,
  type TaskTemplate,
} from './task-model';
import { MAX_RESULT_CHARS, TaskStore, pruneRuns } from './task-store';

/** One place a task can be launched on. */
export interface TaskMember {
  id: string;
  name: string;
  ip: string;
}

/** Task workspaces a member exposes below `~/.dsh/workspaces`. */
export interface TaskWorkspaces {
  /** Absolute workspace root on that member. */
  dir: string;
  workspaces: Array<{ name: string }>;
}

/** Options the control service passes in. */
export interface TaskServiceOptions {
  /** Directory holding tasks.json. */
  dir: string;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Interop port on every member. */
  interopPort?: number;
  /** Login token for member interop services. */
  interopToken?: () => string | null;
  /** Members this machine may launch on, this machine first. */
  members?: () => TaskMember[];
  /** Non-null when another machine owns the store (this one is a member). */
  remote?: () => { baseUrl: string; token: string } | null;
  /** Name shown as the initiator of a launch. */
  selfName?: string;
}

/** Interop statuses that keep a run in flight. */
const LIVE_STATUS = new Set(['blank', 'running']);

/**
 * Read a simple KEY=VALUE file.
 * @param file path.
 * @returns entries.
 */
export function readEnvFile(file: string): Record<string, string> {
  const result: Record<string, string> = {};
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return result;
  }
  for (const line of raw.split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (match === null) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}

/**
 * Directories that may contain `config/gate.env` or `config/interop.env`.
 * @returns candidate roots, nearest first.
 */
export function tokenRoots(): string[] {
  const roots: string[] = [];
  let current = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    roots.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

/**
 * The token member interop services accept.
 *
 * The same value is what the mesh host plugin uses: an explicit
 * `DSH_INTEROP_TOKEN`, or the gate password all members were installed with.
 * @param roots directories to search.
 * @returns token or null.
 */
export function findInteropToken(roots: string[] = tokenRoots()): string | null {
  for (const name of ['DSH_TASKS_INTEROP_TOKEN', 'DSH_INTEROP_TOKEN', 'DSH_GATE_PASSWORD']) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  for (const root of roots) {
    const interop = readEnvFile(path.join(root, 'config', 'interop.env'));
    if (interop.DSH_INTEROP_TOKEN !== undefined && interop.DSH_INTEROP_TOKEN !== '') return interop.DSH_INTEROP_TOKEN;
    const gate = readEnvFile(path.join(root, 'config', 'gate.env'));
    if (gate.DSH_GATE_PASSWORD !== undefined && gate.DSH_GATE_PASSWORD !== '') return gate.DSH_GATE_PASSWORD;
  }
  return null;
}

/**
 * Trim one run to its list fields.
 * @param run full run.
 * @returns summary.
 */
export function runSummary(run: TaskRun): TaskRunSummary {
  const preview = run.result.replace(/\s+/gu, ' ').trim();
  return {
    id: run.id,
    title: run.title,
    status: run.status,
    member: run.member,
    manager: run.manager ?? null,
    workspace: run.workspace ?? null,
    cwd: run.cwd,
    conversationId: run.conversationId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    nodeCount: run.doc.nodes.length,
    resultPreview: preview.length > 160 ? `${preview.slice(0, 160)}…` : preview,
    error: run.error,
  };
}

/**
 * Validate one task workspace name.
 *
 * The name addresses exactly one directory below `~/.dsh/workspaces`, so path
 * separators and `.` / `..` are refused instead of being silently normalized.
 * @param value raw name.
 * @returns name, or null when the caller sent nothing.
 */
function cleanWorkspace(value: unknown): string | null {
  const name = cleanText(value, 120);
  if (name === '') return null;
  if (name === '.' || name === '..' || /[\\/"]/u.test(name) || /[\u0000-\u001f]/u.test(name)) {
    throw new WireGuardError('workspace_invalid', '工作目录名称不能包含路径分隔符或引号。', { status: 400 });
  }
  return name;
}

/**
 * Keep only usable workspace names from a member's answer.
 * @param value raw list.
 * @param dir raw root path.
 * @returns normalized listing.
 */
function normalizeWorkspaces(value: unknown, dir: unknown): TaskWorkspaces {
  const list = Array.isArray(value) ? value : [];
  const workspaces: Array<{ name: string }> = [];
  const seen = new Set<string>();
  for (const item of list) {
    const name = item !== null && typeof item === 'object'
      ? cleanText((item as Record<string, unknown>).name, 120)
      : '';
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    workspaces.push({ name });
  }
  return { dir: cleanText(dir, 400), workspaces };
}

/**
 * The prompt that turns the local conversation into the task coordinator.
 *
 * The target executes; the coordinator delegates, waits, and accepts. Being
 * explicit about the tool arguments matters: `call_member` supports a
 * `workspace` name, and the target resolves it under its own home instead of
 * receiving the gateway's absolute path.
 * @param input run details.
 * @returns markdown prompt.
 */
function coordinatorPrompt(input: {
  title: string;
  markdown: string;
  target: TaskMember;
  workspace: string | null;
}): string {
  const { title, markdown, target, workspace } = input;
  const delegateArgs = [
    'action="delegate"',
    `member="${target.ip}"`,
    ...(workspace === null ? [] : [`workspace="${workspace}"`]),
  ].join('，');
  return [
    `# 协调任务：${title}`,
    '',
    '你是这次任务的管理者、协调者和验收者，**不负责具体执行**：不要自己修改文件或执行任务里的命令。',
    '',
    `- 执行成员：${target.name}（${target.ip}）`,
    ...(workspace === null ? [] : [`- 工作目录：~/.dsh/workspaces/${workspace}（执行成员本机的实际目录）`]),
    '',
    '## 执行方式',
    `1. 用 \`call_member\`（${delegateArgs}）把「## 任务」下的 markdown 原样作为 prompt 交给执行成员，并写清验收要求。`,
    '2. 用 `wait_member` 等待：state=progress 表示还在进行，继续用同一个 taskId 等待；state=done 才是最终结果。',
    '3. 验收：对照任务定义检查结果；不通过时用 `call_member`（action="send"）让执行成员补做，再继续等待。',
    '4. 最后给出：验收结论（通过 / 不通过）、改动清单、验证方式、遗留问题。',
    '',
    '## 任务',
    '',
    markdown,
  ].join('\n');
}

/**
 * Everything the 发起任务 tab needs from one machine.
 */
export class TaskService {
  readonly store: TaskStore;
  readonly now: () => number;
  readonly logger: (line: string) => void;
  readonly fetchImpl: typeof fetch;
  readonly interopPort: number;
  readonly options: TaskServiceOptions;
  #lastRefresh = 0;
  #refreshing: Promise<void> | null = null;

  /**
   * @param options service options.
   */
  constructor(options: TaskServiceOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.log ?? (() => {});
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.interopPort = options.interopPort ?? 8765;
    this.store = new TaskStore(options.dir, this.logger);
  }

  /** Load the store; safe to call twice. */
  async init(): Promise<void> {
    await this.store.load();
  }

  /** True when another machine owns the data. */
  get delegated(): boolean {
    return (this.options.remote?.() ?? null) !== null;
  }

  /**
   * The panel's whole view: draft, templates, and recent launches.
   * @returns snapshot.
   */
  async snapshot(): Promise<TaskSnapshot> {
    if (this.delegated) return (await this.#remote('GET', '')).tasks;
    await this.refreshWithin(2500);
    return this.#view();
  }

  /**
   * The current view without waiting for member polling.
   * @returns snapshot.
   */
  #view(): TaskSnapshot {
    const data = this.store.data;
    const runs = [...data.runs]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(runSummary);
    return { draft: data.draft, templates: data.templates, runs };
  }

  /**
   * Replace the object being edited.
   * @param doc new document.
   * @returns the new snapshot.
   */
  async setDraft(doc: unknown): Promise<TaskSnapshot> {
    if (this.delegated) return (await this.#remote('POST', '/draft', { doc })).tasks;
    this.store.data.draft = normalizeDoc(doc);
    await this.store.save();
    return this.#view();
  }

  /**
   * Save the current document under a new template name.
   * @param name template name.
   * @param doc document.
   * @returns the whole template list.
   */
  async createTemplate(name: unknown, doc: unknown): Promise<TaskSnapshot> {
    if (this.delegated) return (await this.#remote('POST', '/templates/create', { name, doc })).tasks;
    const label = this.#templateName(name);
    const unique = this.#uniqueName(label);
    const stamp = new Date(this.now()).toISOString();
    this.store.data.templates.push({
      id: `tpl-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      name: unique,
      doc: normalizeDoc(doc),
      createdAt: stamp,
      updatedAt: stamp,
    });
    await this.store.save();
    return this.#view();
  }

  /**
   * Rename one template.
   * @param id template id.
   * @param name new name.
   * @returns the whole template list.
   */
  async renameTemplate(id: unknown, name: unknown): Promise<TaskSnapshot> {
    if (this.delegated) return (await this.#remote('POST', '/templates/rename', { id, name })).tasks;
    const template = this.#template(id);
    const label = this.#templateName(name);
    const clash = this.store.data.templates.find((item) => item !== template && item.name === label);
    if (clash !== undefined) throw new WireGuardError('template_name_taken', `模板「${label}」已经存在。`, { status: 409 });
    template.name = label;
    template.updatedAt = new Date(this.now()).toISOString();
    await this.store.save();
    return this.#view();
  }

  /**
   * Overwrite a template with the current document.
   * @param id template id.
   * @param doc document.
   * @returns the whole template list.
   */
  async updateTemplate(id: unknown, doc: unknown): Promise<TaskSnapshot> {
    if (this.delegated) return (await this.#remote('POST', '/templates/update', { id, doc })).tasks;
    const template = this.#template(id);
    template.doc = normalizeDoc(doc);
    template.updatedAt = new Date(this.now()).toISOString();
    await this.store.save();
    return this.#view();
  }

  /**
   * Delete one template.
   * @param id template id.
   * @returns the whole template list.
   */
  async deleteTemplate(id: unknown): Promise<TaskSnapshot> {
    if (this.delegated) return (await this.#remote('POST', '/templates/delete', { id })).tasks;
    const template = this.#template(id);
    this.store.data.templates = this.store.data.templates.filter((item) => item !== template);
    await this.store.save();
    return this.#view();
  }

  /**
   * Render the task and launch it through a local coordinator conversation.
   *
   * The gateway never executes the task itself. It opens a conversation on the
   * local member whose agent delegates to the target with `call_member`, waits
   * with `wait_member`, and returns the acceptance result. The target member is
   * the only machine that executes anything, which also means the coordinator's
   * conversation is what 对话 lists and what the run status follows.
   * @param input document, title, member, workspace, cwd.
   * @returns the new run.
   */
  async launch(input: { doc?: unknown; title?: unknown; member?: unknown; workspace?: unknown; cwd?: unknown }): Promise<{ run: TaskRun; tasks: TaskSnapshot }> {
    if (this.delegated) {
      const answer = await this.#remote('POST', '/launch', input);
      return { run: answer.run as TaskRun, tasks: answer.tasks };
    }
    const doc = input.doc === undefined ? this.store.data.draft : normalizeDoc(input.doc);
    if (doc.nodes.length === 0) throw new WireGuardError('task_empty', '任务里还没有对象，先添加一个再发起。', { status: 400 });
    const members = this.options.members?.() ?? [];
    if (members.length === 0) throw new WireGuardError('no_member', '没有可用的成员。', { status: 503 });
    const local = members.find((member) => member.id === 'local');
    const target = this.#target(input.member, members);
    const title = cleanText(input.title, MAX_TITLE_CHARS) || `任务 ${new Date(this.now()).toLocaleString('zh-CN', { hour12: false })}`;
    const workspace = cleanWorkspace(input.workspace);
    const legacyCwd = cleanText(input.cwd, 400) || null;
    const cwd = workspace === null ? legacyCwd : `~/.dsh/workspaces/${workspace}`;
    const markdown = renderTaskMarkdown(doc, title);
    const localIp = (local?.ip ?? '').trim();
    const managerIp = localIp === '' ? '127.0.0.1' : localIp;
    const prompt = coordinatorPrompt({ title, markdown, target, workspace });
    const created = await this.#interop(managerIp, 'POST', '/v1/conversations', {
      prompt,
      // The executor's conversation carries the task title; the coordinator's
      // is marked so 对话 shows which local conversation is doing the managing.
      title: `${title} · 协调`,
      initiator: { id: 'gateway', name: this.options.selfName ?? os.hostname(), ip: managerIp, source: 'panel-task' },
      ...(workspace === null ? {} : { workspace }),
    });
    const conversation = (created as Record<string, unknown>).conversation as Record<string, unknown> | undefined;
    const conversationId = typeof conversation?.id === 'string' ? conversation.id : '';
    if (conversationId === '') throw new WireGuardError('interop_refused', '本机的协调对话没有返回 id。', { status: 502 });
    const stamp = new Date(this.now()).toISOString();
    const run: TaskRun = {
      id: `run-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      title,
      status: 'running',
      member: { id: target.id, name: target.name, ip: target.ip },
      manager: { id: local?.id ?? 'local', name: local?.name ?? (this.options.selfName ?? os.hostname()), ip: managerIp },
      workspace,
      cwd,
      conversationId,
      createdAt: stamp,
      updatedAt: stamp,
      doc,
      markdown,
      result: '',
      error: null,
    };
    this.store.data.runs = pruneRuns([run, ...this.store.data.runs]);
    await this.store.save();
    this.logger(`launched ${run.id}: local coordinator (${managerIp}) -> ${target.name} (${target.ip}): ${conversationId}`);
    return { run, tasks: this.#view() };
  }

  /**
   * Workspaces a member exposes below `~/.dsh/workspaces`.
   * @param member member id, name, or VPN address.
   * @returns the member's workspace listing.
   */
  async workspaces(member: unknown): Promise<TaskWorkspaces> {
    if (this.delegated) {
      const answer = await this.#remote('GET', `/workspaces?member=${encodeURIComponent(String(member ?? ''))}`);
      return normalizeWorkspaces(answer.workspaces, answer.dir);
    }
    const members = this.options.members?.() ?? [];
    if (members.length === 0) throw new WireGuardError('no_member', '没有可用的成员。', { status: 503 });
    const target = this.#target(member, members);
    const answer = await this.#interop(target.ip, 'GET', '/v1/workspaces');
    const payload = answer as Record<string, unknown>;
    return normalizeWorkspaces(payload.workspaces, payload.dir);
  }

  /**
   * Remove the finished launches from 历史, leaving running ones alone.
   * @returns the new snapshot.
   */
  async clearRuns(): Promise<TaskSnapshot> {
    if (this.delegated) return (await this.#remote('POST', '/runs/clear')).tasks;
    const before = this.store.data.runs.length;
    this.store.data.runs = this.store.data.runs.filter((run) => run.status === 'running');
    if (this.store.data.runs.length !== before) await this.store.save();
    return this.#view();
  }

  /**
   * One full historical run, refreshing it first when still in flight.
   * @param id run id.
   * @returns the run.
   */
  async run(id: unknown): Promise<TaskRun> {
    if (this.delegated) return (await this.#remote('GET', `/runs/${encodeURIComponent(String(id ?? ''))}`)).run;
    const run = this.store.data.runs.find((item) => item.id === String(id ?? ''));
    if (run === undefined) throw new WireGuardError('run_not_found', '找不到这次任务。', { status: 404 });
    if (run.status === 'running' || (run.status === 'completed' && run.result === '' && (run.resultTries ?? 0) < 3)) {
      await this.#refreshRun(run);
      await this.store.save();
    }
    return run;
  }

  /**
   * Refresh running launches without waiting longer than the budget.
   * @param budgetMs time to spend at most.
   * @returns when the refresh is done or the budget elapsed.
   */
  async refreshWithin(budgetMs: number): Promise<void> {
    const refresh = this.refresh();
    if (refresh === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs);
      timer.unref?.();
    });
    await Promise.race([refresh, timeout]);
    if (timer !== null) clearTimeout(timer);
  }

  /**
   * Ask every live launch's interop service for its status. Throttled.
   * @param force ignore the throttle.
   * @returns the shared refresh promise, or null when nothing is in flight.
   */
  refresh(force = false): Promise<void> | null {
    if (this.delegated) return null;
    // A run that finished while its final text was still empty keeps one more
    // chance: the interop can report `idle` a moment before it records the reply.
    const live = this.store.data.runs.filter((run) => (
      run.status === 'running' || (run.status === 'completed' && run.result === '' && (run.resultTries ?? 0) < 3)
    ));
    if (live.length === 0) return null;
    if (!force && this.now() - this.#lastRefresh < 5000) return null;
    if (this.#refreshing !== null) return this.#refreshing;
    this.#lastRefresh = this.now();
    this.#refreshing = (async () => {
      for (const run of live) await this.#refreshRun(run);
      await this.store.save();
    })().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  /**
   * Update one run from its member's conversation state.
   * @param run run to refresh.
   * @returns when the run is updated.
   */
  async #refreshRun(run: TaskRun): Promise<void> {
    // A run created after the coordinator change follows the local manager
    // conversation. Older runs tracked the target conversation directly.
    const ip = (run.manager?.ip ?? '').trim() !== '' ? String(run.manager?.ip) : run.member?.ip ?? '';
    if (ip === '') return;
    let conversation: Record<string, unknown> | null = null;
    try {
      const answer = await this.#interop(ip, 'GET', `/v1/conversations/${encodeURIComponent(run.conversationId)}`);
      conversation = (answer as Record<string, unknown>).conversation as Record<string, unknown> | null;
    } catch (error) {
      const status = (error as WireGuardError).status;
      if (status === 404) {
        run.status = 'failed';
        run.error = run.manager === null || run.manager === undefined
          ? '成员上已经没有这个对话了。'
          : '本机上已经没有这个协调对话了。';
        run.updatedAt = new Date(this.now()).toISOString();
        return;
      }
      return;
    }
    if (conversation === null) return;
    const status = typeof conversation.status === 'string' ? conversation.status : '';
    const failure = typeof conversation.error === 'string' && conversation.error !== '' ? conversation.error : null;
    if (failure !== null) {
      run.status = 'failed';
      run.error = failure;
    } else if (LIVE_STATUS.has(status)) {
      run.status = 'running';
    } else if (status === 'idle') {
      run.status = 'completed';
      run.error = null;
      // The conversation can turn idle a moment before its last reply is
      // recorded, so an empty answer is retried before it is believed.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = await this.#interop(ip, 'GET', `/v1/conversations/${encodeURIComponent(run.conversationId)}/result`);
          const finalText = typeof (result as Record<string, unknown>).finalText === 'string'
            ? (result as Record<string, unknown>).finalText as string
            : '';
          if (finalText !== '') {
            run.result = finalText.length > MAX_RESULT_CHARS ? finalText.slice(0, MAX_RESULT_CHARS) : finalText;
            run.resultTries = 0;
            break;
          }
        } catch {
          // The final text is a convenience; the completed status still matters.
        }
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 600));
      }
      if (run.result === '') run.resultTries = (run.resultTries ?? 0) + 1;
    } else {
      run.status = 'failed';
      run.error = status === 'interrupted' ? '对话被中断了。' : status === 'unavailable' ? '成员的 SDK 运行时已退出。' : `对话状态：${status || '未知'}`;
    }
    run.updatedAt = new Date(this.now()).toISOString();
  }

  /**
   * Call one member's interop service.
   * @param ip member VPN address.
   * @param method HTTP method.
   * @param endpoint path below the interop root.
   * @param body JSON body.
   * @returns parsed answer.
   */
  async #interop(ip: string, method: string, endpoint: string, body?: unknown): Promise<unknown> {
    const token = this.options.interopToken?.() ?? findInteropToken();
    if (token === null) throw new WireGuardError('interop_token_missing', '找不到成员 SDK 的访问令牌（config/interop.env 或 config/gate.env）。', { status: 503 });
    const host = ip.includes(':') && !ip.startsWith('[') ? `[${ip}]` : ip;
    const url = `http://${host}:${String(this.interopPort)}${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), method === 'POST' ? 60_000 : 8_000);
    timer.unref?.();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new WireGuardError('interop_unreachable', `${ip} 的 SDK 服务连不上：${error instanceof Error ? error.message : String(error)}`, { status: 502 });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let parsed: unknown = {};
    try {
      parsed = text === '' ? {} : JSON.parse(text);
    } catch {
      parsed = {};
    }
    if (!response.ok) {
      const detail = parsed as Record<string, any>;
      const message = typeof detail?.error?.message === 'string' ? detail.error.message : `HTTP ${String(response.status)}`;
      throw new WireGuardError('interop_failed', `${ip} 的 SDK 拒绝了请求：${message}`, { status: response.status >= 500 ? 502 : response.status });
    }
    return parsed;
  }

  /**
   * Forward one task request to the gateway that owns the store.
   * @param method HTTP method.
   * @param suffix path below the tasks API.
   * @param body JSON body.
   * @returns parsed payload.
   */
  async #remote(method: string, suffix: string, body?: unknown): Promise<{
    tasks: TaskSnapshot;
    run?: TaskRun;
    workspaces?: unknown;
    dir?: unknown;
  }> {
    const target = this.options.remote?.() ?? null;
    if (target === null) throw new WireGuardError('not_delegated', 'This machine owns the task store.', { status: 500 });
    const base = target.baseUrl.replace(/\/+$/u, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    timer.unref?.();
    let response: Response;
    try {
      response = await this.fetchImpl(`${base}${API_PREFIX}/tasks${suffix}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-dsh-wireguard': '1',
          'x-dsh-peer-token': target.token,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new WireGuardError('gateway_unreachable', `网关连不上，任务列表暂时读不到：${error instanceof Error ? error.message : String(error)}`, { status: 502 });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let parsed: Record<string, any> = {};
    try {
      parsed = text === '' ? {} : JSON.parse(text) as Record<string, any>;
    } catch {
      parsed = {};
    }
    if (!response.ok || parsed.ok === false) {
      const message = typeof parsed?.error?.message === 'string' ? parsed.error.message : `HTTP ${String(response.status)}`;
      throw new WireGuardError(parsed?.error?.code ?? 'gateway_failed', message, { status: response.status >= 400 ? response.status : 502 });
    }
    return {
      tasks: parsed.tasks as TaskSnapshot,
      run: parsed.run as TaskRun | undefined,
      workspaces: parsed.workspaces,
      dir: parsed.dir,
    };
  }

  /**
   * Resolve the member that executes a task.
   *
   * The local member is never an execution target: it owns the coordinator
   * conversation. Callers send an id, a name, or a VPN address.
   * @param value raw identifier; empty picks the first peer.
   * @param members current members, local included.
   * @returns the target.
   */
  #target(value: unknown, members: TaskMember[]): TaskMember {
    const wanted = String(value ?? '').trim();
    const target = wanted === ''
      ? members.find((member) => member.id !== 'local')
      : members.find((member) => member.id === wanted || member.ip === wanted || member.name === wanted);
    if (target === undefined) {
      throw new WireGuardError(
        wanted === '' ? 'no_member' : 'member_not_found',
        wanted === '' ? '没有可执行的成员；本机只负责管理和验收。' : `找不到成员 ${wanted}。`,
        { status: wanted === '' ? 503 : 404 },
      );
    }
    if (target.id === 'local') {
      throw new WireGuardError('local_member_not_allowed', '本机只负责管理和验收，请选择其他成员执行。', { status: 400 });
    }
    if (target.ip.trim() === '') throw new WireGuardError('member_without_ip', `成员 ${target.name} 没有 VPN 地址。`, { status: 409 });
    return target;
  }

  /**
   * Name a template, refusing empty ones.
   * @param value raw name.
   * @returns the name.
   */
  #templateName(value: unknown): string {
    const name = cleanText(value, 120);
    if (name === '') throw new WireGuardError('template_name_required', '模板名不能为空。', { status: 400 });
    return name;
  }

  /**
   * Append a counter until the name is unused.
   * @param name wanted name.
   * @returns a free name.
   */
  #uniqueName(name: string): string {
    const taken = new Set(this.store.data.templates.map((item) => item.name));
    if (!taken.has(name)) return name;
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${name} (${String(index)})`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${name} (${randomUUID().slice(0, 4)})`;
  }

  /**
   * Find one template or fail the request.
   * @param value raw id.
   * @returns the template.
   */
  #template(value: unknown): TaskTemplate {
    const id = String(value ?? '').trim();
    const template = this.store.data.templates.find((item) => item.id === id);
    if (template === undefined) throw new WireGuardError('template_not_found', '找不到这个模板。', { status: 404 });
    return template;
  }
}

/** Small helper used by tests and the panel header. */
export { summarize };
