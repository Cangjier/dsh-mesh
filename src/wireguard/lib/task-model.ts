/**
 * Task object trees: the data model behind the panel's 发起任务 tab.
 *
 * A task is a flat list of objects plus references between them. Everything
 * that reads the tree (roots, rendering, cycle checks) therefore works on the
 * flat list: `children` holds only `{ id, remark }`, and a node is a root when
 * no other node references it. References are not unique — the same child can
 * be attached twice to one parent with the same or a different remark — so the
 * model is a directed acyclic graph that is rendered as a tree.
 *
 * Mutations are pure: they take a document and return a new one, which keeps
 * the HTTP handlers and the panel reducers free of aliasing bugs.
 */

/** One child edge. `remark` explains why this object hangs here, per edge. */
export interface TaskChildRef {
  id: number;
  remark: string;
}

/** One object in the task. */
export interface TaskNode {
  id: number;
  source: string;
  define: string;
  children: TaskChildRef[];
}

/** A whole task: every object, flat, in display order. */
export interface TaskDoc {
  nodes: TaskNode[];
}

/** Limits that keep one pasted task from bloating the state file. */
export const MAX_NODES = 500;
export const MAX_SOURCE_CHARS = 2000;
export const MAX_DEFINE_CHARS = 20000;
export const MAX_REMARK_CHARS = 2000;
export const MAX_TITLE_CHARS = 200;

/** A saved task, offered in the 模板 tab. */
export interface TaskTemplate {
  id: string;
  name: string;
  doc: TaskDoc;
  createdAt: string;
  updatedAt: string;
}

/**
 * One launch of a task. `doc` and `markdown` are the snapshot taken when the
 * task was launched, so later edits to the task or a template never rewrite
 * history.
 */
export interface TaskRun {
  id: string;
  title: string;
  status: 'running' | 'completed' | 'failed';
  member: { id: string; name: string; ip: string } | null;
  cwd: string | null;
  conversationId: string;
  createdAt: string;
  updatedAt: string;
  doc: TaskDoc;
  markdown: string;
  result: string;
  error: string | null;
  /** How often the final text was empty when read; stops at three. */
  resultTries?: number;
}

/** The same run without the heavy fields, for the 历史 list. */
export interface TaskRunSummary {
  id: string;
  title: string;
  status: TaskRun['status'];
  member: TaskRun['member'];
  cwd: string | null;
  conversationId: string;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
  resultPreview: string;
  error: string | null;
}

/** What the panel gets from one GET. */
export interface TaskSnapshot {
  draft: TaskDoc;
  templates: TaskTemplate[];
  runs: TaskRunSummary[];
}

/** One freshly launched run and the snapshot it produced. */
export interface LaunchResult {
  run: TaskRun;
  markdown: string;
}

/**
 * Clamp a string field and keep its inner newlines.
 * @param value raw value.
 * @param limit character limit.
 * @returns normalized text.
 */
export function cleanText(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
  return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * Read a non-negative integer id, or null.
 * @param value raw value.
 * @returns id or null.
 */
function readId(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number) || number < 0) return null;
  return number;
}

/**
 * Deep-copy a document so callers never share node arrays.
 * @param doc document.
 * @returns copy.
 */
export function cloneDoc(doc: TaskDoc): TaskDoc {
  return { nodes: doc.nodes.map((node) => ({ ...node, children: node.children.map((child) => ({ ...child })) })) };
}

/**
 * Normalize anything that claims to be a task.
 *
 * Unknown fields are dropped, ids are made unique, and references to objects
 * that are not in the document are removed — a dangling reference would make
 * the tree view render a row that cannot be edited or deleted.
 * @param value raw document.
 * @returns a valid document.
 */
export function normalizeDoc(value: unknown): TaskDoc {
  const source = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const rawNodes = Array.isArray(source.nodes) ? source.nodes : [];
  const nodes: TaskNode[] = [];
  const used = new Set<number>();
  let next = 0;
  for (const entry of rawNodes.slice(0, MAX_NODES)) {
    if (entry === null || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    let id = readId(item.id);
    if (id === null || used.has(id)) {
      while (used.has(next)) next += 1;
      id = next;
    }
    used.add(id);
    nodes.push({
      id,
      source: cleanText(item.source, MAX_SOURCE_CHARS),
      define: cleanText(item.define, MAX_DEFINE_CHARS),
      children: [],
    });
  }
  const known = new Set(nodes.map((node) => node.id));
  rawNodes.slice(0, MAX_NODES).forEach((entry, index) => {
    const node = nodes[index];
    if (node === undefined || entry === null || typeof entry !== 'object') return;
    const rawChildren = Array.isArray((entry as Record<string, unknown>).children)
      ? ((entry as Record<string, unknown>).children as unknown[])
      : [];
    for (const raw of rawChildren) {
      if (raw === null || typeof raw !== 'object') continue;
      const child = raw as Record<string, unknown>;
      // A bare number is accepted too: it is the same reference, no remark.
      const id = readId(child.id);
      if (id === null || !known.has(id)) continue;
      node.children.push({ id, remark: cleanText(child.remark, MAX_REMARK_CHARS) });
    }
  });
  return { nodes };
}

/**
 * The id a new object gets: one past the highest live id, or 0.
 * @param doc document.
 * @returns next id.
 */
export function nextNodeId(doc: TaskDoc): number {
  let max = -1;
  for (const node of doc.nodes) if (node.id > max) max = node.id;
  return max + 1;
}

/**
 * Find one object.
 * @param doc document.
 * @param id object id.
 * @returns the node or undefined.
 */
export function findNode(doc: TaskDoc, id: number): TaskNode | undefined {
  return doc.nodes.find((node) => node.id === id);
}

/**
 * Root ids: every object nobody references, in document order.
 *
 * This is deliberately computed by walking the whole document rather than by
 * "nodes that are not in some child list": with duplicate edges the same id can
 * appear under several parents, and the answer must stay the same.
 * @param doc document.
 * @returns root object ids.
 */
export function rootIds(doc: TaskDoc): number[] {
  const referenced = new Map<number, boolean>();
  for (const node of doc.nodes) referenced.set(node.id, false);
  for (const node of doc.nodes) {
    for (const child of node.children) {
      if (referenced.has(child.id)) referenced.set(child.id, true);
    }
  }
  return doc.nodes.filter((node) => referenced.get(node.id) !== true).map((node) => node.id);
}

/**
 * Ids referenced at least once.
 * @param doc document.
 * @returns referenced ids.
 */
export function referencedIds(doc: TaskDoc): Set<number> {
  const referenced = new Set<number>();
  for (const node of doc.nodes) for (const child of node.children) referenced.add(child.id);
  return referenced;
}

/**
 * Whether `targetId` is reachable from `fromId` by following child edges.
 * @param doc document.
 * @param fromId start object.
 * @param targetId object to look for.
 * @returns whether it is reachable.
 */
export function reaches(doc: TaskDoc, fromId: number, targetId: number): boolean {
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const seen = new Set<number>();
  const stack = [fromId];
  while (stack.length > 0) {
    const current = stack.pop() as number;
    if (current === targetId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const node = byId.get(current);
    if (node === undefined) continue;
    for (const child of node.children) stack.push(child.id);
  }
  return false;
}

/**
 * Why attaching `childId` below `parentId` is not allowed, or null when it is.
 * @param doc document.
 * @param parentId parent object.
 * @param childId child object.
 * @returns an error message or null.
 */
export function attachProblem(doc: TaskDoc, parentId: number, childId: number): string | null {
  if (findNode(doc, parentId) === undefined) return 'parent object not found';
  if (findNode(doc, childId) === undefined) return 'child object not found';
  if (parentId === childId) return 'an object cannot be its own child';
  // Attaching a node that already reaches the parent would create a cycle,
  // which has no root and therefore cannot be rendered as a tree.
  if (reaches(doc, childId, parentId)) return 'that object already contains the parent';
  return null;
}

/**
 * Add one object.
 * @param doc document.
 * @param input optional parent and initial values.
 * @returns the new document and the new object's id.
 */
export function addNode(doc: TaskDoc, input: { parentId?: number | null; source?: string; define?: string } = {}): { doc: TaskDoc; id: number } {
  const next = cloneDoc(doc);
  const id = nextNodeId(next);
  next.nodes.push({ id, source: cleanText(input.source, MAX_SOURCE_CHARS), define: cleanText(input.define, MAX_DEFINE_CHARS), children: [] });
  const parentId = input.parentId;
  if (typeof parentId === 'number') {
    const parent = findNode(next, parentId);
    if (parent !== undefined) parent.children.push({ id, remark: '' });
  }
  return { doc: next, id };
}

/**
 * Update one object's own fields.
 * @param doc document.
 * @param id object id.
 * @param patch fields to replace.
 * @returns new document.
 */
export function updateNode(doc: TaskDoc, id: number, patch: { source?: string; define?: string }): TaskDoc {
  const next = cloneDoc(doc);
  const node = findNode(next, id);
  if (node === undefined) throw new Error(`object ${String(id)} not found`);
  if (patch.source !== undefined) node.source = cleanText(patch.source, MAX_SOURCE_CHARS);
  if (patch.define !== undefined) node.define = cleanText(patch.define, MAX_DEFINE_CHARS);
  return next;
}

/**
 * Delete one object and every reference to it.
 *
 * Its children are not deleted: they lose one parent and become roots unless
 * another object still references them.
 * @param doc document.
 * @param id object id.
 * @returns new document.
 */
export function removeNode(doc: TaskDoc, id: number): TaskDoc {
  const next = cloneDoc(doc);
  next.nodes = next.nodes.filter((node) => node.id !== id);
  for (const node of next.nodes) node.children = node.children.filter((child) => child.id !== id);
  return next;
}

/**
 * Replace one object's own fields and its whole child edge list in one step.
 *
 * The object drawer edits locally and saves once, so this is the call it makes:
 * sources and definitions are trimmed, every edge must point at a live object,
 * and an edge that would close a cycle is refused. Since only the outgoing
 * edges of `id` change, a cycle can only come from a child that already
 * reaches `id`, which is what each edge is checked against.
 * @param doc document.
 * @param id object id.
 * @param patch source, define and the full edge list.
 * @returns new document.
 */
export function setNode(doc: TaskDoc, id: number, patch: { source?: string; define?: string; children?: TaskChildRef[] }): TaskDoc {
  const node = findNode(doc, id);
  if (node === undefined) throw new Error(`object ${String(id)} not found`);
  const next = cloneDoc(doc);
  const target = findNode(next, id);
  if (target === undefined) throw new Error(`object ${String(id)} not found`);
  if (patch.source !== undefined) target.source = cleanText(patch.source, MAX_SOURCE_CHARS);
  if (patch.define !== undefined) target.define = cleanText(patch.define, MAX_DEFINE_CHARS);
  if (patch.children !== undefined) {
    const cleaned: TaskChildRef[] = [];
    for (const edge of patch.children) {
      const childId = readId(edge?.id);
      if (childId === null) continue;
      if (findNode(next, childId) === undefined) throw new Error(`object ${String(childId)} not found`);
      if (childId === id) throw new Error('an object cannot be its own child');
      if (reaches(next, childId, id)) throw new Error(`#${String(childId)} already contains #${String(id)}`);
      cleaned.push({ id: childId, remark: cleanText(edge?.remark, MAX_REMARK_CHARS) });
    }
    target.children = cleaned;
  }
  return next;
}

/**
 * Attach an existing object below another one.
 * @param doc document.
 * @param parentId parent object.
 * @param childId child object.
 * @param remark why it hangs there.
 * @returns new document.
 */
export function addChildRef(doc: TaskDoc, parentId: number, childId: number, remark = ''): TaskDoc {
  const problem = attachProblem(doc, parentId, childId);
  if (problem !== null) throw new Error(problem);
  const next = cloneDoc(doc);
  const parent = findNode(next, parentId);
  if (parent === undefined) throw new Error('parent object not found');
  parent.children.push({ id: childId, remark: cleanText(remark, MAX_REMARK_CHARS) });
  return next;
}

/**
 * Rewrite one child edge's remark.
 * @param doc document.
 * @param parentId parent object.
 * @param index edge index.
 * @param remark new remark.
 * @returns new document.
 */
export function updateChildRef(doc: TaskDoc, parentId: number, index: number, remark: string): TaskDoc {
  const next = cloneDoc(doc);
  const parent = findNode(next, parentId);
  if (parent === undefined) throw new Error('parent object not found');
  const edge = parent.children[index];
  if (edge === undefined) throw new Error('child edge not found');
  edge.remark = cleanText(remark, MAX_REMARK_CHARS);
  return next;
}

/**
 * Drop one child edge. The child object itself stays in the task.
 * @param doc document.
 * @param parentId parent object.
 * @param index edge index.
 * @returns new document.
 */
export function removeChildRef(doc: TaskDoc, parentId: number, index: number): TaskDoc {
  const next = cloneDoc(doc);
  const parent = findNode(next, parentId);
  if (parent === undefined) throw new Error('parent object not found');
  if (parent.children[index] === undefined) throw new Error('child edge not found');
  parent.children.splice(index, 1);
  return next;
}

/**
 * Move one object within the flat list.
 *
 * The flat order is the display order of both views: the 平铺 view lists the
 * document as-is, and the 树形 view lays roots out in document order.
 * @param doc document.
 * @param id object id.
 * @param delta -1 for up, +1 for down.
 * @returns new document.
 */
export function moveNode(doc: TaskDoc, id: number, delta: number): TaskDoc {
  const next = cloneDoc(doc);
  const index = next.nodes.findIndex((node) => node.id === id);
  if (index < 0) throw new Error(`object ${String(id)} not found`);
  const target = index + delta;
  if (target < 0 || target >= next.nodes.length) return next;
  const [node] = next.nodes.splice(index, 1) as [TaskNode];
  next.nodes.splice(target, 0, node);
  return next;
}

/**
 * Move one child edge within its parent.
 * @param doc document.
 * @param parentId parent object.
 * @param index edge index.
 * @param delta -1 for up, +1 for down.
 * @returns new document.
 */
export function moveChildRef(doc: TaskDoc, parentId: number, index: number, delta: number): TaskDoc {
  const next = cloneDoc(doc);
  const parent = findNode(next, parentId);
  if (parent === undefined) throw new Error('parent object not found');
  const target = index + delta;
  if (target < 0 || target >= parent.children.length) return next;
  const [edge] = parent.children.splice(index, 1) as [TaskChildRef];
  parent.children.splice(target, 0, edge);
  return next;
}

/** One row of the tree view: an object plus the edge that reached it. */
export interface TaskTreeRow {
  node: TaskNode;
  /** The remark of the edge that led here; empty for roots. */
  remark: string;
  /** Id of the parent object; null for roots. */
  parentId: number | null;
  /** The index of the edge inside the parent, for reordering. */
  edgeIndex: number | null;
  depth: number;
  children: TaskTreeRow[];
}

/**
 * Lay the document out as a tree.
 *
 * Shared objects and duplicate edges are rendered once per edge on purpose:
 * the remark belongs to the edge, so two edges can say different things about
 * the same object. A cycle would make this infinite, so a node already open on
 * the current path is skipped — the model prevents cycles, this is a guard.
 * @param doc document.
 * @returns root rows.
 */
export function taskTree(doc: TaskDoc): TaskTreeRow[] {
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const build = (id: number, remark: string, parentId: number | null, edgeIndex: number | null, depth: number, path: Set<number>): TaskTreeRow | null => {
    const node = byId.get(id);
    if (node === undefined || path.has(id) || depth > MAX_NODES) return null;
    const nextPath = new Set(path);
    nextPath.add(id);
    const row: TaskTreeRow = { node, remark, parentId, edgeIndex, depth, children: [] };
    node.children.forEach((child, index) => {
      const built = build(child.id, child.remark, node.id, index, depth + 1, nextPath);
      if (built !== null) row.children.push(built);
    });
    return row;
  };
  const roots = rootIds(doc);
  const rows: TaskTreeRow[] = [];
  for (const id of roots) {
    const built = build(id, '', null, null, 0, new Set());
    if (built !== null) rows.push(built);
  }
  return rows;
}

/**
 * Counts shown in the panel header.
 * @param doc document.
 * @returns object count and root count.
 */
export function summarize(doc: TaskDoc): { nodes: number; roots: number; edges: number } {
  let edges = 0;
  for (const node of doc.nodes) edges += node.children.length;
  return { nodes: doc.nodes.length, roots: rootIds(doc).length, edges };
}

/**
 * Render one object's `define` as an indented block.
 * @param text define text.
 * @returns markdown lines.
 */
function defineLines(text: string): string[] {
  if (text === '') return [];
  return text.split('\n').map((line) => (line === '' ? '>' : `> ${line}`));
}

/**
 * Render the task as the markdown prompt a launch sends.
 *
 * The structure is the point: roots become sections, edges become nested
 * bullets, and every edge's remark travels with it. An index table at the end
 * keeps shared and duplicated objects readable without opening the tree twice.
 * @param doc document.
 * @param title task title.
 * @returns markdown text.
 */
export function renderTaskMarkdown(doc: TaskDoc, title: string): string {
  const heading = cleanText(title, MAX_TITLE_CHARS) || '任务';
  const stats = summarize(doc);
  const lines: string[] = [];
  lines.push(`# ${heading}`, '');
  lines.push(`- 对象：${String(stats.nodes)} 个（根对象 ${String(stats.roots)} 个，引用 ${String(stats.edges)} 条）`);
  lines.push('- 说明：每个对象是一个可执行单元；`source` 指出它指向的文件、git 仓库或代码中的类，`define` 是它要做的事，子对象是要先做或包含的事。');
  lines.push('');

  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const emitted = new Set<string>();
  const walk = (id: number, depth: number, remark: string, path: Set<number>): void => {
    const node = byId.get(id);
    if (node === undefined || depth > 12) return;
    const key = `${String(id)}|${String(depth)}|${remark}`;
    if (path.has(id) || emitted.has(key)) return;
    emitted.add(key);
    const marker = depth === 0 ? '###' : '####';
    const arrow = depth === 0 ? '' : `${'↳ '.repeat(Math.min(depth, 6))}`;
    lines.push(`${marker} ${arrow}#${String(node.id)}${node.source === '' ? '' : ` · ${node.source}`}`);
    if (remark !== '') lines.push(`> ${remark}`);
    const body = defineLines(node.define);
    if (body.length > 0) lines.push('', ...body);
    lines.push('');
    const nextPath = new Set(path);
    nextPath.add(id);
    for (const child of node.children) walk(child.id, depth + 1, child.remark, nextPath);
  };
  for (const id of rootIds(doc)) walk(id, 0, '', new Set());

  if (doc.nodes.length > 1) {
    lines.push('---', '', '## 对象索引', '', '| id | source | 子对象 |', '| --- | --- | --- |');
    const cell = (text: string): string => text.replace(/\|/gu, '\\|').replace(/\n/gu, ' ');
    for (const node of doc.nodes) {
      const children = node.children.length === 0
        ? '—'
        : cell(node.children.map((child) => `#${String(child.id)}${child.remark === '' ? '' : `（${child.remark}）`}`).join('、'));
      lines.push(`| ${String(node.id)} | ${node.source === '' ? '—' : cell(node.source)} | ${children} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
