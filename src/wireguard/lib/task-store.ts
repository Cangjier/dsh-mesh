/**
 * Durable storage for the 发起任务 tab: the current task, its templates, and
 * the launches that were started from it.
 *
 * The file lives in the control-service data directory and is written with the
 * same temp-file + rename dance as the WireGuard state, so a crash mid-write
 * leaves the previous file intact. Only the gateway control service writes it;
 * members read and write through the gateway (see `task-service.ts`).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_DEFINE_CHARS,
  MAX_SOURCE_CHARS,
  MAX_TITLE_CHARS,
  normalizeDoc,
  type TaskDoc,
  type TaskRun,
  type TaskTemplate,
} from './task-model';

/** How many launches are kept; the oldest completed run is dropped first. */
export const MAX_RUNS = 100;

/** Longest result text kept per run. */
export const MAX_RESULT_CHARS = 20000;

/** The whole file. */
export interface TaskData {
  version: 1;
  draft: TaskDoc;
  templates: TaskTemplate[];
  runs: TaskRun[];
}

/**
 * An empty store.
 * @returns fresh data.
 */
export function emptyTaskData(): TaskData {
  return { version: 1, draft: { nodes: [] }, templates: [], runs: [] };
}

/**
 * Clamp text and keep newlines.
 * @param value raw value.
 * @param limit limit.
 * @returns text.
 */
function text(value: unknown, limit: number): string {
  const result = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
  return result.length > limit ? result.slice(0, limit) : result;
}

/**
 * Normalize one template.
 * @param value raw template.
 * @returns template or null when it has no usable name.
 */
function normalizeTemplate(value: unknown): TaskTemplate | null {
  if (value === null || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const name = text(item.name, 120);
  if (name === '') return null;
  const id = text(item.id, 80) || `tpl-${Date.now().toString(36)}`;
  return {
    id,
    name,
    doc: normalizeDoc(item.doc),
    createdAt: text(item.createdAt, 40) || new Date().toISOString(),
    updatedAt: text(item.updatedAt, 40) || new Date().toISOString(),
  };
}

/**
 * Normalize one run.
 * @param value raw run.
 * @returns run or null when it is unusable.
 */
function normalizeRun(value: unknown): TaskRun | null {
  if (value === null || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const id = text(item.id, 80);
  const conversationId = text(item.conversationId, 120);
  if (id === '' || conversationId === '') return null;
  const status = item.status === 'completed' || item.status === 'failed' ? item.status : 'running';
  const member = item.member !== null && typeof item.member === 'object'
    ? {
      id: text((item.member as Record<string, unknown>).id, 120),
      name: text((item.member as Record<string, unknown>).name, 120),
      ip: text((item.member as Record<string, unknown>).ip, 120),
    }
    : null;
  return {
    id,
    title: text(item.title, MAX_TITLE_CHARS) || '任务',
    status,
    member,
    cwd: text(item.cwd, 400) || null,
    conversationId,
    createdAt: text(item.createdAt, 40) || new Date().toISOString(),
    updatedAt: text(item.updatedAt, 40) || new Date().toISOString(),
    doc: normalizeDoc(item.doc),
    markdown: text(item.markdown, 200000),
    result: text(item.result, MAX_RESULT_CHARS),
    error: text(item.error, 2000) || null,
    resultTries: typeof item.resultTries === 'number' && Number.isSafeInteger(item.resultTries) && item.resultTries > 0 ? item.resultTries : 0,
  };
}

/**
 * Normalize the whole file, dropping anything unusable.
 * @param value raw JSON.
 * @returns data.
 */
export function normalizeTaskData(value: unknown): TaskData {
  const source = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const templates = (Array.isArray(source.templates) ? source.templates : [])
    .map(normalizeTemplate)
    .filter((item): item is TaskTemplate => item !== null)
    .slice(0, 200);
  const seen = new Set<string>();
  for (const template of templates) {
    if (seen.has(template.id)) template.id = `${template.id}-${Math.random().toString(36).slice(2, 8)}`;
    seen.add(template.id);
  }
  const runs = (Array.isArray(source.runs) ? source.runs : [])
    .map(normalizeRun)
    .filter((item): item is TaskRun => item !== null)
    .slice(0, MAX_RUNS);
  return { version: 1, draft: normalizeDoc(source.draft), templates, runs };
}

/**
 * One task store file.
 */
export class TaskStore {
  readonly file: string;
  readonly logger: (line: string) => void;
  data: TaskData = emptyTaskData();
  #chain: Promise<void> = Promise.resolve();

  /**
   * @param directory data directory.
   * @param log logger.
   */
  constructor(directory: string, log: (line: string) => void = () => {}) {
    this.file = path.join(directory, 'tasks.json');
    this.logger = log;
  }

  /**
   * Read the file; a missing or broken file yields the empty store.
   * @returns loaded data.
   */
  async load(): Promise<TaskData> {
    try {
      const raw = await readFile(this.file, 'utf8');
      this.data = normalizeTaskData(JSON.parse(raw));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') this.logger(`task store unreadable (${code ?? 'error'}); starting empty`);
      this.data = emptyTaskData();
    }
    return this.data;
  }

  /**
   * Write the file, serialized so concurrent saves cannot interleave.
   * @returns when the file is on disk.
   */
  async save(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    const run = this.#chain.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${String(process.pid)}.tmp`;
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.file);
    });
    this.#chain = run.catch(() => {});
    await run;
  }
}

/** Keep the newest runs when the list grows past the cap. */
export function pruneRuns(runs: TaskRun[]): TaskRun[] {
  if (runs.length <= MAX_RUNS) return runs;
  return [...runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, MAX_RUNS);
}

/** Re-exported so callers import limits from one place. */
export { MAX_DEFINE_CHARS, MAX_SOURCE_CHARS, MAX_TITLE_CHARS };
